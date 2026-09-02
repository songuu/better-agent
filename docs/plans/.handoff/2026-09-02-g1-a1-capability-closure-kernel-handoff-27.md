---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 27
created: "2026-09-02T18:03:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 27

## Implemented

- Nested Flow closure operations now resolve only through exact standalone Flow-node canonical paths and complete ordered graph/node ancestry.
- Source, graph and closure dependency manifests plus closure assembly pins must agree before parent-prefix projection.
- Multiple parent Flow mounts remain isolated and unrelated parent paths retain empty operation sets.

## Evidence

- Focused projection tests: **8/8**.
- Release-core: **875/875**.
- Fresh zero-cache `pnpm check`: pass; existing unrelated test-support Biome diagnostics remain non-fatal at 9 warnings and 1 info.
- Architecture mutation gate: **31/31**; `git diff --check`: pass.
- Five-view local review found no P0/P1/P2 issue. This adapter consumes an already sealed node-to-operation association; typed action-specific node-to-resource compilation remains a later final-compiler obligation.
- No PostgreSQL, host-attested or production acceptance is claimed.

## Next

Attach the parent Flow/SubAgent call operation declarations, then assemble per-path effective policies without widening child authority.
