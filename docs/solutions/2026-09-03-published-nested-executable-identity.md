---
title: "嵌套可执行版本必须区分发布身份、局部根身份和调用操作范围"
date: 2026-09-03
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["published nested executable identity"]
---

# Published nested executable identity

## Problem

Real closure-bound Agent/Flow published pins were rejected by source-seed path
adapters. Once that identity was fixed, a real Agent→Agent→Flow chain exposed a
second failure: composite descendant demand includes child operations, while its
call entry deliberately exposes only the invocation operation.

## Root Cause

Fixtures had reused semantic source pins as published pins. The same conflation
appeared in dependency paths, call declarations, Binding owners, Gate projection
and final admission replay. One-level fixtures also hid an invalid equality check
between an aggregate nested-call envelope and a call-entry operation set.

## Solution

- Keep standalone child closure roots and paths unchanged, using their semantic
  seed. Derive parent-facing published pins from exact source + verified complete
  closure hash. Private path helpers require that hash; no seed fallback exists.
- Carry the graph-bound published pin through child-call matching, descendant
  owners, SubAgent targets, Gate sources/paths and final proof replay.
- For recursive composite entries, bind the invocation operation set exactly and
  join the retained child expression to the exact target node's intrinsic policy.
  Validate the complete envelope against the new parent, then meet the original
  child effective ceiling while narrowing the entry to invocation operations.
  Grandchild operations remain in their own entries; all other demand axes remain.

## Prevention

Use real compiled pins in positive fixtures. Negative fixtures that reseal a
closure must also repin the parent and rebuild its graph, otherwise a stale-hash
failure hides the intended semantic guard. Test two levels and two mounts per
level through final closure and Plan, enabled/disabled, exact Gate owners, hash
substitution and resealed invocation/child-demand drift. Re-sort mutated paths
before asserting the specific owner guard. Capacity tests retain production
limits; allow sufficient test-runner time for repeated full compilation.

## Evidence and boundary

Focused suite: 127/127. Full release-core: 1069/1069 in 39 files; final targeted
owner-isolation pair and typecheck pass. Full repository/gate results are tracked
in [[g1-a1-published-nested-identity-validation]]. These are local compiler facts,
not registry authority, transactional publication, deployment or a finished app.

## Related

- [[2026-09-03-published-nested-identity]]
- [[2026-09-03-source-root-manifest-binding]]
- [[2026-09-03-published-nested-identity-debug-journal]]
