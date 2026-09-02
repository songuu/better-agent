# Compiled Capability Closure v1

> **状态：T1 canonical identity 与 T2 policy meet 已实现并本地验证；完整 closure compiler、registry/readback、admission 与应用上线仍待实现**
> **适用范围：** `packages/domain-contracts`、`packages/agent-runtime`、`packages/flow-ir`、`packages/policy`、`packages/release-core`、`apps/worker`  
> **关联：** [Agent Release v1](./agent-release-v1与能力装配契约.md)、[Flow IR v1](./flow-ir-v1与运行时契约.md)、[Agent Strategy ABI v1](./agent-runtime-strategy-v1.md)、[ADR-003](../adr/003-多租户与凭据模型.md)

## 1. 目的与安全结论

顶层 Agent 或 Flow 只验证一条 Binding 不足以安全执行。一个 Flow 可以调用子流程、插件、知识和数据库，Skill Pack 可以展开多种能力，SubAgent 还可以进入另一个 Agent Release。如果只检查表面 target，内部依赖就可绕过凭据、egress、数据分类、副作用和预算上限。

因此，每个可执行 Agent Release 和 Flow Version 在发布时都必须生成 `CompiledCapabilityClosureV1`：它是直接与传递性依赖、操作契约和有效安全上限的 canonical、不可变、可哈希闭包。发布时无法展开、类型不匹配或无法证明不扩权时必须 fail closed。

## 2. 类型边界

### 2.1 BindingKind 与 PublishedResourceKind 分离

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
```

`BindingKind` 描述 Agent/Flow 的调用方式；`PublishedResourceKind` 描述发布 registry 中的不可变物理目标。不得用 `kind="flow"` 同时代表 Binding 和 registry row，也不得用裸 UUID 延迟到运行时猜测类型。

### 2.2 唯一 target 映射

| Binding 判别式 | 唯一 target `PublishedResourceKind` | 必须递归展开的内部依赖 |
|---|---|---|
| `knowledge` | `KNOWLEDGE_INDEX_GENERATION` | source/pipeline/embedding/retrieval/rerank contract hashes、ACL/filter policy |
| `database` | `DATABASE_OPERATION_RELEASE` | connector identity、table/schema revisions、column/row policy、parameter/result schema |
| `flow` | `FLOW_VERSION` | 子流程与所有节点资源 |
| `plugin` | `PLUGIN_TOOL_RELEASE` | provider/MCP server identity、tool schema、transport、egress、implementation digest |
| `skill_pack` | `SKILL_PACK_RELEASE` | 已展开的具体 Capability Binding 列表；不允许 runtime discovery |
| `subagent + internal_agent` | `AGENT_RELEASE` | target Agent closure、bounded delegation policy、context projection |
| `subagent + external_a2a` | `A2A_AGENT_RELEASE` | endpoint/remote identity/egress/auth contract、bounded delegation policy |

`SYSTEM_RELEASE` 可作为顶层 Run target，但不是 Agent Capability Binding。`INSTRUCTION_SKILL_RELEASE`、`AGENT_STRATEGY_RELEASE`、`EXPERIENCE_RELEASE` 和 `DEPLOYMENT_REVISION` 是 assembly/deployment pin，也不是 Capability Binding。`DEPLOYMENT_REVISION` 的 registry row 必须另带 `deployment_kind="agent"|"flow"` 判别，Agent 与顶层 Flow 使用各自 schema，不能用同一宽泛 JSON 或互相回退。Instruction Skill 的内容激活不授权，Strategy 只能在 closure 内选择，Experience 只做展示，Deployment 只在准入时装配并收窄。

## 3. Canonical schema

```ts
interface CompiledCapabilityClosureV1 {
  schema_version: "compiled-capability-closure/1";
  root: ClosureRootV1;
  assembly_pins: PublishedResourcePin[];
  bindings: CompiledBindingEntryV1[];
  gate_specs: CompiledGateSpecEntryV1[];
  resource_nodes: ClosureResourceNodeV1[];
  dependency_edges: ClosureDependencyEdgeV1[];
  disabled_binding_paths: CanonicalBindingPathV1[];
  aggregate_limits: EffectiveCapabilityPolicyV1;
  closure_hash: string;
}

interface ClosureRootV1 {
  pin: ClosureRootPinV1;
  semantic_seed_hash: string; // 排除 final compiled/closure hash，避免循环哈希
}

interface ClosureRootPinV1 {
  workspace_id: string;
  published_resource_kind: "AGENT_RELEASE" | "FLOW_VERSION";
  resource_id: string;
  resource_version_id: string;
  contract_hash: string; // closure-local；必须逐字等于 semantic_seed_hash
  binding_mode: "pinned";
}

interface PublishedResourcePin<K extends PublishedResourceKind = PublishedResourceKind> {
  workspace_id: string;
  published_resource_kind: K;
  resource_id: string;
  resource_version_id: string;
  contract_hash: string;
  binding_mode: "pinned";
}

type CanonicalBindingPathV1 = string; // bp1.<base64url(SHA-256(binding-path-lp-utf8/1 bytes))>
type ClosureResourceNodeIdV1 = string; // rn1.<base64url(SHA-256(JCS(full pin)))>

type BindingOwnerIdentityV1 =
  | { owner_kind: "root"; pin: ClosureRootPinV1 }
  | {
      owner_kind: "published_dependency";
      pin: PublishedResourcePin<"AGENT_RELEASE" | "FLOW_VERSION" | "SKILL_PACK_RELEASE">;
    };

type FlowOwnerIdentityV1 =
  | {
      owner_kind: "root";
      pin: ClosureRootPinV1 & { published_resource_kind: "FLOW_VERSION" };
    }
  | {
      owner_kind: "published_dependency";
      pin: PublishedResourcePin<"FLOW_VERSION">;
    };

type BindingPathSegmentV1 =
  | {
      segment_kind: "root";
      pin: ClosureRootPinV1;
    }
  | {
      segment_kind: "binding";
      owner: BindingOwnerIdentityV1;
      binding_kind: BindingKind;
      local_binding_id: string;
    }
  | {
      segment_kind: "flow_node";
      owner: FlowOwnerIdentityV1;
      graph_id: string;
      node_id: string;
    }
  | {
      segment_kind: "skill_pack_member";
      owner_pin: PublishedResourcePin<"SKILL_PACK_RELEASE">;
      local_member_binding_id: string;
    }
  | {
      segment_kind: "subagent_target";
      target_pin: PublishedResourcePin<"AGENT_RELEASE" | "A2A_AGENT_RELEASE">;
    };

interface CompiledBindingEntryV1 {
  binding_path_encoding_version: "binding-path-lp-utf8/1";
  binding_path: CanonicalBindingPathV1;
  binding_path_segments: [BindingPathSegmentV1, ...BindingPathSegmentV1[]];
  binding_id: string;
  binding_kind: BindingKind;
  target: PublishedResourcePin;
  config_schema_version: string;
  config_hash: string;
  source_contract_hash: string;
  effective_policy: EffectiveCapabilityPolicyV1;
  operation_contracts: OperationContractPinV1[];
  dependency_node_ids: ClosureResourceNodeIdV1[];
  approval_gate_spec?: { gate_spec_id: string; gate_spec_hash: string };
  async_child_policy_hash?: string;
  skill_pack_operation_routes?: SkillPackOperationRouteV1[];
}

interface CompiledGateSpecBaseV1 {
  schema_version: "compiled-gate-spec/1";
  gate_spec_id: string;
  gate_spec_hash: string;
  kind: "input" | "approval";
  decision_schema_hash: string;
  approver_policy_ref: string;
  approver_policy_hash: string;
  notification_profile_hash?: string;
  on_reject: "fail_run" | "cancel_run";
  on_expire: "fail_run" | "cancel_run";
  protected_operation_contract_hashes: string[];
}

type CompiledGateSpecEntryV1 = CompiledGateSpecBaseV1 & (
  | {
      source_kind: "agent_release";
      source_node_id: ClosureResourceNodeIdV1;
    }
  | {
      source_kind: "flow_node";
      source_node_id: ClosureResourceNodeIdV1;
      source_binding_path: CanonicalBindingPathV1;
      source_flow_node_id: string;
    }
);

interface SkillPackOperationRouteV1 {
  pack_binding_path: CanonicalBindingPathV1;
  exposed_operation_id: string;
  exposed_operation_contract_hash: string;
  member_binding_path: CanonicalBindingPathV1;
  member_target: PublishedResourcePin;
  member_operation_contract_hash: string;
  route_hash: string;
}

interface ClosureResourceNodeBaseV1 {
  node_id: ClosureResourceNodeIdV1;
  intrinsic_policy: IntrinsicCapabilityPolicyV1;
  dependency_manifest_hash: string;
}

type ClosureResourceNodeV1 = ClosureResourceNodeBaseV1 & (
  | { node_role: "root"; pin: ClosureRootPinV1 }
  | {
      node_role: "dependency";
      pin: PublishedResourcePin;
      nested_closure_hash?: string; // Agent/Flow dependency 必填；leaf 必须缺失
    }
);

interface ClosureDependencyEdgeV1 {
  from_node_id: ClosureResourceNodeIdV1;
  to_node_id: ClosureResourceNodeIdV1;
  relation:
    | "binding_target"
    | "flow_node"
    | "subflow"
    | "skill_pack_member"
    | "subagent_target"
    | "typed_internal_dependency";
  source_path: CanonicalBindingPathV1;
}

interface EffectiveCapabilityPolicyV1 {
  credential_requirements: CredentialRequirementV1[]; // canonical sorted demands
  principal_modes: ("caller_delegated" | "service_principal" | "team_shared" | "none")[];
  egress: CanonicalEgressRuleV1[];
  readable_data_classification_ceiling: "public" | "internal" | "confidential" | "restricted";
  output_data_classification: "public" | "internal" | "confidential" | "restricted";
  side_effect: {
    maximum_class: "safe" | "requires_key" | "unsafe";
    approval: "none" | "required";
  };
  operation_contract_hashes: string[];
  max_calls: number;
  max_depth: number;
  max_parallelism: number;
  budget: CapabilityBudgetV1;
}

interface OperationContractPinV1 {
  operation_kind: "knowledge_query" | "database_operation" | "flow_call" | "plugin_tool" | "subagent_call";
  operation_id: string;
  input_schema_hash: string;
  output_schema_hash?: string;
  side_effect_class: "safe" | "requires_key" | "unsafe";
  operation_key_required: boolean;
  approval_required: boolean;
  contract_hash: string;
}
```

`assembly_pins` 用于复现 Agent/Flow 发布装配，不会自动转换为 `bindings`。所有非 root pin 都以 `workspace_id + published_resource_kind + resource_id + resource_version_id + contract_hash` 定位 registry 行；受控全局目录也必须使用专用、不可伪造的 catalog workspace 身份，不允许缺失 Workspace 后仅凭 UUID 回读。`ClosureRootV1.pin.contract_hash` 是唯一例外：它使用排除 final compiled/closure hash 的 `semantic_seed_hash`，两者必须逐字相等，以避免循环哈希但仍保留完整 workspace/kind/resource/version/contract 身份；读取 root registry row 时仍须独立验证最终 `compiled_hash`。closure 只保存 `credential_requirements`；实际 `secret_ref`/credential handle 只在准入后的 Resolved Plan 与可信 SecretResolver 中以不透明引用存在。secret value、token、连接串、认证头和可重放 URL 不得进入 closure。

`binding_id` 只在其定义 Release 内唯一，不是 closure 级身份。`binding_path_segments` 必须以 `root` 开始，随后按实际嵌套顺序追加类型化 `binding/flow_node/skill_pack_member/subagent_target` segment；每个 owner/target 都携带完整 pin，局部 ID 只存在于声明它的 owner segment。`binding-path-lp-utf8/1` 将每个 segment 编码为固定 tag，再将该 variant 的字段按协议固定顺序编码为 `field_tag:uint8 + utf8_length:uint32be + utf8_bytes`，整个序列以 segment count 和每段 byte length 前缀连接；`binding_path` 是这些 canonical bytes 的 SHA-256，以无 padding 的 `bp1.<base64url(digest)>` 表示。值中的 `/`、`:`、Unicode、空串或类似前缀因此不能造成边界歧义，且公开 path 不可逆地暴露内部 pin；禁止自行拼接 `agent:<id>/binding:<id>`、JSON pointer、显示名或对 digest 做第二次编码。publisher/closure loader 必须从 closed `binding_path_segments` 重算 path 并逐字相等，拒绝非法 UTF-8、非最短 length、未知 tag、重复 path 或同 path 不同 segments（后者以 `BINDING_PATH_DIGEST_COLLISION` 失败）。`disabled_binding_paths`、Resolved Plan membership、Skill Pack route 与运行时 Call 都只使用这个 canonical opaque path；嵌套 Flow、Skill Pack 或 SubAgent 中重复的局部 `binding_id` 不得互相覆盖。

Flow 的 `node_id` 只在所属 graph 内唯一，因此 `flow_node` segment 必须同时编码 `graph_id`。一个 Flow source 内的 `graph_id` 必须全局唯一；branch/loop 的 sibling graph 可以复用同一 node ID，但仍因 graph namespace 不同得到不同 canonical path。不得依赖遍历序号或 branch 显示文本消歧。

`resource_nodes` 必须包含恰好一个与 `ClosureRootV1.pin` 逐字相等的 root node，以及所有依赖 node。`ClosureResourceNodeV1.node_id` 必须逐字等于 `rn1.<base64url(SHA-256(JCS(pin)))>`；JCS 输入是完整五元 pin（`workspace_id + published_resource_kind + resource_id + resource_version_id + contract_hash`）连同 `binding_mode="pinned"`，不能只用 kind/version UUID。相同 node ID 若解出/关联到不同 canonical pin 必须以 `RESOURCE_NODE_ID_COLLISION` 拒绝发布，不能做跨 Workspace 或跨 catalog 去重。

`gate_specs` 是发布期 Gate 权限边界，不是 UI 元数据。Agent Release 的 `AgentGateSpecV1` 和 Flow node 的 `GateSpecV1` 都必须以 source resource node、canonical Flow source path（如适用）、ID/hash、kind、decision schema hash、approver policy ref/hash、notification hash、disposition 和 protected operation allow-set 写入 `CompiledGateSpecEntryV1`；Agent root spec 不得携带 Flow-only source 字段。`approval_gate_spec` 必须精确命中同 closure 的一条 `kind="approval"` spec，且覆盖该 Binding 的 operation contract；Agent Strategy 只能请求已发布 allow-set 内的 ID/hash。缺失、重复、hash 不符、错 source/kind 或运行时自报策略都 fail closed；运行时只能按当前 epoch 收窄 pinned approver policy，不能替换。

## 4. 编译算法

### 4.0 Identity byte profile (`binding-path-lp-utf8/1`)

G1 的 identity 实现使用以下固定字节语法；这是第 3 节 length-prefixed 编码的具体化，不接受额外 tag/字段或可替代序列化。路径 API 消费 closed typed segments，不提供接收任意二进制编码的入口。

**未发布基线重置（2026-09-02）：** T1 的本地 `/1` golden baseline 在任何 registry/publisher 持久化前补入 `flow_node.graph_id`，用于消除合法 sibling graph 复用 node ID 时的身份碰撞。仓库级 `rg "binding-path-lp-utf8/1|bp1\\."` 只命中 source、测试和未完成计划，T6 publisher/registry 仍为 open；因此不存在需要双读的历史持久化 `/1` artifact。此次 reset 必须随 T3.2 提交及 review evidence 留档；从首次持久化开始，任何改变字段/tag/digest 的修改都必须发布新 identity/closure 版本，不得再次原位改写 `/1`。

- 整体：`segment_count:uint32be`，随后每段为 `segment_byte_length:uint32be + segment_bytes`；无 BOM、分隔符、padding 或隐式终止字符。
- 每段：`segment_tag:uint8`，随后按下表字段顺序编码。第一个字段 tag 为 1，依次递增；每字段为 `field_tag:uint8 + utf8_byte_length:uint32be + utf8_bytes`。所有字段值是字符串，保留 Unicode 原始标量序列，不进行 NFC/NFD、大小写或空白归一化。
- 完整 pin 的字段顺序固定为 `workspace_id, published_resource_kind, resource_id, resource_version_id, contract_hash, binding_mode`。owner pin/target pin 采用同一展开顺序。
- 每个 root/owner/target/resource pin 的 `contract_hash` 必须是 71 字符的 `sha256:<64 lowercase hex>`，不能因为结构 Schema 使用非空字符串就接受缩写、其他算法、大小写别名或尾部空白。此处验证语法；已发布记录的真实性仍由 registry/compiler 校验。

| Segment | Tag | Ordered fields |
|---|---|---|
| root | 1 | full pin (fields 1–6) |
| binding | 2 | owner_kind, full owner pin, binding_kind, local_binding_id (fields 1–9) |
| flow_node | 3 | owner_kind, full owner pin, graph_id, node_id (fields 1–9) |
| skill_pack_member | 4 | full owner_pin, local_member_binding_id (fields 1–7) |
| subagent_target | 5 | full target_pin (fields 1–6) |

路径必须恰好以一个 root 开始；后续不得再有 root，`owner_kind=root` 的 pin 必须逐字等于起始 root pin。每路径最多 128 segments；每字符串最多 4,096 UTF-8 bytes；最终编码最多 1,048,576 bytes。这些是当前 publisher/loader 的绝对拒绝上限，不做截断或降级。输入仅接受普通数据对象、连续数组和字符串；拒绝 getter、symbol、额外属性、非法 Unicode、NUL 和超过结构预算的输入。资源 node pin 使用同一输入边界，再经既有 RFC 8785 JCS 编码。

`bp1.` / `rn1.` 后只能是 SHA-256 的 32 字节摘要的 canonical base64url（43 个字符，最后字符的未使用位必须为 0），不允许 `=`、标准 base64 别名、换行、前后空白或再次编码。loader 从原始 segments/pin 重算并精确比较，不把仅通过格式 Schema 当作身份验证。编译器在单个 closure 内登记 canonical bytes：binding path 重复拒绝，resource node 相同完整 pin 可去重，相同 digest 对应不同 canonical bytes 分别以 `BINDING_PATH_DIGEST_COLLISION` / `RESOURCE_NODE_ID_COLLISION` 失败。该内存登记器只服务有界编译过程，不作为跨请求的全局缓存；两类身份合计最多 8,192 entries、16,777,216 retained bytes，超限登记不得修改已存状态。8,192 的 entry ceiling 必须容纳合法的 4,096-node Flow、root resource identity 和后续有界依赖身份；retained-byte ceiling 仍独立生效。

### 4.1 发布时展开

1. 从固定的 Agent Release 或 Flow Version 开始，读取同 Workspace 或受控全局目录中的 typed release registry，固定 `ClosureRootV1.pin/semantic_seed_hash`，并为完整 root pin 生成/验证 resource node ID。
2. 按第 2.2 节验证每条 Binding 的判别 target 及其 closed、versioned kind-specific config；kind/config mismatch、未知字段、空 pin、跨 Workspace 裸引用、未发布/未 seal 版本立即失败。compiler 以完整 owner/target pins 构造 typed path segments，按 `binding-path-lp-utf8/1` 生成 canonical path，并校验 path/node identity 唯一；canonical config version/hash 必须进入对应 `CompiledBindingEntryV1`。
3. 递归展开 Flow 子流程、Skill Pack member 和内部 SubAgent target；所有边使用版本 pin。每个 Skill Pack 公开 operation 必须在展开后精确匹配一条 `pack_binding_path + exposed_operation_id + exposed_operation_contract_hash → member_binding_path + member_target + member_operation_contract_hash` 路由，并写入 `skill_pack_operation_routes`；`pack_binding_path` 必须等于承载该 route 数组的 `CompiledBindingEntryV1.binding_path` 并进入 `route_hash`。零个或多个成员匹配都拒绝发布。G0/G1 的 schema/publisher/admission 必须拒绝 `floating_latest`、`latest`、运行时 discovery 或只存文本 ID；未来 compatibility envelope 也只能引用其已 seal 的版本成员，不能把新 latest 注入既有 closure。
4. 编译 Agent/Flow 的不可变 GateSpec 为 `CompiledGateSpecEntryV1`，验证 Strategy allow-set、Binding `approval_gate_spec` 和 protected operation contract；Flow source path/node 必须属于本 closure。异步 Flow/SubAgent 还必须把 closed `G1JoinChildTerminalOutcomeMapV1` 纳入 config/`async_child_policy_hash`；G1 的缺省、自定义、detach 或非 join 组合立即失败。
5. 构建版本级有向图并检查直接/间接循环。递归深度、资源数、operation 数和 canonical 文档大小必须有平台绝对上限；超限是发布错误，不可截断后运行。
6. 对每条 root-to-leaf 路径按下节规则计算策略交集，然后合并为 Binding 和 root aggregate。必经/forced 路径交集为空时必须拒绝发布；可选 Binding 也必须显式 disabled 并进入 hash，不得在运行时悠悠失败。
7. 以稳定排序和 JCS canonicalization 生成 `closure_hash`，再把该 hash 写入 root release compiled hash、dependency manifest 和发布 registry。嵌套 Agent/Flow 节点必须同时保留目标已发布 `nested_closure_hash`，不得将它用当前编译器原地重算。

#### 4.1.1 Pinned dependency graph preparation

`pinned-dependency-graph/1` 是编译器的中间依赖图，不是 `CompiledCapabilityClosureV1`、授权证据或已发布资源。输入 `pinned-dependency-graph-candidate/1` 固定 closure-local `root`、`root_dependencies` 和恰好覆盖传递依赖的 `resources`。每份 `pinned-dependency-record/1` 包含完整 `pin`、literal `publication_state=sealed`、既有 `published-resource-dependency-manifest/1`；Agent/Flow 另要求 `nested_closure_hash`，其他 kind 禁止该字段。

该步骤重算每份 manifest、核对 owner/full pin、拒绝同版本多 hash、缺失/多余记录、跨 Workspace 引用和直接/间接环，输出 canonical node IDs、edges、dependency-first order 及独立 `graph_hash=SHA-256(JCS(graph_without_graph_hash))`。所有 UUID 必须是合法的小写规范文本；hash 是严格 71 字符 sha256 小写十六进制。集合排序不改变 graph hash，dependency-first order 必须由图计算，不能由调用方指定。深度按 root 到节点的最长依赖边数计算，不能因节点先通过较短路径访问就漏算。

绝对上限：包含 root 最多 256 nodes、1,024 条去重边、最长路径 32 edges；输入/输出最多 8 MiB 字符串数据和 8 MiB JCS bytes，snapshot 最多 131,072 values、depth 12、每数组 1,024 entries、每对象 12 properties、每字符串 4,096 UTF-8 bytes。超限拒绝，不截断。使用 T1 的完整 pin identity，输入无 Proxy/getter/稀疏数组/非法 Unicode，输出 detached/deep-frozen；loader 必须与同一候选快照重算的完整 canonical artifact 精确比较，而不仅比较它自报的 hash。

这里的 `sealed`、root semantic seed 和 nested closure hash 是待上层读取器证明的 registry facts，不因调用方填入字段就成为可信事实。本步骤不验证 root semantics preimage、nested closure body/compiled hash、kind-specific Binding 展开、policy path、GateSpec/route 或发布事务；这些仍是 T3 后续、T4–T6 的硬要求。Agent publisher 继续关闭，不得以该中间图代替最终闭包。受控全局目录需要独立 typed provenance，当前无这种证明的跨 Workspace 输入一律拒绝。

### 4.2 只能收窄的 meet 规则

| 维度 | 合并规则 | 拒绝条件 |
|---|---|---|
| resource/version | 保留精确 typed pin 并对相同节点去重 | 同一身份出现两个 contract hash、裸 ID 或 mutable latest |
| credential | provider/audience 必须精确匹配；required scopes 必须是父 allow-set 子集；principal modes 取交集 | 必需 scope 不被允许、交集为空或出现静默凭据降级 |
| egress | canonical scheme/host/port/path/method 规则取交集；只能从 wildcard 缩小到具体端点 | 网络 operation 无可用规则、DNS/IP/redirect policy 不完整或子级扩大 host/method |
| 读数据分类 | clearance ceiling 取更严的上限 | 目标必需分类高于有效 clearance |
| 输出污点 | 输出分类取所有可达输入/资源中最敏感级别 | 下游投影、日志或模型上下文不允许该级别 |
| side effect | `safe < requires_key < unsafe`；子 operation 不得高于父 maximum，approval 取逻辑 OR；审批时保留精确 GateSpec ID/hash 与 protected operation allow-set | 超上限、必需 operation key 缺失、需审批但无同 closure GateSpec/operation coverage |
| operation contract | 保留精确 schema/side-effect/operation hash，不允许通配覆盖 | 实际 operation 不在 allow-set 或 hash 不同 |
| budget/limits | 金额、token、耗时、calls、depth、parallelism 各自取最小上限 | 必经路径的最小需求已超有效上限 |

“更严格”不能只用枚举大小实现。例如，数据分类对“允许读取上限”取最低 clearance，对“输出污点”则取最高 sensitivity；两者必须是独立字段。

#### 4.2.1 G1 policy vocabulary

`capability-policy-ceiling/1` 表示权限上限，`capability-requirements/1` 表示资源固有需求；两者不可混用。前者的 credential allowance 以精确 `(provider_id, audience)` 为键，保存 scope/principal allow-set；后者保留不可删减的 required scopes。meet 只求上限交集，再校验每个固有需求，不能通过对 required scopes 求交集把资源需求悄悄删掉。空 allow-set 是拒绝，不代表无限制；`none` 是无凭据模式，不可替代有凭据模式。

`canonical-egress-rule/1` 固定 deployment-approved `network_policy` 的 ID、SHA-256 hash 和 address class（`public_only` 或 `approved_internal`），再限制 scheme、ASCII 小写 DNS host、显式 port、绝对 path、HTTP method。不同 policy pin/address class 不可互相替代；Workspace/Binding 不能配置任意 IP/CIDR、DNS server 或 proxy。`public_only` 只接受 HTTPS；受控内部服务可使用 HTTP/HTTPS。单条 rule 不是出网授权证明：准入必须验证 policy pin 的部署级批准事实，执行器仍须落实 ADR-002 的 network-layer、DNS/IP 检查。

- Host `exact` 精确匹配；`subdomains` 匹配任意层级子域但不包含 apex；必须按 `.` 边界收窄。拒绝 IP literal、大小写/尾点别名和 URL 字段混入。
- Path `exact` 精确匹配；`subtree` 包含自身与 `/` 边界后代，根 `/` 包含所有路径。只接受规范绝对 ASCII URI path（非 ASCII 使用大写百分号 UTF-8 编码）；拒绝 query/fragment、反斜线、空段、dot segment、encoded separators/dot/percent/control、非规范 unreserved 编码及非法 UTF-8。运行时 request path 使用同一规范验证，不做多重 decode 或前缀猜测。
- Methods 是 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS 闭集。DNS 固定 `revalidate_each_connection`；每次连接和 redirect 都重新解析、验证并 pin 实际连接地址。Redirect `deny < same_origin < approved_targets`，同时对 `max_hops` 取最小（0 强制 deny；最大 10）。每跳仍须在有效规则内；跨 origin 必须移除凭据，禁止绕过地址检查。
- 规范化先拆分 method 原子、去重、删除被更宽规则完全涵盖的原子，再把其余相同规则的 method 合并并按 JCS 字节序排列。规则的 scheme/port/network pin 必须相同；host/path 取更窄区域，method 取交集，redirect mode/hops 取更严值。
- 输入每策略最多 32 egress rules、32 credential allowances/requirements、128 operation hashes，单集合最多 128 项；规范化最多 224 method 原子，meet 中间结果最多 1,024 个不同原子，规范结果最多 32 rules。超过绝对预算失败，不截断。对象输入必须有界、无 Proxy/getter/cycle/稀疏数组，单字符串 4,096 UTF-8 bytes，总字符串数据 1 MiB、最多 32,768 值、深度 12。

`capability-budget/1` 所有维度都必填：`amount_credits` 为 PostgreSQL bigint 范围内规范非负十进制字符串；`input_tokens`、`output_tokens`、`total_tokens`、`duration_ms` 为非负 safe integer。各自取 min，0 代表零额度，不是 unlimited，缺字段/未知字段拒绝。calls/depth/parallelism 同样为非负 safe integer。金额比较只使用 bigint，不转换为 Number。资源的 `minimum_limits` 必须逐维不超过有效上限。

`minimum_limits` 是一次能力执行需要同时满足的最低资源消耗，因此除逐轴校验外，`input_tokens + output_tokens` 的最低消耗之和也不得超过有效 `total_tokens` 上限；用 bigint 做联合可行性比较。ceiling 的 input/output 上限不必相加小于 total 上限，后者可以合法地限制二者的联合使用。

纯内核在返回前对完整规范结果重新执行同一结构/字节预算验证，再深度冻结；两份合法输入的笛卡尔交集可能增加输出大小，必须在本次 meet 拒绝，不能等下一次使用才失败。不访问网络、凭据或数据库；其 meet 结果本身不是可信授权凭证。GateSpec/operation-key 的实际绑定、registry 真实性和 epoch 重验证仍分别由 T3–T5 实现。

## 5. 发布、准入与运行时

### 5.1 发布

- closure 编译必须无网络副作用，只读已封存的 release/registry 和受控全局目录。需要临时 discovery 的 Plugin/MCP 必须先发布 tool-list release，再参与 closure。
- publisher 必须在同一 assembly 事务中写入 closure blob/hash、root compiled hash、dependency manifest 和 registry row；任一部分失败就不得 seal root release。
- seal 后 closure 不得 UPDATE/DELETE。依赖升级、政策扩大、operation schema 变更或 Skill Pack 成员变化必须创建新 root release。

### 5.2 准入

- `ResolvedAgentPlan`/`RunPlan` 必须固定 `closure_hash`，并把 closure 与调用主体、类型化 admission profile/entry grant、当前 credential/resource grant、数据分类和顶层预算再取一次交集。Agent 使用固定 `AgentDeploymentRevisionV1 + AgentDeploymentEntryGrantV1`，顶层 Flow 使用固定 `FlowDeploymentRevisionV1 + FlowDeploymentEntryGrantV1 + FlowAdmissionProfileV1`，Agent 内嵌 Flow 继承父 Plan 的准入上限；三者不得借用 Workspace 默认 credential 或互相回退。每个 mapping/grant 都必须通过其 closed discriminator 和 literal kind/principal/audience/channel/scope/cardinality 校验。该过程只能把已发布 `binding_path` 写入 enabled 或 `disabled_binding_paths` 集合并缩小其 policy，不能添加 closure 中没有的 path/target/operation。
- 准入决策必须记录 `closure_hash + effective_policy_hash + authorization_decision_id + epoch source set`。高风险 forced Binding 被收窄为不可用时必须拒绝整个 Plan，不得交给模型绕过。

### 5.3 Capability Call 与重验证

- Strategy/Flow engine 只能以 canonical opaque `binding_path + operation_contract_hash` 发起 Call。Capability dispatcher 在外部副作用前必须对 path 做固定长度/prefix/base64url 语法校验、在固定 closure 中精确查找，并验证 closure loader 已从 typed segments 重算出同一 digest；随后要求 path 存在于 Resolved Plan enabled 集合且不在 `disabled_binding_paths`，并重验证当前 epoch 只有收窄变化。禁止 decode path 猜资源、接受另一种可规范化字符串或按局部 ID fallback。Skill Pack Call 还必须通过已 seal 的唯一 `SkillPackOperationRouteV1` 路由到 member path，不得按局部 ID/名称搜索成员。
- resource/grant/credential 撤销可以使未开始 Call 失败，但不得使用其他 release 或当前 latest 代替。对应类型的 Deployment active pointer 切换不改变已接受 Run 的 closure；只有稳定 Agent/Flow Deployment 的独立 `status/revoke_epoch` 可以收窄旧 Run 后续调用。该 epoch 是永久 fence：一旦与 Plan 中 observed 值不同，该旧 Run 在随后重新 ACTIVE 后也不得恢复能力；新 Run 必须按当前 epoch 重新准入。
- Call 至少持久 root/binding path、实际 target pin、closure/effective policy hash、operation hash、authorization decision、credential 非秘密指纹、副作用/幂等回执和 usage。
- G1 `async_child_policy_hash` 只允许 `join/cascade/safe_summary/wait_for_settlement` 与固定五态 outcome map。child `SUCCEEDED/FAILED/CANCELLED/TIMED_OUT/NEEDS_ATTENTION` 分别投影为父 Call `SUCCEEDED/FAILED/CANCELLED/FAILED/NEEDS_ATTENTION`，root 父 Run 为“继续/FAILED/CANCELLED/FAILED/NEEDS_ATTENTION”；最后一种必须传播 operator hold、保留未知 reservation/allocation 责任且不可被父 error fallback、Gate disposition 或 resume 覆盖。投影按 `parent_call_id + child_run_id + child_terminal_event_sequence` 唯一消费。

### 5.4 Agent/Flow 共享的 production promotion gate

Agent 与顶层 Flow 不得各自发明 production gate 字段或状态机。两者共用下列 closed canonical decision；受限 promotion 函数只接受该类型：

~~~ts
interface ProductionPromotionGateKeyV1 {
  schema_version: "production-promotion-gate-key/1";
  workspace_id: string;
  deployment_kind: "agent" | "flow";
  deployment_id: string;
  candidate_deployment_revision_id: string;
  candidate_revision_contract_hash: string;
  executable_target: PublishedResourcePin<"AGENT_RELEASE" | "FLOW_VERSION">;
  dependency_manifest_hash: string;
  capability_closure_hash: string;
  evaluation_suite_release_id: string;
  evaluation_policy_hash: string;
  evaluation_run_ids: string[]; // canonical 排序、去重
  evidence_bundle_hash: string;
  observed_evidence_epoch_hash: string;
  expected_activation_epoch: number;
}

interface ProductionPromotionGateDecisionV1 {
  schema_version: "production-promotion-gate-decision/1";
  decision_id: string;
  key: ProductionPromotionGateKeyV1;
  key_hash: string; // SHA-256(JCS(key))
  status: "PENDING" | "APPROVED" | "REJECTED" | "INVALIDATED" | "CONSUMED";
  decision_version: number;
  expires_at: string;
  decided_by?: string;
  decided_at?: string;
  invalidated_at?: string;
  invalidation_reason?: string;
  consumed_at?: string;
}
~~~

- key 按上述字段 JCS canonicalize；数组先按协议排序去重，不允许别名、缺省 target kind 或只用 revision ID 查找证据。Agent 的 Experience/policy/credential mapping 和 Flow 的 entry/mapping 均必须进入各自 `candidate_revision_contract_hash`；可执行 Release/Version、dependency manifest、closure、评测运行/evidence 与 observed evidence epoch 另以显式字段防止错配。持久层对 `workspace_id + key_hash WHERE status IN ('PENDING','APPROVED')` 施加唯一约束，确保同一 key 同时只有一个可决策/可消费事实；terminal decision 永久保留，重开审批必须创建新 `decision_id` 和 immutable `expires_at`。decision 创建后 key/key hash/expiry 均不可 UPDATE。
- 唯一状态迁移是 PENDING → APPROVED|REJECTED|INVALIDATED、APPROVED → CONSUMED|INVALIDATED；REJECTED|INVALIDATED|CONSUMED 均终结。状态只能用 `decision_id + decision_version + current_status` CAS 更新；`expires_at` 到达时 PENDING/APPROVED 必须 CAS 为 INVALIDATED，不能继续消费或原地延长。
- 候选 revision/contract hash、target pin、dependency/closure hash、evaluation suite/policy/run/evidence 状态、observed evidence epoch 或 expected activation epoch 任一改变，受限函数必须把尚未消费的 decision 置为 INVALIDATED 并要求以新 canonical key 创建 decision；不得在旧审批上换 pin、换 evidence 或改 expiry。
- production activation 必须在同一事务锁定 deployment security state、active pointer、candidate revision 和 decision，要求 security state ACTIVE、decision APPROVED、当前时间早于 `expires_at`、key 逐字匹配且当前 activation_epoch=expected_activation_epoch；重验证 evidence 后以 `decision_id + decision_version + APPROVED` CAS 切换 pointer/递增 epoch、写 audit 并将 decision 置为 CONSUMED。任一步失败整体回滚；同一 decision 不可二次 promotion/rollback。
- G0 不存在产生 APPROVED production decision 的路径，production pointer 的 INSERT/UPDATE 与 promotion 函数一律 fail closed。G1 实现评测/evidence gate 后才可启用上述单一路径。

## 6. SubAgent bounded delegation

bounded delegation 是 closure 的二次收窄，不是凭据或权限复制。运行时 `BoundedDelegationGrantV1` 必须固定 parent Run/Call/Plan/closure、target release、原始与受委托主体、binding/resource/operation allow-set、audience/scopes、egress、data class、side-effect、budget/depth/call limits、`projection_contract_hash`、有效期、nonce、审计理由和 canonical hash。

子 Plan 的有效集合为：

```text
parent delegable closure
  ∩ published delegation policy
  ∩ runtime delegation grant
  ∩ target release closure
  ∩ delegated principal current authorization
```

交集为空、grant 过期/重放、超调用或深度、目标 closure hash/projection contract hash 不匹配、父授权被撤销或需要不可委托凭据时必须 fail closed。任何 secret material、父 Agent 完整 Tool 目录、raw full history、system/developer 指令、Capability observation 或未在 context projection allowlist 的数据都不得进入 grant/子 Plan。只有经过消息类型/字段 allowlist、分类上限、脱敏策略和 turn/token 窗口裁剪的 `eligible_history` 才可投影，运行时只能继续删除。

## 7. Canonicalization 与 hash

### 7.1 G1 executable source preimage profile

`prepareExecutableSource` 接受闭集 `executable-source-candidate/1`：`workspace_id` 加 `document`。Agent 使用独立 `agent-executable-source/1`（复用 Agent Release 的字段和跨引用约束，但禁止 `compiled_hash`/`capability_closure_hash`）；Flow 使用 `flow-ir/1`。不接受以 placeholder hash 冒充未编译的 Agent Release。

`executable-semantic-preimage/1` 的完整字段为 `schema_version`、`compiler_version="capability-compiler/1"`、`canonicalizer_version="rfc8785/1"`、`workspace_id`、`published_resource_kind`、`document`。语义 seed 是该对象的 SHA-256/JCS。`document` 只删除 Agent 顶层 `release_number`/`source_draft_revision_id` 或 Flow 顶层 `title`/`ui`；不得递归删除同名业务字段、JSON Schema title、角色提示或数组内容。

规范集合：Agent bindings/instruction skills 按 binding ID、Gate 按 spec ID、public handles 按 handle 排序；Strategy allow IDs、credential scopes/principal modes、instruction capability IDs、database table revision IDs、Skill Pack exposed operation IDs 和 SubAgent typed allow-sets 按契约排序。Flow 递归规范 graph nodes/edges/exit IDs、resource pins 和 credential requirements；branch cases 的 first-match 顺序、任务模板顺序、普通 JSON/opaque 子合同内数组保持原顺序，不能凭同名字段猜其集合语义。仅 source profile 显式声明的集合在这里规范化；更深 action/policy 子合同由对应版本 adapter 验证。

所有根/依赖完整 pin 使用严格小写 UUID 和 71 字符 SHA-256；Agent 直接依赖由 Strategy、Instruction Skill 和全部 Capability Binding（包括 disabled）派生，Flow 由固定 `resources` 派生。普通图/branch/loop 内 subflow 必须解析到其中的精确 Flow ID/version pin；根版本自依赖拒绝。typed hash 字段在此校验规范拼写，**不是**对相应远端或 opaque 内容的真实性证明。

解析前 snapshot 和输出复验均限制：8 MiB 字符串与 key UTF-8 数据、8 MiB JCS bytes、131,072 values、depth 64、数组 1,024 entries、对象 128 properties、字符串 65,536 UTF-8 bytes、key 256 UTF-8 bytes，Flow 全部子图合计最多 4,096 nodes。仅允许 plain JSON 数据，无 Proxy/accessor/cycle/稀疏数组。Schema parse 前后 JCS 必须逐字一致；例如 Zod record 会丢弃的 own `__proto__` 数据键必须拒绝，不能生成忽略该输入的 hash。语义规范化只发生在无损 schema parse 之后。

`deriveExecutableCompiledHash` 仅把该 preimage 的 `schema_version` 换为 `executable-compiled-preimage/1`，追加严格 `capability_closure_hash`，再 SHA-256/JCS；`verifyExecutableCompiledHash` 同时核对完整 final pin。该纯 hash-binding primitive 不验证 closure 正文、registry seal 或准入。T3.2 剩余 compiler 必须从 source adapter 重建 Binding/policy/operation 和嵌套闭包，再允许把此摘要用于 T6 原子发布；本步骤不解封现有 publisher，也不更换历史 G0 Flow registry hash。

#### 7.1.1 Operation declaration source profile

`operation-contract-source/1` 是一个具体 operation 的闭集内容源，完整字段为 `schema_version`、五类 `operation_kind`、`operation_id`、`input_schema`、可选 `output_schema`、`side_effect_class`、`operation_key_required` 与 `approval_required`。它禁止调用方提供 `input_schema_hash`/`output_schema_hash`/`contract_hash`。`requires_key` class 必须显式要求 operation key，`knowledge_query` 的 class 只能为 safe。Plugin 的 operation ID 使用固定发布工具的 `provider_tool_name`；其他类型的 ID 由其固定目标 adapter 定义，不按名称发现或猜测。

`prepareOperationContractSource` 首先应用 §7.1 的 source snapshot/无损解析边界，operation ID 另限 4,096 UTF-8 bytes。输入/输出 schema 对象完整 JCS/SHA-256，不删除 title、default、examples 或业务数组；对象 key 顺序无关，数组顺序保留。output schema 缺失和显式空对象不是同一事实。`operation-contract-preimage/1` 包含 `canonicalizer_version="rfc8785/1"`，以及 `OperationContractPinV1` 除 `contract_hash` 外的全部字段；`contract_hash=SHA-256(JCS(preimage))`。输出 `prepared-operation-contract-source/1` 固定原 source、preimage、完整 pin，并再次应用同一预算后深度冻结。两个 verify API 分别重算并比较完整 artifact 或完整 pin，不能只比较自报 contract hash。

`verifyBindingOperationContract` 验证单个具体 Binding 与 operation 源的声明一致性：闭集 Binding/完整 typed target pin 语法、operation kind、输入/输出 hash 与缺失状态、精确 effect class、operation key source、所需 approval 声明；knowledge/database/plugin 还必须匹配 config 中的 operation hash，plugin 必须匹配 provider tool name。Binding 可额外要求审批或 operation key，但不得省掉 operation 所需的要求。database 必须同时为 G1 read-only/safe，并落实 config 中更严的 key 声明。disabled Binding 同样校验，不能藏入失效契约。Skill Pack 必须进入 T4 的精确成员路由，不使用此单 operation helper 降级。此 helper 不新增 path、授权或发布能力。

**边界：** 这里证明的是完整 JSON 内容到 operation pin 的绑定，不执行 JSON Schema meta-validation/实例校验，不验证 provider/SQL/索引实现或 registry provenance，也不证明 GateSpec coverage。Flow/SubAgent Binding 没有本地 operation ID/hash 槽，该 helper 只核对共有声明；固定 target 与对应 operation source 的关系必须由后续 kind-specific release adapter 和 closure compiler 验证。最终编译仍须把真实 leaf/operation 资源源、schema validator、typed policy、嵌套 closure 与 registry 证据一起连接；不能把任意自洽 source/pin 当作目标已发布事实。G0 publisher 与历史摘要不受本 profile 更改。

#### 7.1.2 Typed leaf resource sources

`leaf-resource-source-candidate/1` 固定 `workspace_id` 与一个闭集 typed `document`，只接受下列四类；资源 ID/version ID 与 Workspace 都是 canonical 小写 UUID。公共正文包含 manual 文本、完整 `operation-contract-source/1` 与 `leaf-capability-requirements/1`。requirements 只声明凭证、principal modes、egress、read/output classification、minimum limits；禁止自报 operation hash、effect 或 approval，这三项从正文 operation 重算。

| Source / resource kind | 哈希覆盖的真实 typed 正文 | 当前语义校验 |
|---|---|---|
| `knowledge-index-generation-source/1` / `KNOWLEDGE_INDEX_GENERATION` | source manifest、ingestion/parser digest/chunks、embedding provider/model/revision/dimensions/metric、retrieval、rerank、metadata filter policy、index shard manifest | safe knowledge query；强制 Workspace/文档 ACL；chunk overlap 小于 size；暴露 metadata 字段须有声明；rerank top_n 不超过 top_k |
| `database-operation-source/1` / `DATABASE_OPERATION_RELEASE` | PostgreSQL16 connector identity/hash、带分类/类型的 table revision、typed SELECT、强制 Workspace row policy | safe database operation；同一 table revision；所有列存在；tenant 为 non-null UUID；principal filter 列为 UUID；参数名在 object input properties 中声明；所有读取列满足 read clearance 和 output taint |
| `plugin-tool-source/1` / `PLUGIN_TOOL_RELEASE` | provider/tool identity、transport、implementation digest、sandbox profile、完整 tool-list operation 正文 | http_json 或 mcp_streamable_http；选择的 tool name 对应唯一 operation；该 operation 的完整正文必须相等 |
| `a2a-agent-source/1` / `A2A_AGENT_RELEASE` | provider/skill identity、transport、内部 agent-card projection 的 revision 和全部 skill/operation 正文 | a2a_jsonrpc；唯一 skill ID 与完整 operation 正文相等；所有 skill operation 均为 subagent_call |

网络 transport 是闭集 `capability-network-transport/1`：一个 exact DNS host/exact path/单 HTTP method、已命名的 network policy pin、deny redirects、timeout、response byte cap、remote identity/revision/hash 与 none/credential authentication。其规范 egress 必须等于 source requirements 中的完整 egress。credential 模式恰好一个同 requirement ID/provider/audience 的需求，provider 也必须等于资源 provider；所有 source principal modes 与凭证允许模式相等，无 none fallback；none 模式没有凭证且 principal modes 固定 `[none]`。不包含 token、任意 auth header 或 secret 引用。拒绝 `latest`/`floating_latest`（不区分大小写）revision；其它 revision/digest 仍需可信发布源确认不可变性，字符串格式本身不是确认。

数据库查询只允许 select columns、AND predicates（eq/ne/lt/lte/gt/gte/in）、ordered order_by、1–500 max_rows 和 1–300,000 ms timeout，不接受 raw SQL、函数或任意表达式。SQL identifier 限小写 ASCII identifier、最长 63；无 predicates 时允许不含 properties 的空 object input schema。SELECT、predicate、order、系统 tenant/principal filter 列都属于读取集合，其最高分类同时约束 read 与 output，防止结果成员/排序泄露。`database-additional-filter/1` 只能追加 AND predicates，不能替换强制租户策略。

规范集合由完整 entry 的 JCS bytes 排序：knowledge sources/metadata fields、DB columns/principal filters、plugin operations、A2A skills、credential requirements；内部字符串集合排序，egress 复用 policy kernel 的规范化。查询 select_columns（结果列次序）、predicates、order_by 以及业务 JSON Schema 数组保序。重复 source ID、列名、metadata 字段名、tool operation ID、skill ID、shard digest 等拒绝。绝对结构/编码预算沿用 §7.1；每个 tool-list/card 最多 128 成员，knowledge source/shard 最多 1,024，列/过滤字段最多 128；网络 response cap 最多 8 MiB。其余明确数值闭区间以 `leaf-resource-source-v1.ts` 的版本化 Schema 为准。

`prepareLeafResourceSource` 先 bounded snapshot + 无损 schema parse，再验证/规范上述正文。`leaf-resource-preimage/1` 精确包含 `schema_version`、`compiler_version="capability-compiler/1"`、`canonicalizer_version="rfc8785/1"`、`workspace_id`、`published_resource_kind`、完整规范 `document`；完整 pin 的 contract hash 为 SHA-256/JCS(preimage)。结果 `prepared-leaf-resource-source/1` 包含 document、preimage、full_pin、重算 operation_contract、intrinsic_policy、component_hashes 与空直接依赖 manifest，应用输出预算后深冻结。component hashes 对应表中 named 子合同（另含公共 manual）；implementation digest 绑定在完整 preimage 中。叶资源的这些 inline 子合同不是另一个可执行 PublishedResourcePin，故直接依赖为空，不能用于隐匿嵌套 executable dependency。

`verifyLeafResourceSource` 分别按 8 MiB/source profile 限制 expected 与 candidate，重算并比较全部 artifact 字段，不额外施加一个破坏 prepare→verify 往返的共享 8 MiB。`verifyLeafResourceBinding` 对 Binding+candidate 施加合并 source 预算，核对完整 target pin、manual 文本/hash、operation 声明、output classification、凭证所有 required scopes 与 ID/provider/audience，以及非空更窄 principal modes。knowledge filter hash 和 plugin transport hash 必须相等；external A2A target kind 必须匹配；网络 Binding timeout 不能超过 transport。DB 的唯一 table version、max_rows/timeout 不能扩大，allowlist 必须覆盖 SELECT/predicate/order 和附加 filter 的全部用户列；固定 tenant/principal 安全过滤列不要求加入用户列 allowlist，但仍受 source 分类约束。附加 filter 也不能读取高于 source read/output 分类的列。

**集成边界：** Binding 可以增加 required scopes、审批/key、提高 output taint、减少 principal modes/limits；helper 返回的仍是 **source intrinsic artifact**，不是合并 Binding 后的 effective path policy。最终 compiler 必须单独纳入 Binding 的更严要求与限制。此处不解析/执行 SQL，不做 JSON Schema 元/实例校验，不验证真实索引、连接器、二进制、远程 tool discovery 或 A2A 官方协议符合性；也不验证 network approval、DNS/IP runtime enforcement、sealed registry/readback、Workspace 内容归属或 nested closure。可信 catalog/artifact readback、完整 closure 与 T5/T6 admission 才能把这些内容用于发布执行。四种纯 source adapter 不构成完整应用、上线或新的 host-attested Acceptance；现有 G0 publisher 不变。

#### 7.1.3 Agent Strategy source and assembly profile

`agent-strategy-source-candidate/1` 固定同 Workspace 与 `agent-strategy-source/1` 正文。正文包含 Strategy/release UUID、`agent-strategy-abi/1`、implementation digest、真实 config/config schema、input/state/decision/observation 四个 ABI schema、sandbox profile、allowed model policy、允许的 capability/gate ID 集合及 iterations/model attempts/tool calls 上限。调用方不能提交 component hashes 代替这些正文。

`strategy-sandbox-profile/1` 是闭集声明：profile ID、固定 host ABI、network/filesystem/database/secrets 四项均为 deny、memory 上限 1–1,073,741,824 bytes、instruction count 1–1,000,000,000。`strategy-model-policy/1` 包含最多 128 个唯一 descriptor ID 的完整 `(descriptor_id, provider_id, model_id, model_revision, model_contract_hash)`，拒绝 latest/floating_latest revision；input/output token cap 分别为 0–1,000,000。这是本项目的固定模型声明格式，不是厂商模型目录或当前账号授权证明。允许 ID 集合各最多 128 项，iterations 为 1–1,000,000，model/tool 次数为 0–1,000,000。

`prepareAgentStrategySource` 应用 source 有界快照与无损解析，ID 集合按字典序、模型集合按完整 JCS bytes 排序，业务 JSON 数组保序。`agent-strategy-source-preimage/1` 精确含 schema/compiler/canonicalizer versions、Workspace、`AGENT_STRATEGY_RELEASE` kind 与完整 document；完整 pin hash 为 SHA-256/JCS(preimage)。八个 component hashes 为 config、config_schema、四个 ABI schema、sandbox_profile、allowed_model_policy。另导出与 `AgentStrategyPinV1` 完整对应的 strategy_pin 及空直接依赖 manifest；输出再次有界并深冻结。verify 分别限制 expected/candidate，重算比较完整 artifact。

`verifyAgentStrategyAssembly` 先通过真实 Agent executable source 语义校验，再核同 Workspace、完整 strategy_pin 相等；Agent 自身的 model policy 每个完整描述必须属于 Strategy 模型集合，两个 token cap 只能收窄，空模型/零 cap 合法。Agent 不存在的 Binding/Gate ID 不能通过。这不验证 config/schema 实例、二进制实现、实际 sandbox enforcement、模型 registry、发布或 ResolvedPlan；这些仍由后续集成完成，不修改 G0 Strategy 发布摘要。

#### 7.1.4 Skill Pack source projection profile

`skill-pack-source-candidate/1` 固定同 Workspace 与 `skill-pack-source/1` 正文。正文为 resource/release UUID、manual、真实 input/可选 output envelope schema、1–128 个唯一 `binding_id` 的完整 typed member Bindings，以及 1–128 个唯一 `exposed_operation_id` 的曝光声明。每个曝光包含 exposed ID、member Binding ID、member operation ID 与完整 `operation-contract-source/1`。拒绝自报 projection/hash、动态 discovery 或未定型成员。

`prepareCapabilityBindingSource` 复用 executable source 的闭集、同 Workspace full-pin、hash 与显式集合规范化，不修改原输入；声明 `requires_key` 必须给出 operation key source。`prepareSkillPackSource` 对所有成员执行此边界，成员按 binding ID、曝光按 exposed ID 排序。禁用/未曝光成员仍完整保留并进入直接依赖 manifest；同版本冲突 hash 和自身 pack version 依赖均失败。每个曝光必须指向已启用的存在成员：非 pack 成员通过单 operation 声明核对并匹配 operation ID；嵌套 pack 必须在成员 config 找到 exact exposed ID/hash，并满足已知 operation 的 effect/key/approval 最低要求，不按名称发现。

`skill-pack-source-preimage/1` 精确含 schema/compiler/canonicalizer versions、Workspace、`SKILL_PACK_RELEASE` kind 和完整 document。完整 pin hash 为 SHA-256/JCS(preimage)。输出 `prepared-skill-pack-source/1` 包含 document、preimage、full_pin、全部直接依赖 manifest、manual/input/可选 output component hashes，以及：

- `exposed_operations`：每项固定 exposed ID/hash、member Binding/operation ID、完整 member target pin 与重算 operation pin。
- `member_projection`：`schema_version="skill-pack-member-projection/1"`、完整规范 member Bindings 和上述 exposed_operations；`member_projection_hash=SHA-256(JCS(member_projection))`。

整个输出再次应用 source 预算并深冻结；verify 独立限制 expected/candidate 并比较全部 artifact。`verifySkillPackBinding` 核对 typed full target pin、manual 文本/hash、完整 envelope schemas/缺失状态、projection hash 与 exact exposed ID/hash 子集。enabled Binding 的子集不能为空；disabled Binding 可为空，但不删除源成员/依赖。外层 effect class 不得低于所选成员与已知 operation；operation/member 要求 key 或审批时必须保留，output classification 不得低于所选成员。

**证明范围：** 这里固定的是源声明与局部曝光映射，不是 `SkillPackOperationRoute` 的 canonical path seal。子 pack 正文、所有成员（含曝光/未曝光成员）目标的实际来源、递归循环/closure、最终路径策略交集、凭证/egress/budget 收窄、GateSpec coverage 与 registry readback 仍由 T3/T4/T5/T6 完成。envelope schema 在此仅绑定内容，不做 JSON Schema 验证或输入转换执行。不得以此投影替代已发布资源、运行时路由授权或完整应用验收。

#### 7.1.5 Instruction Skill signed inert source profile

`instruction-skill-source-candidate/1` 包含同 Workspace UUID、闭集 `instruction-skill-source/1` document 和完整文件数据。document 固定 resource/release UUID、name/description、`parser_version="instruction-skill-bundle-parser/1"`、`entry_path="SKILL.md"`、origin（publisher_id/source_id/非 latest revision）、manifest、allowed_capability_binding_ids、context_budget_tokens、data_classification、scripts 与 signature。manifest 每项为 path、kind（instruction/reference/asset/script）、size_bytes 和 content_hash（原始文件 bytes 的 SHA-256）。这是本项目的有界 JSON bundle 协议，不声明 BetterYeah Skill 格式兼容、ZIP/TAR 导入或文件系统解包能力。

- 1–64 个唯一文件，与 manifest 精确一一对应；manifest/files 按 path、allowed IDs 按字典序规范排序。每文件最多 1 MiB、全部解码 bytes 最多 2 MiB；文件以最多 22 个 canonical base64 chunk 表示，每个解码后 1–49,152 bytes，非末尾 chunk 必须恰好 49,152 bytes；零字节资源用空 chunks 数组。实际长度/hash 必须匹配 manifest，不接受声明替代实际数据。
- path 必须 NFC，最多 1,024 UTF-8 bytes、8 段、每段 128 bytes；拒绝绝对/空/dot/dotdot 段、反斜线、百分号、冒号、Windows 禁用字符/设备名、末尾点或空格、C0/C1 控制符、Unicode 大写再 NFC 后的别名与文件/目录前缀冲突。唯一 instruction 为 `SKILL.md`；其他 kind 只在对应 `references/`、`assets/`、`scripts/` 下。内核不提取文件，不调用脚本。
- SKILL.md 必须为 1–65,536 bytes、有效 UTF-8、非空白，拒绝开头 BOM 和除 Tab/LF/CR 外的 C0/C1；保留正文换行/Unicode bytes，不执行 Markdown 或解析其中的指令。其余资源（包括 scripts）为签名覆盖的惰性 bytes。`scripts.mode` 只允许 inert；requires_execution=true 显式报 `SKILL_SCRIPT_EXECUTION_UNSUPPORTED`，没有脚本降级执行路径。
- capability ID 集合最多 128，context budget 为 1–1,000,000 整数 token，classification 为 public/internal/confidential/restricted。沿用 §7.1 的独立 candidate/expected/trust 与完整返回 artifact 预算；输入合法但返回 artifact 超预算也失败，不截断。

签名采用 Ed25519，signature 固定 algorithm/key_id/64-byte canonical base64。`instruction-skill-trusted-signers/1` 是独立传入的可信配置：同 Workspace、最多 128 个唯一 key_id，各项固定 publisher_id/source_id、1–128 个 allowed_resource_ids 及 canonical base64 公钥 SPKI。验签同时匹配这些 scope；候选自身不能添加公钥或 trust 字段使自己可信。**调用方必须从可信发布者配置提供此集合；纯 helper 不验证配置的 registry provenance、撤销状态或宿主权威。**

`instruction-skill-signing-payload/1` 精确为 schema_version、canonicalizer_version=`rfc8785/1`、workspace_id、published_resource_kind=`INSTRUCTION_SKILL_RELEASE`、规范 document 去除 signature，以及 signer={algorithm,key_id}；对该对象的 JCS bytes 验签。manifest hash 已与实际 bytes 核对，因此元数据、内容、资源身份和来源均被签名绑定。公钥只接受精确 44-byte Ed25519 public SPKI DER，解析再导出必须逐字相等；随后使用固定 `@noble/curves@2.4.0` 严格解码 raw point（非 ZIP215）、排除 identity 与非 torsion-free 公钥，并显式 `verify(...,{zip215:false})`。DER 合法不等于公钥可安全验签。参见 [库的 Ed25519 接口](https://github.com/paulmillr/noble-curves/blob/2.4.0/README.md)；升级实现必须重跑真实验签和 key/option 边界回归。签名/信任 scope 错误统一为 `INSTRUCTION_SKILL_SIGNATURE_INVALID`，不返回底层 crypto diagnostics。

`prepareInstructionSkillSource` 输出 `prepared-instruction-skill-source/1`，包含规范 document/files、signing_payload、signature_evidence（schema/key/publisher/source/public_key_hash/signed_payload_hash）、完整 preimage/full_pin、content_hash、inert_content 与空直接依赖 manifest。`instruction-skill-source-preimage/1` 固定 compiler/canonicalizer versions、Workspace、resource kind 与完整规范 document（含 signature），完整 pin hash=SHA-256/JCS(preimage)。`content_hash=SHA-256(JCS({schema_version:"instruction-skill-content/1",parser_version,entry_path,manifest}))`；inert_content 仅导出入口正文/hash、allowed IDs、context budget、classification 与 inert 模式。所有返回内容深冻结，verify 重新核对真实文件、签名及整个 artifact，不只比较自报 hash。

`verifyInstructionSkillAssembly` 先核真实 Agent executable source、同 Workspace 和指定 Instruction Skill Binding 的 full pin/content_hash；Binding token budget 不得超过源 budget，Binding allowed IDs 必须全部属于源集合，源中的每个 ID 都必须存在于 Agent Capability Bindings（即使该 Skill Binding 没有选择它）。不把 Skill 作为 Tool，也不派生新 Capability 依赖。**源证明不是最终 `CompiledInstructionSkillDescriptor`**：closure-unique path 映射、能力有效策略、activation/priority、按模型 tokenizer 的预算裁剪、分类授权、嵌入/渲染安全、registry seal 和真实运行仍由后续 compiler/host 集成落实。内容签名与 host-attested reviewer Acceptance Receipt 完全不同，不可互相替代。

#### 7.1.6 Bounded JSON Schema validation profile

`prepareJsonSchemaContract` / `verifyJsonSchemaContract` / `validateJsonSchemaInstance` 实现独立的、无外部加载器的单资源 JSON Schema 2020-12 平台 profile。它不是任意 dialect/扩展的兼容层；既有 source helper 仍只负责声明绑定，不能把其同步返回值当成 Schema 校验成功。新增异步校验与原 source hash 分离，避免悄悄改变已固定的声明身份。

`json-schema-validator-profile/1` 固定 `ajv@8.20.0`、`ajv-formats@3.0.1`、dialect=`https://json-schema.org/draft/2020-12/schema`、完整 formats 模式及明确的 format 白名单。strictSchema/strictNumbers/validateSchema/validateFormats 开启，allErrors/useDefaults/coerceTypes/removeAdditional 关闭，ownProperties=true、inlineRefs=false、unicodeRegExp=true。未知 keyword/format、旧 dialect、`$async`/`$data`/自定义 keyword/loader 不受支持，不能静默忽略；标准 annotation 保留为数据，`contentSchema` 自身接受结构检查，但 contentEncoding/contentMediaType 不意味着执行内容解码或验证。

- schema 可以是 boolean 或 object；调用方 schema/instance 各自同步复制并采用 §7.1 source snapshot 预算（8 MiB JCS、131,072 数据节点、64 深度、1,024 数组项、128 对象字段、65,536 UTF-8 string bytes、256 key bytes）；拒绝 getter/Proxy/cycle 等非 JSON 值。整个准备后的 artifact 也必须独立满足预算。额外最多 4,096 个 schema-bearing 位置，只遍历明确的 schema map/array/single keyword，不把 const/default/examples 中的业务字段当 Schema。
- 仅允许同文档 `#` fragment 引用。嵌套 `$id` 禁止；root `$id` 不产生外部访问。所有 anchor/dynamicAnchor 名称在单资源内唯一，引用必须指向已识别的 schema 位置或存在的 anchor。fragment 必须采用唯一的 URI 编码和 JSON Pointer 转义，未使用定义中的无效引用也拒绝。schema map 与 dependentRequired 的 `__proto__` key 被显式拒绝，因为引擎会省略该约束；这不禁止用 patternProperties 校验真实数据中的同名 own property。
- 原文 profile/meta-schema 检查通过后，仅在 worker 副本中将 anchor ref 转换为已确认的 schema-location pointer；`$dynamicRef` 转为 `$ref`。同节点已有 `$ref` 时在 allOf 尾部追加新约束，保留所有原 sibling、数组索引和指针位置。此降级仅在本 profile 的**单资源、唯一 anchor、禁止外部引用**下成立：不存在另一资源的动态 override；普通 anchor/pointer 按规范本就执行静态目标。修复避免引擎对部分动态目标错误回退到 root validator。原始 source 文档和 hash 不变。依据 [JSON Schema core §8.2.3.2](https://json-schema.org/draft/2020-12/json-schema-core)。放宽 resource/ref 规则必须重新设计并版本化 profile，不能复用此证明。

每次编译/实例校验创建固定文件的 Node worker，`env={}`、`execArgv=[]`、`argv=[]`，不注册用户 callback、loader 或任何 schema-supplied executable。父线程在首次 await 前完成快照；同模块实例最多 4 个活 worker，无队列，第五个调用返回 BUSY。单 Schema 与 source batch worker 从启动后的父线程计时起均最多 5 秒，old/young generation 128/16 MiB、stack 4 MiB；超时请求 terminate，只有 exit 事件释放并发槽。停止事件幂等；terminate Promise 拒绝时返回 UNAVAILABLE 但保留槽位直到实际 exit。未知/重复消息、messageerror、stdout/stderr、异常/非零退出均失败；仅一次 `ok` 且 exit=0 才成功。错误不回显 Schema、实例或引擎 diagnostics；OOM/耗时/预算失败映射为 LIMIT。

`prepareJsonSchemaContractSummaries` 接受 1–8,194 个独立 Schema，整个数组仍受 8 MiB aggregate operand 预算；父线程按 canonical bytes 去重后只向一个 worker 发送唯一文档，worker 逐个独立编译并在每项后移除非 meta-schema 注册，避免相同 root `$id` 跨资源碰撞。去重只减少编译，返回仍保持原顺序和每个字段的独立 hash/contract_hash。任一项无效、5 秒总 deadline、worker/OOM/协议失败都会拒绝整批；小批次不会获得更长的 worker-slot 占用窗口。

**worker 是响应性与资源隔离措施，不是 OS 安全沙箱或进程总内存保证。** `env/argv` 清空不等于抹除一切宿主状态；Node worker 仍处于同一进程并继承 Node environmentData。该 API 不接受代码、网络引用或凭证；宿主不得把此机制用作运行任意不可信代码的边界。并发额度是模块实例内的额度，不是跨进程全局限流。每次调用重新编译，没有预编译缓存或 pool。设计参考 [Ajv 对不可信 Schema 的限制](https://ajv.js.org/security.html) 与 [Node Worker API](https://nodejs.org/download/release/v22.22.0/docs/api/worker_threads.html)。

`prepared-json-schema-contract/1` 完整包含 document、schema_hash=SHA-256/JCS(document)、完整固定 validator_profile 与其 hash，以及 `contract_hash=SHA-256(JCS({schema_version:"json-schema-validation-contract/1",schema_hash,validator_profile_hash}))`。verify 重新校验真实 Schema 并逐字比较完整 artifact。instance API 编译并校验实际值，返回独立深冻结快照；禁止靠默认填充、类型强转或删除额外字段让非法值通过。

实际 source 接口：

- `prepareSchemaValidatedOperationSource` / `verifySchemaValidatedOperationSource` 校验 operation 的真实 input_schema 和存在时的 output_schema，不虚构缺失输出。
- `prepareSchemaValidatedStrategySource` / `verifySchemaValidatedStrategySource` 顺序校验 config/input/state/decision/observation 五类 Schema，再用 config_schema 校验真实 config；不执行 Strategy 或验证 implementation_digest/sandbox 的宿主真实性。
- `prepareSchemaValidatedExecutableSource` / verifier 显式校验 Agent input/optional output contract、全部 GateSpec decision Schema、全部 Capability Binding input/optional output Schema；Flow 校验 root input/output、递归 branch/else/loop graph 的每个 node output 与 human-gate decision Schema，不把 exports/config 中普通业务 JSON 当 Schema。
- `prepareSchemaValidatedLeafResourceSource` / verifier 校验四类 leaf 的主 operation；Plugin 额外校验 tool_list 的全部 operations，A2A 额外校验 agent_card 全部 skill operations。
- `prepareSchemaValidatedSkillPackSource` / verifier 校验 pack envelope、全部 member Binding 与全部 exposure operation 的 input/optional output Schema。

Operation/Strategy 返回原完整 source_artifact、`source-schema-validation-evidence/1` 与 validation_hash。新增 executable/leaf/pack wrapper 分别使用对应的 `schema-validated-*-source/1` 和 `source-schema-set-validation-evidence/1`；证据固定 source artifact/profile hash、schema_count、按 canonical field path 排序的 field/hash/contract_hash，并每 1,024 项切成一批以满足通用数组预算。去重编译不能折叠字段证据。整个 wrapper 再次限制大小并深冻结，verify 重建所有校验，不信自报 source/evidence/count/batches/hash。它们是可重算的校验结果，**不是签名 attestation、registry seal、host-attested reviewer receipt 或发布授权**。最终 closure compiler 尚须消费这些 wrapper；实例执行输入/输出校验、registry/readback、UI/API/runtime 和线上验收仍待后续实现。

### 7.2 Final closure integration

`closure_hash = SHA-256(JCS(closure_without_closure_hash))`。JCS 指 RFC 8785 JSON Canonicalization Scheme。root 必须按以下两阶段顺序生成，不得把 final `compiled_hash` 又放回 closure 形成循环：

```text
semantic_seed_hash = SHA-256(JCS(root executable semantics
                                 without compiled_hash/capability_closure_hash/registry contract_hash))
root closure pin.contract_hash = semantic_seed_hash
closure_hash       = SHA-256(JCS(canonical closure using that closure-local root pin))
compiled_hash      = SHA-256(JCS(root executable semantics + closure_hash + compiler/schema versions))
registry contract_hash = compiled_hash
```

嵌套依赖的 `PublishedResourcePin.contract_hash` 是它们已完成上述流程后的 registry contract hash，可以安全进入父 closure；只有当前 root 的 closure-local pin 使用 `semantic_seed_hash`，它不得被用于绕过 registry 中最终 `compiled_hash` 的 seal/readback 校验。实现必须先进行以下语义规范化：

- `assembly_pins`、`resource_nodes`、`dependency_edges`、`bindings`、`gate_specs`、`disabled_binding_paths`、`skill_pack_operation_routes`、typed path segments、scope/host/operation/binding path 数组按协议定义的字典序排序并去重；有业务顺序的数组另保留原顺序并在 schema 标注。
- URL/host/method/scope/schema ID 使用唯一 canonicalizer；Unicode 、number 和 JSON Schema `$ref` 必须遵循 contract toolchain 的固定版本。
- 排除 UI 坐标、标题、临时时间、数据库 surrogate row ID、secret material 和 `closure_hash` 本身；不排除发布 resource IDs、version IDs、contract hashes、policy 上限、disabled binding paths 和 Skill Pack operation route hashes。
- compiler/canonicalizer/schema 版本变更如果可能改变输出，必须发布新 schema version；不得用新编译器原地重算旧 Release hash。

## 8. 错误码与失败边界

| 错误码 | 阶段 | 含义 |
|---|---|---|
| `CAPABILITY_TARGET_KIND_MISMATCH` | Compile | Binding 判别式与 registry target kind 不匹配 |
| `CAPABILITY_DEPENDENCY_UNRESOLVED` | Compile | 传递性依赖不存在、未 seal 或 contract hash 不匹配 |
| `CAPABILITY_OPERATION_CONTRACT_MISMATCH` | Compile/Load | 完整 operation 源/pin 或 Binding 声明不一致 |
| `CAPABILITY_DEPENDENCY_CYCLE` | Compile | Flow/Skill Pack/SubAgent 调用图存在循环 |
| `CAPABILITY_CLOSURE_LIMIT_EXCEEDED` | Compile | 闭包深度、节点、operation 或大小超平台上限 |
| `CAPABILITY_POLICY_NOT_CLOSED` | Compile/Plan | 凭据、egress、数据、副作用、operation 或预算交集无法满足必经路径 |
| `BINDING_PATH_CANONICALIZATION_FAILED` | Compile/Execute | typed segments 与 `binding-path-lp-utf8/1` 不一致、存在第二编码或解析不唯一 |
| `BINDING_PATH_DIGEST_COLLISION` | Compile/Load | 相同 opaque path digest 对应不同 canonical typed segments，必须 fail closed |
| `RESOURCE_NODE_ID_COLLISION` | Compile | 相同 node ID 对应不同完整 pin，或实现只按局部 version ID 去重 |
| `GATE_SPEC_NOT_CLOSED` | Compile/Plan | GateSpec 缺失/重复/hash/source/kind/operation coverage 不匹配 |
| `ASYNC_CHILD_OUTCOME_MAP_UNSUPPORTED` | Compile/Admission | G1 child policy 缺失或偏离固定 join 五态映射 |
| `SKILL_PACK_OPERATION_UNRESOLVED` | Compile | exposed operation 没有唯一的 member path/pin/hash 路由 |
| `SKILL_PACK_OPERATION_AMBIGUOUS` | Compile | 两个或更多 member 宣称同一 exposed operation |
| `CAPABILITY_NOT_IN_RESOLVED_PLAN` | Execute | Strategy/Flow 尝试调用 closure/Plan 外能力 |
| `CAPABILITY_CLOSURE_HASH_MISMATCH` | Admission/Resume | root release、Plan、checkpoint 或 target closure hash 不一致 |
| `DELEGATION_NOT_EFFECTIVE` | Plan/Execute | bounded delegation 交集为空、过期、撤销或超限 |

所有错误必须指向脱敏的 `binding_path`、维度与 contract hash；不得回显 secret、完整内部 schema、未授权 resource ID 或另一个 Workspace 的存在性。

## 9. 验收夹具

| 夹具 | 必须证明 |
|---|---|
| `kind-safe-targets` | 每个 BindingKind 只接受第 2.2 节的 target kind，错 kind/裸 UUID 失败 |
| `kind-specific-config-closed` | 每个 Binding 只接受对应版本 config；错 kind、未知字段、缺 schema version 和 G1 DB write/Flow detach/SubAgent detach 均失败 |
| `floating-binding-rejected` | G0/G1 schema、publisher 和 admission 均拒绝 `floating_latest/latest`，不会以 compatibility approval 绕过 |
| `nested-flow-tightening` | 父 Flow 收窄子流程 scope/egress/effect/budget，子级不能扩大 |
| `skill-pack-expanded` | pack 的所有成员和 operation 均进入 closure，每个 exposed operation 只有一条 member path/pin/hash 路由；零/多匹配发布失败，runtime 不 discovery |
| `binding-path-membership` | 嵌套 Release 重复使用局部 binding ID 时，disable/执行仍仅影响精确 closure path，不影响同名 sibling；合法局部 ID 含 `/`、`:`、Unicode 或前缀相似值时 length-prefixed typed encoding 仍无歧义，空 ID 与非 canonical 第二编码失败 |
| `resource-node-full-pin` | 相同 version UUID 在不同 Workspace/kind/resource/contract 下得到不同 node ID；同 node ID 不同 full pin 以 collision 失败 |
| `subagent-cycle` | 跨多个 Agent/Flow 的间接递归在发布时被拒绝 |
| `delegation-intersection` | 子 Plan 严格等于五方交集，credential material 不传递 |
| `subagent-eligible-history` | raw full history/system/tool observation 被拒绝；投影严格受 allowlist、分类、脱敏、窗口和 projection hash 约束 |
| `classification-two-directions` | clearance 取更严上限，output taint 取更高敏感级别 |
| `canonical-permutation` | 不具业务顺序的输入数组乱序后 closure hash 不变 |
| `revocation-no-rebind` | 运行中撤销使 Call 失败，不改用 latest/其他 release |
| `typed-deployment-admission` | Agent/顶层 Flow 各自只接受 closed credential mapping/entry grant 及其 literal kind/principal/audience/channel/scope/target cardinality；Agent 内嵌 Flow 不走顶层 Flow 入口，两个 Deployment kind 不互借 |
| `gate-spec-closure` | Agent/Flow 发布 GateSpec 进入 closure；Strategy/Binding 只能引用精确 ID/hash/source/operation，运行时自报 approver/expiry/disposition 失败 |
| `join-child-terminal-map` | G1 五种 child terminal 逐字映射 parent Call/root Run；`NEEDS_ATTENTION` 传播 operator hold 并保留未知账务责任，重复 terminal Event 不重复投影/结算 |
| `active-pointer-not-an-epoch-source` | promotion/rollback 不影响已接受 Run；不可变 revision pin 不是 epoch source；SUSPENDED 后旧 Run 被永久 fence，重新 ACTIVE 仅允许带新 observed epoch 的新 Run；REVOKED 不可恢复 |
| `shared-production-promotion-gate` | Agent/Flow 使用同一 canonical key/status/CAS；revision/target/closure/evidence/epoch/expiry 任一漂移即 INVALIDATED，竞争消费只有一个 CONSUMED；G0 production 写入永远失败 |

本文只冻结目标契约。直到 schema、compiler、registry 复合外键、授权决策、恶意夹具和恢复测试在实际实现中通过之前，不得把 closure 报告为已上线能力。
