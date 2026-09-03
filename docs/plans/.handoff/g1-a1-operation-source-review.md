# G1-A1 T3.2 operation declaration increment evidence

Date: 2026-09-02. Base: local executable-source commit `805b64c` on `codex/g1-a1-closure-identity`.

## Implementation / TDD

- Added closed domain `operation-contract-source/1` and registry/export. Callers supply real input/output JSON documents, not their hash claims. Knowledge queries must be safe; requires-key class requires its key flag.
- `prepareOperationContractSource` derives complete schema digests, versioned preimage and operation pin. It preserves all JSON keys/array order, distinguishes missing output from empty output, checks raw/parsed equality, bounds input/output and freezes detached results.
- `verifyOperationContractSource` / `verifyOperationContractPin` compare complete recomputation, not only a supplied digest. `verifyBindingOperationContract` connects concrete Binding declarations to operation kind, schemas, effect, config hash/name and required key/approval declarations. Skill Pack routes remain separate; G1 database write/unsafe combinations remain forbidden.
- Initial **54** tests failed on absent APIs, then passed after implementation. Added six adversarial/positive/budget regressions: final **60** operation tests. Release-core total **379/379**, domain **127/127**.
- Initial package-local typecheck read stale domain dist exports. Building domain-contracts first resolved it without a source workaround; both package typechecks and release lint then passed.

## Independent review

L4; five views across three existing read-only reviewers. All three returned DONE: architecture, TypeScript/code quality, test strategy, security and performance PASS, no remaining P0/P1/P2. No design lens applies to this pure kernel increment. No reviewer modified source; no context retry or structural review blocker occurred.

- Architecture independently checked 240 kind/effect/key/approval declaration combinations, shared JSON subtrees, uppercase UUIDs and nested key-loss rejection; all matched the independent expected model. It reran 59 operation tests plus typecheck/lint and checked §7.1.1.
- Test review found two P2 regression gaps in the initial 54 cases: removing the DB safe-effect check survived; removing the DB config's own key-source condition survived. Both permanent cases were added and each in-memory deletion now fails its own assertion. Implementation was already correct, so these are regression coverage gaps, not production defects.
- The final output-artifact budget test was added after these two reviewers' 59-case runs; root reran all 60 cases and the full repository afterward. No production logic changed after their review.
- Security/performance independently checked 15 digest vectors, nine hostile-object classes with trap count zero and 288 effect/key/approval combinations. It reran final release-core 379/domain 127, both typechecks and diff check. An approximately 7.5 MiB input prepared in about 227 ms; combined Binding verification took about 383–424 ms on this Windows host. No exponential behavior or unbounded state was observed; these timings are not production capacity/SLA claims. It also checked the final input-fit/output-overflow regression.

## Gap Detection / Doc↔Code

| Invariant | Evidence | Remaining obligation |
|---|---|---|
| Real JSON content → complete operation pin | Independent fixed schema digests, exact output fields, all semantic axes and pin-field tampering | Runtime JSON Schema meta/instance validation is separate |
| Binding declaration matching | Five Binding kinds, internal/external subagent, disabled Binding, exact output presence, hash/name/kind/effect/key/approval tests | Release adapter must prove the operation belongs to the fixed target |
| Database / Pack boundaries | read-only and safe independent; intrinsic and extra config key requirements; pack rejects generic path | Actual DB resource contracts and sealed pack routes are later tasks |
| Hostile inputs / budgets | Lossless input, trap=0, UTF-8 and raw/encoded/output limits, retry after failure | No cross-machine performance SLA claimed |
| Complete application | Publisher unchanged; no new business call sites or external execution | Final closure, admission, real API/browser/runtime and deployment still required |

Contract §7.1.1 matches code and explicitly limits the evidence. It does not claim target registry provenance, provider/SQL/index implementation, GateSpec coverage or final closure acceptance. Flow/SubAgent have no local operation ID/hash slot; their checker verifies only common declarations until a typed release adapter proves target/source correspondence. Second pass: none.

## Final local validation

`TURBO_FORCE=true pnpm check` passed at **2026-09-02 12:38 +08:00** with zero cache reuse: format, lint, workspace boundaries, OpenAPI/contracts, typecheck, all tests and build. Existing nine non-fatal test-support lint warnings are unchanged; no new lint diagnostics remain. `pnpm architecture:gate:test` passed **31/31**, skipped/todo=0, after freezing release 379/domain 127 in both manifest and gate core. This is not the full six-suite PostgreSQL clean-checkout gate or host-attested acceptance.

No upload, remote CI run, database mutation, new receipt or deployment occurred. Prior upload denial, server full disk and paused Docker recovery remain unchanged; pure local T3.2 can continue.

## Compound

One solution + one canonical index entry and four architecture/testing rules were saved. `scripts/sync-solution-index.js` remains absent, so no renderer/runtime projection synchronization is claimed. Global skill-signal directory is empty and unchanged; no global instinct or signal statistics were fabricated.

Continue from [[2026-09-02-g1-a1-capability-closure-kernel-handoff-5]].
