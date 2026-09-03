---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 12
created: "2026-09-02T16:05:50+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 12

## Position

The product goal remains the complete Agent application modeled on ai.betteryeah.com and independently reachable through songuu.top. This increment adds recursive Flow node identity paths inside partial T3.2 only.

## Implemented

- `flow_node` canonical identities include `graph_id`, preventing collisions when sibling graphs reuse node IDs.
- Flow source validation fixes the root graph ID to `root` and rejects duplicate graph IDs across all nested case, else and loop-body graphs.
- The private raw-source compiler derives sorted, deeply frozen root/branch/else/loop paths with their complete ancestor chain and exact 4,096-node admission.
- Binding-path `/1` baseline reset is documented as pre-persistence; future persisted changes require a new version.

## Evidence

- Fresh zero-cache `pnpm check` passes; release-core 764/764 and domain-contracts 155/155.
- Architecture gate tests 31/31 pass.
- Independent security, architecture, quality, test and performance reviews converge at P0/P1/P2=0.

## Next

1. Carry verified nested dependency prefixes and closure-wide owner/registry context into path compilation.
2. Add Skill Pack member and SubAgent target segments from typed source adapters.
3. Compile effective path policies and distinguish source-disabled from policy-unavailable paths; T3.2 remains incomplete.
