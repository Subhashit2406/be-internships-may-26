import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dbPath = process.env.DATABASE_URL || "./data/signals.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// Enable WAL mode for concurrency
db.pragma("journal_mode = WAL");

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`);

// failure simulation
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error("simulated_db_failure");
    err.code = "SQLITE_BUSY";
    throw err;
  }
}

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  const stmt = db.prepare(
    "INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)",
  );
  return stmt.run(userId, type, String(payload), idemKey || null, nowMs);
}

export function getByIdemKey(idemKey) {
  maybeFail();
  const stmt = db.prepare(
    "SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?",
  );
  return stmt.get(idemKey);
}

export function listSignals(userId, limit) {
  maybeFail();
  const stmt = db.prepare(
    "SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  );
  return stmt.all(userId, limit);
}

const stmtUpdateRateLimit = db.prepare(`
  INSERT INTO rate_limits (user_id, window_start, count)
  VALUES (?, ?, 1)
  ON CONFLICT(user_id) DO UPDATE SET
    count = CASE WHEN ? - window_start >= 60000 THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN ? - window_start >= 60000 THEN ? ELSE window_start END
`);

const stmtSelectRateLimit = db.prepare(`
  SELECT window_start as windowStart, count FROM rate_limits WHERE user_id = ?
`);

export const updateRateLimit = db.transaction((userId, nowMs) => {
  maybeFail();
  stmtUpdateRateLimit.run(userId, nowMs, nowMs, nowMs, nowMs);
  return stmtSelectRateLimit.get(userId);
});

export async function withRetry(fn, maxRetries = 10, initialDelayMs = 5) {
  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (err) {
      attempt++;
      const isTransient =
        err.code === "SQLITE_BUSY" || err.message === "simulated_db_failure";
      if (!isTransient || attempt > maxRetries) {
        throw err;
      }
      const delay = initialDelayMs * Math.pow(2, attempt) + Math.random() * 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
