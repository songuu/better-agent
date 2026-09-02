---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 4
created: "2026-09-02T12:24:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 4

## Product / progress

The target is a complete Agent application modeled on `ai.betteryeah.com`, independently deployed through `songuu.top`. `E:/project/ai/agent` is only the deployment-mechanics reference. Do not ask the user to choose again between an app and a documentation site. The active unbounded implementation goal is incomplete.

T1/T2 and T3.1 are implemented locally. This checkpoint adds the **source-preimage portion of T3.2**, not final closure compilation. Continue kind-specific leaf/operation source adapters, verified nested closure bodies/compiled hashes, canonical Binding paths and effective policies, then T4 gate/routes/child map, T5 typed admission, T6 integration. Browser/API/runtime/persistence and production deployment remain required beyond this kernel.

## Source / APIs

- Branch `codex/g1-a1-closure-identity`; T1 `84892d96e7146e36910f8a7ea843f6570d397327`, T2 `bfaf4fb`, T3.1 `75062c2a21ac15052d2ff09893041e46b014ffe1`. This checkpoint accompanies the new local source-preimage commit; resolve its exact SHA from `git log -2`. No push occurred.
- `packages/release-core/src/executable-source.ts`: prepare/verify source and derive/verify compiled hash primitives. Closed `executable-source-candidate/1` with Workspace plus `agent-executable-source/1` or `flow-ir/1` document.
- Semantic preimage fixes compiler/canonicalizer versions, owner kind/Workspace and normalized document. Root pin's contract hash is the semantic seed. Direct dependencies include strategy, instructions and all Agent Bindings including disabled ones, or Flow resources.
- Only Agent top-level release number/source revision and Flow top-level title/ui are excluded. Explicit typed sets sort; business arrays and first-match branch cases retain order. Nested Flow subflow references must resolve exactly to declared resource pins.
- Final-hash helper changes the preimage schema to `executable-compiled-preimage/1` and adds strict `capability_closure_hash`. It binds a supplied hash, **not proof of closure body validation or registry provenance**. No new publisher call sites; Agent remains paused.

## Important fixes / evidence

- Reject any raw/parsed canonical byte difference before documented exclusions. This closes Zod own `__proto__` silent loss in both Agent and Flow; no global prototype pollution was observed.
- Flow loop and node schemas use discriminated unions. A valid 13-condition-loop work-count regression was red at 16383 leaf reads; discriminator dispatch fixes the exponential parsing. The source API still rejects all getter/Proxy inputs.
- Source profile: 8 MiB raw key/value UTF-8 and separately JCS, depth 64, 131072 values, 1024 array items, 128 object keys, 65536-byte strings, 256-byte keys; aggregate nested Flow nodes 4096. Existing profiles remain separate.
- Source tests **81**, release total **319/319**; Flow recursion tests **5**, domain total **127/127**. Rich fixtures cover six Binding kinds, nested graphs and isolated drift. In-memory mutation checks protect lossless barriers, recursion complexity, full Binding projection, shared gate refs and recursive loop traversal.
- Final fresh zero-cache `pnpm check` passed at 12:22 +08:00; architecture unit/mutation tests **31/31**, skip/todo=0. Five-view L4 review across three reviewers DONE, remaining P0/P1/P2=0. Existing test-support lint warnings unchanged. This is not real PostgreSQL, remote CI, host-attested or production acceptance.
- Read [[g1-a1-executable-source-review]] / [[g1-a1-executable-source-debug-journal]] for exact scope; previous evidence remains historical.

## Operational boundaries — do not bypass

1. The earlier push of this branch to `github.com/songuu/better-agent` was rejected by auto-review. An exact upload-only approval request is outstanding. No retry via Git, API, browser or another transport, no main merge or deploy without the required authorization.
2. Server root `/dev/vda3` is full. No partition expansion, neighboring deletion or disk-preflight bypass is authorized.
3. Docker recovery is paused after an external GUI reset appeared in logs. Do not reset/reinitialize it; original authority PG readback is still unavailable. Do not manufacture authority records from local receipt copies.
4. Historical G0 receipt `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668` remains scoped to its recorded subject. This outage neither revokes that result nor attests current source. Pure local TDD may continue.

No external state was changed in this increment. Production's independent PostgreSQL is not evidence that the application is served. Prior `/better-agent/` result was 404 and no working front-end/HTTP service has been delivered.

## Next action

Read T3.2 remainder and `docs/architecture/compiled-capability-closure-v1.md`, especially source adapters and final closure obligations. Implement the next bounded pure-kernel slice with TDD and independent review; do not promote syntactically valid fixture hashes to trusted leaf contents or registry sources. Preserve uncommitted user changes. Use local pinned Biome through package scripts/direct `node node_modules/@biomejs/biome/bin/biome`; root `pnpm exec biome` previously selected a different global version.

## Compound

Saved one solution, index entry and architecture/debugging/testing rules. Unified solution-index renderer is absent; global skill signals are empty and unchanged. No usage statistics or global instincts were invented.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[2026-09-02-executable-source-lossless-recursion]]
- [[g1-a1-executable-source-review]]
