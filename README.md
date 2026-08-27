# better-agent

当前仓库已完成文档级 Gate A，并推进到 G0-06 的本地可执行事实层框架。G0-01～G0-04 已建立工作区、契约、迁移和 tenant/auth/principal/assertion/RLS 底座；G0-05 落地 strict Experience/Strategy/Agent/Flow/Deployment/browser-session 契约、唯一 canonical hash/release-core、stable Deployment 与 typed entry grant、CAS pointer/security epoch、browser session 公私分层，以及不暴露公开 handler 的 API 组合边界。G0-06 已建立 Run/Conversation/Idempotency/Outbox/HumanGate/计费/归档保留的 closed contracts、纯领域核心、四个隔离 owner 的事实表和 package-private API seam。Strategy/Flow/Experience 可在纯核心中生成 prepared command；Agent Release、Deployment Revision 与首次应用 Run 准入在 compiler/closure/Plan authority 尚不可信时继续 fail closed。数据库中的 content-addressed publisher 和 G0-06 acceptance/finalizer/计费正向原语只保留给 NOLOGIN owner，并仅在 disposable fixture 中验证；公开 handler、dispatcher、Knowledge/Database/Plugin/MCP/Skill/SubAgent runtime 与 G1 执行器仍未实现，G0-08 通过前不能进入 G1。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm db:test:postgres16
```

`pnpm check` 验证静态质量、工作区边界、OpenAPI 生成一致性、领域契约、单元测试、类型检查和构建；`pnpm db:test:postgres16` 需要 Docker，串行运行五套真实 PostgreSQL 16 harness。它验证 000～004 幂等与 checksum、003 catalog 指纹、004 空回退/重应用和非空保护、least-privilege/FORCE RLS、Deployment 与 browser-session fence，以及 G0-06 Flow/Agent Chat 原子 acceptance、Conversation CAS、完整幂等 namespace、账务并发与 reconciliation、terminal 原子回滚、original-Run read/events/cancel、archive/retention allowlist 和真实 `pg_temp` 攻击。所有 owner-only 正向路径只通过 migrator 的事务内 `SET LOCAL ROLE` 夹具执行且不留下临时 ACL。该证据只覆盖本地 disposable PostgreSQL；不能据此推断生产数据库、真实连接池、HTTP/CORS、APM、客户端、云端或部署已经验证。

- [文档索引](./docs/00-INDEX.md)
- [设计冻结入口](./docs/07-实施计划.md)
- [当前 G0-06 实施计划](./docs/plans/2026-08-26-g0-06-run-fact-layer.md)
- [G0-04 数据库与权限边界](./packages/db/README.md)
- [领域与认证契约边界](./packages/domain-contracts/README.md)
- [Release/Deployment 纯核心](./packages/release-core/README.md)
