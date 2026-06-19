import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import http from "node:http";
import fs from "node:fs";

function cleanupDb(dbPath) {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
    if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
  } catch (err) {
    // ignore
  }
}

async function waitForServer(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${url}/healthz`, (res) => {
          if (res.statusCode === 200) resolve();
          else reject();
        });
        req.on("error", reject);
        req.end();
      });
      return;
    } catch (err) {
      await wait(50);
    }
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

test("idempotency returns same resource for same key", async () => {
  const dbPath = "./data/signals-test-idem-1.db";
  cleanupDb(dbPath);

  const proc = spawn("node", ["src/server.js"], {
    env: { ...process.env, API_KEY: "k", PORT: "9091", DATABASE_URL: dbPath },
  });

  const base = "http://localhost:9091";
  const idem = "same-key";

  try {
    await waitForServer(base);
    const a = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u1", type: "note", payload: "x" },
    });
    const b = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u1", type: "note", payload: "x" },
    });

    assert.equal(a.id, b.id);
    assert.equal(a.idempotencyKey, b.idempotencyKey);
  } finally {
    proc.kill();
    cleanupDb(dbPath);
  }
});

test("idempotency survives concurrent parallel requests", async () => {
  const dbPath = "./data/signals-test-idem-2.db";
  cleanupDb(dbPath);

  const proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      API_KEY: "k",
      PORT: "9093",
      DATABASE_URL: dbPath,
      RATE_LIMIT_PER_MIN: "100",
    },
  });

  const base = "http://localhost:9093";
  const idem = "concurrent-key-" + Date.now();

  try {
    await waitForServer(base);
    const requests = Array.from({ length: 10 }).map(() =>
      postJson(`${base}/v1/signals`, {
        headers: { "x-api-key": "k", "Idempotency-Key": idem },
        body: { userId: "u2", type: "event", payload: "y" },
      }),
    );

    const results = await Promise.all(requests);

    const firstId = results[0].id;
    assert.ok(firstId !== undefined, "ID should be defined");
    for (const res of results) {
      assert.equal(
        res.id,
        firstId,
        "All concurrent requests must return the same resource ID",
      );
      assert.equal(res.idempotencyKey, idem);
    }
  } finally {
    proc.kill();
    cleanupDb(dbPath);
  }
});

test("survives transient DB failures via retries", async () => {
  const dbPath = "./data/signals-test-idem-3.db";
  cleanupDb(dbPath);

  const proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      API_KEY: "k",
      PORT: "9094",
      DATABASE_URL: dbPath,
      DB_FAIL_RATE: "0.4",
    },
  });

  const base = "http://localhost:9094";
  const idem = "retry-key-" + Date.now();

  try {
    await waitForServer(base);
    const res = await postJson(`${base}/v1/signals`, {
      headers: { "x-api-key": "k", "Idempotency-Key": idem },
      body: { userId: "u3", type: "retry-event", payload: "z" },
    });

    assert.ok(
      res.id !== undefined,
      "Should successfully complete after retries",
    );
    assert.equal(res.idempotencyKey, idem);
  } finally {
    proc.kill();
    cleanupDb(dbPath);
  }
});

async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => (chunks += d));
        res.on("end", () => resolve(JSON.parse(chunks || "{}")));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
