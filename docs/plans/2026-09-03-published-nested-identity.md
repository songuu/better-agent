# T6 prerequisite: exact published nested executable identity

## Scope and outcome

The source/root manifest join is complete. The next real publisher integration
reveals a separate mismatch: dependency paths currently use the child's semantic
seed, while a published Agent/Flow pin must contain its closure-bound compiled
hash. Fix this across the complete recursive projection and final verification
chain before implementing registry readback. This does not complete T6 or the
application, and does not authorize deployment or historical receipt changes.

## Decision (P3, L4; serial implementation)

Keep closure-local root paths bound to the semantic seed. Require the child's
closure hash in private executable-dependency path adapters and derive the
published pin from the exact source plus that hash. Final nested adapters must
verify the complete child closure before using its hash. Do not accept a semantic
seed as a compatibility fallback for a published dependency. Pass the verified
published resource identity through descendant Binding, Gate and admission proof
projection; do not reconstruct it from closure-local root pins.

An optional semantic-pin fallback was rejected because it admits two meanings for
the same dependency contract. Rewriting child closure-local roots was rejected
because it creates a hash cycle and changes independently committed child bytes.

## Work and verification

1. Write Agent and Flow positive regressions with real compiled dependency hashes;
   observe their current failures before changing production code.
2. Update private path/graph adapters and nested operation producers, retaining
   exact full-pin, source manifest, closure and direct-edge verification.
3. Carry the same identity through descendant paths, Gate projection, admission
   replay and final Agent closure assembly. Preserve independent semantic roots.
4. Update fixtures to model published pins, add semantic substitution/hash drift
   rejection, and exercise repeated mounts and recursive final sealing.
5. Run affected and full package tests, repository checks and architecture gates;
   synchronize only actual test counts. Independent five-view review is required.

Registry storage, transactional publication, remaining compiler combinations and
the full browser/runtime application remain subsequent obligations in the parent
G1-A1 plan. No database migration or production mutation is part of this fix.

## Progress

Steps 1–5 are complete for this bounded prerequisite. Two-level compiled-pin tests exposed and
fixed recursive call-entry demand/operation conflation; complete demand remains
checked while entry operations stay invocation-only. Focused 127/127 and full
release-core 1069/1069 pass. Repository checks, 37/37 architecture mutation tests,
the full clean-checkout gate and all six PostgreSQL suites pass; independent
five-view review converges at P0/P1/P2=0. Evidence is recorded in
[[g1-a1-published-nested-identity-validation]]. Parent T6 remains open.
