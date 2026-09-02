---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 9
created: "2026-09-02T14:36:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 9

## Goal / position

Full goal unchanged: complete Agent application modeled on ai.betteryeah.com and independently reachable through songuu.top. E:/project/ai/agent is deployment mechanics reference only. Do not ask scope again or substitute docs, PostgreSQL health, green CI or pure kernel tests for the application. Active goal remains incomplete; pure local work is making progress.

Baseline is local commit `644e1bc`, branch `codex/g1-a1-closure-identity`; this increment adds bounded JSON Schema validation and explicit operation/Strategy source validation. Resolve the resulting local commit with git log. T3.2 final closure/path/policy/nested bodies, T4 gates/routes/outcomes, T5 admission, T6 PG/registry and the actual UI/API/runtime remain open. This is not a new host-attested receipt.

## Code / APIs

- `json-schema-profile.mjs`: fixed profile/1, dialect2020-12, Ajv8.20.0 + formats3.0.1 full fixed list; no coerce/default/removal; strict schema/numbers; same-document refs only, no nested $id, unique anchors, canonical URI/Pointer; reject __proto__ schema-map keys that engine skips. No user custom keyword/loader/$async/$data/external reference fetch.
- `json-schema-validation-worker.mjs`: original profile/meta-schema checked first; known schema positions only; anchors lower to pointers and dynamic refs lower to static refs. Single-resource restriction makes this correct; simultaneous refs append allOf preserving existing indexes/siblings. Only worker JSON copy transforms; parent original document/hash untouched.
- `prepareJsonSchemaContract`, `verifyJsonSchemaContract`, `validateJsonSchemaInstance`: source-bounded operands before first await; real compile/instance validation. Prepared document/hash/profile/profile_hash/contract_hash, whole verify; instance returns detached frozen null-prototype JSON data. Errors use six JSON_SCHEMA_* codes, not raw diagnostics.
- Parent creates static worker module with env={}, argv=[], execArgv=[], captured stdout/stderr, V8 old/young128/16MiB + stack4MiB; 5s deadline, four alive workers per module, no queue. Multiple stop triggers terminate once. Slot released only actual exit, including termination promise rejection. Only single ok + exit0 resolves; protocol/output/error/nonzero failures reject. Worker is NOT OS sandbox/global memory isolation; Node environmentData remains ambient. Profile records these limits and normalization semantics.
- `schema-validated-source.ts`: operation prepare/verify checks real input/optional output; Strategy prepare/verify checks five schema fields and real config instance. Original sync source helpers unchanged. Source artifact hash + profile hash + ordered schema field/hash/contract_hash + config field/schema_field/instance_hash form evidence; validation_hash hashes whole evidence. Whole wrapper bounded/frozen and verify redoes checks. Not registry provenance, implementation/sandbox proof, final closure or attestation. Sequential six-worker Strategy preparation has per-worker deadlines, no overall source deadline/cache/pool.
- Static MJS worker/profile checked with allowJs/checkJs and emitted via tsconfig build includes. Architecture profile §7.1.6 records exact boundary. Package/lock pin versions, no dependency downgrade; Redocly formats peer resolution changed but contract gate baselines remain unchanged.

## Evidence

- **89 new tests**: 51 real Schema, 19 worker lifecycle, 19 real source wrappers. Release-core **694/694**, domain **152/152**; gate core/manifest synchronized only observed count, no semantic weakening. Architecture **31/31**, no skips/todos.
- Typecheck/build/changed lint and real dist Schema/operation prepare/verify/instance smoke PASS. Independent five views across three readonly reviewers finally DONE; P0/P1/P2=0. Earlier security/performance agent error was not a pass; resumed defensive review completed.
- Final fresh `TURBO_FORCE=true pnpm check` **PASS** at ~14:34–14:35 +08, zero cached tasks, after the expanded verifier matrix. Evidence is recorded in [[g1-a1-json-schema-review]]; the final later changes only record evidence/handoff prose.
- DynamicRef target bug had RED cases then GREEN original/root/three nested target/double-ref regressions. Test mutations caught hidden defaults, early slot release, repeated terminate and removed4096-node guard. Complete Strategy verifier matrix added after review. See [[g1-a1-json-schema-debug-journal]].
- No current-source PG, clean-checkout gate, GitHub CI, host-attested Acceptance, production/browser validation. Existing unrelated test-support lint warnings retained.

## Authority / environment (unchanged)

1. Prior push to github.com/songuu/better-agent / codex/g1-a1-closure-identity denied by auto-review; exact upload-only request remains unanswered. Do not retry via Git/API/browser/alternate transport, merge or deploy without required authority.
2. Server root /dev/vda3 full; no expansion, neighboring data removal or disk preflight bypass authorized.
3. Docker recovery paused after external GUI reset log; no reset/reinitialization; original authority readback unavailable. Never reconstruct authority rows from local receipt copies.
4. Historical receipt `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668` belongs only to its recorded old subject.
5. Exact local dependency metadata/download/install escalations approved for Ajv8.20.0/formats3.0.1, not upload. Use existing pnpm store `C:/Users/Administrator/AppData/Local/Temp/better-agent-pnpm-store-20260901` with --ignore-scripts; default store mismatch would demand replacing node_modules. No tree reset performed.
6. `pnpm exec biome` once resolved a global2.3.14; pinned `node node_modules/@biomejs/biome/bin/biome` and normal package scripts correctly use2.5.10. Do not migrate repo config to an accidental global binary. Local-only commit needs exact escalation.

## Next local work

Continue T3.2 serial TDD. Wire validation explicitly to remaining typed source positions (leaf operations, Plugin/A2A collections, Pack envelopes/member schemas/exposures, executable Binding/Flow inputs/outputs/GateSpec fields). Do not recursively assume any business `_schema` field or opaque `Agent.output_contract` is a Schema: read frozen contracts and define semantics where currently unspecified. Existing operation/Strategy wrappers are helpers, not automatic all-kind compiler enforcement.

Then compile actual all-kind graph with verified nested closure/compiled hashes, canonical Binding paths and effective policies, Instruction Skill ID→closure path mapping; T4 seals exact Pack operation routes/GateSpecs/join child outcomes, T5 typed admission, T6 registry/PG/integration. Preserve disabled/unexposed resources, immutable full-pin identity and all source/Binding-added restrictions. Source checks and caller-supplied sealed flags cannot replace trusted registry readback.

## Compound

Saved [[2026-09-02-schema-reference-and-worker-boundaries]], canonical index entry, architecture/testing rules and debug journal. Renderer `scripts/sync-solution-index.js` absent; only explicit index entry maintained, no fabricated runtime projection. Global skill-signals directory returned no entries; no global writes or invented health statistics. Local skill observations: work/test-strategy gave RED→GREEN, review exposed real false-acceptance and test gaps, compound/context-handoff retain them. No skill change proposed.

This checkpoint is neither goal completion nor a blocked-goal declaration.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[g1-a1-json-schema-review]]
- [[2026-09-02-g1-a1-capability-closure-kernel-handoff-8]]
