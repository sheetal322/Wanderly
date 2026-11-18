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

Built in phases; each phase produces something demonstrable. What comes next is decided case by
case rather than strictly in this order.

| Phase                                                                                    | Status  |
| ---------------------------------------------------------------------------------------- | ------- |
| 1. Foundations — monorepo, Docker Compose, NestJS skeleton, health checks, CI            | ✅ Done |
| 2. Auth — register/verify/login/refresh/logout, Argon2id, rotation + reuse detection     | ✅ Done |
| 3. `libs/recurrence` — pure RRULE + timezone expansion                                   | ✅ Done |
| 4. Events CRUD — validation, ownership scoping, occurrence preview                       | ✅ Done |
| 5. Materializer — horizon expansion, idempotent upsert, version invalidation             | ⬜      |
| 6. Dispatcher + Outbox + Relay — `SKIP LOCKED`, leader election                          | ⬜      |
| 7. Email worker — idempotency, templates, `delivery_attempts`                            | ⬜      |
| 8. Retries — tiered topics, backoff + jitter, error classification, DLQ, circuit breaker | ⬜      |
| 9. Web push — VAPID, service worker, 410 pruning                                         | ⬜      |
| 10. Frontend — React + TS, RRULE builder with live preview                               | ⬜      |
| 11. Observability — correlation IDs end to end, metrics, lag dashboard                   | ⬜      |
| 12. Hardening — rate limits, load test, chaos                                            | ⬜      |

## Running it

Requires Docker and Node 22+.

```bash
cp .env.example .env
npm install
npm run keys:generate            # RS256 key pair for access tokens, written into .env
docker compose up --build        # whole platform: migrations run first, then a hot-reloading API
```

| Service       | URL                   |
| ------------- | --------------------- |
| API           | http://localhost:3000 |
| Mailpit inbox | http://localhost:8025 |
| kafka-ui      | http://localhost:8080 |

To run the API on the host against containerised infrastructure (after the first three
commands above):

```bash
npm run infra:up      # postgres, redis, kafka, kafka-ui, mailpit
npm run db:deploy     # apply migrations
npm run build
npm run dev:api       # loads .env, restarts on change
```

```bash
npm run lint              # eslint
npm run typecheck         # prisma generate + tsc --build across the workspace
npm test                  # unit tests: no infrastructure needed
npm run test:integration  # real Postgres; needs `npm run infra:up`
npm run db:migrate        # after editing libs/db/prisma/schema.prisma: creates a migration
```

### Trying the auth flow by hand

```bash
curl -X POST localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"correct horse battery","timezone":"Europe/Berlin"}'

# Open the email in Mailpit (localhost:8025) and copy the token from the link. The link points
# at the web app, which arrives in Phase 10.
curl -X POST localhost:3000/api/v1/auth/verify-email -H 'Content-Type: application/json' \
  -d '{"token":"<token>"}'

curl -c cookies.txt -X POST localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"correct horse battery"}'   # → accessToken

curl localhost:3000/api/v1/me -H 'Authorization: Bearer <accessToken>'
curl -b cookies.txt -c cookies.txt -X POST localhost:3000/api/v1/auth/refresh   # rotates the cookie
```

### Events

All event routes need `Authorization: Bearer <accessToken>`.

```bash
# Every other Tuesday at 18:00 Berlin time
curl -X POST localhost:3000/api/v1/events -H 'Authorization: Bearer <accessToken>' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Groceries","startsAtLocal":"2026-12-01T18:00","timezone":"Europe/Berlin","rrule":"FREQ=WEEKLY;BYDAY=TU;INTERVAL=2"}'

curl 'localhost:3000/api/v1/events/<id>/occurrences?limit=5' -H 'Authorization: Bearer <accessToken>'
```

| Route                                       | What it does                                                        |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/v1/events`                       | Create. `rrule` omitted or `null` makes a one-off event             |
| `GET /api/v1/events?limit=&cursor=&status=` | List, newest first, cursor-paginated; `status` is `ACTIVE`/`PAUSED` |
| `GET /api/v1/events/:id`                    | One event                                                           |
| `PATCH /api/v1/events/:id`                  | Partial update; `rrule: null` turns it into a one-off               |
| `POST /api/v1/events/:id/pause`, `/resume`  | Pause or resume                                                     |
| `DELETE /api/v1/events/:id`                 | Soft delete                                                         |
| `GET /api/v1/events/:id/occurrences`        | Preview: next `limit` (default 10), or `from`/`to` (max 366 days)   |

## Layout

```
apps/api        NestJS HTTP API
apps/api/test   integration test harness (scratch database, test app factory)
libs/config     environment schema, validated once at boot by every service
libs/db         Prisma schema, migrations and generated client, shared by every service
libs/recurrence RRULE + time zone expansion: pure, no I/O, shared by the API and the scheduler
docker/         one multi-stage Dockerfile; APP build arg selects the entrypoint
scripts/        developer tooling (JWT key generation)
```

Four backend services (`api`, `scheduler`, `worker`, `relay`) will share this codebase and build,
because they have different scaling and failure characteristics but no reason to be versioned
separately. Only `api` exists so far.

TypeScript configs come in pairs per package: `tsconfig.json` covers source _and_ tests with the
Jest types named explicitly (what the editor and `npm run typecheck` use), and
`tsconfig.build.json` compiles source only into `dist/`. TypeScript 6, which VS Code bundles, no
longer loads every `@types` package by default, so test files outside any project lost
`describe`/`expect`; this layout also means `npm run typecheck` now type-checks the tests.

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

## Decisions made in Phase 2

**Refresh token rotation with reuse detection.** Every refresh revokes the presented token and
issues a new one in the same _family_. Presenting an already-revoked token means a copy exists
somewhere else, so the whole family is revoked and every holder must log in again. The revoke is
a conditional `UPDATE … WHERE revoked_at IS NULL`, not a read-then-write: two concurrent refreshes
with one token serialize on the row lock and only one wins. The loser is treated as reuse. The
cost is that two browser tabs refreshing at the same instant log the user out; a short grace
window would soften that, at the price of a window in which a stolen token also works.

**Tokens are stored as SHA-256 hashes**, refresh and verification alike. A leaked dump contains
nothing usable. SHA-256 rather than Argon2 because the tokens are 256 random bits: there is no
dictionary to attack.

**Access tokens are RS256 with the algorithm pinned on verify.** Only the API holds the private
key (it is in the API's env schema, not the shared one). Pinning `algorithms: ['RS256']` closes
`alg: none` and the HS256-keyed-with-the-public-key confusion attack; both have unit tests.

**Authentication is the default.** A global guard requires a bearer token on every route;
`@Public()` opts out. Forgetting the decorator fails closed.

**No account enumeration.** Registration answers identically whether or not the address is taken
(an existing verified owner gets an "you already have an account" email instead). Login returns
one message for unknown email and wrong password, and runs Argon2 against a dummy hash for unknown
emails so timing does not tell them apart. Unverified accounts get `403` only _after_ a correct
password.

**Account pre-hijacking is closed.** Re-registering an unverified address replaces its password
and invalidates every earlier verification link. Whoever verifies therefore verifies the password
from the latest registration, so someone who pre-registers a victim's address cannot keep a
password on the account. This is an integration test.

**Timezones must be IANA names.** class-validator's `@IsTimeZone()` accepts `+01:00`, because
recent ICU treats offset strings as zones. A custom validator rejects them: an offset is a fact
about one moment, a zone is a rule.

**Integration tests use real Postgres**, in a `wanderly_test` database that global setup drops,
recreates and migrates on every run (and refuses to touch unless its name ends in `_test`). Email
is the one boundary faked, with a capturing provider. CI runs Postgres as a service container.

**Migrations run as a one-off `migrate` compose service** before the API starts, mirroring the
design's "one-off task before the service update". The runtime image omits the Prisma CLI: npm
installs it as an optional peer of `@prisma/client` even under `--omit=dev`, so the runtime stage
also passes `--omit=optional` (651 MB → 446 MB).

## Decisions made in Phase 3

`libs/recurrence` turns an event (a wall-clock start, an IANA zone, an optional RRULE) into the
instants its notifications fire at. It does no I/O and was built against unit tests alone, as
the design asks: the occurrence preview endpoint and the materializer will both call it, so the
preview cannot drift from what is actually sent.

**Recurrence is computed in local wall-clock time, never in UTC.** The rule is expanded on
"floating" dates (wall-clock fields with no zone), and only then is each result converted to an
instant using the zone's rules on that date. A 09:00 Berlin reminder is 08:00Z in winter and
07:00Z in summer, and stays 09:00 local across both transitions.

**The written answers the design asked for**, each a test in
`libs/recurrence/src/recurrence.spec.ts`:

| Case                                     | Answer                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| 02:30 on a spring-forward day            | Fires once, shifted forward by the gap: 03:30. 30-min gaps (Lord Howe) shift 30 min |
| 01:30 on a fall-back day (happens twice) | Fires **once**, at the first (daylight-time) instant                                |
| `FREQ=MONTHLY;BYMONTHDAY=31`             | Skips months without a 31st. "Last day of the month" is `BYMONTHDAY=-1`             |
| Birthday on Feb 29, `FREQ=YEARLY`        | Leap years only. For every year, use `BYMONTH=2;BYMONTHDAY=-1` (Feb 28 or 29)       |
| Start that the rule would not produce    | Not an occurrence: "every Monday" created on a Thursday starts the next Monday      |

The first two follow RFC 5545 §3.3.5. Each occurrence also reports how it was resolved
(`exact`, `shifted-forward` or `earlier-of-two`), so a UI can explain a shifted reminder.

**`UNTIL` is converted to the event's zone by hand.** The rrule library would compare a UTC
`UNTIL` directly against floating wall-clock dates, which is wrong by the zone's offset: a
Berlin rule with `UNTIL=…T070000Z` would drop the 09:00 occurrence it is meant to include. A
date-only `UNTIL` means the whole of that local day.

**Validation doubles as abuse prevention.** Rules are rejected if they are sub-daily
(`SECONDLY`/`MINUTELY`/`HOURLY`), would produce more than 1,500 occurrences a year (so `DAILY`
plus a long `BYHOUR` list cannot sneak past the frequency check), never produce an occurrence
(`BYMONTH=2;BYMONTHDAY=30`, `COUNT=0`, an `UNTIL` before the start), or embed their own
`DTSTART`/`TZID`. Time zones must be IANA names; offsets like `+01:00` are rejected.

**The tests were checked by breaking the code.** Picking the later instant in an overlap,
shifting a gap backwards, and comparing `UNTIL` naively each make tests fail. Expected instants
are worked out by hand from published 2026 DST dates, not taken from the code's own output.

## Decisions made for events

**Ownership is enforced in the query, not after it.** Every read and write filters on `user_id`
in the `WHERE` clause; nothing loads by id and then checks the owner. Another user's event is a
`404`, not a `403`, so ids cannot be probed. An integration test fails if the scoping is removed.

**The start is stored as `timestamp` without time zone** (`starts_at_local`), the wall-clock
intent, next to its IANA zone. Instants are always derived, never stored for the event itself.

**The start, zone and rule are validated together** by `libs/recurrence`, on create and on the
merged result of a `PATCH`, so a partial edit cannot leave an event with an invalid schedule.

**`rrule_version` is bumped whenever the schedule actually changes** (not on a title edit, and
not on a no-op edit). Nothing reads it yet; it is in place so that occurrences computed from an
older schedule can later be recognised as stale.

**Cursor pagination, not offset**: `(created_at, id)` keyset, backed by an index. Stable under
concurrent inserts.

**Delete is soft** (`status = DELETED`): the row stays for history, but the event disappears from
every route.

**The preview reuses the exact expansion code** a future scheduler would, so what the preview
shows cannot drift from what would be sent.

Not built yet: reminders (`event_reminders`), sending notifications, and the `Idempotency-Key`
header on `POST`.

### Deviations from the original design document

- **Kafka image:** the design specified `bitnami/kafka:3.7`. Bitnami retired its free public image
  catalog in 2025 and that tag no longer resolves, so this uses the official `apache/kafka:3.9.1`
  instead — also free, also KRaft mode, different environment variable names.
- **Health indicators:** the design's `HealthIndicatorService` is a `@nestjs/terminus` v11 API.
  This is v10, which uses the `HealthIndicator` base class.
- **`email_verification_tokens` table:** not in the design's schema. Verification links are
  single-use, expire, and only the newest works, which a stateless signed token cannot give.
- **Verification email is sent directly over SMTP** from the API. The delivery pipeline does not
  exist until Phase 7, which moves this onto the outbox behind the same `EmailProvider` interface.
  Until then a failed send is logged, not retried; `POST /auth/resend-verification` recovers.
- **Prisma 6, not 7.** Prisma 7 requires Node `^20.19 || ^22.12 || >=24`; 6.19 runs on any Node 22+.
- **Logout revokes the refresh family only.** The access JWT stays valid for its remaining ≤15
  minutes; the design's Redis access-token denylist was deliberately left out to keep verification
  stateless.
- **Auth rate limiting is deferred to Phase 12** (hardening), as in the build order.
- **Recurrence rejects sub-daily frequencies entirely**, not just `SECONDLY`: hourly reminders
  for a personal event are not a use case worth 8,760 jobs a year per reminder.

Everything in the local stack is free and open source.
