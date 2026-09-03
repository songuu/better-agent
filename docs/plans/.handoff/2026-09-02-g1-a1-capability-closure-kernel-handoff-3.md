---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 3
created: "2026-09-02T11:56:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 3

## Product and current slice

The user requires a complete Agent application modeled on `ai.betteryeah.com`, independently deployed through `songuu.top`. `E:/project/ai/agent` is a deployment-mechanics reference only. Do not ask the user to choose again between an app and a documentation site. The active implementation goal is incomplete.

T1/T2 and **T3.1 pinned manifest graph** are implemented locally. T3 itself remains open: next implement **T3.2 kind-specific immutable source preimages, nested closure/body/compiled-hash verification, canonical Binding paths and effective policies**, then T4 gates/routes/child map, T5 typed admission, T6 integration. The real API/browser/runtime application and deployment remain required after this kernel.

## Source and evidence

- Branch `codex/g1-a1-closure-identity`. T1 `84892d96e7146e36910f8a7ea843f6570d397327`; T2 `bfaf4fb`. This checkpoint accompanies the T3.1 local commit; resolve its exact hash from `git log -3`.
- New `pinned-dependency-graph.ts` exposes `preparePinnedDependencyGraph` / `verifyPinnedDependencyGraph`; shared snapshot adds a separate graph profile without relaxing identity or policy profiles.
- New graph tests **81**; total release-core **238**, domain-contracts **122**, identity regressions **56** unchanged. Core/manifest test inventories match 238.
- Final validation/review results are in [[g1-a1-pinned-graph-review]]. Do not confuse the architecture control-plane's 31 tests with its full six-PostgreSQL-suite clean-checkout gate.
- No GitHub upload, database mutation, server deployment or new host attestation was performed in this continuation.

## Frozen T3.1 boundary

- Closed candidate/record envelopes; lowercase strict UUIDs and exact SHA-256 hashes; only pinned resources in the same Workspace.
- Exact manifest owner and recomputed normalized dependency hash; all referenced full pins present, no conflicting version records, duplicates or unrelated extra records.
- Agent/Flow require nested closure hash metadata; other kinds reject it. Presence and canonical syntax are **not proof of source authenticity**.
- Canonical full-pin node IDs, canonical edge sets, dependency-first traversal. Root version return is a cycle even if the edge uses a final compiled hash instead of the root semantic seed.
- 256 total nodes including root, 1024 unique edges, longest path 32 edges; 8 MiB raw string and encoded JCS limits, 131072 values, depth 12, 1024 array entries, 12 object keys, 4096 UTF-8 bytes per field. No truncation.
- Immutable complete output, revalidated budgets, loader full artifact comparison against recomputation. The graph is not a final `CompiledCapabilityClosureV1` or admission token. Agent publisher remains paused.

## T3.2 next-step constraints

Read the current closure architecture, Agent Release and Flow IR schemas and `publishable-resource.ts` first. Current G0 Agent publishing is intentionally paused; several leaf-resource source writers arrive in G1-A2/A3/A4. Define and test exact adapters/preimages rather than passing caller-provided `sealed`, semantic seed or nested hash assertions into final publication as authority. Nested executable bodies must be bound to full pins and verified closures; canonical Binding path expansion is separate from manifest-node deduplication. Coordinate the final closure contract with T4 without marking either complete early.

Continue pure local TDD. No `[P]` implementation tasks; L4 tasks are serial, independent review uses the existing three reviewers. Read-only in-memory mutation probes found two test gaps now covered: shared **non-leaf** height caching and node `dependency_manifest_hash` substituted with pin contract hash.

## External boundaries unchanged

1. Earlier `git push --set-upstream origin codex/g1-a1-closure-identity` was explicitly rejected by auto-review before execution. The exact GitHub repo/branch authorization question remains unanswered. **Do not retry upload, use another transport/API or merge to main without explicit authorization.** Local commits are not remote uploads.
2. Server root `/dev/vda3` was full. Do not expand partitions, delete neighboring projects or bypass deployment disk preflight without specific authorization.
3. Docker recovery is paused after an external GUI factory-reset entry appeared in its logs. Do not resume resets/reinitialization; preserved socket backups and VHDX presence do not prove database integrity.
4. Historical G0 receipt remains scoped to its original subject. Unavailable original authority does not revoke that historical result and does not prevent pure TDD, but new source needs fresh database/full-gate and applicable independent acceptance before release.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[2026-09-02-shared-dag-depth-regression]]
