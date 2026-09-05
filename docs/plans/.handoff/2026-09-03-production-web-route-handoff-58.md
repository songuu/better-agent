---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md"
checkpoint_number: 58
created: "2026-09-05T14:50:00+08:00"
phase: work
tags: [handoff, sprint]
---

# Sprint Handoff #58: G1-A5 closure and G1-A6 public event projection

## Sprint 状态

- G1-A5 join-only root/child/grandchild execution, settlement and terminalization is complete locally.
- G1-A6 public event projection, service/browser authorization and EventSource cookie session are implemented locally and registered for full-gate verification.
- G1-A7, G1-A8, production deployment and host-attested Acceptance remain open.

## 已完成的 Task

- [x] Added migrations 014–016 for exact join-child execution, billing settlement and terminalization.
- [x] Replaced replica terminalization in the PostgreSQL harness with production functions.
- [x] Registered the G1 join-child suite and migrations in the executable architecture gate.
- [x] Passed repository `pnpm check`, all 14 PostgreSQL suites and the disposable Architecture Gate.
- [x] Added the strict 12-branch public Run event projection contract.
- [x] Added canonical SSE framing, cursor normalization and ordered same-Run replay-batch validation.
- [x] Added the authorization-bound API projection reader and migration 017 immutable public-event storage/readback foundation.
- [x] Added migration 018 with owner-separated safe metadata/private verifier storage and a 60-second single-Run Origin-bound browser session.
- [x] Added service and browser event-stream boundaries plus the dedicated PostgreSQL 16 A6 suite.

## 关键证据

- Architecture Gate result: pass; `cleanBefore=true`, `cleanAfter=true`.
- Source digest: `sha256:2607ac44ee007cb0a10345ffbd2b31179770438c201a76f6da1e9dc697158659`.
- Gate manifest: `sha256:13210011c318ab1f0852bc5504d5bc6fbd4326709ff0b78b442b4e52568c4f88`.
- Pre-G1-A6 totals: Domain 176/176, Release Core 1115/1115, Run Core 131/131, DB 134/134, API 111/111.
- Current G1-A6 totals: API 126/126, Auth 54/54, Domain 190/190, Run Core 146/146 and DB 144/144.
- Real PostgreSQL migration lifecycle passes with 19 production migrations; the dedicated A6 suite also passes.

## 关键决策

1. The internal persistence event and public SSE `run-event/1` have different shapes. The public projection uses `PublicRunEventV1Schema` and is intentionally not added to the domain artifact registry, whose existing entry describes internal persistence.
2. Public events are strict and reject internal Workspace, Release/version, Plan/closure, credential and resource identity fields.
3. SSE business frames use the validated event discriminator and require `id` to equal `data.sequence`; cursors are canonical PostgreSQL bigint strings.
4. Replay batches must be same Run, same accepted request, strictly increasing, all greater than the supplied cursor, and bounded to 1,000 events.
5. No commit, push, upload, production migration or deployment is claimed for G1-A6.

## 当前修改

- Added `packages/domain-contracts/src/public-run-event-v1.ts`.
- Added `packages/domain-contracts/test/public-run-event-v1.test.ts`.
- Added `packages/run-core/src/public-sse.ts`.
- Added `packages/run-core/test/public-sse.test.ts`.
- Exported both new modules from their package indexes.
- Updated G1-A5 documentation and architecture gate inventory/hash/counts before the G1-A6 changes.

## 环境/阻塞

- Docker Desktop is healthy after preserving stale runtime socket directories; no images or volumes were deleted.
- Existing test-support lint baseline remains 9 warnings and 1 info.
- Architecture gate expected Domain/Run test counts now need updating only after the G1-A6 increment stabilizes.

## 下一步

1. Run `pnpm check`, all registered PostgreSQL suites and `pnpm architecture:gate` for the final G1-A6 snapshot.
2. Complete G1-A7 immutable evaluation/promotion evidence.
3. Complete G1-A8 authenticated vertical E2E, then deploy and obtain new host-attested production Acceptance.

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[SSE与异步操作契约]]
