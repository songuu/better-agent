# Instruction Skill signed inert source increment review

Date: 2026-09-02. Base `c2e38ef`, branch `codex/g1-a1-closure-identity`.

## Dispatch

L4; serial implementation with three independent read-only reviewers across five views: g008_perf_review (security/performance), g008_quality_review (architecture/TypeScript quality), g008_test_review (tests). Existing models inherited. Design skipped because this increment has no rendered UI. No reviewer file/network/Git writes. The initial security follow-up errored at the tool safety layer and was not treated as a review pass; after the defensive patch, a separate bounded defensive source audit completed DONE. Final source and doc/code reviews are DONE, no remaining P0/P1/P2, no unresolved context request.

## Gap walkthrough

| User flow / invariant | Current evidence | Remaining boundary |
|---|---|---|
| Publish signed inert Skill source | Real Node-generated Ed25519 signatures, exact payload/bytes/hash, strict key/format/scope checks | Real trusted-publisher registry, revocation and seal not integrated |
| Invalid signer/key cannot authorize content | Original degenerate-key regression, low/mixed-order and noncanonical rejection, isolated strict-option/guard tests | Does not attest the caller supplying the trusted-signers object |
| Agent references only declared capabilities | Real executable-source preparation, full Skill pin/content hash, second-only scope checks and context cap narrowing | Closure-unique paths, effective authorization and activation/tokenizer clipping remain pending |
| Inert resources remain data | Opaque binary script fixture, explicit requires_execution rejection, no extraction/execution | Runtime prompt/rendering treatment and final descriptor integration not implemented |
| Bounds and representation uniqueness | 2 MiB total/1 MiB file/64 KiB entry, canonical base64/chunks/path aliases, large legal round trips and artifact overflow | No server/persistence/SLA proof from pure source tests |
| Complete Agent app | No app-level evidence in this slice | Authenticated UI/API/runtime/persistence/deployment E2E still required |

## Findings and closure

- Security P1: Node SPKI parsing/re-export plus verification accepted a degenerate identity public key. Kept the two-message RED regression and fixed with @noble/curves 2.4.0 canonical point, nonidentity/torsion-free checks and explicit zip215:false verification. Fixed dependency and integrity lockfile; no custom cryptographic arithmetic or single-key blacklist.
- Four test P2 sensitivity findings: first signer, first Binding ID only, wrong full-pin resource ID, narrowed inert_content budget/classification. Complete independent expectations and second-item cases now kill all four mutations (one failing regression each).
- New test P2 masking: nonfinal short chunk fixture changed bytes/hash too. The replacement preserves exact signed content and only repartitions bytes; deleting the nonfinal chunk guard now fails it.
- Independent tests also kill strict-mode/identity/torsion guard mutations. The mocked crypto boundary lives in its own suite; real signing/verification remains unmocked.

## Validation

- release-core **605/605** (63 new: 61 real source/assembly + two isolated crypto-boundary tests), domain-contracts **152/152** (nine new structural cases). No skip/todo.
- `TURBO_FORCE=true pnpm check`: PASS, zero cached tasks, final source validation 2026-09-02 ~13:56–13:57 +08. Formatting, lint, workspace, contract checks, typecheck, all unit tests and build pass. Existing test-support lint warnings are non-fatal and unrelated; changed source/test lint is clean.
- `pnpm architecture:gate:test`: **31/31**, skip/todo=0. Core+manifest synchronize the observed 605/152 counts and exact markers; no matcher semantics weakened.
- Independent quality review: 65 extra probes and typecheck passed. Security/performance found no new unbounded caches or data paths; fixed-size curve operations and bounded source/artifact remain enforced.
- No new PostgreSQL integration, clean-checkout executable gate, GitHub CI, host-attested Acceptance or production validation was performed.

## Doc/code audit

Architecture §7.1.5, architecture/testing rules and feedback journal match current fields, bytes, scope and budgets. Independent doc readback DONE: source-only inert_content is explicitly not final CompiledInstructionSkillDescriptor; signer trust provenance/revocation, registry, runtime activation/clipping and host attestation remain excluded. Generic journal wording was tightened to the exact inert_content field. Plan §5 reports only partial T3.2 and observed counts; no task/completion status upgrade. Second pass: none.

## Verdict

Local source increment passes its five-view review and local gates. **Not final closure, publication, public application delivery or host-attested acceptance.**
