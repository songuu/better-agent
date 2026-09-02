---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 6
created: "2026-09-02T13:07:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 6

## Goal / current position

Full deliverable unchanged: complete Agent application modeled on `ai.betteryeah.com`, independently deployed/reachable through `songuu.top`. `E:/project/ai/agent` is deployment mechanics reference only. No docs-site/database-health/CI substitute and no repeat request to choose product scope. Active goal remains incomplete.

T1, T2, T3.1, Agent/Flow source preimages and operation declaration sources are local commits. This increment adds four real **typed leaf contract bodies** (Knowledge/Database/Plugin/A2A) with content hashes, operation/intrinsic demands and Binding checks. It is not final closure compilation or verification of underlying artifact/registry provenance. T3.2 remains open; Instruction Skill/Strategy/Skill Pack sources, JSON Schema validation, nested closure/compiled hashes, canonical Binding expansion and effective path policies still require implementation. Then T4 routes/GateSpec/child outcomes, T5 admission, T6 publisher integration, and the actual application.

## Code / evidence

- Branch `codex/g1-a1-closure-identity`; base for this increment `c8c8959`. Earlier commits: `805b64c`, `75062c2`, `bfaf4fb`, `84892d96`. Resolve this increment's local commit with `git log -2`; no upload occurred.
- Domain `leaf-resource-source-v1.ts` defines closed typed leaf candidates/documents, network transport, additional DB filters and allowed columns. Registry/index updated. It provides structural parsing; semantic relationship validation is in release-core.
- Release `leaf-resource-source.ts`: prepare/verify complete artifact and verify target Binding. Common requirements derive operation hash/effect/approval; remaining demand fields are preserved. Policy module exports a pure `normalizeCapabilityRequirements`; resolver behavior is unchanged. Full source preimage field profile is frozen in architecture §7.1.2.
- DB tenant column must be non-null UUID, principal fields UUID, table revisions/parameter names match, read/output classification covers every read including membership/order. User SELECT/predicate/order/additional-filter columns require Binding allowlist. Fixed tenant/principal filters remain mandatory but outside user-column allowlist. No raw SQL/renderer/execution added.
- Plugin/A2A exact transport/auth demands, complete selected manifest operation and corresponding pin checked. Network directions/identity digests are contract facts, not validated remote binaries or deployment network approval. None-auth explicitly uses no credentials and principal `[none]`.
- **Return-value caveat:** Binding verifier returns the source intrinsic artifact, not effective policy. The final compiler must merge all Binding-added scopes/approval/key/taint and narrowed modes/limits; never treat verification as an authorization grant.
- Final tests: **74 new release** (71 leaf + 3 requirements) + **8 domain**. Totals **453/453** and **135/135**. Final `TURBO_FORCE=true pnpm check` PASS, started **13:06 +08:00**, zero cached; architecture **31/31**, skip/todo=0. Existing nine non-fatal test-support lint warnings remain. Full PostgreSQL/CI/host/production validation not performed.
- All three independent reviewers DONE across five views; P0/P1/P2 remaining=0. See [[g1-a1-leaf-source-review]] / [[g1-a1-leaf-source-debug-journal]]. Independent mutation checks separately kill read/output guards, credential provider mismatch and derived effect/approval downgrades. Independent 384 DB classification model and hostile/digest/scale probes passed.

## Outstanding authority — do not bypass

1. Prior push to `github.com/songuu/better-agent` branch `codex/g1-a1-closure-identity` was rejected by auto-review; exact upload-only approval request remains unanswered. No retry Git/API/browser/alternate transport, main merge or deployment without required authorization.
2. Server root `/dev/vda3` full; no partition expansion, neighbor deletion or preflight bypass authorized.
3. Docker recovery paused after an external GUI reset log; no reset/reinitialization. Original authority readback unavailable. Never reconstruct authority rows from local receipt copies.
4. Historical G0 host receipt `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668` remains scoped to its recorded subject. Outage does not revoke it or attest newer code. Pure local deterministic TDD may continue.

No external state changed. Previously `/better-agent/` returned 404; this local increment does not supply front-end/HTTP/runtime application or change that deployment evidence.

## Next useful local work

Continue T3.2 with remaining typed source adapters and/or schema validation, then integrate verified nested sources, closure bodies, Binding paths and effective policies. Reuse existing bounded snapshot/JCS/domain source helpers; do not replace them with arbitrary hash-only claims or bypass T4/T5/T6. Build domain dist before package-local release typecheck; full workspace check handles order.

Implementation remains serial (L4); `review` skill authorizes independent read-only reviewers. Reuse `g008_quality_review`, `g008_perf_review`, `g008_test_review` if still available. Do not reset the worktree or retry denied external operations. Local commits need exact local-only escalation.

## Compound

Saved [[2026-09-02-leaf-contract-narrowing-and-roundtrip]], canonical index and four architecture/testing rules. Renderer absent; no global skill signals/instincts written or invented. This checkpoint preserves scope/authority for continuation, not a completion or blocked-goal claim.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[g1-a1-leaf-source-review]]
- [[2026-09-02-g1-a1-capability-closure-kernel-handoff-5]]
