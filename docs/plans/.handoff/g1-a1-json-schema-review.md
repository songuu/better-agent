---
title: "G1-A1 bounded JSON Schema and source validation review"
date: 2026-09-02
tags: [review, contracts, testing]
---

# Dispatch

- Risk: L4. Implementation stayed serial. Readonly reviewers: `g008_perf_review` (security/performance), `g008_quality_review` (architecture/TypeScript/doc consistency), `g008_test_review` (test sensitivity). Five views across three agents; no design lens because this increment has no UI changes.
- Final reviewer status: all three DONE, remaining P0/P1/P2 = 0. One earlier performance/security agent error was not treated as a pass; resumed local defensive review completed independently.
- Revise: wrong-target dynamicRef P1 fixed and independently rechecked; masked defaults/lifecycle/node-budget tests and Strategy verifier matrix P2 findings fixed and rechecked. No authority or external deployment operations performed.

## Gap Detection Walkthrough

| workflow / invariant | existing coverage | uncovered gap | action |
|---|---|---|---|
| Untrusted Schema to real instance validation | real engine, typed/unknown/unused refs, formats, recursion, no mutation, exact bytes | dynamicRef initially picked root instead of target | fixed single-resource lowering, permanent positive/negative tests |
| Worker compile/execute lifecycle | timeout, OOM, protocol, output, constructor failure, four slots | immediate fake exit masked early release/repeated stop | delayed exit/termination rejection and mutation-sensitive tests |
| Strategy configuration reaches real contract | five schemas + actual config through real source adapter | original source binding did not validate JSON Schema | new explicit validated wrapper, original synchronous APIs unchanged |
| Declared evidence to independently verified evidence | exact producer artifact, full verifier comparisons | Strategy verifier matrix originally missed some fields | complete top-level/profile/schema/instance/extra-field matrix |
| Source size to larger prepared result | Schema and wrapper output-budget regressions, large legal round trips | none for this boundary | preserve both accepted and rejected cases |
| Distribution/CI inventory | emitted checked MJS worker + public exports; dist smoke; actual 694/152 markers; 31 architecture tests | registry/current PG/host/public app not covered | explicitly pending, no completion claim |

## Doc↔Code Consistency Walkthrough

| doc claim | code reality | status | confidence | action |
|---|---|---|---|---|
| architecture §7.1.6 fixes profile, budgets and local refs | `json-schema-profile.mjs`; worker `checkProfile`/`lowerReferences`; parent snapshot/check | PASS | high | version profile if semantics change |
| Original Schema hash is unchanged by lowering | worker gets serialized copy; parent `prepareJsonSchemaContract` hashes original snapshot | PASS | high | retain real target/original-document tests |
| Instance and config validation do not coerce/fill/delete | fixed options; required+default/wrong-type/extra-property actual refusal | PASS | high | guard mutation-sensitive negatives |
| Only actual exit releases worker slot | `json-schema-validation.ts` decrement in exit handler; delayed-exit/rejection tests | PASS | high | no sandbox/global-memory claim |
| Wrapper verifies whole source/profile/schema/config evidence | `schema-validated-source.ts` finish and both reconstructing verifiers | PASS | high | validation hash is not attestation |
| All-kind compiler/registry/app remain open | existing sync source helpers unchanged; wrappers only operation/Strategy | PASS | high | no claim of source-wide or runtime enforcement |
| Plan and architecture inventory report 694/152 | package test logs plus core/manifest exact count diff | PASS | high | no marker weakening |

Second pass: none. Detailed specification: `docs/architecture/compiled-capability-closure-v1.md` §7.1.6.

## Validation

- New tests: **89** = 51 real Schema + 19 controlled lifecycle + 19 real operation/Strategy source tests. Final full release-core inventory **694**; domain-contracts **152**, unchanged. No new tests deleted or disabled.
- Package typecheck/build/lint PASS. Static MJS is included in checked JS and emitted dist; real dist Schema prepare/verify/instance plus operation wrapper prepare/verify smoke PASS.
- First fresh zero-cache `TURBO_FORCE=true pnpm check` PASS (~14:30–14:31 +08). OpenAPI bundle/types/response baselines unchanged after the dependency peer-layout refresh. Existing unrelated test-support lint warnings remain non-fatal.
- Architecture mutation/inventory suite **31/31**, skipped/todo=0, PASS. Gate inventory changed only the observed release count 605→694; no gate/marker semantic relaxation.
- Final full check after the expanded verifier matrix: **PASS**, `TURBO_FORCE=true pnpm check` at ~14:34–14:35 +08; all lint/typecheck/test/build task groups report zero cached tasks. Release-core **694/694**, domain **152/152**; no skips/todos in the full inventory. The final change after this run only records this evidence and the handoff.
- Independent final source test review: targeted verifier tests passed; earlier defaults/node-limit/slot/stop mutations were caught. Full-package evidence, not the filtered review run, defines the no-skip inventory.

No current-source PostgreSQL integration, clean-checkout executable gate, new GitHub CI, host-attested Acceptance or public browser/app deployment was run. Historical G0 receipt subject is unchanged.

## Decision / limits

APPROVE the bounded local Schema/operation/Strategy validation increment. T3.2 and the complete application remain incomplete. Worker is not an OS sandbox; per-worker V8 limits are not total-process memory limits, and four-worker admission is module-local. Strategy preparation can create six sequential workers (five schema checks plus config validation), each with its own deadline; no pool/cache or overall source deadline is claimed. Future all-kind compiler/runtime wiring must explicitly consume validation, not treat source hashes as successful schema validation.

## Related

- [[g1-a1-json-schema-debug-journal]]
- [[2026-09-02-schema-reference-and-worker-boundaries]]
- [[2026-09-02-g1-a1-capability-closure-kernel]]
