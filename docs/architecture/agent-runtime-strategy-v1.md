# Agent Runtime Strategy ABI v1

> **状态：契约冻结；G0-02 已实现 ABI 结构 Schema，Strategy loop、checkpoint 持久化与恢复尚未实现**
> **适用范围：** `packages/domain-contracts`、`packages/agent-runtime`、`packages/model-runtime`、`packages/run-core`、`apps/worker`  
> **关联：** [Agent Release v1](./agent-release-v1与能力装配契约.md)、[Compiled Capability Closure v1](./compiled-capability-closure-v1.md)、[Flow IR v1](./flow-ir-v1与运行时契约.md)、[ADR-004](../adr/004-持久化执行与计费.md)

## 1. 目的与非目标

Agent Strategy 是推理循环控制面，不是 Prompt 段落、Tool、授权策略或 Worker 内存回调。它决定“何时请求模型、何时调用已允许能力、何时等待人、何时结束”，但它不能创建 `ResolvedAgentPlan` 之外的能力、解析 secret、绕过预算/授权或自行写 Run 终态。

本 ABI 冻结以下语义：

- Strategy Release 的版本化 pin 和实现 digest；
- 持久 loop state、model-call attempt、decision、observation 和 checkpoint；
- 宕机、lease 丢失、重试、HumanGate 和取消后的唯一恢复路径；
- 终止原因、Run 状态和计费事实的映射。

本 ABI 不规定具体模型供应商、Prompt 文案、推理算法或长期记忆策略。模型输出可以非确定，但已提交 transition 的恢复必须是确定的。

## 2. 不可变 Strategy Release pin

```ts
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
  allowed_capability_binding_ids: string[]; // 仅 Release 编译输入；Plan 必须解析成 closure-unique paths
  max_iterations: number;
  max_model_attempts: number;
  max_tool_calls: number;
  contract_hash: string;
}
```

- `implementation_digest` 必须指向不可变 artifact/image/module；恢复时找不到该 digest 必须以 `STRATEGY_IMPLEMENTATION_UNAVAILABLE` 停止，不得改用新版本。
- Strategy config 、四个 schema、sandbox 和允许目录均进入 `contract_hash`。Release 封存后不得就地修改实现或上限。
- Strategy runtime 没有原始网络、文件系统、数据库或 secret 权限。它只能返回本 ABI 的类型化 Decision；model/capability/gate 由 host dispatcher 执行完整的授权、出网、计费与持久化路径。

## 3. ABI 输入、决策与状态

### 3.1 初始输入

```ts
interface StrategyStartV1 {
  schema_version: "agent-strategy-start/1";
  run_id: string;
  root_step_id: string;
  resolved_agent_plan_hash: string;
  capability_closure_hash: string;
  strategy_pin: AgentStrategyPinV1;
  input_snapshot_ref: string;
  role_context_hash: string;
  conversation_projection_ref?: string;
  model_catalog: SafeModelDescriptorV1[];
  capability_catalog: SafeCapabilityDescriptorV1[];
  instruction_skills: InertInstructionSkillDescriptorV1[];
  limits: StrategyRuntimeLimitsV1;
}
```

`model_catalog`、`capability_catalog` 和 `instruction_skills` 都是 Resolved Plan 的裁剪投影。它们不含内部资源全量 schema、secret、credential ID、其他主体信息或 closure 外能力。Instruction Skill script 在 G1 中是 inert asset，descriptor 不得暴露任何“执行脚本”动作。

### 3.2 Decision union

```ts
type StrategyGateOperationIntentV1 =
  | {
      intent_kind: "collect_input";
      prompt_arguments_ref: string;
      prompt_arguments_hash: string;
      requested_input_contract_hash: string;
      operation_intent_hash: string;
    }
  | {
      intent_kind: "approve_capability";
      binding_path: CanonicalBindingPathV1;
      operation_contract_hash: string;
      canonical_input_hash: string;
      operation_key_hash?: string;
      operation_intent_hash: string;
    };

interface StrategyGateRequestV1 {
  schema_version: "strategy-gate-request/1";
  gate_spec_id: string;
  gate_spec_hash: string;
  operation_intent: StrategyGateOperationIntentV1;
}

type StrategyDecisionV1 =
  | {
      kind: "request_model";
      model_descriptor_id: string;
      request: SafeModelRequestV1;
      retry_policy_ref: string;
    }
  | {
      kind: "invoke_capability";
      binding_path: CanonicalBindingPathV1;
      operation_contract_hash: string;
      input: JsonValue;
    }
  | {
      kind: "activate_instruction_skill";
      skill_binding_id: string;
    }
  | {
      kind: "suspend_for_human";
      gate: StrategyGateRequestV1;
    }
  | {
      kind: "complete";
      output: JsonValue;
      output_schema_hash: string;
    }
  | {
      kind: "fail";
      reason: StrategyTerminationReasonV1;
      safe_error: SafeRunErrorV1;
    };
```

host 必须在任何外部动作之前验证 Decision schema、当前 phase、序号、限制和 Plan/closure membership，并从 `run_id + transition_sequence + decision kind` 派生稳定 logical model/capability call ID；Strategy 不能自行提供或重用这些幂等身份，也不能通过伪造 `binding_path`、model alias、operation hash 或自报余额越权。Strategy Release 的局部 allowed binding IDs 只在 Agent Release 编译期解析；进入 Resolved Plan 后 enabled/disabled membership 与每次 Call 一律使用 closure-unique binding path。

`StrategyGateRequestV1` 与两个 operation intent 分支都是 closed object；`operation_intent_hash` 必须逐字等于 `SHA-256(JCS(intent excluding operation_intent_hash))`，由 host 重算。除 `gate_spec_id + gate_spec_hash + operation_intent` 外，Strategy 不得提交 Gate kind、decision schema、prompt template、approver、expiry、notification 或 reject/expire disposition。host 必须从固定 Agent Release/closure 按 ID+hash 精确回读 `AgentGateSpecV1`：`collect_input` 只匹配 `kind="input"` 且 `requested_input_contract_hash` 等于已发布 decision schema hash；`approve_capability` 只匹配 `kind="approval"`，其 canonical path/operation hash 必须同时命中 Resolved Plan、closure 与 spec 的 protected operation allow-set。所有 refs/hashes 必须来自本 Run 已提交的安全事实；未知字段、错分支、intent/hash 漂移或 Strategy 自报策略一律以 `STRATEGY_DECISION_INVALID` fail closed。

### 3.3 Durable checkpoint

```ts
type StrategyPhaseV1 =
  | "READY"
  | "MODEL_PENDING"
  | "CAPABILITY_PENDING"
  | "SUSPENDED"
  | "RESUMING"
  | "TERMINATING"
  | "TERMINAL";

interface StrategyCheckpointV1 {
  schema_version: "agent-strategy-checkpoint/1";
  checkpoint_id: string;
  previous_checkpoint_hash?: string;
  run_id: string;
  root_step_id: string;
  strategy_release_id: string;
  implementation_digest: string;
  resolved_agent_plan_hash: string;
  capability_closure_hash: string;
  transition_sequence: number;
  iteration: number;
  phase: StrategyPhaseV1;
  durable_state: JsonValue;
  state_schema_hash: string;
  accepted_observation_refs: string[];
  completed_model_attempt_ids: string[];
  completed_capability_call_ids: string[];
  instruction_skill_activation_ids: string[];
  pending_action?: PendingStrategyActionV1;
  resume_cursor?: string;
  counters: StrategyCounterSnapshotV1;
  termination_reason?: StrategyTerminationReasonV1;
  checkpoint_hash: string;
}
```

`durable_state` 是 state schema 验证后的最小循环状态；它可以引用脱敏的 model/capability observation，但不能用 conversation history 或 worker 内存隐藏未持久 cursor、待执行 Tool、计费或终止条件。`checkpoint_hash` 由固定 schema/canonicalizer 对除自身外的字段生成。

## 4. Transition 与事务边界

### 4.1 单 transition 规则

1. Worker 领取带 TTL/fencing token 的 Agent Step lease，读取最新已提交 checkpoint 和原 Resolved Plan。
2. host 向固定 Strategy implementation 传入 checkpoint 和至多一个已提交 observation，得到一个 Decision。这一步不得直接产生网络/数据副作用。
3. host 检查 Decision 并以当前 checkpoint hash/fence 条件写入“pending action + next checkpoint + decision Event + outbox”。同一 `transition_sequence` 只能提交一次。
4. model/capability/gate dispatcher 从 outbox 执行动作，将结果写为独立事实和 observation。只有 observation 与下一 checkpoint 在事务中提交后，它才可被 Strategy 看见。
5. 旧 fence、重复 outbox 或过期 Worker 只能读回已提交结果，不得创建第二个 Decision/observation。

G1 的 Strategy 每个 checkpoint 最多只有一个 `pending_action`。并行/推测模型调用、并行 Tool fan-out 或 multi-agent voting 需要新 ABI version，不得隐藏在 `durable_state` 中绕过事务与计费。

### 4.2 Model-call attempt

```ts
interface ModelCallAttemptV1 {
  model_attempt_id: string;
  logical_model_call_id: string;
  run_id: string;
  transition_sequence: number;
  attempt_number: number;
  model_pin: PublishedModelPinV1;
  request_hash: string;
  sampling_config_hash: string;
  provider_operation_key?: string;
  status: "PREPARED" | "DISPATCHED" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  provider_receipt_hash?: string;
  response_ref?: string;
  response_hash?: string;
  usage?: CommittedModelUsageV1;
  error?: SafeRunErrorV1;
  started_at?: string;
  finished_at?: string;
}
```

- host 必须先持久 `PREPARED` attempt 和 outbox，再请求 provider。同一 `logical_model_call_id + attempt_number` 唯一。
- provider 支持幂等 operation key/结果查询时，宕机后必须对原 attempt 对账，不能新建请求。provider 不支持且已发送结果不明时，attempt 进入 `OUTCOME_UNKNOWN`；只有固定 retry policy、剩余预算和审计事件同时允许时，才可创建新 attempt。迟到的旧响应不得成为 observation。
- 一个 successful response 只有在“response ref/hash + usage + observation + checkpoint + Event”通过当前 fence 提交后才被 Strategy 采纳。恢复只读该 response，绝不重新生成已采纳的模型输出。
- 每个实际 provider attempt 都单独记录 usage/费用；失败或 `OUTCOME_UNKNOWN` 如果后续收到可验证计费回执，以账务 correction fact 追加，不覆盖旧 attempt。

### 4.3 Capability Call 和 Skill activation

- `invoke_capability` 必须命中 Resolved Plan 中已启用且不在 `disabled_binding_paths` 的 `binding_path + operation_contract_hash`。host 创建稳定 `call_id`、执行 epoch/credential/egress/side-effect 重验证并使用该 Binding 的幂等契约；重复的嵌套局部 binding ID 不参与 membership。Skill Pack exposed operation 还必须命中 closure 中唯一 member path/pin/hash route；Strategy 永远不接收 secret handle。
- Capability observation 只包含 schema 验证和分类/脱敏后的输出、安全错误、receipt/usage 引用。副作用结果不明时进入 `SIDE_EFFECT_UNKNOWN`，Strategy 不能将它解释为“可重试失败”。
- `activate_instruction_skill` 只持久 workspace-scoped `PublishedResourcePin<"INSTRUCTION_SKILL_RELEASE">`、content hash、激活顺序和经裁剪上下文摘要；它不产生 Capability Call 或授权。G1 中的 Skill script 始终 inert，Strategy 返回任何 script execution 意图都以 `STRATEGY_DECISION_INVALID` 拒绝。

### 4.4 HumanGate suspend/resume

- `suspend_for_human` 只能引用固定 Agent Release/closure 中的 `AgentGateSpecV1`；spec 已固定 `input|approval`、decision schema、approver policy、过期、disposition 与允许的 operation hash，Strategy 仅提交 `StrategyGateRequestV1 + SUSPENDED candidate/checkpoint`，不得局部写 Run waiting 或重述策略。candidate Worker 必须在同一个 Run/barrier CAS 事务建立 `DRAINING` barrier、冻结所有 scope 新调度/frontier、提交 checkpoint，并把自己的可执行 lease 原子标记 `RELINQUISHED`、转交给 host-only `barrier_owner_generation`；该 owner 只能 drain/fence/物化 Gate，不计入 active executable lease，也不能执行业务动作。任一步失败整体回滚，因此不存在 lease 已释放但 barrier 未建立的窗口。host 随后 drain 或安全 checkpoint siblings；只有 active executable lease、待 dispatch outbox、未对账 attempt 全部清零，才由相同 owner generation 在 waiting 事务递增 fence、写 HumanGate、Run/Step waiting、Event/notification outbox，并把 barrier owner 置为 `RELEASED`。candidate lease 已在 handoff 时释放，不存在 waiting 后再释放它的步骤；无法安全 quiesce、handoff CAS 失败或副作用结果未知时不得物化 Gate。
- resume mutation 先认证/确认 Run 可读并锁定固定 route 的 mutation idempotency fact；命中时比较 canonical intent 后重放首次 receipt，不重验 Gate 当前状态。仅 miss 才锁 Run/Gate/barrier，重验证 approver、expiry、operation hash、原 Plan/closure、credential/resource epoch 和预算，并以 `gate_id + barrier_version` 条件 claim。APPROVE 固定 receipt/Gate；若 canonical cohort 尚有 deferred candidate，则只物化下一 `OPEN` Gate并继续 waiting。只有最后一个 Gate 获批才把 barrier/Run/Steps 与 Strategy checkpoint 切到 `RESUMING`，从保存的完整 frontier/cursors 形成唯一 human observation并写 resume outbox。REJECT/EXPIRE 只保存 disposition/receipt/terminal intent 并唤醒唯一全图 finalizer，不直接提交 Run 终态。
- 并发 approve/reject/expire/cancel 只能提交一个状态转换。已保存的重复 mutation 只读回首次结果；不能重复调用 Strategy、重新结算或执行任何副作用。
- Gate 的 `REJECTED/EXPIRED` 是 `HumanGateStatusV1`，不直接充当 `RunStatusV1`。host 必须读取已发布 GateSpec 的 `on_reject/on_expire`：`fail_run → FAILED`，`cancel_run → CANCELLED`；该 disposition 与 Gate 实际状态一起进入 termination Event。Strategy 不得用一个默认 `fail` Decision 覆盖 `cancel_run`，也不得在拒绝/过期后恢复 checkpoint。

## 5. 恢复、lease 与 fencing

- 恢复身份是 `run_id + root_step_id + strategy_release_id + transition_sequence + checkpoint_hash`。新 Worker 必须使用更新 fencing token 条件提交；旧 Worker 的迟到响应可用于 provider 对账，但不得改变 Strategy state。
- `READY` 可以计算下一 Decision；`*_PENDING` 必须先对账现有 model attempt/capability call，不得直接再发一次；`SUSPENDED` 只等待 barrier cohort 的 Gate mutation，中间 Gate 获批仍保持 `SUSPENDED`；只有最后一个 Gate 获批且 barrier 已提交唯一 resume outbox 后，`RESUMING` 才接收已提交 human observation；`TERMINAL` 不得再 transition。
- 恢复必须使用原 Strategy implementation digest、Resolved Plan、closure、model/resource pins 和 checkpoints。active Deployment pointer、新草稿、新 Strategy Release、新模型默认值或新工具目录均不得进入已接受 Run。
- 当前授权重验证可以收窄未开始动作；如果固定能力被撤销，以明确终止原因失败/人工处置，不会为旧 Run 补充现在新授予的能力。
- `CAPABILITY_PENDING` 指向 G1 `join` child 时，恢复必须先按固定 `G1JoinChildTerminalOutcomeMapV1` 对账 child 的唯一 terminal Event 与 usage/allocation，不能再次 dispatch child 或让 Strategy 重选映射：`SUCCEEDED` 形成一次安全 observation；`FAILED`/`TIMED_OUT` 分别以 `CHILD_FAILED`/`CHILD_TIMED_OUT` 使父 Call 失败并使 root Run `FAILED`；`CANCELLED` 使父 Call/root Run `CANCELLED`；`NEEDS_ATTENTION` 使父 Call/root Run terminal operator hold 并保留未知账务责任。该投影以 `parent_call_id + child_run_id + child_terminal_event_sequence` 唯一消费，重复恢复只读回首次结果。

## 6. 终止原因与 Run 映射

```ts
type StrategyTerminationReasonV1 =
  | "COMPLETED"
  | "MAX_ITERATIONS"
  | "MAX_MODEL_ATTEMPTS"
  | "MAX_TOOL_CALLS"
  | "BUDGET_EXHAUSTED"
  | "USER_CANCELLED"
  | "RUN_TIMED_OUT"
  | "AUTHORIZATION_REVALIDATION_FAILED"
  | "RESOURCE_REVOKED"
  | "MODEL_FAILED"
  | "MODEL_OUTCOME_UNKNOWN"
  | "CAPABILITY_FAILED"
  | "SIDE_EFFECT_UNKNOWN"
  | "HUMAN_REJECTED"
  | "HUMAN_GATE_EXPIRED"
  | "INVALID_DECISION"
  | "STRATEGY_IMPLEMENTATION_UNAVAILABLE"
  | "INTERNAL_FAILURE";
```

| termination reason | Run 结果 | 重试/处理 |
|---|---|---|
| `COMPLETED` | `SUCCEEDED` | 输出 schema 必须验证通过，否则不得 complete |
| `USER_CANCELLED` | `CANCELLED` | 停止新动作；已发副作用仍按 receipt 对账 |
| `RUN_TIMED_OUT` | `TIMED_OUT` | 不得由 Strategy 用 fallback 掩盖 |
| `SIDE_EFFECT_UNKNOWN` | terminal `NEEDS_ATTENTION` | 禁止自动重放/resume；只允许站外人工/provider 对账追加 resolution/correction fact |
| `HUMAN_REJECTED` | GateSpec `on_reject=fail_run → FAILED`；`cancel_run → CANCELLED` | Gate 保留 `REJECTED`；不得再次调用 Strategy |
| `HUMAN_GATE_EXPIRED` | GateSpec `on_expire=fail_run → FAILED`；`cancel_run → CANCELLED` | Gate 保留 `EXPIRED`；不得再次调用 Strategy |
| 其他非成功原因 | `FAILED` | 仅在 Run 之外按入口策略新建请求；不覆盖原 Run |

同一 finalizer 还必须把当前活动 Step/Gate 收敛到以下唯一投影；没有当前 Step/Gate 时对应列为空，不得伪造记录：

| termination reason | 活动 `StepStatusV1` | `HumanGateStatusV1` |
|---|---|---|
| `COMPLETED` | `SUCCEEDED` | 不允许存在 `OPEN` Gate |
| `SIDE_EFFECT_UNKNOWN` | `NEEDS_ATTENTION` | 不创建 Gate；已有 `OPEN` Gate 是状态冲突 |
| `HUMAN_REJECTED` | `on_reject=fail_run → FAILED`；`cancel_run → CANCELLED` | 保留 `REJECTED` |
| `HUMAN_GATE_EXPIRED` | `on_expire=fail_run → FAILED`；`cancel_run → CANCELLED` | 保留 `EXPIRED` |
| `USER_CANCELLED` | `CANCELLED` | 若存在 `OPEN` Gate，以同一 CAS 置为 `CANCELLED` |
| `RUN_TIMED_OUT` | `CANCELLED` | 若存在 `OPEN` Gate，以同一 CAS 置为 `CANCELLED`；不得伪造为 `EXPIRED` |
| 其他非成功原因 | `FAILED` | 若存在 `OPEN` Gate，以同一 CAS 置为 `CANCELLED` |

Strategy 返回 `complete/fail` 只是终止意图。finalizer 必须重验证当前 fence、无 pending action、输出 schema、子 Run/Gate 策略、计费状态和已存在 terminal event；若 root Run 包含并行/嵌套 Flow，还必须满足 Flow IR 的全图 quiescence/barrier，无 active executable lease、未对账 attempt 或待 dispatch outbox，且先前 barrier owner 已 `RELEASED` 或由同一 finalizer generation 合法接管。它只能以 `run_id + finalizer_generation` 与 terminal-null CAS 在一个事务中固定 Run terminal snapshot 与唯一 terminal Event。

`NEEDS_ATTENTION` 与 `SUCCEEDED|FAILED|CANCELLED|TIMED_OUT` 同属 Run terminal set。finalizer 结算已确认 usage，保留未知外部责任对应的 reservation/allocation 事实并把当前 billing state 标为 `NEEDS_ATTENTION`；后续对账不能改写 Run terminal status/checkpoint/Event，也不能让原 Strategy 重新 transition。

HumanGate reject/expire 的 finalizer 只结算 Gate 前已确认 usage，并释放未使用 reservation/allocation；它不得产生新的模型/Capability Attempt 或把等待时间计成执行 usage。重复/竞争 mutation 只回放首次 terminal receipt，不重复结算或释放。若 Gate 前已有未知外部副作用，则必须优先按 `SIDE_EFFECT_UNKNOWN → NEEDS_ATTENTION` 收敛，不能用 reject/expire 覆盖责任未知状态。

## 7. 计费与预算

- 预算事实源是 root Run reservation/allocation 和已提交 usage ledger，`StrategyCheckpoint.counters` 只是可快速验证的快照，不是账务真源。
- 每个 model attempt 和 Capability Call 以稳定 usage identity 写入去重事实。重放 Event、接管 Worker、重建 checkpoint 或重复 provider receipt 不得再扣费。
- 重试是新 attempt，可能产生新真实费用；必须在发起前检查剩余预算。provider 迟到账单以 correction fact 追加并可使 `billing_state` 进入 `NEEDS_ATTENTION`，不篡改旧 checkpoint。
- 同步 Flow/SubAgent 在 root billing owner 下归集 usage；G1 异步 child 只支持 `join`，从父 allocation 扣减且不创建第二个 Workspace reservation。

## 8. 事件与可观测顺序

- 每次 Decision、model attempt、Capability Call、Skill activation、Gate wait/resume、checkpoint 和 termination 都产生持久 Event。Event 必须有 Run 内严格递增 `sequence`、`event_id`、`causation_id`、Step/Attempt/Call 身份与脱敏 payload。
- 因果顺序必须保持：Decision 先于其 attempt/call，result 先于 accepting checkpoint，Gate waiting 先于 resume，所有业务事件先于唯一 terminal Event。
- 若后续 ABI 支持并发 Call，独立 Call 的完成 sequence 可以因调度不同而不同；验收比较因果图、终态、已提交回放和去重事实，不要求无依赖事件每次字节级同序。G1 的 linear profile 没有并发 pending action。

## 9. G1 实现剪裁

G1 只实现 `linear_tool_loop_v1`，其行为必须是上述 ABI 的严格子集：

1. 单 Agent root Step，每个 checkpoint 最多一个 pending model/capability/gate action；
2. 只允许 Resolved Plan 中的模型和 closure Binding，不做 dynamic tool discovery；
3. 支持结构化 model decision、单 Capability Call、Instruction Skill 上下文激活、HumanGate 和 complete/fail；
4. Instruction Skill scripts inert；Database Binding 只读；异步 child 只支持 `join/cascade/safe_summary/wait_for_settlement` 与固定 `G1JoinChildTerminalOutcomeMapV1`；
5. 不支持推测并发、并行 Tool fan-out、自修改 Release、自主解析 secret、public detach 或匿名 delegated connector。

超出该子集的已发布 Strategy 必须在 G1 admission 以 `STRATEGY_PROFILE_UNSUPPORTED` 拒绝，不得静默降级或忽略 Decision。

Instruction Skill 的 G1 ownership 必须显式分层：release parser/manifest/hash/path/来源校验属于 release/skill contract 模块，Agent publisher/compiler 负责 seal binding、验证 `allowed_capability_binding_ids` 并生成 inert descriptor，Strategy runtime 只能激活该已编译 descriptor。runtime 不得临时读取包目录、重新解析 manifest 或执行 scripts；任一层缺失都使 Agent Release/admission 失败，不能以空 descriptor 跳过后宣称 G1 Skill 可用。

## 10. 必须先行的验收夹具

| 夹具 | 必须证明 |
|---|---|
| `strategy-pin-resume` | 新版 Strategy 发布后，旧 Run 仍使用原 digest/schema/checkpoint |
| `decision-cas-race` | 两个 Worker 对同一 transition 竞争，只有一个 Decision/outbox 提交 |
| `model-response-commit` | 已采纳 response 恢复时不重新调用模型、不重复扣费 |
| `model-outcome-unknown` | 无 provider idempotency 且发送后宕机时标记 unknown；新 attempt 受 policy/预算限制，迟到响应不成为 observation |
| `capability-outside-closure` | Strategy 猜测 binding path/operation、调用 disabled path 或以重复局部 binding ID 冒充 sibling 时在副作用前失败 |
| `subagent-context-dispatch-fact` | SubAgent Call 首次 dispatch 前原子固定 workspace、parent Attempt/fence、dispatch generation/outbox/intent、projection ref/hash、cursor/messages/tokenizer/truncation/serializer；summary 固定 model/prompt/schema/accepted attempt/usage，复合唯一拒绝旧 fence/错 intent，重放不重投影/重摘要/重计费 |
| `skill-script-inert` | parser 拒绝 path traversal/未知字段并固定 manifest/hash；Skill script 可验完整性但不被加载，必需执行的 Skill 发布失败，descriptor 不能扩大 Binding |
| `agent-gate-spec-closed` | Strategy 只能引用固定 Release/closure 的 GateSpec ID/hash 与 closed operation intent；自报 approver/expiry/disposition、错 kind/hash 或 closure 外 operation 均失败 |
| `human-gate-restart` | 同一 CAS 事务建立 DRAINING barrier、冻结新调度/checkpoint 并把 candidate lease handoff 给不可执行 barrier owner；零 active executable lease 后 waiting 事务释放 owner，重启与重复 resume 只产生一个 observation/后续副作用 |
| `human-gate-disposition` | reject/expire 的 `fail_run/cancel_run` 分别映射 FAILED/CANCELLED，Gate 状态与 Run 状态不混用 |
| `side-effect-operator-hold` | unknown side effect 只产生一次 terminal NEEDS_ATTENTION；对账不 resume Strategy、不改写 terminal snapshot |
| `join-child-terminal-map` | 五种 child terminal 逐字映射父 Call/root Run；`NEEDS_ATTENTION` 传播 operator hold 并保留 allocation，重复 child Event 不重复投影/结算 |
| `revocation-before-call` | active pointer promotion 不影响旧 Run；SUSPENDED 永久 fence 旧 Run，重新 ACTIVE 仅新 Run 可用，REVOKED 不可恢复；resource/credential revoke 阻止未开始 Call |
| `limits-are-terminal-reasons` | iteration/model/tool/budget 限制分别产生明确 reason，不伪装成成功 |
| `terminal-once` | duplicate finalizer/outbox/Worker 仍只有一个 terminal snapshot/Event/settlement identity |

本文是目标契约，不是已实现证据。只有实际 schema validator、持久化事务、provider 对账、lease/fencing、故障注入、计费读回和上述夹具全部通过后，才能声明 Strategy runtime 就绪。
