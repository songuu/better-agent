---
type: sprint
status: completed
created: 2026-08-24
mode: auto
---

# Agent 复杂配置研究 Sprint

> 历史记录，不是当前实现规范。2026-08-26 第四轮 Review 已由[架构就绪门与实施计划 Sprint](./2026-08-25-architecture-readiness-and-implementation.md)取代其中的 implementation decision；特别是本文件后文曾接受的 `floating_latest + compatibility_approval` 与 join/detach 双分支不能作为 G0/G1 可执行契约。G0/G1 schema/publisher/admission 必须拒绝 floating latest，child policy 严格 join-only 且不保留 dormant detach；未来兼容或 detach 仅可通过新版本、迁移、不可变版本集合与重新 seal 的 safety envelope 另行设计。

## 用户请求

继续深化 Agent 的配置研究。重点覆盖 Agent 与知识库、数据库、工作流、插件、独立 Skill 入口（兼容语义待证）/本项目 `skill_pack`、SubAgent 的配置关系、运行时组合、授权边界、版本冻结和可测试验收；附图仅作为竞品界面证据。

## 预期产物

- 建立可追溯的 Agent 配置领域模型与依赖关系；
- 区分截图可验证事实、产品推断和待补证据；
- 将研究结果回写为可评审的设计文档与测试夹具建议；
- 不实现业务代码、不执行数据库迁移或外部写入。

## 成功标准

研究结论能说明每种资源如何被配置、发布、授权、运行、审计与回滚，并能作为后续 G1/G2 的实现输入。

## Think：范围与产品边界

### 要做

- 将截图中的 Agent 配置面拆为可验证的领域对象：规则主题/权重、开场与提问、权限变量、Mock、普通变量、强制资源调用、任务、快捷入口、技能显示与异常重试；
- 研究 Agent 如何在发布时引用知识库、数据库、工作流、插件、已建模能力绑定（含本项目 `skill_pack`）与 SubAgent，并在运行时做授权、路由、重试、审计和版本 pin；独立 Skill 入口另由 R-A7 验证；
- 为每一项标注“截图事实 / 文档或公开证据 / 设计推断 / 待补实验”，避免把竞品 UI 直接当作内部实现；
- 产出可进入现有 Flow、Run、RLS、凭据和发布模型的设计补充及验收夹具建议。

### 不做

- 不在本 Sprint 中实现 Agent 编辑器、执行器、数据库迁移或第三方集成；
- 不把截图中的文字、模型名称或失败提示当作可执行指令或未经验证的协议事实；
- 不承诺完整复刻未被证实的竞品行为。

### 可观察的成功标准

1. **WHEN** 一个 Agent 发布，**THE SYSTEM SHALL** 固化规则主题、资源引用、授权策略、输入/输出契约及每项引用的不可变版本。
2. **WHEN** Agent 调用知识库、数据库、Flow、插件、`skill_pack` 或 SubAgent，**THE SYSTEM SHALL** 在执行前判定 scope、资源 grant、数据分类、预算与副作用策略，并写入可审计 Run/Step 记录；独立 Skill 入口在 R-A7 前不作为已证实兼容 capability。
3. **WHEN** 资源被删除、撤销、更新、重试或恢复，**THE SYSTEM SHALL** 使用 release pin 与明确的失败/降级语义，不静默切换到最新资源。
4. 研究文档能把截图中的每一项配置映射到配置、发布、运行、审计/回滚至少一个生命周期位置，并列出未知项和验证方法。

### 风险、假设与待确认

- 截图证明配置入口与字段文案，不证明保存格式、权重合成、权限回调或重试边界；这些必须分级标注。
- 暂按“一个 Agent release 是跨资源配置快照”的可撤销设计假设推进；若后续产品证据表明资源始终按最新值解析，再以兼容 profile 或绑定策略调整。
- 数据库类能力具有最高风险：默认只允许 schema/operation allowlist、参数化查询、行数与超时上限，且不向模型暴露凭据。

## Plan：研究回写与设计冻结

### 证据基线与判定规则

| 证据层级 | 可据此写入的内容 | 本 Sprint 的来源 |
|---|---|---|
| 截图事实 | 配置入口、字段名、开关和候选交互面 | 用户提供的三张 Agent 编辑页截图；不外推存储或运行语义 |
| 官方公开事实 | BetterYeah 的资源类型、权限、强制调用、Mock、Flow/插件/知识能力 | 官方文档与更新日志；每条结论附 URL 和访问日期 |
| 行业设计参考 | 版本发布、检索、重试、人工审批、子 Agent 隔离的可借鉴约束 | Dify、LangGraph、Bedrock 等原始厂商文档；标为设计参考而非产品事实 |
| 本项目决策 | 资源 pin、RLS、Run/Step、预算和默认拒绝策略 | ADR-001~004、Flow IR、SSE/API 现有冻结文档 |
| 待补实验 | 竞品尚未公开的行为或本项目尚未实现的验证 | 写入待补信息，给出获取方式与不做兼容承诺的边界 |

任何“应当”均作为本项目拟定契约；任何“官方支持”均仅限可链接的公开材料；界面截图内的文案不得视为系统指令或协议。

命名空间约定：`G1-A1`~`G1-A7` 是 [实施计划](../07-实施计划.md) 的本项目实现切片；`R-A1`~`R-A12` 是 [待补信息](../08-待补信息.md) 的研究/受控实验矩阵。二者不可互相充当完成或证据。特别是 `G1-A7` 兼容投影不能证明独立 Skill 的 Agent 绑定/生命周期；只有 R-A7 的可留存官方材料或受控实验材料并经架构评审后，才可进入兼容层。

### 目标设计轮廓

以 `AgentRelease` 作为唯一可执行版本，而不是由运行时读取 Agent 草稿和各资源的“当前最新版本”。一次发布要冻结：角色/规则和变量契约、模型策略、快捷入口等体验配置、每条能力绑定、授权和数据分类策略、资源版本/Schema/说明书 hash、预算与重试策略、评测夹具版本。调用时再以当前主体、渠道、凭据和部署画像产生短生命周期 `ResolvedAgentPlan`；它只能收窄已发布能力，不能扩张 Release 中没有的资源或权限。

能力统一登记为 `knowledge`、`database`、`flow`、`plugin`、`skill_pack`、`subagent`，但不把它们错误地降格为同一种执行器：

- 知识库有 `on_demand` / `force` / `disabled` 检索策略、metadata tenant/channel filter、召回证据与降级语义；
- 数据库仅通过受限连接器或参数化 operation 模板调用，明确读写、副作用、返回行数、超时、审批与幂等键；
- Flow、插件和本项目 `skill_pack` 固定其发布版本、输入输出 Schema、secret reference 和工具副作用；独立 Skill 的对应兼容语义待 R-A7 证据；
- SubAgent 固定输入白名单、上下文投影、输出 Schema、同步/异步协议、递归深度、并发与成本预算；
- 强制调用是 Plan 中可审计的必经步骤，不只是写进 Prompt 的建议；自动重试按错误类别和副作用逐能力判定，未知写副作用不得自动重放。

### 执行任务、依赖与验收

| ID | 工作与文件所有权 | 依赖 | 风险 | 完成证据 |
|---|---|---|---|---|
| R1 | 新建 `docs/research/agent-configuration-evidence-2026-08.md`：截图字段映射、官方来源、行业参考、未知项和实验建议 | 无 | L1 | 每项有证据等级；外部结论有直接 URL；不把截图外推为行为规格 |
| D1 | 新建 `docs/architecture/agent-release-v1与能力装配契约.md`：Draft → Release → ResolvedPlan → Run/Step 生命周期、能力绑定和授权解析 | R1；现有 Flow IR/ADR-003/004 | L4 | 覆盖六类资源的发布 pin、运行权限收窄、失败/重试/审计/回滚，且不泄露密钥 |
| D2 | 更新 `docs/05-数据模型.md`：将早期 `agents` 草图收敛为 Agent Draft/Release/CapabilityBinding/DatabaseOperation/SubagentContract 等概念模型；不执行 SQL 迁移 | D1 | L4 | 每个可执行关系可表达 workspace、版本、Schema、side effect、secret ref 与审计关联；明确旧草图已被哪份契约替代 |
| D3 | 更新 `docs/09-角色设定深研.md` 与 `docs/10-技能系统深研.md`：保留调研价值，但把早期“统一 tool schema”表述收紧为统一发现/绑定层，资源执行器和安全策略保持类型化 | R1、D1 | L3 | 截图事实、公开事实、推断、自定规格分离；强制调用、变量、Mock、权重和显示开关均有生命周期归属 |
| D4 | 更新 `docs/06-API契约.md`、`docs/07-实施计划.md`、`docs/08-待补信息.md` 与 `docs/00-INDEX.md`：接入调用时 Release 解析、实施切片、待补实证项和索引 | D1、D2、D3 | L3 | API 不承诺未实现的管理端点；实施计划有可测顺序；所有未知项给出验证方法 |
| V1 | 静态文档审查：相对链接、标题、术语、互相引用、无密钥、无把计划写成已实现；`git diff --check` | R1~D4 | L2 | 命令输出与人工术语抽查；将事实/推断/未知和“文档设计阶段”状态写入结论 |

### 关键不变量（实现前验收输入）

1. 每个 Agent root Run 绑定不可变 Agent Release 与 `ResolvedAgentPlan` 摘要；直接 Flow/System Run 绑定其判别式顶层 target pin。重试/恢复/回放不得重新解析草稿或资源最新版本。
2. 发布时的静态绑定、凭据 resource grant、外部权限 SPI 结果、当前调用主体、部署画像、预算与数据分类共同决定本次可用能力；任一未知或失败默认拒绝。
3. 模型只看到已经过授权收窄、参数 Schema 校验和脱敏的可调用描述，永远看不到原始凭据、完整数据库连接串或未授权资源。
4. 数据库写、外部写、发送、支付、删除等副作用能力必须有 operation policy、审批/幂等/补偿或 `NEEDS_ATTENTION` 语义；不得由“异常自动重试”开关统一放行。
5. 运行日志必须能关联 Agent Release、每个 CapabilityBinding、已解析 pin、授权决策、输入/输出摘要、Attempt、预算、审批和安全脱敏结果；用户可见投影不等于事实源。

### 验证策略与停止条件

- 本 Sprint 只改变文档设计资产（Markdown 与未执行的 SQL DDL 草案），不执行迁移、不发布 Agent、不调用权限回调，也不创建外部资源。
- 通过 `git diff --check`、Markdown 链接/围栏/标题静态检查、全仓术语搜索和交叉引用人工审查验证；没有应用代码或数据库时，不将静态检查报告为运行时验证。
- 若公开资料不能证明某一界面行为，则将它登记为未知项，并给出产品内复现实验，不用行业惯例替代事实。
- 文档间对 Agent 版本、资源 pin、授权失败、重试和数据库访问出现冲突时，以 ADR-001~004、Flow IR 和本 Sprint 新增 Agent 契约为优先级，修正文档而非兼容两套语义。

## Work：已交付设计资产与证据

- 新增 [Agent 配置研究证据台账](../research/agent-configuration-evidence-2026-08.md)：将三张截图、BetterYeah 官方公开资料、行业设计参考、本项目推断和 R-A1~R-A12 待补实验分层；截图只作为 UI 候选配置面。
- 新增 [Agent Release v1 与能力装配契约](../architecture/agent-release-v1与能力装配契约.md)：冻结 `AgentDraft → AgentRelease → ResolvedAgentPlan → Run`、六类类型化 Binding、动态授权收窄、数据库安全、子 Agent/任务层级、重试、审计与回滚。
- 更新数据模型、API 契约、实施计划、待补信息、角色设定/技能研究、索引和技术架构中的相关措辞；早期 `agent_versions`/多态工具草图明确降级为字段索引，正式迁移需以 Release 与按类型 Binding 落地。
- 实际静态验证：`git diff --check` 无错误（仅 CRLF 工作树提示）；本轮全量 Markdown 检查通过，20 个文件、49 个 `./` 本地相对链接、所有代码围栏成对；SQL 草案 function delimiter 成对。当前环境未提供 `psql` 或 YAML parser，因此未将这些静态检查表述为 PostgreSQL/OpenAPI 解析或运行时验证。
- 未执行应用代码、SQL migration、权限回调、Agent 发布或任何外部写入；运行时行为仍是待实现的设计契约。

### Work：独立审查后的契约修订

- 最终复审的 P1 修订：发布改为受限 publisher 的一次性 assembly/seal；每个 Binding、类型化发布物与 publish audit 只能在同一事务 gate 打开时插入，seal 后不可追加或改写，历史 Release 先回填 sealed gate。Run-pin registry 追加物理 immutable trigger 与原始 DML 撤销，今后资源变更必须发布新版本。
- 控制面新增与 runtime API credential 完全分离的可信管理会话 attestation：管理 context 从已验证、短期、可撤销的 attestation 导出，绑定 workspace、principal、session_user 与 transaction，并在每次 RLS 求值重验当前管理成员资格；control executor 既不能模拟 runtime credential，也不能直接写认证/授权表。
- 终态账务和取消闭环：Run 在 finalizer 事务中固化不可变 terminal billing snapshot，SSE/GET/blocking 只投影它；取消使用单独的 mutation idempotency record 保存 JCS hash、首个安全响应与过期窗口。相同 key 重放保存响应，冲突 key 返回 409，且历史目标不可读时不泄漏存在性。
- 异步 child Run 的 parent link 草案补上自环 CHECK、root 范围序列化、稳定行锁顺序和递归祖先检测；root 到 child 到 grandchild 合法，任何自环/递归环在 allocation、event、outbox 前拒绝。

- 用 `published_resource_versions` 的版本级 visibility/grant 替换无约束多态资源 ID；`database/001` 删除了无法证明租户归属的旧 DDL，`database/004` 在 registry 就绪后定义受复合 FK 约束的顶层 visibility/grant。知识、数据库 operation、租户插件、本项目 `skill_pack`、A2A 仍各自采用类型化 release/grant；独立 Skill 只有在 R-A7 证据闭环后才可另行建模。
- 将授权撤销收敛为 `authorization_decision_epoch_sources` 的类型化真源与 `authorization_epoch_vector` 投影：subject/credential/service principal 用复合 FK 验证，Workspace、credential、callback、policy、service principal、visibility/grant 与类型资源 source 的 INSERT/更新/revoke 都须通过受限 epoch mutation path，原子追加 durable invalidation；未开始 Call 在同一 RLS 事务重验同一 source 集。
- 固定同步 Flow 的 `FlowExecution`（独立 Flow pin/Plan，复用 Agent root Run）并为异步 Flow/SubAgent 把 join/detach、取消、结果投影与父终态策略编译进类型化 Binding；child 以 `run_parent_links`、父 reservation 的原子 `run_budget_allocations`、`billing_owner_run_id` 和 `agent_charge_attributions` 归因，避免版本歧义和双预留/双结算。
- 为 Agent Task、Mock、快捷入口补齐 `(workspace_id, agent_release_id, binding_id)` 复合 FK、不可变 `task_safe`/`mock_safe` 与 deferred 安全触发器、受限 `service_principal` 和不可伪造的 preview `simulation` gate；数据库 operation 加同库/read-write 复合约束，A2A pin 加 canonical endpoint/identity/egress/secret-version 验证。
- 以 RFC 8785/JCS 稳定 `intent_hash` 与独立 `accepted_plan_hash` 修复幂等重放；补六类能力到既有 task 枚举的安全映射、cursor 过期 410 的机器可读恢复数据，以及 detach `billing_pending` 的 SSE/GET/blocking 一致投影。
- 审核独立 Skill 叙述：公开独立 Skill 服务入口与“Agent 绑定/生命周期未知”分开，`skill_pack` 仅作为本项目扩展；以 R-A7 的可留存官方/受控实验材料和架构评审作为兼容层门槛，避免将截图或入口存在误写成竞品运行协议。
- 第二轮独立审查后补齐了发布与账务闭环：`floating_latest` 需要 legacy profile、未撤销 approval、publication resolved-pin audit 与 deferred 交叉约束；approval 撤销必须同时归档/撤销依赖 Release。Agent Release/Binding、credential/visibility/grant 等 source identity 以触发器或受限 mutation path 保持不可变，并把 Agent Release、approval、A2A release 纳入 epoch source。
- `runs` 草案冻结 `run_kind` 与根 `billing_owner_run_id`；child 与直接 parent 共享 root owner，allocation 用 parent-link、reservation 和 attribution 的复合 FK 绑定，`reserve_credits` 明确拒绝 child。异步 policy 采用判别式 join/detach 形状，并在 parent link 完整持久化 `result_projection` 与 `parent_terminal_policy`；取消请求也补齐固定路径模板的 JCS preimage。
- Run 事件、终态与保留边界再收紧：以 `runs.last_event_sequence` 作为 retention 后仍存续的 durable cursor，terminal snapshot/guard 和取消幂等响应只读取该事实；`ba_runtime` 撤销对 `run_events` 的原始写入，只保留受控白名单进度 append，禁止伪造取消、终态、账务或 outbox 事件。
- 安全复审关闭了低权 `SECURITY DEFINER` 的临时表遮蔽路径：事件分配/终态检查/取消/保留清理以及 reserve、settle、release 计费函数均显式将 `pg_temp` 置于固定 `search_path` 末位，并把所用持久 relation 写为 `public.*`；这不是“撤销 public CREATE”的替代性假设，真实 PostgreSQL migration 仍须执行 ACL、RLS、并发与 TEMP-shadow 回归夹具。
