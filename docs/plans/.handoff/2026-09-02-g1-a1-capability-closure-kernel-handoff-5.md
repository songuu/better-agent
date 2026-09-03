---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 5
created: "2026-09-02T12:40:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 5

## Goal / current position

The full deliverable remains the Agent application modeled on `ai.betteryeah.com`, independently deployed through `songuu.top`. `E:/project/ai/agent` is a deployment-mechanics reference only. Do not offer a documentation site/database-health/CI substitute or ask the user to select product scope again. Active goal remains incomplete.

T1, T2, T3.1 and the Agent/Flow source-preimage slice of T3.2 are local commits. This increment adds **operation declaration sources + concrete Binding compatibility**, not the final closure compiler. T3.2 still needs real kind-specific leaf/release adapters, JSON Schema validation, verified nested closure bodies/compiled hashes, canonical Binding expansion and path policy compilation. Then T4 GateSpec/routes/child outcomes, T5 admission, T6 integration, and the actual browser/API/runtime application remain.

## Code / tests

- Branch `codex/g1-a1-closure-identity`; preceding commits: T1 `84892d96`, T2 `bfaf4fb`, T3.1 `75062c2`, Agent/Flow source `805b64c`. This checkpoint accompanies the next operation-source local commit; resolve exact SHA via `git log -2`. Nothing was pushed.
- New domain `operation-contract-source-v1.ts` derives the closed source fields from existing operation pin schema while replacing caller hashes with actual JSON bodies. Registry/index exports are updated.
- New release `operation-contract-source.ts`: prepare/verify complete artifact, verify full pin, verify concrete Binding declarations. Preimage fixes `operation-contract-preimage/1` + `rfc8785/1`; hashes actual schema objects and all operation declaration fields. See architecture §7.1.1 for exact profile.
- `verifyBindingOperationContract` checks known kind, target pin syntax, exact input/output presence and digest, effect class, mandatory key/approval; knowledge/database/plugin config hashes and plugin provider name. Disabled Bindings are not exempt. Extra approval/key may narrow. G1 DB requires read-only AND safe, and honors its own stricter config key requirement. Skill Pack explicitly requires its separate member route.
- **Do not misuse success:** no JSON Schema meta/instance validation, target implementation/registry provenance, GateSpec coverage or final closure proof is provided. Flow/SubAgent operation ID/hash correspondence must come from a real fixed-target release adapter; checker only validates common declarations. Publisher is unchanged and Agent remains paused.
- Tests: 54 initially red on missing APIs → green; final 60 operation tests, release **379/379**, domain **127/127**. Two DB regression gaps were protected with mutation-sensitive tests. Final output-budget case distinguishes input fit from prepared-output overflow.
- Final fresh zero-cache `pnpm check` **PASS at 12:38 +08:00**, architecture unit/mutation **31/31**, skip/todo=0. Manifest/core freeze 379/127. Nine preexisting non-fatal test-support lint warnings remain. Package-local typecheck needs built domain dist; full workspace pipeline handles dependency order.
- Review evidence: [[g1-a1-operation-source-review]]. All three independent reviewers DONE across five views, remaining P0/P1/P2=0. Independent checks include 240 architecture and 288 security declaration combinations, 15 digest vectors and nine hostile-object classes; security reran final 379/127. Do not claim full PostgreSQL/CI/host/production validation.

## Outstanding authority — do not bypass

1. The prior push of this exact branch to `github.com/songuu/better-agent` was rejected by auto-review; the exact upload-only approval request remains unanswered. No retry Git/API/browser/alternate transport, main merge or deploy without required authorization.
2. Server root `/dev/vda3` full; no partition expansion, deleting neighbors or preflight bypass authorized.
3. Docker recovery paused after external GUI reset log; no reset/reinitialization. Original authority PG readback is unavailable. Never reconstruct authority from local receipt copies.
4. Historical G0 host receipt `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668` remains scoped to its recorded subject. Outage does not revoke that result; it also does not attest current changes. Pure deterministic implementation can continue.

This turn changed no external state. Independent PostgreSQL is not proof of a served app; previous `/better-agent/` was 404 and no complete front-end/HTTP application has been delivered.

## Continue

Implement real immutable leaf/resource source adapters that connect these operation bodies and intrinsic policies to the target full pins and derived dependency graph. Freeze required per-kind source fields against the existing Agent/Flow/closure contracts; do not substitute caller-supplied arbitrary JSON/hash for typed implementation evidence. Then wire nested source/body/compiled hash validation and full closure assembly. Keep T3.2 open until all obligations are met; preserve the full application goal.

## Compound

Saved [[2026-09-02-operation-declaration-cross-checks]], canonical index and four architecture/testing rules. Renderer absent; global signals empty/unchanged; no invented counts or global instincts.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[g1-a1-operation-source-review]]
- [[2026-09-02-g1-a1-capability-closure-kernel-handoff-4]]
