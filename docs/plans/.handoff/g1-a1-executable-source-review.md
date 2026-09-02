# G1-A1 T3.2 executable source increment evidence

Date: 2026-09-02. Base: local T3.1 commit `75062c2` on `codex/g1-a1-closure-identity`.

## Implemented increment

- `prepareExecutableSource` and `verifyExecutableSource` accept closed Agent/Flow candidates, derive deterministic semantic preimages, seed pins and direct dependency manifests, and compare complete recomputed artifacts.
- `deriveExecutableCompiledHash` / `verifyExecutableCompiledHash` bind the source preimage to a supplied strict closure digest and complete published pin. They do not authenticate the closure body or its registry source.
- Agent executable source shares public fields and cross-reference refinements with Agent Release but rejects final compiled/closure fields. Existing Agent publisher remains paused.
- Snapshot limits cover hostile reflection, depth, value/entry counts, UTF-8 keys/strings, aggregate raw/JCS bytes and 4096 aggregate nested Flow nodes. Explicit sets canonicalize; business arrays and ordered branch cases retain order.
- Lossless raw/parsed comparisons and discriminator-based recursive schema dispatch fix two actual defects, with permanent red→green regressions. See [[g1-a1-executable-source-debug-journal]].

## Review dispatch and result

L4, five views across three existing read-only reviewers: architecture + TypeScript/code quality, security + performance, and test strategy. No UI/design lens applies. Final status: all three DONE, remaining P0/P1/P2=0. No coverage percentage was measured or claimed.

Two P1 implementation defects (silent semantic-key loss and exponential recursive parsing) were fixed. Three P2 regression gaps (complete Binding projection, shared gate membership and recursive loop traversal) were strengthened and their in-memory mutations now fail. Reviewers did not edit source. Independent final package reruns passed 319/319 and 127/127.

## Gap Detection Walkthrough

| Invariant | Evidence | Remaining gap |
|---|---|---|
| Source / Release separation | Closed hash fields; shared positive/negative cross-reference fixture | No publication authority supplied by source |
| Semantic preimage preservation | Complete expected document, all six Binding kinds, top-level-only exclusions, nested business keys and array order | Opaque leaf/action/policy contents are not independently validated |
| Recursive Flow handling | Nested set permutations, first-match case ordering, isolated second-case/loop/else version drift, total-node bounds | No final Binding-path or nested closure expansion |
| Parser safety | Proxy/getter traps remain zero; no silent raw/parsed changes; work-count complexity regression | No cross-machine performance SLA |
| Artifact / compiled digest | Complete object verification, strict hashes, source changes and all pin tuple fields | Supplied closure digest is not verified closure body/provenance |
| Registry / admission / app | Existing publisher pause preserved; no external mutation | T3.2 remainder, T4–T6 and full application E2E remain open |

## Doc↔Code Walkthrough

Contract §7.1 matches the implemented exclusions, typed-set sorting, parser barrier, budgets and compiled-hash formula. The plan only records partial T3.2 progress. The manifest/core freeze actual counts (domain 127, release 319), without loosening any gate. Historical acceptance evidence remains unchanged.

Second pass: none. Final reviewer verdict approves this local source-preimage increment only.

## Validation

- Fresh `TURBO_FORCE=true pnpm check` passed on 2026-09-02 at 12:22 +08:00: formatting, lint, workspace boundaries, contracts, typecheck, tests and build, with zero Turbo cache reuse. Existing nine non-fatal test-support lint warnings remain unchanged.
- Source tests: **81**; release-core total: **319/319**. Recursive Flow tests: **5**; domain-contracts total: **127/127**.
- `pnpm architecture:gate:test`: **31/31**, skipped/todo=0, after synchronizing frozen package counts. This is not the complete clean-checkout six-suite PostgreSQL gate.
- Final formatting and `git diff --check` are rechecked after evidence updates. No upload, new remote CI, database mutation, new host attestation or production deployment occurred.

## Compound / continuation

One solution and its canonical JSONL summary entry record both defects and the sensitive regressions. Architecture/debugging/testing rules record the decisions. The repository lacks `scripts/sync-solution-index.js`; no renderer or runtime-projection synchronization is claimed. The global skill-signal directory is empty; no global signal counts or instincts were fabricated or written.

Next checkpoint: [[2026-09-02-g1-a1-capability-closure-kernel-handoff-4]]. Final T3.2 needs kind-specific leaf/operation source adapters, verified nested bodies and compiled hashes, canonical Binding expansion and effective path policies, then T4–T6. The user still requires the complete Agent application and independent deployment.
