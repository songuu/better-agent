# G1-A1 T3.2 typed leaf source increment evidence

Date: 2026-09-02. Base: local `c8c8959` on `codex/g1-a1-closure-identity`. This record covers local source adapters, not complete application or production acceptance.

## Implementation / TDD

- Four closed source bodies: Knowledge Index Generation, Database Operation, Plugin Tool and external A2A Agent. Domain exports/registry and typed additional DB filter/allowlist contracts added.
- `prepareLeafResourceSource` binds complete normalized content to a versioned preimage/full pin, component hashes, operation declaration, intrinsic demands and empty direct leaf manifest. All inputs are bounded and losslessly parsed; outputs are bounded and deeply frozen. `verifyLeafResourceSource` recomputes every field with independent bounded operands.
- `verifyLeafResourceBinding` checks complete target/manual/operation identity, credential requirements and narrowing, taint, typed per-kind configuration and limits. DB user SELECT/predicate/order/additional-filter columns require the allowlist; all reads must fit source read/output classifications, including implicit membership/order flows. Fixed tenant/principal guards remain mandatory. Empty parameter-free SELECT is valid.
- `normalizeCapabilityRequirements` canonicalizes demand sets without dropping required scopes/modes. It reuses policy egress semantics and is consumable by existing policy resolution; it does not alter that resolver.
- Initial 53 tests RED on missing APIs, then GREEN. Final new release cases: **71 leaf + 3 normalization = 74**, plus **8 domain** structural cases. Package totals: release **453/453**, domain **135/135**. See [[g1-a1-leaf-source-debug-journal]] for review-driven red/green cases.

## Independent review

L4; all five views across three existing read-only reviewers, no design lens for pure kernel changes. Final three statuses DONE; no remaining P0/P1/P2, no context retry/structural blocker. Source fixes remained on the main agent; no reviewer changed files.

- Architecture/TypeScript: verified large artifact round trips, DB allowlist coverage, parameter-free SELECT, scope and §7.1.2 doc/code consistency. Its final targeted run passed new release **74/74**, domain **8/8**, typecheck/lint/diff check. Two P1 findings (round-trip budget and query-column allowlist) and one P2 empty-input boundary were fixed with permanent regressions.
- Security/performance: independently verified 32 hostile-object cases with trap=0, 16 network credential/timeout combinations, **384** DB classification combinations, and all four pin/component digest outputs against an independent canonical serializer/SHA-256. A **7,872,349-byte** artifact round-tripped; 128-entry plugin/card cases took about 54–62 ms, 1,024-source/1,024-shard knowledge about 86 ms on this Windows host. The 1,025-source case failed closed. Final release **453/453** and typecheck passed. No cross-platform throughput/SLA claim follows.
- Test: identified the additional-filter classification defect and three sensitivity gaps (Binding credential identity, non-default operation effect/approval, and allowlist masking classification rejection). All now have permanent regressions. Removing provider equality or replacing derived effect/approval with safe/false fails their cases. Final **74/74** baseline; independently deleting the read guard or output guard gives **73 pass / 1 fail** each, proving neither is masked by the allowlist.

## Gap Detection / Doc↔Code

| Invariant | Local evidence | Remaining obligation |
|---|---|---|
| Full leaf content → pin/components/operation | Four-kind positive/tamper matrix, independent digests, normalized sets and ordered query columns | Trusted catalog/artifact provenance and Workspace ownership |
| Source → Binding compatibility | Full pin tuple, manual bytes/hash, exact schemas, per-kind hashes, credentials, effect/key/approval | Compiler must merge Binding-added stricter requirements into effective path policy |
| DB scope and information flow | Tenant/principal constraints, all user-column allowlist, separate read/output guard mutations, no raw SQL | Actual prepared SQL execution, runtime tenant/principal injection, JSON Schema meta/instance validation |
| Bounds and deterministic verification | Independent operands, input-fit/output-overflow pair, large round trips, hostile inputs, max manifest cases | Capacity across hosts and complete nested closure budgets |
| Complete Agent application | No new HTTP/browser/executor/publisher call site | Remaining sources, final closure/admission, real API/browser/runtime/persistence E2E and independent deployment |

Architecture §7.1.2 is anchored to domain `leaf-resource-source-v1.ts`, release `prepareLeafResourceSource` / `verifyLeafResourceSource` / `verifyLeafResourceBinding` and policy `normalizeCapabilityRequirements`. It explicitly distinguishes source intrinsic policy from Binding-effective policy and digests from trusted implementation/provenance. Plan T3.2 remains open. Second pass: none; completion claims are limited to this tested local increment.

## Final local validation

- `TURBO_FORCE=true pnpm check` **PASS on 2026-09-02, final run started 13:06 +08:00** after the final guard-isolation regression: format, lint, workspace boundaries, OpenAPI/contracts, typecheck, all tests, build. Turbo reported **0 cached** for every stage. Nine existing non-fatal test-support lint warnings remain unchanged; no new lint diagnostics.
- `pnpm architecture:gate:test`: **31/31**, skip/todo=0. Gate core and manifest freeze the actual **453 / 135** inventory; no PostgreSQL registration, assertion or acceptance policy was weakened.
- This is not the six-suite real PostgreSQL clean-checkout gate, a remote CI run, host-attested receipt or production deployment. No database/authority/server state, remote branch or external credentials were changed.

## Compound / continuation

Saved one solution [[2026-09-02-leaf-contract-narrowing-and-roundtrip]], one canonical index entry, three architecture rules and one testing rule. The solution renderer is absent, so the index was narrowly updated without claiming runtime-projection synchronization. Global skill-signal directory is empty/unchanged; no global instinct or signal counts invented.

Continue from [[2026-09-02-g1-a1-capability-closure-kernel-handoff-6]].
