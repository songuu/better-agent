# Agent 复杂配置证据台账（2026-08）

> **状态：调研基线；不是实现规范。**
> **范围：** 角色主题与权重、开场与推荐、变量/权限/Mock，以及知识库、数据库、Flow、插件、SubAgent、本项目 `skill_pack`、BetterYeah 独立 Skill 入口（仅 R-A7 待补实证）、任务和对话入口。
> **边界：** 用户提供的三张截图证明候选**配置面**存在；它们不能单独证明字段的持久化结构、运行时装配顺序、授权边界、重试算法或外部副作用语义。Dify、Coze、Flowise、Stack AI、Gumloop 的后续对照独立记录在[五平台横向研究](./agent-platform-comparison-2026-08.md)，仅作为设计参考，绝不反推 BetterYeah 的私有实现。

## 1. 证据标记与使用规则

| 标记 | 含义 | 可作为什么依据 | 不可作为什么依据 |
|---|---|---|---|
| **S** | 用户提供截图中可直接观察到的 UI | 页面有该配置入口、可见标签/当前开关状态 | 后端字段、默认值、运行时效果、跨版本行为 |
| **O** | BetterYeah 官方公开文档/更新日志 | 文档明确描述的产品能力 | 未公开的数据模型、算法、优先级或失败处理 |
| **R** | 行业设计参考（Dify/LangGraph/AWS） | 可借鉴的通用设计模式与风险清单 | BetterYeah 的产品事实或兼容性承诺 |
| **D** | 本项目设计推断 | 后续架构设计候选、需评审的契约 | 已实现功能或竞品事实 |
| **U** | 未知项 | 必须通过实验、官方确认或实现评审闭环的风险 | 任何默认假设 |

本台账与 [角色设定深研](../09-角色设定深研.md)、[技能系统深研](../10-技能系统深研.md)、[五平台横向研究](./agent-platform-comparison-2026-08.md) 配合阅读；其中已有的“复刻实现设计”同样应视为 **D**，并受 [Flow IR v1 与运行时契约](../architecture/flow-ir-v1与运行时契约.md)、[ADR-003 多租户与凭据模型](../adr/003-多租户与凭据模型.md)、[ADR-004 持久化执行与计费](../adr/004-持久化执行与计费.md) 的安全和发布约束限制。

编号约定：`R-A1`~`R-A12` 是 [待补信息](../08-待补信息.md) 中的 BetterYeah 研究/受控实验编号，不是本节的 **R**（行业参考）证据标记；`R-P1`~`R-P8` 是五平台导入/架构验证项；`G1-A1`~`G1-A8` 则是 [实施计划](../07-实施计划.md) 的本项目实施切片。特别地，`G1-A6` API/SSE/browser 投影不能代替独立 Skill 的 `R-A7` 证据。

## 2. 截图可验证的候选配置面（S）

### 2.1 逐图观察

| 截图 | 可直接观察到的内容 | 明确不能推出的结论 |
|---|---|---|
| 图 1 | “规则”页有角色、背景、技能、任务、要求、输出格式、限制、红线等主题卡；每卡显示权重（示例为 `0.6`）；有“添加主题”“一键同步”“保存生效”；右侧有效果预览。 | 权重的范围、是否归一化、如何影响 Prompt/工具选择；“一键同步”的方向、冲突解决和发布时机。 |
| 图 2 | 可开关开场白；可配置多个开场提问引导；推荐提问标为“AI 自动生成”；有权限变量、回调地址选择、Mock 模式变量、变量、强制调用（当前显示知识库）和任务的入口/开关。 | 权限回调的请求/响应协议和故障策略；变量作用域；Mock 是否禁止生产；“强制调用”是否每轮、每会话或仅首轮。 |
| 图 3 | 有快捷入口（示例：AI 识图、网页解析）；有“隐藏技能图示”和“异常自动重试”开关。右侧预览显示网页解析一次 `ClientResponseError` 失败。 | 快捷入口是否绕过模型路由；技能图示隐藏的对象范围；重试次数、退避、幂等键；截图中的单次失败不能证明自动重试已发生或失败原因。 |

### 2.2 覆盖矩阵

| 领域 | 截图事实（S） | 应进入后续设计的最小问题（D/U） |
|---|---|---|
| 角色主题/权重 | 多主题、权重、技能一键同步和预览均可见。 | 主题是自由文本还是枚举；权重应编译为可审计 Prompt 渲染规则，不能只保存一个浮点数。 |
| 开场/推荐 | 开场白、开场引导、AI 自动推荐提问是分离区域。 | 它们应版本化为交互文案，不能误作系统指令或授权规则。 |
| 变量 | 普通变量、权限变量、Mock 模式变量有独立入口。 | 必须区分输入/会话/派生/权限/测试变量，明确是否可写入、脱敏和生命周期。 |
| 知识库 | “强制调用”可选知识库。 | 按需检索、强制检索、写入知识库、引用返回和 ACL 过滤是不同能力。 |
| 数据库 | 侧栏可见“数据”；截图本身未展示数据库配置详情。 | 读/写/DDL/导出必须拆成不同动作和风险等级；不可把“数据表描述”当成数据访问授权。 |
| Flow/插件/Skill 入口/SubAgent | 侧栏含插件、工作流、Skill、Agent；截图未展示每类绑定面。 | 兼容层只为已建模的 Flow/插件/SubAgent/`skill_pack` 建立类型化能力绑定；BetterYeah 独立 Skill 须待 R-A7 后再进入兼容模型。本项目通用 `InstructionSkillRelease` 另见五平台研究，不属于截图事实。 |
| 任务 | 有独立“任务”开关。 | 任务是否为异步执行、可否定时、如何投递/回调/取消，不能由开关外观决定。 |
| 快捷入口/隐藏图示/自动重试 | 三个开关或列表项可见。 | UI 可见性、路由策略和执行恢复必须分层，不能让 UI 开关隐式扩大权限或改变幂等语义。 |

## 3. BetterYeah 官方公开事实（O）

| 主题 | 官方公开事实 | 直接来源 | 对本项目的约束，而非反推 |
|---|---|---|---|
| 资源级权限 | 官方权限配置页明确把 SubAgent、知识库、Flow、插件、数据库列为可按用户控制的 Agent 技能资源，并描述以外部权限回调返回可访问资源列表。 | [Agent 权限配置](https://ai-docs.betteryeah.com/%E5%8F%91%E5%B8%83Agent/Agent%E6%9D%83%E9%99%90%E9%85%8D%E7%BD%AE.html) | 本项目必须在请求主体解析后裁剪可用能力；不能只在编辑期做静态勾选。回调协议细节仍属 **U**。 |
| 技能路由 | 官方技能文档说明 Agent 依据对话内容与技能说明/参数信息决定调用；插件描述可预填并可调整，Flow 作为 Agent 技能时需要给出用途和输入描述。 | [技能](https://ai-docs.betteryeah.com/%E6%8A%80%E8%83%BD.html) | “描述 + 输入契约”必须是已发布版本的一部分；不能把只有名称的资源暴露给模型。 |
| Flow 能力 | 官方 Flow 文档列出知识库、模型、代码等组合能力，以及作为 Agent 技能、独立运行、批处理、定时和外部 API 等使用场景。 | [什么是 Flow](https://ai-docs.betteryeah.com/Flow/%E4%BB%80%E4%B9%88%E6%98%AFFlow.html) | Flow 绑定需要固定目标发布版本、输入/输出 schema、预算和副作用声明；不能把 Flow 当作无版本的黑盒工具。 |
| 更新后的技能控制 | 更新日志公开提到批量 Agent 技能、Flow/SubAgent 描述自动化、启停、输出方式与推荐问题等能力。 | [2026-01-15 更新日志](https://ai-docs.betteryeah.com/%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97/2026-01-15%20%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97.html) | 自动生成/同步只能改变草稿，发布后必须形成可审计快照；推荐问题不是授权来源。 |
| 资源覆盖范围 | 更新日志公开表明函数/思考模型场景可涉及插件、工作流、知识库和数据库，并出现知识库异常处理和动态插入等能力演进。 | [2025-03-06 更新日志](https://ai-docs.betteryeah.com/%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97/2025-03-06%20%E6%9B%B4%E6%96%B0%E6%97%A5%E5%BF%97.html) | 知识库、数据库、插件的失败与副作用不能共用一个“重试”布尔值；需逐资源分类。 |

以下是现有本地研究对这些公开材料的归纳，不添加新的产品事实：

- [角色设定深研](../09-角色设定深研.md) 已把主题、变量、开场、推荐问题和权重的未公开实现区分为复刻设计；
- [技能系统深研](../10-技能系统深研.md) 已列出插件、Flow、SubAgent、`skill_pack`、任务与 Mock 的资料线索；
- [数据模型](../05-数据模型.md) 中的早期 Agent 表结构草图不可直接当成最终协议，最终发布/运行边界应服从本轮新增的 Agent release 设计。

## 4. 行业设计参考（R，不反推 BetterYeah）

| 参考 | 可借鉴的公开模式 | 对本项目的限定性结论 |
|---|---|---|
| [Dify Plugin](https://docs.dify.ai/en/develop-plugin/getting-started/getting-started-dify-plugin) | 插件可分为工具、模型、Agent 策略、扩展、数据源、触发器等不同类型；不是所有“插件”都是同一种可调用函数。 | 插件绑定需带 `capability_kind`、schema、凭据/出网策略和副作用分类，不能仅存 URL 或名称。 |
| [Dify Knowledge Retrieval](https://github.com/langgenius/dify-docs/blob/main/en/cloud/use-dify/nodes/knowledge-retrieval.mdx) | 检索节点把选定知识库查询结果作为下游节点上下文，输出包含内容、元数据等结果。 | 强制检索应是确定性的执行步骤，按需检索才是供模型选择的工具；二者都需传入 ACL/过滤条件。 |
| [LangGraph Agent Server](https://langchain-ai.github.io/langgraph/concepts/langgraph_server/) | 持久化资源、运行、检查点与任务队列分离；执行 Worker 与 API 服务器可分开，Redis 仅作短暂协调。 | 采用本项目 ADR-004 的 Postgres 事实源/检查点/事件方案；不因参考而引入 LangGraph。 |
| [LangGraph 重放与幂等](https://langchain-ai.github.io/langgraph/how-tos/state-reducers/) | 恢复会从节点函数开头重跑，副作用必须使用幂等键、upsert 或读前校验。 | “异常自动重试”只有在能力声明为幂等或有补偿时才可自动执行；数据库写、插件写、外部 Flow 回调默认不自动重试。 |
| [Amazon Bedrock Action Groups](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-action-create.html) 与 [Knowledge Bases](https://docs.aws.amazon.com/en_en/bedrock/latest/userguide/knowledge-base.html) | 动作以参数/执行契约建模，知识库可在检索时执行文档级权限过滤。 | 把“工具 schema”和“检索权限过滤”当成首级运行时对象；这不是对任何竞品行为的判断。 |

## 5. 本项目设计推断与候选协议（D）

### 5.1 五层分离

五平台对照后，建议把截图中的编辑内容拆为五种生命周期，避免把 UI、授权、部署和执行混成一张 Agent 表：

1. **Agent/Experience/Skill/Strategy Draft（编辑态）**：执行规则与呈现文案分开保存；允许 AI 生成、同步、预览和 Mock，但都不可公开运行。
2. **不可变 Releases（发布态）**：Agent Release 固定角色、Strategy/Instruction Skill pins、能力/知识 revision、输入输出 schema、说明书 hash 和执行上限；Experience Release 固定开场、推荐、快捷入口和渠道组件。
3. **Agent Deployment Revision（部署态）**：固定 environment/channel 到 Agent/Experience Release、policy profile、入口 scope 和 credential mappings；Save/Publish/Deploy 不共用一个“生效”动作。
4. **Resolved Agent Plan（运行解析态）**：以 Deployment/Release 为上限，交集当前主体/source ACL、实际 credential binding、环境/出网、预算和数据分类；其结果才生成模型目录、强制步骤和运行身份快照。
5. **Run（执行态）**：持久记录 Strategy iteration、Skill activation、Capability Call、Child Run、HumanGate/Checkpoint、Attempt、Event 和 Usage；任何投影都不能反向成为事实源。

这与 [Flow IR v1 的资源 pin](../architecture/flow-ir-v1与运行时契约.md) 和 [ADR-003 的资源 grant/凭据边界](../adr/003-多租户与凭据模型.md) 一致：发布态固定“可候选的版本与 credential requirement”，Deployment 绑定允许的环境策略，运行态再按主体解析实际 credential/grant 并缩减，不能将用户 token 或权限回调结果写回 Release。

### 5.2 统一能力绑定，不抹平资源差异

每个绑定至少应具备：`binding_id`、`kind`、`target_release_pin`、`manual/description_hash`、`input_schema`、`output_schema`、`enabled`、`selection_mode`、`default_parameters`、`visibility`、`data_classification`、`effect_class`、`retry_policy_ref`、`grant_policy_ref`、`budget_policy_ref`。

| 能力 | `selection_mode` 候选 | 额外不可省略字段 | 默认安全立场 |
|---|---|---|---|
| 知识库 | `forced_retrieval` / `model_tool` | 语料 revision、检索配置、过滤器、引用格式、空结果策略 | 运行时按主体 ACL 过滤；强制检索是步骤而不是 Prompt 建议。 |
| 数据库 | `model_tool` / `explicit_workflow_step` | 只读/写入动作、允许的查询模板、参数 schema、行数/导出上限、事务/幂等策略 | 禁止模型自由 SQL、DDL 和无幂等写；表说明只用于路由，不授予数据权限。 |
| Flow | `model_tool` / `forced_step` / `async_task` | Flow release pin、输入输出契约、回调、等待策略、外部副作用声明 | 版本 pin；未知副作用超时进入人工处置而非盲重试。 |
| 插件 | `model_tool` / `forced_step` | provider/tool/schema pin、`CredentialRequirement`、出网/域名策略、操作键支持 | 实际凭据在 Deployment/Run 解析；最小 scope；写操作默认显式确认或幂等键。 |
| BetterYeah 独立 Skill | **U：R-A7 前不定义兼容 capability 或 `selection_mode`** | 官方 Agent 绑定、参数、版本、选择与运行生命周期 | 不能将其假定为插件、Flow、本项目 Instruction Skill 或包；仅在 R-A7 留存官方/受控实验材料并经架构评审后再进入兼容能力模型。 |
| `skill_pack`（本项目扩展） | `bundle_expansion` | 包版本、展开后的内部能力图、冲突优先级 | 仅作为本项目发布态扩展；不得写成 BetterYeah 独立 Skill 的已证实语义。 |
| SubAgent | `delegation_tool` / `forced_step` | 子 Agent release pin、上下文传递模式、最大深度/并发/预算、返回契约 | 只传所需上下文；隔离凭据和资源集合；不能继承父 Agent 的全部能力。 |
| 任务 | `async_task` / `schedule` | 触发器、幂等键、执行身份、通知/回调、取消/过期策略 | 接收 Run 后异步执行；定时/重放按稳定 fire id 去重。 |

### 5.3 UI 字段的归宿

| 截图字段 | 应归属 | 不应影响 |
|---|---|---|
| 角色主题、背景、限制、红线、权重 | Release 中的 Prompt source + 确定性编译规则 | 资源授权、数据库写权限、重试安全性。 |
| 开场白、开场引导、推荐提问、快捷入口 | 独立 Experience Release；Deployment 与 Agent Release 组合校验 | system prompt 的权限边界、已运行任务的能力集合。 |
| 普通变量 | Run 输入 schema 与会话状态 | 凭据、长期授权或未脱敏日志。 |
| 权限变量/回调 | 运行时 Policy Resolver | 已发布 Release 的内容哈希；回调失败时不得扩权。 |
| Mock 变量 | 仅草稿预览/测试环境的注入策略 | 生产 Release 的真实资源或账务事实。 |
| 隐藏技能图示 | 客户端展示投影 | 审计、Run/Step 记录和运维日志。 |
| 异常自动重试 | 每个绑定引用的 retry policy | 不幂等的外部写操作。 |

## 6. 关键未知项与获取方法（U）

完整研究/实验矩阵以 [待补信息](../08-待补信息.md) 的 `R-A1`~`R-A12` 为唯一编号源；下表只说明其中关键未知项如何影响设计，不以它替代实验留存材料。

| 对应实验 | 未知项 | 为什么重要 | 最小验证方法 | 通过标准 |
|---|---|---|---|---|
| R-A1 | 权重的值域、合成与冲突规则 | 影响角色主题是否真的可控。 | 同一 Agent 仅变更一个主题权重，导出/比较请求体、预览与运行日志。 | 能区分 UI 显示、保存载荷、Prompt/运行差异；否则保持为 UI-only。 |
| R-A2 | 变量来源、作用域与覆盖顺序 | 决定输入、会话、权限与测试变量能否安全投影。 | 对同名变量分别从聊天输入、身份、权限回调和保存变量注入，比较请求/错误/重连后的结果。 | 明确来源优先级、缺值/类型错误和持久化边界；否则保持为未知。 |
| R-A3 | 权限回调协议与失效模式 | 决定资源是否可被越权调用。 | 用最小服务返回允许、拒绝、超时、格式错误、跨 workspace 资源等响应并观察行为。 | fail-closed；回调结果与调用日志能关联主体/资源/版本。 |
| R-A4 | Mock 的注入位置和发布边界 | 防止测试数据进入已发布或外部渠道路径。 | 在预览、发布后聊天、API/渠道调用和批量调试中分别运行同一变量。 | 明确真实值/Mock 值的优先级与生产隔离；否则不做 UI 兼容承诺。 |
| R-A5 | 强制知识库与按需知识库的顺序 | 影响 RAG 成本、可解释性和答案依据。 | 以可唯一标记的两个知识库分别配置 forced/on-demand，比较每轮日志和提示词/工具事件。 | 确定是否每轮强制、是否可并存、空结果/失败的处理。 |
| R-A6 | 数据库能力边界 | 直接关系到数据泄漏和破坏性写入。 | 用只读、写、越权表、超大结果、超时五类最小夹具调用。 | 有动作 allowlist、参数化、行数/导出限制、租户过滤和安全失败。 |
| R-A7、R-A12 | Flow/插件/SubAgent 与本项目 `skill_pack` 的版本/schema 绑定、依赖更新/撤销后的解析 | 编辑后是否改变已发布 Agent 的可重复性。 | 发布后修改目标资源，再调用旧 Agent/回滚 Agent，比较目标 revision 和 schema。 | 旧 Release 不漂移；不可兼容变更在发布前拒绝或显式升级。 |
| R-A8 | SubAgent 上下文、授权和预算继承 | 防止递归扩权与 token 失控。 | 分别传完整历史/摘要/当前问题，且给子 Agent 一个父级未授权资源。 | 上下文、能力、深度、预算均可观测且拒绝扩权。 |
| R-A9、R-A11 | 自动重试及快捷入口/隐藏图示的实际语义 | 界面开关很容易被误认为执行协议。 | 记录入口点击后的请求、tool event、用户视图与审计视图，并对可控失败记录重试次数。 | 快捷入口不绕授权；隐藏不删审计；重试服从 effect/idempotency 策略。 |
| R-A10 | 任务的触发、重试和通知 | 防止重复执行/重复扣费。 | 立即、定时、取消、重复 fire、Worker 崩溃后恢复五类测试。 | 每次业务触发仅一个 Run；未知外部副作用进入人工处理。 |
| R-A7 | 独立 Skill 的官方定义及其与插件/Flow 的关系 | 影响数据模型是否需要独立资源类型。 | 查阅对应官方文档、版本更新日志或获得产品方确认；如可创建独立 Skill，再执行 Agent 绑定、发布、更新、撤销黑盒实验。 | 留存官方定义或受控实验材料，明确生命周期、绑定/执行/权限模型，并经架构评审；否则仅保留本项目 `skill_pack` 扩展。 |

## 7. 本轮可作出的结论与不能作出的结论

**可作出的设计结论（D，待实现评审）：**

- Agent 不是单一 Prompt；它是一个由发布快照、资源绑定、运行时授权裁剪和持久化执行共同构成的系统。
- 知识库、数据库、Flow、插件、SubAgent、任务与本项目 `skill_pack` 应共享“能力绑定 + release pin + 审计”的骨架，但保留各自的副作用、输入/输出、授权和重试策略；BetterYeah 独立 Skill 在 R-A7 证实前不属于兼容集合。本项目通用 Instruction Skill/Strategy 是分离的发布资源，不伪装为 Capability Binding。
- “强制调用”“权限变量”“Mock”“隐藏图示”“异常自动重试”必须落在不同控制层，不能靠一个通用开关实现。
- 任何 UI 预览、模型选择或展示开关都不能绕过 [ADR-004](../adr/004-持久化执行与计费.md) 的 Run/Attempt/Step/事件/幂等/人工处置语义。

**本轮不能作出的事实结论：**

- 截图所示产品的具体表结构、API、回调 body、权重算法、自动重试次数/退避、数据库写能力、独立 Skill 定义与内部执行顺序；
- 图中网页解析失败是否已被重试、为何失败、是否与 Agent 配置有关；
- 本项目尚未实现 Agent release、Policy Resolver 或上述任何运行时行为。当前产物仅为文档设计研究。

## 8. 后续文档落点

本台账的 **D/U** 项应驱动一个单独的“Agent release 与能力装配契约”架构文档，并回写到：

- [数据模型](../05-数据模型.md)：Draft、Release、能力绑定、授权决策快照和任务/Run 的关联；
- [API 契约](../06-API契约.md)：发布、测试、调用、运行状态、权限失败与版本冲突；
- [实施计划](../07-实施计划.md)：先落实版本 pin/权限裁剪/运行审计，再扩展 UI 配置；
- [待补信息](../08-待补信息.md)：将第 6 节所有无法从公开证据得到的协议问题作为外部确认或受控实验项。
