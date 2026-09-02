# Better Agent server deployment and CI recovery

## Product scope clarification — 2026-09-02

The product is a complete Agent application modeled on `ai.betteryeah.com`, as specified by the existing product, architecture, and implementation documents. `E:/project/ai/agent` is a reference for server deployment mechanics only. It does not make Better Agent a VitePress or documentation site.

The foundation scope below describes one deployment milestone, not the final user deliverable. Missing frontend, HTTP, and execution capabilities are unfinished implementation of the established application design; completing them does not require the user to redefine the product. The final delivery must run on the user's server, remain independent from neighboring projects, be reachable through `songuu.top`, and pass real browser/API/persistence/runtime acceptance. Database health, CI success, documentation pages, and placeholder UI are not substitutes for that acceptance. Operational changes such as resizing the host root partition still require their own authorization.

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
