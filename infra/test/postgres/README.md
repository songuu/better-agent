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

Each run owns a unique Compose project and executes both suites:

- `run-integration.mjs` proves the migration engine/version/ledger lifecycle;
- `run-auth-rls-integration.mjs` applies the ordered G0-04 migrations as the
  non-superuser migrator and exercises role separation, exact definer
  `search_path` policy, FORCE RLS, signed transaction context, credential
  lifecycle, verifier isolation, assertion replay and append-only audit.

The auth/RLS suite also authenticates, commits, starts the next transaction and
checks an empty context, then repeats the check after rollback—all through one
physical `psql` connection with a stable backend PID. This models a reused
database session rather than two unrelated `docker exec` calls.

Cleanup failure fails the command. The suites do not apply
`docs/database/*.sql`, connect to a developer database, or treat design DDL as
an executed migration. A passing run is local disposable PostgreSQL 16 evidence;
it does not prove production role enrollment, pooler behavior, external secret
handling, APM/support-export redaction or a deployed database.
