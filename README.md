# better-agent

当前仓库已完成文档级 Gate A 以及 G0-01～G0-07 的本地可执行底座。G0-08 的声明式 registry、mutation gate、disposable clean checkout、PostgreSQL 精确清理与冻结 CI schema 已实现，并通过 L4 code-quality、security/integrity、architecture、performance 与 test-strategy 独立复审；最终本机 clean-checkout 重跑证据只写入 `.handoff` 控制面 sidecar，避免回填文字改变已验输入摘要。公开业务 handler、Knowledge/Database/Plugin/MCP/Skill/SubAgent runtime 与 G1 执行器仍未实现；host-attested Acceptance Receipt 未通过前仍不能关闭 G0-08 或进入 G1。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm db:test:postgres16
pnpm architecture:gate
```

`pnpm check` 验证静态质量、工作区边界、OpenAPI 生成一致性、领域契约、单元测试、类型检查和构建；`pnpm db:test:postgres16` 需要 Docker，串行运行六套真实 PostgreSQL 16 harness。`pnpm architecture:gate` 是 G0-08 的唯一聚合入口：clean checkout 直接执行，dirty worktree 则只读取 Git tracked+untracked/non-ignored 当前文件，在系统临时目录生成 content-addressed snapshot 和隔离 Git commit，离线安装依赖后执行相同内部门，并核对源 HEAD/index/status 未变化。它不使用 stash/reset/checkout，不把 unit mock 当作 PostgreSQL 证据，也不允许关键 gate 或测试 skip 放行。该证据仍只覆盖本地或 CI disposable PostgreSQL；不能据此推断生产数据库、真实连接池、HTTP/CORS、APM、客户端、云端或部署已经验证。

- [文档索引](./docs/00-INDEX.md)
- [设计冻结入口](./docs/07-实施计划.md)
- [当前 G0-08 实施计划](./docs/plans/2026-08-31-g0-08-executable-architecture-gate.md)
- [G0-04 数据库与权限边界](./packages/db/README.md)
- [领域与认证契约边界](./packages/domain-contracts/README.md)
- [Release/Deployment 纯核心](./packages/release-core/README.md)
