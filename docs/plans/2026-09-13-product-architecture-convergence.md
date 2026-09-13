---
title: "产品架构收敛与 BetterYeah 完整功能对齐"
date: 2026-09-13
status: active
tags: [architecture, implementation, parity, acceptance]
---

# 产品架构收敛与 BetterYeah 完整功能对齐

## 本轮决策

继续执行[完整应用交付总图](./2026-09-02-complete-agent-application-delivery.md)，以[本次浏览器证据](../research/betteryeah-browser-architecture-2026-09-13.md)修正遗漏。先把已有 Product Web、G1 内核和 child worker 接成一条可恢复的产品运行链，再在该链上完成真实 Skill 工具包、Flow、资源、发布和治理。保留现有 UI、数据和历史 Release，不另起一套执行系统。

本文件定义后续实施约束；除 S0 的本轮代码修复，其余条目尚未实现。编号 S0～S8 仅属于本计划，不替代历史 G0/G1 编号。新增业务接口、DDL 与版本迁移仍须在各切片实现前形成严格 Schema、测试和架构审查。

## 当前系统与目标差异

仓库当前实现与[部署定义](../deployment.md)包含 `apps/web` Node HTTP 服务、静态 Studio、PostgreSQL 和独立 `apps/worker`；`apps/api` 是组合边界库。本轮未验证生产 worker 状态。目标文档中的 Next.js、Fastify、Redis、向量检索和多服务拓扑不能当作现有部署事实。

产品父 Run 在请求线程执行；046 仅将子 Agent 放入有 lease 的持久队列。Web 进程退出后，不应假设父 Run 会因 child 完成而自行恢复。046 过期 child lease 会收敛为失败，并没有提供任意副作用的自动重放保证。

### S0 · Worker 失权停止执行

**本轮实施范围**：共享模型运行接口传递 AbortSignal；递归和并行执行在调用模型、提交调用收据及继续上层执行前校验取消；Responses transport 合并取消与超时。PostgreSQL 精确 lease conflict 转为类型化失权，其他存储错误继续携带原始上下文上抛。

只在实际数据库 mutation 周围分类存储错误，格式化/预算等运行错误仍写入执行失败。已开始的并行存储操作需要有界收集其错误，不能让一个 lease conflict 掩盖另一笔未知数据库故障；清理等待超时按基础设施故障抛出，不伪装成功或写入业务失败。失权后不能提交完成或启动新模型调用；忽略取消的模型迟到结果不得重新取得写入权。

**边界**：本地取消尽力中止 HTTP；已经被供应商接受的请求及其费用不能保证撤回。该修复不增加父 Run 恢复、不更改 SQL、不新增生产部署结论。最终检查记录与测试数见[本轮研究验证记录](../research/betteryeah-browser-architecture-2026-09-13.md#本轮实现与验证记录)。

**仍需处理的进程边界**：`apps/worker/src/main.ts` 的 `pool.end()` 及现有连接池没有显式连接/查询/关闭时间上限。S0 只保证本次 cycle 的错误清理有界，不能据此承诺整个进程一定按时退出。S1 的连接生命周期验收需补数据库不响应、关闭时仍有查询、服务停止期限与重启后的结果核对。

## 分阶段产品闭环

| 切片 | 依赖 | ownership / 复用资产 | 同时交付的结果 |
|---|---|---|---|
| S1 父 Run 持久执行 | S0 | `apps/web` handler/client、`apps/worker`；复用 `apps/api` admission、`run-core`、数据库事实 | 创建请求原子接受；Worker执行与恢复；Run查询；Web刷新继续观察；取消；错误可恢复说明 |
| S2 产品事件与人工介入 | S1 | G1 public event/session/HumanGate adapters、Studio Chat/Run Console | SSE重放、工具步骤、最终回答；取消与HumanGate claim/resume/timeout；客户端去重 |
| S3 Skill 工具包 | S1，观测接S2 | `instruction-skill`、`release-core` closure/compiler、Product Skill编辑器及store | 包描述/说明/精确成员；发布展开；Agent调用成员；版本与错误收据 |
| S4 Flow执行器完善 | S1，资源成员接S3 | Flow IR、现有Flow编辑/发布、共享model runtime | 首先Start→LLM→Output；再真实分支/循环/批处理；最后隔离代码与多模态节点 |
| S5 知识与数据库 | S1，能力调用接S3/S4 | knowledge/database核心、摄取worker、对象存储与Postgres | 文件/问答/多模态摄取和索引；检索测试；受控读写Operation；资源撤销即时收窄 |
| S6 Deployment与互操作 | S1/S2；授权产品化为前置 | release/deployment/credential/session既有契约、渠道adapter | Agent环境部署、Web授权、API/SDK/Webhook、MCP/A2A双向；渠道输入与身份映射 |
| S7 身份、任务与治理 | 身份可并行；任务依赖S1/S2；治理依赖事件 | auth/RLS、scheduler/outbox、日志/评测投影 | Workspace/成员/角色；一次性/周期任务与投递；反馈/质检/评估器/告警 |
| S8 独立部署验收 | 所需产品切片全部通过 | 现有部署workflow与host acceptance | 同源码CI/PG/浏览器/重启恢复/回滚/备份恢复证据；完整应用验收 |

每个切片按 UI、API、持久化、授权、失败路径、浏览器验收六个维度关闭。提供入口、静态截图或纯核心测试只能关闭对应维度。

## S1/S2 的事务与迁移要求

1. **单一运行身份**：Product conversation/request 映射到唯一 canonical Run，保留现有历史ID可查。准入事务固定 Agent/Flow Release、依赖闭包、principal、预算、输入摘要和请求幂等键，提交 Run+outbox 后才向客户端返回已接受状态。准确接口响应以现有 OpenAPI 版本化演进，不能在此文档暗自更改对外协议。
2. **唯一执行事实**：优先通过显式 adapter 复用现有 `run-core` 与数据库函数；禁止同时维护两个彼此无法验证的 root 状态机。迁移需定义旧 Product pending/completed/failed 到新投影的映射，已完成历史记录不可重写或重新调用模型。
3. **Worker**：领取必须绑定租约与 fence；模型/能力调用、收据、checkpoint、用量和事件在既定事务边界提交。等待 child/HumanGate 时释放执行占用，恢复读取原Plan和checkpoint；不能依赖 Web 内存中的轮询或未等待 Promise。
4. **恢复与外部副作用**：纯计算可以从checkpoint恢复；模型请求已发但结果未知、插件写入已发但回执未知分别建模。只有可证明的幂等调用允许重试；否则进入明确失败/人工处理，不以 HTTP 断连推断调用未发生。
5. **取消竞态**：取消请求、Worker完成和child完成竞争同一事实版本；父取消收窄所有派生执行，旧fence不能写入。重复取消和恢复请求幂等；账务只结算一次。
6. **公开投影**：复用 G1 公开事件白名单和授权绑定 reader。Run内序号、Last-Event-ID、断流后补读、重复事件去重与终态唯一同时测试。SSE不泄露prompt、凭据、内部lease token或未授权的工具返回。
7. **平滑升级**：新handler/worker必须读旧已完成记录；迁移发布顺序、回滚窗口、旧worker识别未知ABI失败关闭均有PG及进程级测试。不存在原子双写方案时，不允许先上线新入口再补事件/恢复。

## S3 的 Skill 语义

| 对象 | 冻结方向 D | 关键约束 |
|---|---|---|
| Instruction Skill | 保留现有指令资源/版本 | 不自行授予工具、凭据或出网权限 |
| Skill Pack Draft | 名称、用途描述、说明、成员与成员用法 | 用严格判别Schema，成员首先支持精确Flow/Plugin，不做万能JSON执行器 |
| Skill Pack Release | 发布期解析并冻结成员Release、输入/输出Schema、参数默认值、依赖manifest和content hash | 同一资源版本出现不同hash、未消歧的重名操作、循环、未安装插件、跨租户或未授权依赖均拒绝；不同精确版本按既有closure pin规则处理 |
| Agent Release | 固定包Release；编译器展开成类型化能力闭包，保留member到包的来源映射 | 不在Run中解析latest；展示层可折叠工具包，执行层仍逐能力授权和计量 |
| Run/Step/Call | 每次调用记录包版本、成员版本、参数摘要、状态与用量 | 子工具输出为不可信数据；撤销只收窄；说明文本不能覆盖平台指令 |

现有039版本继续可读为“仅指令内容的历史版本”；不能无提示给旧Agent添加新工具。若启用工具成员，需要显式新revision和重新发布Agent。产品界面要区分包说明、用途描述、工具Schema和默认值；B06只证明字段存在，具体执行与安全边界采用上述D级规格。

## 必须先于扩展的验收矩阵

| 场景 | 观察点 | 通过条件 |
|---|---|---|
| Web接受后重启 | HTTP、Postgres、Worker、浏览器 | 同Run继续或明确可处理失败，不留无人拥有的pending；客户端刷新可查 |
| 相同请求并发提交 | 准入事务、模型记录、账务 | 单一Run/一次预扣；参数不同而幂等键相同明确冲突 |
| child结束前父进程退出 | child/parent checkpoint、事件 | 恢复原Plan并只消费一次child结果 |
| lease失权且模型迟到 | worker、数据库fence、供应商调用记录 | 不再开启新调用、不写终态、不吞未知存储错误 |
| SSE断线、重复、越权游标 | event reader、浏览器 | 同Run有序补读和去重；不同Run/身份不能读到事件 |
| 取消与完成/人工恢复竞争 | Run/child/HumanGate/结算 | 唯一终态，重复请求幂等，剩余额度正确释放 |
| Skill成员升级或撤销 | Draft/Release/新旧会话/运行trace | 升级不漂移旧Release；撤销阻止后续未授权调用 |
| Flow模型失败/JSON错误/预算不足 | 节点状态、输出Schema、用量 | 明确失败与可诊断步骤；不能静默以模板文本替代模型 |
| 知识更新/删除与查询竞争 | object/index generation、ACL、引用 | 原子切换、引用可追溯；权限撤销不被历史pin绕过 |
| Database写入后断连 | operation幂等键、数据读回、审计 | 不重复写；未知结果显式待核对 |
| 周期任务时区/停机/重复投递 | schedule occurrence key、run、outbox | 固定时区/错过策略；一次发生对应一次Run；通知可重试且不重跑业务 |
| 权限撤销及发布回滚 | principal、grant、deployment、旧会话 | 新准入固定新的有效版本；旧Run不重新解析latest，撤销即时收窄 |

本计划只给出需要绑定的证据，不以测试名称代替真实验证。PG test须运行生产函数，浏览器E2E必须调用真实同源API并读回持久化；模型模拟用于故障测试，真实模型成功须单独标注。

## 尚待参考产品实证

优先完成 R-A7 工具包生命周期、R-A8 子Agent取消/失败、R-A9副作用重试、R-A10调度恢复、R-A12依赖升级传播。需要可用隔离Workspace、纯测试资源与可控无敏感数据的外部服务。当前过期与企业版权益限制不阻断本项目上述安全自定实现，但阻断精确兼容声明；不能自动购买、改变访问权限或把按钮可见当实验完成。
