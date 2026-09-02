# better-agent

Better Agent 的目标是对标 `ai.betteryeah.com` 的完整 Agent 应用；`E:/project/ai/agent` 只作为服务器部署方式参考。

Gate A 与 G0 底座已完成；G0-08 的 generation 3 host-attested passed Receipt 记录在 [历史验收状态](docs/plans/.handoff/active-sprint.json)，其准入已解除。当前正在实施 [G1-A1 能力内核](docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md)：canonical identity 首个切片已有实现和本地回归，完整 closure/policy/admission、公开业务 handler、Studio 与运行时仍未完成，不能据此宣称应用已上线。历史 Receipt 只覆盖原 subject；原本机 authority 库暂不可回读不自动撤回旧准入，新代码仍须取得自己的完整测试与验收证据。

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
