# G1-A1 T2 local implementation evidence

Date: 2026-09-02. Base: local T1 commit `84892d96e7146e36910f8a7ea843f6570d397327`.

## TDD and corrections

1. New 56 release policy tests failed on absent functions; previous 89 passed. New 69 domain tests failed on absent schemas; previous 53 passed.
2. Implemented closed network/budget/ceiling/requirements contracts and pure meet/resolve; extracted the T1 bounded snapshot without changing its identity limits. Both packages passed. Typecheck exposed local never-function control-flow inference and mixed tuple `it.each` inference; explicit function declarations and `[string, object]` rows fixed those errors.
3. Added structure/byte/rule budgets, generated policy laws and actual CompiledBinding schema composition. Fresh zero-cache workspace check passed at 151/122; this earlier count is not the final candidate evidence.
4. Added joint token minimum feasibility: two regressions first failed because illegal demands were accepted, then passed with bigint comparison.
5. Independent review found output budget non-closure. A permanent large-scope/4-host/8-path regression first failed; `sealCeiling` and resolved output revalidation fixed it. Exact host/path/scheme conflict tests were also added and independent in-memory mutations verified sensitivity.

## Final review

L4, five viewpoints using three existing read-only reviewers: architecture + TypeScript/quality, security + performance, test strategy. No design lens: no UI changes. All final STATUS=DONE, P0/P1/P2=0. No reviewer edited source files.

- Security independent model: 100 policy pairs and 100,800 request points, zero incorrect membership; malicious object traps never invoked.
- Architecture independent model: 150 policy pairs, 36,000 request assertions, commutativity/associativity checks pass.
- Test reviewer: former scheme/exact-path mutants survived the earlier suite; added tests now fail for those mutants.
- Output limit: legal two-input cross-product exceeding 1 MiB now fails immediately; smaller 32-rule output is accepted by normalize and idempotent meet.
- Local Windows observation: maximum long-rule normalization rejection ~237 ms / ~33 MiB heap increment; not a portable SLA.

Final package evidence: release-core **157/157**, domain-contracts **122/122**, both typecheck/lint and diff whitespace checks pass. Existing identity tests remain **56/56**. Final `TURBO_FORCE=true pnpm check` completed at 2026-09-02 11:36–11:37 +08:00 with zero cache reuse; all format/lint/workspace/contracts/typecheck/tests/build stages passed. Existing nine non-fatal test-support warnings remain unchanged. The final architecture control-plane rerun passed **31/31**, skipped/todo=0. This command is not the full six-PostgreSQL-suite clean-checkout gate.

## Scope and provenance

This proves the T2 pure kernel slice, not current-source PostgreSQL integration, host attestation, CI, deployment or a finished app. T3–T6 remain pending. The historical G0 record is untouched and not reused as a signature of this source. The GitHub upload rejection, unavailable local Docker/authority environment and server filesystem authorization constraints remain unchanged.

## Compound

One solution and its summary index entry saved; architecture/debugging/testing rules updated. `scripts/sync-solution-index.js` is absent, so the canonical index was narrowly updated with apply_patch; no nonexistent renderer/projection sync is claimed. Runtime skill-signal directory is unavailable; no global skill statistics or new global instincts were fabricated.
