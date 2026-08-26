---
type: sprint
status: completed
created: 2026-08-25
mode: auto
---

# 架构就绪门与实施计划 Sprint

## 用户请求

再次检查当前架构是否仍有缺陷，判断是否已经具备直接编写实施计划的条件；若门条件满足，继续形成可执行、可验证的实施计划。

## 当前阶段

`g0-04-implemented-locally`（第四轮最终架构 Review 未发现 P0/P1；Gate A 文档冻结通过；G0-01～G0-04 本地底座已落地，下一依赖项为 G0-05；G0-08 未通过前不得进入 G1）

## Think：范围与产品边界

### 要做

- 以当前仓库文档为唯一工作基线，重新审查 Agent、Flow、Knowledge、Database、Plugin/MCP、Instruction Skill、Strategy、SubAgent、Deployment、Credential、HumanGate、Evaluation 与 Run/计费之间的边界；
- 检查 ADR、领域契约、数据模型、OpenAPI/SSE、实施切片之间是否存在双重事实源、无法落成物理约束的多态引用、状态机缺口、授权/副作用/恢复矛盾或阶段依赖倒置；
- 把问题分为：阻断实施计划的 P0/P1、可以随实现切片闭环的 P2、兼容研究未知项；发现可在设计层确定修复的缺陷时直接回写文档；
- 只有架构就绪门通过后，才进入 Plan Phase，形成按迁移、控制面、运行时、接口和验证顺序可执行的实施计划。

### 不做

- 本 Sprint 不直接实现业务代码、执行数据库 migration、启动服务、变更外部系统、提交或推送 Git；
- 不把现有 SQL/OpenAPI 草案、拓扑或已完成研究当成运行时已实现证据；
- 不等待 BetterYeah 独立 Skill 等兼容未知项来阻塞本项目自有安全闭环，除非它会改变 G1 的不可逆数据/API 形状；
- 不为了“可以开工”而弱化 RLS、不可变 Release、类型化授权、幂等恢复、账务事实源或评测 promotion gate。

### 可观察的成功标准

1. **WHEN** 架构审查完成，**THE SYSTEM SHALL** 为每个关键控制面给出唯一事实源、不可变身份、状态转移、授权主体、事务边界、失败语义和可验证落点，且跨文档无相互冲突的规范表述。
2. **WHEN** 某项仍只有概念模型或 SQL 草图，**THE SYSTEM SHALL** 明确它是“计划内实现工作”还是“实现前产品决策”；只有后者阻断进入 Plan。
3. **WHEN** Agent/Flow/子 Run/HumanGate 涉及恢复或外部副作用，**THE SYSTEM SHALL** 能从准入、lease/fencing、checkpoint、operation key、outbox、取消到终态计费给出闭合失败路径。
4. **WHEN** 判断“可以写实施计划”，**THE SYSTEM SHALL** 同时给出 readiness matrix、剩余风险、依赖顺序、每阶段验收证据和停止条件，而不是仅凭文档数量或静态检查通过。
5. **WHEN** 仍存在会改变租户隔离、凭据绑定、发布身份、运行状态或公开 API 的开放决策，**THE SYSTEM SHALL** 停留在 Think 并明确阻断；否则 `--auto` 进入 Plan。

### 风险、假设与待确认

- 本 Sprint 入口时仓库仍是文档设计资产；“缺少物理 migration/源码”本身是实施任务，不自动等于架构缺陷，但其目标约束必须足够明确，不能让实现者自行决定安全语义；
- 历史草图与后置冻结章节可能同时存在，必须验证优先级声明是否足以防止误实现，必要时删去或进一步隔离旧语义；
- OpenAPI 已使用本机可用的 `yaml` parser 完成语法与 duplicate-key 检查，但仍缺正式 OpenAPI 3.1 semantic linter/bundler/breaking/example validator；它影响机器契约验收完备性，但不阻断 G0 Plan；
- BetterYeah 独立 Skill、部分跨平台依赖冻结行为仍是兼容未知项；默认不改变本项目 `InstructionSkillRelease` 与类型化 Binding 的自有设计。

### 下一步

执行架构就绪门审查；若不存在开放产品决策或不可逆外部影响，则自动进入 Plan Phase。

## Plan：初始架构就绪门基线（历史，已被后续 Review 轮次取代）

### 结论

**Sprint 入口判定为 Conditional No-Go。** 顶层方向当时已经足以编写一份“架构修复优先”的任务级实施计划，但文档尚不能直接作为业务功能编码依据。下表保留初始审查证据，不代表文件当前结论；唯一当前 verdict 必须读取文末最新 Review/Work 段落。

### 初始 Readiness matrix

| 控制面 | 当前判定 | 阻断级别 | 进入实现前必须关闭的事项 |
|---|---|---:|---|
| Draft → Release → Deployment → ResolvedPlan → Run | 方向正确，重验证语义冲突 | P0 | active pointer 只参与准入；另设 Deployment revoke epoch；已接受 Run 只按固定 revision/resource/credential/policy 收窄 |
| Agent → Flow/Plugin/DB/Knowledge/SubAgent | 缺传递性授权闭包 | P0 | `CompiledCapabilityClosure` 固定依赖、凭据需求、出网、数据分类、副作用上限与 operation contract |
| 浏览器/SDK 最终用户身份 | 未冻结可信主体 | P0 | 冻结 host-backed token exchange、短期 session token、anonymous 限制以及 conversation 的 principal/deployment 约束 |
| 租户上下文与 RLS SQL | 草案包含必现错误和 definer 风险 | P0 | 修复 `format` 占位符、统一安全 `search_path`/schema qualification，并增加临时表攻击夹具 |
| 财务账本 retention | 可被通用 Run retention 删除 | P0 | G1 禁止删除 `credits_ledger`；未来清理必须使用独立财务保留、不可变归档回执和审批 |
| Flow HumanGate | 状态机与执行 ABI 不闭合 | P1 | 补 `SUSPENDED`、GateSpec、WAITING/RESUMING、resume cursor 和 checkpoint 事务边界 |
| Agent Strategy/LLM loop | 只有配置 pin，无可恢复 ABI | P1 | 冻结 strategy ABI、durable loop state、model-call attempt、终止原因、恢复和计费规则 |
| Resource/Binding kind | 枚举混用，无法 kind-safe FK | P1 | 分离 `BindingKind` 与 `PublishedResourceKind`，各 Binding 使用判别式 pin |
| SubAgent delegation | 枚举无法表达限权 | P1 | 定义 bounded delegation object 和同步 `agent_execution_id`/subplan/checkpoint 边界 |
| Instruction Skill script | 是否可执行存在扩权歧义 | P1 | G1 固定 scripts inert；后续执行脚本必须是独立、类型化、可授权的 code-tool Binding |
| API 幂等/错误/可见性 | 多处跨文档冲突 | P1 | 统一 Run/mutation 幂等、blocking 投影、404、60001 映射、公开 selector 和 conversation create 语义 |
| detach 账务 | 历史快照不可变但当前结算不可查询 | P1 | 保留 immutable terminal snapshot，另增 current billing state；G1 公共 child policy 仅 `join` |
| Runtime event 写入 | 缺 lease/fencing 与角色边界 | P1 | admission/executor 分权，按事件校验 Run/Attempt/Step、lease/fence 和状态迁移 |
| credential rotation / fail-open | 两套轮换语义且缺可证明的 sealed envelope | P1 | 常规 rotation 新建 credential；G0/G1 完全拒绝 `floating_latest`/`legacy_allow`，未来兼容能力必须单独设计不可变版本集合和重新 seal 的安全上限 |
| Flow/Knowledge 物理生命周期 | 逻辑契约与数据草图命名不一致 | P1 | Draft 与 immutable version 分表；统一 source/pipeline/run/generation 及 release registry kind |
| 研究文档与路线图 | 已出现生命周期/依赖漂移 | P1 | 标记旧草图非规范，修正 Deployment/Experience、`subagent`、secret 和 G1 依赖顺序 |
| BetterYeah 独立 Skill 与黑盒字段 | 仍需外部证据 | P2 | 保持兼容未知项，不阻塞本项目自有 Instruction Skill/typed Binding |
| OpenAPI 正式 parser | 当前环境缺工具 | P2 | 作为 G0 toolchain 任务安装并在 CI 执行 parse/lint/breaking/example checks |

### 本 Sprint 采用的安全默认决策

1. **身份。** `user.id` 仅是渠道展示属性，不是认证主体。宿主后端以稳定 Deployment publish credential 加已验证用户身份换取短期 browser session token；token 固定 `workspace_id + deployment_id + channel + principal_id + origin + audience + expiry + session_epoch`。G1 不开放匿名 Agent；匿名主体和 delegated connector 后移。
2. **Run 授权。** active pointer 只在 admission transaction 中读取并固定 revision；运行中重验证不得因 promotion/rollback 失败。稳定 Deployment 的独立 revoke/status epoch 可停止旧 Run 的后续能力调用；epoch 只增不减且永久 fence 旧 Run，重新 ACTIVE 只允许新准入，不能把旧 Run 的能力恢复或扩大。
3. **嵌套闭包。** Flow/Agent compiler 输出传递性 capability closure；父 Binding 的 side-effect、credential、egress、data-classification 和 operation policy 只能与内部闭包取更严格值。
4. **幂等。** Run 接受事务持久化 canonical `202 Operation` acceptance receipt；blocking 只是首次连接上的可选终态投影，不是幂等事实。任何命中既有 key 的重放均返回已保存的 acceptance receipt，客户端再 GET/SSE。mutation key 唯一范围为 `(workspace, principal, fixed route template, key)`，目标 Run/Gate 位于 JCS intent；跨目标复用返回 409。
5. **账务。** `terminal_billing_pending` 是不可变历史快照；当前结算另由 `billing_state=PENDING|SETTLED|NEEDS_ATTENTION` 与 `billing_settled_at` 投影。G1 对外 child policy 只实现 `join`，可执行 schema、迁移和枚举均不保留 dormant `detach`；未来若在 G2 引入，必须使用新版本契约、迁移和独立验收门。
6. **公开 ID。** 公共 Chat/SSE 默认只返回稳定公开 selector/operation/run ID，不返回内部 Release/version/resource pin；具有 observe-internals scope 的管理 API 才可读取 pin。
7. **错误。** 机器错误统一使用字符串 `error.code`；余额不足为 `CREDITS_INSUFFICIENT`。BetterYeah 兼容响应可同时投影顶层整数 `code: 60001`，不得把整数塞进 `error.code`。
8. **Flow/Agent runtime。** Flow 支持 durable suspend/resume；并发只保证因果顺序、单 Run sequence 单调与相同终态，不承诺并发完成事件逐项同序。Strategy 必须实现可版本化 ABI 和 durable loop checkpoint。
9. **Skill/DB/兼容绑定。** G1 Instruction Skill script 全部 inert。G1 只交付参数化、只读、限行限时的 Database Operation 夹具；写 DB、可执行 Skill script、public detach、匿名 Agent 与 `floating_latest` 后移到独立架构门，不能借兼容 profile 绕过 immutable closure。
10. **会话升级。** Deployment revision 固定由变量、session-state 与 history/context serialization ABI 计算的 `conversation_contract_hash`；会话创建时保存该 hash。G1 仅允许 hash 相同的会话跨 Agent Release，不相等在任何 Run/计费/投递副作用前返回 409 并要求新会话，不做隐式迁移；已命中的幂等 Run 仍重放原 receipt。
11. **契约事实源。** `docs/api/openapi.yaml` 是 REST 规范源，生成 TS 类型/运行时 validator/client；migration SQL 是数据库源，生成数据库类型/repository 约束；Markdown 解释语义但不得反向覆盖机器契约。

## Plan：本 Sprint 的文档修复任务

> 下列任务在 Work Phase 执行。本 Sprint 只修改文档与 SQL 设计草案，不创建运行时代码、不执行 migration、不把静态检查表述成数据库验证。

### A1 — 冻结 Agent/Flow 可恢复执行与传递性权限闭包

- **目标：** 消除 promotion 漂移、嵌套 Flow 扩权、HumanGate、Strategy ABI、kind-safe pin、SubAgent delegation、Skill script 和并发事件顺序的歧义。
- **文件集合：** `docs/architecture/agent-release-v1与能力装配契约.md`、`docs/architecture/flow-ir-v1与运行时契约.md`、新增 `docs/architecture/agent-runtime-strategy-v1.md`、新增 `docs/architecture/compiled-capability-closure-v1.md`。
- **依赖：** 无；A2/A4/A5 依赖本任务的术语和状态机。
- **风险：** L4（授权、恢复和副作用边界）。
- **验收证据：** active pointer 不出现在已接受 Run 的 call-time epoch vector；closure 有 canonical schema/hash；Flow 有 durable suspend/resume；Strategy ABI 有 attempt/checkpoint/终止/计费；`BindingKind` 与 `PublishedResourceKind` 分离；G1 script 明确 inert；相应跨文档检索无旧冲突表述。

### A2 — 冻结最终用户身份与公共 API 一致性

- **目标：** 使 browser principal、conversation ownership、Run read、幂等、错误、内部 ID 可见性和账务查询形成单一公开契约。
- **文件集合：** `docs/adr/003-多租户与凭据模型.md`、`docs/adr/004-持久化执行与计费.md`、`docs/06-API契约.md`、`docs/api/SSE与异步操作契约.md`、`docs/api/openapi.yaml`。
- **依赖：** A1 的 Deployment/Run/closure 术语。
- **风险：** L4（公开 API、跨用户隔离、计费）。
- **验收证据：** OpenAPI 出现 browser session exchange 与同一认证模型；Chat 有 404；conversation create 不再暴露未定义幂等；Run replay 固定 202 acceptance receipt；resume/cancel 使用同一 mutation scope；`error.code` 只为 string；公共事件不泄漏 pin；GET Run 有 current billing state。

### A3 — 修复 SQL 草案的必现错误与安全边界

- **目标：** 修复 tenant context、SECURITY DEFINER、parent-link、ledger retention、billing intent、rotation、runtime fencing 和 fail-open approval 缺陷。
- **文件集合：** `docs/database/001-租户与凭据.sql`、`docs/database/004-运行与计费.sql`。
- **依赖：** A1/A2 的 epoch、身份、账务与状态语义。
- **风险：** L4（RLS、账本、并发执行）。
- **验收证据：** control context `format` 参数一致；所有 definer function 的 relation schema-qualified 且 `pg_temp` 最后；G1 无 ledger delete path；settle/release 比对 canonical billing intent hash；credential verifier 对普通应用角色不可读且禁止原地修改；Run 准入事实不可改、未终态幂等键不释放；event append 校验角色/lease/fence；G0/G1 基线完全拒绝 `floating_latest`/`legacy_allow`，未来若启用必须先冻结版本集合、安全上限、重新审批与重新 seal 的独立契约/migration。静态 SQL 检查通过；真实 PostgreSQL 运行仍明确列为 G0 实现证据。

### A4 — 统一物理生命周期与 conversation 数据边界

- **目标：** 让 Flow Draft/Version、Knowledge source/pipeline/run/generation、Deployment entry、conversation principal 与 published resource registry 有可落成的唯一模型。
- **文件集合：** `docs/05-数据模型.md`。
- **依赖：** A1、A2、A3。
- **风险：** L4（不可逆 schema/API 形状）。
- **验收证据：** Flow draft 与 immutable version 分离；Knowledge 四段生命周期与 registry kind 一致；conversation 有同 Workspace 的 principal/deployment 复合约束；Run mutation key 不含 target；billing current state 与 terminal snapshot 分离；旧 direct Agent entry 明确不可迁移上线。

### A5 — 清理研究草图和架构总览漂移

- **目标：** 防止实现者从非规范研究文档复制第二套生命周期、secret 或执行链。
- **文件集合：** `docs/04-技术架构.md`、`docs/09-角色设定深研.md`、`docs/10-技能系统深研.md`、`docs/00-INDEX.md`。
- **依赖：** A1～A4。
- **风险：** L2（文档投影）。
- **验收证据：** 研究草图标明规范优先级；Experience/Deployment 分离；`subagent` 命名统一；Plugin/Flow 不持有实际 `secret_ref`；执行链从 Deployment admission 开始；技术栈写为 OpenAPI contract-first generation。

### A6 — 形成任务级产品实施计划

- **目标：** 将高层能力路线图改造成 G0/G1 可执行计划，包含 ownership、依赖、红测、验证命令、读回证据和停止条件。
- **文件集合：** `docs/07-实施计划.md`、本 Sprint 计划文件。
- **依赖：** A1～A5。
- **风险：** L3（执行顺序和里程碑承诺）。
- **验收证据：** G0 先于业务功能；S0a closure kernel → S1a Flow → S2a Strategy runtime 不再依赖倒置；G1 明确只读 DB operation、join-only child、authenticated browser exchange、linear Flow/Agent loop；每个任务有明确文件集合和证据；任何 G0 gate 失败都会停止 G1。

### A7 — 文档级验证与审查

- **目标：** 在当前 docs-only 环境中验证格式、链接、围栏、OpenAPI 引用/operationId、SQL delimiter 与关键冲突词；明确未验证边界。
- **文件集合：** 本轮所有改动文件，只读检查。
- **依赖：** A1～A6。
- **风险：** L2。
- **验收证据：** `git diff --check`；全量 Markdown 相对链接存在；代码围栏成对；OpenAPI `$ref` 目标和 `operationId` 唯一；SQL function delimiter 成对；禁止模式检索通过。没有 PostgreSQL 16/OpenAPI parser 时必须报告为未验证，不得升级证据等级。

## Plan：G0/G1 产品实施依赖图

```text
G0-01 Monorepo/CI
  ├─ G0-02 OpenAPI/Schema contract toolchain [P]
  └─ G0-03 PostgreSQL migration + test harness [P]
G0-02 + G0-03 ──> G0-04 tenant/auth/principal/assertion/RLS
G0-02 + G0-04 ──> G0-05 registry/release/deployment/admission-profile/browser-session facts
G0-03 + G0-04 + G0-05 ──> G0-06 run/billing/outbox/idempotency/human-gate
G0-06 ──> G0-07 executor roles + lease/fencing + failure injection
G0-02..07 ──> G0-08 architecture executable gate
G0-08 ──> G1-01 closure canonicalizer + policy meet + ResolvedPlan kernel
G1-01 ──> G1-02 Flow IR/compiler [P]
       └─> G1-03 Knowledge generation + read-only DB operation [P]
G1-02 + G1-03 ──> G1-04 Agent compiler + Strategy runtime + inert Skill activation
G0-06 + G1-01..04 ──> G1-05 worker/recovery/HumanGate/SubAgent join
G0-02 + G0-04 + G1-05 ──> G1-06 API/SSE/browser projection
G1-01..06 ──> G1-07 evaluation/promotion ──> G1-08 vertical E2E gate
```

## Plan：任务级产品实施计划

### G0-01 — Monorepo 与最小 CI

- **目标：** 建立不携带业务语义的 TypeScript workspace 与统一质量命令。
- **文件集合：** `package.json`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、`.github/workflows/ci.yml`、`packages/test-support/**`。
- **依赖：** A7 文档审查完成。
- **风险：** L2。
- **红测/证据：** 先提交会失败的 workspace smoke；完成后 `pnpm lint`、`pnpm typecheck`、`pnpm test` 在 clean checkout 可重复通过。

### G0-02 [P] — Contract-first OpenAPI 与领域 Schema 工具链

- **目标：** 把 `docs/api/openapi.yaml` 变成 REST 唯一机器事实源，并为 Agent/Flow/Closure/Strategy schema 建立版本化校验和生成链。
- **文件集合：** `packages/api-contract/**`、`packages/domain-contracts/**`、`scripts/check-contracts.mjs`；只读输入 `docs/api/openapi.yaml` 与 `docs/architecture/**`。
- **依赖：** G0-01。
- **风险：** L2。
- **红测/证据：** 先加入 broken ref、duplicate operationId、invalid example、breaking response fixture；`pnpm contract:check` 执行 OpenAPI 3.1 parse/lint/bundle、生成一致性和兼容检查。

### G0-03 [P] — PostgreSQL 16 migration 与攻击测试工具链

- **目标：** 将设计 SQL 拆为有序 migration，并提供真实 PostgreSQL 16、pgvector、RLS/并发/故障注入测试环境。
- **文件集合：** `packages/db/migrations/**`、`packages/db/test/**`、`packages/db/package.json`、`infra/test/postgres/**`。
- **依赖：** G0-01。
- **风险：** L3。
- **红测/证据：** 空库 migrate、rollback/reapply、schema snapshot、临时表遮蔽、跨租户、并发事务红测；`pnpm db:test:postgres16` 全绿且二次 migrate 无漂移。

### G0-04 — Tenant/Auth/Principal/Assertion/RLS

- **目标：** 实现管理身份、不可读 verifier 的 Access-Key 认证投影、真实 credential kind、scope、principal、一次性 subject assertion、单向 credential rotation 与租户上下文，并冻结供 G0-05 组合授权消费的窄接口；`publish` 的 scope 只允许 browser exchange，但本任务不创建依赖尚不存在 Deployment 的 entry grant/browser session。`deployment_publish|agent_invoke|flow_invoke` 只作为由 OpenAPI operation 决定的 purpose 标签，不建持久化 profile 或新的 epoch source，也不开放 `floating_latest` 兼容例外。
- **文件集合：** `packages/db/bootstrap/**`、`packages/db/migrations/00{1,2}_*.sql`、`packages/auth/**`、`apps/api/src/modules/auth/**`、`infra/test/postgres/bootstrap-test.sql`、`infra/test/postgres/run-auth-rls-integration.mjs`。
- **依赖：** G0-02、G0-03。
- **风险：** L4。
- **红测/证据：** 跨 Workspace/跨 principal 越权、kind/scope 混用、publish kind 获得 Agent/Flow operation scope、无期限/可延长 overlap、revoked/expired 回活、低 scope runtime 读取/重放 verifier、伪造 `user.id`、重复 subject assertion nonce、错误 issuer/audience、temp-table shadow 与任何 `floating_latest` 发布全部失败；verifier 使用经审计的 constant-time 边界且数据库参数/错误/trace 禁止记录可重放值；credential/principal/assertion/RLS 读回一致。需要 Deployment 的 target/grant/cardinality 验收属于 G0-05，不得用 mock grant 让 G0-04 假绿。
- **当前状态（2026-08-26）：** 本地实现与 PostgreSQL 16 攻击 harness 已通过；method/route/operation-bound policy proof、结构化 principal、Workspace/credential observed epoch 与同一物理连接 COMMIT/ROLLBACK 原始 GUC 清理均已纳入门禁。证据明细与未验证边界见文末 G0-04 实施回写。

### G0-05 — Published Resource、Release 与 Deployment

- **目标：** 实现 kind-safe registry、Draft/immutable Release、dependency manifest、Agent/Flow 判别式 Deployment revision、各自 closed scope 的类型化 entry grant、不可变的 per-Run admission profile、credential mapping、不可变 Experience public-handle map、候选 active pointer、独立 revoke epoch，以及绑定 Deployment 的 browser-session 存储/签发/撤销原语。公开准入只由 G0-04 credential kind/status/epoch + scope + 本任务 typed grant + distinct Deployment cardinality 联合派生；通用 Release grant 只可服务隔离的 System/preview，不得成为 Agent/Flow 公共入口。Agent/Flow admission 均原子要求 `ACTIVE` 并保存 observed revoke epoch。G0 只允许 development/staging 激活或初始非生产 bootstrap；production promotion 在 G1-07 的统一 decision/CAS 落地前数据库级 fail closed。
- **文件集合：** `packages/db/migrations/003_release_deployment.sql`、`packages/release-core/**`、`apps/api/src/modules/releases/**`、`apps/api/src/modules/deployments/**`、`packages/db/test/releases/**`。
- **依赖：** G0-02、G0-04。
- **风险：** L4。
- **红测/证据：** Draft 不可运行、sealed Release 不可变、错误 kind/cross-workspace FK 拒绝；每个 OpenAPI purpose 的 kind + literal scope + Agent/Flow typed grant + target cardinality 可由独立 SQL readback证明，publish credential 不能直接运行、Agent credential 不能调用 Flow 入口、Flow 多目标或无 matching profile 拒绝、通用 Release grant 不能代替公共 entry grant；public handle 不唯一/错 binding/schema 拒绝、browser session 不匹配 Deployment/origin/audience 拒绝、非 `ACTIVE` Deployment 不可新准入且 Run 固定 observed epoch、production 在统一 evaluation decision 落地前拒绝；promotion 原子切 pointer+audit 并展示 conversation contract 变化，`SUSPENDED → ACTIVE` 后旧 Run 永久失权而新 Run 使用新 epoch 成功，`REVOKED` 不可恢复。

### G0-06 — Run/Billing/Outbox/Idempotency/HumanGate 事实层

- **目标：** 实现 acceptance receipt、共享 Run/Step 状态枚举、Run/Attempt/Step/Event/Checkpoint/Gate/Outbox、G1 join-only parent link、受控 child allocation/cancel cascade、reservation/allocation/ledger、人工 reconciliation/correction 事实、分类 retention horizon、current billing state 与带 terminal event 墓碑的 immutable terminal snapshot。
- **文件集合：** `packages/db/migrations/004_run_billing.sql`、`packages/run-core/**`、`packages/billing-core/**`、`packages/db/test/run-billing/**`。
- **依赖：** G0-03、G0-04、G0-05。
- **风险：** L4。
- **红测/证据：** 同 key 同 intent 重放/不同 intent 冲突、cancel key 跨 target 冲突且 canonical intent 只由可信边界计算、非终态或长时间 WAITING 的 key 永不释放、终态后至少 24 小时 replay grace、跨 Run/Gate key 冲突；终态 result 必须通过 accepted output schema ref/hash，result/error/billing snapshot/terminal event id+sequence 不可变且在 Event purge 后 cancel/finalizer replay/read 仍稳定；Run 准入字段更新拒绝、非终态 billing 只能 PENDING、内部 `NEEDS_ATTENTION → FAILED + SIDE_EFFECT_UNKNOWN` 非法组合拒绝；child 只能由唯一事务同写 child/link/allocation/event/outbox，孤儿 child 与非 join 值拒绝，父 cancel 产生去重 cascade intent/outbox；余额并发不为负、过期前不得标记 reservation expired、billing key 不同金额冲突、operator hold 只有带审批证据的幂等 correction 可推进 current billing state 且不能改终态；events 至少 7 天、checkpoint/Gate/outbox dedupe 至少 30 天且活跃窗口更长，未 SETTLED Run 不可 purge，ledger 无自动 purge。

### G0-07 — Executor role、lease/fencing 与恢复安全

- **目标：** 分离外部 credential admission、内部 service attestation、executor/finalizer/metering/reconciliation/retention 数据库权限，并把事件、checkpoint、side effect receipt、reserve/settle/release/correction 与 terminal finalization 绑定 accepted Run、Attempt、有效 lease/fence 或专用人工处置证据及 charge attribution；通用 runtime role 不拥有账务 mutation，phase executor 不能拿任意外部 credential 建立内部服务身份。
- **文件集合：** `packages/db/migrations/005_runtime_roles.sql`、`packages/run-core/src/leases/**`、`packages/run-core/src/events/**`、`packages/db/test/runtime-security/**`。
- **依赖：** G0-06。
- **风险：** L4。
- **红测/证据：** publish/webhook/mcp/permission-callback 或普通 service API credential 冒充 phase service、过期/重放 service attestation、过期 worker、错误 attempt、同 Workspace 其他 Run/reservation、错误 charge attribution、通用 runtime 直接 reserve/settle/release/correct、伪造 terminal/event、租约丢失后 unsafe retry 全部拒绝；唯一 finalizer 原子完成 terminal/event/billing，reclaimer 只恢复 safe/requires-key attempt；未知副作用进入独立 operator reconciliation path。

### G0-08 — 可执行架构门

- **目标：** 用机器契约、真实 DB 和失败夹具证明文档冻结项已可执行。
- **文件集合：** `tests/architecture-gate/**`、`scripts/architecture-gate.mjs`、CI workflow。
- **依赖：** G0-02、G0-04～G0-07。
- **风险：** L3。
- **红测/证据：** `pnpm architecture:gate` 聚合 contract、migration/RLS、security、billing、recovery；任何 P0/P1 fixture 失败即停止 G1，禁止以 mock 或跳过标记放行。

### G1-01 — Capability Closure、Policy Meet 与 ResolvedPlan Kernel

- **目标：** 先实现所有 Flow/Agent 编译器共同消费的版本化 closure schema、canonicalizer/hash、由 typed segment array 无碰撞编码的 closure-unique binding path、完整 canonical resource pin 身份、权限格 meet/intersection、Deployment admission profile 与 `ResolvedAgentPlan` 收窄内核；在写入任何持久 path 前冻结 `binding-path-lp-utf8/1` 的 segment/field 数值 tag 注册表、字段顺序、UTF-8/NFC 输入规则和跨语言 golden vectors。Skill Pack 暴露 operation 在编译期形成唯一 `pack path + operation → member path + target pin + operation hash` 路由。不得放入具体 Flow/Strategy executor，也不得以 placeholder 形成第二事实源。
- **文件集合：** `packages/domain-contracts/src/capability-closure/**`、`packages/policy-engine/**`、`packages/resolved-plan/**`、对应 fixtures。
- **依赖：** G0-08。
- **风险：** L4。
- **红测/证据：** wrong-kind/unknown-field、自由 ID 分隔符/Unicode/长度碰撞、非 NFC 输入、未知/重复 tag、跨 Workspace 相同 version ID、重复 local binding ID、disabled path 歧义、pack operation 多成员歧义、typed Instruction Skill pin 跨 Workspace、nested escalation、缺 credential mapping、egress/data-classification/operation/side-effect 超限、Agent 与 Flow admission profile 混用、`floating_latest`、promotion 后旧 Run 与 revoke 后 Call 全部 fail closed；TypeScript 与至少一个独立 reference implementation 对固定 byte/digest golden vectors 逐字一致，canonical hash、typed path codec、完整 pin node identity、pack route 与集合 meet 具性质测试。

### G1-02 [P] — 最小 Flow IR/Compiler

- **目标：** 以 G1-01 为唯一 closure/policy 内核，交付 Start → LLM → Output 线性 Flow、canonical compile、FlowPlan、checkpoint 与 causal event sequence；预留 suspend ABI，不交付任意 Code/API 写副作用。
- **文件集合：** `packages/flow-ir/**`、`packages/flow-compiler/**`、`packages/flow-runtime/**`、`packages/flow-*/test/fixtures/**`。
- **依赖：** G1-01。
- **风险：** L3。
- **红测/证据：** canonical hash、错误引用、类型化 Binding config、资源 closure、并发因果序、崩溃恢复、LLM usage 去重夹具通过；需要 service/team credential 的顶层 Flow 必须解析 matching Flow admission profile。

### G1-03 [P] — 固定 Knowledge Generation 与只读 Database Operation

- **目标：** 交付一个 immutable Knowledge generation 查询和一个参数化只读 DB operation，作为 G1-01 closure/policy 的真实类型化资源；不提供自由 SQL 或写操作。
- **文件集合：** `packages/knowledge-core/**`、`packages/database-capability/**`、`packages/db/migrations/006_knowledge_db_operation.sql`、对应 fixtures。
- **依赖：** G1-01。
- **风险：** L4。
- **红测/证据：** generation pin/ACL、metadata filter、行列 allowlist、参数绑定、LIMIT/timeout、跨 principal delegated ACL、Release 后索引刷新不漂移。

### G1-04 — Agent Compiler、Strategy Runtime 与 Inert Skill

- **目标：** 用 G1-01/02/03 编译不可变 Agent closure/Plan，实现一个版本化 ReAct-style Strategy ABI、durable loop state、model-call attempt、tool-call intent、checkpoint、预算与终止原因；实现 Instruction Skill manifest/parser/hash、路径安全、上下文裁剪与 inert activation，任何必需脚本发布均显式失败。
- **文件集合：** `packages/agent-compiler/**`、`packages/agent-runtime/**`、`packages/strategy-runtime/**`、`packages/instruction-skill/**`、对应 fixtures。
- **依赖：** G0-05、G1-02、G1-03。
- **风险：** L4。
- **红测/证据：** 模型响应前后宕机、usage receipt 重放、最大迭代/预算、无工具终止、重复 tool intent、不可重放响应均有确定结果；Skill path traversal、manifest/hash 漂移、required script、越权 Binding 引用和上下文数据分类超限均拒绝。Plugin/MCP/SkillPack/SubAgent 在本切片只完成 typed release/config/closure；除 join-only SubAgent 外的广泛执行器后移到后续 gate。

### G1-05 — Worker、恢复、HumanGate 与 Join-only SubAgent

- **目标：** 执行 Flow/Agent Plan，支持 lease/fence、checkpoint、稳定 `agent_execution_id`/subplan/checkpoint namespace、带 Workspace/parent attempt+fence/dispatch generation+outbox identity 的不可变 context projection fact、join-only child 的确定 outcome map、并行 HumanGate 全图 quiescence barrier 与 barrier-owner lease 原子 handoff、WAITING/RESUMING 和 replay-first 幂等 resume。
- **文件集合：** `apps/worker/**`、`packages/run-core/src/recovery/**`、`packages/run-core/src/human-gate/**`、对应 failure fixtures。
- **依赖：** G0-06、G0-07、G1-01～G1-04。
- **风险：** L4。
- **红测/证据：** kill/reclaim、barrier owner lease 自身、Gate 前后宕机、并行 sibling 在途副作用、multi-gate 中间批准/最后批准/reject winner、重复/并发 resume/cancel、资源撤销、child/grandchild join/cancel/budget、child success/failure/timeout/cancel/NEEDS_ATTENTION 到 parent Call/Run 的闭合映射、dispatch 重试前会话变化与旧 fence 重放、summary tokenizer/model/prompt/schema 漂移、历史消息分类/脱敏/轮数、Gate reject/expire/cancel 与 `SIDE_EFFECT_UNKNOWN` operator-hold 终态映射全部确定收敛；terminal 前所有 sibling 被 fence 并收敛，唯一 finalizer 写 terminal。

### G1-06 — API/SSE/Browser Projection

- **目标：** 实现 exchange-only publish credential、browser session、conversation ownership、service Flow grant、Run admission/read/cancel/resume、durable SSE replay 和 blocking compatibility projection；OpenAPI 机器表达 replay-first、Origin/CORS、状态/账务及 HumanGate 判别条件。
- **文件集合：** `apps/api/src/modules/browser-sessions/**`、`apps/api/src/modules/conversations/**`、`apps/api/src/modules/runs/**`、`apps/api/src/modules/events/**`、`packages/api-contract/test/**`。
- **依赖：** G0-02、G0-04、G0-05、G1-05。
- **风险：** L4。
- **红测/证据：** user.id 伪造、跨 principal conversation、browser bearer/cookie SSE 的 exact Origin/CORS/missing/null/mismatched origin、credential kind/purpose/scope/grant 错配、publish key 直调、公开历史泄漏 system/tool 内容、conversation contract 相同可跨 Release/不同在副作用前返回 409、不同 hash 下 same-key 已接受 Run 仍先重放原 receipt、历史 Run 不可见统一 404、可选 cancel key 两分支、Gate budget/expired、非法 pending_action/billing projection、`SIDE_EFFECT_UNKNOWN` 自动重试、长 WAITING key、cursor expiry、断线回放、60001 compatibility、pin redaction、标准 OpenAPI oneOf 事件与 DB readback一致。

### G1-07 — Evaluation 与 Promotion Gate

- **目标：** 以不可变 suite/run 固定 Agent/Flow/Strategy/Knowledge generation 和阈值，并生成 Agent/Flow 共用的 `ProductionPromotionGateDecisionV1`：固定 workspace、deployment kind/id/revision、target pin、closure/dependency/change-set hash、suite/evaluator revisions、PASS、审批与有效期；只有唯一受限 promotion 函数在同一 pointer CAS 事务验证通过者才可进入 production。
- **文件集合：** `packages/evaluation-core/**`、`apps/api/src/modules/evaluations/**`、`apps/api/src/modules/deployments/promotion*`、对应 migration/test。
- **依赖：** G1-01～G1-06。
- **风险：** L3。
- **红测/证据：** 重跑追加、decision 字段/target/hash/状态/审批/有效期任一错配、阈值失败/预算不足/门尚未安装均不提升、fixture 不授生产权限、Agent/Flow 使用同一 promotion CAS、promotion diff+approval+audit、rollback 不改历史 Run；直接写 production pointer、复用旧 decision 和借 staging audit 提升都失败。

### G1-08 — 最小纵向 E2E Gate

- **目标：** 证明一个已认证用户通过 browser exchange 调用已部署 Agent，Agent 使用固定 Knowledge generation、只读 DB operation 与一个 inert Instruction Skill，经历一次 HumanGate 后恢复并以 join-only 子执行终结。
- **文件集合：** `tests/e2e/g1-agent-flow/**`、`tests/failure-injection/**`、`scripts/g1-gate.mjs`。
- **依赖：** G1-01～G1-07。
- **风险：** L4。
- **红测/证据：** `pnpm test:e2e:g1`、`pnpm test:failure:g1`、数据库独立 readback、事件/账务/授权审计链一致；publish/service credential 混用、并行 Gate sibling、SubAgent 输入漂移、Skill inert/required-script/path traversal/能力扩张、pack route/public handle 错配、production decision 复用、任何绕过 RLS/latest/mock/direct Release entry 或第二事实源都会失败。

## Before / After 契约投影表

| 领域 | Before（当前风险） | After（目标唯一链路） | 验证 |
|---|---|---|---|
| REST | Markdown 与 OpenAPI 可互相漂移，技术栈又暗示 code-first | `docs/api/openapi.yaml` → parse/lint/bundle → generated TS/runtime validators/client → route conformance | contract check + breaking fixtures + route tests |
| Database | 逻辑表、SQL 草案和未来 migration 边界混杂 | ordered migration → PostgreSQL schema/RLS/functions → generated DB types/repositories → transaction tests/readback | empty/reapply migration + RLS/attack/concurrency tests |
| Release | capability kind 与 resource kind 混用 | discriminated Release schema → sealed registry row/manifest → compiled hash → kind-safe Deployment/Binding FK | wrong-kind/cross-tenant/immutability fixtures |
| Agent/Flow | 父 Binding 看不到嵌套依赖 | Draft → immutable Release/Version → compiled capability closure → Deployment mapping → ResolvedPlan → Run/Call snapshot | nested escalation/credential/egress/side-effect tests |
| Runtime | 文档状态机与执行结果形状不一致 | Strategy/Flow ABI → durable Attempt/Checkpoint/Gate → lease/fence executor → event/outbox projection | crash/resume/duplicate/unknown-effect tests |
| Billing | terminal pending 被误作当前结算状态 | immutable terminal billing snapshot + mutable settlement projection + append-only ledger | concurrent reserve/settle/release + child join/readback |

## 停止条件与恢复策略

- 任一 P0/P1 契约仍有两个事实源、无法形成判别式 schema/复合约束或需要实现者自行选择安全语义时，停止业务实现，只允许继续修复契约。
- PostgreSQL 16 中任何 migration、RLS、definer、账务或并发夹具失败，停止 G1；不得把静态 SQL 检查代替数据库证据。
- OpenAPI parser/lint/breaking/example 任一失败，停止 API handler/client 生成；不得手工修改 generated artifact 绕过源契约。
- 任何实现需要把 secret、mutable latest、caller-provided principal、direct Agent Release entry 或分析投影作为事实源时，停止并回到架构门。
- Migration 采用 forward-only 修复和空库重放；已发布 Release/Run/ledger 不使用破坏性回滚。开发环境重建前必须确认只删除可再生测试数据。
- G1 gate 未通过时保留已通过的底层 migration/contract 证据，但不宣称公开 Chat、Agent、Flow、RAG 或计费功能完成。

## Plan 验收

- 任务已按架构修复 → 契约工具链 → 数据事实层 → runtime → API projection → eval/E2E 排序；
- 每个任务均有目标、文件集合、依赖、风险和可观察证据；
- `[P]` 用于两组文件互斥且共享前置事实源的并行项：G0-02/G0-03，以及 G1-02/G1-03；并行项不得各自复制 closure/policy/contract 内核，完成后必须组合验证。
- 已明确 Gate A 文档冻结后可执行 G0-01～G0-08 工程底座；只有 G0-08 可执行门通过后才允许进入 G1 业务能力实现；
- 本计划不把尚未运行的 SQL/OpenAPI 或不存在的源码报告为实现证据。

## Work：文档级架构修复结果

### 已关闭的阻断项

- A1～A7 已在规范文档、ADR、OpenAPI 与 SQL 设计草案中闭环：active pointer 与永久 revoke fence 分离、`BindingKind`/`PublishedResourceKind` 分离、传递性 `CompiledCapabilityClosure`、Strategy ABI、durable HumanGate、bounded SubAgent delegation、G1 inert Skill scripts、可信 browser principal、canonical acceptance receipt、账务当前态与历史终态快照、append-only ledger、runtime lease/fence、Knowledge/Flow 物理生命周期以及 contract-first 实施顺序均已成为唯一规范链路。
- Work 期间额外发现并关闭 4 个会让实现者产生安全分叉的缺口：browser exchange 与 Flow Run 的 OpenAPI operation 缺少显式 security、subject assertion 缺少一次性消费事实、Deployment 恢复 ACTIVE 可能错误恢复旧 Run 权限、Conversation 跨 Release 时缺少状态 ABI 兼容门。
- Conversation 最终采用 G1 安全默认：revision 与 Conversation 固定 `conversation_contract_hash`；相同 hash 才允许跨 Release，不相同在任何 Run/计费/outbox 副作用前返回 `409 CONVERSATION_REVISION_INCOMPATIBLE`，不做隐式迁移；已接受 Run 的幂等重放仍返回原 receipt。

### 本地静态证据

- Markdown：扫描 `docs/**` 共 24 个 Markdown 文件，相对链接缺失 `0`，代码围栏不平衡 `0`。
- 跨文档术语：旧能力枚举、旧 SubAgent kind、批量 secret-ref 字段与账本删除语句的可执行定义均为 `0`；`BindingKind`、`PublishedResourceKind`、closure、conversation contract、revoke epoch 与 assertion replay fact 均有规范落点。
- OpenAPI 语法/静态结构：本机 `yaml` parser 以 duplicate-key 检查解析通过；11 个 path、11 个 operationId、重复 operationId `0`、314 个本地 `$ref` occurrence、122 个唯一引用、缺失引用 `0`、11 个 operation 均有显式 security；10 个使用服务凭据的 operation 均有完整 `CredentialOperationPolicyV1`，唯一 browser-only events-session operation 有 exact Origin/CORS 约束；12 个公开 RunEvent 判别分支、Run/terminal 条件 schema、browser exchange、canonical 202、HumanGate resume、current billing state 与 conversation 409 均存在。
- SQL 静态安全：001/004 草案分别定义 22/38 个函数，其中 22/30 个为实际 `SECURITY DEFINER`，均有对应固定 `search_path`、owner 与 PUBLIC revoke，且 `pg_temp` 位于末位；11/16 张表均同时启用并强制 RLS；004 中 `credits_ledger` DELETE 语句 `0`，retention 角色的 ledger 写/删权限被显式撤销；phase-specific reserve/settle/release/finalize/reconciliation EXECUTE、canonical receipt、immutable terminal result/error/event tombstone、billing intent hash 与 lease fencing 字段存在。
- `git diff --check` 通过，仅报告现有 Windows CRLF 转换提示。

### 尚未获得的证据

- 当前环境可完成 YAML 语法解析，但没有正式 OpenAPI 3.1 semantic linter/bundler/breaking/example validator；G0-02 仍必须把这些门放入仓库 CI。
- SQL 仍未在真实 PostgreSQL 16 + pgvector 上执行，也没有 migration 重放、RLS/临时表攻击、账务并发、故障注入或独立 readback；这些是 G0-03～G0-08 的硬门。
- 仓库没有产品 runtime/client/deployment；因此 Work 只证明文档级安全语义已冻结，不能证明 Agent、Flow、Knowledge、Database、Plugin、Skill 或 SubAgent 已实现或上线。

### Work 判定

文档级 P0/P1 已达到独立 Review 候选状态，可以开始 G0 工程底座；不得跳过 G0-08 直接进入 G1 业务能力实现。若 Review 发现新的双重事实源或不可落地约束，则回到 Work 修复后重新验收。

## Review 轮次 1：独立审查发现

### 结论

独立 API、Agent/Flow Runtime 与主审数据/SQL 三个表面均未发现新的 P0，但确认仍有会让实现产生第二事实源或安全旁路的 P1。因此本 Sprint 已按状态机从 `review` 回退 `work`；在这些项关闭并重新复审前，结论仍是：**可执行 G0 骨架与契约修复，不可直接进入 G1 业务实现。**

### 必须关闭的 P1

1. **任务图语义环：** 原 G1-01/02 已消费 closure/ResolvedPlan，G1-03 才实现它们并反向依赖前两者；已把 canonical closure、policy meet 与 ResolvedPlan kernel 前移为 G1-01。
2. **Binding 配置未判别：** union 只有 `kind/pin`，类型特有配置落在开放 `local_config`；必须改成版本化 kind-specific `config`，unknown field/wrong-kind fail closed。
3. **`floating_latest` 与 sealed closure 冲突：** G0/G1 必须完全拒绝；未来兼容能力需要不可变版本集合、安全 envelope、重新审批与重新 seal，不能在运行时解析任意 latest。
4. **顶层 Flow 无准入事实源：** 需要判别式 Flow Deployment/admission profile，固定 entry policy、credential mapping 与 revoke source；不能套用 Agent Deployment。
5. **状态映射不闭合：** 必须分离 Run/Gate/Step 状态，固定 Gate reject/expire/cancel 与 termination reason 的映射，并将 `SIDE_EFFECT_UNKNOWN` 定义为不可自动恢复的 operator-hold 终态及明确账务路径。
6. **SubAgent 上下文冲突：** G1 移除原始 `full_history`，改为有消息类型、分类、脱敏、最大轮数与 contract hash 的 `eligible_history`。
7. **API replay 顺序：** Chat 与 Gate mutation 均须先查 canonical idempotency fact；只有 miss 才解析当前 revision、检查 conversation ABI 或重验证 Gate/授权。长 WAITING Run 的 key 不得在 24 小时后释放。
8. **浏览器 Origin 只存不验：** 必须冻结 RFC 6454 canonical origin、请求时 exact Origin/CORS、null/missing origin 与 host-only cookie 语义；Origin 只是浏览器约束，不能替代 bearer 防重放。
9. **机器授权与公开投影过宽：** OpenAPI 需机器表达 credential kind/scope；按 ID 不可见统一 404；Conversation history 不得投影 system/tool 内部内容；SSE event 使用标准判别 `oneOf` 而非任意 `data`。
10. **credential verifier 可重放：** verifier 在数据库认证边界等价于 bearer，普通 runtime/control app role 必须连列值也不可读，认证只能经隔离的 `auth` 投影/函数。
11. **Run 准入事实可被更新：** operation/route/principal/idempotency intent/receipt/plan/target/dependency/input/billing owner/accepted time 必须在 INSERT 后不可变；幂等 active/expiry 只能按非终态保持与终态 replay grace 单调变化。
12. **计费过期与 retention 可自证：** `release_credits(... mark_expired=true)` 必须验证实际过期时间；Run purge 必须消费事先验证、不可变且精确匹配的归档回执，不能接受调用者现场提交 hash/ref 后自行证明。
13. **数据词汇漂移：** credential kind、`secret_refs.locator`、public Experience handle map 必须与 SQL/registry 唯一模型一致。
14. **实施门缺口：** production promotion 只能在 G1-07 evaluation gate 后启用；Skill manifest/parser/inert activation 必须有明确 owner 和 E2E 失败夹具；永久 revoke 需要 `SUSPENDED → ACTIVE` 旧 Run 仍失败的回归证据。
15. **请求期重新编译歧义：** 总览中的 `Compile(cached)` 容易让实现者在准入时重读 mutable latest；已改为发布期唯一编译、请求期只加载 sealed compiled artifact/closure。

### 本轮未升级为 P0 的边界

- 正式 OpenAPI 3.1 semantic lint、PostgreSQL 16 migration/RLS/并发/攻击测试、浏览器 CORS E2E 与 runtime failure injection 尚未执行；这些仍是 G0-02～G0-08 的硬门，而不是当前文档静态审查的已验证事实。
- Plugin/MCP/SkillPack/SubAgent 的 typed release/config/closure 属于 G1 架构面；广泛第三方 transport、任意代码、写 DB、可执行 Skill script、public detach 与动态递归委派不进入首个纵向切片。

## Work：Review 回修状态

- 已完成实施依赖图重排：G1-01 成为 closure/policy/ResolvedPlan kernel，G1-02 Flow 与 G1-03 Knowledge/只读 DB 可并行，G1-04 才装配 Agent/Strategy/Inert Skill，消除反向依赖。
- 已将 G0-04/G0-05 边界改为先建身份事实，再建立 Agent/Flow Deployment 与 browser-session 数据原语；公开 browser exchange 留在 G1-06。
- 已增加 production promotion、永久 revoke、长 WAITING idempotency、verifier 不可读、Run acceptance immutability、归档回执、Skill owner、public handle 与标准事件 schema 的红测要求，并移除请求期重新编译的第二事实源。
- API 回修已固定 replay-first、非终态幂等保留、exact Origin/CORS、typed credential policy/404/409、公开历史与标准 OpenAPI 3.1 event union；events cookie SSE 读取也有独立 Origin 绑定参数。
- Runtime 回修已固定 closed kind-specific Binding config、pinned-only closure、独立 Agent/Flow Deployment 与 admission、Run/Step/Gate 状态映射、`eligible_history`、Experience public handle 与 Skill ownership。
- 数据/SQL 回修已把 verifier 视为 bearer-equivalent、冻结 Run 接受事实、把过期检查放入锁定 reservation 的 `release_credits`、以相互隔离的 archive-evidence/retention role 和不可变 manifest/receipt 关闭 purge 自证，并从 G0/G1 可执行 schema 移除 legacy profile、URL-secret fallback 与 compatibility approval source。
- 2026-08-25 再次核对五个平台官方资料后，Dify/Coze/Gumloop 的版本与 live pointer 行为、Gumloop credential fallback、Flowise EOL 等仍支持“immutable pin、显式 credential binding、Flowise 仅作研究样本”的既定决策；竞品公开界面继续不作为本项目事务保证。
- API、Runtime 与数据/SQL 的第一轮 P1 已完成组合回修；下一步只进行第二轮交叉独立 Review，不再扩大 G1 范围。

## Review 轮次 2：交叉审查发现

### 判定

第二轮采用交叉文件面复审：原 API reviewer 检查 Agent/Flow runtime，原 runtime reviewer 检查数据/SQL，原数据 reviewer 检查 API，主审检查实施依赖图。共确认 **1 个 P0、16 个 P1、4 个 P2**；Sprint 已从 `review` 回退 `work`。P0/P1 关闭前不得把文档冻结结论升级为可直接进入 G1。

### P0/P1 回修清单

1. **P0 — credential kind 与 purpose 混用：** OpenAPI 使用数据库不存在的 `deployment_publish|flow_invoke` kind，并让 publish credential 获得运行权限。机器契约必须只使用 `service_api|publish|webhook|mcp|permission_callback`，另以 purpose/scope/grant 表达 exchange-only publish 与 exactly-one-flow 调用。
2. **P1 — 并行 Gate 缺少全图 barrier：** Gate 打开、reject/expire/cancel 与 sibling lease/副作用之间缺 quiescence、fence、drain/checkpoint 和唯一 finalizer 规则。
3. **P1 — closure 身份与 pack 路由不唯一：** Release-local `binding_id` 不能标识嵌套闭包路径；Skill Pack 暴露 operation 还需编译为唯一 member path/pin/hash 路由。
4. **P1 — SubAgent 输入不可复现：** projection rule hash 不能替代本次实际上下文快照；首次 dispatch 必须原子固定 cursor/message set、serializer/tokenizer/truncation、content hash，以及 summary 的 model/prompt/schema/usage attempt。
5. **P1 — production gate 双重事实源：** Agent/Flow 必须共用一个可机器验证的 `ProductionPromotionGateDecisionV1` 与 pointer CAS，G0 对 production 无条件 fail closed。
6. **P1 — API 机器约束不足：** replay-first 404、cookie SSE Origin/CORS、Run/账务条件 schema、`SIDE_EFFECT_UNKNOWN`、可选 cancel key、Gate budget/expired 与 HumanGate 判别 union 必须进入 OpenAPI，而非只留 Markdown。
7. **P1 — 数据状态与授权不闭合：** Run/Step 状态需与共享 runtime 枚举一致；cancel mutation 必须比较 target 并由可信边界计算 canonical intent；G1 join-only 需数据库约束。
8. **P1 — 计费角色过宽：** reserve/settle/release 不能授予通用 runtime role；必须分离 admission/finalizer/metering owner，并绑定 Run/Attempt/lease/fence/charge attribution。
9. **P1 — secure-only 仍有旧旁路：** G0/G1 文档不得保留 URL-secret、legacy 或 floating 的可执行入口；未来兼容能力只能在独立 sealed envelope、migration 与 gate 后启用。
10. **P1 — 实施编号漂移：** 总路线的 G1-A6～A8 与任务级计划不一致，导致 Mock/定时任务挤入 G1 且最小纵向 E2E 消失。统一为 A6 API、A7 Evaluation/Promotion、A8 E2E；Mock/任务产品广度后移 G2/P3。

### P2 处置

- Agent admission 显式要求 Deployment `ACTIVE` 并持久化 observed revoke epoch；Instruction Skill 使用 typed workspace-scoped pin。本轮一并回修，避免把简单缺口留给实现者解释。
- HumanGate public ABI 用 `oneOf` 区分 input/approval；verifier 的 constant-time 原语、数据库参数日志脱敏与泄漏夹具进入 G0 实施门。本轮能冻结的契约直接补齐，真正时序/日志证据仍必须由实现与真实环境给出。

## Work：Review 轮次 2 回修状态

- 已统一总路线 G1-A1～A8：A6 API/SSE/browser projection，A7 Evaluation/production promotion，A8 最小纵向 E2E；Mock 产品能力与定时/预设任务明确后移 G2/P3。
- API、Agent/Flow runtime、数据/SQL 的其余 P0/P1 已按互斥文件集合完成回修；组合静态门已重跑，下一步只进行第三轮独立 Review。
- 主审组合回修又关闭了三个跨文件缺口：内部 `NEEDS_ATTENTION` 与公开 `FAILED + SIDE_EFFECT_UNKNOWN` 映射、可在 Step/Event 保留期后稳定重放的 immutable terminal result/error snapshot，以及 credential operation purpose 只是路由派生值而非第二授权事实源。此外已删除 production evaluation 双重字段，并补全 Skill Pack parent binding path。
- 最后一次组合核对将 Agent/Flow entry grant 固定为分立类型化事实，并规定 Agent grant 的 `publish + browser-session:exchange` 与 `service_api + Agent operation scope` 互斥；Flow grant 只接受 `service_api`。target cardinality 统计 distinct Deployment，避免同一目标的多条 scope 行被误判为歧义。G1 `AsyncChildPolicyV1` 与数据草图也已收窄为唯一 `join+cascade+safe_summary+wait_for_settlement`，不再保留可被误启用的 detach enum。

## Review 轮次 3：最终冻结前独立审查发现

### 判定

第三轮由 API/计划、Agent/Flow runtime、Data/SQL 三个互斥文件面复审。无新增 P0；确认 **16 个 P1、6 个 P2**。这些问题不推翻不可变 Release/Deployment/ResolvedPlan/Run 的总体方向，但会让生成实现读取旧授权源、错误恢复 HumanGate、产生孤儿 child、无法处置 operator hold，或使 G0 计划自身不可执行。因此 Sprint 已从 `review` 回退 `work`，关闭后必须重新进行最终 Review。

### 必须关闭的 P1

1. API 必须区分“Gate decision 已接受”和“Run 真正 resumed”：中间 cohort decision 只物化下一 Gate，最后一个正向 decision 才创建 attempt/resume outbox，reject/expire 只写 terminal intent 并唤醒唯一 finalizer。
2. cancel 的 keyed/unkeyed 分支、mutation-key lock、hit-read-gate-404、intent replay 和 miss mutation 顺序必须进入 OpenAPI 机器扩展。
3. 公开非终态 Run 的 `billing_state` 只能是 `PENDING`，不能被 schema 接受为 `SETTLED|NEEDS_ATTENTION`。
4. G0-04 不得以尚未存在的 G0-05 typed grant/cardinality 作为自身完成条件；credential/principal/RLS 与 Deployment entry admission 分阶段、在 G0-08 组合。
5. 文档冻结门与 G0-08 可执行门必须分离，不能要求先通过只有 Monorepo/Postgres harness 才能产生的证据再创建工具链。
6. Agent/Flow entry contract 必须定义 closed credential mapping/grant schema 和各自 literal scope union，未知 scope/kind/principal/channel/audience 失败。
7. Agent HumanGate 必须引用已发布、不可变并进入 compiled hash/closure 的 `AgentGateSpecV1`；Strategy 不能动态选择 approver/disposition。
8. HumanGate barrier 必须定义 barrier-owner lease handoff，消除“全部 lease 为零”与“waiting 提交后才释放当前 lease”的死锁。
9. G1 child `SUCCEEDED|FAILED|TIMED_OUT|CANCELLED|NEEDS_ATTENTION` 到 parent Call/Run/账务责任必须有确定 outcome map。
10. closure binding path 必须使用无碰撞、版本化 typed segment 编码；resource node identity 从完整 canonical pin 派生。
11. credential overlap 必须有不可延长的服务端期限与 rotation group；revoked/expired 永不回活。
12. 通用 Release grant 不得作为 Agent/Flow 公共入口的第二授权源；只可明确隔离为 System/preview 用途。
13. admission/metering/finalizer 等 phase executor 必须使用独立 internal service attestation，不能用任意外部 API credential 建立内部身份。
14. child 只能由受控事务同写 child/link/allocation/event/outbox，数据库拒绝孤儿 child；父 cancel 必须产生幂等 cascade intent/outbox。
15. `NEEDS_ATTENTION` 必须有带人工 resolution/approval evidence 的幂等 reconciliation/correction 事实，只推进 current billing state；未 `SETTLED` 时禁止 purge。
16. event 至少 7 天与 checkpoint/Gate/outbox dedupe 至少 30 天必须使用分类 retention horizon，不能由单个 7 天字段同时清理。

### P2 一并回修

- 历史 P0 能力表改为 `INV-P0-*`，不再与可执行 `G0-01～08` 混用；初始 Conditional No-Go matrix 明确为历史，文末提供唯一当前 verdict。
- SubAgent context projection fact 增加直接 Workspace、parent attempt/fence、dispatch generation/outbox identity 和复合唯一键；Deployment revision 的不可变 contract pin 不再被描述成可变 epoch source。
- finalizer 必须按 accepted output schema ref/hash 验证结果，并在 Run terminal snapshot 保存 terminal event id/sequence 墓碑，使 event retention 后同 intent 仍可幂等读回。

## Work：Review 轮次 3 回修状态

- 已拆分 Gate A 文档冻结与 Gate B/G0-08 可执行证据，解除 G0-01 启动死锁；G0-04 只负责 credential/principal/assertion/RLS，G0-05 负责 typed Deployment entry grant/cardinality，G0-08 做组合读回。
- ADR-001/002 已转为“文档级决策已接受、运行证据待 G0”，固定 visibility 语义、SPI 有界失败默认值及后续交付选项的最迟决策门；这不表示仓库已有实现。
- API 已封闭 Gate 三结果、`run.resumed` 正向动作、cancel keyed/unkeyed 机器顺序与非终态 `billing_state=PENDING`；Runtime 已封闭 Agent/Flow entry grant、不可变 Agent GateSpec、barrier-owner lease handoff、child 五态映射、typed binding path 与完整 pin node identity；Data/SQL 已封闭 credential 单向 lifecycle、phase-bound internal attestation、System-only 通用 grant、child 全路径 fail-closed、人工 reconciliation、7/30 天分层 retention、accepted-schema validator stub 与 terminal event 墓碑。
- 组合主审又关闭 1 个跨文档 P1：数据模型、ADR-004 与 SSE 验收不再保留“写 WAITING 后才释放 candidate Worker”或“任意 Gate decision 都创建 resumed attempt”的旧顺序；三者现统一为 DRAINING barrier + candidate lease 原子 handoff、quiescence 后 waiting 事务释放 barrier owner，以及 `NEXT_GATE_WAITING|RUN_RESUMED|TERMINAL_INTENT_ACCEPTED` 三分支。
- 组合静态验收已通过：24 个 Markdown 文件的 165 个相对链接缺失 `0`、围栏错误 `0`；OpenAPI duplicate-key parse、314 个本地引用解析、11 个 operation security 和 Gate/Run 定向 AJV 夹具通过；001/004 的事务/函数分隔符、22/30 个 definer 安全头、11/16 张表 ENABLE+FORCE RLS 与关键 fail-closed invariant 通过；`git diff --check` 无 whitespace error。
- Work 主审新增 1 个非阻断 P2：`binding-path-lp-utf8/1` 的数值 tag/字段顺序/Unicode 规范与跨语言 golden vectors 必须在 G1-01 写入任何持久 path 前冻结，现已纳入该任务目标与红测。它不改变 Gate A 或 G0 顺序。
- 当前已具备第四轮最终独立 Review 条件；Review 通过前不把候选判定写成最终冻结，G0-08 通过前仍不可进入 G1。

## Review 轮次 4：最终架构冻结结论

### Findings-first 判定

- **P0：0；P1：0。** 第三轮回修后的 API、Agent/Flow runtime、Data/SQL、实施依赖图与文档边界未发现新的阻断项。
- **P2：2。** 一是 `binding-path-lp-utf8/1` 的数值 tag、字段顺序、UTF-8/NFC 规则和跨语言 golden vectors 必须在 G1-01 首次持久化前冻结；二是清理当前 G1 文案中“保留 dormant detach 契约”的歧义。两项均已进入任务或规范，不阻断 Gate A 与 G0。
- **Gate A：PASS。** 可以按依赖顺序启动 G0-01～G0-08 工程底座；这表示实施计划已可执行，不表示 Agent、Flow、Knowledge、Database、Plugin/MCP、Skill 或 SubAgent 已实现。
- **Gate B / G0-08：仍为硬阻断。** OpenAPI semantic lint/bundle、PostgreSQL 16 migration/RLS/并发/攻击测试、浏览器 CORS E2E 与 runtime failure injection 未通过前，不得进入 G1 业务能力实现。

### 已验证证据与未知项

- 已验证：24 个 Markdown 文件、165 个相对链接缺失 `0`、围栏错误 `0`；OpenAPI duplicate-key parse、314 个本地引用解析、11 个 operation security 与 13 个定向 AJV fixture 通过；001/004 SQL 静态事务、definer 安全头、RLS 与关键 fail-closed invariant 通过；`git diff --check` 无 whitespace error。
- 未验证：真实 PostgreSQL 16 + pgvector 解析/迁移/回放，RLS 与临时表攻击、并发账务、故障注入、实际路由/客户端/部署。仓库仍是文档与设计草案阶段。

> 上述两项保留第四轮架构冻结时的历史证据快照；当前实现证据以紧随其后的 G0-04 实施回写为准。

## 2026-08-26 G0-04 实施回写（本地可执行证据）

### 已验证事实

- `packages/domain-contracts` 已冻结 credential kind/scope、caller principal、带 Workspace/credential 双 observed epoch 的 tenant auth context、subject assertion 安全投影与 operation policy；OpenAPI 的 10 个服务 operation 均有机器可校验策略，唯一 browser-only operation 禁止携带该策略，策略变化受独立 baseline 约束。
- `packages/db/migrations/000～002` 已实现平台角色前置检查、Workspace 直属身份事实、不可读 credential verifier、issuer trust、稳定 end-user principal 映射、一次性 assertion use、签名且 transaction-local 的租户上下文、14 张表的 `ENABLE + FORCE RLS` 与 46 个固定 `search_path` 的 `SECURITY DEFINER` 函数。
- `packages/auth` 已实现 `ba1.<uuid>.<secret>` Access-Key、HMAC verifier、从不可变 generated OpenAPI registry 解析 exact operation policy，并在请求认证前绑定 reviewed HTTP method + route template + operation ID；其 module-private issuer/WeakSet 生成并验真同时绑定 route tuple、required scope 与 canonical policy hash 的 `credential_phase_passed` proof。另已实现 Ed25519 compact JWS assertion 验签；subject identity hash 绑定 Workspace 与稳定 issuer identity，不随 issuer config/key rotation 改变。
- `apps/api/src/modules/auth` 已形成不暴露公开路由的组合边界：组合根必须先用 method/route template/operation 三元组绑定 authenticator，请求输入不能再选择 operation；秘密材料在使用后清零；parser/secret-provider/DB verifier 失败固定为无细节 401，Workspace/scope/origin 拒绝固定为无候选资源细节的 403；browser exchange 将 publish credential、assertion verify/map/consume 约束在同一个 transaction adapter 调用链。该边界不等同于已实现 HTTP router，不签发 browser session，也不产生 Deployment grant 或最终授权结论。
- `pnpm check` 全绿；真实 PostgreSQL 16.12、pgvector 0.8.1、pgcrypto 1.3 上的 `pnpm db:test:postgres16` 全绿，覆盖 3 个生产 migration 的重放/checksum/受控 rollback，以及角色组合拒绝、跨租户、同一物理连接 COMMIT/ROLLBACK 后上下文清理、精确 definer `search_path`、scopes/双 epoch 快照、临时表、credential rotation、verifier 隔离、nonce 回滚/并发重放和撤销主体在 key rotation 后仍拒绝。

### 尚未实现或未验证

- G0-05 的 Release/Deployment、Agent/Flow typed entry grant、target cardinality、admission profile 与 browser-session 存储/签发尚未实现；因此 G0-04 的 `credential_phase_passed` 不能升级为“已授权”。
- 公开 HTTP handler、SSE/browser projection、Agent/Flow/Knowledge/Database/Plugin/Skill/SubAgent runtime、Run/计费以及 G0-07 phase executor 均尚未实现。
- 未执行生产部署，也未验证真实连接池、PostgreSQL 驱动 binary bind、APM、错误采集和支持导出链路对 bearer-equivalent verifier 的脱敏；本地 harness 通过不能替代这些部署证据。
- Gate B / G0-08 仍为硬阻断；下一实现切片严格按依赖进入 G0-05，不提前创建 G1 handler/executor。
