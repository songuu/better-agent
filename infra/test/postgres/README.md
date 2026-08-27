# PostgreSQL 16 + pgvector migration harness

This harness pins `pgvector/pgvector:0.8.1-pg16` to the reviewed image digest
`sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337`
and uses an ephemeral `tmpfs` data directory. The test-only database is not
published to the host; the harness talks to it through `docker compose exec`.
The DBA bootstrap installs the platform roles and extensions, while
`bootstrap-test.sql` enrolls distinct non-superuser migrator, runtime, control,
management-issuer and subject-verifier logins.

```powershell
pnpm --filter @better-agent/db test:integration
```

Each run owns a unique Compose project and executes five suites serially:

- `run-integration.mjs` proves the migration engine/version/ledger lifecycle,
  captures the exact G0-05 catalog fingerprint before `004`, proves an empty
  `004 -> 003 -> 004` rollback/reapply restores it, and keeps checksum/down
  guards fail closed;
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
- `run-run-conversation-browser-integration.mjs` independently exercises the
  owner-only Agent Chat/Conversation CAS transaction, two-connection
  single-winner rollback, pointer-free browser identity, same-end-user
  cross-session namespace, persisted-target read/events/cancel, cancellation
  replay/conflict, wrong-principal invisibility and observed Deployment
  revoke/epoch lock fencing.

The auth/RLS suite also authenticates, commits, starts the next transaction and
checks an empty context, then repeats the check after rollback—all through one
physical `psql` connection with a stable backend PID. This models a reused
database session rather than two unrelated `docker exec` calls.

Cleanup failure fails the command. The suites do not apply
`docs/database/*.sql`, connect to a developer database, or treat design DDL as
an executed migration. A passing run is local disposable PostgreSQL 16 evidence;
it does not prove production role enrollment, pooler behavior, external secret
handling, APM/support-export redaction or a deployed database.
