# API 契约（兼容层 + 平台扩展）

> 状态：路径、字段名和 task 载荷优先保持 BetterYeah 兼容；身份、凭据、幂等、事件序列和安全默认值为本项目新增平台契约。G1 机器可读入口以 [OpenAPI 草案](./api/openapi.yaml) 为准；运行语义以 [SSE 与异步操作契约](./api/SSE与异步操作契约.md)、ADR-001、ADR-003 与 ADR-004 为准。

## 1. 公共请求头

| 头 | 说明 |
|---|---|
| `Content-Type` | 仅带 JSON body 的请求固定为 `application/json`；无 body 的 GET/204 流程不发送该头，SSE 订阅改用 `Accept: text/event-stream` |
| `Access-Key` | 仅服务端兼容调用和 browser exchange 使用的 scoped credential；持久化 kind 只允许 `service_api`、`publish`、`webhook`、`mcp`、`permission_callback`。`deployment_publish`、`agent_invoke`、`flow_invoke` 只是由 OpenAPI operation 决定的 purpose 标签，不存入数据库也不单独授权。授权必须在同一准入事务联合验证 kind、scope、类型化 entry grant 及目标基数；`publish` 仅可由宿主后端用于 browser exchange，不能直调 Chat、Conversation、Run、cancel、resume 或 events；服务端仅存 hash，稳定 credential 不得下发浏览器 |
| `Workspace-Id` | 服务端 credential 调用的工作空间声明；必须与认证结果一致，不是权限证明 |
| `Authorization: Bearer` | Web SDK 使用的短期 browser session token；工作空间、Deployment 与最终用户 principal 均从 token 推导，浏览器不得用 `user.id` 自选主体 |
| `X-Client-Request-Id` | 可选、调用方提供的审计关联值；不控制平台 `request_id`，格式见 SSE 契约 |
| `Idempotency-Key` | Run 创建/取消可选、Human Gate resume 必填；唯一性范围、重放与冲突规则见 SSE 契约。G1 conversation create 不接受该头 |

服务端为每个 HTTP exchange 生成 UUIDv7 `request_id`，并在响应 `X-Request-Id` 与 JSON envelope 中回显。接受 Run 时的首次值作为 `accepted_request_id` 固定进 Run；同一幂等键重放产生新的当前 `request_id`，但使用原 `accepted_request_id` 和 `run_id`。Studio 管理接口使用登录会话或 OIDC，不接受 Workspace 发布凭据。

G1 浏览器身份只通过 `POST /v1/oapi/browser/sessions/exchange` 建立。宿主后端用不出浏览器的稳定 Deployment publish credential，加上由预配置 issuer 签名的短期 `subject_assertion`、exact origin 和 channel 发起 exchange；服务端验证后从 assertion 映射平台 `principal_id`，返回短期 Bearer token。token 固定 `workspace_id + deployment_id + channel + principal_id + origin + audience + expiry + session_epoch`，准入时再原子解析 active revision。请求体不得提交 `principal_id`；SDK 的 `user.id` 仅是展示/日志元数据。G1 不开放匿名 Agent，也不允许用户凭据缺失时回退到发布者身份。

Browser origin 使用 RFC 6454 的 ASCII serialization：scheme/host 小写、IDN 使用 A-label、默认端口省略，只接受 `https`（本地开发可显式允许 loopback `http`），拒绝 `null`/opaque origin、userinfo、path、query、fragment、尾点主机和未规范化等价写法。每个 browser-session 请求都必须在运行时把请求 origin 与 session 固定 origin、当前 Deployment exact-origin allowlist 同时比较；events cookie 订阅则把请求 origin 与 cookie 固定 origin、当前 allowlist 同时比较。跨源请求缺少 `Origin`、值为 `null` 或不相等均以 `403 BROWSER_ORIGIN_FORBIDDEN` 拒绝。仅同源 GET/HEAD 在浏览器合法省略 `Origin` 时，网关可从受信任的外部 scheme/host/port 推导 request origin；不得信任客户端直传的 `Forwarded`/`X-Forwarded-*`。CORS 只回显单个已验证 origin，并发送 `Vary: Origin`；使用 cookie 时允许 credentials，但绝不使用 `*`。origin 是浏览器上下文限制，不是 bearer 的密码学持有证明；token 泄漏仍按凭据泄漏处置。

## 2. Agent 会话族

```http
POST /v1/oapi/agent/chat                    # 发送会话消息（聊天）
POST /v1/oapi/browser/sessions/exchange      # 宿主后端为已验证用户换取短期 browser session
POST /v1/oapi/agent/conversation            # 创建新会话
GET  /v1/oapi/agent/conversations           # 获取会话列表
GET  /v1/oapi/agent/conversation/messages   # 获取会话历史消息
POST /v1/oapi/agent/push                    # 历史 compatibility inventory，未列入 G1 OpenAPI
GET  /v1/oapi/info                          # 历史 compatibility inventory，未列入 G1 OpenAPI
```

G1 的 conversation create 不定义网络重放幂等语义，因此不接受 `Idempotency-Key`，也不把未定义的 409 当作去重保证。宿主在响应不确定时应先按当前 browser-session principal/Agent 列出会话并按自己的关联数据对账；若以后需要创建幂等，必须在 OpenAPI 中另行冻结专用 intent，而不能复用 Run 的 acceptance receipt。

公共会话历史只投影经过 schema 脱敏的 `user` / `assistant` 消息。内部 system prompt、Strategy/Instruction Skill 内容、工具上下文、隐藏控制消息和审计记录不属于 `GET /v1/oapi/agent/conversation/messages`；若产品需要展示系统通知，必须另立显式 `system_notice` 公共类型与 schema，不能复用内部 `system` 记录。

`POST /v1/oapi/agent/chat` 兼容请求体：

```json
{
  "robot_id": "agent 的唯一标识符",
  "conversation_id": "会话 id",
  "content": "总结书籍内容",
  "inputs": { "bookName": "孙子兵法" },
  "response_mode": "blocking"
}
```

- `robot_id`、`conversation_id`、`content`、`inputs` 为兼容层的必填字段；`response_mode` 为可选字段，省略时默认 `blocking`。这修复了“全部必填”与“有默认值”的原文矛盾。
- `inputs` 两种用途：Agent 变量（角色设定中 `{{}}` 引用）、工作流 start 节点表单变量。
- `response_mode`：`blocking` 最多等待部署定义的窗口，窗口内终态返回 `200`，超窗返回 `202` 且后台 Run 继续；`streaming` 一律先返回 `202` operation，客户端再订阅 Run SSE。
- `conversation_id` 必须属于认证 context 中的同一 Workspace、Deployment 和 principal；不存在或不可见统一返回 `404 CONVERSATION_NOT_FOUND`。`user.id` 即使与会话元数据相同也不能建立读取权。
- Conversation 创建时固定 active Deployment revision 的 `conversation_contract_hash`。**每个未命中幂等历史的新 Chat Run** 都必须在同一接受事务固定当前 active revision，再比较其 hash 与会话创建时的 hash；不同则在创建 Run、积分预留和 outbox 前返回 `409 CONVERSATION_REVISION_INCOMPATIBLE`，客户端应新建会话。G1 不自动迁移变量、session state 或历史消息。普通 Agent/Prompt/模型/资源版本变化只有在不改变该会话数据 ABI 时才沿用原 hash。命中既有 `Idempotency-Key` 的可读 Run 必须先返回原 canonical 202 receipt，不读取或比较当前 active revision，也不因当前 hash 变化改判。

### 2.1 Agent Chat 的接受、幂等、解析与版本固定

`POST /v1/oapi/agent/chat` 的接受事务不是“把 `robot_id` 和输入直接交给当前编辑态 Agent”。带 `Idempotency-Key` 的请求必须先通过以下幂等 gate；**不得**先解析当前 Deployment/Release、能力 binding 或 Plan 再决定是否重放：

1. 认证调用方并建立受签名的 Workspace context，只做请求结构校验和公开字段规范化；以 `(workspace_id, principal_id, fixed_route_template, key)` 查询历史幂等记录；
2. 若存在历史记录，必须先按普通 Run 读取策略确认该调用方当前仍可读取其原始 Run；不可读时按 `404 RUN_NOT_FOUND` 处理，既不得重放，也不得借幂等键泄漏该 Run；
3. 按 [SSE 契约 §2.4](./api/SSE与异步操作契约.md#24-intent_hash-的-canonical-编码) 的 RFC 8785/JCS preimage 计算稳定的客户端 `intent_hash`：Chat 含 `robot_id`、`conversation_id`、`content`、规范化 `inputs` 与 `response_mode`；Flow 入口含规范化 `inputs` 与 `response_mode`；取消使用固定路径模板 `/v1/oapi/runs/{run_id}/cancel`、`run_id` 与规范化空 body `{}`。它**不**包含当前 credential binding、已解析 Deployment/Agent/Flow、Release、资源 pin、授权决策或 Plan；
4. 历史记录的 `intent_hash` 相同，一律返回已保存的 canonical `202 Operation` acceptance receipt，并回显同一 `run_id`、`accepted_request_id`、receipt data 和新的当前 `request_id`；不得重放首次 blocking 连接可能得到的 `200` 终态投影，也不得重新执行 Release 解析、权限回调、资源解析、Plan 编译、预扣或投递；历史记录的 `intent_hash` 不同则返回 `409 IDEMPOTENCY_KEY_REUSED`；
5. 仅当没有历史记录时，才进入下方的首次执行准入与版本解析。

只有幂等记录未命中时，才按以下顺序完成首次执行准入：

1. 检查入口 principal、active Deployment 的 visibility 与渠道约束。服务端调用从 scoped credential 建立 `credential:<uuid>` principal；浏览器调用只从 exchange 后的 Bearer token 建立 `end_user:<uuid>` principal。`robot_id`/`agentId` 只是兼容选择器，服务端必须将它与 credential 或 browser session 解析为唯一 `deployment_id`；不能越过入口 grant 选择任意 Agent；
2. 在同一事务固定 active `deployment_revision_id`，从中取得**已发布** `agent_release_id`、`experience_release_id`、`conversation_contract_hash`、policy profile 和 credential mappings，并从发布版本注册表回读 dependency manifest/`compiled_hash`。草稿、mutable latest 或未发布资源均不是合法执行目标；secure profile 下依赖必须使用 Release 中的 pin；
3. 读取当前 principal 可见且属于该稳定 Deployment 的 Conversation，并将其创建时 `conversation_contract_hash` 与第 2 步固定 revision 的 hash 比较；不同即返回 `409 CONVERSATION_REVISION_INCOMPATIBLE`。该比较只发生在幂等 miss 路径，且必须与 active revision 固定使用同一事务快照/锁，不能在比较后重新读取 active pointer；
4. 以当前主体、渠道、`CredentialRequirement ∩ Deployment mapping ∩ 当前 grant`、部署画像和外部权限 SPI（如启用）生成 `AuthorizationDecision`，再从已发布能力中收窄为短生命周期 `ResolvedAgentPlan`；任一身份、回调、grant、数据分类、预算或资源解析未知时拒绝，用户凭据缺失不得回退到发布者/团队身份；
5. 对 `inputs` 运行已固定 Agent Release 的输入 Schema 校验，解析 Strategy/Instruction Skill、每项能力的 resource/index pin、说明书/Schema hash、实际 credential binding 摘要、超时、预算、重试和副作用策略。Plan 只保存不可重放 handle/指纹和脱敏摘要，绝不保存原始凭据或连接串；
6. 在一个接受事务中创建 Run、保存 `accepted_request_id`、`intent_hash`、独立的 `accepted_plan_hash`、Deployment/Agent/Experience release IDs、编译 hash、授权决策标识/摘要、canonical `202` acceptance receipt 和输入摘要，并完成积分预留、`run.accepted` event 与启动 outbox；任一项失败都整体回滚，只有提交后才可投递 Worker。receipt 的稳定 data/URL 不含内部 Release/version/resource pin，当前 exchange 的 `request_id`/`now_time` 不作为保存后原样重放的字段。

`accepted_plan_hash` 是首次准入时的不可变执行事实，不能反过来作为幂等比较键。即使后续 active Deployment、Agent/Experience Release、能力 binding、授权决策或资源版本发生变化，稳定意图相同且原 Run 仍可读的重放也必须返回原 canonical 202 receipt。G0/G1 schema、publisher 与 admission 不接受 `floating_latest`/`latest` 等可执行引用，也不存在“首次接受时临时解析”路径；未来若研究此能力，必须使用独立版本 envelope、迁移计划、风险审批和不可绕过 gate。Worker/恢复器只能使用该 Run 的不可变 Plan；在副作用执行前可检查决策是否已撤销或过期，但不得借此扩张 Release 的能力范围。详细领域契约见 [Agent Release v1 与能力装配契约](./architecture/agent-release-v1与能力装配契约.md)；本节不新增任何 Studio 管理端点。

取消不复用 Run 创建时的幂等列：它保存独立的 mutation idempotency record，唯一范围为 workspace、由已验证 transaction context 派生的 principal、固定取消路径模板和 key，**不包含目标 Run**；`run_id` 位于 JCS intent 中，跨 Run 复用同一 key 返回 409。principal 是服务 credential 或 browser session 固定值，请求不得提交或冒充。带 key 的路径必须先锁 mutation key：命中后先按当前主体读取历史目标，不可读固定返回 `404 RUN_NOT_FOUND`；可读时才比较 hash，相同重放第一次的 200/202 投影并返回 Idempotent-Replay，不同返回 `409 IDEMPOTENCY_KEY_REUSED`。miss 才锁当前 Run，并将终态 200 或非终态取消意图/事件/202 receipt 与 keyed record 原子提交。未带 key 的路径跳过 mutation record，只锁当前 Run 后返回终态 200 或持久化非终态取消意图；它不承诺网络重放去重。Human Gate resume 使用相同唯一范围，`run_id + gate_id + action + input` 位于其 JCS intent，key 必填。

幂等 key 的“24 小时”仅是**目标终态后的默认 replay grace**，不是从首次接受起无条件释放唯一性的 TTL。只要关联 Run 仍非终态，创建或 mutation key 都不得释放、复用或被清理；目标终态后至少继续保留 24 小时，且不得短于端点重试、审批链接或合同约定窗口。物理记录保留期必须覆盖该有效期。实现必须分别保存 `target_terminal_at`/`replay_until`，不能仅用 `accepted_at + 24h` 的部分唯一索引使长运行产生第二个事实。

## 3. 响应结构（兼容视图）

顶层：

```json
{
  "code": 200,
  "success": true,
  "message": "",
  "request_id": "服务端生成的 UUIDv7",
  "data": {
    "status": "SUCCEEDED",
    "duration_time": 3.2,
    "message": "",
    "tasks": [],
    "timestamp": 1700000000,
    "run_id": "durable-run-id",
    "accepted_request_id": "首次接受该 Run 的 UUIDv7",
    "billing_pending": false,
    "billing_state": "SETTLED",
    "billing_settled_at": "2026-08-25T08:00:00Z"
  },
  "now_time": 1700000000
}
```

`data.status`：`FAILED` | `SUCCEEDED` | `CANCELLED` | `TIMED_OUT`。`duration_time` 单位秒。`SUCCEEDED` 必须带不可变公开 `result` 且无 `error`；其余终态必须带 closed `error` 且无 `result`。终态兼容 `billing_pending` 是不可变的 terminal-time 快照；G1 只允许 join，因此机器契约固定为 `false`。正常 G1 终态的 `billing_state=SETTLED` 并带 `billing_settled_at`；内部 operator-hold 投影为 `FAILED + SIDE_EFFECT_UNKNOWN` 时 current state 可为 `NEEDS_ATTENTION|SETTLED`。G2 detach 只能通过后续版本 schema 放宽，不能让当前 G1 schema 接受 `billing_pending=true`。`blocking` 在等待窗口内保持此兼容形状；超出窗口不应断开或放弃执行，而是返回 [SSE 契约](./api/SSE与异步操作契约.md) 定义的 `202` operation envelope。

task 对象：

| 字段 | 取值 |
|---|---|
| `name` | `llm_response` \| 技能/知识库/插件名 \| `related_questions` |
| `type` | `TEXT` \| `FUNCTION` \| `RELATED_QUESTIONS` |
| `tool_type` | `dataset` \| `flow` \| `plugin` \| `system` |
| `tool_id` | 经授权的、稳定的能力投影 ID；不是原始资源 ID |
| `status` | `STARTED` \| `SUCCEEDED` \| `FAILED` |
| `content` | object \| string，含 `input` / `output` |
| `duration_time` | 秒 |
| `metadata` | 经可见性裁剪的 icon、color、property 描述符 |
| `upgrade_consume` | 完成的 FUNCTION 事件携带 |

`tasks` 是持久化 `run_steps` / `run_events` 的兼容投影，不是第二套执行或日志事实源。Agent Chat 的每个可见 FUNCTION task 都能在受控审计面按 `run_id` 反查到 Deployment revision、Agent Release、CapabilityBinding、资源 pin、授权决策摘要和 attempt；直接 Flow Run 则反查其 Flow target/version pin。兼容响应与 SSE 不默认暴露这些内部标识、原始规则、secret reference 或未获调用者授权的依赖资源。投影在脱敏和可见性裁剪后才可填充 `tool_id`、`content` 与 `metadata`。

兼容枚举不扩展；六类 Agent 能力按下表折叠为既有 `tool_type`。`tool_id` 必须是 Release/binding 范围内稳定、只对已授权观察者有意义的公开别名或不透明投影，绝不能回显数据库 operation、表、连接、远端 endpoint、内部 resource UUID 或未获授权的依赖 ID。调用方无权观察某次能力调用时，应省略该 FUNCTION task，而不是以真实资源 ID 作为降级值；`metadata.capability_kind` 仅可在调用方已获准知晓该类型时出现，且不得携带版本、授权、连接或密钥细节。

| Agent 能力 | 兼容 `tool_type` | 安全投影规则 |
|---|---|---|
| 知识库 | `dataset` | 使用该知识库 binding 的公开别名，不暴露文档、切片或 revision ID。 |
| 工作流 | `flow` | 使用已授权 Flow binding 的公开别名，不暴露嵌套 Plan 或内部 version ID。 |
| 插件 | `plugin` | 使用已授权插件的公开别名，不暴露配置、凭据引用或 endpoint。 |
| 数据库 | `system` | 使用不透明 capability 别名，绝不暴露 operation、表、schema、连接或 SQL。 |
| SubAgent | `system` | 使用不透明 capability 别名，不暴露子 Agent Release、上下文或委派凭据。 |
| `skill_pack` | `system` | 使用不透明 capability 别名，不暴露手册内容、私有资源或密钥引用。 |

终态 compatibility data 的 `billing_pending` 是 Run terminal snapshot：finalizer 在终态状态、finished 时间和唯一 terminal event 的同一事务写入，之后不可重算或改写。当前 `billing_state`/`billing_settled_at` 来自独立的账务投影。所有非终态 `RunSnapshot` 必须是 `billing_state=PENDING`，且禁止 `billing_pending` 与 `billing_settled_at`；只有进入终态后才按下述规则投影结算结果。G1 普通和 join Run 固化 `billing_pending=false`；G2 若启用 detach，必须先通过后续版本 schema 表达 true 快照，并保证 child 结算或历史 event 被受控清理都不改写该历史字段，只有 GET 的 current state 可反映后续结算结果。

## 4. SSE 流式与旧帧 adapter

公开 v1 的 `response_mode=streaming` **不**以 Chat POST 长连接返回 SSE：创建请求先返回 `202` operation，客户端随后以 `GET /v1/oapi/runs/{run_id}/events` 订阅。平台原生 SSE 帧使用 `id: <run 内 sequence>` 和 `RunEventV1` envelope；事件的顺序、心跳、断线重连、取消、终态、脱敏和错误语义由 [SSE 与异步操作契约](./api/SSE与异步操作契约.md) 统一定义。

历史客户端若未来必须接收直接 POST 的旧 task 流，只能另立版本隔离的 compatibility adapter。该 adapter 将已持久化的 Run 事件投影为旧式 `data: <task-json>` 帧，同时保留 `id: <sequence>`；它不能创建独立执行、日志或计费事实源，连接断开也不能取消 202 后仍在后台运行的 Run。G0/G1 只允许 secure profile，adapter 及其旧路径不可激活；以后启用必须有独立兼容 envelope、迁移计划、风险审批和可执行 gate，且不属于当前 OpenAPI。

- `llm_response` 可以逐 token 推送，但不是持久化事件事实源。
- FUNCTION 类先发 `STARTED`，再发 `SUCCEEDED` 或 `FAILED`；敏感入参/出参经过脱敏后才可进入 task。
- `related_questions` 只能在运行成功的收尾阶段发出；所有运行都必须有唯一终态事件。
- Agent Chat 的 Run/SSE 事件在服务端可按 `run_id` 关联已固定的 Deployment/Agent/Experience Release 与 Plan；直接 Flow Run 同样关联其内部 target/version pin，但公共 operation、task 与 SSE 默认只返回稳定公开 selector 和 `run_id`，不得返回 Release/version/resource pin。两者都不得在流式过程中重新读取草稿或资源最新版本。兼容 adapter 只投影已持久化的步骤和事件，不得因断线、重连或 task 重放再次调用知识库、数据库、Flow、插件、Skill 或 SubAgent。

### 4.1 Human Gate 查询与恢复

平台原生 Run 查询在内部 WAITING 状态时仍返回兼容 `status: "RUNNING"`，并增加脱敏 `pending_action`；该字段只能在公开 `status: "RUNNING"` 时出现。`type=input` 必须同时带公开 `schema` 且 actions 只能是 `submit`；`type=approval` 不带输入 schema，actions 只能来自 `approve`/`reject`。两类都带 `gate_id` 与 `expires_at`，且不得返回 approver policy 内部成员、operation/resource pin、credential 或未授权参数。每次 Gate 等待都发送 durable `run.waiting`；中间 cohort 的正向 decision 只物化下一 Gate 并再次发送 `run.waiting`，只有最后一个正向 decision 才发送 `run.resumed`，reject 不发送 `run.resumed`。

```http
POST /v1/oapi/runs/{run_id}/gates/{gate_id}/resume
Idempotency-Key: <required>
Content-Type: application/json
```

输入型 Gate：

```json
{ "action": "submit", "input": { } }
```

审批型 Gate：

```json
{ "action": "approve" }
```

拒绝审批时仅将 `approve` 替换为 `reject`。

- 请求体必须命中上述两个互斥分支之一：`submit` 必须携带满足公开 JSON Schema 的 object `input`；`approve`/`reject` 必须省略 `input`。actor 从认证 context 获得，请求体不得提交 approver、Workspace、Release、credential、operation hash 或 resume token。
- `Idempotency-Key` 缺失或空值直接返回 `400 REQUEST_VALIDATION_FAILED`。认证后先锁定 `(workspace, principal, fixed resume route template, key)`：若命中，先按当前 principal 对历史 Run/Gate 执行 read gate，再比较包含 `run_id`、`gate_id`、`action`、规范化 `input` 的 JCS intent；相同即重放保存的 `202`，不同返回 `409 IDEMPOTENCY_KEY_REUSED`。命中路径不得先检查 Gate 当前状态、过期、active Deployment 或当前授权。
- 只有幂等 miss 才在同一事务锁定 Run/Gate、验证 actor policy/过期/原 Plan 与 operation hash、credential/resource epoch 和预算，原子 claim、写 mutation idempotency、decision 与不可变 `202` receipt。receipt data 以封闭 `outcome` 区分三种接受结果：`NEXT_GATE_WAITING` 仅物化下一 Gate、写新的 `run.waiting` 并返回脱敏 `pending_action`，保持 quiescent 且不创建 `run.resumed`、attempt 或 Worker outbox；`RUN_RESUMED` 只在最后一个正向 decision 时写 `run.resumed`、下一 attempt 与恢复 outbox；`TERMINAL_INTENT_ACCEPTED` 只在 reject 时写终态意图并唤醒唯一 finalizer，不写 `run.resumed` 或下一 attempt。相同 key/intent 永远重放首次 outcome，当前状态另查 `operation_url`。任何一步失败都不得投递 Worker。同 key 跨 Run/Gate 或改变 action/input 返回 409。预算不足返回 `402 CREDITS_INSUFFICIENT` 且不得 claim/写 decision/投递；Gate 已由另一决策提交返回 `409 GATE_ALREADY_RESOLVED`，过期返回机器约束为 `error.code=GATE_EXPIRED` 的 410，actor 无权读取目标仍按 `404 RUN_NOT_FOUND`，参数不符合 schema 返回 `422 REQUEST_VALIDATION_FAILED`。
- resume 固定原 Deployment/Release/Plan/Checkpoint，不解析 active latest。批准只绑定原 canonical 操作；输入改变、授权收窄或操作 hash 不匹配时返回 `409 GATE_STALE`，由运行逻辑决定是否创建新 Gate。
- 邮件/IM 链接只能携带一次性、短期、绑定 gate/actor/audience 的 exchange token，并先换取受认证会话；仅持有链接不能绕过 approver policy。token、决策详情和敏感表单值不得进入 URL 查询串、SSE 或日志。

## 5. 工作流

```http
POST /v1/oapi/flow/run                       # body: { inputs: {...} }
POST /v1/webhook/flow/{flowId}               # 推荐：HMAC 签名或短期 scoped token
POST /v1/webhook/flow/{flowId}?api_key=...   # 历史 inventory；G0/G1 不可激活
```

`POST /v1/oapi/flow/run` 的 body 有且只有 `inputs` 与可选 `response_mode`，**不得**携带 `flow_id`。该 operation 的审计 purpose 为 `flow_invoke`；它不是凭据属性。调用用 `Access-Key` 的持久化 kind 必须是 `service_api`，并在同一准入事务命中 `flow:run:create` scope 与 exactly-one-flow 的类型化 Flow Deployment entry grant。服务端仅在幂等 miss 的首次准入中解析并固定该 Flow 的发布 `flow_version_id`。多目标绑定返回 `409 FLOW_TARGET_AMBIGUOUS`，未绑定或无权调用返回 `403 FLOW_EXECUTION_FORBIDDEN`。同一幂等键必须先查历史记录并验证原 Run 可读性；不可读固定返回 `404 RUN_NOT_FOUND`，可读且稳定 `intent_hash` 相同才重放 canonical 202。命中时不重新选择 Flow、版本、credential binding 或 Plan，首次记录另行保存 `accepted_plan_hash` 与已固定目标。

G0/G1 Webhook 只接受签名 header、mTLS 或其他不在 URL 暴露秘密的 secure 入口。固定 URL 且不能自定义 header 的渠道属于未来兼容研究：只有在独立兼容 envelope、迁移/弃用计划、管理员风险审批、专用凭据和可执行 gate 全部落地后才可讨论启用；当前运行时必须拒绝 query/path token，绝不能把 Workspace 主凭据写入 URL。

## 6. MCP 服务（三种接入）

| 方式 | 鉴权位置 |
|---|---|
| SSE 添加 | G0/G1 只允许标准 Authorization header 或安全配置引用；URL token/兼容占位符不可激活 |
| 可流式传输的 HTTP | 请求头 `access_key` 映射为 scoped credential |
| 配置文件 | 不写入主密钥；分发可轮换的连接凭据引用或短期 token |

可暴露资源：工作流 · 插件（含自定义）· 三类知识库（文档/问答/多模态）。

## 7. 权限 SPI（企业侧实现）

```http
POST {企业提供地址}?action=external_user_auth
Headers: Workspace-Id, X-Permission-Callback-Credential, Content-Type
Body:  { "user_list": [ { "user_type": "...", "user_id": "..." } ] }   # 需支持空数组
```

响应：

```json
{
  "code": 200, "success": true, "message": "",
  "data": { "user_permission_list": [ {
      "user_type": "DINGTALK_ORGAPP_ROBOT",
      "user_id": "corp:staff",
      "allow": {
        "agents": [], "flows": [], "plugins": [], "a2a_agents": [], "datasets": []
      } } ] }
}
```

- 默认策略：身份缺失、回调失败、响应不完整、`allow` 不填均拒绝访问。
- `allow` 不填即不限制的历史行为仅保留为未来迁移研究，不是 G0/G1 可选 profile。任何未来例外都必须另立独立 envelope、迁移/弃用计划、管理员风险审批、资源 visibility 复验与可执行 gate；当前实现始终 fail-closed。
- 「测试连接」按钮发空数组请求，接口必须容忍
- G0/G1 回调策略按 ADR-001 固定为：单次硬超时上限 `2s`、同一次 admission 内不自动重试、allow cache 最多 `30s`、deny cache 最多 `5s`，并受 credential/session/policy expiry 与 authority epoch 进一步收窄；超时、断路、畸形响应或缓存不一致都不得读取 stale allow 或静默 fail-open。策略随不可变 Deployment revision 发布，只能收紧；放宽必须走新的契约评审。

## 8. Web SDK（`@bty/chat-sdk`）

三种安装：

```bash
npm install @bty/chat-sdk        # 包管理器（Vite / Webpack5，Tree Shaking）
```

```html
<!-- CDN 同步 -->
<link rel="stylesheet" href="https://web-bty-sdk.betteryeah.com/sdk/0.2.4/chat-sdk.css">
<script src="https://web-bty-sdk.betteryeah.com/sdk/0.2.4/chat-sdk.js"></script>
```

CDN 异步走 SystemJS：`system-sdk/systemjs@6.15.1/index.js` + importmap（`react@18.3.1` / `react-dom@18.3.1` / `bty@0.2.4`），取模块 `System.import('BetterYeah').then(m => m.Chat)`。

上方 CDN 示例仅适用于受控出网画像；气隙运行必须由离线包提供等价静态资产，不得在浏览器运行期访问公网。

`init` 参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `root` | 是 | DOM ID，init 时该节点必须已存在（Vue 放 `onMounted`） |
| `agentId` | 是 | 稳定公开 Agent selector；只能与 browser session 中固定的 Deployment 一致，不能选择 Release/revision |
| `accessKey` | 是 | 仅为旧 SDK 参数名；其值是宿主后端 bootstrap 返回的短期 browser session token，SDK 以 `Authorization: Bearer` 发送，不是 publish/Workspace credential |
| `workspaceId` | 否 | 兼容一致性声明；权威 workspace 来自 browser session，值不一致时拒绝 |
| `user.id` | 是 | 展示/日志元数据；不是认证主体，不能改变 token 固定的 `principal_id` 或取得其他用户会话 |
| `user.name` | 否 | 出现在 Agent 日志 |
| `features.*` | 否 | `conversationList` / `clearConversationEnable` / `voice` / `uploadFile` / `toolsLogger`，均默认 false |
| `clientType` | 否 | `PC` \| `MOBILE` \| `DINGTALK_WEB` \| `CLIENT`，仅日志标记来源 |
| `hooks.*` | 否 | `onLinkClick` / `onConversationIdChange` / `onCopy`（配置后默认 copy 失效）/ `onChatEnd` / `onError` |
| `unReadMessageManager` | 否 | `enable` + `onCountMapChange`（countMap 含 `robot` / `conversation`） |

会话与挂载：

```js
const conversationId = await AIChat.api.Conversation.create('会话标题')
const instance = await AIChat.mount({ conversationId: 'xxxx' })
```

`mount` 参数：`conversationId`（空则新建）· `agentMetadata`（Flow 内 `betterAI.session.agentInput.xxx`，Prompt 内 `{{xxx}}`）· `inputAutoFocus`(true) · `inputPlaceholder`("问我任何问题...") · `showWelcome`(true) · `thinkDefaultIsCollapse`(true)

实例方法：`refetch` · `stop` · `getMessageList` · `setInputValue` · `getInputValue` · `submit` · `updateMetaData` · `getGenerateStatus` · `saveVariables`（持久化）· `getConversationList` · `getCurrentConversationId`

宿主后端必须先完成 browser exchange，并通过自己的已认证 bootstrap 把短期 token 交给当前用户；浏览器不得直接持有或调用稳定 publish credential。exchange 的 token 响应和 events-session 的 204 都必须发送 `Cache-Control: no-store`（兼容代理可同时发送 `Pragma: no-cache`）。浏览器订阅运行事件时，SDK 再用 `Authorization: Bearer <browser-session>` 调用 `POST /v1/oapi/runs/{run_id}/events/session`，服务端只允许通过 `Set-Cookie` 下发短期、单 Run、host-only（不得有 `Domain`）、`__Secure-` 前缀、`HttpOnly; Secure; SameSite=Strict` 的 events session，并把 Path 限定到该 Run events 路径；整个 `Set-Cookie` 头必须从应用日志、代理日志和 trace 中删除。随后同源 `EventSource` 自动携带 cookie。cookie 值不得进入响应 body、SSE URL、Referer 或任何可观测导出；v1 也不返回/传递 `stream_token` 或任意长期 key，跨源 EventSource 不受支持。

`CopyPayload.type`：`text` | `html` | `image` | `video` | `table`。所有结构化机器错误的 `error.code` 都是字符串；余额不足固定为 `error.code="CREDITS_INSUFFICIENT"`。BetterYeah 兼容层可同时把顶层整数 `code`（及旧 SDK 的 `ChatError.code`）投影为 `60001`，不得把整数 `60001` 放进 `error.code`。

## 9. 实现前的契约资产

- [OpenAPI 草案](./api/openapi.yaml) 是 G1 browser exchange/session、Chat、显式会话、Flow Run、Run 查询/取消/Human Gate resume/SSE 与浏览器 events session 的 REST 路径、请求/响应和 operation 生命周期机器可读输入；
- OpenAPI 是上述 G1 REST 资源、错误码、分页、认证 scope 和破坏性变更检查的事实源；`agent/push`、`info` 等仅列于历史 compatibility inventory 的端点，尚未成为实现承诺；
- 本文保留的兼容字段由契约测试夹具验证，不把外部产品的内部实现推断写成兼容承诺；
- 运行 API 必须提供服务端 `request_id`、持久化 `accepted_request_id`、`run_id`、`Idempotency-Key`、取消和 Human Gate resume 入口；SSE 以订阅 URL 的 `run_id` 与 `sequence` 支持回放；
- Browser/Agent Chat 的接受夹具必须证明：稳定 publish credential 只留在宿主后端；伪造 `user.id`、subject assertion、origin/audience/session epoch 或跨 principal conversation 均失败；未部署/未发布/未授权目标在接受前被拒绝；已接受 Run 内部固定同一 Deployment/Agent/Experience Release 与能力 pin，但公共响应/SSE 不泄漏这些 pin；两个最终用户的 delegated credential 不串用且缺失时不降级；重放先验证原 Run 可读性、按稳定 `intent_hash` 总是返回 canonical 202 receipt 而不重新解析版本/Plan；取消夹具使用固定路径模板与 `{}` body，重复请求仅写一条 `run.cancel_requested`；SSE/task 仅投影该 Run 的持久化事实，并且决策撤销不会导致能力范围扩大；
- Browser origin 夹具必须覆盖 RFC 6454 规范化等价值、默认端口、IDNA、尾点、`null`/opaque/userinfo/path/query/fragment、缺少或伪造 Origin、错误可信代理配置、精确 `Access-Control-Allow-Origin + Vary: Origin`、credentials 模式不使用通配符，以及 events cookie 无 `Domain`、只经 `Set-Cookie` 交付且全链路日志脱敏；
- Conversation 夹具必须证明每个幂等 miss 的新 Chat 都比较创建时 contract hash，而幂等 hit 在 revision 变化后仍先重放原 canonical 202；历史消息只含脱敏 `user`/`assistant` 公共投影，内部 system/Strategy/tool context 永不返回；
- task 兼容夹具必须覆盖六类能力到既有四值 `tool_type` 的映射，并断言 `tool_id`、`metadata`、`name`、`content` 均不会泄漏未获授权资源、连接信息、版本 pin 或 secret reference；
- 取消/恢复幂等夹具必须独立覆盖统一 mutation scope：cancel 的 keyed hit 顺序为“锁 key → 读取历史目标（不可读即 `404 RUN_NOT_FOUND`）→ 比较 intent → 重放首次 200/202 或返回 409”，keyed miss 才保存 record；unkeyed 路径不得读写 mutation record。同 key/同 JCS intent 重放首次投影并回显 Idempotent-Replay、不新增事件；同 key 跨 Run/Gate 或不同 body 的 intent 冲突为 409。G1 公开 child policy 只接受 join；非终态 `RunSnapshot` 固定 `billing_state=PENDING` 且无 `billing_pending/billing_settled_at`，终态 `billing_pending=false` 且 GET 有 current `billing_state`；G2 detach 启用后再验证不可变 terminal snapshot 与可推进 current state。
- Human Gate 夹具必须覆盖等待期间 Worker/队列重启、并发 submit/approve/reject/cancel、相同 mutation 重放、过期、actor 无权、schema 错误、operation 变化和 credential/resource 撤销，并分别断言三个 receipt outcome：中间正向 decision 为 `NEXT_GATE_WAITING`，只产生下一 `run.waiting` 且没有 `run.resumed`/attempt/outbox；最后一个正向 decision 为 `RUN_RESUMED`，恰好产生一个 `run.resumed`/下一 attempt/恢复 outbox；reject 为 `TERMINAL_INTENT_ACCEPTED`，不产生 `run.resumed`/attempt，只唤醒唯一 finalizer。三种首次 receipt 均可原样重放，外部副作用至多一次。
- URL、Header、请求体、节点日志和 trace 在持久化前应用统一 secret redaction。
