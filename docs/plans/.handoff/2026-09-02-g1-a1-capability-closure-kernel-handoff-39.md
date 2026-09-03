---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 39
created: "2026-09-02T20:18:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 39

## Implemented

- Added a closed invocation-demand source contract for Flow/SubAgent parent calls.
- Derived operation identity, effect and approval from the verified call operation rather than caller input.
- Attached normalized invocation requirements only to exact parent paths, preserving same-ID child isolation.

## Evidence

- Domain contracts: **162/162**.
- Release-core: **938/938**.
- Repository `pnpm check`: pass; existing unrelated test-support diagnostics remain non-fatal at 9 warnings and 1 info.
- Inline L4 review P0/P1/P2 = 0 after fixing build-only exact-optional typing and readonly-fixture errors found by the full feedback loop.
- No PostgreSQL, host-attested, upload or production acceptance is claimed.

## Next

Compile Flow/internal-Agent parent Binding entries by joining verified invocation requirements with the verified child-root expression as `nested_call`, then resolve the complete effective policy through exact path ceilings.
