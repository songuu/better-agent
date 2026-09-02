---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 37
created: "2026-09-02T19:46:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 37

## Implemented

- Replaced flat resource-node intrinsic requirements with a closed recursive requirement-expression contract.
- Preserved ordered sequence topology and canonicalized set-like parallel/alternative branches without deduplication.
- Enforced expression fanout, node-count and depth bounds, including an independent hostile-input snapshot profile.
- Required every compiled closure resource-node expression to already be canonical before accepting its hash.

## Evidence

- Domain contracts: **161/161**.
- Release-core: **918/918**; typecheck passes.
- Repository `pnpm check`: pass; existing unrelated test-support diagnostics remain non-fatal at 9 warnings and 1 info.
- Architecture mutation gate: **31/31**; `git diff --check`: pass.
- Inline L4 review found and fixed both the expression-depth/profile mismatch and direct-schema deep-recursion risk; final P0/P1/P2 = 0.
- No PostgreSQL, host-attested, upload or production acceptance is claimed.

## Next

Define executable numeric minima composition for each expression kind, then compile root/composite Binding entries from verified topology rather than copying child minima.
