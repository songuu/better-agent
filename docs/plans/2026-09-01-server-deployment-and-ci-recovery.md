# Better Agent server deployment and CI recovery

## Goal

Restore the Windows GitHub Actions quality job and deploy the current Better Agent foundation to the same host as the Agent project using an isolated PostgreSQL service and immutable releases.

## Scope

- Enforce LF checkout for every Biome-formatted JavaScript and TypeScript extension.
- Add a regression guard so a future `.gitattributes` change fails the workspace smoke test.
- Reuse the Agent project's immutable release directory, atomic `current` symlink, bounded retention, and post-deploy verification model.
- Keep Better Agent PostgreSQL, roles, credentials, network binding, storage, and migration ledger independent from every existing service.
- Deploy only capabilities that exist in G0-08: source/build evidence, PostgreSQL 16 with pgvector/pgcrypto, roles, and migrations.

## Explicit non-goals

- Do not invent a public HTTP endpoint before the G1 API handler exists.
- Do not share an existing project's PostgreSQL cluster, credentials, or persistent volume.
- Do not weaken the executable architecture gate to make deployment pass.

## Success criteria

1. Formatting, workspace smoke, lint, typecheck, tests, build, and the clean-checkout architecture gate pass.
2. Windows checkout preserves LF for `.mts`, `.cts`, `.tsx`, and `.jsx` files.
3. The server has an immutable release addressed by the deployed Git commit and an atomically switched `current` link.
4. An isolated loopback-only PostgreSQL 16/pgvector service is healthy and contains migrations `0..5` with the expected digest ledger.
5. Deployment is idempotent, keeps credentials outside the release tree, and leaves rollback evidence.

## Risk and verification

This is P4/L4 because it changes production deployment and database state. Verification must include cross-platform CI regression coverage, the complete repository check, clean-checkout architecture acceptance, container health, migration readback, isolation checks, idempotent re-execution, and rollback/current-link evidence.
