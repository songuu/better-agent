# better-agent

当前仓库已完成文档级 Gate A，并推进到 G0-05 的本地可执行架构框架。G0-01～G0-04 已建立工作区、契约、迁移和 tenant/auth/principal/assertion/RLS 底座；G0-05 进一步落地 strict Experience/Strategy/Agent/Flow/Deployment/browser-session 契约、唯一 canonical hash/release-core、Agent/Flow stable Deployment 与 typed entry grant、CAS pointer/security epoch、browser session 公私分层，以及不暴露公开 handler 的 API 组合边界。Strategy/Flow/Experience 可在纯核心中生成 prepared command；Agent Release 与 Deployment Revision 在 compiler/closure/change-set 前像尚不可信时拒绝生成发布命令。数据库中的 content-addressed publisher 也只保留给 NOLOGIN owner，`ba_control_executor` 在可由数据库验证的编译/前像证明到位前无执行权限。当前准入只返回 transaction-bound snapshot，不创建 Run 或最终 `authorized=true`；Knowledge、Database、Plugin/MCP、Skill、SubAgent runtime、Run/计费和 G1 执行器仍未实现，G0-08 通过前不能进入 G1。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm db:test:postgres16
```

`pnpm check` 验证静态质量、工作区边界、OpenAPI 生成一致性、领域契约、单元测试、类型检查和构建；`pnpm db:test:postgres16` 需要 Docker，用真实 PostgreSQL 16 验证 000～003 的幂等、migration-history checksum、受审回滚，以及 least-privilege、事务上下文清理、FORCE RLS、默认 publisher deny、测试夹具临时授权后撤销、Deployment CAS/production gate、revoke-race-safe typed service admission、original-Run scope 拒绝、原子 assertion→session exchange、verifier/epoch fence、非空回滚保护与 secret-log 边界。该证据只覆盖本地 disposable PostgreSQL 和无公开路由的组合接口，不代表生产数据库、真实连接池、HTTP/CORS、APM、客户端或部署已经验证。

- [文档索引](./docs/00-INDEX.md)
- [设计冻结入口](./docs/07-实施计划.md)
- [当前任务级实施计划](./docs/plans/2026-08-25-architecture-readiness-and-implementation.md)
- [G0-04 数据库与权限边界](./packages/db/README.md)
- [领域与认证契约边界](./packages/domain-contracts/README.md)
- [Release/Deployment 纯核心](./packages/release-core/README.md)
