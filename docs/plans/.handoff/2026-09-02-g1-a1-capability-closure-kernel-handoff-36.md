---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 36
created: "2026-09-02T19:35:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 36

## Implemented

- Propagated the verified dependency resource node through Agent/Flow nested operations and child-call projections.
- Preserved non-empty child-root typed requirements without accepting caller policy.
- Removed an unsafe draft parent-entry compiler after review identified unspecified invocation minima composition.

## Evidence

- Focused nested Agent/Flow suites: **23/23**.
- Release-core: **914/914**; typecheck passes.
- Repository `pnpm check`: pass; existing unrelated test-support diagnostics remain non-fatal at 9 warnings and 1 info.
- Architecture mutation gate: **31/31**; `git diff --check`: pass.
- Review: P0/P1/P2 = 0 for the retained diff; unsafe speculative compilation was removed before commit.
- No PostgreSQL, host-attested, upload or production acceptance is claimed.

## Next

Specify topology-aware composite minima for leaf, Pack alternative routes, sequential/parallel Flow nodes and nested calls before compiling root/composite Binding entries.
