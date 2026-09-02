---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 38
created: "2026-09-02T20:08:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 38

## Implemented

- Compiled exact numeric limit envelopes for leaf, sequence, parallel, alternative, repeat and nested-call requirement expressions.
- Made nested-call invocation cost explicit and nonzero, with fail-closed safe-integer and PostgreSQL-bigint overflow checks.
- Bound root expression demand to closure aggregate limits before accepting an otherwise self-consistent closure hash.

## Evidence

- Domain contracts: **161/161**.
- Release-core: **937/937**.
- Repository `pnpm check`: pass; existing unrelated test-support diagnostics remain non-fatal at 9 warnings and 1 info.
- Architecture mutation gate: **31/31**; `git diff --check`: pass.
- Inline L4 security/architecture/quality/performance/test review found and fixed the implicit zero-cost nested invocation; final P0/P1/P2 = 0.
- No PostgreSQL, host-attested, upload or production acceptance is claimed.

## Next

Compile root and composite Binding entries from verified operation/resource topology using the shared envelope compiler, then assemble their canonical effective policies into the final closure.
