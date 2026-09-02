# G1-A1 T3.1 pinned manifest graph evidence

Date: 2026-09-02. Base: local T2 commit `bfaf4fb` on `codex/g1-a1-closure-identity`.

## TDD and final candidate

- Initial 48 graph regressions failed against absent APIs, while the existing 157 release tests passed. Implementing the bounded manifest graph made all 205 pass. One intentional malformed fixture needed an `unknown` input shape instead of an incorrectly typed nested hash; typecheck then passed.
- Added 32 snapshot-limit, hostile-input and deterministic DAG model cases, then one shared-non-leaf depth case: **81 graph tests**, total release-core **238/238**. Domain **122/122** and identity **56/56** remain unchanged.
- Exact graph budgets: 256 nodes, 1024 unique edges, longest path 32; raw UTF-8 and encoded JCS separately bounded to 8 MiB. Tests cover exact and +1 entry/field/depth/value/byte limits, escaped-byte inflation, snapshot traps and loader recomputation.
- Stored artifacts are compared in full against the recomputed candidate, including every node's actual dependency manifest hash; a caller recomputing an outer hash cannot substitute fields.

## Review dispatch and findings

L4; five views across three existing read-only reviewers: architecture + TypeScript/code quality, security + performance, test strategy. No design lens because no UI files changed. Final statuses: **3 DONE**, P0/P1/P2=0, blocked=0, context retries=0. Two test-view correction/recheck rounds; reviewers never edited source. No quantitative coverage percentage was collected or claimed.

| Finding | Evidence | Resolution |
|---|---|---|
| P2: initial depth case shared only a leaf | In-memory `return known` → `return 0` mutation passed the initial 48 cases | Added pin(1)/pin(6) non-leaf topology, asserted actual canonical visit ordering and paired 32/33-edge boundary; mutant now fails exactly that regression |
| P2: self-hash checks did not protect the node manifest field | Replacing `record.manifestHash` with `record.pin.contract_hash` passed 81 graph cases | Added root/dependency manifest field assertions and rehashed stored-node tamper rejection; mutant now fails the exact-field assertion |

Actual implementation was correct in both cases; these were missing tests protecting it against regressions, not observed production defects.

## Gap Detection Walkthrough

| Workflow / invariant | Existing coverage | Uncovered gap | Action |
|---|---|---|---|
| Full pins and manifest dependencies | Owner/hash mismatch, missing/conflicting/duplicate/extra records, cross-Workspace rejection | none for T3.1 | pass |
| Deterministic graph and path limits | Main 12-seed model; independent architecture 100 DAGs / 1883 precedence assertions / 100 injected cycles; security 30 60-node DAGs / 120 edge/order/JCS/permutation checks | none for T3.1 | pass |
| Hostile input and resource bounds | Proxy/getter/revoked/sparse/alias/cycle probes, trap=0, input/output limits | portable performance SLA not measured | no SLA claim |
| Stored graph verification | Six independent rehashed field-tamper classes plus permanent artifact/manifest regressions | none for intermediate graph | pass |
| Final closure and publication | Agent publisher paused at `publishable-resource.ts` AGENT_RELEASE branch; no new business call sites consume this graph | Source preimages, nested bodies, policies, registry and admission remain | T3.2–T6 stay open |
| PostgreSQL, CI, browser and production | No new execution of those external workflows | not validated for this candidate | no completion/release claim |

## Doc↔Code Walkthrough

| Claim | Code / test evidence | Status |
|---|---|---|
| §4.1.1 describes a separate intermediate artifact | `PreparedPinnedDependencyGraphV1.schema_version`, API comments; publisher pause unchanged | pass |
| Manifest owner/hash and full-pin dependency equality | `parseRecord`, `byVersion`/`byPin`, edge resolution; permanent mismatch tests | pass |
| Longest-path and exact budget behavior | `visit` height memoization and graph snapshot profile; exact/+1 tests | pass |
| Candidate `sealed`/nested hash do not prove registry provenance | Contract explicitly defers authenticity; implementation has no registry or source-body verifier | pass, final closure pending |
| T3 remains open | Plan marks only T3.1 complete; T3.2 and T4–T6 unchecked | pass |

Second pass: none. No missing evidence was treated as a PASS for the full application.

## Verification and operational scope

Final `TURBO_FORCE=true pnpm check` passed at 2026-09-02 11:57 +08:00, after both test-strengthening changes, with zero cache reuse: format, lint, workspace boundaries, contracts, typecheck, tests and build. Release-core remains 238/238 and domain-contracts 122/122. Existing nine non-fatal test-support lint warnings remain unchanged. The final `pnpm architecture:gate:test` rerun also passed **31/31**, skipped/todo=0. This is not the six-PostgreSQL-suite clean-checkout architecture execution.

Independent Windows probe observations: oversized raw/JCS/value inputs rejected within about 60 ms; the escaped JCS probe increased heap by about 19 MiB. These are observations on this host, not service guarantees.

No upload, remote CI run, database change, new host attestation or production deployment occurred. The prior upload denial, server disk constraint and paused Docker recovery remain unchanged; none prevents continued pure T3.2 TDD.

## Compound and continuation

Saved one solution and its summary index entry; architecture/testing rules record intermediate provenance and non-leaf depth testing. `scripts/sync-solution-index.js` is absent, so only the canonical JSONL index was narrowly updated with apply_patch; no renderer/runtime-projection synchronization is claimed. Runtime skill-signal directory is empty; no usage statistics or new global instincts were fabricated.

Next checkpoint: [[2026-09-02-g1-a1-capability-closure-kernel-handoff-3]]. Continue T3.2; do not report G1-A1 or the complete Agent application as finished.
