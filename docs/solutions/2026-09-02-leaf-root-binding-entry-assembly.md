# Leaf root Binding entry requires source-derived identity and a three-layer policy meet

## Problem

A structurally valid `CompiledBindingEntryV1` can still combine a real path with caller-invented config hashes, foreign operations or an authority ceiling that was never applied. Approval is especially dangerous: an effective policy may say `required` while no source GateSpec protects the operation.

## Solution

Independently prepare the Agent and leaf source, verify exact kind/full-pin Binding compatibility, and rederive the canonical root Binding path. Accept Workspace, root and Binding ceilings only through one closed, path-keyed input; require its Binding path set to equal the selected mounts. Meet all three ceilings, then resolve the leaf's complete intrinsic requirements without intersecting demands away.

Build the entry from prepared facts: typed path segments, target pin, canonical config hash, leaf source contract hash, concrete operation pin and canonical dependency node. Join approval through the Agent's same-source GateSpec coverage, and reject any effective `required` policy without that gate. Hash async external-A2A child policy from normalized Binding config. Parse the final value through the closed compiled-entry schema, sort by canonical path and deep-freeze it.

## Boundary

This is a private deterministic compiler projection. The supplied typed ceilings still require authoritative registry/publisher provenance, and Flow, internal Agent, Skill Pack and final closure assembly remain separate work.
