# Nested Flow operations require source-aware path projection

## Problem

A Flow node ID is only unique inside its graph, and the same Flow can be mounted by multiple Agent Bindings. A closure hash proves the supplied closure bytes, but does not alone prove that the graph manifest or closure assembly describes the supplied Flow source.

## Solution

Recompute the parent graph and prove the direct Agent-to-Flow edge. Verify the graph-committed nested closure, then require the prepared Flow dependency manifest hash to equal both the graph dependency node and closure root resource node hashes; require the closure assembly pins to equal the Flow source dependencies.

Every child closure Binding must equal an independently derived standalone Flow-node canonical path. Its identity key is the complete ordered `(graph_id,node_id)` ancestry. Project its operation set only to the corresponding node path under each already-derived parent Flow Binding prefix. Preserve parent sibling paths with empty operation sets and sort/deep-freeze the result.

## Boundary

This projects operations already sealed in one direct child Flow closure. It does not create the parent `flow_call` operation declaration, compile effective policy, recursively assemble arbitrary subflows, attest registry provenance or authorize runtime execution.
