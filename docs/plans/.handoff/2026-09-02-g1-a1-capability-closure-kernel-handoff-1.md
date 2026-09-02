---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 1
created: "2026-09-02T11:15:00+08:00"
phase: work
tags: [handoff, sprint]
---

# G1-A1 handoff 1

## Product goal

Implement the complete Agent application modeled on `ai.betteryeah.com`, hosted independently through `songuu.top`. `E:/project/ai/agent` is only the deployment mechanics reference. Do not ask again whether the desired product is a documentation site. The application, API server, Studio and runtime are unfinished; T1 is one implementation slice, not the final deliverable.

## Git and completed work

- Local branch: `codex/g1-a1-closure-identity`.
- Local commit: `84892d96e7146e36910f8a7ea843f6570d397327` (`feat(release-core): add bounded canonical closure identities`).
- T1 implemented: fixed LP UTF-8 byte grammar, full-pin JCS node identity, strict pin/digest format, root owner equality, bounded data snapshot, zero-trap Proxy rejection, actual dense array indices, collision/duplicate checks and bounded per-compilation registry.
- Tests: 56 new identity cases + 33 existing release-core cases = 89 passing; typecheck/lint passing; fresh `TURBO_FORCE=true pnpm check` passed with zero cache reuse; architecture control-plane 31/31, skip/todo zero. Existing nine non-fatal test-support lint warnings unchanged.
- Independent final reviews: quality/architecture, security/performance, test-strategy all pass with no remaining P0/P1/P2. Three stale status paragraphs in README/docs07/G0 plan also reviewed.
- Detailed TDD/fix evidence: [[g1-a1-identity-debug-journal]]. Debug lessons and solution index updated; the repository has no `scripts/sync-solution-index.js`, so no runtime projection renderer was claimed.

## Upload is not complete

`git push --set-upstream origin codex/g1-a1-closure-identity` was rejected by automatic approval before execution. Reason: explicit authorization was required for this batch of private source/docs to the exact GitHub target, notwithstanding the earlier general upload/deploy request. Do not work around the rejection via API, alternate transport or indirect push.

An asynchronous question asked whether the user authorizes pushing this T1 code and implementation records to `github.com/songuu/better-agent`, branch `codex/g1-a1-closure-identity`, and triggering CI. No answer was present at this checkpoint. When authorized, push this branch only, obtain fresh Windows/Linux quality and real PostgreSQL architecture-gate evidence, and record the actual commit/run. No main merge or production deployment was performed.

The successful older CI run `33581446892` is for `a1ce87d133dfaa1edf482ab9935604b7e5a2bd5d`; it is not evidence for commit `84892d9`.

## Admission and environment boundaries

- Historical `.handoff/active-sprint.json` records G0-08 generation 3 host-attested passed, with G1 admission granted. Receipt hash: `sha256:b2f5b229b01162058cd364e06bfcdd2a9b98556392252f304cd9a235f1840668`. Old Receipt/evidence were not changed.
- Do not reintroduce T0 as a hard gate for every pure kernel TDD task. Independent review corrected that over-blocking: a local Docker outage does not revoke historical admission. New source still requires its own complete validation before completion/release.
- Historical verifier `docs/plans/.handoff/verify-g0-08-host-acceptance.cjs` uses original local authority DB `127.0.0.1:55433/tech_persistence`. It currently cannot connect. Temporary forwarding to a different remote DB yielded mismatch, not proof that the original local receipt is invalid. Tunnel is closed; no authority writes occurred.
- Docker stale sockets were preserved by renaming exact stopped runtime directories: `Docker/run.stale-better-agent-20260902`, `docker-secrets-engine.stale-better-agent-20260902`. The second directory was verified to contain only `engine.sock`.
- Docker logs subsequently recorded an external GUI factory-reset action at 02:48 UTC. The agent did not execute it and paused Docker operations, asking the user about concurrent reset. `Docker/wsl/disk/docker_data.vhdx` still exists (8,609,857,536 bytes), but content integrity is unknown. Do not reset/delete/reinitialize original volumes or copy local receipts into a fresh authority DB.
- Production root filesystem remains full; server `/dev/vda3` expansion authorization is still absent. Do not resize it, delete neighboring projects or bypass free-space preflight. Existing independent Better Agent PostgreSQL and old production release were not modified by T1.

## Next work

1. Resolve the exact GitHub push authorization and run CI when permitted; do not treat this as authorization for main merge or deployment.
2. Continue T2 closed, versioned policy vocabulary and narrowing-only meet. Existing `EffectiveCapabilityPolicyV1Schema` embeds arbitrary JSON for egress/budget; `CanonicalEgressRuleV1` and `CanonicalBudgetCeilingV1` are only names in the architecture document, so freeze concrete fields and semantics before implementing.
3. Keep Agent/top-level Flow/embedded Flow admission distinct in T5, and preserve four-fact publishing atomicity fault injection in T6 (review additions already in plan).
4. Follow T2–T6 then G1-A2–A8 and product breadth in docs07. Do not create placeholder closure/UI, runtime latest, shared database credentials or direct-release execution.

No tool sessions or reviewer tasks are left running. This checkpoint does not mark the overall goal complete or blocked.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[2026-09-02-closure-identity-hostile-input]]
- [[g0-08-debug-journal]]
