# better-agent

Better Agent 的目标是对标 `ai.betteryeah.com` 的完整 Agent 应用；`E:/project/ai/agent` 只作为服务器部署方式参考。产品范围以 [完整应用交付总图](docs/plans/2026-09-02-complete-agent-application-delivery.md) 为准，不能用架构门禁、API 或入口页替代完整应用。

截至 2026-09-13，仓库已有 G0/G1 内核、Web/Studio 与同源产品 API、Agent/Flow/知识库/数据库/插件/Skill Pack/MCP 产品资产，以及迁移 046 的独立异步 SubAgent worker 和迁移 047 的 DeepSeek 模型契约扩展。父 Product Run 仍由 Web 请求处理器执行并等待子 Run；完整父 Run 持久调度、任务中心、对外发布集成与成员治理仍需补齐。当前范围、代码依据和剩余工作见 [交付总图的状态分级](docs/plans/2026-09-02-complete-agent-application-delivery.md#当前状态2026-09-13)。

G0-08 的 generation 3 host-attested passed Receipt 保留在 [历史验收状态](docs/plans/.handoff/active-sprint.json)，[G1 内核计划](docs/plans/2026-09-02-g1-a1-capability-closure-kernel.md) 已记录其本地闭环证据。它们只覆盖当时的源码与测试范围。代码资产存在、本轮检查通过、生产部署验收是三类独立结论；本次文档核对未重跑完整门禁，也未验证当前生产部署。

本轮已完成 BetterYeah 浏览器研究、架构差距校正及 Worker 失权取消修复；最终 `pnpm check` 与门禁自身37项测试通过，真实PG因本机Docker引擎不可用受阻。详见[研究与验证记录](docs/research/betteryeah-browser-architecture-2026-09-13.md)和[后续架构收敛计划](docs/plans/2026-09-13-product-architecture-convergence.md)。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm db:test:postgres16
pnpm architecture:gate
```

`pnpm check` 验证静态质量、工作区边界、OpenAPI 生成一致性、领域契约、单元测试、类型检查和构建；`pnpm db:test:postgres16` 需要 Docker，串行运行 [数据库包脚本](packages/db/package.json) 注册的真实 PostgreSQL 16 harness。`pnpm architecture:gate` 是可执行架构门的聚合入口，库存以 [门禁清单](tests/architecture-gate/manifest.json) 为准：clean checkout 直接执行，dirty worktree 则只读取 Git tracked+untracked/non-ignored 当前文件，在系统临时目录生成 content-addressed snapshot 和隔离 Git commit，离线安装依赖后执行相同内部门，并核对源 HEAD/index/status 未变化。它不使用 stash/reset/checkout，不把 unit mock 当作 PostgreSQL 证据，也不允许关键 gate 或测试 skip 放行。该证据仍只覆盖本地或 CI disposable PostgreSQL；不能据此推断生产数据库、真实连接池、HTTP/CORS、APM、客户端、云端或部署已经验证。

- [文档索引](./docs/00-INDEX.md)
- [设计冻结入口](./docs/07-实施计划.md)
- [历史 G0-08 实施与验收计划](./docs/plans/2026-08-31-g0-08-executable-architecture-gate.md)
- [G0-04 数据库与权限边界](./packages/db/README.md)
- [领域与认证契约边界](./packages/domain-contracts/README.md)
- [Release/Deployment 纯核心](./packages/release-core/README.md)
