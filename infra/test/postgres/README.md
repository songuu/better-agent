# PostgreSQL 16 + pgvector migration harness

This harness pins `pgvector/pgvector:0.8.1-pg16` to the reviewed image digest
`sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337`
and uses an ephemeral `tmpfs` data directory. The test-only database is not
published to the host; the harness talks to it through `docker compose exec`.
The DBA bootstrap installs the platform roles and extensions, while
`bootstrap-test.sql` enrolls distinct non-superuser migrator, runtime, control,
management-issuer, subject-verifier, internal-issuer, and isolated phase
executor logins. A second execution login is the wrong-`session_user`
adversarial fixture.

```powershell
pnpm --filter @better-agent/db test:integration
pnpm architecture:gate
```

The first command runs the complete registered database harness directly. The G0-08
architecture gate additionally verifies the exact migration/suite registry,
OpenAPI and workspace gates, zero conditional test skips, and clean Git state.
On a dirty local worktree it copies only Git tracked plus untracked non-ignored
regular files into a content-addressed disposable directory, creates Git
metadata only there, installs from the pnpm store with `--offline
--frozen-lockfile`, and runs the same gate in that clean snapshot. It compares
the source HEAD, staged diff, and byte-exact status before and after; it never
uses stash, reset, or checkout against the source worktree.

Each run owns a unique Compose project and executes the registered suites serially:

- `run-integration.mjs` proves the migration engine/version/ledger lifecycle,
  names the through-003/004/005 milestones explicitly, appends a dynamic 006
  probe, and reads the selected IDs back from the migration ledger. It captures
  the exact G0-05 catalog fingerprint before `004`, proves empty
  `003 -> 004 -> 005 -> 006 -> 005 -> 004 -> 003 -> 004 -> 005` lifecycle
  restoration, and keeps checksum/down guards fail closed;
- `run-auth-rls-integration.mjs` applies the ordered G0-04 migrations as the
  non-superuser migrator and exercises role separation, exact definer
  `search_path` policy, FORCE RLS, signed transaction context, credential
  lifecycle, verifier isolation, assertion replay and append-only audit.
- `run-release-deployment-integration.mjs` applies the G0-05 migration to a
  fresh PostgreSQL 16 database and proves table ownership/FORCE RLS, function
  ACL separation and default control-role publisher denial. To build downstream
  fixtures it grants the owner-only publishers inside this disposable database,
  exercises typed Draft-to-Release publication and Flow Deployment revision
  assembly, then revokes and independently reads back every temporary grant.
  It also verifies every executable platform role is denied the publisher helper,
  proves Agent Conversation scope parity, activation CAS, production fail-closed behavior, a two-connection
  grant-revoke race, selector-based original-Run-scope denial, typed service
  admission, raw-DML denial, the non-empty rollback guard and secret-log
  redaction. It also runs the browser Agent Release/Experience/Deployment path,
  atomically exchanges a subject assertion for a session and checks the
  public/private projection, correct/wrong verifier behavior and Deployment
  revoke-epoch fence. Browser token issuance remains an API-layer concern and
  is not claimed by this database harness.
- `run-run-billing-integration.mjs` applies the G0-06 migration to a fresh
  PostgreSQL 16 database and proves the four isolated fact owners, all 22
  Workspace-direct facts, exact owner/function/ACL matrices, FORCE RLS and the
  reviewed original-Run surface. It exercises Flow acceptance and namespace
  races, late-failure rollback, zero and positive billing, charge/expiry replay
  and conflict, reserve/settle/release/expire/reconciliation concurrency,
  terminal replay/conflict/rollback, `SIDE_EFFECT_UNKNOWN`, immutable ledger,
  archive evidence, EVENTS/RECOVERY negative and positive matrices, non-empty
  down protection and real `pg_temp` shadow attacks.
- `run-g1-knowledge-database-capability-integration.mjs` applies the complete
  chain and proves exact Knowledge generation/Database operation pins,
  execution-lease-bound immutable receipts, exact replay, key conflict and
  hash-tamper rejection, plus zero direct execution-role receipt-table DML.
- `run-g1-agent-strategy-integration.mjs` proves one host-reviewed compiled
  AgentPlan is consumed once, then exercises exact checkpoint/action CAS,
  decision/outbox binding, unknown-model-outcome termination and replay,
  foreign-operation denial, and zero direct execution-role fact-table DML.
- `run-g1-worker-human-gate-integration.mjs` proves the public resume mutation
  is one PostgreSQL definer transaction: exact replay precedes current grant
  revalidation, ordered barriers expose only the next Gate, the final approval
  creates one Attempt and dispatch, concurrent approve/reject has one durable
  winner, and claim/decision evidence remains private and immutable.
- `run-g1-join-child-integration.mjs` proves the compiled AgentPlan's exact
  join-only policy across root, child and grandchild Runs. It rejects ancestor
  and foreign-target authority, retains one root reservation, commits the
  execution-authored immutable terminal intent, and lets only the billing
  façade settle descendant allocations and root usage. Concurrent settlement,
  replay and recovery use the production functions; no replica terminal
  fixture stands in for the deployed path.
- `run-g1-public-run-events-integration.mjs` applies all migrations and proves
  immutable replay-safe public SSE projections, strict cursor readback, the
  host-only 60-second single-Run browser event-session verifier, current
  Origin/session/principal/Deployment fences, direct runtime DML denial and
  raw-secret exclusion from PostgreSQL facts and logs.
- `run-g1-production-evaluation-integration.mjs` proves immutable evaluation
  suites and terminal Runs, exact aggregate thresholds, host-reviewer/control
  role separation, stale or failed evidence rejection, and one-use atomic
  Agent/Flow production pointer promotion under decision and activation CAS.
- `run-g1-vertical-agent-integration.mjs` executes the browser-facing Agent
  path against one disposable PostgreSQL 16 database: subject-assertion session
  exchange, fixed Knowledge, parameterized read-only Database, a signed inert
  Instruction Skill, HumanGate resume, a bounded join-only child, terminal
  settlement, strict public-event replay and independent durable readback. Its
  exact acceptance marker is emitted only after every layer succeeds.
- `run-run-conversation-browser-integration.mjs` independently exercises the
  owner-only Agent Chat/Conversation CAS transaction, two-connection
  single-winner rollback, pointer-free browser identity, same-end-user
  cross-session namespace, persisted-target read/events/cancel, cancellation
  replay/conflict, wrong-principal invisibility and observed Deployment
  revoke/epoch lock fencing.
- `run-runtime-security-integration.mjs` applies G0-07 and proves the
  internal-service attestation matrix, exact phase ACL/RLS separation,
  same-phase wrong-`session_user` rejection, two-connection Attempt and
  `RUN_DISPATCH` fencing/recovery/retirement, historical attribution billing,
  HOLD/finalizer convergence, and fail-closed Attempt completion for missing,
  open, unknown, or unsafe effect responsibility. It observes two-connection
  same-fact misses for effect envelopes, receipts, usage sources, and termination
  intents, including winner commit, exact loser replay, conflict, one-row
  readback, post-commit response loss, and old-producer replay after fencing and
  terminalization. Checkpoint and billing-source responses are parsed through
  the public domain schemas; the billing matrix includes termination-first and
  full-settlement-before-termination orders. Three isolated databases prove the
  `005` used-installation down guard independently for a new audit fact, legacy
  protocol-v5 provenance, and a v2 ledger authority while comparing migration
  ledger, complete catalog, and runtime-fact digests. Marker-driven interactive
  clients expose real backend PIDs and `pg_blocking_pids` edges; client kill,
  DBA backend termination, timeout cleanup, and raw-buffer secret canaries are
  reported separately from a server/WAL crash claim.

The auth/RLS suite also authenticates, commits, starts the next transaction and
checks an empty context, then repeats the check after rollback—all through one
physical `psql` connection with a stable backend PID. This models a reused
database session rather than two unrelated `docker exec` calls.

Cleanup failure fails the command. The suites do not apply
`docs/database/*.sql`, connect to a developer database, or treat design DDL as
an executed migration. A passing run is local disposable PostgreSQL 16 evidence;
it does not prove production role enrollment, pooler behavior, external secret
handling, APM/support-export redaction or a deployed database.
