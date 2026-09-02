---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 15
created: "2026-09-02T16:37:07+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 15

## Position

The complete Agent application and independent songuu.top delivery remain the product goal. This increment adds direct internal and external SubAgent target paths inside partial T3.2 only.

## Implemented

- Internal Agent targets require exact pins, reject direct same-version cycles and expand their immediate dependency-owned Binding namespace after `subagent_target`.
- External A2A targets use a bounded unique Binding-set leaf verifier and terminate at `subagent_target`.
- Both adapters pre-register the full parent root namespace, retain explicit disabled paths and omit unproved nested closure seals.

## Evidence

- Focused path/leaf tests 134/134; release-core 801/801.
- Typecheck and package lint pass.
- Security, architecture, quality, test and performance self-review reports no open P0/P1/P2 findings; one invalid duplicate-credential fixture was corrected without weakening the Agent requirement-ID uniqueness contract.

## Next

1. Drive all direct slices from authoritative pinned graph records and require nested closure seals for Agent/Flow nodes.
2. Build sealed Skill Pack operation routes.
3. Compile effective policies and final closure artifacts; T3.2 remains incomplete.
