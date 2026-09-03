---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 32
created: "2026-09-02T19:00:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 32

## Implemented

- Replaced open JSON resource-node intrinsic policy with `CapabilityRequirementsV1`.
- Removed fabricated empty intrinsic policies from nested Agent/Flow adapters.
- Split strict pinned-graph dependency commitment parsing from typed closure resource-node validation.
- Preserved version-tuple, resource-node identity, manifest and nested closure-hash joins.

## Evidence

- Domain contracts: **160/160**.
- Release-core: **899/899**.
- Focused nested/closure regressions: **37/37**; both package typechecks pass.
- Fresh repository-wide `pnpm check` passes; existing unrelated test-support diagnostics remain non-fatal at 9 warnings and 1 info.
- Architecture mutation gate: **31/31**; `git diff --check`: pass.
- No PostgreSQL, host-attested, upload or production acceptance is claimed.

## Next

Derive composite CapabilityRequirements from verified Flow, internal Agent and Skill Pack source/member facts; do not use caller-reported requirements or empty defaults.
