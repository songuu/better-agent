# G1-A1 all-kind Schema review

Date: 2026-09-02

## Scope

Typed all-kind Schema collection, bounded batch compilation, canonical per-field evidence and complete verifier reconstruction. This is a partial T3.2 increment, not final closure, database, host-attested or application acceptance.

## Validation

- release-core: 21 files, 729 tests passed.
- repository: fresh `TURBO_FORCE=true pnpm check` passed after the final code, contract and manifest changes.
- architecture mutation suite: 31/31 passed, no skip/todo.
- changed package: format, lint, typecheck and build passed.
- boundary probes: 8,194 unique schemas within one 5-second worker contract; a real 1,025-schema Flow produces frozen `[1024,1]` evidence batches and verifies round-trip.

## Review revisions

Independent review first found stale 694 test markers/docs, insufficient non-first/output/batch mutations, a missing exact batch-timeout regression and a 30-second batch worker regression. The implementation synchronized the manifest/contract to 729, expanded those regressions, and restored/protected the batch deadline at exactly 5 seconds. Quality, performance and test re-reviews all completed with P0/P1/P2=0. The final Skill Pack case uses an independently typed nested-pack member and changes only its second exposure while updating the declared operation hash, so source preparation still succeeds and Schema validation supplies the rejection.

## Remaining boundary

T3.2 still needs final Binding path/policy/nested closure compilation. T4 route/gate outcomes, T5 admission, T6 registry/PostgreSQL/publisher evidence, and the product UI/API/runtime/E2E remain open. No historical receipt is reused for this source.
