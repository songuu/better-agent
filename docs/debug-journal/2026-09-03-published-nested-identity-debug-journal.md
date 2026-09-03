# Published nested identity debug journal — 2026-09-03

1. Hypothesis: private Agent/Flow dependency paths compare semantic pins rather
   than the final published hash. Added two real compiled-pin positive tests.
   Both failed with `CAPABILITY_DEPENDENCY_UNRESOLVED` before implementation.
2. Propagated source + verified closure-derived pins through paths, owners, Gates
   and final replay. Both positive tests passed. Existing fixtures moved to real
   compiled pins; the expanded run exposed the same seed comparison in child-call
   declaration matching. Fixed that consumer; 119/119 affected cases passed.
3. Added six independent wrong-hash vectors and two enabled/disabled two-level,
   double-mount cases. A fixture initially omitted the second call operation from
   its shared ceiling; fixed the fixture without relaxing policy checks.
4. The real Agent→Agent→Flow chain then failed at descendant requirement/operation
   equality. Reproduced both modes. Distinguished nested invocation operations
   from complete child demand; bound the child expression to its target node,
   retained full parent validation and old effective ceilings. Both modes passed.
5. Added independently resealed invocation and child-demand mutations, explicit
   operation isolation, exact enabled/disabled Plan counts and semantic-owner
   substitution. Review found path ordering could mask the last negative check;
   restricted it to enabled mode, re-sorted entries and asserted the exact
   `descendant Binding shape is unsupported` guard. Both final cases passed.
6. Large Gate fanout took 6.28 seconds without competing test runs and exceeded the
   default five-second runner timeout. Removed duplicate fixture compilation and
   scoped a 15-second timeout to this repeated full-compilation boundary vector.
   Production 32 MiB / 8,192-entry limits and budget-rejection assertion unchanged.

Validation: 127 affected cases; 1069 release-core cases in 39 files; final targeted
pair and typecheck pass. Repository/full-gate evidence is recorded separately.
No source test was removed, skipped or marked todo. No database authority or
production mutation was used to turn a failure into a pass.
