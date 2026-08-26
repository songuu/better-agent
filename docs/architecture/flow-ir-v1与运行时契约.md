# Flow IR v1 与运行时契约

> 状态：**契约冻结；G0-02 已实现结构 Schema、可达性与普通 DAG 校验，节点编译器/runtime 尚未实现**
> 适用范围：`packages/domain-contracts`、`packages/flow-ir`、`packages/flow-engine`、`apps/api`、`apps/worker`
> 关联：[Agent Release v1](./agent-release-v1与能力装配契约.md)、[Compiled Capability Closure v1](./compiled-capability-closure-v1.md)、[Agent Strategy ABI v1](./agent-runtime-strategy-v1.md)
> 规范关键词：**必须**、**不得**、**应**分别表示强制、禁止、建议。

## 1. 目的、继承项与新增决策

本文把 [04-技术架构](../04-技术架构.md) 中的 `Compile → Plan → Execute → Emit` 链路和 `NodeExecutor` 草案，落实为可实现、可测试、可恢复的 v1 契约；它也是 [07-实施计划](../07-实施计划.md) S1/S2、P1-1/P1-2 的冻结输入。

以下既有兼容行为继续有效，本文不改变其产品语义：

- 普通节点用 `{{path}}` 插值；逻辑分支和 Code 节点使用裸变量表达式。
- 分支自上而下短路，首个命中即止，末端为 Else；分支间节点不可互访。
- 子流程只可调用已发布 Flow，且为同步阻塞调用。
- Code 节点必须有 `main`，无返回值为 `null`，返回值必须可序列化。
- 循环必须有边界；运行需记录节点日志、积分和运行路径。

下列内容是为消除现有文档歧义而作的**新增决策**，实现必须以本文为准：

| ID | 新决策 | 原因 |
|---|---|---|
| N1 | 发布后的 Flow 使用不可变 `flow_version_id`；运行、子流程调用、恢复均钉住该版本。 | 仅有“发布/回退”不足以保证恢复时语义不漂移。 |
| N2 | 任意图中的普通边必须构成 DAG；分支和循环只能以结构化控制节点表达，禁止普通回边。 | 防止画布循环与运行时循环语义混杂。 |
| N3 | Plan 产生不可变运行快照；恢复不得重新读取草稿、环境变量、资源版本或输入。 | 使重试/接管可审计且可复现。 |
| N4 | 节点检查点、尝试、租约和副作用状态是独立持久化记录，不能只依赖一个 JSON `run_logs` 字段。 | 支持宕机恢复、精确计费与未知副作用隔离。 |
| N5 | 对外副作用节点未声明幂等性时不得自动重试；租约丢失后的未知副作用不得自动重放。 | 避免重复写第三方系统或重复扣费。 |
| N6 | `betterAI.store` 为单次运行私有的持久状态；并行写同一键在 v1 中失败，不采用不确定的最后写入获胜。 | 保持结果确定性。 |
| N7 | Human Input/Approval 是第一类持久 `HumanGate`；节点可以 `SUSPENDED`，并只能从已提交 checkpoint/resume cursor 恢复。 | 不能用占用 Worker 或 HTTP 长连接来表示人工等待。 |
| N8 | Run Event 保证单 Run `sequence` 严格递增和因果偏序；不保证独立并发节点的完成事件每次以相同相对顺序提交。 | 避免把调度时序错当业务确定性。 |
| N9 | Flow 编译必须产生传递性 `CompiledCapabilityClosure`，嵌套子流程、工具和数据资源只能被父级收窄。 | 防止 Agent 只检查顶层 Flow Binding 而被内部节点扩权。 |

## 2. 版本、术语与不变量

| 术语 | 含义 |
|---|---|
| Flow 草稿 | 可编辑的画布定义，不可被运行直接引用。 |
| Flow 版本 | 发布时由草稿规范化得到的不可变 IR，标识为 UUIDv7 `flow_version_id`。 |
| 编译产物 | 静态校验通过后的 canonical IR、类型表、资源清单、拓扑计划和 `compiled_hash`。 |
| 顶层 Flow Run | 一次直接接受的 Flow 执行，标识为 UUIDv7 `run_id`。一个顶层 Flow Run 只对应一个 `flow_version_id`。 |
| FlowExecution | Agent Run 内同步调用 Flow 时的嵌套执行，固定 `flow_execution_id`、`flow_version_id`、`flow_plan_hash` 与 `scope_path`；它复用 root Run 的事件/账务事实源，但不是顶层 Flow Run。 |
| Attempt | 同一节点的一次真实执行尝试；首次也是 attempt 1。 |
| Checkpoint | 已提交且可用于恢复的节点结果或控制状态。 |
| GateSpec / HumanGate | 发布时的类型化等待规格，以及运行时从它物化出的持久、可幂等 claim 的人工任务。 |
| 结构化子图 | 分支 case、Else、循环 body 中嵌套的有向图。 |

发布版本必须满足以下不变量：

1. `flow_version_id`、canonical IR、`compiled_hash`、节点 `key`、端口名和输出 schema 一经发布不得更新或删除。
2. 编辑、环境变量变更、资源重新发布只能产生后续版本；不得改变已存在 Run 的快照。
3. `compiled_hash` 是 canonical JSON（键排序、无展示字段、UTF-8）的 SHA-256；它用于缓存键和审计，不得包含密钥明文。
4. 一个顶层 Flow Run 的所有事件、检查点、积分预留和重试均带同一个 `run_id`；首次接受该逻辑请求时固定 `accepted_request_id`。Agent 内的同步 Flow 额外以 `flow_execution_id` 区分 checkpoint/step scope，但不创建第二个 Run 或 Reservation。每一次 HTTP 请求/幂等重放另有自己的 `request_id`，只进入响应和审计，不得覆写 Run 的首次接受标识。

### 2.1 顶层 Flow 的 Deployment 与 Admission Profile

顶层 Flow 的公开调用不能借用 Agent Deployment，也不能从 Workspace 默认 credential、可变环境或调用者提交的 credential ID 补齐资源。它使用独立、类型化的稳定 Flow Deployment：

```ts
type FlowDeploymentChannelV1 = "service_api" | "internal_preview";

interface FlowDeploymentRevisionV1 {
  schema_version: "flow-deployment/1";
  deployment_kind: "flow";
  workspace_id: string;
  flow_deployment_id: string;
  flow_deployment_revision_id: string;
  flow_id: string;
  environment: "development" | "staging" | "production";
  ingress_channel: FlowDeploymentChannelV1;
  flow_version: PublishedResourcePinV1 & { published_resource_kind: "FLOW_VERSION" };
  policy_profile: ImmutableDeploymentPolicyPinV1 & { policy_kind: "deployment_profile" };
  entry_grant_policy: ImmutableDeploymentPolicyPinV1 & { policy_kind: "entry_grant" };
  entry_scope_policy: ImmutableDeploymentPolicyPinV1 & { policy_kind: "entry_scope" };
  credential_mappings: FlowDeploymentCredentialMappingV1[];
  credential_mapping_hash: string;
  dependency_manifest_hash: string;
  change_set_hash: string;
  revision_contract_hash: string; // SHA-256(JCS(candidate revision excluding this field))
}

interface FlowDeploymentCredentialMappingBaseV1 {
  schema_version: "flow-deployment-credential-mapping/1";
  requirement_id: string;
  provider_id: string;
  audience: string;
  credential_policy: ImmutableDeploymentPolicyPinV1;
  allowed_scopes: [string, ...string[]];
  mapping_hash: string; // SHA-256(JCS(mapping excluding this field))
}

type FlowDeploymentCredentialMappingV1 = FlowDeploymentCredentialMappingBaseV1 & (
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

interface FlowDeploymentActivePointerV1 {
  flow_deployment_id: string;
  active_revision_id: string;
  activation_epoch: number; // 只用于 promotion/rollback CAS 与准入审计
}

interface FlowDeploymentSecurityStateV1 {
  flow_deployment_id: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  revoke_epoch: number; // 单调永久 fence
}

type FlowServiceApiEntryScopeV1 =
  | "flow:run:create"
  | "run:read"
  | "run:cancel"
  | "run:resume"
  | "run:events:read";

interface FlowDeploymentEntryGrantV1 {
  schema_version: "flow-deployment-entry-grant/1";
  entry_grant_id: string;
  workspace_id: string;
  credential_id: string;
  credential_kind: "service_api";
  principal_mode: "credential_service_principal";
  entry_audience: "flow_runtime_api";
  flow_deployment_id: string;
  ingress_channel: "service_api";
  scope: FlowServiceApiEntryScopeV1;
  target_cardinality: "exactly_one_flow_deployment";
  status: "ACTIVE" | "REVOKED";
  authorization_epoch: number;
  not_before_at?: string;
  expires_at?: string;
  revoked_at?: string;
}

interface FlowDeploymentEntryAdmissionSnapshotV1 {
  schema_version: "flow-deployment-entry-admission-snapshot/1";
  deployment_kind: "flow";
  entry_source_kind: "service_credential";
  workspace_id: string;
  flow_deployment_id: string;
  flow_deployment_revision_id: string;
  flow_deployment_revision_contract_hash: string;
  flow_version: PublishedResourcePinV1 & { published_resource_kind: "FLOW_VERSION" };
  admission_activation_epoch: number;
  observed_revoke_epoch: number;
  authenticated_principal: CallerPrincipalV1 & { kind: "credential" };
  credential_id: string;
  credential_authorization_epoch: number;
  workspace_authorization_epoch: number;
  entry_grant_id: string;
  entry_grant_authorization_epoch: number;
  entry_credential_kind: "service_api";
  entry_principal_mode: "credential_service_principal";
  entry_audience: "flow_runtime_api";
  entry_channel: "service_api";
  entry_scope: FlowServiceApiEntryScopeV1;
  entry_target_cardinality: "exactly_one_flow_deployment";
  policy_profile_contract_hash: string;
  entry_scope_policy_contract_hash: string;
  credential_mapping_hash: string;
  dependency_manifest_hash: string;
  snapshot_hash: string;
}
```

- `FlowDeploymentRevisionV1` 是不可变候选物；stable Flow Deployment 固定 `workspace + flow + environment + ingress_channel + public selector`，revision 的同名轴必须逐字相等，跨环境/渠道创建新 Deployment。entry scope policy 与 credential mappings 随 revision 固定并进入 hash；所有 policy ref 是同 Workspace immutable typed pin。`revision_contract_hash` 覆盖除自身外的完整 canonical candidate，并作为共享 production promotion key 的 `candidate_revision_contract_hash`。`FlowDeploymentCredentialMappingV1` 是 closed 判别 union：每个 Flow Version 的 `requirement_id` 唯一并恰好匹配一条 mapping，`provider_id/audience` 逐字相等，G0 `allowed_scopes` 与 `required_scopes` 集合精确相等，`principal_mode` 只与对应 policy kind/source/principal 字段组合；它不保存 secret material。
- `FlowDeploymentEntryGrantV1` 是独立、closed、类型化授权 source，合法 tuple 固定 `service_api + credential_service_principal + flow_runtime_api + service_api + FlowServiceApiEntryScopeV1 + exactly_one_flow_deployment`。`flow:run:create` 用于 direct Flow 创建；四个 `run:*` scope只用于 G0-06 已固定原 Flow target 的 read/cancel/resume/events，不重新选择 Deployment。credential、grant 与 stable Flow Deployment 必须同 Workspace；它不能引用 Agent Deployment、publish credential、管理 preview 身份或通用 release grant。
- G0-05 公开 direct Flow resolver在同一事务锁定唯一 active pointer/security state，要求 `ACTIVE` 并把同一锁下的 revoke epoch保存进只读 `FlowDeploymentEntryAdmissionSnapshotV1`；snapshot不含 Run、resolved credential、closure或effective policy。G0-06 才在 Run/reservation/outbox同事务持久化 snapshot，G1-01 再生成完整 `FlowAdmissionProfileV1`/RunPlan。四个 `original_run_only` operation 的真实 Run readback归 G0-06/G0-08；G0-05只提供 target-bound owner-private resolver seam。
- 客户端不得直接指定 `flow_version_id`、revision、entry grant 或 credential。只有隔离的内部 preview/test 路径可用管理身份指定未激活 revision，并且不能复用生产 entry credential。
- active pointer promotion/rollback 不影响已接受 Run；不可变 `FlowDeploymentRevisionV1` 及 mapping 只以 revision/mapping hash 固定进 Plan，没有 status/revoke epoch，不能成为第二个可变安全状态源。唯一 Deployment revoke fence 来自稳定 `FlowDeploymentSecurityStateV1`：`ACTIVE → SUSPENDED|REVOKED` 原子递增 `revoke_epoch`，`REVOKED` 不可恢复。`SUSPENDED → ACTIVE` 不回退 epoch：旧 Run 的 observed 值永久失配，新 Run 才能按新值准入。
- Flow production activation 与 Agent 共用 [Compiled Capability Closure v1 5.4](./compiled-capability-closure-v1.md#54-agentflow-共享的-production-promotion-gate) 唯一的 `ProductionPromotionGateDecisionV1` canonical key、状态、失效和单次消费 CAS；不得另立 Flow-only approval 或只凭 EvaluationRun ID 切 pointer。G0 只允许 development/staging active pointer，production pointer 的 INSERT/UPDATE/promotion 无条件 fail closed；G1 gate 落地后，受限函数仍须逐字匹配 candidate Flow Deployment revision contract、Flow Version pin、dependency/closure/evidence hashes 与当前 expected activation epoch，并在同一事务消费 decision。
- Agent 内嵌 Flow 不解析 Flow Deployment；它使用父 Agent Deployment/ResolvedAgentPlan 已固定的 credential mapping、entry principal 与 closure 上限，再为固定 Flow pin 产生子 `FlowPlan`。这两条准入路径不得互相回退。

## 3. Flow IR v1

### 3.1 文档外形

IR 的 `schema_version` 固定为 `flow-ir/1`。展示标题、画布坐标、折叠状态等编辑器信息可保留在 `ui`，但不参与编译哈希，也不得影响执行。

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

interface FlowIrV1 {
  schema_version: "flow-ir/1";
  flow_id: string;
  flow_version_id: string;
  title: string;
  entry_graph: FlowGraph;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  resources: PublishedResourcePin[];
  credential_requirements: CredentialRequirementV1[];
  execution_defaults: ExecutionDefaults;
  ui?: JsonValue; // 非语义字段；编译时剔除
}

interface FlowGraph {
  graph_id: string;              // 根图为 "root"，子图全局唯一
  entry_node_id: string;
  exit_node_ids: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface FlowEdge {
  edge_id: string;
  from: { node_id: string; port: string };
  to: { node_id: string; port: string };
  kind: "data" | "control";
}

interface NodeBase<T extends string, C> {
  node_id: string;               // UUID；仅机器身份
  key: string;                   // 版本内稳定、可在表达式使用，如 llm_1
  type: T;
  config: C;
  inputs: Record<string, ValueBinding>;
  output_schema: JsonSchema;
  retry?: RetryPolicy;
  error_policy?: ErrorPolicy;
  timeout_ms?: number;
}
```

`key` 必须匹配 `[A-Za-z_][A-Za-z0-9_]{0,63}`，同一图内唯一；显示名称不作为变量名。兼容既有 `start.content`、`llm_1` 风格时，发布器须把画布名称规范化为 `key` 并在发布前提示冲突。

### 3.2 普通节点与有向图规则

`FlowNode` 包含业务动作节点（`start`、`output`、`llm`、`api`、`code`、`knowledge`、`text`、`intent`、`classifier` 等）以及下文的分支、循环、子流程和 `human_gate` 控制节点。G0-02 的公共结构 Schema 当前由 `packages/domain-contracts` 导出；各 action-specific config 在对应能力任务冻结后进入唯一 registry，未来如提取 `packages/flow-ir` 也只能迁移 owner，不能由 Studio 或执行器复制定义。

根图和每一个结构化子图都必须满足：

- 根图的唯一入口必须是唯一的 `start` 节点；结构化子图不得再声明 `start`，其入口从父控制节点获得受限作用域。
- 恰有一个 `entry_node_id`，并且它可达所有执行节点；不可达节点是发布错误。
- `exit_node_ids` 至少一个；`output` 节点只能位于根图的退出路径。
- 将 `branch`、`loop`、`subflow`、`human_gate` 视作原子节点后，普通 `control` 边必须是 DAG；禁止 `A → … → A` 普通回边。
- 端口存在、边的源/目标类型兼容、必填输入均为发布前静态校验项；一条输入端口只能有一个数据来源，除非节点 schema 显式声明 `many: true`。
- `data` 边只声明依赖和类型来源，不触发执行；节点就绪由 `control` 前驱全部完成以及输入可解析共同决定。
- 多个可并行就绪节点可并发执行，但其并发度由 Plan 限制；控制节点的内部语义不得由通用拓扑排序猜测。

### 3.3 分支：显式、短路、隔离

分支不是带任意回连的普通节点，而是一个封闭的结构化控制节点：

```ts
interface BranchNode extends NodeBase<"branch", BranchConfig> {}
interface BranchConfig {
  expression_language: "js-expression-v1";
  cases: Array<{
    case_id: string;
    when: string;                // 裸变量表达式；按数组顺序求值
    graph: FlowGraph;
    exports: Record<string, ValueBinding>; // case 内值 -> branch 输出字段
  }>;
  else_case: {
    graph: FlowGraph;
    exports: Record<string, ValueBinding>;
  };
}
```

执行器必须按 `cases` 的数组顺序求值，第一个返回严格布尔值 `true` 的 case 获胜；其余 case 和 Else 均不得启动。没有命中时必须执行 `else_case`，不得把“无条件”当作静默成功。每个 case/Else 的 `graph` 均是独立作用域，只可访问祖先作用域和本分支内已完成节点；不同分支的节点、输出和 `store` 写入不互相可见。

分支的可见输出仅为 `exports` 明确导出的字段，并挂载为 `branchKey.outputName`。任一 case 未能提供要求的导出字段是编译错误，不能以 `null` 猜测补齐。条件表达式失败、非布尔或超时均为 `BRANCH_EVALUATION_FAILED`。

### 3.4 循环：有界结构，而不是回边

```ts
interface LoopNode extends NodeBase<"loop", LoopConfig> {}
interface LoopConfig {
  mode: "collection" | "condition";
  max_iterations: number;        // 1..10_000，发布时必填
  collection?: ValueBinding;     // mode=collection 时必填，数组或对象数组
  continue_when?: string;        // mode=condition 时必填，js-expression-v1
  item_name?: string;            // collection 默认 item
  index_name?: string;           // collection 默认 index
  body: FlowGraph;
  break_when?: string;           // 每轮 body 后求值；true 即停止
  exports: Record<string, LoopExport>;
}
```

- collection 循环按输入顺序串行运行；condition 循环先判断 `continue_when` 再运行 body。v1 不提供并行循环。
- 每一轮的作用域为 `loopKey.iterations[index]`，含只读 `item`、`index`、祖先变量和本轮输出；下一轮不能隐式读取上一轮局部变量。
- 跨轮数据必须通过 `exports` 中的 `collect`、`last` 或 `reduce` 显式产生。`reduce` 必须给出初值和受限表达式，不能执行任意代码。
- 达到 `max_iterations` 仍未满足停止条件时，Run 以 `LOOP_LIMIT_EXCEEDED` 失败；不得把该情况标为成功或无限重试。
- 循环 body 可以嵌套分支、子流程、另一循环；其自身普通图仍必须是 DAG。

### 3.5 子流程：发布版本钉住与递归禁止

```ts
interface SubflowNode extends NodeBase<"subflow", SubflowConfig> {}
interface SubflowConfig {
  target: { flow_id: string; flow_version_id: string };
  inputs: Record<string, ValueBinding>;
  output_mapping: Record<string, string>; // 被调 Flow 输出名 -> 本节点输出名
  invocation: "sync";                    // v1 固定同步阻塞
}
```

`flow_version_id` 必须是已发布且已编译的版本；“按最新发布版本”不是 v1 合法值。编译器必须构建版本级调用图，直接或间接递归均以 `SUBFLOW_RECURSION_FORBIDDEN` 拒绝发布。被调版本的输入/输出 schema 必须在发布时兼容，运行时不得依据最新草稿重新解析。子流程的内部节点事件带 `scope_path`，但不改写父 Run 的 `run_id`。

### 3.6 资源固定

`CredentialRequirementV1` 使用 [Agent Release v1](./agent-release-v1与能力装配契约.md) 冻结的共享 closed 定义，`PublishedResourcePin` 使用 [Compiled Capability Closure v1](./compiled-capability-closure-v1.md) 的唯一共享定义；pin 至少含 `workspace_id`、`published_resource_kind`、`resource_id`、`resource_version_id`、`contract_hash`。模型别名、知识库 generation、数据库 operation release、插件工具 release、提示词资产、子流程版本和环境配置均必须以 workspace-scoped、类型化 pin 进入编译产物。Flow Release/IR 只声明 `CredentialRequirementV1` 或 requirement ID，不保存 `secret_ref`、secret material、token 或连接串；顶层 Flow 准入由固定 `FlowDeploymentRevisionV1/FlowAdmissionProfileV1` 解析，Agent 内嵌 Flow 则由父 ResolvedAgentPlan 解析，二者都只向执行器提供不透明 credential handle 和非秘密指纹。本文的 `RunCtx.secrets` 仅表示可信执行器中的运行时 `SecretResolver`；该 handle/material 绝不可进入 IR、compiled hash、模型上下文、事件或日志。Flow 的直接与递归资源必须编译为 [Compiled Capability Closure v1](./compiled-capability-closure-v1.md)；运行时不得只验证顶层 `FLOW_VERSION` 后信任内部节点。

### 3.7 HumanGate：持久 suspend，不是长连接

```ts
interface HumanGateNode extends NodeBase<"human_gate", HumanGateNodeConfig> {}

interface HumanGateNodeConfig {
  gate: GateSpecV1;
  prompt: ValueBinding;
  operation_intent?: ValueBinding; // approval 时必填，用于生成 canonical hash
  exports: Record<string, string>; // 已验证的 decision/input 字段 -> 节点输出
}

interface GateSpecBaseV1 {
  schema_version: "human-gate/1";
  gate_spec_id: string; // Flow Version 内唯一
  decision_schema: JsonSchema;
  decision_schema_hash: string;
  approver_policy_ref: string;
  approver_policy_hash: string;
  expires_after_seconds: number;
  notification_profile_ref?: string;
  notification_profile_hash?: string;
  on_reject: "fail_run" | "cancel_run";
  on_expire: "fail_run" | "cancel_run";
  gate_spec_hash: string; // SHA-256(JCS(spec excluding this field))
}

type GateSpecV1 = GateSpecBaseV1 & (
  | { kind: "input"; protected_operation_contract_hashes: [] }
  | { kind: "approval"; protected_operation_contract_hashes: [string, ...string[]] }
);

interface GateBarrierV1 {
  schema_version: "human-gate-barrier/1";
  barrier_id: string;
  run_id: string;
  source_execution_fence: number;
  quiesced_execution_fence?: number; // 完成全图 drain 后原子递增并固定
  barrier_version: number;
  phase: "DRAINING" | "WAITING" | "RESUMING" | "FINALIZING" | "FINALIZED";
  barrier_owner: {
    generation: number;
    state: "CONTROL_OWNED" | "RELEASED";
  };
  candidate_lease_handoffs: {
    source_step_id: string;
    source_attempt_id: string;
    source_worker_lease_id: string;
    source_execution_fence: number;
    checkpoint_ref: string;
    state: "RELINQUISHED";
  }[];
  frontier_checkpoint_hash?: string;
  resume_dispatch_id?: string; // 仅最后一个 Gate APPROVE 时固定
  finalizer_generation: number;
  candidates: {
    order_key: string; // scope path + compiled topology rank + node_id + GateSpec hash
    flow_execution_id: string;
    step_id: string;
    gate_spec_id: string;
    gate_spec_hash: string;
    checkpoint_ref: string;
    resume_cursor: string;
    state: "DEFERRED" | "OPEN" | "APPROVED" | "DROPPED";
    gate_id?: string; // state=OPEN|APPROVED 时存在
  }[];
}
```

- `GateSpecV1` 是 Flow Version 中的不可变、closed 判别 union；`gate_spec_id` 在版本内唯一，decision schema 与 approver policy 都必须携带可读回的精确 hash，notification ref/hash 必须同时存在或同时缺失，`input` 必须携带空 protected-operation 集，`approval` 必须携带非空的精确 operation contract hash allow-set。`gate_spec_hash` 覆盖 kind、decision schema、approver policy、expiry、notification、disposition 与 allow-set，并与 source Flow resource node/canonical node path 一起进入 compiled hash/Compiled Capability Closure。它不包含运行时 `gate_id`、实际审批人或客户端自选策略。`approval` 必须从已解析输入生成待执行操作的 canonical intent hash，并逐字命中该 allow-set；审批只覆盖该 hash，不授予后续步骤或更大 scope。当前 approver policy 的撤销/epoch 可以收窄 claim，但不能替换已发布 pin 或 disposition。
- 执行到该节点时，执行器以 `SUSPENDED` candidate 把已解析 `GateSpecV1`、checkpoint 和唯一 `resume_cursor` 交回运行时；它无权局部地直接把 Run 写成 waiting。candidate Worker 必须在**同一个 Run/Step/barrier CAS 事务**创建或加入唯一 `GateBarrierV1`、把 phase 置为 `DRAINING`、停止 root Run 下全部 scope/嵌套 FlowExecution 领取新节点、冻结 runnable frontier、提交 checkpoint，并把自己的可执行 lease 从 `(source_step_id, source_attempt_id, source_execution_fence)` 原子标记为 `RELINQUISHED`、追加唯一 `candidate_lease_handoffs[]`；首个 candidate 同事务建立 host-only `barrier_owner.generation/state="CONTROL_OWNED"`，后续 candidate 必须命中相同 source fence/owner generation。owner 只允许 drain/fence/物化 Gate，不计入 active executable lease，也不能执行节点或产生业务 dispatch。任一步失败整体回滚，candidate 未被接受且不存在“lease 已释放但 barrier 未建立”的窗口。quiescence 完成前 Run 仍投影 `RUNNING`（已有取消意图时为 `CANCEL_REQUESTED`）。
- 旧 fence 下已经运行的 sibling 必须在有界 drain 窗口内提交终态 checkpoint，或由声明支持安全暂停的 executor 提交 `barrier_checkpoint_ref + resume_cursor` 后释放其可执行 lease；不可取消的在途请求必须先提交可验证结果/回执。结果未知立即以 `SIDE_EFFECT_UNKNOWN/NEEDS_ATTENTION` 终结，无法在期限内安全 drain 则按 timeout/cancel 终结，均不得物化 Gate。“active leases 为零”明确指全图 active **executable** Worker leases：所有 candidate 已各自通过唯一 handoff 退出该集合，barrier owner 不计入。只有 active executable leases、待 dispatch outbox 和未对账 attempts 全部为零，匹配同一 `barrier_owner.generation` 的 host 才在 waiting 事务保存完整 frontier hash、递增 execution fence 使所有旧 Worker 迟到写失效、物化 waiting 事实，并把 `barrier_owner.state` 置为 `RELEASED`。
- 同一 source fence 的并行节点可以产生多个 candidate，但 G1 每个 Run 同时至多一个 `OPEN` HumanGate。barrier 按 `scope path + compiled topology rank + node_id + GateSpec hash` 排序形成不可变 cohort，只将第一项物化为 HumanGate，其余保持 `DEFERRED`。APPROVE 以后若仍有 candidate，CAS 物化下一 Gate 且全图继续 quiescent；只有 cohort 全部批准后才以新 fence 从保存 frontier 恢复 siblings。任一 reject/expire/Run cancel 将剩余 candidate 标为 `DROPPED` 并进入对应唯一 finalizer，不能绕过前一 Gate 或选择性恢复其他分支。
- waiting 提交事务必须同时写 barrier/Step/FlowExecution checkpoints、当前 HumanGate、Run `WAITING_FOR_INPUT|WAITING_FOR_APPROVAL`、waiting Event 与通知 Outbox，并释放 host-only barrier owner。candidate Worker lease 已在 handoff 事务释放，不能在 waiting 后再次释放。resume 只可 CAS 当前 `gate_id + barrier_version`；最后一个 Gate 批准时在一个事务把 barrier/Run/Steps 切为 `RESUMING` 并写唯一 resume Outbox，Worker 只能从 barrier 保存的 frontier/cursors 继续。
- 等待期间不保留数据库事务、Worker 进程、模型请求或 HTTP/SSE 连接。SSE 只投影已提交 waiting Event；重连不会触发 resume。
- resume/decision mutation 必须先认证并确认当前主体可读取 Run，再锁定固定 route 的 mutation idempotency fact：命中时只比较 canonical intent 并重放首次 receipt，不重新检查当前 Gate、授权或过期状态。仅 miss 时才验证决策 schema、approver policy、Gate OPEN/未过期/未取消、原 Plan/closure、credential/resource epoch、预算和 canonical operation hash，再以 `gate_id + barrier_version` 条件更新 claim Gate。APPROVE 事务必须固定 Gate `APPROVED`、decision hash 和 mutation receipt；若 cohort 仍有 deferred candidate，则以 canonical 次序物化下一个 `OPEN` Gate、写下一条通知 Outbox 并保持 barrier/Run 全图 quiescent 的 `WAITING_FOR_*`，不得写 resume Outbox 或领取 Worker lease。只有最后一个 Gate 的 APPROVE 才可在同一事务把 barrier/Run/Steps 切到 `RESUMING`，并从已保存的完整 frontier/checkpoints/cursors 写唯一 resume Outbox；Worker 不能重跑 gate 前节点或重新解析最新 Flow。REJECT/EXPIRE 只固定 Gate `REJECTED/EXPIRED`、已发布 disposition、mutation receipt 和 terminal intent，丢弃 deferred candidates 并唤醒唯一全图 finalizer；不得由 mutation 直接写 Run/Step 终态或 terminal outbox。若 Gate 前已有未知外部副作用，finalizer 必须优先收敛到 `NEEDS_ATTENTION`，不得用 disposition 覆盖责任未知状态。
- reject、expire、cancel 与 approve 竞争时只有一个 `Run + Gate + barrier_version` 条件转换可提交。terminal intent 只能唤醒以 `run_id + finalizer_generation` 唯一的全图 finalizer；finalizer 必须再次 fence 调度、证明所有 scope quiescent，并以 `terminal_event_sequence IS NULL` CAS 一次性关闭/保留 Gate、drop deferred candidates、终结所有非终态 Step、处理账务和写唯一 terminal snapshot/Event。重复 decision/finalizer/outbox 只重放首次结果，不得创建第二个 attempt、terminal Event、settlement 或已批准副作用。

## 4. 变量、表达式与数据边界

### 4.1 作用域

运行时从外到内按以下顺序查找变量：

1. `start`：已通过 `input_schema` 验证的请求输入；Webhook payload 也固定挂在 `start`。
2. 根图已完成节点输出：`<node.key>.<field>`；节点输出一旦提交即只读。
3. 当前 branch 或 loop 局部作用域；只有显式 `exports` 能离开该作用域。
4. `betterAI.store`：本 Run 私有、持久化的键值空间。
5. `session`：会话 API 的受控快照；不得把整个会话历史自动注入任意节点。
6. `env`：Plan 已解析的只读非敏感配置。密钥只能通过 `secret_ref` 在执行器内使用。

普通配置字段只接受 `{{path.to.value}}` 插值。插值器不得执行 JavaScript、不得访问未列入作用域的键，并且必须在节点实际执行前完成类型/缺失值检查。逻辑分支条件使用 `js-expression-v1` 的纯 AST 子集：JSON 字面量、合法变量/自有属性路径、括号、`!`、比较运算、`&&`、`||`、`??` 和三元表达式；禁止赋值、函数调用、构造器、原型访问、动态 import、全局对象和任意计算属性。Code 的 `main` 使用单独的 Code 沙箱裸变量绑定。两者输入中出现 `{{...}}` 必须报 `TEMPLATE_SYNTAX_NOT_ALLOWED`，不能兼容性地二次解析。

### 4.2 `betterAI.store`

`get/set` 的生命周期仅覆盖一个 `run_id`。每次 `set` 作为带 sequence 的持久 mutation 提交；值须为 JSON 可序列化且受单值/总量配额限制。执行器在 Plan 中声明 `store_access: none | read | write`：有写入可能的节点不得与同键写入节点并行。动态键导致无法静态证明安全时，运行时以 `STORE_WRITE_CONFLICT` 失败并保留两方检查点，不得使用最后写入获胜。

## 5. Compile、Plan、Execute

### 5.1 Compile

`compile(flow_version_id)` 纯计算、无网络副作用，输出 `CompiledFlow`。它必须完成：

- IR schema、节点 config、端口、输入/输出类型、可达性、唯一 `key` 和普通 DAG 校验；
- 分支 Else、短路顺序、隔离出口、循环上限与嵌套深度校验；
- 模板路径和裸变量引用的作用域/类型校验；
- 子流程版本、调用图无环、资源 pin 与工具 schema 校验，并将直接/递归依赖合并为 canonical `CompiledCapabilityClosure`；
- HumanGate 的 version-local `gate_spec_id` 唯一，decision schema、approver policy ref、过期/拒绝路径、operation intent 与 exports 静态可验证；编译器必须验证 `gate_spec_hash`，为每个 Gate 生成全局稳定 topology rank，并把 source resource node/canonical node path/spec 写入 closure；同时验证所有可并行 executor 的 drain/安全 checkpoint 和 barrier-owner lease handoff 能力与有界 barrier timeout；无法安全达到全图 quiescence 的 Flow 不得发布；
- 凭据路径污点检查：CredentialRequirement 所对应的运行时 SecretResolver 值、认证头和访问密钥不得流向 LLM prompt、输出节点、日志字段或不受信任 API 参数；
- 生成稳定拓扑序、节点副作用清单、所需权限、最大执行预算、`capability_closure_hash` 和 `compiled_hash`。

任何校验失败均不得发布，也不得创建 Run。编译缓存键为 `flow_version_id + compiled_hash`；缓存未命中仅影响性能，不能改变结果。

### 5.2 Plan

顶层入口的 `plan(compiled_flow, flow_admission_profile, request)` 在创建顶层 Flow Run 时原子完成，且在实际调用节点前完成积分预留。它必须：

1. 生成 `run_id`，绑定调用方、`accepted_request_id`、`flow_deployment_id/revision_id`、`FlowAdmissionProfileV1.profile_hash`、`admission_activation_epoch`、`observed_revoke_epoch`、`flow_version_id`、`compiled_hash`、`capability_closure_hash` 和输入哈希；
2. 在同一事务锁定 active pointer 与 security state，要求 `status="ACTIVE"` 且当前 `revoke_epoch` 等于将保存的 `observed_revoke_epoch`，再原子校验 active revision、entry grant/policy、主体、输入 schema、并发/配额和取消前状态；
3. 将 closure 与 admission profile 再取交集，并快照实际 credential binding 摘要、非敏感环境值、资源 revision、模型路由选择、超时、重试和预算；任何 requirement 无精确 mapping、scope 扩大或 epoch 不一致都拒绝；
4. 创建 `run`、初始 `run_step`、积分 reservation 与 outbox 事件；
5. 返回只读 `RunPlan`。Plan 不得执行插件、模型、HTTP、代码或写业务数据。

Plan 成功后出现容量不足、队列不可用等问题属于运行故障，不得回写或修改 Flow 版本。Plan 失败必须释放未使用的预留并产生可审计错误。

Agent 同步 Flow 不调用顶层入口 Plan：它在 Agent 的 ResolvedAgentPlan 中创建 `FlowExecution` 与其子 `FlowPlan`，固定相同字段并引用 root Run 的预算/授权上限。它不得改写 root Run 的 `target_kind`/`flow_version_pin`，也不得另建 Workspace reservation；异步 Flow 则按 Agent 契约创建具父链接与预算 allocation 的 child Run。

### 5.3 Execute 与节点接口

执行器从 durable `RunPlan` 读取就绪节点，领取带 TTL 的运行租约，并在每个终态步骤后提交检查点和 outbox 事件。同一 `run_id + flow_execution_id + scope_path + node_id + attempt` 同时只能有一个有效租约。

```ts
interface NodeExecutor<C = unknown> {
  readonly type: NodeType;
  validate(config: C, ctx: CompileCtx): ValidationResult;
  plan?(config: C, ctx: PlanCtx): NodePlan; // 不执行外部副作用
  execute(config: C, ctx: RunCtx): Promise<NodeResult>;
  compensate?(ctx: CompensationCtx): Promise<void>; // v1 仅显式支持的节点
}

interface RunCtx {
  run_id: string;
  flow_execution_id: string; // 顶层 Flow Run 的根执行或 Agent 内嵌执行的稳定身份
  scope_path: string;
  attempt: number;
  vars: ReadonlyVarScope;
  resolve(template: string, mode: "interpolated" | "bare"): unknown;
  session: SessionApi;
  store: RunStoreApi;
  credits: CreditsMeter;
  signal: AbortSignal;
  checkpoint: CheckpointWriter;
  secrets: SecretResolver; // 仅可信执行器可用；Release/IR 不持有 ref/material
}

type NodeResult =
  | { status: "SUCCEEDED"; output: JsonValue; usage?: Usage; side_effect?: SideEffectReceipt }
  | { status: "SKIPPED"; reason: string }
  | {
      status: "SUSPENDED";
      gate: ResolvedGateSpec;
      checkpoint: CheckpointPayload;
      resume_cursor: string;
    }
  | {
      status: "NEEDS_ATTENTION";
      error: RunError & { category: "SIDE_EFFECT_UNKNOWN" };
      side_effect: SideEffectReceipt;
    }
  | { status: "FAILED"; error: RunError; side_effect?: SideEffectReceipt };
```

`execute` 必须在超时、取消、重试和错误策略之外保持幂等可观测：不得自行吞错、不得自行写最终 Run 状态、不得泄漏 secrets。节点完成时写入的 checkpoint 至少含输入摘要、输出或安全引用、资源 pin、attempt、耗时、积分和副作用回执摘要。`SUSPENDED` 是已成功到达持久等待点的控制结果，不是 `FAILED`，不应消耗通用重试次数。

`NodeResult.status` 与共享 `StepStatusV1` 同名值逐字映射：`SUCCEEDED|SKIPPED|FAILED|NEEDS_ATTENTION` 均为 Step 终态，`SUSPENDED` 是持久等待态。超时/取消由 host 分别把 Run 映射为 `TIMED_OUT/CANCELLED`，并把尚未终结的当前 Step 映射为 `CANCELLED`；执行器不得自行发明 `TIMED_OUT` Step 状态。

## 6. 错误、重试、取消与恢复

### 6.1 错误与策略

所有运行错误使用 `{ code, message, retryable, category, details? }`，其中 `details` 必须脱敏。`category` 固定为 `VALIDATION`、`RESOLUTION`、`POLICY`、`CANCELLED`、`TIMEOUT`、`UPSTREAM_TRANSIENT`、`UPSTREAM_PERMANENT`、`SIDE_EFFECT_UNKNOWN`、`INTERNAL`。

```ts
interface RetryPolicy {
  max_attempts: number;  // 包含首次，默认 1，最大 5
  backoff: "fixed" | "exponential";
  initial_delay_ms?: number;
  max_delay_ms?: number;
}

type ErrorPolicy =
  | { mode: "fail" }
  | { mode: "continue_with"; output: JsonValue };
```

仅 `llm`、`api`、`code`、`knowledge` 四类节点可配置 `error_policy`；控制节点、开始、输出节点必须失败即停止。`continue_with` 仍必须写入失败明细和降级标记，不能把实际失败伪装成成功。仅 `retryable=true` 且副作用声明为 `safe` 或 `requires_key`（并已提交幂等键）时可重试；`unsafe` 节点的 `max_attempts` 必须为 1。

### 6.2 取消

`RunStatusV1/HumanGateStatusV1/StepStatusV1` 的唯一共享定义见 [Agent Release v1 §7.3](./agent-release-v1与能力装配契约.md#73-错误重试与取消)；Flow IR 只描述这些状态在 FlowExecution/节点上的合法转换，不另建枚举。

`RunStatusV1` 的合法主干是 `QUEUED → RUNNING`；`RUNNING` 可进入 `WAITING_FOR_INPUT|WAITING_FOR_APPROVAL`，barrier cohort 中间 Gate 获批后仍保持 waiting 并物化下一 Gate，只有最后一个 Gate 获批后才能经 `RESUMING → RUNNING`；Run 也可从运行态按唯一 finalizer 进入任一合法终态 `SUCCEEDED|FAILED|CANCELLED|TIMED_OUT|NEEDS_ATTENTION`。取消使用中间态 `CANCEL_REQUESTED` 后收敛到 `CANCELLED`。`WAITING_FOR_*` 是 Run 投影，对应 FlowExecution/Step 的持久 `SUSPENDED`；该状态不持有 Worker lease。Gate 的 `REJECTED/EXPIRED` 不是 `RunStatusV1`：其已发布 `on_reject/on_expire` 形成 `FAILED` 或 `CANCELLED` terminal intent，最终 Run/Step 映射仍由全图 finalizer 提交。取消接口只写请求意图并发出 outbox 事件；Worker 必须向所有活跃执行器传播 `AbortSignal`，停止领取新的步骤，并在安全点提交 checkpoint；Run `CANCELLED` 仍由 finalizer 唯一固定。已发出的第三方请求不保证可撤销，v1 不隐式补偿。

终态 Run 再次取消必须返回其现有终态，不得创建新 attempt。取消、超时与系统崩溃不是可由 `continue_with` 掩盖的节点错误。

`NEEDS_ATTENTION` 是 operator-hold terminal `RunStatusV1`：执行器停止领取新节点，finalizer 固定唯一 terminal snapshot/Event，已确认 usage 正常结算，未知外部责任及相应 reservation/allocation 保持可对账，当前 billing state 标记为 `NEEDS_ATTENTION`。人工/provider 对账只能追加 resolution/correction fact 并更新当前 billing state，不能 resume 原 Flow、改写 terminal snapshot 或自动重放节点。

### 6.3 恢复与未知副作用

Worker 接管过期租约时，必须从最后一个已提交 checkpoint 恢复，且只使用原 `RunPlan`。下列情形允许重放未完成节点：节点没有开始，或已有 `safe`/`requires_key` 的幂等回执可验证未完成。`SUSPENDED` 节点不由租约过期接管；中间 Gate 获批仍不得恢复，只有 cohort 最后一个 Gate 已合法 claim、`GateBarrierV1.phase="RESUMING"` 且唯一 resume Outbox 已提交时，Worker 才能按 barrier 固定的完整 frontier/checkpoints/cursors 继续。若 worker 在非幂等副作用调用后、写 checkpoint 前失联，Step 与 Run 必须以 `SIDE_EFFECT_UNKNOWN/NEEDS_ATTENTION` 终结并等待站外人工对账；不得自动再调用，也不得通过 HumanGate 恢复原 Run。

恢复不会重跑已成功节点，不会重新计费已结算 attempt，也不会重新发布任何 Flow。恢复前后必须能由 `run_id`、`flow_execution_id`、`scope_path`、`node_id`、`attempt` 关联同一条审计轨迹。

### 6.4 并发与事件顺序

- 事件 append 在持久化事务中为每个 `run_id` 分配严格递增、不重复的 `sequence`。事件还必须固定 `event_id`、`causation_id`、`scope_path`、Step/Attempt 身份与提交时间；SSE 只按已提交 sequence 回放。
- 同一节点内的 `attempt.started → attempt.completed/failed → checkpoint.committed`、下游启动对上游 checkpoint、HumanGate waiting/resume 与 terminal event 必须保持因果顺序。terminal event 是该 Run 最后一个业务事件，每个 Run 恰好一个。
- 两个没有依赖边的并发节点可以以任何顺序提交完成事件。执行的确定性指相同 Plan/输入得到相同因果图、终态、显式 exports、store mutations 和计费去重键，不指并发完成事件的字节级同序。多前驱结果合并必须按编译时稳定拓扑 rank 与 `node_id` 排序，不得使用实际完成时间。
- HumanGate waiting 事件只能在对应 `GateBarrierV1` 已证明全图 quiescent、active executable lease 为零、递增 execution fence 且 barrier owner 已在同一事务 `RELEASED` 后提交。terminal finalizer 同样要求所有 scope 无 active executable lease/未对账 attempt/待 dispatch outbox，并且只能按自己的 finalizer generation 取得控制权；节点级 finalizer 或某个 Gate mutation 不得越过并行 sibling 写 Run 终态。

## 7. 最小持久化边界

为实现 N4，P0/P1 至少需要下列逻辑记录（物理表名可调整，但语义不得合并丢失）：

| 记录 | 最小内容 |
|---|---|
| `runs` | `run_id`、`RunStatusV1`、`accepted_request_id`、判别式顶层 target（`target_kind`、`target_id`、`target_version_pin`、`compiled_hash`、`capability_closure_hash`）、类型化 Deployment/admission profile hash 与 observed revoke epoch、execution fence、finalizer generation/terminal CAS、输入/计划快照摘要、取消时间、终态时间。`target_kind=FLOW` 时 pin 是 `flow_version_id`；`target_kind=AGENT` 时 pin 是 `agent_release_id`，不得再填 `flow_version_id`。 |
| `flow_executions` | 嵌套 Flow 的 `flow_execution_id`、root `run_id`、parent capability call、`scope_path`、固定 `flow_version_id`、`compiled_hash`、`capability_closure_hash`、`flow_plan_hash` 与状态。 |
| `run_steps` | `run_id`、可空/判别式 `flow_execution_id`、`scope_path`、`node_id`、`StepStatusV1`（含 `SUSPENDED|RESUMING|NEEDS_ATTENTION`）、当前 attempt、租约、checkpoint/`resume_cursor`、可空 barrier checkpoint/cursor 引用、错误摘要。顶层 Agent Step 没有 FlowExecution；Flow 节点必须属于顶层 Flow Run 的 root FlowExecution 或 Agent 内嵌 FlowExecution。 |
| `run_attempts` | 每次 attempt 的开始/结束、worker、幂等键、资源 pin、积分和副作用回执摘要。 |
| `run_events` | 不可变 sequence、event/causation 身份、事件类型、安全 payload、outbox 投递状态。 |
| `run_store_mutations` | `run_id`、sequence、key、值摘要/安全值、写入节点，用于确定性恢复。 |
| `human_gates` | `gate_id`、Run/FlowExecution/Step/Attempt、发布 source + GateSpec ID/hash、checkpoint、`resume_cursor`、operation intent hash、approver policy ref/hash、`HumanGateStatusV1`/条件版本、过期时间、已采纳 decision hash 与发布时固定的 reject/expire disposition。 |
| `gate_barriers` | `barrier_id`、Run、source/new execution fence、barrier version/phase、host-only barrier owner generation/state、每个 candidate 唯一的 source Step/Attempt/lease/fence/checkpoint relinquish handoff、canonical candidate cohort、完整 runnable frontier/checkpoint hash、drain 截止时间、当前 gate 与唯一 resume/finalizer 身份。同一 Run 只有一个未终结 barrier。 |
| `run_mutation_idempotency` | Workspace/principal/fixed route template/key 的唯一记录、JCS intent hash、首次结果；resume target 在 intent 内，不进唯一键。 |

物理表通过 `published_resource_versions` 的 `(workspace_id, target_version_pin, target_version_kind, target_id)` 复合 FK 落实上述判别 target；禁止以一个可空 `flow_version_id` 让 Agent root 或嵌套 Flow 混入顶层 target。`run_logs` 可作为检索/展示投影，不能代替上述恢复事实。顶层 Flow Run 的积分 reservation/settlement 通过 `run_id + attempt` 去重；嵌套 FlowExecution 的 usage 归属其 root Run/billing owner，由已提交 usage 驱动，不能形成第二个 Workspace reservation。

## 8. 验收夹具与 TDD 门槛

实现前必须先在 `packages/flow-ir/test/fixtures/` 建立以下版本化夹具；每个夹具至少有 `input.json`、`expected.compile.json`、`expected.events.json` 或等价断言。夹具中的 UUID、时间和密钥使用固定占位符。

| 夹具 | 必须证明的行为 |
|---|---|
| `linear-template` | 普通 `{{start.content}}` 插值、拓扑序、只读节点输出。 |
| `branch-first-match` | case 按顺序短路、Else 必达、未选分支零 attempt、显式 export。 |
| `branch-isolation-invalid` | 跨分支引用在 Compile 被拒绝。 |
| `loop-collection-export` | 输入顺序、每轮作用域、collect/last export。 |
| `loop-condition-bound` | 条件循环越过上限后为 `LOOP_LIMIT_EXCEEDED`。 |
| `subflow-pinned` | 只使用指定已发布版本，不使用最新草稿。 |
| `subflow-recursion-invalid` | 直接和间接递归均被拒绝。 |
| `retry-and-resume` | 可幂等暂态失败仅重试规定次数；宕机后从 checkpoint 恢复且不重复扣费。 |
| `unknown-side-effect` | 非幂等节点租约丢失后进入 terminal `NEEDS_ATTENTION`，不自动重放/恢复；对账只追加 correction/resolution，原 terminal snapshot 不变。 |
| `cancel-in-flight` | 取消不再启动后续节点，且只产生一个终态。 |
| `human-gate-spec-closed` | Flow Version 内 GateSpec ID/hash/source path 唯一并进入 closure；未知字段、错 hash、客户端自选 approver/expiry/disposition 在发布或恢复前失败。 |
| `human-gate-resume` | candidate 可执行 lease 已先 handoff，等待事务持久 checkpoint/Gate/Outbox 并释放 barrier owner；重启后只从 `resume_cursor` 继续。 |
| `human-gate-race` | 并发 approve/reject/expire/cancel 只有一个结果提交；重复 mutation 不重复副作用。 |
| `human-gate-disposition` | reject/expire 分别按已发布 `fail_run/cancel_run` 映射 Run/当前 Step 为 `FAILED/CANCELLED`，Gate 仍保留 `REJECTED/EXPIRED`；只结算已确认 usage，重复 mutation 不重复释放/计费。 |
| `human-gate-parallel-quiescence` | 并行 sibling 存在时 candidate Worker 在同一 CAS 事务创建/加入 DRAINING barrier、停止新调度、提交 checkpoint、释放可执行 lease 并 handoff 到不可执行业务动作的 barrier owner，再 drain/安全 checkpoint 所有 scope；证明 active executable lease 为零后同一 waiting 事务递增 fence 并释放 owner。旧 Worker 迟到提交失败，unknown 副作用不物化 Gate 而进入 `NEEDS_ATTENTION`。 |
| `human-gate-multi-cohort` | 同一 frontier 多 Gate 的每个 candidate lease 都以唯一 handoff 加入同一 owner generation，随后按 canonical order 串行物化且同时只一个 OPEN；全部获批前 sibling 不恢复，reject/expire/cancel 丢弃剩余 candidate。 |
| `human-gate-finalizer-once` | Gate/Run cancel/timeout/sibling failure 竞争只唤醒同一全图 finalizer，终态前无 active executable lease/outbox/unknown attempt，barrier owner 已释放或由 finalizer generation 合法接管，terminal snapshot/Event/settlement 各一份。 |
| `secret-taint-invalid` | 密钥流向输出、日志或不受信任输入时发布失败。 |
| `nested-capability-closure` | 子流程内资源、凭据、egress、数据分类和副作用全部进入 closure；父策略不足时发布失败。 |
| `parallel-causal-order` | 并发节点可以不同顺序完成，但 sequence 不重复、因果边正确、合并结果与 terminal event 唯一且稳定。 |
| `published-immutable` | 编辑草稿/环境后，已创建 Run 的 hash、资源 pin、结果不变。 |
| `top-flow-deployment-admission` | 顶层 Flow 只解析 active Flow Deployment/profile；mapping requirement/provider/audience/principal/scope 必须 closed 且恰好一条，entry grant/profile 只接受 `service_api + credential_service_principal + flow_runtime_api + service_api + flow:run:create + exactly_one_flow_deployment`；零/多 distinct target、direct version 与跨类型 Agent Deployment 均失败。 |
| `top-flow-revoke-reactivate` | SUSPENDED 永久 fence 旧 Run；重新 ACTIVE 仅新 Run 可用，REVOKED 不可恢复。 |
| `top-flow-active-admission` | 准入在同一事务锁 pointer/security state，只接受 ACTIVE 并保存同一锁下的 `observed_revoke_epoch`；SUSPENDED/REVOKED 不创建 Run/reservation/outbox。 |
| `shared-production-promotion-gate` | G0 production 写入始终失败；G1 候选 Flow revision/version/closure/evidence/expected epoch 精确匹配时才用共享 decision CAS 切 pointer 并一次性 CONSUMED，证据或 pin 变化立即 INVALIDATED。 |
| `agent-nested-flow` | 一个 Agent root Run 内嵌同步 Flow 时，root target 保持 Agent；FlowExecution 固定独立 Flow pin/plan，恢复不读取最新 Flow，且不产生第二个 reservation。 |

通过标准：上述夹具全部稳定；同一 `flow_version_id + RunPlan + input` 在允许的并发调度下产生相同的终态、导出变量、store mutations、计费去重键、因果偏序和唯一 terminal event。独立并发完成事件的相对 sequence 可不同；一旦提交，同一 Run 的 SSE 必须按保存 sequence 稳定回放。SSE 的事件外形与断点续传要求由 [SSE 与异步操作契约](../api/SSE与异步操作契约.md) 约束。
