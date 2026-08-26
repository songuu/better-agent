# Agent 平台横向研究：Dify、Coze、Flowise、Stack AI、Gumloop

> **状态：设计输入，尚未实现**  
> **核对日期：2026-08-24**  
> **适用目标：** 在现有 BetterYeah 兼容研究之上，补充通用 Agent 平台的领域边界、发布治理与运行时契约。  
> **证据标记：** **F** = 官方资料可验证的平台事实；**D** = better-agent 的设计决定；**U** = 公开资料不足、仍需实验或供应商确认。

## 1. 结论先行

现有 `Agent Draft → immutable Agent Release → ResolvedAgentPlan → Run` 主干不需要推倒重来。五个平台的公开资料共同提供了一个需求信号：Agent 不应被缩减为 Prompt、工具列表或一张可变画布。至于“发布时固定装配、运行时按身份收窄、在持久状态机中执行”，这是 better-agent 基于这些事实与反例作出的设计决定（D），并非竞品已经替本项目证明的实现事实。

本轮需要补的不是更多通用 JSON，而是六个一等契约：

1. **Instruction Skill Release**：过程说明、模板、参考资料和可选脚本的版本化内容包；它可以指导模型，但不能自行授予工具或数据权限。
2. **Agent Strategy Release**：控制推理循环、路由和工具选择的执行策略；它不是 Tool，也不是角色 Prompt。
3. **Agent Deployment**：把环境/渠道映射到确定的 Agent Release、Experience Release、策略画像和凭据绑定；“保存”“发布”“部署”必须分离。
4. **Credential Binding Policy**：区分调用者委托凭据、服务主体、团队共享凭据和无凭据调用；Release 只声明需求，Run 才解析实际身份。
5. **Durable Human Gate**：将审批、补充输入、超时和恢复建模为持久任务，而不是让 HTTP/Worker 线程等待。
6. **Evaluation Release Gate**：固定数据集、Evaluator、模型、知识索引和目标 Release；评测重跑追加记录，不覆盖历史，也不替代生产授权。

同时应明确：当前 `skill_pack` 继续只是本项目的**发布打包机制**，不能兼任 Instruction Skill、Tool、Workflow、Agent Strategy 或 SubAgent 的统称。

## 2. 证据方法与边界

- 仅将官方文档、官方仓库、官方发布说明和官方安全公告标记为 **F**；产品博客中的治理能力只证明产品声明，不推定底层事务、租户隔离或 exactly-once 实现。
- 同名概念按产品面隔离。例如 Coze 低代码 Agent 的“技能”入口、Coze Coding 的 `SKILL.md`、Coze 多 Agent 会话交接不是一个运行协议；Dify Classic Agent 与 Beta New Agent 也不是同一运行时。
- “可把 Agent 放进 Workflow”只证明静态组合，不证明运行时动态创建 SubAgent、父子预算、取消传播或无限递归。
- 竞品 Save/Publish、版本历史或 checkpoint 不自动等价于本项目的不可变依赖闭包；凡未公开依赖 pin、恢复事务和凭据快照的部分均保留为 **U**。
- Flowise 已宣布 2026-08-31 EOL，最终版本为 `3.1.4`，官方仓库在 2026-08 归档。因此只把它当作架构样本，不把它选为长期上游依赖或兼容目标。[官方 EOL 公告](https://github.com/FlowiseAI/Flowise/discussions/6727)、[3.1.4 Release](https://github.com/FlowiseAI/Flowise/releases/tag/flowise%403.1.4)

## 3. 五个平台事实矩阵

| 平台 | 构建与执行抽象（F） | 可复用资源（F） | 发布、治理与运行（F） | 限制事实（F）与未知边界（U） |
|---|---|---|---|---|
| Dify | Workflow 面向一次性任务/触发器，Chatflow 面向对话；Classic Agent 节点以 Function Calling/ReAct 迭代；**self-host/Docker Compose 文档面**的 Beta New Agent 是独立应用并可嵌入 Workflow。[Workflow/Chatflow](https://docs.dify.ai/en/cloud/use-dify/build/workflow-chatflow)、[Classic Agent](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)、[New Agent](https://docs.dify.ai/en/self-host/use-dify/build/new-agent/overview) | 插件分为 Tool、Model、Agent Strategy、Extension、Datasource、Trigger；self-host New Agent 支持含 `SKILL.md`、scripts、references 的 Skill 包；知识摄取有独立 Pipeline。[插件类型](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)、[Agent Strategy](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/agent-strategy-plugin)、[New Agent Build](https://docs.dify.ai/en/self-host/use-dify/build/new-agent/build)、[Knowledge Pipeline](https://docs.dify.ai/en/cloud/use-dify/knowledge/knowledge-pipeline/readme) | Chatflow/Workflow 区分 Current Draft、Latest 和 Previous Versions；Human Input 可暂停 Workflow；Tool OAuth 区分管理员客户端配置与每个 Dify 用户对个人账号的授权。[版本控制](https://docs.dify.ai/en/cloud/use-dify/build/version-control)、[Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input)、[Tool OAuth](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/tool-oauth) | **F：** New Agent 仍为 Beta；其导出 DSL 不含 Skill/文件，版本恢复只回滚配置、不回滚 sandbox 环境。**U：** Cloud 是否提供同等 New Agent 能力、已发布应用的外部最终用户能否完成 delegated OAuth，以及完整依赖闭包原子发布、通用持久重试、exactly-once、动态 SubAgent 树均未由本轮资料证明。 |
| Coze | 空间资源库中的资源可供低代码应用和 Agent 使用；应用也可拥有独享资源，而“引入空间资源”会复制资源，并非共享同一实例。Agent、Workflow、Chatflow、App 具有不同会话/批处理语义；多 Agent 主要是独立 Agent 节点之间的条件路由和会话交接。[应用资源管理](https://docs.coze.cn/guides_add_resources_to_project)、[Agent 概览](https://docs.coze.cn/guides_agent_overview)、[Workflow/Chatflow](https://docs.coze.cn/guides_workflow_and_chatflow)、[多 Agent](https://docs.coze.cn/guides_multiagent) | 知识与一等结构化 Database 分离；可从 MCP Server 创建 Coze 插件；部分官方/第三方付费插件可通过 MCP 被外部调用，免费或资源库插件不在该范围。[Database](https://docs.coze.cn/guides_database)、[从 MCP 创建插件](https://docs.coze.cn/guides_create_a_plugin_based_on_mcp)、[调用插件 MCP](https://docs.coze.cn/guides_call_plugin_mcp)；正式 Skill 在扣子编程中开发和部署，使用 `SKILL.md`、scripts、references、assets；部署后当前仅供扣子对话使用，扣子编程创建的低代码 Agent、Workflow、App 暂不支持运行时调用。[Skill 概览](https://docs.coze.cn/guides_skill_overview)、[Skill FAQ](https://docs.coze.cn/guides_skill_faq) | 开启协作模式的低代码 Agent 支持个人草稿、提交、合并、diff、发布历史，但多 Agent 和 AI 生成 Agent 不支持多人协作；Workflow API 运行已发布资源，**资源库 Workflow** 可显式传 `workflow_version`，不传则默认最新，异步模式仅限个人付费版和企业版；Coze Loop 自身提供 trace、评测集、Evaluator 和 Experiment。[协作](https://docs.coze.cn/guides_collaborate_agent)、[Workflow API](https://docs.coze.cn/developer_guides_workflow_run)、[Coze Loop](https://github.com/coze-dev/coze-loop) | **F：** Workflow 评测目前限定已发布的资源库 Workflow，应用内 Workflow 不支持。[评测 Coze Workflow](https://docs.coze.cn/cozeloop_evaluate_coze_workflow) **U：** SaaS、Coze Studio、Coze Coding、Coze Loop 不能互相推定；统一版本图、默认 immutable pin、原子依赖发布、动态 SubAgent、全链路取消或底层 RLS 均未由本轮资料证明。 |
| Flowise | Assistant、Chatflow、Agentflow 是由简到繁的三个构建入口；Agentflow V2 明确区分确定性 Tool/Condition 与模型决策 Agent/Condition，并提供 Loop、Iteration、Execute Flow、Supervisor/Worker 和 Agent as Tool。[Introduction](https://docs.flowiseai.com/)、[Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2) | Document Store 覆盖 Loader、Splitter、Embedding、Vector Store、Record Manager 和 Upsert；Tool、MCP、Custom Function/Node 属不同扩展面。[Document Stores](https://docs.flowiseai.com/using-flowise/document-stores)、[Tools 与 MCP](https://docs.flowiseai.com/tutorials/tools-and-mcp) | Human Input 持久 checkpoint、释放线程并可在重启后恢复；生产建议 Queue + PostgreSQL；支持节点 trace、外部观测和数据集评测。[Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2)、[Queue Mode](https://docs.flowiseai.com/configuration/running-flowise-using-queue)、[Evaluations](https://docs.flowiseai.com/using-flowise/evaluations) | **F：** 公开 API 以稳定 ID 执行可变 `flowData`；项目已宣布 EOL。**U：** 本轮未见不可变 Flow Release，也未确认通用幂等、DLQ、副作用重试与 HITL 并发恢复事务；Redis pub/sub 不被本项目采用为审计事实源，EOL 后不再假设有持续安全维护。 |
| Stack AI | Workflow Builder 是显式节点画布，Agent Builder 以 Tools、Knowledge Bases、Prompt、LLM 等配置构建 Agent；Project 可确定性复用，Subflow Tool 可由 Agent 动态调用，AI Routing 可构成 master-agent 编排。[Platform Overview](https://docs.stackai.com/platform-overview)、[Agent Builder Academy](https://www.stackai.com/academy/agent-builder)、[编排模式](https://docs.stackai.com/hacks)、[Project Node](https://docs.stackai.com/utils/stackai-project-node) | Knowledge Base、业务数据 App、Custom Action、Project/Subflow、带版本的 Anthropic-compatible Skill 分层，并支持连接外部 Custom MCP Server。[Knowledge Base](https://docs.stackai.com/workflow-builder/knowledge-bases/how-to-use-knowledge-bases)、[2026-07 更新](https://www.stackai.com/changelog/july-product-update)、[MCP 更新](https://www.stackai.com/changelog/12-31-2025) | Save 与 Publish 分离；公开资料描述 project lock、版本 diff/rollback 和发布控制；环境能力覆盖 dev/staging/prod；delegated permissions 允许按最终用户认证；另有 trace/replay 和评测产品面。[Governance](https://www.stackai.com/blog/governing-ai-agents-at-scale-how-stackai-keeps-enterprises-in-control)、[SDLC Environments](https://www.stackai.com/changelog/january-product-update)、[Delegated Permissions](https://www.stackai.com/changelog/03-22-2026)、[Platform Overview](https://docs.stackai.com/platform-overview) | **U：** 这些产品表面不能证明底层 secret envelope、原子 dependency manifest、请求级 resolved plan、运行中不漂移、行级租户隔离、child-run 生命周期、队列 lease、幂等和统一成本账本；Subflow 输入兼容策略也未完整公开。 |
| Gumloop | Agent 动态选择工具，Workflow 固定路径；Agent 可进入 Workflow 节点，Workflow 也可作为 Agent Tool。[Agents](https://docs.gumloop.com/core-concepts/agents)、[Workbooks](https://docs.gumloop.com/core-concepts/workbooks) | Brain、Connector/Tool、Skill、Workflow、MCP、Subagent 分层；Skill 是含 `SKILL.md`、scripts/references/assets 的过程包并支持版本 diff。[Brain](https://docs.gumloop.com/core-concepts/brain)、[Skills](https://docs.gumloop.com/core-concepts/skills) | Tool 可按读/写删除设 allow/ask/deny；Subagent 有独立对话、context、sandbox 和后台队列；Run/Audit Log 提供运行观测，checkpoint history 和 Agent version API 提供配置版本/diff 表面，另有 Evaluation 产品面。[Human in the Loop](https://docs.gumloop.com/core-concepts/human_in_the_loop)、[Run Log](https://docs.gumloop.com/core-concepts/run_log)、[Audit Logging](https://docs.gumloop.com/enterprise-features/audit_logging)、[Checkpoint History](https://docs.gumloop.com/core-concepts/checkpoint_history)、[Agent Version API](https://docs.gumloop.com/api-reference/agents/retrieve-agent-version)、[Evaluations](https://docs.gumloop.com/core-concepts/evaluations) | **F：** live checkpoint 保存后影响新运行；Agent version API 早期版本可能 `composition.complete=false`，不含 Skill 文件内容，且只读、不能 restore/deploy；续聊后的新 Evaluation 会替换旧结果，credits 不足时评测可被跳过；共享 Agent 的 credential 存在 personal-default fallback。[Credentials](https://docs.gumloop.com/core-concepts/credentials) **U：** 自改系统指令的完整历史与跨 specialized-agent 链的统一深度上限未由本轮资料证明。这些行为不进入本项目生产默认值。 |

## 4. 必须拆开的资源类型

五个平台最有价值的共同证据，是“可复用能力”内部仍有完全不同的执行与授权语义。better-agent 采用以下分类：

| 类型 | 内容与激活 | 是否直接执行外部动作 | 发布与授权规则（D） |
|---|---|---|---|
| `instruction_skill` | `SKILL.md`、模板、references、可选 scripts/assets；`always`、`model_selected` 或显式选择 | 默认否；脚本只能通过单独受控执行器 | 独立 `InstructionSkillRelease` 和内容 hash；只能引用当前 Agent Release 已绑定的 capability ID，不能带 secret 或扩权。 |
| `agent_strategy` | 推理循环、路由、终止条件、模型/工具选择 | 控制调用但不是业务 Tool | 独立 `AgentStrategyRelease`；固定代码/配置 digest、最大迭代、允许的 Binding 集和 sandbox profile。 |
| `tool/plugin/connector` | 一次类型化操作；MCP 是其中一种 provider/transport | 是，可能有读写副作用 | 固定 provider/tool/schema hash、出网、凭据需求、审批、幂等、预算与每次调用事实。 |
| `flow/subflow` | 确定性或显式条件图，可包含模型节点 | 取决于内部节点 | 固定 Flow Release 与依赖闭包；同步嵌套执行或异步 child Run，不能以名称解析 latest。 |
| `knowledge` | 对固定索引 generation 的只读检索 | 否；摄取/写入另建有副作用的操作 | Source/ingestion 与 retrieval 分离；Agent Binding pin 到可检索 index generation。 |
| `database` | 参数化结构化查询/写操作 | 是 | 独立 operation release、表列行授权、调用身份、结果上限、审批/幂等；禁止模型自由 SQL。 |
| `agent_ref/subagent` | 静态 Agent 节点、会话交接或动态委派 | 间接执行目标 Agent 的能力 | 固定目标 Agent Release；显式上下文投影、深度、调用数、预算、取消和授权再检查。 |
| `skill_pack` | 本项目将上述已发布资源组合成一个装配清单 | 本身不执行 | 仅做发布期展开和依赖锁定；不得作为任何一类资源的兼容别名。 |

由此得到三个不能混淆的“多 Agent”模型：

1. **静态 Agent 图**：Workflow 在确定位置引用 Agent Release。
2. **对话交接图**：路由条件切换当前应答 Agent，但会话/身份/移交记录仍受图约束。
3. **动态委派树**：父 Run 在运行时创建 child Run；必须保留深度、调用数、并发、预算、上下文、取消和授权边界。

Coze 提供了前两类的编排形态，但未证明其中节点固定本项目定义的 immutable Agent Release；Gumloop 提供独立 child interaction 的产品样本；Flowise 只证明 Supervisor/Worker 或模型动态选择**预配置**子 Flow/Worker，未证明独立 child Run 身份、预算、取消或恢复协议。[Flowise Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2)、[Agent as Tool](https://docs.flowiseai.com/tutorials/agent-as-tool) 截至核对日期，本轮资料没有为“无界动态委派”提供可接受的安全契约，因此本项目继续拒绝无上限递归。

## 5. 目标控制面

```text
Authoring Plane
  AgentDraft · FlowDraft · SkillDraft · StrategyDraft · ExperienceDraft
       │ publish/validate/diff
       ▼
Release Plane（全部不可变）
  AgentRelease ─┬─ InstructionSkillRelease pins
                ├─ AgentStrategyRelease pin
                ├─ KnowledgeIndexGeneration pins
                ├─ DatabaseOperation / Tool / Flow / Agent pins
                └─ contract + dependency manifest + compiled_hash
       │ promote
       ▼
Deployment Plane
  AgentDeploymentRevision(environment + channel → AgentRelease + ExperienceRelease)
  FlowDeploymentRevision(environment + entry → FlowVersion)
       → typed admission profile + credential requirement mappings + revoke epoch
       → rollout/rollback record
       │ request/schedule/trigger
       ▼
Resolution Plane
  principal + source ACL + credential grant + deployment policy + budget
       → immutable ResolvedAgentPlan
       │
       ▼
Execution Plane
  Run → Step → CapabilityCall → ChildRun
         └─ HumanGate / Checkpoint / Attempt / Outbox / UsageEvent
       │
       ▼
Observe & Eval Plane
  trace/log/SSE projections · EvaluationRun · promotion evidence
```

关键边界（以下均为 better-agent 设计决定 D）：

- **Agent Release 是执行装配物**，不再承担渠道 UI 和环境凭据的全部生命周期。
- **Experience Release 是呈现装配物**，包含开场白、推荐问题、快捷入口和渠道组件；它与确定的 Agent Release 组合校验后才能进入 Deployment。
- **Deployment/Admission Profile 是公开入口的唯一解析入口**。Agent API token、渠道或 Web UI 先由稳定 Agent Deployment 的 active pointer 解析 revision，再固定 Agent/Experience Release；顶层 Flow 则由判别式 Flow Deployment 固定 Flow Version、entry policy、credential mapping 与 revoke source。两者不能互用 credential，也不能直接执行 Draft、未激活 revision 或 mutable latest。
- **ResolvedAgentPlan 是请求级收窄结果**，保存实际 credential/grant/知识 generation/策略 pin，但永不保存原始 secret。
- **Observe/Eval 是投影和发布证据面**，不成为运行授权或计费事实源。

## 6. 六个缺口的规范补充（D）

本节全部是 better-agent 根据平台事实与负面边界提出的目标契约，仍需通过自有 ADR、迁移、并发测试和故障注入验证；不能把平台的产品表面当作这些事务保证的实现证据。

### 6.1 Instruction Skill 与 Agent Strategy（D）

`InstructionSkillRelease` 至少固定：内容清单、每个文件 hash、入口 `SKILL.md`、解析器版本、依赖/脚本声明、数据分类、上下文预算和签名/来源。Skill 激活只改变允许进入模型上下文的过程说明；它不得：

- 创建 Agent Release 未绑定的 Tool、Flow、Knowledge、Database 或 SubAgent；
- 内嵌原始 secret、连接串、可重放 token 或绕过 schema 的网络调用；
- 在已发布 Agent 内被原地更新；
- 以“脚本存在”为由直接获得平台进程权限。

`AgentStrategyRelease` 至少固定：实现/配置 digest、输入输出 contract、允许模型、允许 Binding IDs、最大迭代/工具调用、终止条件、状态 schema、sandbox/egress profile。策略每次选择、工具请求、终止原因和迭代预算都写入 Step/CapabilityCall；策略只能从 ResolvedAgentPlan 已允许的目录中选择。

### 6.2 Credential Binding Policy（D）

Capability Binding 只声明 `CredentialRequirement`（provider、audience、最小 scopes、数据主体要求），Agent Deployment 或同类型 Flow Admission Profile 再配置允许的解析模式：

| 模式 | 运行主体 | 适用场景 | 必要约束 |
|---|---|---|---|
| `caller_delegated` | 当前最终用户 | 用户个人云盘、邮件、CRM | 每次 Run 按用户 grant 解析；源系统 ACL 必须保留；无授权即拒绝。 |
| `service_principal` | 受限服务身份 | 定时任务、后台同步 | 固定 principal、scope、有效期和任务用途；不得继承发布者个人凭据。 |
| `team_shared` | 经审批的团队凭据 | 共享只读数据或组织应用 | 角色/资源/操作 allowlist、审计 owner、轮换与撤销 epoch。 |
| `none` | 无外部身份 | 纯计算、公开只读工具 | 仍受出网、schema、副作用和预算限制。 |

Release 不固定用户 token；Run/CapabilityCall 固定的是已解析 credential binding ID、身份类型、scope 摘要、版本/指纹和授权 epoch。凭据轮换不改写历史 Release，撤销可以阻止未开始的调用。Stack AI 的 delegated permission 只为“按最终用户认证”提供产品样本，不证明上述完整 binding 协议；Gumloop 的 personal-default fallback 则是本项目明确拒绝的反例：未被 Deployment 显式允许的身份模式必须 fail closed。

### 6.3 Durable Human Gate（D）

Stack AI/Gumloop 的公开资料只证明暂停、审批/拒绝和继续这一产品行为；没有证明下述 Worker 释放、原子提交、幂等恢复和重新授权语义。这些均为自有契约与待验证实现。

`approval="required"` 不能只是一枚布尔字段。持久 Gate 至少包含：`gate_id`、`run_id/call_id`、checkpoint、原 Plan hash、待批准操作的 canonical hash、表单/动作 schema、审批者 policy、渠道、创建/过期时间、状态、决策者与决策摘要。

Gate 状态与 Run 状态不能混为一个枚举。最小映射为：

```text
Gate: PENDING → APPROVED | REJECTED | EXPIRED | CANCELLED
Run:  RUNNING → WAITING_FOR_INPUT | WAITING_FOR_APPROVAL
              → RESUMING → RUNNING
              → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT | NEEDS_ATTENTION
```

- 等待不占用 HTTP 连接、Worker 线程或数据库事务；Checkpoint、Gate 和通知 Outbox 原子提交。
- `resume` 使用幂等 mutation key；并发点击只能有一个决策胜出。
- 恢复固定原 Release/Plan，不解析新版；但必须重新检查审批者权限、credential/resource epoch、预算和待执行副作用是否仍有效。
- 批准绑定 canonical 操作；参数变化、过期或权限收窄必须创建新 Gate，不能复用旧批准。
- 未知送达的外部写操作进入 `NEEDS_ATTENTION`，不能借审批重放来假定第一次未发生。

### 6.4 Agent/Flow Deployment 与 Experience Release（D）

不可变 `AgentDeploymentRevision` 至少固定：环境、渠道、Agent Release、Experience Release、policy profile、credential requirement mappings、入口 scope、变更 diff、创建者和回滚目标；不可变 `FlowDeploymentRevision` 固定环境、公开 entry、Flow Version、Flow policy profile、credential mappings 与 revoke source。二者都不保存可变 active 状态，且 credential kind/scope 不能跨类型复用。稳定 Deployment 的独立 active pointer 是唯一激活事实源；G0 只允许 development/staging，production pointer 必须由不可绕过的 Evaluation Gate 解锁。

这解决三个现有问题：

1. UI 文案/快捷入口调整可发布新的 Experience Release，而不用重编译执行 Agent；Deployment 切换前仍做兼容校验。
2. dev/staging 可以绑定同一执行 Release 的不同受限凭据和出网画像，但不能改变 Release 声明的能力上限；production 只有在 Evaluation Gate 落地并通过后才允许 promotion。
3. 回滚是将 Deployment 指向既有 Release 组合并写审计，不是修改 Release、恢复 Draft 或让运行中请求漂移。

### 6.5 Knowledge Ingestion 与 Retrieval（D）

知识面拆成：

```text
KnowledgeSourceRelease
  → IngestionPipelineRelease(loader/splitter/extractor/embedding)
  → IngestionRun + source ACL snapshot
  → KnowledgeIndexGeneration
  → Knowledge Binding in AgentRelease
```

刷新构建新 generation，验证完整后再切换候选别名；已发布 Agent/已接受 Run 仍使用原 pin。原始文件直入上下文属于另一种受限 `file_input`，不能冒充 RAG，也不能绕过数据分类和上下文预算。数据库连接不作为知识源的隐式替代。

### 6.6 Evaluation Release Gate 与受控自改进（D）

`EvaluationSuiteRelease` 固定 dataset revision、Evaluator revisions、阈值、安全断言、允许的 capability call、成本/延迟上限。`EvaluationRun` 固定 Agent/Flow/Skill/Strategy/model/Knowledge generation 的完整依赖摘要；重跑追加 revision，不覆盖旧评分，预算不足必须显式 `SKIPPED_BUDGET`。Stack AI/Gumloop 的 Evaluator/Evaluation 只作为产品样本；特别是 Gumloop 的替换旧结果和 credits 不足时跳过，构成本项目采用 append-only 与显式跳过状态的负面事实输入，不证明该发布门已经存在。

Gumloop 的自改指令和基于反馈更新过程说明提供了良好交互样本，但生产系统不能让一次 Run 原地修改 published Release。任何反思、自我改进或用户反馈只能产生：

```text
ChangeProposal → Draft diff → static policy checks → EvaluationRun
               → human approval → new immutable Release → Deployment promotion
```

## 7. 保留、吸收、拒绝与延期

| 决策 | 内容 | 理由 |
|---|---|---|
| 保留 | 不可变 Release、运行时授权收窄、类型化 Binding、Postgres Run/Event/Checkpoint/Outbox、受限 child Run | 截至核对日期，本轮纳入的公开资料未发现可替代这些自有契约的完整依赖冻结、恢复、幂等和计费协议；这是检索结论（U），不是对供应商内部实现的绝对否定。 |
| 吸收 | 简化/高级 authoring profile；确定性节点与 LLM 决策节点分离；Instruction Skill 与 Strategy；耐久 HITL；delegated credential；独立 Eval Plane；发布 lock/diff/promotion | 多个平台提供互补的产品行为、需求与反例输入；具体安全契约全部按 D 设计，并由本项目自行验证。 |
| 拒绝 | 可变 live 配置直接服务生产；运行时按名称取 latest；未声明的 personal/team credential fallback；Prompt/LLM 充当 SQL 安全；无界 Agent 链；Redis/SSE 当事实源；Skill/自改指令原地修改发布态；默认开放 stdio/shell/任意包 | 破坏可复现、租户安全、恢复或副作用一致性。 |
| 延期 | 复刻各平台市场、渠道 UI、所有节点；跨平台 DSL 互导；自动灰度；动态 Agent 生成；跨租户 Agent Marketplace | 不是最小可审计闭环所需，且公开协议不足。 |

特别决策：Flowise 只保留为 Agentflow/HITL/Document Store 的研究样本，不加入依赖、兼容范围或迁移承诺。

## 8. 新增验收夹具

1. 修改已发布 Skill/Strategy/Knowledge source 不改变旧 Agent Release、旧 Plan 或恢复中的 Run；升级必须生成新 Release 和依赖 diff。
2. Instruction Skill 试图引用未绑定 Tool、读取 secret、扩展域名或执行未声明脚本时，发布失败。
3. Agent Strategy 只能选择 ResolvedAgentPlan 中已允许的 Binding；达到迭代、调用或预算上限后产生明确终止事实。
4. 同一 Deployment 分别以两个最终用户调用 delegated connector，只能看到各自源 ACL；无授权用户不回退到发布者/团队凭据。
5. service principal 只用于已发布任务，撤销/过期后未开始调用失败；历史审计仍能识别当时身份而不暴露 secret。
6. Worker 在 Human Gate 等待时重启后可恢复；重复/并发批准只执行一次；审批后资源撤销必须阻止副作用。
7. Experience-only 发布不会改变 `compiled_agent_hash`；不兼容快捷入口不能与目标 Agent Release 组成 Deployment。
8. dev/staging/prod promotion 固定相同或显式变更的 Release 组合；回滚不改写历史 Run。
9. KB refresh 生成新 index generation；旧 Release 检索旧 pin，新 Deployment 才能采用新 pin，删除/撤销源后按策略 fail closed。
10. Eval 重跑产生新记录；变更未通过安全/成本/质量阈值时不能 promotion，且评测结果不授予生产资源访问权。
11. 静态 Agent 图、会话交接和动态 child Run 在日志中是三种关系；所有动态调用都受深度、并发、预算和取消上限约束。
12. MCP discovery 变化导致 tool-list/schema hash 不一致时阻断 promotion；Remote MCP 仍受 tool allowlist、出网、凭据和 side-effect policy。
13. 顶层 Flow 需要 service/team credential 时必须命中同类型 Flow Deployment/admission profile；Agent publish credential、无 profile 或错 audience/scope 均拒绝。
14. SubAgent 的 `eligible_history` 只包含允许消息类型、分类上限内且已脱敏的有限轮次；原始 system/tool 内容或整段历史不能进入子 Plan。

## 9. 保留的未知项

| 未知项（U） | 对本项目的影响 | 验证方式 |
|---|---|---|
| BetterYeah 独立 Skill 的真实绑定/发布生命周期 | 继续阻断其兼容 `BindingKind`/`PublishedResourceKind` 映射；不阻断本项目 Instruction Skill | 继续执行 `R-A7` 官方资料/受控黑盒实验。 |
| 各平台发布时是否原子固定 Skill、文件、KB index、子 Flow/Agent 和 credential policy；Stack AI/Gumloop 是否存在请求级 resolved plan 与运行中不漂移保证 | 不采用“竞品也一定 pin”作为设计依据 | 导出发布包并在依赖更新/撤销后重跑旧版本，核对 trace 中实际 revision。 |
| 各平台 Human Gate 等待时是否释放 Worker，以及 Checkpoint/Gate/Outbox 是否原子提交 | 公开“暂停/继续”不作为耐久事务证据 | 观察资源占用，并在各提交点杀 Worker 后核对唯一事实。 |
| 各平台 Human Gate 的 claim、过期、重复 resume、取消竞态和恢复重新授权语义 | 自有状态机必须先有事务/并发夹具 | 对同一 gate 并发 approve/reject/cancel，恢复前撤销凭据和审批权限。 |
| delegated/team/service credential 在子 Flow/SubAgent 中的继承规则 | 默认每一目标重新授权，只允许显式有界委托 | 使用两个用户、两个资源 scope 和父/子组合抓取审计记录。 |
| Coze SaaS、Studio、Coding、Loop 的版本与身份是否统一 | 不跨产品面承诺兼容 | 分别在官方环境导出配置/API/trace，保留产品版本与租户信息。 |
| Stack AI/Gumloop 的 child-run、幂等、队列 lease 和成本结算协议 | 继续采用自有 ADR-004，不猜测内部实现 | 供应商技术确认或受控故障注入。 |
| Flowise EOL 后 Cloud、镜像、文档与漏洞修复的持续时间 | 不引入依赖；仅保留来源快照 | 记录最终 release/commit、安全公告和归档状态。 |

## 10. 对现有文档的落点

- [Agent Release v1 与能力装配契约](../architecture/agent-release-v1与能力装配契约.md)：补充 Instruction Skill、Agent Strategy、Deployment、Credential Binding、Human Gate 和 Eval Gate 的规范边界。
- [实施计划](../07-实施计划.md)：在 G1-Agent 中新增发布/部署、凭据解析、等待恢复和评测门切片，避免等到 UI/生态阶段再补安全模型。
- [待补信息](../08-待补信息.md)：保留 BetterYeah 兼容未知，并新增跨平台依赖闭包、HITL 竞态、凭据委托和产品面差异实验。
- [Flow IR v1](../architecture/flow-ir-v1与运行时契约.md)：后续单独补 `human_gate`、Agent node、Knowledge generation 和 deterministic/LLM routing 节点；本轮不越过当前 Agent 架构设计范围修改 Flow IR。
