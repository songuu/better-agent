---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 7
created: "2026-09-02T13:34:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 7

## Goal / position

Full deliverable unchanged: complete Agent application modeled on `ai.betteryeah.com`, independently reachable through `songuu.top`. `E:/project/ai/agent` is deployment mechanics reference only. Do not ask for product scope again or substitute docs, healthy PostgreSQL or green CI. Active goal remains incomplete.

T1/T2/T3.1 and Agent/Flow/operation/leaf source increments are committed locally. This increment implements **Strategy and Skill Pack typed sources**, not final closure compilation, real publisher admission or an application. Instruction Skill is now the remaining typed source adapter; JSON Schema validation, verified nested closure/compiled hashes, canonical Binding expansion and effective path policies remain in T3.2, followed by T4 routes/GateSpec/child outcomes, T5 admission, T6 real integration and the actual UI/API/runtime application.

## Files / APIs

- Base `a4eac52` on `codex/g1-a1-closure-identity`; resolve this increment's local commit with `git log -2`. No upload.
- Domain `agent-strategy-source-v1.ts`: closed source/candidate, exact full model descriptors/caps, deny-all bounded sandbox declaration. `skill-pack-source-v1.ts`: complete typed member Bindings, operation source exposures and envelope schemas. Index/registry updated; eight new structural tests.
- `source-contract-data.ts`: internal shared bounded snapshot, full-JCS lossless parse/equality and canonical set helpers for these two new adapters. Does not alter existing source adapters.
- `prepareAgentStrategySource`, `verifyAgentStrategySource`, `verifyAgentStrategyAssembly`: complete document/preimage/full pin/strategy pin/eight component hashes/empty dependencies; source allowsets/models normalized; real Agent source exact strategy and model narrowing. No binary/sandbox enforcement/schema/catalog provenance assertion.
- `prepareSkillPackSource`, `verifySkillPackSource`, `verifySkillPackBinding`: complete source/full pin/envelope components/all-member dependency manifest/exact exposure tuples/member projection. Disabled/unexposed targets stay dependencies. Self-version and conflicting hash reject. Nested aliases require ID/hash equality and known operation effect/key/approval floor; outer selected pack additionally retains member restrictions/classification. No recursive route seal or effective policy returned.
- New `prepareCapabilityBindingSource` in executable-source reuses its canonical typed Binding normalizer and requires key source for requires_key. Existing Agent/Flow preparation path otherwise unchanged.
- Full profiles are frozen in `compiled-capability-closure-v1.md` §7.1.3/7.1.4. G0 publisher/hash profiles and historical host evidence untouched.

## Verification / review

- New release tests: Strategy **49**, Skill Pack **40**; release total **542/542**, domain **143/143** (+8). Architecture inventory updated in core and manifest only for these observed counts.
- Final `TURBO_FORCE=true pnpm check` passed with zero cached tasks (~13:34 +08); architecture **31/31**, skipped/todo=0. Existing non-fatal test-support lint warnings remain. Final post-document verification is retained in turn output.
- Five views across three read-only reviewers: all source reviews DONE. Security/architecture P1s (missing key source; known nested operation floor) were reproduced as RED then fixed. Four Strategy and three Pack test-sensitivity mutations now fail the permanent regressions. Independent 480 direct + 120 nested restriction models, hostile inputs, hashes and near-limit roundtrips passed.
- See [[g1-a1-composite-source-review]] / [[g1-a1-composite-source-debug-journal]]. Final doc/marker review readback DONE, second pass none, remaining P0/P1/P2=0. No current-source PostgreSQL suites, clean-checkout executable gate, new CI, host-attested Acceptance or production result.

## Authority — unchanged, do not bypass

1. Prior push to `github.com/songuu/better-agent` / `codex/g1-a1-closure-identity` was rejected by auto-review; exact upload-only approval request remains unanswered. Do not retry Git/API/browser/alternate transport upload, merge main or deploy without required authorization.
2. Server root `/dev/vda3` full. No partition expansion, neighboring project deletion or disk preflight bypass authorized.
3. Docker recovery paused after external GUI reset log. No reset/reinitialization; original authority readback unavailable. Never reconstruct authority rows from local receipt copies.
4. Historical G0 receipt `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668` remains scoped to its recorded subject; it does not attest new code. Pure local deterministic implementation may continue.

No external state changed. Earlier `/better-agent/` 404 evidence is not superseded by these local tests.

## Next local work

Implement Instruction Skill signed inert content source under T3.2, then remaining schema/closure/path integration. Read the exact architecture §4.6 requirements first: immutable same-Workspace content release fixes file manifest/hash/entry/parser/provenance/signature/context budget/classification; references only existing Agent Capability Binding IDs. `scripts/**` may be validated as inert bytes but never executed, loaded or converted into Tools; required execution fails `SKILL_SCRIPT_EXECUTION_UNSUPPORTED`.

No Instruction Skill code or tests were started in this increment. A possible bounded design is canonical JSON file bundle (not archive extraction) plus exact manifest/path/size/hash validation and independent trusted signer input for signature verification; this is a design direction, **not a frozen or implemented protocol**. Do not let candidate-provided keys establish trust, and do not confuse content signature with host reviewer attestation or registry admission. Consult primary crypto documentation before implementing crypto APIs. Final compiler must still resolve existing allowed Binding IDs into canonical paths; no empty descriptor fallback.

Continue serial L4 TDD. Review skill authorizes independent read-only reviewers; reuse `g008_quality_review`, `g008_perf_review`, `g008_test_review`. Build domain dist before release package-local typecheck. Use observed exact counts for inventory; never weaken markers/skip tests. Local-only commits require exact escalation. Preserve unrelated work.

## Compound

Saved [[2026-09-02-composite-source-restriction-floors]], canonical index and three architecture/testing rules. `scripts/sync-solution-index.js` absent, so only explicit canonical index entry maintained; no runtime projection invented. Global skill-signals directory had no entries; no global instincts/signals or invented health stats. This checkpoint is continuity evidence, not completion or blocked-goal status.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[g1-a1-composite-source-review]]
- [[2026-09-02-g1-a1-capability-closure-kernel-handoff-6]]
