# Parent child-call operations bind by canonical mount path

## Problem

The operation used to invoke a child Flow or Agent is not the same as operations projected from inside that child's verified closure. Parent and child releases may reuse local Binding IDs, and one child version may have multiple mounts with different call schemas or effects.

## Solution

First complete the graph-bound nested Agent or Flow projection. Reprepare both sources and determine the exact mount set by target kind and complete target pin. Require a closed declaration array with exactly one unique entry per mount. Verify each operation against its concrete parent Binding, including call kind, input/output schemas, side effect, operation-key and approval requirements.

Resolve each parent Binding's canonical root path and attach its call operation only by that path. Preserve projected child entries unchanged, even when their local `binding_id` equals the parent ID. Sort and deeply freeze the composed result.

## Boundary

This binds call declarations to verified direct child mounts. Final config/async policy hashes, GateSpec coverage, effective policy, recursive closure assembly, registry provenance and runtime admission remain separate requirements.
