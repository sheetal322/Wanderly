# Wanderly

A personal-event notification platform: users create events (birthdays, anniversaries, "buy
groceries every other Tuesday"), attach reminder rules, and Wanderly delivers a notification at
the right moment over email and web push.

The product is a vehicle. The goal is to solve the problems distributed systems actually have:
scheduling work in the future, delivering it exactly once when the infrastructure only guarantees
at-least-once, retrying against providers that fail, and doing it without losing or duplicating a
user's data.

The full system design — including the alternatives that were rejected and why — lives in
`docs/DESIGN.md`.

## Status

Built in phases; each phase produces something demonstrable.

| Phase                                                                                    | Status  |
| ---------------------------------------------------------------------------------------- | ------- |
| 1. Foundations — monorepo, Docker Compose, NestJS skeleton, health checks, CI            | ✅ Done |
| 2. Auth — register/verify/login/refresh/logout, Argon2id, rotation + reuse detection     | ⬜ Next |
| 3. `libs/recurrence` — pure RRULE + timezone expansion                                   | ⬜      |
| 4. Events CRUD — validation, ownership scoping, occurrence preview                       | ⬜      |
| 5. Materializer — horizon expansion, idempotent upsert, version invalidation             | ⬜      |
| 6. Dispatcher + Outbox + Relay — `SKIP LOCKED`, leader election                          | ⬜      |
| 7. Email worker — idempotency, templates, `delivery_attempts`                            | ⬜      |
| 8. Retries — tiered topics, backoff + jitter, error classification, DLQ, circuit breaker | ⬜      |
| 9. Web push — VAPID, service worker, 410 pruning                                         | ⬜      |
| 10. Frontend — React + TS, RRULE builder with live preview                               | ⬜      |
| 11. Observability — correlation IDs end to end, metrics, lag dashboard                   | ⬜      |
| 12. Hardening — rate limits, load test, chaos                                            | ⬜      |

## Running it

Requires Docker and Node 20+.

```bash
docker compose up --build        # whole platform, including hot-reloading API
```

| Service       | URL                   |
| ------------- | --------------------- |
| API           | http://localhost:3000 |
| Mailpit inbox | http://localhost:8025 |
| kafka-ui      | http://localhost:8080 |

To run the API on the host against containerised infrastructure:

```bash
cp .env.example .env
npm install
npm run infra:up      # postgres, redis, kafka, kafka-ui, mailpit
npm run build
npm run dev:api
```

```bash
npm run lint          # eslint
npm run typecheck     # tsc --build across the workspace
npm test              # jest
```

## Layout

```
apps/api        NestJS HTTP API
libs/config     environment schema, validated once at boot by every service
docker/         one multi-stage Dockerfile; APP build arg selects the entrypoint
```

Four backend services (`api`, `scheduler`, `worker`, `relay`) will share this codebase and build,
because they have different scaling and failure characteristics but no reason to be versioned
separately. Only `api` exists so far.

## Decisions made in Phase 1

**npm workspaces + TypeScript project references**, not Nx or Turborepo. At five packages the
extra tooling buys caching we do not need yet and adds machinery a reader has to learn first.

**Liveness and readiness are separate endpoints, and the split is load-bearing.** `/healthz`
checks nothing but the process — a container must not be restarted because Postgres was briefly
unreachable. `/readyz` checks Postgres and Redis, so an instance that cannot serve is pulled from
rotation while staying alive to recover. Verified by stopping each dependency: `/readyz` returns
503 and recovers, `/healthz` stays 200 throughout, and the process survives.

Two bugs found by actually running that test rather than trusting the code:

- Returning a `down` status from a Terminus indicator leaves the aggregate check at `200 ok`. The
  indicator has to _throw_ `HealthCheckError`. Without this, readiness was decoration — a broken
  instance would have stayed in rotation reporting itself healthy.
- `pg.Pool` emits an `error` event when an idle connection dies, and an unhandled `error` event
  terminates the process. A brief Postgres restart killed the entire API. Both the Postgres pool
  and the Redis client now have `error` listeners.

Both are asserted by tests in `apps/api/src/health/health.spec.ts`, so they cannot silently
regress.

**The environment is validated once, at boot, by a Zod schema in `libs/config`.** A misconfigured
worker should die on startup, not three hours later on the first message it handles.

**Kafka topics are not auto-created** (`KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false'`), so a typo in a
topic name fails loudly instead of silently producing into a new empty topic.

**Multi-stage Docker build** (`deps → build → runtime`), running as the non-root `node` user. The
runtime stage carries production dependencies and compiled output only — no TypeScript compiler,
no dev dependencies.

### Deviations from the original design document

- **Kafka image:** the design specified `bitnami/kafka:3.7`. Bitnami retired its free public image
  catalog in 2025 and that tag no longer resolves, so this uses the official `apache/kafka:3.9.1`
  instead — also free, also KRaft mode, different environment variable names.
- **Health indicators:** the design's `HealthIndicatorService` is a `@nestjs/terminus` v11 API.
  This is v10, which uses the `HealthIndicator` base class.

Everything in the local stack is free and open source.
