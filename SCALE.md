# Scale Plan (10k RPS)

## Data model & indexes

Currently, we're using SQLite with basic indexes on `idempotency_key` and `(user_id, created_at)`.
To scale to 10k RPS, we should migrate to PostgreSQL (like AWS Aurora). We'll want to:

- Partition the table by hash of `user_id` so write load is spread out.
- Keep the composite index on `(user_id, created_at DESC)` for fetching fast, and a unique index on `idempotency_key`.

## Idempotency across instances

- **Database unique index**: Keep using a unique constraint on `idempotency_key`. We'd use `INSERT ... ON CONFLICT (idempotency_key) DO UPDATE` or query the existing record to prevent race conditions when multiple nodes try to insert.
- **Caching**: Put active/recent idempotency keys in a Redis cluster with a 24-hour TTL. Check Redis first; if not found, write to PG and update Redis.

## Rate limiting across instances

- **Redis storage**: In-memory maps don't work for multiple instances, so we'd move rate limits to Redis.
- **Sliding Window**: Use a Redis Sorted Set (ZSET) for each user and run a Lua script to:
  1. Remove old timestamps (`now - 60s`).
  2. Count items.
  3. If less than limit, add current request and return OK.
     This runs in <1ms and works across all instances.

## Observability

- **Logs**: Structured JSON logging using Winston or Pino, sent to ELK or Datadog.
- **Metrics**: Track request rate, 429/5xx error rates, and p95/p99 latency using Prometheus.
- **Alerts**: Set up PagerDuty alerts for high 5xx error rates (>1%) or database/Redis resource exhaustion.

## Failure modes

- **Retry Jitter**: Implement exponential backoff with jitter on database calls to avoid retry storms (thundering herd).
- **Circuit Breaker**: Use a circuit breaker library (like `opossum`) so if PG goes down, we fail-fast immediately rather than hanging connections.
- **Fallback Queue**: If the database goes down completely, we can write signals to a message queue (SQS or Kafka) and ingest them asynchronously later.

## 10k RPS Architecture & Cost Estimate

- **Infra Setup**:
  - Load Balancer: AWS ALB
  - App: ECS Fargate (20 tasks, autoscale on CPU/RAM)
  - Cache: Redis Cluster (3 shards, Elasticache)
  - DB: Amazon Aurora Postgres (multi-AZ)
- **Cost Estimate**:
  - Compute (ECS): ~$800/mo
  - Database: ~$1500/mo
  - Redis: ~$400/mo
  - ALB/Bandwidth: ~$600/mo
  - **Total**: ~$3,300/mo
