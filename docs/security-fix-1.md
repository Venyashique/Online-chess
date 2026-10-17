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

## Replay incident fix (migration 007, local only)

Release candidate 0400b051 relied on provider single-use: Siteverify success alone
allowed creation. Production smoke reported the same real proof accepted twice.
The replacement must remain safe even if Siteverify returns success repeatedly.
This is an application defense; the Cloudflare incident itself is not diagnosed
by local provider adapters. No real keys/tokens were used in regression tests.

### Durable burn and bounded storage

The new handler awaits `online_api_admit`, then hashes the EXACT challenge string
with Web Crypto SHA-256 and awaits `online_api_reserve_turnstile` in a separate
RPC transaction BEFORE Siteverify. Only the winner proceeds. A lost response,
provider denial/timeout, failed creation or actual creation SQL rollback never
releases a committed reservation. Missing proofs create no registry entry.
Existing-game owner restoration still uses admission's recognized session path;
this creates no new game and does not require another proof.

`online_security.turnstile_uses` stores only the 32-byte proof hash, random
reservation UUID, game UUID, SHA-256 player credential binding and timestamps.
There is NO game FK: game deletion cannot release a proof. There is no raw
challenge/player credential or IP in this table or in application logs.

The central policy adds defaults/hard safety bounds:

| Setting | Default | Allowed |
| --- | --- | --- |
| turnstile_ttl_seconds | 600 | 600..3600 |
| turnstile_capacity | 2048 | 1..100000 |
| turnstile_cleanup_batch | 128 | 1..1000 |
| turnstile_max_age_seconds | 240 | 1..240 |
| turnstile_future_skew_seconds | 30 | 0..30 |

Registry admission deletes at most one batch of expired rows, checks duplicates
and capacity, then inserts, under a dedicated transaction advisory lock. Both
reservation and final creation acquire that lock first; creation then locks
policy/reservation in a fixed order. PostgreSQL wall-clock time is sampled AFTER
waits. The primary key is an additional duplicate barrier. Never evict a live
reservation to admit new traffic. Capacity/SQL/malformed response failures close
creation with 503; no automatic mutation retry. No Cron is necessary. Without
traffic expired rows remain but row count is bounded. PostgreSQL autovacuum still
needs normal operational monitoring; a row bound is not a physical disk quota.
This registry cleanup does NOT delete games or enable game retention deletion.

### Mandatory proof of reservation

007 moves the existing quota-aware creation implementation into owner-only
`online_security.create_game_unchecked`; even service_role cannot execute it.
`online_api_create(uuid,text,text)` becomes an unconditional UNAVAILABLE stub,
so stale deployed Functions cannot continue to create without reservations.
`online_api_create_reserved(uuid,text,text,uuid,timestamptz)` requires matching
unexpired, unused reservation/game/player binding. It checks freshness AFTER
locks and again AFTER creation/trigger waits. Expiry during creation raises a
generic SQL exception, rolling back the entire game/quota/outbox transaction;
the earlier reservation burn and attempt counter remain committed.
Reservation consumption and successful game creation commit atomically.
All new public entrypoints are service-role-only; private tables have RLS, no
browser/service table grants; every definer has an empty search_path.

Frontend already clears/resets its challenge at submission. Regression testing
requires a replacement proof after rejection, with no automatic creation retry.
There is no frontend production-code change or new secret in this fix.

### Timestamp/TTL trust boundary

Siteverify must return valid UTC `challenge_ts`, exact hostname and action
`create_game`, in addition to boolean success. Edge hard ceilings are age <=240s
and future skew <=30s; DB may tighten them and rechecks at finalization. Even if
an old hash has expired and been cleaned, its old challenge_ts is invalid.
Freshness uses strict timestamp parsing (no normalized invalid calendar dates),
not the time the server received the token. All nodes need healthy clocks.

Finite TTL cannot provide lifetime token uniqueness if the provider returns a
NEW current challenge_ts for the SAME old opaque token. That behavior lies beyond
this bounded registry's trust assumptions. If observed, pause creation and resolve
provider behavior; do not extend acceptance or disable freshness checks.
A stolen token can be burned first by someone else, causing that challenge to
fail; the legitimate user must complete a new challenge. Registry exhaustion is
a bounded denial of new creation, not unbounded DB growth. Existing global
attempt quotas remain ahead of reservation but provider Edge invocation costs
still require operational limits.

### Required native evidence

Run `scripts/check-online-native.mjs` against a freshly provisioned disposable
PostgreSQL/PostgREST fixture with 001..005 and 007 (explicitly NO 006), the updated
policy defaults, and the unchanged Deno entrypoints. Provider adapter accepts
`native-valid-proof:<unique-suffix>` repeatedly, returning current challenge_ts.
The fixture must NOT call Cloudflare or any real Supabase. Existing runner guards
still require private DB, loopback gateway and matching UUID markers. Reset also
truncates the scratch proof registry. Never use this runner with production.

New native scenarios cover six identical-proof requests with different game IDs,
capacity races, concurrent bounded expired cleanup, actual creation rollback,
registry ACL failure, old-server RPC denial, six concurrent finalizations with
binding/freshness checks, and expiry DURING a blocked INSERT trigger. Existing
move CAS, burst, counters, retention, FK lock-cycle and deadlock tests also run.

### Exact staged rollout (SEPARATE production authorization required)

1. Keep rollout paused. Confirm actual 004/005 installation, current Function
   versions and backup. Do not modify 004/005 or deploy old RC 0400b051.
2. After review, apply ONLY `202610170007_online_turnstile_replay.sql` to the
   existing 004/005 database. 006 is deliberately skipped and remains pending.
   Do not run blanket db push. Record this explicit migration ordering in the
   deployment tool's migration history, preserving the unapplied 006 status.
3. Run the read-only checks below. Old online_api_create MUST return UNAVAILABLE
   for every argument set. Stale online-api instances now fail new creation with
   503; reads/join/moves remain available. Legacy PUBLIC RPC are STILL open and
   H1 is STILL NOT CLOSED. If checks fail, keep creation closed and fix forward;
   never restore the unchecked public helper or old creation implementation.
4. Deploy only the replay-aware online-api from the new reviewed commit with its
   pinned Deno config/lock. No new secrets: use existing Turnstile secret and exact
   hostname allowlist. Do not deploy submit-online-move/frontend for this fix unless
   separate changes require it; this fix changes neither public request format nor
   move entrypoint. If deployment fails, leave the old create stub fail-closed.
5. Controlled production smoke with fresh proof: first new-game create succeeds;
   SAME proof with another UUID/player must return CAPTCHA_INVALID and create
   nothing. Repeat with a small concurrent pair. Do not retry Cloudflare tokens
   for actual gameplay; generate fresh challenges. Confirm owner restore, join,
   read, spectator, move, Realtime and reconnect still work; no credentials in logs.
6. Verify bounded registry occupancy/expiry using aggregates only. No game DELETE
   and no Cron. If failure occurs, keep creation closed; do not remove the registry
   or re-enable unchecked creation. Revert Function only to a version that honors
   reservation, or accept the old version's 503 behind the stub.
7. Only after replay/provider findings and full game smoke are reviewed, request
   separate authorization for the final 006 cutover. This fix neither applies nor
   automatically authorizes it. Legacy clients can bypass quotas/CAPTCHA until 006.

Read-only SQL after 007 (no actual credentials or arbitrary RPC invocations):

```sql
select column_name, data_type
from information_schema.columns
where table_schema='online_security' and table_name='turnstile_uses'
order by ordinal_position;

select turnstile_ttl_seconds,turnstile_capacity,turnstile_cleanup_batch,
       turnstile_max_age_seconds,turnstile_future_skew_seconds
from online_security.policy where singleton;

select count(*) as total,
       count(*) filter (where expires_at<=clock_timestamp()) as expired,
       count(*) filter (where consumed_at is not null) as consumed
from online_security.turnstile_uses;

select relrowsecurity from pg_class
where oid='online_security.turnstile_uses'::regclass;

select p.oid::regprocedure as signature,p.prosecdef,p.proconfig,
       has_function_privilege('anon',p.oid,'execute') as anon_execute,
       has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute,
       has_function_privilege('service_role',p.oid,'execute') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='public' and p.proname in
 ('online_api_create','online_api_create_reserved','online_api_reserve_turnstile'))
   or (n.nspname='online_security' and p.proname='create_game_unchecked');
-- Public functions: definer=true, empty search_path, false/false/true.
-- Private unchecked helper: false/false/false EXECUTE.

select pg_get_functiondef('public.online_api_create(uuid,text,text)'::regprocedure);
-- Must contain only unconditional UNAVAILABLE, no call to creation helper.

select role_name,has_table_privilege(role_name,
 'online_security.turnstile_uses','select,insert,update,delete') as table_access
from (values ('anon'),('authenticated'),('service_role')) as r(role_name);
-- All false (the table has no public policies).
```

Local verification of this fix: 225 unit/integration/UI tests (23 files), 30/30
native Deno 2.9.6 + PostgreSQL 17.11/PostgREST 13.0.7 scenarios, zero new native
PostgreSQL deadlocks, both frozen native deno checks, runtime permission probes,
TypeScript (frontend and Edge), production build and diff whitespace checks pass.
The native provider deliberately accepts the same proof repeatedly; no real
Cloudflare/Supabase was contacted. 006 was not applied in this verification.
Build retains the existing >500 kB JS chunk warning. Local fixtures were stopped
and their disposable Docker containers/network removed after verification.
