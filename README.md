# better-agent

当前仓库已完成文档级 Gate A，并推进到 G0-04 本地可执行底座。G0-01 已建立 Node 22、pnpm、Turborepo、TypeScript、Biome、Vitest 与双平台 CI；G0-02 已具备 OpenAPI/领域 Schema 校验、生成及严格响应兼容基线；G0-03 已具备 PostgreSQL 16 + pgvector 的迁移生命周期测试框架；G0-04 已落地 tenant/auth/principal/assertion/RLS 迁移、Access-Key 与一次性 subject assertion 认证包，以及在路由注册时绑定 reviewed HTTP method、route template、operation、scope 与 policy hash、只返回“凭据阶段通过”的 API 组合边界。Release/Deployment、类型化 entry grant、browser session、Run/计费和业务 runtime 仍未实现，G0-08 通过前不能进入 G1。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm db:test:postgres16
```

`pnpm check` 验证静态质量、工作区边界、OpenAPI 生成一致性、领域契约、单元测试、类型检查和构建；`pnpm db:test:postgres16` 需要 Docker，用真实 PostgreSQL 16 验证 000～002 迁移的幂等、migration-history checksum、受控回滚，以及 least-privilege 角色、同一物理连接上的事务上下文清理、FORCE RLS、凭据 scopes/双 epoch 快照、轮换、verifier 隔离与 assertion replay 防护。该证据只覆盖本地测试环境，不代表生产数据库、连接池、APM、客户端或部署已经验证。

- [文档索引](./docs/00-INDEX.md)
- [设计冻结入口](./docs/07-实施计划.md)
- [当前任务级实施计划](./docs/plans/2026-08-25-architecture-readiness-and-implementation.md)
- [G0-04 数据库与权限边界](./packages/db/README.md)
- [领域与认证契约边界](./packages/domain-contracts/README.md)
