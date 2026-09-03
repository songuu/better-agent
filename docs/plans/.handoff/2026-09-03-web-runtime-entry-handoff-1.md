---
type: sprint-handoff
sprint_doc: "docs/plans/2026-09-03-web-runtime-entry.md"
checkpoint_number: 1
created: "2026-09-03T11:15:00+08:00"
phase: compound
tags: [handoff, sprint, web, deployment]
---

# Web runtime entry handoff 1

## Implemented

- Added the independently startable `@better-agent/web` runtime at `/better-agent/` with fixed static assets and a same-origin health endpoint.
- Added fail-closed request routing, browser security headers, parser/connection bounds and 20 HTTP regressions.
- Added a production-oriented Better Agent application shell without fake persistence or execution actions.
- Added Web build outputs to the immutable deployment artifact checks and froze those requirements in workspace deployment rules.

## Evidence

- Web tests: **20/20**; Web typecheck and lint pass.
- Repository `pnpm check`: pass for **10** workspaces; only the existing test-support **9 warnings + 1 info** remain.
- Architecture gate tests: **31/31**.
- Inline L3 review converged at P0/P1/P2 = 0 for this runtime/build slice.

## Production truth

- The Web process is **not yet running on the production host**.
- Nginx has **not yet been configured** for `/better-agent/`.
- `https://songuu.top/better-agent/` therefore remains unverified/404 and the independent gateway project remains unchanged.

## Next

Add an idempotent managed-service lifecycle and a bounded Nginx include for `/better-agent/`, deploy the accepted release, verify loopback and public health/assets in a browser, then add the gateway card in `E:\project\ai\agent` without disturbing its unrelated dirty changes.
