import { updateRateLimit, withRetry } from "./db.js";

const WINDOW_MS = 60_000;

export async function checkAndConsume(userId, nowMs = Date.now()) {
  const limit = Number(process.env.RATE_LIMIT_PER_MIN || 5);
  // update rate limit atomically in DB
  const info = await withRetry(() => updateRateLimit(userId, nowMs));

  const ok = info.count <= limit;
  const remaining = Math.max(limit - info.count, 0);
  const resetMs = info.windowStart + WINDOW_MS;

  return { ok, remaining, resetMs };
}
