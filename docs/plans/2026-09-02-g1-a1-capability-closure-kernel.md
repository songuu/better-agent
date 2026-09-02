# G1-A1 Capability Closure / Policy / ResolvedPlan kernel

> Status: T1–T2 and the T3.1 manifest graph slice implemented locally; T3.2–T6, final PostgreSQL validation and deployment remain pending.
> Updated: 2026-09-02
> Planning depth: P3 for the local kernel; P4 for eventual deployment. Implementation risk: L4.

## 1. Product outcome and slice boundary

Better Agent is the complete Agent application defined in `docs/07-实施计划.md`, modeled on `ai.betteryeah.com`. The reference project `E:/project/ai/agent` supplies deployment mechanics only. The final application must provide real editing, publishing, execution, persistence and observation through `songuu.top`; a documentation site, healthy database, green CI or placeholder interface does not satisfy that goal.

This plan implements the first dependency of that application, not a reduced final deliverable. G1-A1 supplies a single deterministic capability kernel shared by Flow and Agent. G1-A2 through G1-A8 then add fixed resources, durable execution, authenticated API/browser projections, production evaluation and a real vertical acceptance path. The broader product inventory remains in the existing implementation plan.

## 2. Entry evidence and current uncertainty

- `docs/plans/.handoff/active-sprint.json` records a passed, host-attested G0-08 receipt at review generation 3. The historical receipt hash is `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668`.
- That record supersedes the older prose saying no receipt exists, but it is not a new attestation of subsequent source changes. Do not edit the historical receipt or its evidence to update status text.
- Commit `a1ce87d133dfaa1edf482ab9935604b7e5a2bd5d` has a successful [CI run 33581446892](https://github.com/songuu/better-agent/actions/runs/33581446892), including the executable architecture gate and six PostgreSQL suites.
- On 2026-09-02 the historical verifier could not connect to its configured local authority database at `127.0.0.1:55433/tech_persistence`. A temporary connection to the remote database at the same port produced a readback mismatch; it is not proof that the original local authority record is invalid. The tunnel was closed without authority writes.
- Local Docker startup encountered stale Windows sockets. Recovery preserved those sockets under backup directory names. A later Docker log recorded an external UI factory-reset action; its effect on the authority database is unknown. Docker recovery is paused pending coordination with the user. The existing VHDX file is present; file presence alone does not prove database integrity.
- Historical G0 admission remains granted for its recorded subject. The unavailable original database does not automatically revoke that result; the remote mismatch does not establish invalidity of the local record. Pure deterministic TDD may proceed under the user's existing implementation authorization. Current-source PostgreSQL integration, complete gates and applicable independent acceptance are still required before new completion, merge or release claims. Never manufacture authority rows from the local receipt copy or use the old receipt to attest new source.

## 3. Technical approach

Reuse `packages/domain-contracts` for closed public schemas and `packages/release-core` for deterministic publishing primitives. Reuse the existing RFC 8785 canonicalizer and release registry boundaries. Introduce no network activity, secret resolution or runtime execution into compilation.

### Options considered

| Option | Decision | Reason |
|---|---|---|
| Extend the existing release kernel and schemas | Selected | Reuses canonicalization, typed pins and publishing contracts without duplicating security semantics. |
| Give Flow and Agent independent compilers and policy implementations | Rejected | Two authorization interpretations can diverge on nested capabilities. |
| Start with a working-looking Studio backed by placeholder closures | Rejected | Does not meet the existing safety or end-to-end acceptance contract. |

### Contract interfaces

| Contract | Current implementation | Required result | Consumers |
|---|---|---|---|
| Binding path / resource node identity | Structural string and segment schemas | Canonical byte profile, recomputation, exact equality and collision rejection | Publisher, closure loader, ResolvedPlan, Flow/Agent call membership |
| Effective capability policy | Closed egress/budget/ceiling/demand schemas and pure meet/resolve implemented in T2 | Wire verified registry and admission facts into the shared kernel in T3–T5 | Closure compiler and admission |
| Compiled closure | Structural schema / references | Deterministic graph validation, canonical hash and exact pinned dependencies | Release registry, Flow compiler, Agent compiler |
| ResolvedPlan | Target contract, not an implemented admission kernel | Immutable narrowing of a verified closure under typed deployment and current authorization | Worker, API, future Studio execution |

### Canonical identity profile to freeze before implementation

- Define exact numeric segment tags, field tags and field order for `binding-path-lp-utf8/1` in the architecture contract. Lengths and segment counts use fixed-width unsigned big-endian integers; tags and fields form a closed grammar, not an extensible free-form map.
- Preserve business segment order. Require exactly one initial root; owner kinds and pin kinds must agree with their closed segment variants. Root contract hash remains the semantic seed hash, not the final compiled hash.
- Hash complete pins, including workspace, resource kind, resource ID, version ID, contract hash and `binding_mode=pinned`. Never deduplicate on a bare version ID or local binding ID.
- Reject malformed Unicode, accessors, unknown fields, mutable aliases, malformed/noncanonical digest text and configured absolute size/depth/count limits before hashing. Do not introduce delimiter concatenation or a second digest encoding.
- Freeze independent byte/digest vectors for every segment variant and adversarial separators/Unicode. Identity validation must distinguish an incorrect digest, duplicate identity and an actual conflicting canonical payload.

## 4. Ordered implementation tasks

No task is marked `[P]`: the kernel is L4, tasks share contracts and each consumes preceding results. Implementation is serial; independent review remains separate.

- [ ] **T0 — Reconcile provenance and restore validation capacity.** Verify original authority readback when its environment is available, without modifying the record; provide a working disposable PG16 test environment for current-source validation. This is not a new prerequisite for pure T1–T5 TDD and does not revoke historical G0 admission. Files: control-plane evidence under `docs/plans/.handoff/`; distinguish stale status prose from signed historical evidence. No database reinitialization, receipt replacement or broker changes are implied.
- [x] **T1 — Freeze and implement canonical identities.** Write failing fixed vectors and malformed-input tests first, then implement binding-path/resource-node computation and verification. Files: `docs/architecture/compiled-capability-closure-v1.md`, `packages/release-core/src/closure-identity.ts`, `packages/release-core/src/errors.ts`, `packages/release-core/src/index.ts`, `packages/release-core/test/closure-identity.test.ts`; narrowly adjust domain schemas only where required. Depends on recorded G0 admission, not local authority availability. Risk: L4. Local evidence: 56 new identity regressions plus 33 existing release-core tests pass; fresh zero-cache `pnpm check`, 31 architecture tests and five-view review pass. See `.handoff/g1-a1-identity-debug-journal.md`; no full G1/production acceptance claimed.
- [x] **T2 — Implement versioned policy meet.** Closed egress/budget/ceiling/demand vocabularies; exact credential provider/audience, full required scopes, common principal modes, exact operation allow-sets, clearance min/taint max, side-effect/approval and all budget dimensions. Joint token minima and complete output budgets also enforced. Files: closure contract, domain policy schemas/tests, release-core policy/snapshot modules/tests. Depends on T1. Risk: L4. Evidence: 68 new release tests + 69 new domain tests; package totals 157/122; final fresh zero-cache `pnpm check` and 31 architecture tests pass; five-view review P0/P1/P2=0. See `.handoff/g1-a1-policy-review.md`. This is pure local kernel evidence, not new PostgreSQL/CI/host-attested or production acceptance.
- [ ] **T3 — Compile and verify the pinned graph.** Enforce kind-specific configuration, recursive dependency pins, cycles, absolute resource limits, root identity, nested closure hashes, forced/optional availability, stable semantic-set ordering and collision detection. Files: closure compiler/loader modules and tests in release-core; closure domain schemas where needed. Depends on T2. Risk: L4.
  - [x] T3.1: prepare/verify the bounded pinned dependency graph from an exact manifest snapshot. Implemented with 81 new graph regressions (release-core total 238), including full-pin/manifest equality, cycles, longest-path depth, 256-node/1024-edge boundaries, hostile input and complete artifact verification. This intermediate artifact does not establish root/nested body provenance or enable publication. See `.handoff/g1-a1-pinned-graph-review.md` for final validation and review evidence.
  - [ ] T3.2: derive graph inputs from kind-specific immutable source preimages, compile canonical Binding paths and path policies, validate nested closure/compiled hashes and required/optional paths; integrate the final closure with T4. T3 stays incomplete until these obligations are implemented and tested.
- [ ] **T4 — Compile gate, route and child policy boundaries.** Verify GateSpec source/ID/hash/operation coverage, exact Skill Pack operation routing and the frozen join-only child terminal map. Unknown or incomplete combinations fail closed. Files: compiler modules and focused adversarial fixtures. Depends on T3. Risk: L4.
- [ ] **T5 — Implement typed admission and ResolvedPlan narrowing.** Consume verified closure and Agent/Flow-specific deployment profiles; integrate existing credential/admission primitives; forbid new paths, targets or operations and retain epoch decision evidence. Files: release-core admission/plan modules and domain contracts/tests as required. Depends on T4. Risk: L4.
- [ ] **T6 — Integrate publisher evidence and review.** Add real registry/publisher readback and rejection fixtures; synchronize the architecture manifest with actual test inventory; run full gates and independent security, architecture, quality, performance and test reviews. Update only evidence-supported status. Files: relevant publisher/DB integration fixtures, `tests/architecture-gate/manifest.json`, handoff evidence. Depends on T5. Risk: L4.

## 5. Verification

- Baseline observed this session: release-core has 33 passing tests. This is baseline evidence only, not G1 implementation coverage.
- The current working-tree `pnpm check` also completed successfully on 2026-09-02 (format, lint, workspace, contracts, typecheck, tests and build; Turbo cache reuse was enabled, with existing non-fatal lint warnings). It does not run the PostgreSQL suites or establish a fresh host attestation.
- Unit/contract tests: independent canonical vectors; unknown fields/kinds; Unicode and size boundaries; nested repeated IDs; permutation stability for sets and order sensitivity for paths; cycles; duplicate/colliding identities; missing or mixed deployment profiles; mutable latest rejection.
- Policy properties: idempotence, commutativity and associativity where the operation is a meet; no authority expansion in any dimension; read clearance and output taint tested in opposite directions. Required scopes and intrinsic resource requirements are validated separately from allow-set intersection.
- Integration/adversarial tests: hidden nested write capability, absent credential mapping, out-of-scope operation/egress, disabled optional vs mandatory paths, wrong GateSpec/route, immutable registry mismatch, cross-workspace references and runtime-added capability rejection.
- Admission matrix: Agent, top-level Flow and Agent-embedded Flow. Embedded Flow inherits its parent Plan and cannot borrow a top-level Flow profile or Workspace default credential. Mutate each kind/principal/audience/channel/scope/cardinality discriminator independently.
- Publishing atomicity: inject failures at closure blob/hash, root compiled hash, dependency manifest and registry writes. Independent readback must show no partial publication or sealed root; a successful retry must preserve matching pins/hashes across all four facts.
- Final evidence: all affected package tests, contract check, typecheck, lint, build, architecture mutation tests, six real PostgreSQL suites and the clean-checkout architecture gate. Review results must include the real user path and doc/code consistency; tests may not be skipped to accommodate local infrastructure failure.
- G1-A1 completion does not imply a public app exists. Full application delivery still requires authenticated browser/API/runtime/persistence E2E, deployment isolation, reload/restart persistence, cancellation/replay/recovery and production promotion evidence.

## 6. Risks and operational boundary

| Risk | Impact | Mitigation |
|---|---|---|
| Wrong authority database substituted for the original | Invalid admission conclusion | Preserve hashes and provenance; verify the original record; no self-created replacement. |
| Unspecified identity encoding details | Incompatible hashes or aliasing | Freeze byte grammar and independent vectors before implementation. |
| Policy dimensions treated uniformly | Clearance/taint inversion or credential widening | Explicit dimension-specific rules and property tests. |
| Unbounded nested closure inputs | Memory/CPU exhaustion | Absolute budgets and fail-closed validation before expansion. |
| UI or CI success mistaken for app completion | Incomplete user delivery | Separate per-layer evidence and the final real-browser vertical acceptance. |
| Full server root filesystem | Failed upload/migration or collateral damage | Keep deployment paused at disk preflight; partition expansion or cleanup requires specific authorization. |

Current server deployment remains untouched. This plan does not authorize partition changes, deleting neighboring projects, copying their credentials, opening database ports publicly or changing historical acceptance evidence.
