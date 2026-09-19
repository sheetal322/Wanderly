# Wanderly — System Design

## Context

Wanderly is a personal-event notification platform: users create events (birthdays,
anniversaries, "buy groceries every other Tuesday"), attach reminder rules to them, and
Wanderly delivers a notification at the right moment over email and web push.

The point of this project is **not** the product. The product is a vehicle. The real goal is
to build something that forces you to solve the problems distributed systems actually have:
scheduling work in the future, delivering it exactly once when your infrastructure only
guarantees at-least-once, retrying against providers that fail, and doing all of it without
losing or duplicating a user's data.

**Decisions already made:**

- Channels: **email + web push (VAPID)**. Both free.
- Email: generic `EmailProvider` interface; **Mailpit** in Docker for local/test, **Resend**
  free tier when deployed.
- Holidays: **out of MVP.** Deliberate — it is a shallow ingestion job. Added later, reusing
  the same delivery pipeline.
- Recurrence: **full RRULE (iCal RFC 5545)**. This is the hardest and most valuable part.

Everything below explains not just _what_ to build but _why_, with the alternatives that were
rejected and the reason.

---

## 1. Product Requirements

### Functional

1. A user signs up, verifies their email, logs in.
2. A user creates an **event**: a title, a start datetime, an IANA timezone, and an optional
   **recurrence rule** (RRULE).
3. A user attaches one or more **reminders** to an event: "notify me 1 day before",
   "notify me 30 minutes before", each with a set of channels.
4. A user registers one or more **devices** for web push (browser grants permission).
5. Wanderly delivers each reminder, on each requested channel, at the correct instant —
   **once**, even though every layer underneath it can duplicate.
6. A user sees a history of what was sent, and what failed.
7. A user can pause an event, delete it, or mute a channel globally.

### Non-functional (these are the ones that actually shape the design)

| Requirement           | Target                                    | Why it matters                                          |
| --------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Delivery accuracy     | Fire within ±60s of the intended instant  | Defines scheduler tick granularity                      |
| Duplicate rate        | Effectively zero user-visible duplicates  | Forces idempotency at every hop                         |
| Loss rate             | Zero silently dropped notifications       | Forces durable outbox + DLQ, not fire-and-forget        |
| Provider failure      | Survive a provider being down for hours   | Forces retry with backoff, not immediate failure        |
| Correctness under DST | A 9am reminder stays 9am local across DST | Forces timezone-aware recurrence, not UTC arithmetic    |
| Restart safety        | Killing any process loses nothing         | Forces state in Postgres/Kafka, never in process memory |

That last column is the whole curriculum. Each non-functional requirement is a lesson.

---

## 2. MVP vs Later

**MVP (build this, and only this, first):**

- Auth: register, verify email, login, refresh, logout
- Events with full RRULE recurrence + timezone
- Reminders with offsets and channel selection
- Occurrence materialization + dispatch scheduler
- Kafka-based delivery pipeline with retries and a DLQ
- Email (Mailpit) and Web Push delivery workers
- Notification history
- Docker Compose bringing the whole thing up with one command
- Jest unit + integration tests, GitHub Actions CI

**Explicitly later (write them down so you can say "I know, it's next"):**

- Public holidays (ingestion job → reuses the same pipeline)
- Shared/group events and invitations
- SMS channel
- Digest notifications ("here's your week")
- Snooze
- Admin dashboard, per-tenant rate limits
- AWS deployment

**Why this cut:** the MVP contains every hard distributed-systems problem exactly once. The
"later" list is all _breadth_ — more channels, more sources, more UI. Breadth demonstrates
nothing new once the pipeline exists. Build the spine first.

---

## 3. System Architecture

### The services

```
                                   ┌──────────────────┐
  React + TS  ──── HTTPS ────────► │   API (NestJS)   │
  (Vite, SPA)                      │  REST + auth     │
                                   └────────┬─────────┘
                                            │ writes
                                   ┌────────▼─────────┐
                                   │   PostgreSQL     │◄──── source of truth
                                   │  (+ outbox tbl)  │
                                   └────────┬─────────┘
                                            │ polls outbox
                                   ┌────────▼─────────┐
                                   │  Outbox Relay    │──── publishes ───►┐
                                   └──────────────────┘                   │
                                                                          │
  ┌────────────────┐   materializes    ┌──────────────────┐               │
  │  Materializer  │──── RRULE ───────►│   PostgreSQL     │               │
  │  (hourly)      │    occurrences    └──────────────────┘               │
  └────────────────┘                                                      │
                                                                          │
  ┌────────────────┐   finds due jobs                                     │
  │   Dispatcher   │──────────────────────── publishes ──────────────────►│
  │  (every 30s)   │                                                      │
  └────────────────┘                                                      ▼
                                                            ┌─────────────────────┐
                                                            │       Kafka         │
                                                            └──────────┬──────────┘
                                                                       │
                                            ┌──────────────────────────┼─────────────┐
                                            ▼                          ▼             ▼
                                   ┌────────────────┐        ┌────────────────┐   ┌──────┐
                                   │  Email Worker  │        │  Push Worker   │   │ DLQ  │
                                   │   → Mailpit    │        │  → Web Push    │   │ Cons.│
                                   └────────────────┘        └────────────────┘   └──────┘

  Redis ──── idempotency keys, rate limits, leader locks, session denylist, caching
```

### Why these are separate processes

The API, the Materializer, the Dispatcher, and the Workers are **four different deployables**
even though early on they share one codebase (a monorepo with a shared `libs/`).

**Why:** they have completely different scaling and failure characteristics. The API scales
with _user traffic_. The workers scale with _notification volume_. The Dispatcher must have
exactly one active instance (or it double-dispatches). If you fuse them into one process, a
burst of notification sends makes your login endpoint slow, and you cannot scale one without
the other.

**Alternative rejected — a single monolith with `@nestjs/schedule` cron decorators.** This is
what most tutorials do. It works until you run two replicas, at which point _both_ replicas
fire the cron and every user gets two emails. Fixing that requires exactly the leader-election
machinery described below, so you may as well separate the concerns properly from the start.

**Alternative rejected — serverless functions per step.** Genuinely good for this workload in
production, but it hides the mechanics (the queue, the consumer group, the offset commit)
behind a cloud provider. You would learn the vendor, not the system.

**Note on the monorepo:** one repo, multiple entrypoints (`apps/api`, `apps/worker`,
`apps/scheduler`, `apps/web`, `libs/`). You get separate deployables without the pain of
versioning shared code across repos. This is what most real companies at this size do.

---

## 4. The Scheduling Problem (the core of the project)

This deserves its own section because it is the part that separates a toy from a real system.

### The problem

An RRULE like `FREQ=WEEKLY;BYDAY=TU;INTERVAL=2` describes an **infinite** set of datetimes.
You cannot store infinite rows. But you also cannot compute "what is due right now?" by
evaluating every user's RRULE on every tick — that is a full table scan through a CPU-heavy
expansion, every 30 seconds, forever.

### The solution: two-tier scheduling (materialize, then dispatch)

**Tier 1 — the Materializer (runs hourly):**

For every active event, expand its RRULE over a rolling **horizon** — say, the next 30 days —
and write each concrete occurrence into a `notification_jobs` table with a computed
`scheduled_for` timestamp. Then stop. Next hour, it extends the horizon again.

This converts an infinite, CPU-bound problem into a finite set of rows with a timestamp column.

**Tier 2 — the Dispatcher (runs every 30 seconds):**

```sql
SELECT * FROM notification_jobs
WHERE status = 'PENDING' AND scheduled_for <= now()
ORDER BY scheduled_for
LIMIT 500
FOR UPDATE SKIP LOCKED;
```

That is now a cheap index scan. Mark them `QUEUED`, publish to Kafka, done.

**Why this pattern:** it separates the expensive, infrequent, CPU-bound work (recurrence math)
from the cheap, frequent, IO-bound work (find due rows). This is a broadly reusable idea —
precompute into a queryable shape, then query it.

**`FOR UPDATE SKIP LOCKED` is worth understanding deeply.** It lets multiple dispatcher
instances pull _disjoint_ batches from the same table with no coordination: each transaction
locks the rows it takes and other transactions skip past locked rows instead of blocking. It
turns a Postgres table into a safe work queue. This single clause is why you may not need a
dedicated queue for this stage at all.

**Alternative rejected — delayed jobs in BullMQ/Redis.** Genuinely reasonable: BullMQ supports
delayed jobs natively and you would write far less code. Rejected for two reasons. First,
Redis persistence is weaker than Postgres — an unlucky restart can lose jobs, and "we lost
someone's birthday reminder" is exactly the failure this project is meant to prevent. Second,
scheduling a job months out means it sits in Redis memory for months. Postgres rows are cheap;
Redis memory is not. _Worth noting in your README that you considered it_ — that framing is
what makes it read as a decision rather than an omission.

**Alternative rejected — one cron entry per event.** Does not survive a restart, does not
scale past a few thousand events, and has no story for retries.

### Horizon and correctness

Two subtleties that will bite you, so design for them now:

1. **Editing an event must invalidate materialized occurrences.** If a user changes an RRULE,
   every future `PENDING` job for that event must be deleted and re-materialized. Past and
   already-sent jobs are untouched — they are history. Implement this as a version counter on
   the event: materialization stamps `rrule_version` on each job, and the dispatcher ignores
   jobs whose version is stale. Deleting is a cleanup detail; the version check is the
   correctness guarantee.
2. **The horizon must exceed the largest reminder offset.** If someone sets "remind me 60 days
   before" and your horizon is 30 days, that reminder is never materialized in time. Horizon
   must be `max(reminder_offset) + safety_margin`.

### Timezones and DST — the trap

**Never do recurrence math in UTC.** A user in Berlin with a 9:00am daily reminder expects 9am
local. Berlin is UTC+1 in winter and UTC+2 in summer. If you store 08:00 UTC and recur daily in
UTC, then on the last Sunday in March every reminder silently shifts to 10am local, forever.

The correct algorithm:

1. Store the event's `timezone` as an **IANA identifier** (`Europe/Berlin`), never a fixed
   offset like `+01:00`. An offset is a _fact about one moment_; a timezone is a _rule_.
2. Expand the RRULE in **local wall-clock time**.
3. Convert each resulting local datetime to a UTC instant _using the timezone rules in effect
   on that specific date_.
4. Store `scheduled_for` as `timestamptz`.

Use `luxon` or `rrule` + `luxon` together. Do not hand-roll this.

Edge cases to write tests for (these make excellent portfolio talking points):

- A 2:30am daily reminder on the day a DST spring-forward _deletes_ 2:30am. What should happen?
- A 1:30am reminder on the day DST fall-back makes 1:30am happen _twice_. Fire once or twice?
- `FREQ=MONTHLY;BYMONTHDAY=31` in February. RRULE says skip; make sure your code agrees.
- A birthday on Feb 29.

Pick a documented answer for each. Having a written answer to "what happens on Feb 29" is a
stronger signal than most of the code you will write.

---

## 5. Database Schema

Postgres is the source of truth. Kafka is transport, Redis is a cache — **neither is ever the
only place a fact lives.** Internalize that sentence; it resolves most design arguments.

```sql
-- ident & auth ------------------------------------------------------------
users (
  id                uuid pk,
  email             citext unique not null,
  password_hash     text not null,           -- argon2id
  email_verified_at timestamptz,
  default_timezone  text not null,           -- IANA
  created_at, updated_at
)

refresh_tokens (
  id            uuid pk,
  user_id       uuid fk -> users on delete cascade,
  token_hash    text unique not null,        -- sha256 of the token; never store raw
  family_id     uuid not null,               -- for rotation-reuse detection
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  created_at
)

-- events ------------------------------------------------------------------
events (
  id              uuid pk,
  user_id         uuid fk -> users on delete cascade,
  title           text not null,
  description     text,
  starts_at_local timestamp not null,        -- NOTE: no tz. wall-clock intent.
  timezone        text not null,             -- IANA
  rrule           text,                      -- null = one-off
  rrule_version   int not null default 1,    -- bumped on any schedule edit
  status          text not null,             -- ACTIVE | PAUSED | DELETED
  created_at, updated_at
)
index on (user_id, status)

event_reminders (
  id              uuid pk,
  event_id        uuid fk -> events on delete cascade,
  offset_minutes  int not null,              -- minutes BEFORE the occurrence
  channels        text[] not null,           -- {EMAIL, PUSH}
  created_at
)

-- the materialized schedule ----------------------------------------------
notification_jobs (
  id            uuid pk,
  event_id      uuid fk -> events on delete cascade,
  reminder_id   uuid fk -> event_reminders on delete cascade,
  user_id       uuid not null,
  occurrence_at timestamptz not null,        -- when the event itself happens
  scheduled_for timestamptz not null,        -- occurrence_at - offset
  rrule_version int not null,
  status        text not null,               -- PENDING|QUEUED|SENT|FAILED|CANCELLED
  created_at, updated_at,

  unique (reminder_id, occurrence_at)        -- ◄── THE idempotency guarantee
)
index on (status, scheduled_for)             -- ◄── the dispatcher's index

-- delivery ----------------------------------------------------------------
push_subscriptions (
  id          uuid pk,
  user_id     uuid fk -> users on delete cascade,
  endpoint    text unique not null,
  p256dh_key  text not null,
  auth_key    text not null,
  user_agent  text,
  created_at, last_seen_at
)

delivery_attempts (
  id                uuid pk,
  job_id            uuid fk -> notification_jobs,
  channel           text not null,           -- EMAIL | PUSH
  attempt_no        int not null,
  status            text not null,           -- SUCCESS|RETRYABLE_FAIL|PERMANENT_FAIL
  provider_message_id text,
  error_code        text,
  error_detail      text,
  idempotency_key   text not null,
  created_at,

  unique (idempotency_key)                   -- ◄── dedupe across Kafka redelivery
)
index on (job_id)

-- the transactional outbox ------------------------------------------------
outbox (
  id             bigserial pk,
  aggregate_type text not null,
  aggregate_id   uuid not null,
  topic          text not null,
  partition_key  text not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  published_at   timestamptz
)
index on (published_at) where published_at is null   -- partial index: tiny + fast
```

### Schema decisions worth defending

**`starts_at_local` is `timestamp` (no timezone), not `timestamptz`.** This looks wrong and is
the single most important line in the schema. The user's _intent_ is "9am on my birthday" — a
wall-clock fact — not "14:00 UTC", an instant. Storing the intent separately from the timezone
rule lets you recompute correct instants when the rules change. (Governments really do change
timezone rules, with a few months' notice. Your data survives it.)

Conversely `scheduled_for` **is** `timestamptz`, because by then it _is_ a resolved instant.
Intent is wall-clock; execution is an instant. Two different types for two different things.

**`unique (reminder_id, occurrence_at)`** — this one constraint is what makes the whole
materializer safe to run twice, concurrently, after a crash, in any order. Re-running it is a
no-op via `ON CONFLICT DO NOTHING`. **A database constraint is a stronger guarantee than any
amount of careful application code**, because it holds even when your code is wrong.

**`delivery_attempts` is append-only.** Never `UPDATE` a row to reflect a new attempt; insert
a new one. You get a complete audit trail, debuggability, and no lost-update races, for the
price of some disk. Disk is cheap.

**Alternative rejected — MongoDB.** The data is deeply relational (users → events → reminders
→ jobs → attempts) and correctness depends on multi-row transactions and unique constraints,
which is exactly Postgres's strength and exactly what document stores make awkward.

**ORM:** Prisma for type-safe queries and good migrations, dropping to raw SQL for the
dispatcher's `FOR UPDATE SKIP LOCKED` query (Prisma cannot express it). TypeORM is the
NestJS-conventional choice and also fine; Prisma's generated types are meaningfully better.

---

## 6. The Transactional Outbox (the subtlest correctness idea here)

### The problem

Consider the obvious implementation of "create an event and announce it":

```
await db.events.create(event);      // ✅ committed
await kafka.publish(eventCreated);  // ❌ process crashes here
```

Postgres has the event. Kafka never heard about it. These two systems are now permanently
inconsistent, and nothing will ever fix it. Swap the order and you get the opposite bug: Kafka
announces an event that does not exist.

This is the **dual-write problem**, and it has no solution _at this level_ — you cannot make
writes to two different systems atomic. Distributed transactions (2PC) technically can, but
they are slow, operationally miserable, and Kafka does not meaningfully support them.

### The solution

Write the message to an `outbox` **table in the same Postgres transaction** as the business
data. Now there is only one write, to one system, and it is atomic — it either all happened or
none of it did.

```
BEGIN;
  INSERT INTO events ...;
  INSERT INTO outbox (topic, payload) ...;
COMMIT;
```

A separate **Outbox Relay** process then polls for unpublished rows, publishes them to Kafka,
and marks them published.

```
SELECT * FROM outbox WHERE published_at IS NULL
ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;
```

If the relay crashes after publishing but before marking, it republishes on restart. That is a
**duplicate, not a loss** — and duplicates are survivable because every consumer is idempotent
(next section). Losses are not survivable. **This is the fundamental trade: you convert an
unfixable consistency bug into a duplicate, then you kill the duplicate downstream.**

**Alternative — Debezium / CDC.** Reads the Postgres write-ahead log directly and streams
changes to Kafka with no polling and no relay code. This is the production-grade answer and
worth naming in your README. Rejected for MVP because Debezium is a whole Kafka Connect
deployment to operate, and writing the relay yourself is where the learning is.

---

## 7. API Design

REST over HTTP/JSON. GraphQL would be defensible but adds schema/resolver/N+1 concerns that
teach you GraphQL rather than distributed systems. gRPC is excellent between services and
awkward from browsers.

Versioned under `/api/v1`.

```
POST   /api/v1/auth/register          { email, password, timezone }
POST   /api/v1/auth/verify-email      { token }
POST   /api/v1/auth/login             { email, password } → { accessToken } + refresh cookie
POST   /api/v1/auth/refresh           (refresh cookie) → new access + rotated refresh
POST   /api/v1/auth/logout

GET    /api/v1/me
PATCH  /api/v1/me                     { timezone, notificationPreferences }

GET    /api/v1/events?cursor=&limit=&status=
POST   /api/v1/events                 { title, startsAtLocal, timezone, rrule, reminders[] }
GET    /api/v1/events/:id
PATCH  /api/v1/events/:id
DELETE /api/v1/events/:id             (soft delete)
POST   /api/v1/events/:id/pause
GET    /api/v1/events/:id/occurrences?from=&to=   ◄── preview expansion, no writes

POST   /api/v1/push/subscriptions     { endpoint, keys:{p256dh, auth} }
DELETE /api/v1/push/subscriptions/:id

GET    /api/v1/notifications?cursor=&limit=       ◄── delivery history
```

### API decisions

**`GET /events/:id/occurrences` is a pure function with no side effects.** The UI calls it to
show "next 10 occurrences" as the user types an RRULE. Because it shares the exact expansion
code the Materializer uses, the preview cannot drift from reality. Shared logic in
`libs/recurrence` — one implementation, two call sites.

**Cursor pagination, not offset.** `OFFSET 10000` makes Postgres walk and discard 10,000 rows,
and if a row is inserted between page loads the user sees an item twice or misses one entirely.
Keyset pagination (`WHERE (created_at, id) < (:cursor)`) is O(log n) and stable under
concurrent writes.

**`POST` accepts an `Idempotency-Key` header.** A mobile client on a flaky connection retries;
without this, the user gets two identical events. Store the key → response mapping in Redis
with a 24h TTL and replay the original response. This is the Stripe convention and is worth
copying.

**Validation at the edge with `class-validator` DTOs**, including validating the RRULE string
by actually parsing it and rejecting rules that generate nothing or generate absurd volume
(`FREQ=SECONDLY` would materialize 2.6 million jobs a month — reject it, or your database
becomes the attack). Treat this as an abuse-prevention control, not just input validation.

---

## 8. Kafka: Topics and Event Flow

### First: why Kafka at all?

Honestly — for this scale, **you do not need it.** Postgres `SKIP LOCKED` would carry this
workload comfortably to hundreds of thousands of notifications a day. You are choosing Kafka
because you want to learn it, and that is a completely legitimate reason. But say so in your
README rather than pretending it was capacity-driven; overclaiming is the thing experienced
reviewers notice, and _"I chose this to learn it, here is when I'd actually reach for it"_
reads as far more senior than a fabricated scale justification.

What Kafka genuinely buys you here: consumer groups (add a worker, partitions rebalance, no
code change), replayability (fix a bug, reset the offset, reprocess a day), and a durable
buffer so a provider outage backs up harmlessly instead of dropping work.

**Alternatives:** RabbitMQ (better at per-message TTL and delayed delivery, worse at replay),
Postgres-only (simplest, genuinely sufficient), SQS+SNS (cheapest on AWS, zero ops).

### Topics

| Topic                             | Key       | Partitions | Purpose                             |
| --------------------------------- | --------- | ---------- | ----------------------------------- |
| `wanderly.notification.requested` | `user_id` | 6          | Dispatcher → fan-out                |
| `wanderly.delivery.email`         | `user_id` | 6          | Email worker input                  |
| `wanderly.delivery.push`          | `user_id` | 6          | Push worker input                   |
| `wanderly.delivery.result`        | `job_id`  | 3          | Outcomes → status updater           |
| `wanderly.retry.1m`               | `user_id` | 3          | Tiered retry                        |
| `wanderly.retry.10m`              | `user_id` | 3          | Tiered retry                        |
| `wanderly.retry.1h`               | `user_id` | 3          | Tiered retry                        |
| `wanderly.dlq`                    | `user_id` | 3          | Terminal failures, human inspection |

**Why key by `user_id`:** Kafka guarantees ordering _within a partition_, and same key → same
partition. So all of one user's notifications are processed in order, while different users
process in parallel. Keying by `job_id` would maximize parallelism but let a user's 9:00 and
9:05 reminders arrive out of order.

**Why 6 partitions:** partition count caps your consumer parallelism — 6 partitions means at
most 6 useful email workers. Increasing partitions later is possible but _rehashes keys_,
breaking ordering for in-flight work. Slight over-provisioning now is cheap insurance.

### The flow, end to end

```
1. Dispatcher: SELECT due jobs FOR UPDATE SKIP LOCKED
                → UPDATE status='QUEUED'
                → INSERT into outbox        [one transaction]

2. Outbox Relay → publishes to wanderly.notification.requested

3. Fan-out consumer:
     reads job → loads user preferences (Redis cache)
     → for each channel in reminder.channels, if not globally muted:
         publish to wanderly.delivery.{email|push}
     ◄── this is where one job becomes N channel-specific messages

4. Email worker:
     idempotency check (Redis fast path → Postgres unique constraint)
     → render template → EmailProvider.send()
     → INSERT delivery_attempts
     → publish result to wanderly.delivery.result
     → on retryable failure: publish to the next retry tier

5. Status updater: consumes delivery.result → updates notification_jobs.status
```

**Why fan-out is its own step** rather than the dispatcher publishing directly to channel
topics: the dispatcher's job is "what is due?", not "who wants what, where?" Separating them
means adding SMS later touches exactly one consumer, and a slow preference lookup never slows
the time-critical dispatch loop.

---

## 9. Retry and Backoff

### Kafka has no delayed messages

This surprises people. RabbitMQ has per-message TTL + dead-letter exchanges; SQS has
`DelaySeconds`. Kafka has _nothing_ — a partition is a strictly ordered log, so "deliver this
one later" would require reordering the log, which is precisely what Kafka refuses to do.

Naively sleeping in the consumer is a real bug, not a shortcut: a Kafka consumer holds its
partition while processing, so `sleep(60s)` stalls **every other message in that partition**
behind it. This is head-of-line blocking, and it turns one slow message into an outage for
that partition.

### The solution: tiered retry topics

Instead of delaying a message, **move it to a topic whose consumer is deliberately slow.**

```
delivery.email ──fail──► retry.1m ──fail──► retry.10m ──fail──► retry.1h ──fail──► dlq
```

The `retry.1m` consumer reads a message, checks its timestamp, and if less than 60s have
elapsed, **pauses the partition** and re-polls later — it does not commit the offset. Because
every message in that topic needs roughly the same delay, ordering is preserved and no message
is stuck behind a message with a longer wait. This is the standard industry pattern (Uber
published a well-known writeup of it) and knowing it is a genuine signal of Kafka depth.

### Backoff policy

Exponential backoff with **full jitter**:

```
delay = random(0, min(cap, base * 2^attempt))
```

**Why jitter is not optional:** if a provider goes down for 5 minutes, 10,000 notifications
fail at once. With pure exponential backoff all 10,000 retry at _exactly_ the same instant,
hammering a recovering service into falling over again. This is a **thundering herd**, and it
is how a brief outage becomes a long one. Randomizing spreads the retries out. Full jitter
(random across the whole window, not `delay ± 10%`) spreads them best.

### Classify errors — this is where most implementations go wrong

**Never retry blindly.** Split failures into three classes:

| Class          | Examples                                            | Action                               |
| -------------- | --------------------------------------------------- | ------------------------------------ |
| **Retryable**  | 5xx, timeout, connection reset, 429                 | Retry with backoff                   |
| **Permanent**  | 400 malformed, invalid email, 404 push subscription | Fail immediately, do not retry       |
| **Actionable** | Push returns 410 Gone / 404                         | Fail **and delete the subscription** |

Retrying a permanent failure 5 times wastes 5 provider calls, delays the DLQ signal, and — if
the provider charges per attempt — costs real money. That 410-Gone case is specific and worth
implementing: web push endpoints expire constantly as users clear browser data. If you never
prune them, your `push_subscriptions` table fills with dead endpoints and your delivery success
rate silently rots. **Self-healing data is a nice thing to be able to point at.**

Also respect `Retry-After` when a provider sends it. It is the provider telling you exactly
what it wants; ignoring it to use your own backoff is how you get rate-limited harder.

### Circuit breaker

If a provider fails past a threshold (say 50% of the last 20 calls), **open the circuit**: stop
calling it entirely for 30 seconds, failing fast into the retry tiers instead. Then half-open —
let one request through to test recovery. Track state in Redis so all worker replicas share one
view.

**Why:** when a provider is down, calling it is pure waste — you burn a worker slot for the
full timeout on every message, so your throughput collapses to zero and the backlog grows.
Failing fast keeps workers free and the queue draining into retry tiers.

---

## 10. Idempotency

### Why it is unavoidable

Kafka gives **at-least-once** delivery by default. A consumer that processes a message and then
crashes before committing its offset will reprocess that message on restart. Exactly-once
exists in Kafka but only for Kafka-to-Kafka transactions — the moment you call an external
email API, the guarantee is gone, because you cannot roll back an email.

So duplicates _will_ happen. The system must make them **harmless**, and the honest framing is:
**you do not prevent duplicate processing; you make duplicate processing produce no duplicate
effect.**

### Defense in depth — three layers

**Layer 1 — Materialization.** `unique (reminder_id, occurrence_at)` + `ON CONFLICT DO NOTHING`.
The materializer can run twice concurrently and produce identical results.

**Layer 2 — Delivery, deterministic key.**

```
idempotency_key = sha256(job_id + ":" + channel + ":" + destination)
```

Deterministic, not random — the _same message reprocessed_ must produce the _same key_, or the
whole mechanism does nothing.

**Layer 3 — Two-phase check.**

```
1. Redis:  SET idem:{key} "processing" NX EX 86400
           → returns null? Someone else has it. Skip.
2. Send via provider.
3. Postgres: INSERT INTO delivery_attempts (...) — unique constraint on idempotency_key
           → conflict? A duplicate slipped through. Swallow it.
```

**Why both Redis and Postgres:** Redis is the fast path — it stops 99.9% of duplicates without
touching the database, and `SET NX` is atomic so two workers cannot both win. But Redis can
lose keys (eviction, restart, failover), so it cannot be the guarantee. Postgres's unique
constraint is the _actual_ guarantee: slower, but it cannot be wrong.

**Fast path for performance, durable constraint for correctness.** That layering shows up
everywhere in system design once you start looking for it.

### The unavoidable gap

If the worker crashes _between_ the provider send and the Postgres insert, the email went out
but nothing recorded it — so a retry sends it twice. This window cannot be fully closed without
provider-side idempotency. The mitigations:

- Pass your idempotency key as the provider's own idempotency key when supported (Resend,
  Stripe, SendGrid all accept one). Then the _provider_ dedupes.
- Keep the window as small as possible.
- Accept it. A rare duplicate birthday email is a vastly better failure than a missed one.

**Knowing where your guarantees end is more valuable than pretending they do not.** Say this
out loud in an interview and you will sound like someone who has run a system in production.

---

## 11. Redis: What It Is Actually For

Redis is a **cache and a coordination primitive**. Nothing lives _only_ in Redis. If Redis is
wiped, the system must still be correct — just slower.

| Use                   | Structure                 | TTL         | Why Redis and not Postgres                 |
| --------------------- | ------------------------- | ----------- | ------------------------------------------ |
| Idempotency fast path | `SET NX`                  | 24h         | Avoids a DB round trip per message         |
| API idempotency keys  | Hash                      | 24h         | Replay POST responses                      |
| Rate limiting         | Sorted set / token bucket | rolling     | Atomic increment-and-check via Lua         |
| Leader election       | `SET NX PX` + heartbeat   | 30s         | Only one dispatcher may be active          |
| Session denylist      | Set                       | = token TTL | Revoke a JWT before it expires             |
| User preference cache | Hash                      | 5m          | Read on every notification; changes rarely |
| Circuit breaker state | Hash                      | 60s         | Shared across worker replicas              |

### Leader election, concretely

The Dispatcher **must not** run on two replicas simultaneously, or every notification is
dispatched twice.

```
SET wanderly:leader:dispatcher {instance_id} NX PX 30000
```

Whoever wins is leader and re-extends the key every 10s. If the leader dies, the key expires in
≤30s and another instance takes over. Note the **10s renew vs 30s TTL** ratio — it must tolerate
a couple of missed renewals from a GC pause or network blip without spuriously failing over.

**This is not a perfect lock.** A leader that pauses for 40 seconds may still believe it is
leader after another instance took over. This is the well-known Redlock critique, and it is
correct. Your protection is that the _dispatch itself_ is idempotent (`FOR UPDATE SKIP LOCKED`
plus the status transition means the same job cannot be dispatched twice anyway). The lock is
an **optimization to avoid wasted work**, not a correctness guarantee.

**Never let a lock be your only correctness mechanism.** Genuine distributed locking needs
consensus — etcd, ZooKeeper, Consul — and even then, fencing tokens. Overkill here, but know
why the shortcut is acceptable in _this specific case_: because the layer beneath it is already
safe.

**Alternative — Postgres advisory locks.** `pg_try_advisory_lock()` gives you the same thing
with one fewer moving part, and is genuinely a good choice if you want to drop Redis.

---

## 12. Authentication and Authorization

### Tokens

**Short-lived access JWT (15 min) + long-lived rotating refresh token (30 days).**

- Access token: JWT, signed **RS256**, sent as `Authorization: Bearer`. Stateless — any service
  verifies it with the public key, no database call. RS256 over HS256 so workers can _verify_
  without holding the key that could _mint_ tokens.
- Refresh token: opaque random string, stored **hashed** (SHA-256) in Postgres, sent as an
  `HttpOnly; Secure; SameSite=Strict` cookie.

**Why hashed:** a leaked database dump then contains no usable tokens. Same reasoning as
password hashing. (SHA-256 is sufficient here, unlike for passwords, because the token is
already high-entropy random — there is no dictionary to attack.)

**Why the split at all:** stateless JWTs are fast but cannot be revoked; database sessions are
revocable but cost a query per request. Short access + revocable refresh gives you most of
both, bounding the damage from a stolen access token to 15 minutes.

### Refresh token rotation with reuse detection

Every refresh **invalidates the old token and issues a new one**, both tagged with a shared
`family_id`. If a token that was already used is presented again, that means someone stole it —
so **revoke the entire family**, forcing a full re-login.

This is the mechanism that makes stolen refresh tokens detectable rather than silently
exploitable, and it is a strong thing to have built.

**Why `SameSite=Strict` + HttpOnly:** HttpOnly means XSS cannot read the token; SameSite blocks
CSRF. Storing tokens in `localStorage` — the common tutorial approach — is readable by any
injected script.

### Passwords

**Argon2id.** Memory-hard, so GPU cracking is expensive. bcrypt is acceptable and battle-tested;
Argon2id is the current recommendation and won the Password Hashing Competition. Never SHA-256
alone — it is _designed_ to be fast, which is the opposite of what you want.

### Authorization

Ownership-based, enforced in the data layer. **Every query is scoped by `user_id`** — never
`findById(id)` followed by a check, because the day someone forgets the check is the day you
have an IDOR vulnerability. A NestJS Guard plus a repository that requires a `userId` argument
makes forgetting structurally difficult. _Make the safe thing the default and the unsafe thing
hard to express_ — that is better than remembering to be careful.

Add per-IP and per-user rate limiting on auth endpoints (Redis) to blunt credential stuffing.

---

## 13. Testing Strategy

The testing pyramid, with the middle layer weighted heaviest — because in a distributed system
the bugs live _between_ components, not inside them.

### Unit tests (Jest) — fast, no I/O

The highest-value target is **`libs/recurrence`**, which is pure and therefore trivially
testable. Test it exhaustively — this is where the real bugs are:

- Every RRULE frequency and combination you support
- DST spring-forward (a nonexistent local time) and fall-back (an ambiguous one)
- Feb 29, `BYMONTHDAY=31` in short months
- `UNTIL` and `COUNT` boundaries
- Timezones on both sides of the equator, and a half-hour offset (`Asia/Kolkata`)

Also unit-test: backoff+jitter math (bounds, monotonicity), error classification, idempotency
key determinism.

### Integration tests — real infrastructure, via Testcontainers

**Do not mock Postgres, Redis, or Kafka.** Mocks encode your _belief_ about how they behave, so
they pass exactly when your belief is wrong — which is precisely the bug you were testing for.
Testcontainers spins up real ones per test run.

Tests that must exist:

- Materializer run twice concurrently → exactly one set of jobs (proves the unique constraint)
- Two dispatchers against one table → disjoint batches, nothing processed twice (`SKIP LOCKED`)
- Same Kafka message delivered twice → one `delivery_attempts` row, one email
- Provider fails 3× then succeeds → correct tier progression and exactly one email
- Provider fails permanently → lands in DLQ, does _not_ retry
- Push returns 410 → subscription deleted
- Refresh token reuse → whole family revoked

That list _is_ the design document, expressed as executable assertions. If those pass, the
system works.

### Contract tests

Verify that produced Kafka messages match a schema. A worker deserializing a field a producer
renamed is a classic distributed-systems outage. Consider Zod schemas shared in `libs/contracts`
as the single source of truth (or Avro + Schema Registry, which is the heavier industry answer).

### End-to-end

A small number, covering the golden path only: register → create event → materialize → dispatch
→ assert email visible in **Mailpit's HTTP API**. Mailpit being queryable over HTTP makes email
assertions genuinely easy — a real advantage over mocking SMTP.

### Not tested

Do not chase 100% coverage. Controllers that only delegate, DTOs, generated code — testing
these produces maintenance burden and no signal. Target ~80% overall with near-100% on
`libs/recurrence` and the idempotency paths. **Coverage percentage is a weak metric; "does a
test fail when I break the invariant?" is the real one.**

### CI (GitHub Actions)

```
lint → typecheck → unit → integration (services: pg, redis, kafka) → build images → e2e
```

Use GitHub Actions `services:` for Postgres/Redis (faster than Testcontainers in CI), cache
`node_modules` by lockfile hash, and run migrations against a scratch database to verify they
actually apply. Fail the build on coverage regression, not on an absolute threshold.

---

## 14. Docker Architecture

`docker-compose.yml` — one command brings up the entire platform.

| Service     | Image                    | Notes                              |
| ----------- | ------------------------ | ---------------------------------- |
| `postgres`  | `postgres:16-alpine`     | named volume, healthcheck          |
| `redis`     | `redis:7-alpine`         | AOF on, so restarts are survivable |
| `kafka`     | `bitnami/kafka:3.7`      | **KRaft mode — no ZooKeeper**      |
| `kafka-ui`  | `provectuslabs/kafka-ui` | inspect topics/lag in a browser    |
| `mailpit`   | `axllent/mailpit`        | SMTP + web inbox at :8025          |
| `api`       | local build              | NestJS HTTP                        |
| `worker`    | local build              | delivery consumers                 |
| `scheduler` | local build              | materializer + dispatcher          |
| `relay`     | local build              | outbox relay                       |
| `web`       | local build              | React + Vite                       |

**KRaft mode, not ZooKeeper.** ZooKeeper is deprecated in modern Kafka; KRaft is one fewer
container and one fewer thing to explain.

**`kafka-ui` earns its place for learning specifically** — being able to _see_ partitions,
consumer lag, and messages sitting in the DLQ turns Kafka from an abstraction into something
concrete. Watching consumer lag grow during a simulated provider outage, then drain, is the
single best way to build intuition for what a queue is actually doing.

### Dockerfile approach

**Multi-stage builds:** `deps → build → runtime`. The runtime stage carries only production
`node_modules` and compiled output — no TypeScript compiler, no dev dependencies. Cuts image
size roughly 5×, which means faster deploys and a smaller attack surface.

One Dockerfile with a build arg selecting the entrypoint, since all four backend services share
a build. Run as a **non-root user**. Add `HEALTHCHECK` and honour `depends_on: condition:
service_healthy` so the API does not race Postgres on startup.

**Dev vs prod compose:** `docker-compose.yml` + `docker-compose.override.yml`. The override
mounts source for hot reload and exposes debug ports; it is picked up automatically in dev and
ignored in CI/prod via `-f`.

---

## 15. Future AWS Deployment

Sketch only — do this after the system works locally.

| Local                        | AWS                                       | Why / cost note                                                                                            |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `api`, `worker`, `scheduler` | **ECS Fargate**                           | No servers to patch; scale services independently. EKS is more powerful and far more operational overhead. |
| `postgres`                   | **RDS Postgres** (Multi-AZ later)         | Managed backups, PITR, failover                                                                            |
| `redis`                      | **ElastiCache Redis**                     |                                                                                                            |
| `kafka`                      | **MSK Serverless** ⚠️                     | Expensive — roughly $100+/mo minimum. See below.                                                           |
| `mailpit`                    | **SES**                                   | Effectively free at low volume; needs domain verification                                                  |
| `web`                        | **S3 + CloudFront**                       | Static SPA, cheap and fast                                                                                 |
| images                       | **ECR**                                   |                                                                                                            |
| secrets                      | **Secrets Manager** / SSM Parameter Store | Never environment variables in a task definition                                                           |
| logs/metrics                 | **CloudWatch** + OpenTelemetry            |                                                                                                            |

**The Kafka cost problem, honestly:** MSK is the single line item that makes this project
expensive to run. Options, in order of what most people should do:

1. **Do not deploy Kafka.** Keep the Kafka path for local demo and swap in **SQS + SNS** for the
   deployed version — near-free at low volume, and if your code depends on a `MessageBus`
   interface rather than a Kafka client, this is a small change. _That abstraction is itself the
   demonstration of good design._
2. Run single-broker Kafka on a small EC2 instance (cheap, not HA — fine for a portfolio).
3. Pay for MSK if you specifically want MSK on your résumé.

**Scaling story to be able to tell:** API scales on CPU/request count; workers scale on **Kafka
consumer lag** (the correct signal — queue depth, not CPU, is what indicates a delivery backlog);
the scheduler stays at a fixed small count with leader election.

**Deployment:** GitHub Actions → build → push to ECR → update ECS service with rolling
deployment and circuit-breaker rollback. Run migrations as a **one-off ECS task before** the
service update, and keep migrations **backward compatible** — during a rolling deploy old and
new code run simultaneously against one schema. Expand-then-contract: add a column, deploy code
that writes both, backfill, then drop the old column in a _later_ release. This is a real
operational skill and a good interview topic.

---

## 16. Suggested Build Order

Each phase produces something demonstrable. Resist building the next before the current one
works end to end.

1. **Foundations** — monorepo, Docker Compose (pg/redis/kafka/mailpit), NestJS skeleton, health
   checks, CI running lint+typecheck.
2. **Auth** — register/verify/login/refresh/logout, Argon2id, rotation + reuse detection, guards,
   integration tests. _Milestone: a real user can log in._
3. **`libs/recurrence`** — pure RRULE + timezone expansion. Build this in **complete isolation
   with only unit tests.** No HTTP, no database. It is the highest-risk, highest-value component;
   getting it right alone is far easier than debugging it inside a pipeline.
4. **Events CRUD** — DTO validation, RRULE validation, ownership scoping, occurrence preview.
   _Milestone: create a recurring event and see its next 10 occurrences._
5. **Materializer** — horizon expansion, idempotent upsert, version invalidation on edit.
   _Milestone: `notification_jobs` rows appear with correct `scheduled_for`._
6. **Dispatcher + Outbox + Relay** — `SKIP LOCKED`, leader election, transactional outbox.
   _Milestone: messages land in Kafka; watch them in kafka-ui._
7. **Email worker** — idempotency, template rendering, `delivery_attempts`.
   _Milestone: an email appears in Mailpit at the right moment. **This is the first true
   end-to-end success — pause and appreciate it.**_
8. **Retries** — tiered topics, backoff+jitter, error classification, DLQ, circuit breaker.
   _Milestone: kill Mailpit, watch messages walk the retry tiers and land in the DLQ._
9. **Web push** — VAPID keys, service worker, subscription lifecycle, 410 pruning.
10. **Frontend** — React + TS, RRULE builder UI with live occurrence preview, history view.
11. **Observability** — structured JSON logs with a correlation ID threaded from API through
    Kafka to worker, `/metrics`, a lag dashboard.
12. **Hardening** — rate limits, load test, chaos (kill workers mid-flight and prove nothing is
    lost or duplicated).

---

## 17. What Makes This Read As Senior

Not the feature list. These:

- **A written answer to "what happens on Feb 29 / during DST."** Most people have not thought
  about it.
- **Knowing where your guarantees end** — the send-then-crash window in §10, stated openly
  rather than papered over.
- **The outbox pattern**, and being able to explain the dual-write problem it solves.
- **Error classification**, because "retry everything" is the default and it is wrong.
- **Saying Kafka is over-engineered here, and why you chose it anyway.** Honest scoping reads as
  senior; invented scale justifications read as junior.
- **Constraints over code** — `unique (reminder_id, occurrence_at)` as the actual guarantee.
- **Tests that assert invariants**, not tests that assert coverage.

## Verification

The system is working when, with `docker compose up`:

1. Create a recurring event 2 minutes out; an email appears in Mailpit (`localhost:8025`) at the
   right instant, and a push notification fires.
2. Stop Mailpit, trigger a notification: kafka-ui shows the message walking
   `retry.1m → retry.10m → dlq`; restart Mailpit and confirm a retried message delivers.
3. Run two `scheduler` replicas: exactly one email per notification (leader election + idempotency).
4. Kill a worker mid-processing: on restart, nothing is lost and nothing is duplicated.
5. `npm test` — unit + Testcontainers integration green; the invariant tests listed in §13 pass.
