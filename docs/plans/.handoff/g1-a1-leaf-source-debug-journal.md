# Typed leaf source debugging journal

Date: 2026-09-02. Feedback loop: focused Vitest source tests, independent read-only probes and then full packages/repository. No external state involved.

| Case | Minimal failing signal | Root cause / fix | Permanent result |
|---|---|---|---|
| Additional DB filter reads higher-classified column | Valid source only reads title; Binding adds score/restricted predicate | Column/parameter existence was insufficient. Check read and output taint; filters affect membership | Allowed score column with independently insufficient read or output rejects; deleting each guard fails its own assertion |
| User predicate/order bypasses column allowlist | Binding allows title; query reads score in predicate or order | Only SELECT columns were checked. Cover all user query/additional-filter columns | Reject omitted score, pass when explicitly allowed |
| Legal artifact cannot verify | prepare accepts roughly 6.3 MiB artifact; verify rejects | Shared 8 MiB budget counted artifact plus source. Bound expected/source separately, retain output limit | Large prepare→verify passes; input fits/output exceeds still rejects |
| Empty parameter-free SELECT rejected | predicates=[] with `{type:'object',additionalProperties:false}` | Helper required properties even without parameters. Return true for empty predicates | Positive prepare+Binding test passes; undeclared nonempty parameter still rejects |
| Guard regression masked | Removing classification checks left previous 71 tests green | Score absent from allowlist caused earlier rejection | Allow score, satisfy other axes, vary read/output independently; both single deletions killed |

Initial absent-API suite: 53 RED → 53 GREEN. Expanded final source/normalization suite: 74 GREEN. One hostile-key test initially expected LIMIT, but existing snapshot classifies an oversized key as INVALID; corrected the test without changing the shared boundary. A test fixture array-index optionality was fixed explicitly; typecheck passes. These were not runtime production failures.

Independent credential/effect mutations prompted stronger paired tests. Final whole release package 453, domain 135 and zero-cache repository checks pass. No skipped test was accepted as final evidence; focused `-t` red probes were diagnostic only.

Related: [[g1-a1-leaf-source-review]], [[2026-09-02-leaf-contract-narrowing-and-roundtrip]].
