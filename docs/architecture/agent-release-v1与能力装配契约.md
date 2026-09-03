# Agent Release v1 与能力装配契约

> **状态：契约冻结；G0-02 已实现结构 Schema，publisher/compiler/runtime 尚未实现**
> **适用范围：** `packages/domain-contracts`、`packages/agent-runtime`、`packages/policy`、`packages/run-core`、`packages/flow-engine`、`apps/api`、`apps/worker`
> **关联：** [Agent 配置研究证据台账](../research/agent-configuration-evidence-2026-08.md)、[五平台横向研究](../research/agent-platform-comparison-2026-08.md)、[Flow IR v1](./flow-ir-v1与运行时契约.md)、[Agent Strategy ABI v1](./agent-runtime-strategy-v1.md)、[Compiled Capability Closure v1](./compiled-capability-closure-v1.md)、[ADR-003](../adr/003-多租户与凭据模型.md)、[ADR-004](../adr/004-持久化执行与计费.md)、[API 契约](../06-API契约.md)
> **规范关键词：** **必须**、**不得**、**应**分别表示强制、禁止、建议。

## 1. 目的与证据边界

Agent 不是“角色 Prompt 加一组工具”。它是将可编辑配置、已发布的不可变资源引用、运行时主体授权、预算与副作用约束编译为一次可审计执行的资源编排包。本契约为现有的 Flow `Compile → Plan → Execute → Emit` 链路补上等价的 Agent 层语义。

本文根据公开资料和竞品界面归纳出候选配置面，但不把界面字段、文案或行业惯例当作对方未公开运行协议。BetterYeah 兼容证据见[证据台账](../research/agent-configuration-evidence-2026-08.md)，Dify、Coze、Flowise、Stack AI、Gumloop 的类型与治理对照见[五平台横向研究](../research/agent-platform-comparison-2026-08.md)。本文中“必须”均为本项目的设计决定，不表示已有代码、数据库迁移或外部配置已经实现。

本契约不定义：Studio 的具体页面布局、模型供应商实现、知识检索算法、插件协议细节或人工审批的渠道 UI；它定义这些能力进入 Agent 发布、部署、等待/恢复和运行时必须满足的边界。

## 2. 核心术语与不变量

| 术语 | 含义 |
|---|---|
| Agent | 稳定业务身份（`agent_id`），可有草稿和多个已发布版本；不是可直接执行的配置 JSON。 |
| Agent Draft | Studio 唯一可编辑真源。保存草稿只影响预览，不能改变已发布运行。 |
| Agent Release | 发布时规范化、校验并固化的不可变可执行版本（`agent_release_id`）。本文以 Release 称呼早期草图中的 `agent_versions`。 |
| Capability Binding | Release 中的一条、带类型的能力绑定；它指向一个资源 pin 以及该 Agent 对该资源的局部策略。 |
| Resource Pin | `workspace_id + published_resource_kind + resource_id + resource_version_id + contract_hash` 的不可变解析结果；不包含原始密钥。 |
| Compiled Capability Closure | 由 Agent/Flow 编译器展开所有嵌套 Flow、Skill Pack 和 SubAgent 依赖后产生的 canonical 权限/副作用闭包；运行时只能再收窄。 |
| Instruction Skill Release | 过程说明、模板、references、可选 scripts/assets 的不可变内容包；可以指导模型，但不是 Tool，也不授予资源权限。 |
| Agent Strategy Release | 控制推理循环、路由、工具选择和终止条件的不可变策略；只能在 Release/Plan 已允许的能力上运行。 |
| Experience Release | 开场白、推荐问题、快捷入口和渠道组件的不可变呈现版本；与 Agent Release 分离发布。 |
| Agent Deployment Revision | 将环境/渠道固定到一个 Agent Release、Experience Release、policy profile 和凭据映射的不可变部署版本；稳定 Deployment ID 只指向一个 active revision。 |
| Credential Requirement / Binding | Release 声明调用某能力所需的 provider、audience、scope 和主体类型；Deployment/Run 再将其解析为调用者委托、服务主体或团队共享凭据。 |
| Authorization Decision | 某主体、渠道、凭据、资源和操作在某一时点的服务器端授权结果；用于审计和后续撤销检查，不能由客户端伪造。 |
| Resolved Agent Plan | 接受一次调用时把一个 Release 收窄到该主体、部署画像、预算和授权后的短生命周期计划；它绑定一个 Run。 |
| Capability Call | Run 内对某一 Binding 的一次调用，具有独立 `call_id`、输入/输出摘要、尝试、副作用和父调用关系。 |
| FlowExecution | 同步 Flow Binding 在 Agent root Run 内的嵌套执行；独立固定 Flow pin/Plan，但不把 root Run 改成 Flow Run。 |
| Run Parent Link | 异步 Flow/SubAgent child Run 到直接父 Run/Call 的同 Workspace 因果、结算与取消关系。 |
| Human Gate | Run 内需要补充输入或人工审批时持久化的等待任务；绑定 checkpoint、待执行操作、审批策略、过期和幂等恢复身份。 |

### 2.1 必须保持的全局不变量

1. **不可变执行身份。** 每个 **Agent root Run** 必须绑定一个 `agent_release_id`、其 `compiled_hash` 与一个 `resolved_agent_plan_hash`；顶层 Flow/System Run 则必须绑定各自的已发布 target pin/compiled hash，且不得伪造 `agent_release_id`。`target_kind` 决定这两类判别形状；重试、恢复、SSE 回放和运行日志查询不得重新读取草稿或把引用替换成最新资源。
2. **能力只能收窄。** 运行时可见能力 = Release 静态 Binding ∩ 资源/凭据 grant ∩ 当前主体授权 ∩ 部署画像/数据分类 ∩ 预算。任何一步失败、未知、过期或响应不完整，secure profile 默认拒绝；运行时不得发现 Release 中没有的新资源。
3. **类型不被 Prompt 抹平。** 模型可收到统一的“可调用描述”，但知识、数据库、Flow、插件、`skill_pack`（本项目扩展）和 SubAgent 的执行器、输入验证、权限、副作用、重试、审计和取消语义必须保持类型化；Instruction Skill 与 Agent Strategy 分别属于上下文过程包和推理控制面，不伪装成通用 Tool。
4. **密钥不进入 Agent 上下文。** 原始凭据、数据库连接串、可重放 URL token 和权限回调密钥不得进入 Prompt、Release JSON、compiled hash、Run 事件、SSE、日志或评测夹具；Release 只声明 closed `CredentialRequirementV1`，执行器只得到运行时按主体和 Deployment 解析出的最小 credential handle。
5. **强制不等于放权。** 强制知识检索或强制能力调用只能绕过模型的“是否调用”选择，不能绕过授权、预算、输入 schema、数据分类、审批或副作用策略。
6. **展示不等于事实。** 隐藏技能图标/名称、原样输出、快捷入口和兼容 `tasks[]` 都是投影策略；完整的 Capability Call、授权和失败事实仍必须写入 Run/Step/Event。
7. **公开入口只解析类型化 Deployment。** Agent 渠道、API token、Trigger 和 Web UI 不得直接执行 Draft、mutable latest、未激活 revision 或调用者指定的 Release；接受请求时必须从稳定 Agent Deployment 的唯一 active pointer 固定 revision 及其 Agent/Experience Release 组合。顶层 Flow 不复用 `AgentDeploymentRevisionV1`，而按 [Flow IR v1](./flow-ir-v1与运行时契约.md) 解析独立 `FlowDeploymentRevisionV1/FlowAdmissionProfileV1`；System 若开放公共入口也必须先定义自己的类型化 admission profile。各 active pointer 及其 `activation_epoch` 只参与准入事务，不参与已接受 Run 的 call-time 重验证。
8. **自我改进只产生提案。** 反思、评测、用户反馈或 Agent 自改只能写入 Change Proposal/Draft；任何 published Release 或 active Deployment 都不得被 Run 原地修改。

## 3. 生命周期：Draft → Release → Deployment → ResolvedAgentPlan → Run

```text
Studio 编辑
  AgentDraft + Skill/Strategy/Experience/Flow/Knowledge 等独立 Draft
           │ 保存：仅更新草稿/预览
           ▼
发布校验 ──► immutable Releases + dependency manifest + compiled_hash
           │
           ▼
部署审批 ──► immutable AgentDeploymentRevision
             environment/channel → AgentRelease + ExperienceRelease
                                   + policy profile + credential mappings
           │
           ▼
API / SDK / Trigger / 渠道
  authenticate + resolve active deployment revision + policy narrowing
           │
           ▼
ResolvedAgentPlan + authorization/credential snapshot + credit reservation
           │ 原子创建
           ▼
Run → agent.strategy → skill.activation | capability.call | child Run
           │                                  └─ HumanGate / Checkpoint
           ▼
RunEvent / Step / Checkpoint / Outbox → SSE、兼容 tasks[]、日志和分析投影
```

### 3.1 Draft 的唯一真源与保存语义

- `AgentDraft` 包含角色设定、结构化主题、变量声明、模型偏好、候选 Instruction Skill/Strategy/Capability Binding、Mock 夹具和任务草稿；`ExperienceDraft` 独立保存开场、推荐问题、快捷入口和渠道显示偏好。Draft 可以不完整，不能被公开 API 或定时调度直接调用。
- “保存并生效”在编辑器中只能表示草稿预览生效；若产品需要把草稿立即给内部调试使用，必须创建显式 `preview_run`，并带 `draft_revision`、测试操作者和不可外发标志。它不得复用 published token，也不得替换正式 Release。
- 一次发布从一个确定的 Draft revision 复制并规范化产生一个新 Release。已发布 Release 不得就地修改；对外生效需要创建并提升新的 Deployment revision。回滚只能把稳定 `agent_deployment_id` 的独立 active pointer 指向一个既有可用 revision，并写审计事件；`agent_id` 只表达业务身份，不再兼任环境/渠道部署别名。

### 3.2 Release 的最小外形

下列类型是规范接口，不是现有 TypeScript 或 SQL 定义。所有 JSON 使用 canonical 序列化（键排序、无 UI 临时字段、UTF-8）；`compiled_hash` 为该 canonical 语义内容的 SHA-256。

```ts
type BindingKind =
  | "knowledge"
  | "database"
  | "flow"
  | "plugin"
  | "skill_pack"
  | "subagent";

type PublishedResourceKind =
  | "AGENT_RELEASE"
  | "FLOW_VERSION"
  | "SYSTEM_RELEASE"
  | "KNOWLEDGE_INDEX_GENERATION"
  | "DATABASE_OPERATION_RELEASE"
  | "PLUGIN_TOOL_RELEASE"
  | "SKILL_PACK_RELEASE"
  | "A2A_AGENT_RELEASE"
  | "INSTRUCTION_SKILL_RELEASE"
  | "AGENT_STRATEGY_RELEASE"
  | "EXPERIENCE_RELEASE"
  | "DEPLOYMENT_REVISION";

type SideEffectClass =
  | "safe"                      // 无外部业务写入或可证明无害的可重入操作
  | "requires_key"              // 仅携带稳定 operation key 时可重试
  | "unsafe";                   // 写入/发送/删除等；未知结果绝不自动重放

interface SideEffectPolicy {
  class: SideEffectClass;
  approval: "none" | "required";
  approval_gate_spec_id?: string; // approval=required 时必填；none 时必须缺失
  operation_key_source?: "request" | "generated";
  compensation_contract_hash?: string;
}

interface AgentGateSpecBaseV1 {
  schema_version: "agent-human-gate/1";
  gate_spec_id: string;             // Agent Release 内唯一
  prompt_template_ref: string;
  prompt_template_hash: string;
  decision_schema: JsonSchema;
  decision_schema_hash: string;
  approver_policy_ref: string;
  approver_policy_hash: string;
  expires_after_seconds: number;
  notification_profile_ref?: string;
  notification_profile_hash?: string;
  on_reject: "fail_run" | "cancel_run";
  on_expire: "fail_run" | "cancel_run";
  gate_spec_hash: string;           // SHA-256(JCS(spec excluding this field))
}

type AgentGateSpecV1 = AgentGateSpecBaseV1 & (
  | {
      kind: "input";
      protected_operation_contract_hashes: [];
    }
  | {
      kind: "approval";
      protected_operation_contract_hashes: [string, ...string[]];
    }
);

interface AgentReleaseV1 {
  schema_version: "agent-release/1";
  agent_id: string;
  agent_release_id: string;
  release_number: number;
  source_draft_revision_id: string;
  role: CompiledRoleSetting;
  input_contract: JsonSchema;
  output_contract?: JsonSchema;
  model_policy: ModelPolicyPin;
  strategy: AgentStrategyPinV1;
  gate_specs: AgentGateSpecV1[];
  instruction_skill_bindings: InstructionSkillBindingV1[];
  capability_bindings: CapabilityBindingV1[];
  public_capability_handles: PublicCapabilityHandleV1[];
  task_templates: AgentTaskTemplate[];
  authorization_policy: AuthorizationPolicyRef;
  runtime_limits: AgentRuntimeLimits;
  capability_closure_hash: string;
  compiled_hash: string;
}

interface CapabilityBindingBaseV1 {
  binding_id: string;              // Release 内稳定身份
  enabled: boolean;
  discoverability: "model_selectable" | "forced" | "hidden";
  manual: { description: string; input_description?: string; hash: string };
  input_schema: JsonSchema;
  output_schema?: JsonSchema;
  input_interaction_mode?: "auto" | "form";
  output_handling_mode?: "model_summarize" | "raw" | "structured";
  data_classification: "public" | "internal" | "confidential" | "restricted";
  side_effect: SideEffectPolicy;
  task_safe: boolean;              // 仅 Flow/Plugin，Release 发布后不可变
  mock_safe: boolean;              // 仅无真实副作用、非 database Binding；Release 发布后不可变
  retry: RetryPolicyRef;
  timeout_ms: number;
  budget: BindingBudget;
  credential_requirement?: CredentialRequirementV1;
}

type CapabilityBindingV1 = CapabilityBindingBaseV1 & (
  | {
      kind: "knowledge";
      pin: PublishedResourcePin<"KNOWLEDGE_INDEX_GENERATION">;
      config: KnowledgeBindingConfigV1;
    }
  | {
      kind: "database";
      pin: PublishedResourcePin<"DATABASE_OPERATION_RELEASE">;
      config: DatabaseBindingConfigV1;
    }
  | {
      kind: "flow";
      pin: PublishedResourcePin<"FLOW_VERSION">;
      config: FlowBindingConfigV1;
    }
  | {
      kind: "plugin";
      pin: PublishedResourcePin<"PLUGIN_TOOL_RELEASE">;
      config: PluginBindingConfigV1;
    }
  | {
      kind: "skill_pack";
      pin: PublishedResourcePin<"SKILL_PACK_RELEASE">;
      config: SkillPackBindingConfigV1;
    }
  | {
      kind: "subagent";
      target_kind: "internal_agent";
      pin: PublishedResourcePin<"AGENT_RELEASE">;
      config: SubagentBindingConfigV1;
    }
  | {
      kind: "subagent";
      target_kind: "external_a2a";
      pin: PublishedResourcePin<"A2A_AGENT_RELEASE">;
      config: SubagentBindingConfigV1;
    }
);

interface PublicCapabilityHandleV1 {
  schema_version: "public-capability-handle/1";
  public_handle: string;             // Release 内唯一稳定的公开句柄；不是 binding_id/resource_id，也不是授权凭据
  binding_id: string;
  operation_contract_hash: string;
  input_schema_hash: string;
  allowed_entry_modes: ("experience_shortcut")[];
}

interface InstructionSkillBindingV1 {
  binding_id: string;
  skill_pin: PublishedResourcePin<"INSTRUCTION_SKILL_RELEASE">;
  content_hash: string;
  activation: "always" | "model_selected" | "explicit";
  allowed_capability_binding_ids: string[];
  context_budget_tokens: number;
  priority: number;
  script_mode: "inert";            // G1 固定；不生成 Tool/执行权
}

interface AgentStrategyPinV1 {
  published_resource_kind: "AGENT_STRATEGY_RELEASE";
  strategy_id: string;
  strategy_release_id: string;
  abi_version: "agent-strategy-abi/1";
  implementation_digest: string;
  config_hash: string;
  input_schema_hash: string;
  state_schema_hash: string;
  decision_schema_hash: string;
  observation_schema_hash: string;
  sandbox_profile_id: string;
  allowed_model_policy_hash: string;
  allowed_capability_binding_ids: string[];
  allowed_gate_spec_ids: string[];
  max_iterations: number;
  max_model_attempts: number;
  max_tool_calls: number;
  contract_hash: string;
}

interface CredentialRequirementV1 {
  schema_version: "credential-requirement/1";
  requirement_id: string;
  provider_id: string;
  audience: string;
  required_scopes: [string, ...string[]];
  allowed_principal_modes: [
    "caller_delegated" | "service_principal" | "team_shared",
    ...("caller_delegated" | "service_principal" | "team_shared")[]
  ];
}

interface AsyncChildPolicyV1 {
  schema_version: "async-child-policy/1";
  invocation: "async";
  completion_policy: "join"; // Release 中必须显式；草稿省略时编译为此形状
  cancel_propagation: "cascade";
  result_projection: "safe_summary";
  parent_terminal_policy: "wait_for_settlement";
  terminal_outcome_map: G1JoinChildTerminalOutcomeMapV1;
}

interface G1JoinChildTerminalOutcomeMapV1 {
  schema_version: "g1-join-child-terminal-map/1";
  SUCCEEDED: "PARENT_CALL_SUCCEEDED_CONTINUE";
  FAILED: "PARENT_CALL_FAILED_PARENT_FAILED";
  CANCELLED: "PARENT_CALL_CANCELLED_PARENT_CANCELLED";
  TIMED_OUT: "PARENT_CALL_FAILED_CHILD_TIMED_OUT_PARENT_FAILED";
  NEEDS_ATTENTION: "PARENT_CALL_AND_RUN_NEEDS_ATTENTION";
}

interface PublishedResourcePin<K extends PublishedResourceKind = PublishedResourceKind> {
  workspace_id: string;
  published_resource_kind: K;
  resource_id: string;
  resource_version_id: string;
  contract_hash: string;
  binding_mode: "pinned";
}
```

`BindingKind` 只表示 Agent 如何调用能力，`PublishedResourceKind` 只表示 registry 中不可变发布物的类型；两者不得共用一个枚举。每个 Binding 的目标是上述判别 union，具体唯一映射和传递性依赖规则以 [Compiled Capability Closure v1](./compiled-capability-closure-v1.md) 为准。`INSTRUCTION_SKILL_RELEASE`、`AGENT_STRATEGY_RELEASE`、`EXPERIENCE_RELEASE` 和 `DEPLOYMENT_REVISION` 虽在发布 registry 中，但都不是 Capability Binding，不得因此生成 Tool descriptor。Instruction Skill 也必须以 workspace-scoped、kind-safe 的 `PublishedResourcePin<"INSTRUCTION_SKILL_RELEASE">` 进入 assembly/compiled hash；裸 `skill_release_id`、跨 Workspace UUID 或仅凭 `content_hash` 猜 release 均拒绝发布。

`CapabilityBindingV1` 的根 schema 和每个 `config` schema 都必须是 closed object（JSON Schema `additionalProperties: false` / Zod strict 等价语义），并以 `kind + target_kind + config.schema_version` 选择唯一验证器。错 kind 的 config、未知字段、缺少版本或把某类配置塞入另一类 Binding 都必须在发布前失败，不能由执行器忽略字段或猜默认值。`public_capability_handles` 属于 Agent Release 的不可变公开映射并进入 `compiled_hash`；Experience 只引用 handle，不能把内部 `binding_id`、resource pin 或 operation catalog 暴露为公共入口。

`AgentGateSpecV1` 是 Agent Release assembly 中不可变、closed 的发布期规格；`gate_spec_id` 在 Release 内唯一，decision schema 与 approver policy 都必须携带可读回的精确 hash，notification ref/hash 必须同时存在或同时缺失，`gate_spec_hash` 覆盖 prompt/decision schema、approver policy、expiry、notification、disposition 与受保护 operation allow-set。`SideEffectPolicy.approval="required"` 必须引用同 Release 的 `kind="approval"` spec，且该 Binding 的每个可调用 operation contract hash 都在其 `protected_operation_contract_hashes` 中；`approval="none"` 时引用必须缺失。`AgentStrategyPinV1.allowed_gate_spec_ids` 只能是本 Release spec 的子集。所有 spec/hash、Binding 引用与 Strategy allow-set 都进入 `compiled_hash` 和 Compiled Capability Closure；缺失、重复、hash 不符、错 kind 或未覆盖 operation 都拒绝发布，运行时不得由 Strategy 临时提交 decision schema、approver、expiry、notification 或 disposition。当前 approver policy 的撤销/epoch 仍可收窄 claim，但不能换成另一个 policy 或修改已发布 disposition。

G1 的异步 Flow/SubAgent 只能携带逐字等于 `G1JoinChildTerminalOutcomeMapV1` 的 closed map。child `SUCCEEDED` 使父 Call 以固定 `safe_summary` 成功并允许父 Strategy/Flow 继续；child `FAILED` 使父 Call/Run `FAILED`；child `CANCELLED` 使父 Call/Run `CANCELLED`；child `TIMED_OUT` 使父 Call 以 `CHILD_TIMED_OUT` 失败并使父 Run `FAILED`；child `NEEDS_ATTENTION` 必须使父 Call 与 root Run 一起进入 terminal operator hold `NEEDS_ATTENTION`。publisher、admission、恢复与 finalizer 不接受自定义/缺省映射，也不得用父级 error fallback 覆盖 child 的 `CANCELLED|NEEDS_ATTENTION`。所有 child 终态先持久化并完成 usage/allocation attribution，再由唯一父 finalizer/continuation CAS 投影；重复 child terminal Event 只重放首次投影。

G0/G1 的 `PublishedResourcePin` 只允许 `binding_mode="pinned"`；`floating_latest` 在 schema、publisher、migration 和 admission 均必须以 `FLOATING_BINDING_UNSUPPORTED` 拒绝。未来若确需兼容“最新版本”，必须新增 schema version 和独立、已 seal 的 `CompatibilityVersionEnvelopeRelease`，固定允许版本集合、operation/schema、egress、数据分类、副作用上限、审批与 epoch；向集合加入版本必须产生并审批新 envelope/root Release，不能在运行时把当前 latest 加入既有 closure。

### 3.3 Release 编译与发布校验

`compile(agent_release_id)` 是无网络副作用的纯计算；它至少必须验证：

- 角色设定的变量引用、主题、渲染器版本、权重范围、输入/输出契约和模型策略可确定地编译；未赋值必填变量不能悄然保留 `{{...}}` 原文；
- Agent Strategy 必须满足 [Agent Strategy ABI v1](./agent-runtime-strategy-v1.md)，Instruction Skill 的 release/hash、上下文预算、激活方式和允许的 Binding 集可确定地编译；Strategy 的 `allowed_gate_spec_ids` 必须精确解析到本 Release 的不可变 `AgentGateSpecV1`，并与 spec/hash 一起进入 closure。二者不得引入 `capability_bindings`/`gate_specs` 之外的资源、scope、域名、审批策略或 secret。G1 的每个 Instruction Skill Binding 必须编译为 `script_mode="inert"`；
- 每条 Binding 的资源已发布（除明确允许的租户静态数据资源）、pin、工具/输入输出 Schema、说明书 hash、数据分类、超时和预算有效；`kind/target_kind/config.schema_version` 必须命中唯一 closed config schema，错 kind、未知字段、G0/G1 floating pin 及 G1 DB write/Flow detach/SubAgent detach 均拒绝；Task/Mock 只能以 `(workspace_id, agent_release_id, binding_id)` 回指同一 Release，且 Task 仅能引用 `task_safe=true` 的 Flow/Plugin Binding，Mock 仅能引用 `mock_safe=true` 的非 database、`safe` Binding；快捷入口属于 Experience Release，并在 Deployment 组装时按公开 handle/operation/input schema 精确验证；
- 绑定的资源归属同一 Workspace，或是受控的全局只读目录，并满足 ADR-003 的复合引用/租户边界；
- `skill_pack` 在发布时展开为具体 Binding 与其自身版本 pin；每个 exposed operation 必须编译出唯一 member binding path/pin/operation hash 路由并进入 closure hash，零/多匹配拒绝发布；它不能只是运行时任意 JSON 容器；
- 所有 `subagent` 目标为已发布 Agent Release 或 A2A Agent Release，版本级调用图没有直接或间接循环；最大深度、最大调用数和子预算在父预算范围内，其 bounded delegation 模板也必须被编译而不是一个布尔开关；
- 数据库 Binding 只引用受批准的 connector、不可变 operation release 与其精确 table/schema revision，不能把自然语言或未经验证的原始 SQL 当作可执行资源；
- 强制 Binding 的顺序、输出注入位置、失败降级、重试和审批策略明确；任一强制写副作用必须在发布时被拒绝，除非有显式操作键、同 Release `AgentGateSpecV1` 审批引用和幂等/补偿契约；所有异步 Flow/SubAgent 的 `completion_policy`、`cancel_propagation`、结果投影、父终态策略与 `G1JoinChildTerminalOutcomeMapV1` 必须已显式编译进该 Binding，不能在运行时从宽泛 JSON 或默认值猜测；
- 每个 `CredentialRequirementV1` 只声明 provider/audience/最小 scope/允许主体模式，不能包含用户 token、secret value 或发布者个人凭据；实际凭据映射属于 Deployment，调用时仍必须按主体解析；
- 从 Agent Release 递归展开 Flow/Subflow、Skill Pack、SubAgent 及类型化内部依赖，生成 [Compiled Capability Closure v1](./compiled-capability-closure-v1.md)；任一资源、凭据需求、egress、数据分类、副作用或 operation contract 无法闭合时拒绝发布；
- UI 状态（画布位置、展开折叠、临时预览、未保存 Mock 值）不参与 hash；原始秘密和完整授权响应也不得参与 hash。

编译成功生成 `CompiledAgentRelease`：已排序的 Prompt/上下文片段、不可变 GateSpec/hash 目录、按类型的 Binding 目录、必经步骤、最大预算、所需 scope、数据流/secret 污点摘要、`CompiledCapabilityClosure` 与 `capability_closure_hash`，再以这些语义字段生成 `compiled_hash`。编译失败不得发布，不得产生 Run。

发布是一个不可分割的 assembly，而不是 Release 已可运行后仍可追加 Binding 的过程。唯一受控 publisher 在同一事务创建 Release、一次性写齐 Strategy pin、Instruction Skill Binding、类型化 Capability Binding、公开 handle、Task 和 Mock，验证它们与 canonical compiled hash 一致，登记不可变 Run-pin registry 后 seal。每个发布物的插入都必须持有仅本事务可见的 assembly token；seal 后任何组成与 audit 都不能新增、修改或删除，普通 runtime/control 角色也没有原始表写权限。已有 Release 迁移时先回填 sealed assembly，再启用该 gate。

### 3.4 Experience Release 与 Deployment Revision

体验、环境和凭据不能继续藏在 Agent Release 或 `agent_id -> latest release` 别名里：

```ts
interface ExperienceReleaseV1 {
  schema_version: "experience-release/1";
  experience_id: string;
  experience_release_id: string;
  compatible_agent_id: string;
  source_draft_revision_id: string;
  opening_message?: string;
  recommended_questions: string[];
  quick_entries: {
    quick_entry_id: string;
    label: string;
    public_handle: string;
    operation_contract_hash: string;
    input_schema_hash: string;
    default_inputs: Record<string, JSONValue>;
  }[];
  content_hash: string;
}

type AgentDeploymentChannelV1 = "browser" | "service_api" | "internal_preview";

interface ImmutableDeploymentPolicyPinV1 {
  schema_version: "deployment-policy-pin/1";
  workspace_id: string;
  policy_kind:
    | "deployment_profile" | "entry_grant" | "entry_scope"
    | "oauth_delegation" | "service_principal" | "team_credential";
  policy_id: string;
  policy_version_id: string;
  contract_hash: string;
}

interface AgentDeploymentStableV1 {
  schema_version: "agent-deployment-stable/1";
  workspace_id: string;
  agent_deployment_id: string;
  agent_id: string;
  public_selector: string;
  environment: "development" | "staging" | "production";
  ingress_channel: AgentDeploymentChannelV1;
}

interface AgentDeploymentCredentialMappingBaseV1 {
  schema_version: "agent-deployment-credential-mapping/1";
  requirement_id: string;
  provider_id: string;
  audience: string;
  allowed_scopes: [string, ...string[]];
  credential_policy: ImmutableDeploymentPolicyPinV1;
  mapping_hash: string; // SHA-256(JCS(mapping excluding this field))
}

type AgentDeploymentCredentialMappingV1 = AgentDeploymentCredentialMappingBaseV1 & (
  | {
      principal_mode: "caller_delegated";
      credential_source_kind: "oauth_delegation_policy";
      principal_source: "authenticated_end_user";
    }
  | {
      principal_mode: "service_principal";
      credential_source_kind: "service_principal_policy";
      service_principal_id: string;
    }
  | {
      principal_mode: "team_shared";
      credential_source_kind: "team_credential_policy";
      team_credential_policy_id: string;
    }
);

type AgentServiceApiEntryScopeV1 =
  | "agent:conversation:write"
  | "agent:conversation:read"
  | "agent:run:create"
  | "run:read"
  | "run:cancel"
  | "run:resume"
  | "run:events:read";

interface AgentDeploymentEntryGrantBaseV1 {
  schema_version: "agent-deployment-entry-grant/1";
  entry_grant_id: string;
  workspace_id: string;
  credential_id: string;
  agent_deployment_id: string;
  status: "ACTIVE" | "REVOKED";
  authorization_epoch: number;
  not_before_at?: string;
  expires_at?: string;
  revoked_at?: string;
}

type AgentDeploymentEntryGrantV1 = AgentDeploymentEntryGrantBaseV1 & (
  | {
      credential_kind: "publish";
      principal_mode: "issuer_asserted_end_user";
      entry_audience: "browser_session_exchange";
      ingress_channel: "browser";
      scope: "browser-session:exchange";
      target_cardinality: "exactly_one_agent_deployment";
    }
  | {
      credential_kind: "service_api";
      principal_mode: "credential_service_principal";
      entry_audience: "agent_runtime_api";
      ingress_channel: "service_api";
      scope: AgentServiceApiEntryScopeV1;
      target_cardinality: "exactly_one_agent_deployment";
    }
);

interface AgentDeploymentRevisionV1 {
  schema_version: "agent-deployment/1";
  deployment_kind: "agent";
  workspace_id: string;
  agent_deployment_id: string;
  agent_deployment_revision_id: string;
  agent_id: string;
  environment: "development" | "staging" | "production";
  ingress_channel: AgentDeploymentChannelV1;
  agent_release: PublishedResourcePinV1 & { published_resource_kind: "AGENT_RELEASE" };
  experience_release: PublishedResourcePinV1 & { published_resource_kind: "EXPERIENCE_RELEASE" };
  policy_profile: ImmutableDeploymentPolicyPinV1 & { policy_kind: "deployment_profile" };
  credential_mappings: AgentDeploymentCredentialMappingV1[];
  credential_mapping_hash: string;
  entry_grant_policy: ImmutableDeploymentPolicyPinV1 & { policy_kind: "entry_grant" };
  entry_scope_policy: ImmutableDeploymentPolicyPinV1 & { policy_kind: "entry_scope" };
  allowed_origins?: string[]; // 仅 browser；RFC 6454 canonical HTTPS origin
  browser_client_channels?: ("WEB_SDK" | "DINGTALK_WEB")[]; // 仅 browser
  session_token_audience?: "agent_browser_api"; // 仅 browser
  conversation_contract_hash: string;
  dependency_manifest_hash: string;
  change_set_hash: string;
  revision_contract_hash: string; // SHA-256(JCS(candidate revision excluding this field))
}

interface AgentDeploymentActivePointerV1 {
  agent_deployment_id: string;
  active_revision_id: string;
  activation_epoch: number; // 仅 promotion/rollback CAS 与准入审计
}

interface AgentDeploymentSecurityStateV1 {
  agent_deployment_id: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  revoke_epoch: number;     // 单调安全代次；任何不匹配都永久 fence 旧 Run
}
```

G0-05 的机器输出是 `AgentDeploymentEntryAdmissionSnapshotV1`，不是完整 Run profile。它是 `service_credential | browser_session` 的 closed 判别 union，只保存同一事务锁定的 authenticated principal、literal entry source、唯一 stable Deployment、active revision 与 Agent/Experience full pins、Workspace/credential/grant/session observed epoch、`admission_activation_epoch`、`observed_revoke_epoch`、policy/mapping/dependency hash 与 `snapshot_hash`。它明确禁止 `run_id`、credential material、resolved credential binding、effective policy、closure meet 和 ResolvedPlan。G0-06 才把 snapshot 与 Run/reservation/outbox 同事务持久化；G1-01 再把它与 closure/policy meet 合成为 effective AdmissionProfile/ResolvedAgentPlan。

`publish` grant 只用于 exchange，撤销它只阻止新 session；exchange 成功后，后续 browser admission 的 typed source 是 `browser_sessions` 本身。session 固定 stable Deployment、end-user principal、`WEB_SDK|DINGTALK_WEB` client channel、canonical origin、`agent_browser_api` audience、principal `session_epoch` 与 Deployment observed revoke epoch；任一当前 epoch 失配都永久 fence 旧 session。原 assertion audience、entry audience 与 session token audience 是三个不同字段，不能混用。

- Experience Release 只能通过公开 handle/schema 描述快捷入口，不持有 secret、内部 Resource Pin 或扩权信息；`quick_entries` 的 `public_handle + operation_contract_hash + input_schema_hash` canonical 投影必须进入 Experience `content_hash`。创建 Deployment revision 时，publisher 必须把每个 quick entry 与目标 Agent Release 的唯一 `public_capability_handles[]` 三元组精确匹配，并确认 Binding enabled；缺失、重复、schema 漂移或指向未启用 Binding 都拒绝。公共 handle 不得由客户端解析成内部 ID，入口触发后仍只能走完整 Plan/授权路径。
- `AgentDeploymentCredentialMappingV1` 是 closed 判别 union：`requirement_id` 在一个 Release 内唯一，每个启用 requirement 在 revision 内必须恰好匹配一条 mapping；`provider_id/audience` 必须逐字相等，G0 的 `allowed_scopes` 必须与 `required_scopes` 集合精确相等，`principal_mode` 必须在 requirement allow-set 内，且只允许与其对应的 `credential_source_kind`/immutable policy pin/主体字段组合。重复/缺失 requirement、未知字段、空/额外/缺少 scope、错 provider/audience/principal 组合均拒绝 revision。mapping 只引用 immutable policy version，不保存原始 credential；无凭据能力必须省略 requirement，不得用伪造的 `none` mapping 满足非空需求，也不得把用户委托静默降级为共享凭据。
- stable Agent Deployment 固定 `workspace + agent + environment + ingress_channel + public_selector`；revision 的同名轴必须逐字相等，跨环境或渠道必须创建新 Deployment。browser revision 必须同时给出非空 canonical exact-origin allowlist、非空 client-channel allowlist 与固定 `agent_browser_api` token audience；service/internal revision 禁止这些 browser-only 字段。所有 policy ref 使用同 Workspace immutable typed pin，裸 text ID 不得进入 revision。
- `conversation_contract_hash` 由 canonical 的会话输入变量 schema、允许的 session-state key/value schema 与 history/context serialization ABI 计算，不包含 Prompt 文案、模型、Knowledge generation 或 Capability pin。新建 Conversation 固定当前 active revision 的该 hash；后续**每个未命中幂等事实的新 Chat Run 准入**只有在当前 active revision 的 hash 相等时才可继续，因此同一 Conversation 可以安全跨 Agent Release，但不能被新版本静默按另一套状态结构解释。顺序固定为认证/结构规范化 → 查询并重放 canonical idempotency receipt → 仅 miss 时解析 active revision 并比较 hash → 创建 Run/reservation/outbox。G1 不做自动会话迁移；不相等时在任何副作用前返回 `409 CONVERSATION_REVISION_INCOMPATIBLE`，调用方必须创建新 Conversation。
- Deployment revision 是无可变激活状态的不可变候选物；`revision_contract_hash` 覆盖除自身外的完整 canonical candidate，并作为共享 production promotion key 的 `candidate_revision_contract_hash`。“已创建 revision”不等于“已上线”。稳定 `agent_deployment_id` 的独立 active pointer 是 Agent 公开入口的唯一激活事实源，promotion/rollback 以带 `activation_epoch` 的条件更新切换它，并在同一事务写 promotion audit。`activation_epoch` 只防止并发提升丢失更新并留下准入审计；它不是运行中授权 epoch。旧 revision 永久保留最小依赖摘要。`AgentReleaseV1` 不保存可变 `evaluation_gate/pass` 字段；suite、policy、evidence 与审批状态只存在于候选 revision 对应的共享 production promotion key/decision，避免 Release 与 Deployment 各自成为上线事实源。
- `AgentDeploymentEntryGrantV1` 也是 closed 判别 union，并只绑定稳定 `agent_deployment_id`、不绑定 revision。合法组合只有：`publish + issuer_asserted_end_user + browser_session_exchange + browser + browser-session:exchange`，或 `service_api + credential_service_principal + agent_runtime_api + service_api + AgentServiceApiEntryScopeV1`；管理 preview 身份不写入该 grant。数据库复合约束/受限写函数与 admission parser 必须同时逐字验证 credential kind、principal、audience、channel、scope 和目标 Deployment kind，未知值或交叉组合 fail closed，不能仅靠 API 分支。OpenAPI 的 `deployment_publish|agent_invoke` 只是 operation purpose，不是持久化 profile。每次入口按当前 credential、audience、channel 与所需 scope 统计有效 grant 指向的 **distinct Agent Deployment**，必须恰好一个；同一 Deployment 的多条 scope 行不构成多目标，零个拒绝，多个返回 target ambiguous。准入事务随后原子读取 active pointer 并固定 `deployment_revision_id`。promotion 后 credential 默认继续有效但受新 revision 的入口策略重新检查。若将来需要 revision-specific token，必须定义另一种 credential kind，不能复用 publish token。
- 只有显式的内部 preview/test 路径可指定未激活 revision；它使用管理身份和隔离的非生产 credential mapping，不能从公开 Chat、渠道或 Trigger 绕入。已接受 Run 固定原 `deployment_revision_id + agent_release_id + experience_release_id`，切换 active pointer 不影响其恢复。若需立即禁止旧 Run 的后续能力调用，只能修改稳定 Deployment 的 `status` 并递增 `revoke_epoch`；这个独立安全操作只能收窄，不能让旧 Run 改用新 revision。
- `ACTIVE → SUSPENDED|REVOKED` 必须原子递增 `revoke_epoch`；`REVOKED` 不可恢复。若运维把 `SUSPENDED` 恢复为 `ACTIVE`，epoch 仍只增不减，只允许新准入读取新值。任何已接受 Run 保存的 observed epoch 一旦不等于当前值，就永久失去后续 Capability Call 权限；恢复激活不能让它重新获得能力，调用方只能显式创建新 Run。
- dev/staging/prod 可使用不同 policy/credential mapping，但执行能力上限仍来自同一明确的 Agent Release；跨环境 promotion 必须生成可读 diff 和审批记录，不得复制 mutable Draft 作为部署。Agent production activation 必须逐字使用 [Compiled Capability Closure v1 5.4](./compiled-capability-closure-v1.md#54-agentflow-共享的-production-promotion-gate) 的 `ProductionPromotionGateDecisionV1` canonical key、状态、失效和单次消费 CAS，不得另立 Agent-only approval。G0 只允许 development/staging，production pointer 的写入/切换无条件 fail closed；G1 gate 落地后也只有共享受限 promotion 函数可解锁。diff 必须显式标出 `conversation_contract_hash` 变化，并明确其结果是旧 Conversation 需要新建，而不是隐式迁移。

## 4. 能力 Binding：统一登记，类型化执行

所有 Binding 共享身份、pin、说明书、schema、授权、预算、重试与审计字段；以下资源拥有额外的不可替代约束。模型只接收已被运行时允许的 `ToolDescriptor`/检索描述，不能直接持有 PublishedResourcePin、secret 或未授权的参数空间。

### 4.1 知识库（`knowledge`）

```ts
interface KnowledgeBindingConfigV1 {
  schema_version: "knowledge-binding/1";
  selection: "on_demand" | "force";
  query_contract_hash: string;
  metadata_filter_policy_hash: string;
  forced_execution?: {
    order: number;
    output_injection: "before_role_context" | "before_current_user_input";
    on_empty: "fail_closed" | "continue_without_context" | "ask_user";
    on_timeout: "fail_closed" | "continue_without_context" | "ask_user";
    on_authorization_denied: "fail_closed";
    on_empty_gate_spec?: { gate_spec_id: string; gate_spec_hash: string };
    on_timeout_gate_spec?: { gate_spec_id: string; gate_spec_hash: string };
  };
}
```

`selection="force"` 时根字段必须是 `discoverability="forced"`，`forced_execution` 必填且 `order` 在 Release 内唯一；`selection="on_demand"` 时 `forced_execution` 必须缺失且不得标成 forced。任何 `ask_user` 分支都必须编译为类型化 HumanGate 计划，不得由模型临时生成等待语义。权限拒绝永远 fail closed，不能使用空上下文降级。

每个 `ask_user` 分支必须提供对应的 `*_gate_spec`，逐字指向同一 Agent source 的 input Gate ID/hash；非 ask_user 分支禁止该引用。ResolvedPlan 将该 Gate 的已编译证据固定到 required call，并以 `execution_scope_path + order` 表达挂载内顺序，不要求不同 child/mount 的局部 order 全局唯一。`enabled=false` 仍保留完整源配置/hash，但不产生准入执行义务；源启用而权限收窄不可用的 forced Binding 仍使 Plan fail closed。

| 约束 | 设计要求 |
|---|---|
| 选择策略 | `selection=on_demand|force`；停用统一使用 Binding 根字段 `enabled=false`，不得再在 config 建第二个 disabled 状态。`force` 在模型轮次前按已解析参数执行，`on_demand` 只提供经授权收窄的检索描述。 |
| 固定内容 | pin 至不可变 `KnowledgeIndexGeneration`，并记录 source/ingestion pipeline/embedding/retrieval/rerank contract hash、metadata filter policy 和说明书 hash。 |
| 租户与数据边界 | 检索器必须强制 workspace 和允许的 channel/metadata filter，不能仅相信模型提供的库 ID 或前端筛选。 |
| 证据与日志 | 每次查询记录 query 摘要、检索 policy、实际 revision、命中 chunk/file/version ID、分数、脱敏上下文摘要和注入位置。 |
| 失败语义 | `force` 的空结果/超时/权限失败必须按 Binding 定义为 `fail_closed`、`continue_without_context` 或 `ask_user`；不得把失败伪装为“已查到”。 |

`KnowledgeSourceRelease → IngestionPipelineRelease → IngestionRun → KnowledgeIndexGeneration` 与查询 Binding 是两条生命周期。刷新先构建新 generation，通过完整性/ACL/检索夹具后再切换候选别名；旧 Release 和已接受 Run 继续引用旧 generation。“写知识库”不是查询的兼容选项，而是具有 `write` 副作用的独立 Flow/Plugin/Database Operation Binding；它不能使用读检索的自动重试规则。

### 4.2 数据库与数据表（`database`）

数据库能力风险最高。Agent 不得得到数据库连接串、自由连接权限或整个 schema 的无约束写权限；`LIMIT 500` 等返回规模限制不是写入安全策略。

```ts
interface DatabaseBindingConfigV1 {
  schema_version: "database-binding/1";
  operation_contract_hash: string; // Binding target 已是 DATABASE_OPERATION_RELEASE
  table_revision_ids: string[];    // 必须属于 operation release 的精确允许表版本
  allowed_tables: TableColumnGrant[];
  row_filter_template?: RestrictedPredicate;
  max_rows: number;                // secure 默认小且有绝对上限
  transaction_mode: "read_only" | "single_write";
  approval: "none" | "required";
  idempotency_requirement: "none" | "operation_key_required";
}
```

- secure profile 默认 `read_only`，只允许参数化 operation 模板或受限 SQL AST；模型输出必须先通过参数 schema、表/列 allowlist、行过滤和数据分类检查，不能直接拼接 SQL。
- G1 只实现参数化、限行、限时的 `read_only` operation；下述 `single_write` 是 G2 预留契约，G1 发布/准入必须以 `FEATURE_NOT_ENABLED` 拒绝，不得因 schema 中存在该枚举就予以执行。
- Binding 根字段 `input_schema/output_schema` 是唯一调用参数/结果 schema 事实源，并必须与 `DATABASE_OPERATION_RELEASE` 的 parameter/result contract hash 精确一致；config 不得再保存第二份 schema。target 已类型化固定 connector identity、查询/AST 与 table/schema revisions，`DatabaseBindingConfigV1` 只能在这些固定语义内进一步收窄，不得替换 connector 或 operation。
- `single_write` 只适用于明确 Binding，必须包含 operation key、事务范围、审批策略、唯一去重/补偿说明和可审计回执。写、删除、发送、付款等高风险操作在请求已发出但结果未知时进入 `NEEDS_ATTENTION`，不得自动重放。
- 数据库 Binding 需要独立的 `agent_release_database_bindings`/等价规范化关系，以表达数据库、表、列、行策略、不可变 operation release、精确 table revision、masking、预算和数据分类；不得藏在 `agent_skills.target_id` 或 JSON 中。修改 AST、schema、row policy、最大行数或审批都必须发布新的 operation release。
- Mock 不能覆盖数据库能力。预览/批测如需要模拟数据库结果，应使用另一个不具副作用的 Fixture Binding，并在 Run 上标记 `simulation=true`，不能静默短路真实写操作；`simulation` 必须由 preview/批调服务器路径写入且在执行器入口再次校验，公开/API/Task Run 不得从客户端输入或 fixture 回退取得它。

### 4.3 工作流（`flow`）

```ts
interface FlowBindingConfigV1 {
  schema_version: "flow-binding/1";
  invocation: "sync" | "async";
  async_child?: AsyncChildPolicyV1; // invocation=async 时必填；sync 时必须缺失
}
```

- Binding 的判别 `pin` 只能指向已发布 `FLOW_VERSION`，输入/输出 schema 必须在 Agent 发布时兼容；Flow 内部资源 pin 与环境解析遵守 [Flow IR](./flow-ir-v1与运行时契约.md)。
- 同步 Flow Binding 是 Agent Run 的一个 Capability Call，并创建固定 `flow_version_id + flow_plan_hash` 的嵌套 `FlowExecution`。它复用 root `run_id` 和其事件/账务事实源，但**不是**一个顶层 Flow Run；Flow 节点使用 `flow_execution_id + scope_path` 恢复，不能把 Agent Run 同时写成另一条 Flow Run。
- 长耗时或计划任务不能让 Chat HTTP 长连等待。异步 Flow 只能在 `FlowBindingConfigV1.async_child` 已发布时创建 child Run；创建 `run_parent_link` 时逐字复制该 closed v1 object 的 `completion_policy`、`cancel_propagation`、`result_projection` 与 `parent_terminal_policy`，不得恢复时重读 Release 或猜默认值。它不能把 child Run 的终态伪装成父 Run 已成功，也不能再次预扣 Workspace 余额。
- Flow 的副作用、重试、审批和 secret 污点规则不由 Agent 覆盖；Agent 只能进一步收紧。
- G1 的 `FlowBindingConfigV1` 是上述 schema 的受限 profile：同步调用可用；异步只接受 `join + cascade + safe_summary + wait_for_settlement` 的精确组合。`detach`、`do_not_cancel`、`none` 结果投影或其他组合必须在发布和 admission 同时以 `FEATURE_NOT_ENABLED` 拒绝，不能只靠 Worker 不执行来降级。

### 4.4 插件（`plugin`）与能力包（`skill_pack`）

```ts
interface PluginBindingConfigV1 {
  schema_version: "plugin-binding/1";
  operation_contract_hash: string;
  provider_tool_name: string;
  transport_contract_hash: string;
  default_parameters: JsonObject;
}

interface SkillPackBindingConfigV1 {
  schema_version: "skill-pack-binding/1";
  exposed_operations: {
    exposed_operation_id: string;
    exposed_operation_contract_hash: string;
  }[];
  member_projection_hash: string;
}
```

- Plugin Binding 必须 pin 到 provider/tool 发布版本、工具 schema/hash、transport、canonical endpoint/server identity、tool-list hash、默认参数和副作用分类，并声明 `CredentialRequirementV1`；Plugin 的“技能描述 + 输入描述”是路由提示，不能作为参数校验或授权替代。
- 外部 HTTP、邮件、IM、支付、文件删除等操作必须声明副作用与 operation key 支持；插件自身不得吞掉超时并把未知送达报告为安全失败。
- MCP 只是 Tool Provider/transport，不是通用授权边界。MCP release 必须固定 transport、远端身份、discovery 得到的 tool allowlist/schema hashes、认证需求、egress、超时、sandbox 和代码/镜像 digest；secure profile 默认禁止任意 stdio、shell 和与平台进程共享高权限的自定义代码。
- `skill_pack` 是本项目扩展概念，不能宣称为竞品已验证能力。它在 Release 编译时展开成可审计的 Plugin/Flow/Knowledge/SubAgent/Database Binding 清单，pack 的升级不得隐式改变已发布 Agent；它不是 Instruction Skill、Agent Strategy 或任一可执行能力的同义词。编译器必须把每个 `exposed_operation_id + exposed_operation_contract_hash` 解析成 [Compiled Capability Closure v1](./compiled-capability-closure-v1.md) 中唯一的 `member_binding_path + member_target pin + member_operation_contract_hash` 并 seal route hash；零匹配或多匹配分别以 `SKILL_PACK_OPERATION_UNRESOLVED` / `SKILL_PACK_OPERATION_AMBIGUOUS` 拒绝发布。运行时只按该 route 与 closure path membership dispatch，禁止按成员名称、局部 binding ID 或当前 pack 内容 discovery。

### 4.5 子 Agent（`subagent`）

```ts
interface SubagentContextProjectionV1 {
  schema_version: "subagent-context-projection/1";
  mode: "eligible_history" | "summary" | "user_question_only";
  allowed_message_kinds: ("user" | "assistant")[];
  allowed_field_paths: string[];
  max_data_classification: "public" | "internal" | "confidential" | "restricted";
  redaction_policy_id: string;
  max_turns: number;
  max_tokens: number;
  serializer_pin: { serializer_id: string; version: string; implementation_digest: string };
  tokenizer_pin: { tokenizer_id: string; version: string; vocabulary_hash: string; implementation_digest: string };
  truncation_policy: {
    algorithm: "newest_complete_turns" | "oldest_complete_turns";
    tie_breaker: "message_sequence_then_id";
    preserve_current_user_message: boolean;
    policy_hash: string;
  };
  summary_policy?: {
    model_pin: PublishedModelPinV1;
    prompt_template_pin: {
      prompt_template_id: string;
      prompt_template_version: string;
      content_hash: string;
    };
    output_schema_hash: string;
    max_attempts: number;
  };
  projection_contract_hash: string;
}

interface SubagentContextProjectionFactV1 {
  schema_version: "subagent-context-projection-fact/1";
  projection_id: string;
  workspace_id: string;
  parent_run_id: string;
  parent_call_id: string;
  parent_attempt_id: string;
  parent_execution_fence: number;
  dispatch_generation: number;
  dispatch_outbox_id: string;
  dispatch_intent_hash: string;
  binding_path: CanonicalBindingPathV1;
  target_release_pin: PublishedResourcePin<"AGENT_RELEASE" | "A2A_AGENT_RELEASE">;
  source_cursor: {
    conversation_id?: string;
    high_watermark_sequence: string;
    high_watermark_message_id?: string;
  };
  included_messages: {
    message_id: string;
    sequence: string;
    role: "user" | "assistant";
    content_hash: string;
  }[];
  eligible_source_ref: string;
  eligible_source_hash: string;
  serializer_pin: SubagentContextProjectionV1["serializer_pin"];
  tokenizer_pin: SubagentContextProjectionV1["tokenizer_pin"];
  truncation_policy: SubagentContextProjectionV1["truncation_policy"];
  projection_contract_hash: string;
  context_projection_ref: string;
  content_hash: string;
  summary?: {
    model_pin: PublishedModelPinV1;
    prompt_template_pin: NonNullable<SubagentContextProjectionV1["summary_policy"]>["prompt_template_pin"];
    output_schema_hash: string;
    logical_model_call_id: string;
    accepted_model_attempt_id: string;
    response_ref: string;
    response_hash: string;
    usage_attempt_id: string;
    usage_identity: string;
    usage_hash: string;
  };
  created_at: string;
}

interface SubagentBindingConfigV1 {
  schema_version: "subagent-binding/1";
  invocation: "sync" | "async";
  async_child?: AsyncChildPolicyV1; // invocation=async 时必填；sync 时必须缺失
  routing_priority_weight: number; // 0..100，仅在已授权候选间排序
  context_projection: SubagentContextProjectionV1;
  input_allowlist: string[];
  max_depth: number;
  max_calls: number;
  budget_share: BindingBudget;
  authorization_delegation:
    | { mode: "recheck_target_policy" }
    | { mode: "bounded_delegation"; policy: BoundedDelegationPolicyV1 };
}

interface BoundedDelegationPolicyV1 {
  target_capability_binding_ids: string[];
  allowed_audiences: string[];
  allowed_scopes: string[];
  allowed_resource_pins: PublishedResourcePin[];
  allowed_egress: CanonicalEgressRule[];
  max_data_classification: "public" | "internal" | "confidential" | "restricted";
  max_side_effect_class: "safe" | "requires_key" | "unsafe";
  allowed_operation_contract_hashes: string[];
  allowed_credential_modes: ("caller_delegated" | "service_principal" | "team_shared")[];
  max_ttl_seconds: number;
  max_calls: number;
  max_depth: number;
  max_budget: BindingBudget;
}
```

- `routing_priority_weight` 必须在发布时验证为 `0..100` 的整数，并且只用于已通过 AuthorizationDecision、closure 与当前 epoch 校验的候选之间排序；它不能把未授权/未编译目标加入候选集，也不能覆盖显式 `@Agent` 目标或强制路由策略。子 Agent 返回契约只使用 Binding 根字段 `output_schema`；config 不得复制第二份输出 schema。
- 不得将原始完整会话、system/developer 指令、Capability observation、父 Agent 的所有变量、任何 secret 或未授权 Binding 传给子 Agent。`eligible_history` 只表示在 `allowed_message_kinds + allowed_field_paths + max_data_classification + redaction_policy_id + max_turns/max_tokens` 共同裁剪后的合格历史，不等于 raw full history；`summary` 的输入也必须先经过同一裁剪。Tool/Capability 输出默认不属于可选 message kind，若未来开放必须新增 schema version 和类型化字段策略。
- `projection_contract_hash` 必须覆盖上述 allowlist、分类、脱敏、窗口、serializer、tokenizer、truncation/canonicalizer 版本和 summary policy，并进入 Agent compiled hash、closure 与子 Plan。`mode="summary"` 时 `summary_policy` 必填，其他 mode 必须缺失；运行时只能进一步删减消息或字段，不能因为摘要器、目标 Agent 或当前 grant 新增内容。
- 首次子 Agent dispatch 前，host 必须在当前 parent Call attempt/fence 下锁定会话 high-watermark cursor，按固定 allowlist/分类/脱敏/窗口选择消息，并把 `workspace_id`、parent Run/Call/Attempt、observed execution fence、由 Call CAS 分配的 `dispatch_generation`、唯一 `dispatch_outbox_id/dispatch_intent_hash`、cursor、逐条 message identity/content hash、不可变 eligible source ref/hash、serializer/tokenizer/truncation pins、target release pin、`context_projection_ref` 与 canonical `content_hash` 写成不可变 `SubagentContextProjectionFactV1`。同一事务还必须把该 fact 绑定到 parent Call 并写唯一 dispatch outbox；事务提交前不得向内部/外部子 Agent 发请求。数据库必须以 `(workspace_id, parent_run_id, parent_call_id, parent_attempt_id)` 复合 FK 证明同租户，以 `(workspace_id, parent_call_id, parent_attempt_id, parent_execution_fence, dispatch_generation)` 唯一约束固定该次 dispatch，并让 `(workspace_id, dispatch_outbox_id)` 同时唯一且复合回指同一 fact；任一 fence 漂移、重复 generation 不同 intent 或 outbox/fact 不一致都 fail closed。重复 outbox、恢复或换 Worker 只能读回同一 fact/ref/hash，不得分配新 generation、按当前会话重新投影或向旧 fence 再次 dispatch。
- summary 前必须先提交 content-addressed eligible source snapshot；摘要只消费该固定 ref/hash，并走标准持久 model-attempt/outbox/usage 路径。只有 response ref/hash、固定 model pin、prompt template pin、output schema hash、被采纳 model attempt、usage attempt 与 usage identity/hash 全部提交后，首次子 Agent dispatch 事务才能把这些字段封入 fact；结果未知时不得重新摘要后继续。summary usage 归属 parent billing owner，重复 dispatch 不得重复计费。
- `content_hash` 覆盖最终 canonical projection bytes、source cursor、included message hashes 和全部 serializer/tokenizer/truncation/summary pins；`context_projection_ref` 只指向该不可变内容。原消息后来新增、编辑（若业务允许）或 retention 不得改变已接受 dispatch；引用内容无法按 hash 回读时显式失败，不能退回 raw current history。
- 外部目标只能引用不可变 `a2a_agent_release`；该 release 固定 canonical endpoint、远端身份 pin、egress policy、认证 requirement/provider-version 约束与 contract hash，不持有 secret ref/material。运行时按主体和 Deployment mapping 解析不透明 credential handle，不得回读可变连接草稿；endpoint/身份/egress 变化必须发布新 release。
- 默认 `recheck_target_policy`：子 Agent 用原始主体/受限委托主体重新执行目标 Release 的运行时授权，且只可获得父 Binding 已委托的能力上限。`bounded_delegation` 不是“继承父权限”开关；Release 必须固定上述 policy，准入时再由服务端签发一次性 `BoundedDelegationGrantV1`。Grant 至少固定 `delegation_id + parent_run_id + parent_call_id + parent_resolved_plan_hash + parent_capability_closure_hash + target release pin + original/delegated principal + audiences/scopes/resource pins/egress/data class/side-effect/operation hashes + budget/depth/call limits + not_before/expires_at + nonce + delegation_hash`；不得包含 secret 或可转移 credential。
- 子 Plan 的有效能力必须是“父 `CompiledCapabilityClosure` 可委托集 ∩ Release policy ∩ runtime Grant ∩ 目标 Release closure ∩ 子主体当前授权”的交集。任一集合缺失、过期、撤销或无法证明不扩权都必须拒绝；`service_principal`/`team_shared` 凭据只有在其源 grant 显式标记 `delegable=true` 且委托策略点名时才可用，不得传递原始材料。
- 发布器必须检查 Agent Release 调用图无环；运行时仍计数 `max_depth` 和 `max_calls`，防止配置后更新、跨 workspace 目录或条件路由形成无限递归。
- 同步子 Agent 是当前 Run 中的嵌套 Capability Call，并固定 target Agent Release、子 Plan hash 和子 checkpoint namespace；异步子 Agent 是带 `run_parent_link` 的 child Run，并具有 `start → status → result/cancel` 状态、`parent_call_id` 和独立最终事件。G1 只允许 `join/cascade/safe_summary/wait_for_settlement + G1JoinChildTerminalOutcomeMapV1` 的精确组合；`detach`、`do_not_cancel`、`none` 投影、缺省/自定义 outcome map 或其他组合在 publisher 与执行准入都必须以 `FEATURE_NOT_ENABLED` 拒绝，直到 G2 完成独立账务和取消验收。

### 4.6 Instruction Skill 与 Agent Strategy

- Dify、Coze Coding、Stack AI 和 Gumloop 的官方资料足以证明 `SKILL.md` 型过程包是值得独立建模的行业能力，但**不能**证明 BetterYeah 截图中的独立 Skill 具有相同协议。`InstructionSkillRelease` 是本项目通用能力；在 `R-A7` 闭环前不得将它投影为 BetterYeah 兼容 `BindingKind` 或宣称可无损导入其 Skill。
- Instruction Skill 是不可变内容 release，以同 Workspace、kind-safe 的 `PublishedResourcePin<"INSTRUCTION_SKILL_RELEASE">` 固定文件 manifest/hash、入口、解析器版本、来源/签名、上下文预算、数据分类和可选脚本声明。激活只允许将经裁剪的过程说明装配进当前模型上下文；Skill 只能引用同一 Agent Release 中已存在的 Capability Binding ID，compiler 必须把它解析为 closure-unique binding path 写入 inert descriptor；它不能创建新 Tool、获得 secret、扩大域名或绕过授权。
- G1 将 Skill release 中的 `scripts/**` 只视为已签名 manifest 的惰性资产：解析器可验证 path/hash/大小，但不得加载、解释、执行、翻译为 Tool，也不得为它解析 secret、依赖或 egress。包声明“必须执行脚本”时 G1 发布以 `SKILL_SCRIPT_EXECUTION_UNSUPPORTED` 失败，不得静默忽略后宣称兼容。后续脚本执行必须通过新 schema 版本增加独立、类型化、可授权的 code-tool Binding，不得复用 Instruction Skill 激活权。
- G1 的实现 ownership 必须分层且不能遗漏：skill release parser 负责 closed manifest、规范路径、大小/hash、来源/签名与 traversal 拒绝；publisher/compiler 负责 assembly/seal、`allowed_capability_binding_ids` 和 inert descriptor；Agent runtime 只装配该 descriptor。任何一层未实现或 hash 不匹配都拒绝 Release/admission，不能临时读目录、以空 Skill 降级或把 parser/runtime 各做一套事实源。
- Agent Strategy 独立固定推理循环实现、状态 schema、允许模型/Binding、最大迭代/调用和 sandbox，并必须实现 [Agent Strategy ABI v1](./agent-runtime-strategy-v1.md)。策略选择、模型 Attempt、决策、迭代 checkpoint 和终止原因进入持久化 Step/Event；它只能从 ResolvedAgentPlan 和 `capability_closure_hash` 允许的目录选择，不能把 Tool 结果、路由、预算或恢复 cursor 藏在不可审计的 conversation history 中。

### 4.7 任务与 Experience Release

- Agent Task 仅可异步调用已发布、同一 Release 且 `task_safe=true` 的 Plugin 或 Flow Binding；首版数据库/`skill_pack`/SubAgent 均不得设置 `task_safe`。若将来支持其他类型，必须新增显式安全能力和任务契约，不能因其存在于通用 Binding 列表就自动允许。
- Task 模板发布时固定目标 Binding、目标 pin、输入 schema/模板、调度、受限 `service_principal`、通知目标、幂等命名空间和预算。定时触发时不得重新解析 Release；但每次实际副作用调用仍检查撤销/有效期和必要的当前授权。
- 开场白、开场引导、推荐问题、快捷入口、隐藏图标/名称只属于 Experience Release。它通过公开 handle/schema 声明目标；Deployment 装配时再验证目标 Agent Release。快捷入口启动后仍走完整授权/Plan，隐藏只影响用户投影，不影响审计。

## 5. 角色、变量、Mock 与模型可见目录

### 5.1 角色设定与权重

结构化主题（角色、背景、技能、任务、要求、输出格式、自定义主题）是 Draft 可编辑内容。Release 固定主题原文、权重、渲染器版本和主题到 Binding 的同步基线。权重的实际模型算法没有公开证据；本项目如采用排序、强调渲染或其他机制，必须作为可 diff 的 `role_renderer_version` 写入 Release，不能把算法效果谎称为竞品事实。

运行时 Prompt 装配顺序由 `CompiledAgentRelease` 显式给出，至少区分：受验证变量插值后的角色段、允许的能力描述、强制检索返回的脱敏上下文、受控会话投影和当前用户输入。任意技能/知识说明书与角色“技能主题”不一致时，发布器应失败或要求确认同步；不得让两份同一业务规则悄然冲突。

### 5.2 变量分类与输入契约

| 类别 | Draft / Release | Run 语义 | 禁止事项 |
|---|---|---|---|
| 普通输入变量 | 名称、类型、必填、默认值、敏感标记写入 `input_contract` | 在 Plan 前校验并形成脱敏输入快照；只有允许字段可插入 Prompt/Flow | 不得允许任意 `inputs` 键绕过 schema 或把敏感值回显到日志 |
| 会话变量 | Release 定义可读字段和 TTL | 从受控 session projection 读取 | 不得自动把全部历史/存储注入子 Agent 或工具 |
| 权限变量 | Release 定义主体 schema 与回调 policy 引用 | 只用于构造服务器端 Authorization Decision | 不得插入 Prompt、由浏览器伪造或在回调失败时 fail-open |
| Mock 变量 | Release 只声明 `mock_safe=true` 的非 database、`safe` Binding 与 fixture schema | 仅 preview/批调服务器路径生效，并形成不可由客户端伪造的 `simulation` Run 标记 | 不得用于公开发布、数据库 Binding 或掩盖真实外部副作用 |
| 派生变量 | Release 声明来源和数据分类 | 由已提交 Step/Call 输出产生 | 不得从 secret 或未授权结果派生到 Prompt/公开输出 |

`input_interaction_mode="form"` 表示前端收集参数的交互方式；`output_handling_mode="raw"` 表示已经完成授权和执行后的输出投影方式。两者不得共用一个枚举字段。

### 5.3 模型可见能力目录

Plan 完成后才生成模型目录。每个可选能力描述至少含稳定 Binding 名称、路由说明书、已经过 JSON Schema 裁剪的入参、超时/预算提示和安全可见输出 schema。它不含资源内部 ID、完整数据库 schema、secret、未授权列/表、其他用户的历史或所有可用工具。

`forced` Binding 不以模型选择作为前提，而以 `ResolvedAgentPlan.required_calls` 的有序步骤执行。它的结果可以按 Binding 的上下文策略注入模型，但若失败必须显示对应的已定义降级，不得伪造检索或工具成功。

## 6. 授权与动态资源解析

### 6.1 两层判定：发布静态校验 + 调用时收窄

发布时验证 Binding 的资源可被该 Workspace 的管理员配置；这只是“可配置”，不是“每个用户在每次调用时都能用”。调用时按以下固定顺序解析：

```text
1. 认证请求 / 调度 service principal，建立 ADR-003 tenant context
2. 按认证 credential/session 的 kind、principal、audience、channel 和所需 literal scope 读取 `AgentDeploymentEntryGrantV1`，统计有效 grant 指向的 distinct Agent Deployment 并要求恰好一个；grant tuple/target kind/cardinality 任一不匹配立即拒绝
3. 在同一准入事务锁定该稳定 Deployment 的 active pointer 与 `AgentDeploymentSecurityStateV1`，要求 `status="ACTIVE"`，读取并保存当前 `revoke_epoch` 为 `observed_revoke_epoch`，再固定 deployment/agent/experience release IDs；`SUSPENDED|REVOKED` 或 pointer/state 不一致均在 Run/reservation/outbox 前拒绝
4. 经 `published_resource_versions` registry 验证 Deployment、Release visibility、版本级 grant 和 dependency manifest
5. 解析主体、渠道和 Authorization Policy / 权限 SPI
6. 对每条 Binding 以其类型化 release/grant 交集收窄：主体 allow-set、资源状态、数据分类、部署画像、预算
7. 以 `CredentialRequirementV1` ∩ closed `AgentDeploymentCredentialMappingV1` ∩ 当前主体 grant 解析实际 credential binding；任何缺失、重复或降级均拒绝
8. 将发布时 `capability_closure_hash` 与当前主体/grant/policy 取交集，生成不可变 Authorization Decision 摘要与 `authorization_epoch_vector`，再生成 ResolvedAgentPlan
9. 原子创建 Run、初始 Step/Event、顶层预算 reservation 与 outbox
```

任一步骤不得由客户端传来的 `workspace_id`、`resource_id`、`agent_release_id` 或“允许列表”替代服务端判断。外部权限回调的原始响应可能敏感，Run 只记录响应 hash、策略版本、决策 ID、有效期、允许 Binding 摘要和失败分类；密钥和未授权资源不得落盘或回显。

### 6.2 运行身份与凭据解析

Release 只声明“需要什么身份”，Deployment 只声明“允许如何满足”，Run 才解析“这次实际是谁”：

| 模式 | 解析规则 | 禁止降级 |
|---|---|---|
| `caller_delegated` | 按当前最终用户、provider、audience、scope 与源 ACL 获取不可转移的 credential handle | 用户未授权时不得回退到发布者、管理员或团队共享凭据。 |
| `service_principal` | 仅对已发布 Trigger/Task 或显式后台入口使用受限服务主体；固定用途、scope、有效期和 owner | 交互式用户调用不得冒用；子 Agent 不自动继承。 |
| `team_shared` | 解析经管理员审批的团队 credential policy，并叠加调用者角色、资源与 operation allowlist | 共享不等于 Workspace 全员可用；写权限不得由 Tool description 授予。 |
| `none` | 只用于无外部身份要求的计算/公开只读资源 | 仍受 egress、schema、数据分类、副作用和预算约束。 |

- `CredentialRequirementV1`、Deployment mapping 和实际 credential binding 必须属于同一 Workspace 或受控全局目录，并由复合引用/RLS 约束；客户端不能提交 credential ID 选择更高权限身份。
- 实际 credential 的 ID、主体类型、scope 摘要、版本/指纹和 epoch 写入 Authorization Decision/ResolvedAgentPlan/CapabilityCall；原始 secret 和可重放 token 永不进入这些对象。
- credential 轮换不修改 Release；新调用解析新有效 material，已开始调用保存当时的非秘密指纹。撤销/过期必须递增 epoch，阻止未开始或待恢复的调用。
- Flow/SubAgent 目标默认用原始主体重新授权。只有已发布 `bounded_delegation` 可以转交不可扩张的 audience/scope/有效期/调用上限；不能传递发布者凭据或整个父 Agent credential set。

### 6.3 冻结与撤销并存

资源版本必须固定以便恢复和审计，但权限撤销必须即时收窄未来动作；二者不能互相替代：

- Accepted Run 保存当时的 Authorization Decision，说明“为何当时被接受”；它固定的是策略引用、候选 Binding 与决策快照，绝不是永久授权结果；
- `authorization_decision_epoch_sources` 是 vector 的权威、类型化 source 集合：Workspace、稳定 Agent/Flow Deployment 的唯一可变 `status/revoke_epoch`、绑定稳定 Deployment 的 entry grant、Agent/Experience/Flow Release、实际 credential 及 mapping 所引用的可变 source grant/policy（如有）、permission callback/policy、任务 service principal（如有）、顶层 System release visibility/grant，以及每条获准 Binding 的类型资源 release/grant，都以稳定 `source_kind + source_id + source_subkey + observed_epoch` 写入；`authorization_epoch_vector` 只是其 canonical 投影。不可变 Deployment revision 及其中的 mapping 只作为 `deployment_revision_id + revision_contract_hash + mapping_hash` pin/审计事实写入 Plan，**没有 status/revoke epoch，也不是第二个安全状态源**。active pointer 和 `activation_epoch` 同样不得进入已接受 Run 的 epoch source 集；它们只作为准入时 `admission_active_revision_id/admission_activation_epoch` 审计快照保存。G0/G1 不存在 floating binding source。每次撤销、状态、scope/grant 或策略变更必须经受限 mutation function/trigger 在同一 RLS 事务原子递增对应 source 与 Workspace epoch、写 durable invalidation，并通知缓存；
- 每个 Capability Call 在执行前于同一租户事务按 Decision 保存的**同一 source 集合**读取当前 epoch 并比较。读取型调用只可在未过期且完全匹配的 Decision 内使用；高风险写调用必须要求有效的新鲜决策或执行前重新授权；
- 撤销后，未开始的 Binding 不得继续执行。Deployment `revoke_epoch` 采用永久 fencing：任一历史 observed 值不匹配都拒绝该旧 Run，即使 Deployment 后来重新 ACTIVE；恢复时若需要重新授权而失败，Run 以 `AUTHORIZATION_REVALIDATION_FAILED` 或 `RESOURCE_REVOKED` 进入终态/人工处置，绝不改用新资源或旧草稿；
- 运行时重新评估只可减少可用权限，不能因为当前获得新 grant 而向已接受 Run 扩张能力。

G0/G1 只有 secure、fail-closed profile，不提供可开启的宽松/legacy/compatibility 行为。未来如有确凿兼容需求，必须通过独立 schema version、migration、管理员审批事实、责任范围、epoch/invalidation、隔离部署画像、攻击夹具与单独发布 gate 引入，并以不可扩张的 safety envelope 约束；不得修改或复用 G0/G1 secure profile，也不得允许空/超时回调、unknown grant 或兼容开关退化为 fail-open。

## 7. Plan、执行、重试与 Run 层级

### 7.1 Resolved Agent Plan

顶层入口的 `plan(compiled_agent_release, request)` 在创建**顶层 Agent Run**的同一事务中完成，且不得执行模型、插件、Flow、SQL、网络请求或用户业务写入。它必须：

1. 在同一事务先固定精确 `AgentDeploymentEntryGrantV1` literal tuple/authorization epoch 与 exactly-one distinct target，再锁定 active pointer 与 Deployment security state，要求 `status="ACTIVE"`，并绑定 `run_id`、`accepted_request_id`、`deployment_revision_id + revision_contract_hash`、`admission_activation_epoch`、`observed_revoke_epoch`、`agent_release_id`、`experience_release_id`、`compiled_hash`、`capability_closure_hash`、已授权主体、调用渠道和输入摘要；`admission_activation_epoch` 只供审计，`observed_revoke_epoch` 则进入 authorization epoch source 并永久 fence 旧 Run；不可变 revision pin 不是 epoch source；
2. 解析并快照 Strategy ABI/Instruction Skill typed pins、经传递性 closure 与当前授权取交集后的 enabled/disabled binding paths、实际 resource/index pins、credential binding 摘要、授权决策、模型策略、超时、预算、强制调用序列和显示策略；运行时 membership 只按 closure-unique path，不按嵌套 Release 内可重复的局部 `binding_id`；
3. 验证 input schema、调用 scope、并发、数据分类、取消前状态，并取得顶层 Workspace reservation；
4. 创建 Run、root Agent Step、初始 Capability Call 计划、**顶层** reservation 和 outbox；
5. 返回只读 `ResolvedAgentPlan`。若失败，释放未使用预留并记录可审计拒绝，不得创建半接受 Run。

异步 Flow/SubAgent 创建 child Run 时不调用上述顶层准入路径：它锁定既有 `billing_owner` reservation，以同一事务写入 `run_parent_link + run_budget_allocation + child Run + outbox`，只从父剩余额度划拨；child 的拒绝、取消和终态均不得创建或释放第二笔 Workspace reservation。

### 7.2 Run / Step / Capability Call 层级

```text
Run (target_kind=agent, agent_release_id)
└─ Step: agent.turn / agent.strategy.iteration
   ├─ InstructionSkillActivation (skill release/hash; no authority grant)
   ├─ CapabilityCall: knowledge.query (binding_id=...)
   ├─ CapabilityCall: plugin.tool (binding_id=...)
   ├─ CapabilityCall: flow.run (scope_path=agent.tool_x/...)
   │  └─ FlowExecution (flow_version_id + flow_plan_hash)
   │     └─ Flow node Steps (same root run_id, distinct flow_execution_id)
   ├─ CapabilityCall: subagent.turn
   │  └─ nested Agent Step or child Run + run_parent_link (depending on invocation)
   └─ HumanGate + Checkpoint (when input/approval is required)
```

每一层都至少记录：closure-unique `binding_path`、来源 Release 内的局部 `binding_id`、实际 pin、authorization decision ID/摘要、父 `call_id`、输入/输出脱敏摘要、Attempt、错误分类、side-effect receipt 摘要、耗时、预算与积分。异步 child Run 还必须记录从 Binding 复制的根 `billing_owner_run_id`、父 reservation allocation、`completion_policy`、`cancel_propagation`、`result_projection` 与 `parent_terminal_policy`：G1 的 `join` 子 Run 把 accepted/terminal 状态投影进父 Run Event/兼容 task，且父 Run 等待其结算；只有 G2 独立架构门通过后，显式 Binding 才可使用 `detach`，此时父终态不能提前释放其 allocation，并在 `run.terminal.data.billing_pending=true` 以及 durable Run snapshot 投影尚待结算的 child 账务。兼容 API 的 `tasks[]` 和 SSE FUNCTION 帧由这些事实投影；它们不能反向成为恢复、扣费或权限判断的依据。

G1 `join` child 的终态投影固定如下，父 continuation/finalizer 必须以 `parent_call_id + child_run_id + child_terminal_event_sequence` 唯一消费；不存在“忽略 child 失败后继续”的隐式分支：

| child Run terminal | parent Capability Call | root parent Run / 账务责任 |
|---|---|---|
| `SUCCEEDED` | `SUCCEEDED`，只暴露已验证 `safe_summary` | child usage/allocation 已结算后父 Run 才可继续 |
| `FAILED` | `FAILED`，错误码 `CHILD_FAILED` | 父 Run `FAILED`，结算已确认 usage 并释放确定未使用 allocation |
| `CANCELLED` | `CANCELLED`，错误码 `CHILD_CANCELLED` | 父 Run `CANCELLED`；cascade 重放不得重复取消/释放 |
| `TIMED_OUT` | `FAILED`，错误码 `CHILD_TIMED_OUT` | 父 Run `FAILED`；不得把 child timeout 伪造为 root timeout |
| `NEEDS_ATTENTION` | terminal `NEEDS_ATTENTION` | root 父 Run terminal `NEEDS_ATTENTION`；保留 child 与父 reservation/allocation 的未知责任，后续只追加对账 correction/resolution |

该表逐字对应 Release 中的 `G1JoinChildTerminalOutcomeMapV1`，并进入 Binding config hash/closure。特别是 child `NEEDS_ATTENTION` 不能被父 `ErrorPolicy`、Strategy `fail/complete`、Gate reject/expire 或 cancel fallback 覆盖；父 Run 进入 operator hold 后不可 resume，也不能释放可能覆盖未知外部责任的 allocation。

G2 gate 后当 detach 允许父 Run 先终态时，finalizer 在同一事务固定 terminal billing snapshot、父 Run 终态和唯一 terminal event。snapshot 中的 billing_pending 作为 SSE、GET 和 blocking 的唯一来源，之后 child 结算、link/allocation 变化或终态 event 清理均不得回写这个历史值；G1 join/普通 Run 以同样机制固定 false，当前 schema 不接受 true。

### 7.3 错误、重试与取消

运行、Gate 和 Step 使用三个互不混用的状态域：

```ts
type RunStatusV1 =
  | "QUEUED" | "RUNNING"
  | "WAITING_FOR_INPUT" | "WAITING_FOR_APPROVAL" | "RESUMING"
  | "CANCEL_REQUESTED"
  | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "NEEDS_ATTENTION";

type HumanGateStatusV1 =
  | "OPEN"
  | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

type StepStatusV1 =
  | "QUEUED" | "RUNNING" | "SUSPENDED" | "RESUMING"
  | "SUCCEEDED" | "SKIPPED" | "FAILED" | "CANCELLED" | "NEEDS_ATTENTION";
```

`SUCCEEDED|FAILED|CANCELLED|TIMED_OUT|NEEDS_ATTENTION` 是 Run terminal set；`NEEDS_ATTENTION` 是“停止自动执行、等待站外人工对账”的 operator-hold 终态，不是可由 resume/retry 重新进入 `RUNNING` 的暂停态。Run terminal snapshot/Event 仍只提交一次。operator 对账只能追加 resolution/billing correction/audit fact；若需再次执行业务操作，必须创建新请求、新 Run 和新的 operation/idempotency intent，不能复活原 Run。

`SUCCEEDED|SKIPPED|FAILED|CANCELLED|NEEDS_ATTENTION` 是 Step terminal set。Flow `NodeResult` 逐字映射同名 Step 终态；节点/Capability Call 返回 `SUSPENDED` 时只进入持久等待，不是终态。Run finalizer 必须在提交唯一 terminal Event 前把所有未终结的活动 Step 按 Strategy termination/Gate disposition 映射为终态，禁止留下 `RUNNING|SUSPENDED|RESUMING` 的孤儿 Step。

| 错误类别 | 例子 | 默认动作 |
|---|---|---|
| `TRANSIENT` / `RATE_LIMITED` | 网络短断、明确的限流响应 | 仅在 Binding 明确允许、预算仍足、操作可安全重试时退避重试 |
| `MODEL_RETRYABLE` | 受控的结构化输出校验失败 | 在模型/输出策略限定次数内重试；不能重复外部副作用 |
| `VALIDATION_FAILED` | 参数不符合 schema、未填必填变量 | 不自动重试；请求补充或明确失败 |
| `AUTHORIZATION_DENIED` / `RESOURCE_REVOKED` | scope、SPI、资源状态失败 | 不自动重试；向调用者投影可解释、脱敏的拒绝 |
| `SIDE_EFFECT_UNKNOWN` | 请求已发送但本地超时 | Step/Call 与 Run 进入 terminal `NEEDS_ATTENTION`；禁止自动重放或 Gate resume |
| `CANCELLED` / `BUDGET_EXHAUSTED` | 用户取消、预算耗尽 | 停止尚未开始调用，提交可恢复状态和终态事件 |

“异常自动重试”只能映射为每条 Binding 的受限 `RetryPolicyRef`，不能是覆盖所有能力的全局开关。没有稳定 operation key、幂等证明或补偿契约的写副作用不得自动重试；具体 lease、checkpoint、attempt、outbox 和账务语义以 ADR-004 为准。

`NEEDS_ATTENTION` finalizer 必须结算已确认 usage，保留未知外部责任所需的 reservation/allocation 事实，并把当前 `billing_state` 设为 `NEEDS_ATTENTION`；不得假定请求未发生而自动释放全部金额。后续 provider/人工对账以 append-only correction/resolution 更新当前 billing state，但不改写 Run terminal status、terminal billing snapshot、原 Attempt/receipt 或 terminal Event。

### 7.4 Human Gate、等待与幂等恢复

`SideEffectPolicy.approval="required"`、Flow 的 Human Input 和 Agent Ask Human 统一投影为持久 `HumanGate`，但保留 `input` 与 `approval` 两种类型。Agent Gate 只能从固定 Release/closure 的 `AgentGateSpecV1` 物化，Flow Gate 只能从固定 Flow Version/closure 的 `GateSpecV1` 物化；Strategy/客户端不能临时补策略。Gate 至少固定：`gate_id`、`gate_spec_id/hash/source`、`run_id/call_id`、`checkpoint_id`、`resume_cursor`、原 `resolved_agent_plan_hash` 与 `capability_closure_hash`、待批准操作的 canonical hash、表单/动作 schema、approver policy ref、通知渠道、创建/过期时间和当前状态。`resume_cursor` 只能指向已提交 checkpoint 之后的唯一合法继续点。

```text
Run:  RUNNING → WAITING_FOR_INPUT | WAITING_FOR_APPROVAL
                  ├─ 中间 Gate APPROVED ──────────► WAITING（物化下一 Gate）
                  ├─ cohort 最后 Gate APPROVED ───► RESUMING → RUNNING
                  ├─ Gate REJECTED/EXPIRED + fail_run   ───► FAILED
                  ├─ Gate REJECTED/EXPIRED + cancel_run ───► CANCELLED
                  └─ Gate CANCELLED / Run cancel        ───► CANCELLED

Step/Call: RUNNING → SUSPENDED → RESUMING → RUNNING
Gate:      OPEN → APPROVED | REJECTED | EXPIRED | CANCELLED
```

`WAITING_FOR_*` 是 Run/API 投影；对执行引擎而言，对应 Step/Capability Call 已进入持久 `SUSPENDED`。`SUSPENDED` 不占用 Worker lease，也不是可由通用 RetryPolicy 重试的失败。Gate 的 `on_reject/on_expire` 是已发布 disposition，决定 Run 映射为 `FAILED` 还是 `CANCELLED`；Gate 自身始终保留实际的 `REJECTED/EXPIRED` 状态，Strategy 不得把这两个维度压成一个默认失败。

- HumanGate 是 root Run 的全图 barrier，不只是当前节点的局部暂停。任一 Agent/FlowExecution 提交 gate candidate 后，当前 Worker 必须在**同一个 Run/barrier CAS 事务**建立或加入唯一 `gate_barrier_id`、把 phase 置为 `DRAINING`、冻结新调度与完整 runnable frontier、提交 candidate checkpoint，并把自己的可执行 Worker lease 从 `(step_id, attempt_id, source_execution_fence)` 原子转交为 host-only 的 `barrier_owner_generation`：原 Worker lease 同事务标记 `RELINQUISHED`，barrier owner 只能 drain/fence/物化 Gate，不能执行 Step 或产生业务 dispatch。任一步失败整体回滚，candidate 未被接受且不存在“lease 已释放但 barrier 未建立”的窗口，Worker 不得在成功 handoff 后继续写。Run 在完成 quiescence 前仍投影 `RUNNING`（取消竞争时为 `CANCEL_REQUESTED`），不得提前宣称 `WAITING_FOR_*`。
- 已在执行的 sibling 必须在有界 drain 窗口内完成并提交终态 checkpoint，或仅在 executor 声明可安全暂停时提交 `barrier_checkpoint_ref + resume_cursor` 后释放其可执行 lease；已发出且不可取消的外部请求必须先得到可验证结果/回执。结果未知进入 `NEEDS_ATTENTION`，无法在期限内安全 drain 则按 timeout/cancel 终结，二者都不得物化 Gate。quiescence 的“零 active lease”只统计可执行 Worker lease：candidate owner 已通过上一条 handoff 退出该集合，host-only barrier owner 不计入且必须用固定 generation CAS。只有全图 active executable leases、待 dispatch outbox 和未对账 attempt 全部为零后，barrier owner 才在同一事务递增 execution fence、使旧 Worker 的迟到提交失效，写 barrier frontier hash、当前 HumanGate、waiting Event/通知 Outbox 与 `WAITING_FOR_*`，并把 owner handoff 状态置为 `RELEASED`/barrier 置为 `WAITING`。
- G1 每个 Run 同时至多一个 `OPEN` HumanGate。并行 frontier 在同一旧 fence 下到达多个 gate candidate 时，drain 事务按 `flow_execution scope path + compiled topology rank + node_id + gate spec hash` 排出稳定 cohort；只把第一项物化为 `OPEN`，其余作为 barrier 内不可变 deferred candidates，不创建可被并发 claim 的 Gate。APPROVE 后若 cohort 仍有候选，则在同一 CAS 中物化下一项并继续等待；只有全部获批后才以新 fence 从保存 frontier 恢复 sibling。任一 reject/expire/Run cancel 丢弃剩余 candidate、固定 terminal intent 并唤醒唯一全图 finalizer，不允许选择性恢复其他分支。
- terminal intent 不是直接写 Run 终态的权限。唯一 finalizer 必须锁 Run/barrier、再次停止调度并证明全图 quiescent，使用 `run_id + finalizer_generation` 唯一身份和 `terminal_event_sequence IS NULL` CAS，一次性关闭/保留当前 Gate、丢弃 deferred candidates、把全部非终态 Step/Call 映射为合法终态、结算/保留账务责任并写 terminal snapshot/Event。approve/reject/expire/cancel/timeout 与重复 outbox 都只能竞争该 Run/Gate/barrier version 或唤醒同一 finalizer，不能各自产生 terminal Event/settlement。
- 进入等待时，在一个事务内提交 Step/Call 进度、Checkpoint、HumanGate、Run 状态和通知 Outbox，并释放 host-only barrier owner；candidate Worker lease 已在 handoff 事务中释放，不能在 waiting 之后再次释放。事务提交后不保留数据库事务、Worker lease 或 HTTP 连接。SSE 只投影已提交的 waiting event。
- `resume(gate_id, idempotency_key, decision)` 的顺序固定为：认证并确认当前主体仍可读取 Run → 锁定 `(workspace, principal, fixed route template, idempotency_key)` mutation fact → 命中时比较 JCS intent 并直接重放首次 receipt，**不得**重查当前 Gate 状态、再次 claim 或重新授权 → 仅 miss 时锁 Run/Gate/barrier，验证 Gate 仍 OPEN/未过期、决策者权限、原 Plan、credential/resource epoch、预算与 canonical operation hash，再以 `gate_id + barrier_version` 条件更新 claim。Run/Gate/decision 属于 JCS intent，不进入唯一键。APPROVE 在同一事务固定 decision hash、Gate `APPROVED` 与 mutation receipt；若 cohort 尚有 deferred candidate，则按 canonical 次序物化下一 `OPEN` Gate、写通知 Outbox，并保持 Run/Step/barrier 为全图 quiescent 的 waiting，不能写 resume Outbox 或领取 Worker lease。只有最后一个 Gate 获批才把 barrier/Run/Step 切到 `RESUMING`，从保存的完整 frontier/checkpoints/cursors 写唯一 resume Outbox。REJECT/过期不进入 RESUMING，只固定 Gate `REJECTED/EXPIRED`、已发布 disposition、mutation receipt 与 terminal intent，丢弃 deferred candidates 并唤醒 `run_id + finalizer_generation` 的唯一全图 finalizer；mutation 本身不得直接写 Run/Step 终态或 terminal outbox。并发 approve/reject/expire/cancel 只有一个 `Run + Gate + barrier_version` 转换可提交；跨目标复用同 key 返回冲突，不能再次执行副作用。
- 首次恢复继续使用原 Deployment/Release/Plan/Checkpoint，不解析 active latest；任何参数变化、过期或权限收窄都使这次首次 mutation 失败且不创建 outbox。已成功保存的 mutation receipt 此后按上一条 canonical replay，不会因当前 Gate/epoch 已变化而改写历史响应。
- 批准只授权该 canonical 操作，不授予后续 Tool、其他资源或更大 scope。邮件/链接等渠道令牌必须一次性、短期、绑定 gate/actor/audience，且不能仅凭持有链接绕过 approver policy。
- 写操作请求已发送而结果未知时按 §7.3 进入 terminal `NEEDS_ATTENTION`；不能创建或复用 Gate 来假定首次未发生，也不能在恢复时自动重放或把原 Run 切回 `RUNNING`。

## 8. 审计、脱敏、评测与回滚

### 8.1 审计和用户投影

- 运行事实源沿用 ADR-004：Postgres 中的 Run、Attempt、Step、Event、Checkpoint、Outbox 和账务；`run_logs`、SSE、`tasks[]`、可视化日志和分析系统都是可重建投影。
- 每个 Run 的事件在持久化时分配严格递增 `sequence`，且 SSE 重放必须逐字使用已提交序列；但并发、互不依赖的 Capability Call 谁先提交不是可复现语义。每个 Event 必须带 `causation_id`/父 Step/Call 身份，同一输入的验收只比较因果偏序、唯一 terminal event、最终输出、账务去重键和已提交回放，不要求独立并发完成事件的相对顺序每次一致。
- Release 与 Binding 的公开读取只返回稳定身份、版本、说明书和经允许的展示信息；不返回 secret、完整权限 SPI 响应、敏感 schema、用户输入、数据库行数据或其他主体的 allow-set。
- `hide_skill_icon`/`hide_skill_name` 不会删除审计数据；它只在合法调用者的 UI/SSE 投影中替换或省略展示元数据。管理员审计仍需按最小权限、脱敏后可追溯。

### 8.2 评测与 Mock

Release 可以引用不可变 `EvaluationSuiteRelease`（dataset revision、Evaluator revisions、输入、期望属性、允许的能力调用、成本/延迟阈值和安全/脱敏断言），但评测夹具不是生产授权。每个 `EvaluationRun` 必须以同 Workspace、kind-safe 的发布 registry 外键固定目标 Agent/Flow 版本，并保存 Skill/Strategy/model/Knowledge generation 的完整依赖摘要；重跑追加新 revision，不覆盖历史结果，预算不足显式记录 `SKIPPED_BUDGET`。作为 production promotion 证据时还必须固定待激活 `deployment_revision_id`，并证明其 Agent Release 与 dependency manifest hash 和评测目标完全一致；运行时授权仍独立判定。至少覆盖：

1. 主题/变量/能力说明书的 canonical 编译 hash 稳定；
2. 发布后编辑草稿、发布新插件或重建 KB index 不改变旧 Release/Run；
3. 授权只收窄，不会因回调遗漏或缓存失效放宽；
4. 强制知识检索经过完整授权并记录命中/空结果/失败降级；
5. 数据库只读/写入、列掩码、参数校验、行数、审批和 `SIDE_EFFECT_UNKNOWN`；
6. Flow/Plugin pin、Schema 变化和 secret 污点阻断；
7. SubAgent 递归、预算、取消与异步结果传播；raw full history/system/tool observation 必须被拒绝，`eligible_history` 严格受 allowlist、分类、脱敏、窗口和 projection hash 约束；
8. Mock 只在 preview/批调上下文使用，且永不覆盖 database/公开发布；
9. 任务重复投递、定时触发、撤销与幂等命名空间；
10. SSE/兼容 tasks[] 隐藏策略不改变 Run 事实、已提交 sequence/因果关系和计费；并发无依赖完成事件不要求相对顺序一致。
11. Skill/Strategy 只能引用已绑定能力，不能读取 secret、扩大 egress 或修改已发布配置；
12. Human Gate 在重启、并发决策、重复 resume、过期、取消和授权撤销下至多恢复一次；reject/expire 的 `fail_run/cancel_run` 分别得到 Run `FAILED/CANCELLED`，Gate 状态不被抹掉；
13. delegated/service/team credential 不串用主体，子 Agent 不隐式继承更大 credential set；
14. Experience-only 发布不改变 Agent compiled hash，Deployment promotion/rollback 固定精确 Release 组合；每个公开 handle 精确匹配 Agent Release 中的 binding/operation/input schema，错误/重复 handle 发布失败；
15. 评测重跑、模型/知识版本变化和未通过 gate 均产生独立可审计结果，不覆盖历史或授予生产权限；
16. promotion/rollback 的 `activation_epoch` 不会使已接受 Run 失效；Deployment SUSPENDED 递增 `revoke_epoch` 后永久 fence 旧 Run，重新 ACTIVE 只允许新 Run，REVOKED 不可恢复；
17. 嵌套 Flow/Skill Pack/SubAgent 的全部资源、凭据、egress、数据分类、operation 和副作用进入同一 canonical closure，父级不能放大子级；
18. Strategy 恢复不重新生成已采纳模型输出、不重复执行 Capability Call，且限制/终止原因可读回；
19. G1 Skill parser 拒绝 traversal/未知 manifest 字段并固定来源/hash；script 可验证但始终 inert，任何必需脚本执行的发布都显式失败，descriptor 不扩大 Binding；
20. 并发无依赖调用可以不同顺序提交，但 Run sequence 不重复、因果边完整、终态/计费去重键与已提交回放稳定。
21. 每种 Binding 只接受其 versioned closed config；错 kind/未知字段失败，G1 DB write、Flow/SubAgent detach 均在发布和 admission 失败；Agent Deployment mapping/entry grant 也只接受 closed discriminator，错 credential kind/principal/audience/channel/scope/Deployment kind 与 zero-or-many distinct target 全部在 Run/reservation/outbox 前失败；
22. G0/G1 对 `floating_latest/latest` 的 schema、publisher 与 admission 全部失败，不能用 compatibility approval 绕过；
23. `SIDE_EFFECT_UNKNOWN` 只产生一次 terminal `NEEDS_ATTENTION`；站外对账仅追加 correction/resolution，不 resume 或改写原 Run。
24. 并行 Flow 中某 Gate 到达时，candidate Worker 在同一 CAS 事务建立/加入 DRAINING barrier、停止全图新调度、提交 checkpoint 并将自己的可执行 lease handoff 给 host-only barrier owner，再 drain/checkpoint sibling、证明 active executable lease 为零、递增 fence 并在 waiting 事务释放 barrier owner；不存在“等待后再释放 candidate lease”或“lease 已释放但 barrier 未建立”的窗口，旧 Worker 迟到提交失败，unknown sibling 副作用优先进入 `NEEDS_ATTENTION`。
25. 同一 frontier 多个 Gate 按 canonical cohort 顺序串行物化，同时只有一个 `OPEN`；最后一个获批前 sibling 不恢复，reject/expire/cancel 只唤醒唯一 finalizer。
26. SubAgent 首次 dispatch 与 immutable context projection fact/outbox 原子提交；fact 固定 workspace、parent Run/Call/Attempt/fence、dispatch generation/outbox/intent identity、cursor/message hashes/tokenizer/truncation/serializer，summary 还固定 model/prompt/schema/accepted model attempt/usage attempt 与 usage identity/hash；复合 FK/唯一约束拒绝跨租户、旧 fence、同 generation 不同 intent 与 outbox/fact 错配，重放不重新投影、分配 generation 或计费。
27. Skill Pack 每个 exposed operation 只有一条 member path/pin/hash 路由；缺失或歧义在发布失败，runtime 不按局部 binding ID discovery。
28. Agent 准入原子要求 Deployment `ACTIVE` 并保存 `observed_revoke_epoch`；G0 production 永久 fail closed，G1 promotion 只消费与候选 revision/closure/evidence/当前 activation epoch 精确匹配的共享 `ProductionPromotionGateDecisionV1`。
29. Instruction Skill 只接受同 Workspace 的 `PublishedResourcePin<"INSTRUCTION_SKILL_RELEASE">`；裸 ID、错 kind、跨 Workspace、floating pin 均在发布失败。
30. Agent GateSpec 是 Release 内唯一、closed、不可变的发布物；Strategy 只能提交已固定 `gate_spec_id + gate_spec_hash + operation_intent`，缺失/错 hash/错 kind/未覆盖 operation 或运行时自报 approver/expiry/disposition 均失败。
31. G1 `join` child 的五种终态逐字按 `G1JoinChildTerminalOutcomeMapV1` 投影；特别是 child `NEEDS_ATTENTION` 同步把 parent Call/root Run 固定为 operator hold 并保留未知账务责任，重复 terminal Event 不二次结算。

模型反思、评测建议、用户反馈或自动优化只能创建 `ChangeProposal → Draft diff`。静态策略、上述 EvaluationRun 和人工审批通过后才能发布新 Release、再提升 Deployment；Run 不得原地写 Agent/Skill/Strategy/Experience published state。

### 8.3 回滚、删除和资源变更

- 回滚仅把稳定 `agent_deployment_id` 的独立 active pointer 切换到既有 Deployment revision；它不会修改 Agent/Experience Release、已接受 Run，也不会把其 Resource Pin 或 credential binding 改写为回滚后的版本。
- 已被 Release 引用的资源可进入撤销/归档状态，但不得物理删除其执行复现所需的最小 metadata、contract hash 和审计引用，直到保留期与合规流程允许清理。
- 若目标版本已不可安全执行（凭据被撤销、资源被删除、数据分类政策变更），后续 Call 明确失败/人工处置；不能静默回退到最新或另一个资源。

## 9. 与现有文档的衔接与实施边界

| 主题 | 本文决定 | 事实源 / 后续落点 |
|---|---|---|
| Flow 执行 | Agent Flow Binding 使用已发布 Flow pin；同步为带独立 FlowPlan 的 `FlowExecution`，异步为带预算 allocation 的 child Run | [Flow IR](./flow-ir-v1与运行时契约.md)、ADR-004 |
| 租户/凭据 | 任何 Release/Binding/Call 直接含 workspace 边界；运行时由受限认证和 RLS 建立 tenant context | [ADR-003](../adr/003-多租户与凭据模型.md) |
| 运行、事件与积分 | Agent 复用 Run/Attempt/Step/Event/Outbox/Reservation 事实模型，增加 target/Release/Binding 关联 | [ADR-004](../adr/004-持久化执行与计费.md) |
| HTTP/SSE | Chat API 接受时先固定 Deployment revision，再固定 Agent/Experience Release；SSE 只投影已持久化 Run 事件 | [API 契约](../06-API契约.md)、[SSE 契约](../api/SSE与异步操作契约.md) |
| 数据模型 | 以规范化 Release/Binding/授权决策/数据库操作/子 Agent 契约替换早期多态 JSON 草图 | [数据模型](../05-数据模型.md) |
| 平台对照 | Instruction Skill、Agent Strategy、Deployment、delegated credential、Human Gate 和 Eval Plane 的外部证据与采纳边界 | [五平台横向研究](../research/agent-platform-comparison-2026-08.md) |
| 发布与部署 | Agent/Skill/Strategy/Experience 分别发布；Deployment revision 固定环境/渠道组合、凭据映射和 promotion/rollback | 本文 3.4；后续新增数据模型/API/ADR 落点 |
| Strategy 运行 | 模型 Attempt、决策、checkpoint、终止和计费必须通过版本化 ABI 持久化 | [Agent Strategy ABI v1](./agent-runtime-strategy-v1.md) |
| 能力闭包 | Binding kind-safe target、嵌套依赖、egress/凭据/数据分类/副作用上限在发布时 canonical 闭合 | [Compiled Capability Closure v1](./compiled-capability-closure-v1.md) |

G0-02 已提供 Release/Binding/HumanGate 的结构化 Zod schema 与版本 registry，但尚未提供 canonical hash、publisher/compiler、SQL、执行器或 API 管理端点。后续仍须把本文逻辑关系转换为 ADR-003 兼容的复合外键/RLS migration、编译期交叉引用与 hash 校验、Plan/Run 集成测试和部署画像验收；在此之前不得报告为已上线功能或 admission 安全边界。

## 10. 未决项与获得证据的方式

下列项尚未公开或尚未实现，不能用推断填补：

| 未决项 | 为什么重要 | 获取/验证方式 |
|---|---|---|
| 主题权重的真实运行语义 | 决定能否做兼容性承诺 | 产品内调整权重并比较同一夹具多次结果、导出日志/Prompt 透视图 |
| “强制调用”顺序、空结果与失败降级 | 决定 Run 编排和用户错误表现 | 在产品调试日志对知识/插件/Flow 各做成功、空结果、超时实验 |
| 权限回调签名、缓存、撤销与超时 | 决定 SPI 与安全 profile 映射 | 获取官方调试记录/抓包和可复现回调测试；不在生产凭据上试错 |
| BetterYeah 独立 Skill 的资源模型 | 决定是否把本项目 `InstructionSkillRelease` 投影为 BetterYeah 兼容类型；通用过程 Skill 已建模，但不代表对方协议 | 收集官方页面、导出配置或官方 API/SDK schema；`R-A7` 未证实前维持 `instruction_skill`/`skill_pack` 的本项目扩展标签，不做兼容投影 |
| Agent/Plugin/KB 的竞品版本语义 | 仅决定未来是否值得另立 schema、迁移和独立 sealed safety envelope；G0/G1 仍只允许 secure pinned 行为 | 发布后修改依赖资源并重复调用，记录调用日志和资源版本；不得假设“最新”或“固定”，也不得把实验结果变成 G0/G1 compatibility 开关 |
| SubAgent 协议与异步语义 | 决定跨 Agent 授权、取消和账务边界 | 以官方 A2A 文档/抓包/受控 sandbox 测试获取；未证实前按本文安全契约实现 |
| 发布是否原子固定 Skill、文件、Knowledge index、子 Flow/Agent | 决定平台导入是否能映射为完整 dependency manifest | 分别导出已发布配置，在依赖更新/撤销后重跑旧版本并核对实际 revision；不能从“有版本历史”推断依赖已固定 |
| delegated/team/service credential 的子调用继承 | 决定父/子 Flow/Agent 的身份与源 ACL | 用两个用户、两个 scope、同步/异步子调用核对源系统和平台审计；默认重新授权且只允许有界委托 |
| Human Gate 的 claim、过期、并发 resume 和取消竞态 | 决定等待恢复是否会重复副作用 | 对同一 Gate 并发 approve/reject/cancel，在各提交点故障注入；通过标准是单一决策、可恢复且副作用至多一次 |
| 跨平台 Skill/Strategy 供应链 | 决定导入 `.skill`、脚本、依赖和签名的安全边界 | 固定 parser/manifest/signature/lockfile，使用恶意路径、secret、网络和依赖夹具；未通过前默认不执行脚本 |
