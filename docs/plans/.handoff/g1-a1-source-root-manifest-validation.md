# G1-A1 source/root manifest validation — 2026-09-03

## Completed increment

Final Agent assembly now compares the source-derived root dependency manifest with the verified graph's direct-edge-derived root manifest. This closes missing/extra/replaced Strategy and Instruction dependencies, including all-source-disabled roots and a Strategy still reachable through a child. It does not establish publisher or registry provenance.

## Validation

- Root/nested focused tests: 76/76; release-core 1059/1059 in 39 files; domain 169/169 in 16 files.
- `pnpm check`: pass. `pnpm architecture:gate:test`: 37/37, zero failed/skipped/todo.
- `pnpm --filter @better-agent/db test:integration`: six suites passed, cleanup succeeded.
- `pnpm architecture:gate`: pass in an offline-installed disposable clean checkout. Mutation, quality and PostgreSQL gates all exited 0; `cleanBefore` and `cleanAfter` true. PostgreSQL phase: 590,760 ms.
- Exact internal report: [[g1-a1-source-root-manifest-gate-report.json]]. Source snapshot: `sha256:5580d04b39932a0e9f26aaaa99385e1fc68ae8d8a9b38c654cd30d15e54f1db8`, 455 files / 6,630,378 bytes. Gate manifest: `sha256:425d00e1c1d999e58c0ce2a73b3d30cef803e1abedc54a847e69d016bc0b6de5`.
- Outer snapshot excluded 86 control-plane files / 959,817 bytes, digest `sha256:4e7cc04c115cc90e7ba1711bdff4ece77494037ddeaef2237fa320b8cb85d97f`. The internal report correctly contains an empty control-plane manifest.
- After the full gate, only evidence/status documentation is updated. The five runnable implementation/test/gate files are unchanged from the tested snapshot; this report is not a new host attestation of later documentation bytes.

## T0 historical authority readback

The existing verifier `node docs/plans/.handoff/verify-g0-08-host-acceptance.cjs` exited 0. Its configured database remains `127.0.0.1:55433/tech_persistence`; listener process is `com.docker.backend`, not an SSH forward. Its connection setup only checks reader/writer privileges with SELECT; verification independently selects the existing authority record. No append/import/replacement/reset operation ran.

- `verified: true`, `overallStatus: passed`.
- Receipt: `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668`.
- Historical subject: `sha256:1404cd95effc707e72bc5eeb8fb5f882cdc9de53757fa920a71b842f8b32ed08`.
- Authority record: `sha256:a814a854c762cbcae19ce26bb11f698b0cc6a8a44e4a968d62e74c82d58f77ca`.

This resolves T0 availability/readback uncertainty. It does not extend the historical receipt to current code or create a current host-attested reviewer capability.

## Review and learning

Five independent views used three existing reviewers: architecture, security, performance, quality and tests. All converged at P0/P1/P2=0; two reviewers also checked the strict inventory synchronization. Doc/code review passed with a second claim pass. Design lens skipped: backend/test/config changes only. Compound retained one solution, one root-manifest rule and four skill signals; no global instincts were written. The solution index uses the existing JSONL fallback because the renderer is absent.

## Next implementation boundary

T3.2 and T6 remain open. Existing `003_release_deployment` registry accepts only five G0 kinds, lacks complete closure storage, and its owner-only writers are not a G1 compiler authority. Several leaf kinds need the planned G1 resource writers. Next define source-backed typed readback and closure/published-hash/manifest atomic publication against this real boundary, using additive migrations and rejection/rollback fixtures. Do not edit historical migration semantics, manufacture `sealed` authority, or simply unpause `preparePublishedResource`.

No upload, push, production deployment, existing database mutation or public gateway change was performed. Unrelated untracked production-web handoffs 50–57 were preserved.
