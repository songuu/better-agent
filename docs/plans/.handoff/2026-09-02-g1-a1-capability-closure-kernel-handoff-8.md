---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 8
created: "2026-09-02T13:59:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 8

## Goal / position

Full goal unchanged: complete Agent application modeled on ai.betteryeah.com and independently reachable through songuu.top. E:/project/ai/agent is deployment mechanics reference only. Do not ask scope again or replace the app with docs, healthy PostgreSQL or green CI. Active goal is incomplete and local implementation is making progress.

T1/T2/T3.1 and earlier source increments are committed locally. This increment completes the **Instruction Skill typed source adapter**, not final closure compilation or application delivery. T3.2 still needs JSON Schema validation, verified nested closure/compiled hashes, canonical Binding expansion/Skill descriptor paths and effective policies; then T4 routes/GateSpec/child outcomes, T5 admission, T6 real integration and the actual UI/API/runtime app.

## Files / APIs

- Base c2e38ef, branch codex/g1-a1-closure-identity. Resolve this increment's local commit with git log -2; no upload.
- Domain instruction-skill-source-v1.ts exports closed source/candidate/manifest/file/trusted-signers schemas; three versioned roots registered. Nine new domain structural tests, not cryptographic proof.
- prepareInstructionSkillSource / verifyInstructionSkillSource in release-core bind full immutable document and actual bytes. Versioned signing payload excludes signature but includes complete normalized source and signer ID; independently supplied trust must match Workspace/key/publisher/source/allowed resource IDs.
- Canonical 44-byte public Ed25519 SPKI roundtrip, then @noble/curves 2.4.0 strict point decoding, nonidentity/torsion-free and verify zip215:false. Every crypto/scope failure sanitized. package.json and lockfile fixed; library dependency @noble/hashes 2.4.0.
- Files are canonical base64 chunks (49,152 decoded bytes for every nonfinal chunk), max 64 files/1 MiB each/2 MiB total. SKILL.md is 1–65,536 bytes valid UTF-8, nonblank, no leading BOM/unsupported controls. Canonical NFC paths with Windows/case/prefix safety; script/reference/asset roles enforce prefixes. No extraction, execution or Markdown interpretation. requires_execution=true fails explicitly.
- Returned artifact includes document/files/signing_payload/signature_evidence/preimage/full_pin/content_hash/inert_content/empty direct manifest, bounded again and deep frozen. Separate source/expected bounds preserve large legal verify roundtrips. Inert source content is not final compiled descriptor or runtime clipped content.
- verifyInstructionSkillAssembly uses real executable-source preparation, same Workspace, exact full Skill pin/content hash, subset/cap narrowing and requires all source Binding IDs to exist in the Agent, including unselected references. Final closure path mapping remains open.
- Full source profile frozen in compiled-capability-closure-v1.md §7.1.5. Historical G0 evidence and existing G0 publisher profiles unchanged.

## Validation / review

- 63 new release tests: real source/assembly suite 61 + isolated crypto-boundary suite 2. release-core **605/605**; domain **152/152** (+9). No skips/todos. Core/manifest exact count markers synchronized, no semantic rule weakened.
- Final source `TURBO_FORCE=true pnpm check` PASS at ~13:56–13:57 +08, zero cached tasks. Architecture **31/31**, skip/todo=0. Existing unrelated non-fatal test-support lint warnings remain.
- Five views through g008_perf_review, g008_quality_review, g008_test_review all finally DONE; independent doc/code and inventory readback DONE. Earlier security tool error was not claimed as a pass; separate defensive patch audit succeeded. No remaining P0/P1/P2.
- Degenerate Ed25519 public key bug reproduced RED, then fixed with strict library checks; permanent real regression retained. Four first-only/partial-projection mutants and one masked chunk-boundary mutant now killed. Strict crypto option/point guard mutations killed by separate isolated mock suite, not substitutions for real signing tests. Independent quality review ran 65 extra probes.
- See [[g1-a1-instruction-skill-review]] / [[g1-a1-instruction-skill-debug-journal]]. No current-source PostgreSQL integration, clean-checkout executable gate, new GitHub CI, host-attested Acceptance or production validation.

## Authority / environment — unchanged

1. Prior push to github.com/songuu/better-agent / codex/g1-a1-closure-identity was rejected by auto-review; exact upload-only approval request remains unanswered. No retry via Git/API/browser/alternate transport, merge or deploy without required authorization.
2. Server root /dev/vda3 is full. No partition expansion, neighboring data deletion or disk preflight bypass authorized.
3. Docker recovery paused after external GUI reset log; no reset/reinitialization, original authority readback unavailable. Do not reconstruct authority rows from local receipt copies.
4. Historical receipt sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668 applies only to its recorded subject, not this code. Pure local deterministic work can continue.
5. Exact local dependency download/install escalation was approved for @noble/curves 2.4.0, not upload. Existing pnpm store is C:/Users/Administrator/AppData/Local/Temp/better-agent-pnpm-store-20260901 (v10 under it). Default install selected another store and refused noninteractive module removal; reuse the existing store with --ignore-scripts. Only two dependencies added; no module tree reset. Read .modules.yaml before future installs.

No external application state changed. Older /better-agent/ 404 evidence is not superseded by these tests.

## Next local work

Continue T3.2 serial L4 TDD: read final closure contract and existing all-kind source APIs; freeze bounded JSON Schema validation profile and implement it before trusting embedded input/output/config schema documents. Existing source helpers only hash schema JSON, not validate instances or schema execution. Then derive real graph from all typed sources and verified nested closure bodies, expand canonical paths and path policies, map inert Skill Binding IDs to exact closure paths; T4 completes GateSpec/route/child outcomes. Do not promote source adapters or self-reported sealed flags into registry authority.

Use existing primary docs/current package sources for schema library APIs; no ad-hoc network $ref fetching or runtime code. Keep immutable full pins, typed operation coverage, disabled/unexposed resources and exact self/cycle/Workspace limits. Effective policies must include Binding-added restrictions, not only the intrinsic source results. Reuse identity/policy/graph kernels.

Review skill authorizes independent read-only reviewers; reuse current three agents. Build domain dist before release package-local typecheck. Use actual full test counts for inventory, preserve all regression tests. Local-only commit needs exact escalation, upload prohibition unchanged.

## Compound

Saved [[2026-09-02-signed-inert-source-key-validation]], canonical index entry, architecture/testing rules and feedback journal. Renderer scripts/sync-solution-index.js is absent; maintained only the explicit index entry, no fabricated runtime projection. Global skill-signals directory yielded no entries; no global instinct/signal writes or invented health numbers. Skill signal observations (local only): work/test-strategy supported RED→GREEN, review caught real crypto and masked-test gaps, compound/context-handoff preserve continuity. No broader skill change proposed.

This checkpoint is not completion or blocked-goal status.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[g1-a1-instruction-skill-review]]
- [[2026-09-02-g1-a1-capability-closure-kernel-handoff-7]]
