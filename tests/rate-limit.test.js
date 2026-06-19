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

test("rate limit: allow 5 per minute, 6th is 429", async () => {
  const dbPath = "./data/signals-test-rl-1.db";
  cleanupDb(dbPath);

  const proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      API_KEY: "k",
      PORT: "9092",
      DATABASE_URL: dbPath,
      RATE_LIMIT_PER_MIN: "5",
    },
  });

  const base = "http://localhost:9092";
  try {
    await waitForServer(base);
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const code = await postStatus(`${base}/v1/signals`, {
        headers: { "x-api-key": "k" },
        body: { userId: "u1", type: "note", payload: String(i) },
      });
      statuses.push(code);
    }
    const counts = statuses.reduce(
      (acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc),
      {},
    );
    assert.ok(counts[200] >= 5);
    assert.ok(counts[429] >= 1);
  } finally {
    proc.kill();
    cleanupDb(dbPath);
  }
});

test("rate limit: concurrent parallel requests are capped strictly at 5", async () => {
  const dbPath = "./data/signals-test-rl-2.db";
  cleanupDb(dbPath);

  const proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      API_KEY: "k",
      PORT: "9095",
      DATABASE_URL: dbPath,
      RATE_LIMIT_PER_MIN: "5",
    },
  });

  const base = "http://localhost:9095";
  try {
    await waitForServer(base);
    const requests = Array.from({ length: 10 }).map((_, i) =>
      postStatus(`${base}/v1/signals`, {
        headers: { "x-api-key": "k" },
        body: { userId: "u2", type: "note", payload: String(i) },
      }),
    );

    const statuses = await Promise.all(requests);
    const counts = statuses.reduce(
      (acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc),
      {},
    );

    assert.equal(counts[200], 5, "Exactly 5 requests should succeed with 200");
    assert.equal(counts[429], 5, "Exactly 5 requests should fail with 429");
  } finally {
    proc.kill();
    cleanupDb(dbPath);
  }
});

async function postStatus(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
