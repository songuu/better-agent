# Nested Agent operations require verified path projection

## Problem

Parent and child Agents can legally reuse local Binding IDs. Joining child operations by `binding_id` alone can leak a child's authority into a same-named parent Binding or merge two mounted child namespaces.

## Solution

First recompute the pinned dependency graph and prove the direct parent-to-child edge. Verify the supplied child closure against the dependency node's version identity and `nested_closure_hash`, including its canonical set order and complete closure hash. Require the prepared child Agent dependency manifest to agree with the graph node, closure root and complete closure assembly pins, including Strategy and Instruction dependencies. Resolve every child operation through the exact child-root canonical Binding path and confirm its kind and full target pin. Only then project that operation set onto each already-derived parent-prefixed `subagent_target` Binding path.

Parent root paths remain present with empty operation sets, and separate mounts of one child receive separate canonical paths. The result is sorted and deeply frozen for later policy and final Binding assembly.

## Boundary

This proves one direct nested Agent operation projection. It does not compile Flow operations, effective delegation policy, arbitrary recursive closure composition, registry provenance, runtime execution or production acceptance.
