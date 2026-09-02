---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 28
created: "2026-09-02T18:09:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 28

## Implemented

- Each exact parent Flow/internal-Agent mount now requires one independently verified call operation declaration.
- Call declarations are matched to mounts by target kind/full pin and attached by parent canonical Binding path.
- Same-ID projected child entries remain isolated; multiple Flow mounts enforce exact declaration cardinality.
- Nested Agent projection now rejects graph/closure assemblies that omit any prepared Agent dependency, including non-Binding Strategy/Instruction dependencies.

## Evidence

- Composed nested Agent/Flow suites: **22/22**.
- Release-core: **882/882**.
- Fresh zero-cache `pnpm check`: pass; existing unrelated test-support Biome diagnostics remain non-fatal at 9 warnings and 1 info.
- Architecture mutation gate: **31/31**; `git diff --check`: pass.
- Five-view local review found no P0/P1/P2 after adding the missing Agent source/graph/closure manifest agreement check.
- No PostgreSQL, host-attested or production acceptance is claimed.

## Next

Assemble complete per-path Binding entries and effective policy using the verified operation, gate, route and nested projections.
