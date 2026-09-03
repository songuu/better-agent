# Complete Agent leaf assembly compares mount and target sets separately

## Problem

Compiling one dependency at a time does not prove that all leaf Bindings were covered. Conversely, requiring one source candidate per mount incorrectly rejects two canonical Bindings that intentionally pin the same immutable resource. Graph membership alone also permits a transitive dependency to masquerade as a direct Agent capability.

## Solution

Derive the complete root leaf mount set from the prepared Agent source: Knowledge, Database, Plugin and external A2A only. Require the path-keyed Binding ceiling set to equal that mount set. Separately group mounts by complete target pin and require exactly one independently prepared leaf candidate per unique target—no missing, duplicate or unrelated candidates.

Assemble entries for every mount and reject path duplicates. The graph-bound wrapper recomputes the supplied graph once, checks its root dependency-manifest hash against the prepared Agent source, and proves a direct root-to-leaf edge for every unique target in the same bounded batch. Canonically sort dependencies by full pin and entries by opaque Binding path, then deep-freeze the result.

## Boundary

This closes the Agent's root leaf subset only. Composite Flow, internal Agent and Skill Pack entries still need source-derived policy semantics, and graph consistency is not registry/publisher provenance or a final closure seal.
