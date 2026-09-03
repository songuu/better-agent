# G1-A1 published nested identity validation — 2026-09-03

## Implemented increment

Private recursive executable paths use source + verified closure-derived published
pins. Child closure-local roots remain semantic. Binding, Gate, call declaration
and admission replay use the same graph-bound published identity. Real two-level
Agent→Agent→Flow compilation additionally preserves aggregate child demand while
restricting each call entry to its own invocation operations and old ceiling.

## Local evidence

- Two initial compiled-pin positive regressions failed before implementation.
- 127/127 focused tests, then 1069/1069 full release-core tests in 39 files pass.
- Final owner-substitution pair, with canonical sorting and exact guard assertion,
  passes; TypeScript typecheck passes.
- `pnpm check`: pass (format, lint, workspace, contracts, typecheck, tests, build).
  Existing non-fatal lint warnings remain; no new lint error. Architecture mutation
  tests: 37/37 with zero failed/skipped/todo.
- Full clean-checkout architecture gate: pass, including mutation, no-cache
  quality and all six PostgreSQL 16 suites. `cleanBefore` / `cleanAfter` are true.
  The saved `g1-a1-published-nested-identity-gate-report.json` binds 458 files /
  6,666,075 bytes to source digest
  `sha256:f9de67f8615d73338ab1bf46308479b71af79c4656ea7337998db209f882c65c`.
  The outer runner also verified 89 excluded control-plane files / 967,456 bytes,
  digest `sha256:6c3b0ab1e66b02195601c1a53a06795efbd2fe75db7d7b3d4003a165cf616afd`.
  After the gate, only evidence/control-plane documentation was finalized; runnable
  code remains the tested snapshot. This report is not a host-attested receipt.
- Strict inventory updated to the actual 1069 cases; no skips or production
  capacity limits were added or weakened.

## Review

Independent architecture, performance, security, quality and test reviews pass;
final P0/P1/P2 = 0. The two-level fixture, operation isolation, scoped timeout and
canonically sorted semantic-owner negative address all review findings. Design
lens skipped: no visual change.

## Remaining boundary

This is a necessary T6 prerequisite, not T6 completion. Private final consumers
verify graph commitments and child bytes but cannot independently establish real
registry provenance without source-backed typed readback. Existing G0 publishing
stays paused. Additive closure storage, transactional publication and rejection/
rollback readback still require implementation, followed by the remaining G1 app.
The two-level positive fixture uses generated Agent closures and a schema-verified
Flow closure fixture; it does not establish a completed standalone Flow compiler.

No upload/push/deployment, authority receipt change or existing database mutation.
Unrelated production-web handoffs 50–57 remain untouched.
