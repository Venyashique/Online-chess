# Security Fix 1: local implementation, deployment NOT performed

The current published client/database remain unchanged. This checkout introduces
limited HTTP entrypoints without accounts. Existing game UUIDs, per-game tokens,
SHA-256 hashes, move CAS/row locks, chess validation and Realtime 4C are retained.

## Boundaries

Browser create/join/read now call `online-api`; moves call `submit-online-move`.
Both handlers use `online_api_admit` as a separate, awaited RPC transaction BEFORE
mutation or chess validation. SQL returns denials rather than raising them, so
attempts commit even when subsequent validation fails or mutation rolls back.
Malformed limiter responses/errors fail closed with 503. No legacy RPC fallback.

The service-role credential remains server-only. `online_api_create` must only be
called by trusted server code AFTER Turnstile Siteverify. Browser roles cannot
execute this or any other new RPC, inspect quotas, choose keys/costs, or change
policy. No IP/header/browser-ID trust is assumed. HTTP CORS is not authorization.

Admission stores only fixed operation keys and keys for existing games/verified
seats. There is no record per request, time window, random ID, token or IP.
Fixed-window counters update the same row, saturate on rejection, and reset in
place. Per-game counter/burst rows have a game FK for eventual cascading cleanup.
Move burst uses atomic row locking and elapsed database time; fixed minute limits
also apply. Separate operation budgets preserve reads/moves during creation spam.
Invalid tokens do not consume a real player's read/move bucket.
Window admission samples wall-clock time after acquiring its row lock and never
rewinds an existing window. Creation checks are VOLATILE and use the current
clock/snapshot, including when their outer SQL statement started earlier.
Recognized idempotent join/create responses share the seat's read quota, so they
cannot become alternative unlimited read endpoints. Denied burst requests retain
fractional refill credit instead of postponing recovery.
The join wrapper uses NO KEY UPDATE, compatible with quota-row FK KEY SHARE
checks. Recognized joins return directly without upgrading to the legacy join's
stronger row lock; this prevents a first-read/idempotent-join lock cycle.

## Server policy

All configurable quotas live in the private singleton
`online_security.policy`. Owner-controlled SQL is the administrative interface;
there is deliberately no public policy-edit API. Windows use server/UTC time:
minute/day limits mean fixed calendar windows (a boundary can admit bursts on
both sides); move burst additionally limits instantaneous attempts.

| Policy column | Default |
| --- | ---: |
| create_minute | 10 newly created games / minute |
| create_day | 100 newly created games / UTC day |
| stored_games | 1000 rows, including expired rows until approved deletion |
| player_reads_minute | 120 / verified game seat |
| spectator_reads_minute | 120 / game, independent from player reads |
| moves_minute | 60 attempts / verified game seat |
| move_burst | 4, replenished at moves_minute / 60 per second |
| joins_minute | 60 / existing game for unrecognized callers |
| create_attempts_minute | 120 / project |
| join_attempts_minute | 600 / project |
| read_attempts_minute | 6000 / project |
| move_attempts_minute | 1200 / project |
| waiting_seconds | 86400 |
| joined_seconds | 604800 |

Global request-attempt counters charge invalid credentials and unsuccessful
requests that reach admission. New-game minute/day quotas charge only an actual
new record, after CAPTCHA verification; denied writes and idempotent retries do
not consume that quota. Creation locks the singleton policy row while checking
quotas/inventory and inserting, preventing concurrent overshoot. Repeating the
same UUID/creator credential restores its existing session without a new CAPTCHA
or a second insertion. A manual same-color retry after an ambiguous client error
reuses its pending UUID/token in memory; no mutation is automatically retried.

## Turnstile and HTTP

`VITE_TURNSTILE_SITE_KEY` is public and needed only for new creation.
Set `TURNSTILE_SECRET_KEY` and `TURNSTILE_ALLOWED_HOSTNAMES` ONLY in Supabase
Function Secrets. Allowed hostnames must be exact, e.g.
`online-chess-venyashique.lively-beech-1023.chatgpt.site`, no scheme, port or path.
The server calls the fixed Siteverify URL, checks success/hostname and action
`create_game`. Single-use/expired proofs are rejected by Siteverify; validation
provider/config errors deny new creation with 503. Reads/join/moves do not require
CAPTCHA. Missing frontend key disables creation while existing games remain usable.
A successful CAPTCHA is not an identity or a guarantee against distributed bots.

Bodies have a 4096-byte bound and a 5-second read deadline. Responses have
`Cache-Control: no-store`; 429/503 expose Retry-After to browser code. UI preserves
the current board, pauses reads until the deadline (including manual/focus/online
triggers), and never retries mutations automatically. No application code logs
request bodies, credentials, challenge tokens, raw IP, or raw backend errors.
Infrastructure request/DB parameter logging still needs deployment review.

## Retention: DRY RUN ONLY

Migration 005 adds `expires_at`. Existing rows receive the full joined-period
grace starting at migration time. New waiting games expire after waiting_seconds;
first join and each confirmed version-increasing move set joined_seconds.
Reads, reconnect and idempotent joins do not extend expiration. Expired games
cannot resume via the new API. Tokens and IDs are not rewritten.
Expiry checks and trigger renewal use clock_timestamp(), not the timestamp at
the start of a statement which may have waited on a row lock. A join/move queued
before expiry but executed after expiry is rejected and cannot revive the game.

`online_cleanup_preview(p_limit)` is service/owner-only, returns count and a
bounded sample (1..1000) without tokens/hashes. It has NO DELETE path or enable
flag. NO Cron job is created. Real deletion/archival needs a future separately
approved change. Consequently expired rows still consume the inventory cap;
creation will eventually stop at 1000 until that policy is implemented/approved.

## Migrations and staged deployment — separate user approval required

Do not replay 4A/4B/4C. Never add online_games to supabase_realtime publication.
Do not run an indiscriminate `supabase db push` for these three files: it would
also apply the final cutover before the new Functions/client are ready. Apply
the exact reviewed stages separately and coordinate migration tracking with the
chosen deployment workflow.

1. Review policy, retention/grace and current inventory; take the agreed backup.
2. Apply 004 (private quotas/service-only wrappers) and 005 (retention/preview).
   Existing public RPC grants intentionally remain at this stage: H1 is NOT closed.
3. Configure the production Turnstile widget/hostname, public site key and server
   secrets. Deploy BOTH updated Functions with their pinned deno.json/deno.lock.
   `submit-online-move` must be upgraded too; a new API alone is insufficient.
4. Build/publish the new Sites client with the real public site key. Do controlled
   smoke tests with independent players, spectator and reconnect.
5. Apply 006 as the final coordinated cutover. It removes PUBLIC/anon/authenticated
   EXECUTE from all five old create/join/read RPC and keeps commit inaccessible.
   Verify actual ACL/RLS plus denied old-RPC calls and successful new-API gameplay.
   Old browser tabs require reload; same-origin seat storage survives reload.
6. Run only the cleanup preview and inspect candidates. Do not schedule deletions.
7. Review provider spend caps, Realtime connection/event/payload caps, usage and
   error monitoring. A public Edge endpoint is still exposed before its handler.

For rollback, prefer reverting the frontend/server version while preserving new
limits or a controlled maintenance response. Do not automatically restore public
unlimited RPC grants as an error-recovery mechanism. Graceful client reload and
failure are preferable to silently reopening the bypass.

## Verification and remaining limits

`npm run typecheck` checks client/shared handlers AND both Deno entrypoints using
`tsconfig.edge.json` and a minimal local declaration of the used Deno API.
`npm test` uses real SQL migrations/roles in isolated PGlite, real handlers,
controlled Siteverify responses, SDK HTTP boundary and React UI. No real provider
or production data are used by these tests. `npm run build` includes typechecks.
PGlite serializes its transactions on one local connection; parallel-handler
tests are useful regressions but do not replace multi-connection PostgreSQL lock/
contention checks.

## Native runtime and concurrency verification

Verified locally with Deno 2.9.6, PostgreSQL 17.11 and PostgREST 13.0.7, using
the pinned Function dependencies and real independent PostgreSQL connections.
Both original Function entrypoints run in native Deno with only the required
environment-variable and loopback network permissions. A test bootstrap selects
two listening ports and replaces only the external Siteverify response. A local
HTTP router strips the /rest/v1 prefix; it forwards every RPC to real PostgREST.
Database Broadcast is an outbox fixture, not a real Realtime/WebSocket server.

Native tests reproduced and verified fixes for three issues that PGlite missed:
expiry during row-lock waits, an FK/idempotent-join deadlock, and stale statement
timestamps reopening quota windows. They also cover successful gameplay,
concurrent creates/capacity/idempotency, competing joins and moves, read isolation,
burst/minute admission, SQL rollback, limiter failure, dry-run cleanup and mixed
operations. Faults and timing barriers are applied only to the disposable fixture.

The repeatable runner is `scripts/check-online-native.mjs`. It intentionally is
not part of ordinary `npm test` and does not add a project dependency. Supply a
private config JSON in a separate fixture directory containing pg@8.16.3:

```sh
node scripts/check-online-native.mjs /path/to/disposable-fixture/config.json
```

The fixture contract is: `isolated: true`, a database named `chess_native` at a
local Docker bridge address, `pg` connection settings, `defaults` captured from
the fresh policy row, the local routing `url`, loopback `apiPort`/`movePort`, a
local-only `anonKey` and a unique `fixtureId`. The same UUID must be the sole row
of `online_security.native_test_fixture(fixture_id uuid)` and be returned by
the router's `/health` response. These markers are verified before any reset.
Never add them to a real database to bypass the guard. The runner truncates test
games, modifies test policy/ACL and installs temporary fault/timing instrumentation.
It writes only noncredential results beside the private config.

Provision the fixture with the exact six migrations, roles anon/authenticated/
service_role plus a NOINHERIT PostgREST authenticator, and a test realtime.send
outbox. Keep PostgreSQL/PostgREST on an internal Docker network, with no production
credentials or data; expose test HTTP listeners only on loopback. Destroy the
fixture after testing. Neither a database password nor a Supabase admin account
is needed from the user for this local verification.

Native Deno and PostgreSQL verification is now complete. Actual hosted Supabase
Edge gateway behavior, real production Turnstile proofs and Realtime delivery
remain rollout smoke checks; do not treat the local provider/outbox fixtures as
proof of those external services.

No per-IP rate identity or user accounts are introduced. Distributed bots can
exhaust shared budgets; quotas can reduce availability; the limiter itself costs
SQL/Edge work. Provider controls must protect ingress/cost before execution.
Public Realtime still accepts untrusted version hints (M1); bounded authorized
reads remain authoritative, but HTTP quotas do not cap WebSocket traffic.
Seat-token revocation/recovery (M2) is a separate task. New CAPTCHA adds a third
party and outage mode affecting creation, not existing gameplay.
