# better-agent 文档索引

BetterYeah AI 兼容面与私有化平台的文档设计。

证据基线：官方手册全站 60+ 页 + **43 篇更新日志全量**（2024-04-19 → 2026-03-05）+ 3 个产品页。

> 当前阶段：竞品逆向需求基线 + HLD + 局部 LLD + G0 工程底座。2026-08-26 第四轮最终架构 Review 未发现 P0/P1，Gate A 文档冻结通过；G0-01 Monorepo/CI、G0-02 契约工具链（含严格 breaking-response 与 credential-operation-policy 基线）、G0-03 PostgreSQL 测试框架和 G0-04 tenant/auth/principal/assertion/RLS 本地可执行底座已落地。真实 PostgreSQL 16 已通过迁移生命周期与 G0-04 权限/RLS/并发攻击 harness；G0-05 Release/Deployment/typed grant/browser session 及其后续 runtime 仍未实现，G0-08 未通过前不能进入 G1，本地 DDL/API 边界不能表述为已部署能力。

| 文件 | 内容 |
|---|---|
| [01-架构分析-betteryeah.md](./01-架构分析-betteryeah.md) | BetterYeah 全生态逆向分析、缺口清单 |
| [02-页面地图-IA.md](./02-页面地图-IA.md) | 全站页面树、每页区块与控件 |
| [03-功能矩阵.md](./03-功能矩阵.md) | 全量功能清单，按模块 |
| [04-技术架构.md](./04-技术架构.md) | 服务拓扑、技术栈、Monorepo 结构 |
| [05-数据模型.md](./05-数据模型.md) | Postgres DDL、迁移顺序 |
| [06-API契约.md](./06-API契约.md) | REST / SSE / Webhook / MCP / 权限 SPI |
| [07-实施计划.md](./07-实施计划.md) | 设计冻结门、分阶段交付、验收与风险 |
| [api/openapi.yaml](./api/openapi.yaml) | REST operation、Run、取消与 SSE 的机器可读草案 |
| [database/001-租户与凭据.sql](./database/001-租户与凭据.sql) | PostgreSQL 16 租户、RLS、凭据与发布可见性冻结草案 |
| [database/004-运行与计费.sql](./database/004-运行与计费.sql) | PostgreSQL 16 Run、事件、恢复、outbox 与积分冻结草案 |
| [08-待补信息.md](./08-待补信息.md) | 手册截图内缺失项 |
| [09-角色设定深研.md](./09-角色设定深研.md) | 双轨模式 · 四份实证样本 · 七主题权重 · 公开线索与自定安全装配规格 |
| [10-技能系统深研.md](./10-技能系统深研.md) | Plugin/Flow/SubAgent 兼容证据 · 自有 Instruction Skill/Strategy · BetterYeah 独立 Skill 待补实证 · `skill_pack` 扩展 |
| [research/agent-configuration-evidence-2026-08.md](./research/agent-configuration-evidence-2026-08.md) | Agent 编辑页截图、官方公开资料与行业参考的证据分级；明确事实、推断和待补实验 |
| [research/agent-platform-comparison-2026-08.md](./research/agent-platform-comparison-2026-08.md) | Dify、Coze、Flowise、Stack AI、Gumloop 横向证据；Skill/Strategy/Deployment/Credential/HITL/Eval 架构收敛 |
| [adr/001-兼容性与安全默认值.md](./adr/001-兼容性与安全默认值.md) | 兼容边界、secure-by-default 与兼容 profile |
| [adr/002-部署画像与出网边界.md](./adr/002-部署画像与出网边界.md) | 离线、受控出网、部署单元与存储演进 |
| [adr/003-多租户与凭据模型.md](./adr/003-多租户与凭据模型.md) | RLS、租户传播、凭据分级与轮换 |
| [adr/004-持久化执行与计费.md](./adr/004-持久化执行与计费.md) | 运行状态机、幂等、事件、积分与恢复 |
| [architecture/flow-ir-v1与运行时契约.md](./architecture/flow-ir-v1与运行时契约.md) | Flow IR v1、编译/执行/恢复与夹具 |
| [architecture/agent-release-v1与能力装配契约.md](./architecture/agent-release-v1与能力装配契约.md) | Agent/Skill/Strategy/Experience Release、Deployment、类型化能力、凭据收窄、Human Gate、Eval 与 Run 审计 |
| [architecture/agent-runtime-strategy-v1.md](./architecture/agent-runtime-strategy-v1.md) | Agent 主循环 ABI、durable state、model-call attempt、checkpoint、恢复、终止与计费 |
| [architecture/compiled-capability-closure-v1.md](./architecture/compiled-capability-closure-v1.md) | Agent/Flow 嵌套依赖、凭据、出网、数据分类、operation 与副作用上限的 canonical closure |
| [api/SSE与异步操作契约.md](./api/SSE与异步操作契约.md) | SSE 序列、重连、取消、幂等与脱敏 |
| [plans/2026-08-25-architecture-readiness-and-implementation.md](./plans/2026-08-25-architecture-readiness-and-implementation.md) | 当前架构就绪矩阵、A1～A7 修复任务、G0/G1 文件 ownership、依赖、证据与停止条件 |

## G0 本地实施证据

| 切片 | 可执行资产与本地证据 | 明确边界 |
|---|---|---|
| G0-01 | Node/pnpm/Turbo/TypeScript/Biome/Vitest workspace、Windows/Ubuntu CI 定义；`pnpm check` 本机通过 | CI 托管 runner 本轮未执行 |
| G0-02 | OpenAPI 3.1 lint/bundle/types、响应兼容与 operation-policy baseline、不可变 runtime policy registry、领域 Zod registry；11 个 operation / 314 个本地引用通过 | 尚无产品 handler/client |
| G0-03 | 有序 migration runner、checksum ledger、受控 rollback/reapply、隔离 Docker PG16 harness | 不连接开发/生产数据库 |
| G0-04 | 000～002 migration、auth 包、method/route/operation 预绑定的 API auth composition boundary；真实 PG16 权限/RLS/并发/同连接复用攻击集通过 | 只到 route-bound credential phase；G0-05 typed grant/browser session 与生产脱敏证据未完成 |

## 兼容性原则

1. 命名体系照搬 —— Agent / 工作流 / 知识库 / 数据库 / 插件 / MCP服务 / Skill服务 / A2A服务 / 效果观测 / 效果监控 / 数据统计 / 我的空间 / 我的关注
2. 节点类型与变量语法照搬 —— 含「逻辑分支与 Code 节点不加双插值」的双语法
3. 对外 API 路径与响应字段保持兼容 —— `/v1/oapi/agent/chat`、`Access-Key` + `Workspace-Id`、task 事件流
4. 限制值照搬 —— 集中定义在 `packages/shared`
5. 内部安全、租户隔离、凭据、恢复与审计不复刻已知缺陷；G0/G1 只实现 secure，兼容行为只有在未来独立 sealed envelope、migration 与验收门通过后才可开启
6. 手册未公开的实现必须标注为“自定规格”或“推断”，并在实现前转成 ADR、契约和测试夹具

## 前置假设

| 项 | 取值 |
|---|---|
| 交付形态 | 私有化优先；离线安装、气隙运行、受控出网三种画像见 ADR-002 |
| 官方插件 | P4 交付框架 + 8 个，其余按框架增量补 |
| 权限行为 | G0/G1 仅 secure/fail-closed；兼容 profile 只有未来独立 safety envelope、migration 与验收门完成后才可研究启用 |
| 工期 | 原 12 周表为能力库存，设计冻结与最小纵向闭环验收后再重新估算 |

## 两级架构门

### Gate A：进入 G0-01 前的文档冻结门

1. ADR-001 至 ADR-004 的目标决策已接受；后续产品/部署选项有明确最迟决策阶段和 fail-closed 默认值；
2. Agent/Flow/Knowledge/Database/Plugin/Skill/SubAgent、发布、授权、HumanGate、Run/计费的规范链路无开放 P0/P1；
3. OpenAPI、目标 DDL、架构契约和最小纵向/失败夹具均已定义，并明确它们尚未形成运行证据；
4. G0-01～G0-08 的 ownership、依赖、红测、停止条件可执行。Gate A 通过后可以创建 Monorepo、CI 和契约/数据库测试工具链，但不能创建 G1 业务 handler/executor。

### Gate B：G0-08（进入 G1 前的可执行门）

1. OpenAPI 3.1 parse/lint/bundle、生成一致性、breaking 与 example checks 在 CI 通过；
2. PostgreSQL 16 migration/rollback/reapply、RLS catalog、跨租户、连接池复用、临时表攻击、并发账务与权限拒绝夹具通过；
3. 已发布 registry/Deployment/typed grant 先于 Run，版本 pin、credential scope/grant/cardinality 与资源 closure 可独立读回；
4. 最小可执行夹具完成“租户 → 已发布版本 → Run → 持久化事件/账务 → SSE → 审计/回滚”，且故障注入收敛。任一失败则停在 G0。
