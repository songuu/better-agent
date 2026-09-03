---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 2
created: "2026-09-02T11:38:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 2

## Product and progress

The user requires a complete Agent application modeled on `ai.betteryeah.com`, independently deployed through `songuu.top`. `E:/project/ai/agent` is only a deployment reference. Do not ask again whether the product is a documentation site. The goal remains active and incomplete.

T1 and T2 are complete locally; next implement **T3 — pinned graph compiler/loader**, followed by T4 gate/routes/child map, T5 typed ResolvedPlan admission, T6 publisher/database integration and full gates. Full G1 and the eventual UI/API/runtime application still remain.

## Source and evidence

- Branch `codex/g1-a1-closure-identity`; T1 base commit `84892d96e7146e36910f8a7ea843f6570d397327`.
- This checkpoint accompanies the T2 local commit; read current `git log -2` to resolve its exact hash. No remote upload or deployment took place in this continuation.
- T2 adds 68 release tests and 69 domain tests. Final counts release-core **157**, domain-contracts **122**, existing identity **56**. Both packages' tests/typecheck/lint pass.
- Final `TURBO_FORCE=true pnpm check` passed 2026-09-02 11:36–11:37 +08:00, zero cache reuse. Existing nine test-support non-fatal warnings unchanged. `pnpm architecture:gate:test` **31/31**, skip/todo=0. This does not run six real PostgreSQL suites.
- Independent five-view review completed with all STATUS=DONE and no remaining P0/P1/P2. Details: [[g1-a1-policy-review]]. Reviewers available for reuse: `g008_quality_review` (architecture/TypeScript quality), `g008_perf_review` (security/performance), `g008_test_review` (test strategy); all idle.

## T2 APIs and contracts

- `normalizeCapabilityPolicyCeiling(unknown)`, `meetCapabilityPolicyCeilings(unknown, unknown)`, `resolveEffectiveCapabilityPolicy(unknown, unknown)` exported by release-core.
- Closed domain versions registered: `canonical-egress-rule/1`, `capability-budget/1`, `capability-policy-ceiling/1`, `capability-requirements/1`. EffectiveCapabilityPolicy now embeds concrete egress/budget schemas; old `{}` placeholders fail.
- Separate allow-sets from demands: provider/audience exact pair keys, scopes intersect only between allowances, all required scopes/operations/egress must remain available. Principal modes intersect across the path's credential demands; `none` cannot substitute for credentials.
- Egress is deployment-approved network policy ID/hash/address class plus canonical scheme/host/port/path/method, fixed per-connection DNS revalidation and closed redirect mode/hop/auth stripping. Public HTTPS and approved internal HTTP/HTTPS are distinct; arbitrary IP/CIDR/DNS server/proxy config forbidden. Pure compilation is NOT approval or SSRF runtime proof.
- Clearance min, taint max, effect maximum min, approval OR, exact operations, all numeric caps min, credits compared as bigint. Simultaneous input/output minima must fit total cap using bigint addition.
- Input and complete canonical output share strict budgets (1 MiB string values, 4096 UTF-8 bytes/field, 32768 nodes, depth12). Rule input/output max32, method atoms max224/input and1024 intermediate. Oversized cross-product output rejects now, not on its next use. Results detached and deeply frozen.
- Shared `bounded-data-snapshot.ts` is internal; identity profile preserves former limits/semantics. Proxy rejection before reflection, no getters, cycles, sparse/forged arrays. Policy profile additionally permits finite numbers/booleans. TypeScript control-flow guards use function declarations returning never.
- Exact profile frozen in closure contract §4.2.1. Source files are domain `capability-policy-v1.ts`, release `capability-policy.ts` and `bounded-data-snapshot.ts`; tests in the corresponding `capability-policy.test.ts` and release `policy-fixtures.ts`.
- Core/manifest test inventory synchronized to 157/122, not weakened.

## Review findings fixed

1. Legitimate inputs can yield >1 MiB output from host×path expansion: full result budget revalidation added, with red→green boundary/reusability regression.
2. Independent token minima may jointly exceed total cap: precise joint feasibility added, equality/+1/unsafe-sum regressions.
3. Earlier tests did not kill removed scheme/exact-path comparisons: direct bilateral meet/resolve negatives now kill those in-memory mutants.

Independent membership probes: security 100 pairs/100800 points; architecture 150 pairs/36000 assertions. No expansion found. Local extreme ~237ms/33MiB is observational, not an SLA.

## Unchanged authority/operational boundaries

- A previous `git push --set-upstream origin codex/g1-a1-closure-identity` was explicitly rejected by auto-review before execution. User was asked for specific approval to upload this branch to `github.com/songuu/better-agent`; no reply yet. Do NOT retry or use API/another transport until explicit approval. This also covers the new T2 continuation. Local commits are not uploads.
- Server `/dev/vda3` remains full with ~10 GiB unallocated disk space. No permission to expand the root partition or delete neighboring projects; no deployment-preflight bypass.
- Docker recovery remains paused after an external GUI factory-reset event appeared in its log. Do not resume reset/reinitialization or assume VHDX existence proves data intact; user coordination pending.
- Historical G0 host-attested record is intact and scoped to its historical subject. Original local authority database availability is unresolved; substituting a remote DB at the same loopback port does not establish original record invalidity. Do not regenerate authority evidence or use the old receipt to attest new source.
- These operational limits do not block pure T3–T5 TDD. Do not mark the goal blocked while meaningful safe implementation remains.

## Compound

[[2026-09-02-policy-meet-output-budget]] saved with canonical summary index; architecture/debugging/testing rules updated. Solution index renderer absent: narrow apply_patch fallback only. Runtime skill-signal storage unavailable; no fabricated global signals. No new global instinct writes.

## Next action

Read the existing T3 plan and closure contract, then write failing graph compiler tests against T1/T2 APIs. Do not redo T1/T2 or restart infrastructure investigations without new input. Keep T3 implementation serial (L4, shared contracts); use independent review when ready. Preserve all current user/working-tree changes and do not push remotely without the outstanding explicit permission.
