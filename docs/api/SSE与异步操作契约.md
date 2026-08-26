# SSE 与异步操作契约

> 状态：**实现前冻结（P1 运行面、P3-13、SDK/渠道适配的共同输入）**
> 适用范围：Agent Chat、Flow Run 以及后续会产生 `run_id` 的异步操作。
> 规范关键词：**必须**、**不得**、**应**分别表示强制、禁止、建议。

## 1. 与现有 API 的关系及新增决策

[06-API契约](../06-API契约.md) 已固定 Agent Chat 的路径、公共鉴权头、顶层响应和 task 字段。本文件补足该文档未定义的异步操作生命周期、SSE 重连和取消语义；既有客户端可见的 task 字段不删除。

以下是为实现可恢复运行而新增、并优先于旧文档歧义的决策：

| ID | 决策 | 影响 |
|---|---|---|
| A1 | 服务端为每个 HTTP exchange 生成 UUIDv7 `request_id`；被接受的执行额外持久化首次接收时的 `accepted_request_id` 与 durable `run_id`。 | 日志、取消、SSE、计费可关联，同时不让客户端控制服务端请求 ID。 |
| A2 | `response_mode` 是**可选字段**，默认 `blocking`；因此“body 五字段全部必填”修正为仅前四字段必填。 | 消除 [06](../06-API契约.md) 的自相矛盾表述。 |
| A3 | 公开 v1 的 `streaming` 先返回 JSON operation（`202`），再通过 `GET .../events` 建立 SSE；不以持有 POST 连接充当唯一恢复通道。 | 断线可续、SDK/渠道可统一。 |
| A4 | SSE 每个事件有持久化、严格单调 sequence，终态事件恰好一个；由 outbox 在提交后投递。 | 防止“执行完成但客户端永远看不到”或重连丢事件。 |
| A5 | `Access-Key`、Workspace 密钥和长期 API Key 不得出现在 SSE/日志 URL；浏览器 EventSource 仅使用同源、短期、单 Run 的 `HttpOnly` cookie session。 | 保留浏览器可用性，同时不把任意原始 token 放入 body 或 query。 |
| A6 | `blocking` 超出等待窗口时返回 `202` operation，而非中断/丢弃 Run。 | 长任务不因 HTTP 生命周期失踪。 |
| A7 | browser principal 只能由宿主后端以稳定 Deployment publish credential 加已验证 subject assertion exchange 得到；`user.id` 不是身份。 | Conversation、Run、幂等与 delegated credential 均能按最终用户隔离。 |
| A8 | 每个已接受 Run 保存 canonical `202 Operation` acceptance receipt；blocking 的 `200` 只属于首次等待连接。 | keyed 重放结果不随首次等待时长或当前 Run 状态变化。 |

`response_mode=streaming` 的旧式“POST 直接返回 SSE”若确有外部兼容需求，只能作为明确命名、版本隔离的 compatibility adapter；它必须复用本契约的 `run_id`、sequence、事件存储和取消语义，不能另建一套执行路径。

## 2. 标识、鉴权与幂等

### 2.1 标识

| 字段 | 生成者 | 语义 |
|---|---|---|
| `request_id` | 服务端生成 UUIDv7。 | 当前一次 HTTP exchange 的追踪标识；必须在 `X-Request-Id` 响应头和 JSON envelope 中回显。 |
| `client_request_id` | 客户端通过 `X-Client-Request-Id` 可选提供。 | 调用方审计关联值；不决定 `request_id`、授权目标或幂等性。 |
| `accepted_request_id` | 服务端。 | 首次成功接受该 Run 时的 `request_id`；持久化在 Run 中，并在 operation 数据、Run 快照和 Run 事件中回显。 |
| `run_id` | 服务端生成 UUIDv7。 | 一次 durable 执行的身份；用于查询、SSE、取消和积分。 |
| `event_id` | 服务端生成 UUIDv7。 | `run_events` 的不可变记录身份；它不是 SSE 的 `id`。 |
| `sequence` | 服务端分配的十进制字符串。 | 同一 `run_id` 内从 `1` 起严格递增，亦用作 SSE `id`/cursor。 |

`X-Client-Request-Id` 若提供，必须匹配 `^[A-Za-z0-9._:-]{1,128}$`；不合法时返回 `400 CLIENT_REQUEST_ID_INVALID`，不得写入审计或日志。`X-Request-Id` 是响应头；v1 不把入站同名 header 解释为客户端可控的请求标识。幂等重放产生新的当前 `request_id`，但返回同一 `run_id` 和同一 `accepted_request_id`。

### 2.2 公共头与授权

服务端集成使用 `Access-Key + Workspace-Id`；浏览器调用使用 exchange 后的 `Authorization: Bearer <browser-session>`，workspace、Deployment 与 `end_user:<uuid>` principal 全部从 token 推导。持久化 credential kind 仅允许 `service_api|publish|webhook|mcp|permission_callback`；`deployment_publish`、`agent_invoke`、`flow_invoke` 是由当前 OpenAPI operation 决定的 purpose 标签，不存入数据库也不单独授权。`publish` 仅能由宿主后端用于 `POST /v1/oapi/browser/sessions/exchange`，不得下发浏览器或直调 Chat、Conversation、Run、cancel、resume、events；其余当前公共运行端点只接受在同一准入事务满足相应 kind/scope/类型化 entry grant/target cardinality 的 `service_api`。`user.id`、body/header workspace 或 Agent selector 都不能改变已认证 principal。OpenAPI 的 operation-level `x-service-credential-policy` 是 purpose、kind、scope、typed grant family 和 target cardinality 的机器可读约束；对原 Run 操作还必须回读原 Run 目标与当前 grant/epoch。认证中间件与契约测试必须消费它，不能只验证通用 apiKey 外形。除这些鉴权字段与 JSON body 的 `Content-Type` 外，写操作支持：

| 头 | 规则 |
|---|---|
| `X-Client-Request-Id` | 可选调用方关联值；服务端仍生成 UUIDv7 `request_id`，并通过 `X-Request-Id` 响应头与 body 返回。 |
| `Idempotency-Key` | 普通写操作可选但强烈建议；1–128 字符。未提供时网络重放是 at-least-once，服务端不承诺去重。Human Gate resume 是例外：必须提供非空 key，否则返回 400。 |
| `Accept: text/event-stream` | 仅 SSE 读取端点需要。 |
| `Last-Event-ID` | SSE 断线续传 cursor，可与 `cursor` query 二选一。 |

browser session 中的 origin 使用 RFC 6454 ASCII serialization：scheme/host 小写、IDN 转为 A-label、默认端口省略，只接受 `https`（显式本地开发画像可允许 loopback `http`），拒绝 `null`/opaque origin、userinfo、path/query/fragment、尾点主机及非规范等价写法。每次 Bearer browser-session Chat、Conversation、Run read/cancel/resume 与 events-session 都必须在授权前比较 request origin、session 固定 origin 和当前 Deployment exact-origin allowlist；events cookie 订阅必须改为比较 request origin、cookie 固定 origin 和当前 allowlist。跨源请求缺失/`null`/不匹配的 `Origin` 返回 `403 BROWSER_ORIGIN_FORBIDDEN`；同源 GET/HEAD 合法省略 `Origin` 时只能从受信任网关的外部 request target 推导，不能信任客户端提供的 forwarding headers。CORS 只能精确回显该已验证 origin、发送 `Vary: Origin`，credential 模式禁止 `*`。该限制降低浏览器误用面，但 bearer/cookie 本身仍可重放，不能把可伪造的 Origin 当作持有证明。

鉴权和资源授权必须在创建、读取、订阅及取消时逐次校验。不同 Workspace 或无权限的 `run_id` 查询一律返回 `404 RUN_NOT_FOUND`，不得泄漏其存在性。认证失败返回 `401`，已认证但当前 Workspace 不匹配返回 `403`。

### 2.3 幂等规则

Run 创建的 `Idempotency-Key` 可省略（持久化列为 nullable）；提供非空 key 时，唯一性范围严格为 `(workspace_id, principal_id, fixed_route_template, key)`。默认 24 小时是**目标终态后的 replay grace**，不是从接受时间开始无条件失效的 TTL：关联 Run 非终态时，创建和 mutation key 都不得释放、复用或清理；终态后 `replay_until` 至少为 `terminal_at + 24h`，且不得短于端点重试、审批链接或合同窗口。记录物理保留期必须覆盖 replay window，禁止仅以 `accepted_at + 24h` 的部分唯一索引允许长 Run 产生第二个事实。未提供 key 时服务端不承诺去重。G1 conversation create 不接受该头，也不继承 Run 的幂等语义。对创建 Run 的写操作，服务端必须按以下顺序处理，不能先解析当前 Deployment/Release/Plan 或比较 conversation contract：

1. 完成认证、建立 Workspace context，并只做请求结构校验和公开字段的确定性规范化；
2. 以唯一性范围查询历史幂等记录。若命中，必须先按通常的 Run 读取策略检查调用方当前可读原始 Run；不可读时返回 `404 RUN_NOT_FOUND`，不得用幂等命中泄漏资源，也不得新建替代 Run；
3. 计算稳定的客户端 `intent_hash`。它包含 schema 版本、route 与公开请求身份：Chat 为 `robot_id`、`conversation_id`、`content`、规范化 `inputs`、`response_mode`；Flow Run 为规范化 `inputs`、`response_mode`。它不包含 credential binding、已解析的 Agent/Flow、Release、资源 pin、授权决策或 Plan；
4. 命中且 `intent_hash` 相同，总是返回保存的 canonical `202 Operation` acceptance receipt，**不得**重放首次 blocking 连接可能得到的 `200` 终态投影，也不得重新执行目标选择、Release/Plan 解析、权限回调、预扣或投递；响应头含 `Idempotent-Replay: true`。该次 HTTP exchange 有新的 `request_id`/`now_time`，但 receipt data、`run_id` 与 `accepted_request_id` 保持不变，即使当前 Run 已终态或 Release、binding、授权决策已改变；
5. 命中但 `intent_hash` 不同，返回 `409 IDEMPOTENCY_KEY_REUSED`，不重新解析任何资源；未命中时才继续首次执行准入。Agent Chat 的 miss 路径必须在同一事务固定 active Deployment revision，并将其 `conversation_contract_hash` 与 Conversation 创建时保存的 hash 比较；不相等时在 Run、预留、event/outbox 之前返回 `409 CONVERSATION_REVISION_INCOMPATIBLE`。只有比较通过后，才在一个接受事务保存 `intent_hash`、独立的 `accepted_plan_hash`、已固定目标/version、`accepted_request_id`、`run_id`、不含当前 exchange 字段/内部 pin 的 canonical 202 receipt、积分预留、`run.accepted` 与启动 outbox。

`accepted_plan_hash` 记录首次已授权、已 pin 的执行事实，不能作为重放相等性的比较键。取消和 Human Gate resume 也是写操作；它们共用 `(workspace_id, principal_id, fixed_route_template, key)` mutation 唯一范围，target 不在唯一键中。取消的稳定意图含 `run_id` 与规范化 body；resume 含 `run_id`、`gate_id`、`action` 与规范化 `input`。因此同一 key 跨 Run/Gate 复用返回 409。原 Run/Gate 必须先通过同一 principal 的 read gate。未提供 key 时服务端可记录请求指纹用于诊断，但不能宣称请求去重；resume 仍强制要求 key。

### 2.4 `intent_hash` 的 canonical 编码

`intent_hash = SHA-256(UTF-8(JCS(preimage)))`，其中 JCS 是 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) 的 JSON Canonicalization Scheme；不得使用语言默认 JSON serializer、对象插入顺序、区域数字格式或 Unicode 转义策略替代。计算发生在幂等 gate 的公开结构校验之后、任何 Release/Agent input schema 解析之前，因此不会把资源依赖的默认值或当前授权带进稳定意图。

`preimage` 的固定外形为：

```json
{
  "intent_schema": "intent/1",
  "route": "/v1/oapi/agent/chat",
  "request": {
    "robot_id": "...",
    "conversation_id": "...",
    "content": "...",
    "inputs": {},
    "response_mode": "blocking"
  }
}
```

- `route` 是无 query、无 host 的 canonical 路径；`intent_schema`、route 和 endpoint body 字段白名单固定，未知顶层字段在哈希前以 `400` 拒绝而非静默丢弃。
- `response_mode` 在哈希前展开缺省值 `blocking`；`inputs` 已必填，保留为 JSON 值，不套用尚未解析的 Agent/Flow schema 默认值。除这一个公开 envelope 默认外，缺失与 `null` 按 JSON 语义区分。
- Agent Chat 的 request 白名单严格为 `robot_id`、`conversation_id`、`content`、`inputs`、`response_mode`；Flow Run 严格为 `inputs`、`response_mode`，并使用其对应 canonical route。字符串按 UTF-8 原值保留，不 trim/大小写折叠；JCS 定义对象键排序和数字表达，故仅键序变化或等价 JSON 数字表示不得产生不同 hash。
- 取消的 preimage 固定为下列形状，`route` **必须**是路径模板而不是实际 URL，`request.body` 固定为 `{}`（该 endpoint 无 body）：

  ```json
  {
    "intent_schema": "intent/1",
    "route": "/v1/oapi/runs/{run_id}/cancel",
    "request": {
      "run_id": "...",
      "body": {}
    }
  }
  ```

  host、query、实际 path 内的 UUID 表示、请求头和 transport `request_id` 不进入该 preimage；`run_id` 仅以 path parameter 的规范 UUID 值进入 `request`。
- resume 的 preimage 固定使用路径模板 `/v1/oapi/runs/{run_id}/gates/{gate_id}/resume`，request 只含规范 UUID `run_id`/`gate_id`、`action` 和规范化 `input`（字段缺失与 `null` 保持区分）；actor 来自认证 context，不进入可伪造 body。
- 同键重放夹具必须覆盖键序变化、`response_mode` 省略/显式 `blocking`、Unicode、嵌套数组/数字、未知字段拒绝和 `null`/缺失差异，以及取消的模板路径/相同 `run_id`/`{}` body 重放只产生一个 `run.cancel_requested`。还必须覆盖 resume 同 key 跨 Run/Gate 或改变 action/input 得到 409。`accepted_plan_hash` 只记录首次解析后的执行事实，永不加入本 preimage。

取消客户端应提供 `Idempotency-Key`。重复取消不得产生第二个取消事件或第二个终态。

创建 Run 的幂等记录属于 runs；取消/resume 是既有 Run 的变更，必须写入独立的 run_mutation_idempotencies。记录以 workspace、由认证 transaction context 派生的 principal、固定 canonical route template 和 key 为 active 唯一范围，**不包含目标 Run/Gate**；服务端 credential principal 为 `credential:<uuid>`，browser session principal 为 exchange 固定的 `end_user:<uuid>`，请求不能传入或冒充。记录持久化含目标的 JCS intent hash、首次 200 或 202 的安全响应投影、事件 sequence、`target_terminal_at` 与 `replay_until`。带 key 的 mutation 顺序固定为：先锁逻辑 key 并查询记录；hit 时先按同一已认证主体的 Run/Gate-read gate 读取历史目标，不可读立即返回 `404 RUN_NOT_FOUND`，可读后才比较 hash；相同 hash 原样重放保存的首次状态/响应并返回 Idempotent-Replay true，不产生第二条事件，不同 hash 返回 `409 IDEMPOTENCY_KEY_REUSED`；miss 才锁当前 Run/Gate、执行当前状态与重新授权检查，并将 mutation record 与首次 200/202 receipt 原子提交。**命中路径不得先验证 Gate 当前 PENDING 状态、过期、active Deployment 或当前授权。**未提供 key 的取消明确跳过 mutation record，只锁当前 Run 后返回终态 200 或原子持久化非终态取消意图/事件；它不承诺请求去重，run_events 的唯一取消事件仅是同一 Run 的额外事实保护，不能替代跨 Run 的 key 冲突语义。

## 3. REST operation 模型

### 3.1 创建执行

Agent Chat 继续使用 `POST /v1/oapi/agent/chat`。为与既有会话流程一致，v1 compatibility body 如下：

```json
{
  "robot_id": "agent-id",
  "conversation_id": "conversation-id",
  "content": "总结书籍内容",
  "inputs": { "bookName": "孙子兵法" },
  "response_mode": "streaming"
}
```

`robot_id`、`conversation_id`、`content`、`inputs` 必填，`inputs` 可以是空对象；`response_mode` 可省略，省略时为 `blocking`。缺少 `conversation_id` 的客户端必须先调用 `POST /v1/oapi/agent/conversation`，不能由 Chat 端点隐式创建以掩盖调用错误。`robot_id` 必须与 credential/browser session 固定的 Deployment 一致；`conversation_id` 必须属于同一 Workspace、principal 和 Agent，否则统一返回 `404 CONVERSATION_NOT_FOUND`。G1 conversation create 不接受 `Idempotency-Key`，未知网络结果不得被描述为已有去重保证。Conversation 创建时保存 active revision 的 `conversation_contract_hash`；之后**每个幂等 miss 的新 Chat Run** 都在同一事务固定 active revision 后比较该 hash。幂等 hit 必须在此之前返回原 canonical 202，不读取 active pointer；miss hash 不同则返回 `409 CONVERSATION_REVISION_INCOMPATIBLE` 并要求新建会话。

Flow 的既有 `POST /v1/oapi/flow/run` 也必须映射到同一 operation 模型。为保持该 compatibility body 只有 `inputs`，它的 operation purpose 为 `flow_invoke`，但该 purpose 不是 credential profile；授权只在 kind 为 `service_api`、含 `flow:run:create` scope 且具有 exactly-one-flow 的类型化 Flow Deployment entry grant 时成立。服务端仅在幂等 miss 的首次授权事务中从 grant 解析 `flow_id`，再解析可运行的发布 `flow_version_id` 并固定进 Run。body 不得携带 `flow_id`，多目标 credential 不得调用该路径（`409 FLOW_TARGET_AMBIGUOUS`）；后续显式 Flow ID 的新路由必须另立路径。幂等命中必须先按普通 read gate 检查原 Run；不可见固定返回 `404 RUN_NOT_FOUND`，可见且 intent 相同才返回保存的 canonical 202。已解析的 `flow_id`、固定版本及 Plan 只写入内部首次接受记录，不进入公开 receipt 或稳定 `intent_hash`，命中路径绝不重新解析当前发布版本或 credential binding。

请求被接受后，服务端创建 Run 并持久化以下 canonical acceptance receipt 的稳定 data；HTTP 状态为 `202 Accepted`。`request_id`/`now_time` 属于当前 exchange，重放时重新生成；其余 receipt data 不变：

```json
{
  "code": 202,
  "success": true,
  "message": "accepted",
  "request_id": "019...",
  "data": {
    "run_id": "019...",
    "accepted_request_id": "019...",
    "status": "QUEUED",
    "operation_url": "/v1/oapi/runs/019...",
    "events_url": "/v1/oapi/runs/019.../events",
    "cancel_url": "/v1/oapi/runs/019.../cancel",
    "conversation_id": "conversation-id"
  },
  "now_time": 1700000000
}
```

响应必须同时携带 `Location: /v1/oapi/runs/{run_id}` 与 `X-Request-Id`。receipt 只含公开 selector/operation/run URL，不含 Deployment revision、Agent/Flow/Experience Release、Flow version、resource pin、Plan hash 或 credential binding。创建 Run、积分预留、保存 receipt 和写入 `run.accepted` 事件必须处于同一事务边界（通过 outbox 提交），不允许返回 202 而没有可查询的 Run。

### 3.2 `blocking` 与 `streaming`

| `response_mode` | 创建后行为 | 返回 |
|---|---|---|
| `streaming` | 立即接受 Run；客户端再建立 SSE。 | `202` operation envelope。 |
| `blocking` | 服务端最多等待 `blocking_wait_ms`（默认 30 秒，部署上限 60 秒）。 | 在窗口内终态时为 `200` 兼容终态响应；超窗时为 `202` operation envelope。 |

`blocking` 在**首次**请求窗口内结束时保持 [06](../06-API契约.md) 的 `data.status`、`duration_time`、`tasks`、`timestamp` 及顶层 `code/success/message/now_time`；仅新增顶层 `request_id` 以及 `data.run_id`、`data.accepted_request_id`，并与 GET 共用 Run 上不可变的互斥 `result|error` 终态快照。该 200 是连接期投影，不写入幂等事实；相同 key 的任何后续重放都返回 canonical 202 receipt，并由客户端 GET/SSE 读取当前状态。断开连接不得取消后台 Run。

### 3.3 查询与取消

| 方法 | 路径 | 成功语义 |
|---|---|---|
| `GET` | `/v1/oapi/runs/{run_id}` | 返回当前 Run 快照、终态、`last_sequence`、安全结果摘要及可用的链接。 |
| `GET` | `/v1/oapi/runs/{run_id}/events` | 返回本 Run 的 SSE 事件流。 |
| `POST` | `/v1/oapi/runs/{run_id}/cancel` | 非终态 Run 设为 `CANCEL_REQUESTED` 并返回 `202`；带 key 时持久化首次 202 并可重放，省略 key 时不创建 mutation 幂等记录且不承诺网络去重；已终态 Run 返回 `200` 及原终态。 |
| `POST` | `/v1/oapi/runs/{run_id}/gates/{gate_id}/resume` | 以必填 Idempotency-Key 提交 input/approve/reject；原子 claim 后返回含封闭 `outcome` 的 `202`，相同 mutation 重放首次 outcome。 |

`GET /runs/{run_id}` 的公开状态为 `QUEUED`、`RUNNING`、`CANCEL_REQUESTED`、`SUCCEEDED`、`FAILED`、`CANCELLED`、`TIMED_OUT`。内部 `WAITING_FOR_INPUT/WAITING_FOR_APPROVAL` 在兼容 API 中保持非终态 `RUNNING`，同时返回脱敏 `pending_action` 并以 `run.waiting` 事件区分；`pending_action` 不得出现在其他公开状态。`type=input` 必须含公开 schema 且 actions 只能为 `submit`；`type=approval` 不含输入 schema，且 actions 只能来自 `approve`/`reject`。等待态不代表 Worker 仍持有 lease。`CANCEL_REQUESTED` 只是意图确认，不得假报为已取消；最终结果以 SSE `run.terminal` 或后续 operation 查询为准。所有非终态 `RunSnapshot` 都必须固定 `billing_state=PENDING`，并禁止 `billing_pending` 与 `billing_settled_at`。只有终态 `RunSnapshot` 与 blocking 终态 `data` 携带兼容布尔 `billing_pending`；G1 机器契约固定为 `false`，G2 detach 须由后续版本 schema 放宽。终态 GET/Blocking 返回当前 `billing_state=SETTLED|NEEDS_ATTENTION`，且 `billing_settled_at` 当且仅当 state 为 `SETTLED` 时出现。客户端只以 current state 判断最终费用/清理。运行时执行状态 `NEEDS_ATTENTION` 必须投影为公开 `FAILED`，并携带 `error.code=SIDE_EFFECT_UNKNOWN`、`retryable=false`、`requires_operator_action=true`；账务 `billing_state=NEEDS_ATTENTION` 是独立字段，不得混同两者。

Human Gate resume 请求必须命中互斥分支：input gate 只接受 `{ "action": "submit", "input": {...} }` 且 input 必须存在；approval gate 只接受 `{ "action": "approve" }` 或 `{ "action": "reject" }` 且禁止 input。只有幂等 miss 才执行预算检查；预算不足返回 `402 CREDITS_INSUFFICIENT`，不得 claim Gate、写 decision、创建下一 attempt 或投递 Worker。过期 Gate 返回机器约束为 `error.code=GATE_EXPIRED`、`retryable=false` 的 410。decision 接受不等于 Run 已恢复：中间正向 decision 的 receipt 为 `NEXT_GATE_WAITING`，只物化下一 Gate、写新的 `run.waiting` 并返回脱敏 `pending_action`，保持 quiescent 且不写 `run.resumed`/attempt/outbox；只有最后一个正向 decision 返回 `RUN_RESUMED`，并原子写唯一 `run.resumed`、下一 attempt 与恢复 outbox；reject 返回 `TERMINAL_INTENT_ACCEPTED`，只提交终态意图并唤醒唯一 finalizer，不写 `run.resumed`/attempt。相同 actor/key/intent 永远重放首次 outcome，当前 Run 状态另由 operation 查询。

终态 `billing_pending` 不是从当前 allocation、parent link 或 event payload 推导的临时值。受控 finalizer 必须在同一事务先追加 terminal event（由锁定 Run 行分配 sequence），再写定 Run 的不可变 terminal billing snapshot、finished 状态与 durable `last_event_sequence`；GET、blocking 兼容响应与 SSE 都投影该同一字段和十进制字符串 sequence。G2 若通过后续版本启用 detach，child 后续结算或 event retention 清理也不得改变已终态 Run 的历史值或 cursor，只能推进当前 `billing_state`/`billing_settled_at`。

## 4. SSE 协议

### 4.1 连接

```http
GET /v1/oapi/runs/{run_id}/events?cursor=42 HTTP/1.1
Accept: text/event-stream
Workspace-Id: workspace-id
Access-Key: access-key
Last-Event-ID: 42
```

服务端客户端可使用 `Access-Key + Workspace-Id`。浏览器原生 `EventSource` 无法稳定添加 Authorization header 时，浏览器必须先用 exchange 后的 Bearer session 以 `fetch(..., { credentials: "include" })` 同源调用 `POST /v1/oapi/runs/{run_id}/events/session`；稳定 publish credential 不得参与浏览器请求。服务端在执行本节 request-origin 校验并确认该 browser principal 仍可读取 Run 后返回 `204`、`Cache-Control: no-store` 与 `Set-Cookie`。`Set-Cookie` 是 cookie 值唯一允许出现的响应位置：名称使用 `__Secure-` 前缀，host-only 且不得含 `Domain`，并设置 `HttpOnly; Secure; SameSite=Strict; Max-Age <= 60`，Path 限定到该 events URL；服务端只存不可逆校验材料，应用/代理日志与 trace 必须删除整个 Set-Cookie 头。随后同源 `EventSource` 自动携带 cookie 建连。cookie 值不得进入响应 body、operation JSON、SSE URL、Referer、日志或导出；跨源 EventSource 不受支持。历史 URL-token 流若以后确有需要，只能作为不在本 OpenAPI 内的版本隔离 compatibility adapter，且必须投影本 Run 事件事实源。

`cursor` 与 `Last-Event-ID` 均存在时必须相同，否则返回 `400 CURSOR_CONFLICT`。未提供 cursor 从当前保留窗口的最早事件开始；提供 cursor 时返回所有 `sequence > cursor` 的事件。服务端在 15 秒内无业务事件时发送 SSE 注释心跳（`: keep-alive`），不占用 sequence。

### 4.2 SSE 帧与事件 envelope

每一条业务事件必须按以下形式写出，`id` 与 `data.sequence` 相等：

```text
id: 42
event: node.completed
retry: 1500
data: {"schema_version":"run-event/1","event_id":"019...","sequence":"42","occurred_at":"2026-08-24T01:23:45.678Z","accepted_request_id":"019...","run_id":"019...","type":"node.completed","scope_path":"root","node":{"node_id":"019...","key":"llm_1","type":"llm"},"data":{"output":{"text":"..."}}}

```

```ts
interface RunEventV1<T extends RunEventType> {
  schema_version: "run-event/1";
  event_id: string;
  sequence: string;
  occurred_at: string;           // RFC 3339 UTC，事件提交时间
  accepted_request_id: string;
  run_id: string;
  type: T;
  scope_path?: string;           // root / branch:case-a / loop:3 等
  node?: { node_id: string; key: string; type: string };
  data: PublicEventDataByType[T]; // OpenAPI oneOf 中与 type 对应的白名单 schema
}
```

上式只表达类型映射。机器可读规范是 OpenAPI `RunEvent.oneOf`：每个分支以 `type: const` 绑定专用 `data` schema，并拒绝未知顶层/data 字段；`run.waiting`、`run.resumed` 与 `run.terminal` 不是依赖 `x-` 扩展才能验证的例外。动态用户/工具内容只能出现在显式标记为 `PublicRedactedPayload` 的叶节点，并且仍须先经过业务 schema 脱敏。

`sequence` 以字符串传输，避免 JavaScript number 精度问题。SSE `id` **只能**等于该 Run 内的 `sequence`；`run_id` 已由订阅 URL 绑定，禁止把 `run_id + sequence` 拼成另一个 SSE id。服务端必须先持久化 `run_events` 再投递；同一事件可能在重连后再次送达，客户端必须以 `(run_id, sequence)` 去重（`event_id` 可作辅助审计键）。服务端不得跳号、重排，也不得为心跳分配 sequence。

### 4.3 事件类型和旧 task 兼容视图

| 事件 | 触发时机 | `data` 最小字段 |
|---|---|---|
| `run.accepted` | Run、canonical 202 receipt 与积分预留已提交。 | `status: "QUEUED"`，以及 compatibility 所需的稳定公开 selector；不得含 Deployment revision、Release/version/resource pin、Plan hash 或 credential binding。 |
| `run.started` | Worker 获得有效租约并开始。 | `status: "RUNNING"`。 |
| `node.started` | 一次节点 attempt 已开始。 | `attempt`、`timeout_ms`。 |
| `task.delta` | LLM 可见文本增量。 | `task`（见下）、`delta`。 |
| `task.completed` | LLM/工具/知识等兼容 task 完成。 | `task`。 |
| `node.completed` | 节点 checkpoint 已提交。 | `attempt`、安全 `output` 摘要、`usage`。 |
| `node.failed` | 节点 attempt 失败且可见。 | `attempt`、`error`、`will_retry`。 |
| `run.usage` | 预留/结算有可见变化。 | `reserved`、`consumed`、`currency`。 |
| `run.waiting` | checkpoint/HumanGate/通知 outbox 已提交，Worker lease 已释放。 | 脱敏 `pending_action`：`gate_id`、`type`、公开 schema/actions、`expires_at`；不含 approver 内部名单、operation hash 或 credential。 |
| `run.resumed` | 最后一个正向 Human Gate decision 已提交并创建下一 attempt；中间正向 decision 与 reject 均不产生该事件。 | `gate_id`、公开 `action=submit|approve`、`resumed_at`；敏感 input 只保存受控引用/摘要。 |
| `run.cancel_requested` | 取消已被接受。 | `requested_at`。 |
| `run.terminal` | Run 进入唯一终态。 | 公开 `status`、`duration_time`、`result` 或 `error`、`last_sequence`，以及**必填** `billing_pending`。内部 `NEEDS_ATTENTION` 使用 `status: "FAILED"`、`error.code: "SIDE_EFFECT_UNKNOWN"`、`requires_operator_action: true`。 |

为了兼容 [06](../06-API契约.md) 的 task 流，`task.delta` 和 `task.completed` 的 `data.task` 必须保留：`name`、`type`、`tool_type`、`tool_id`、`status`、`content`、`duration_time`、`metadata`、`upgrade_consume`。FUNCTION 类必须先有 `STARTED` 视图再有终态视图；`related_questions` 只能在 Run 成功收尾前发出。`task.delta.data.delta` 是追加文本，compatibility adapter 若要严格复刻逐字符推送，必须每次发送一个 Unicode code point；原生 v1 客户端不得假定模型 token 和 UTF-16 字符相同。

事件投影沿用既有四值枚举，不能为 Agent 能力新增 `tool_type`：

| 能力 | `tool_type` | 事件投影约束 |
|---|---|---|
| 知识库 | `dataset` | 仅可发出授权后的公开 binding 别名。 |
| 工作流 | `flow` | 仅可发出授权后的公开 binding 别名。 |
| 插件 | `plugin` | 仅可发出授权后的公开 binding 别名。 |
| 数据库 | `system` | 仅可发出不透明 capability 别名；不得暴露 operation、表、schema、连接或 SQL。 |
| SubAgent | `system` | 仅可发出不透明 capability 别名；不得暴露子 Release、上下文或委派凭据。 |
| `skill_pack` | `system` | 仅可发出不透明 capability 别名；不得暴露手册、私有资源或密钥引用。 |

所有 `tool_id`、`name`、`content` 与 `metadata` 均先经过可见性裁剪和 schema 脱敏；调用方无权观察某次调用时，必须省略该 FUNCTION task，不能以真实资源 ID、版本 pin 或 endpoint 作为替代值。`metadata.capability_kind` 只可在调用方获准知晓类型时出现。

### 4.4 重连、保留与终态

运行事件在终态后默认至少保留 7 天；部署只可延长。若 cursor 早于可保留的最小 sequence，SSE 建连返回 `410 EVENT_CURSOR_EXPIRED`。`last_sequence` 从 Run 上持久化的单调 cursor 读取，绝不从可清理 event 行重新聚合；尚有事件时 `min_sequence` 是保留行的最小 sequence，当前全量 event purge 后为 `last_sequence + 1`。该响应不是通用 `data: null` 错误：顶层仍有当前 HTTP `request_id`，而 `data` 必须精确为 `run_id`、`min_sequence`、`last_sequence`、`operation_url` 与 `events_url`，例如：

```json
{
  "code": 410,
  "success": false,
  "message": "event cursor is outside the replay window",
  "request_id": "019...",
  "data": {
    "run_id": "019...",
    "min_sequence": "42",
    "last_sequence": "80",
    "operation_url": "/v1/oapi/runs/019...",
    "events_url": "/v1/oapi/runs/019.../events"
  },
  "error": {
    "code": "EVENT_CURSOR_EXPIRED",
    "retryable": false,
    "category": "CONFLICT"
  },
  "now_time": 1700000000
}
```

客户端应先查询 operation 快照，再选择从有效位置重新订阅。cursor 大于 `last_sequence` 返回 `409 CURSOR_OUT_OF_RANGE`。

`run.terminal` 必须是每个 Run 的最后一条业务事件，并且恰好一条；其 sequence 同时是不可变 `runs.last_event_sequence`。其 `data` 必须符合 OpenAPI `RunTerminalEventData`（含必填且 `const: false` 的 `billing_pending`），且不携带可变 `billing_state`。G1 普通 Run 与 join parent 的该帧和最终计费结算原子关联；public detach 在 G1 准入时拒绝。G2 若启用 detach，必须先以新版本 schema 明确放宽该 const 并持久化 handoff，不能让当前 G1 validator 接受 true。断线、410 cursor 过期或跳过 SSE 的客户端必须可从 `GET /runs/{run_id}` 读到同一历史 `billing_pending`、当前 `billing_state` 和 `last_sequence`。服务器在该帧 flush 后可关闭连接。除网络异常外，服务器不得无终态关闭流。客户端在网络异常后以最后已处理的十进制 sequence 重连；若从未收到终态，不得以连接关闭推断执行成功或失败。

terminal event 的 `billing_pending` 与 Run 上不可变快照必须在同一事务写入。因而客户端即使在 cursor 过期、断线、跳过 SSE 或 event retention 后查询，也能从 GET 得到与原 terminal event 完全相同的布尔值；服务端不得根据稍后的账务变化改写它。当前结算变化只更新 `billing_state` 与 `billing_settled_at`，不产生第二个 terminal event。

## 5. 错误模型

所有 JSON 错误保留既有 envelope 并扩展结构化 `error`：

```json
{
  "code": 409,
  "success": false,
  "message": "idempotency key has a different request payload",
  "request_id": "019...",
  "data": null,
  "error": {
    "code": "IDEMPOTENCY_KEY_REUSED",
    "retryable": false,
    "category": "VALIDATION"
  },
  "now_time": 1700000000
}
```

除 `410 EVENT_CURSOR_EXPIRED` 外，本节的普通错误 `data` 均为 `null`；410 必须使用第 4.4 节的恢复数据结构，机器可读定义见 OpenAPI 的 `EventCursorExpiredErrorResponse`。

| HTTP | `error.code` | 客户端动作 |
|---|---|---|
| 400 | `REQUEST_VALIDATION_FAILED` / `CLIENT_REQUEST_ID_INVALID` / `CURSOR_CONFLICT` | 修正请求，不重试。 |
| 401 / 403 | `AUTHENTICATION_FAILED` / `WORKSPACE_FORBIDDEN` / `BROWSER_ORIGIN_FORBIDDEN` / `ENDPOINT_SCOPE_FORBIDDEN` / `FLOW_EXECUTION_FORBIDDEN` | 刷新或修正请求上下文/授权；按 ID 资源不可见仍统一 404，不得以 403 泄漏存在性。 |
| 402 | `CREDITS_INSUFFICIENT` | 机器错误固定为字符串；BetterYeah 兼容 envelope 可同时使用顶层整数 `code: 60001`，不得重试扣费。 |
| 404 | `RUN_NOT_FOUND` / `CONVERSATION_NOT_FOUND` | 资源不存在或无可见权限。 |
| 409 | `IDEMPOTENCY_KEY_REUSED` / `CONVERSATION_REVISION_INCOMPATIBLE` / `CURSOR_OUT_OF_RANGE` / `FLOW_TARGET_AMBIGUOUS` / `FLOW_TARGET_UNAVAILABLE` / `GATE_ALREADY_RESOLVED` / `GATE_STALE` | 使用原 key 对应结果、为不兼容 Conversation 新建会话、使用正确 cursor，或重新读取 Run/Gate；不得重放旧批准。 |
| 410 | `EVENT_CURSOR_EXPIRED` / `GATE_EXPIRED` | cursor 响应使用专用恢复 data；Gate 响应的 `error.code` 由机器 schema 固定为 `GATE_EXPIRED` 且不可重试。查询 operation 快照后重新订阅，或由运行逻辑创建新的输入/审批请求。 |
| 429 | `RATE_LIMITED` | 依据 `Retry-After` 退避。 |
| 503 / 5xx | `INTERNAL` / `UPSTREAM_UNAVAILABLE` | 仅在 Run 尚未被接受且 `retryable=true` 时使用同一幂等键重试。 |

Flow IR 错误映射以发生时点区分：

| Flow IR `category` | Run 被接受前 | Run 被接受后 |
|---|---|---|
| `VALIDATION` | `400 REQUEST_VALIDATION_FAILED`；不得创建 Run。 | 仅限实现缺陷或已固定快照异常；Run 以 `FAILED` 终态和安全错误摘要结束。 |
| `RESOLUTION` | `409 FLOW_TARGET_UNAVAILABLE`；不得泄漏未授权资源细节。 | `FAILED`，`error.code` 保留安全的资源解析错误。 |
| `POLICY` | `403 FLOW_EXECUTION_FORBIDDEN`。 | `FAILED`，不得以 `continue_with` 伪装成功。 |
| `CANCELLED` / `TIMEOUT` | 不适用。 | 分别投影为 `CANCELLED` / `TIMED_OUT` 终态。 |
| `UPSTREAM_TRANSIENT` / `UPSTREAM_PERMANENT` | 若尚未接受且依赖不可用，可返回 `503 UPSTREAM_UNAVAILABLE`。 | `FAILED`；`retryable` 由已固定节点策略决定。 |
| `SIDE_EFFECT_UNKNOWN` | 不适用。 | 内部进入 `NEEDS_ATTENTION`，公开投影为 `FAILED`，`retryable: false`、`requires_operator_action: true`。 |
| `INTERNAL` | 未接受时返回安全的 `5xx`。 | `FAILED`；保留 `request_id` 供支持人员追踪，不暴露堆栈或密钥。 |

运行中错误通过 `node.failed` 和最终 `run.terminal` 表达，不能用 HTTP 200 的连接关闭代替。SSE 若鉴权/重连失败，在尚未写入首帧前返回相同 JSON 错误；开始流后发生内部投递问题时必须写一个安全的 `run.terminal`（若 Run 已终态）或让客户端按 cursor 重连，不能伪造成功。

## 6. 数据脱敏、可见性与审计

事件、operation 查询、task 日志和 OTel 属性使用同一套字段分类：`PUBLIC`、`SENSITIVE`、`SECRET`。

- `SECRET`（Access-Key、API Key、Webhook 凭据、`Authorization`、Cookie、模型/provider token、`secret_ref` 的解析值）绝不进入 REST body、SSE、日志、追踪、错误、task `input/output` 或导出文件；只可记录类型和不可逆指纹。
- `SENSITIVE`（用户输入、文件名/内容、会话元数据、第三方响应）默认仅向拥有该 Run 读取权限的调用方返回，并按节点/字段配置进一步掩码；不具备敏感读取权限时返回 `"[REDACTED]"` 与 `redaction_reason`。
- 公共 Conversation history 只返回 schema 脱敏后的 `user`/`assistant` 投影；内部 system prompt、Strategy/Instruction Skill、工具上下文、隐藏控制消息和审计事件不进入该端点。公开事件的 `type + data` 必须匹配 OpenAPI 标准 `oneOf` 分支，不能依赖自定义扩展或任意 object 绕过字段白名单。
- URL 日志必须剥离 query 全部值，尤其是旧 `api_key`；v1 events URL 不接受认证 query 参数。events cookie 值只允许出现在已禁止记录/追踪的 `Set-Cookie` 交付头，不得出现在响应 body、日志、追踪或 Referer；其他响应也不得回显请求头或原始 URL。
- `task.content.input/output` 只发布经过 schema 驱动脱敏后的视图。安全审计记录 `redaction_policy_version`、字段路径和哈希，不保存原密钥副本。
- `request_id`、`accepted_request_id`、`run_id`、`event_id` 可记录；它们不是授权凭据。任何事件订阅都必须再次完成 Workspace 与资源权限判断。
- 公共 operation、Run 和 SSE 不返回 Deployment revision、Agent/Flow/Experience Release、资源 version/generation pin、Plan/closure hash 或内部 resource UUID；这些只可在具备 `observe-internals` scope 的管理审计 API 中读取，且不属于本 G1 公共 OpenAPI。

Webhook `?api_key=...` 只保留为历史 inventory，不是 G0/G1 可激活入口；当前 secure profile 必须拒绝 URL/path credential，并使用签名 header、mTLS 或等价的非 URL 认证。若未来确有不可改造渠道，必须先冻结独立兼容 envelope、迁移/弃用计划、管理员风险审批、专用凭据与可执行 gate，再另立版本化入口；不得复用 Workspace `Access-Key`，也不能仅靠日志脱敏把它视为当前安全行为。

## 7. 验收用例

除已有创建 Run 幂等夹具外，还必须覆盖：cancel keyed hit 严格按“锁 key → 历史目标 read gate → intent compare → replay/conflict”执行，历史目标不可读时为不泄漏存在性的 `404 RUN_NOT_FOUND`；cancel unkeyed 路径不查询/写入 mutation record；相同取消/resume key 重放保存的响应并带 Idempotent-Replay；同一 key 指向不同 Run/Gate 因 JCS intent 不同而返回 409。Human Gate 首次 receipt 与重放都必须在 `NEXT_GATE_WAITING`、`RUN_RESUMED`、`TERMINAL_INTENT_ACCEPTED` 三种封闭 outcome 中。G1 还必须覆盖公开 detach 被拒绝、所有非终态 `RunSnapshot` 固定 `billing_state=PENDING` 且没有 `billing_pending/billing_settled_at`、普通/join 终态固化 `billing_pending=false`。G2 启用 detach 前再覆盖父 Run true 快照、child 后续结算后 state 推进及终态 event 清理边界。

P1/P3 的集成测试至少覆盖：

1. 省略 `response_mode` 时按 `blocking` 处理；其余四字段缺失分别得到校验错误。
2. 相同 `Idempotency-Key` 与相同稳定 `intent_hash` 只产生一个 `run_id`、一次预留、一份 canonical 202 receipt 和一组 sequence；即使首次 blocking 连接返回过 200，重放仍先验证原 Run 可读性，再以新的当前 `request_id` 返回相同 receipt data/`accepted_request_id`，即使 Run 已终态或 Release/binding/决策已改变；不同意图得到 409，原 Run 不可读时得到不泄漏存在性的 404。
3. `streaming` 创建返回 202，事件从 `run.accepted` 递增到唯一 `run.terminal`；断线后以 `Last-Event-ID` 恰好补齐遗漏事件。
4. `blocking` 超时窗口后为 202，后台 Run 仍可由 GET/SSE 观察并结束。
5. 取消前后并发请求最多写一个 `run.cancel_requested`、一个 `run.terminal`；runtime 的裸 event 写或白名单外的 cancel/terminal 伪造均被数据库拒绝，已开始的不可取消上游调用不被误报为立即取消。
6. 过期 cursor 返回 410，且 `data` 精确含 `run_id`、`min_sequence`、`last_sequence`、`operation_url`、`events_url`；全量 retention 后 `min_sequence=last_sequence+1`、而 GET/410 仍返回 Run 上持久化的原 `last_sequence`；未来 cursor 返回 409；心跳不改变 sequence。
7. 宿主后端以稳定 publish credential + 有效 subject assertion 完成 exchange，浏览器只拿到绑定 workspace/Deployment/channel/principal/origin/audience/expiry/session epoch 的短期 Bearer session；伪造 `user.id` 或跨 principal 会话失败。Browser 请求逐次执行 RFC 6454 request-origin/allowlist 校验和 exact CORS 响应；缺失、`null`、非规范或不相等 origin 被拒绝。浏览器再以 Bearer header 获取同源、短期、单 Run、host-only 且无 Domain 的 `__Secure-`/`HttpOnly; Secure; SameSite=Strict` events cookie，并用原生 EventSource 订阅；token 响应均 `no-store`，cookie 值只出现在已从日志/trace 排除的 `Set-Cookie`，publish/Access-Key、Webhook/API key、cookie 值和 Authorization 值均不进入 body、SSE URL、结构化日志、错误或 trace 快照。
8. `flow_invoke` operation 只在 `service_api + flow:run:create scope + exactly-one-flow typed grant` 联合成立时启动其绑定 Flow；多目标 grant 在 `/v1/oapi/flow/run` 得到 `409 FLOW_TARGET_AMBIGUOUS`，同一幂等键重放先检查原 Run 可读性且不重新选择版本。
9. 旧 task 的 `STARTED → SUCCEEDED/FAILED`、LLM 增量和 `related_questions` 在 compatibility adapter 中字段级保持可消费；六类能力稳定折叠到 `dataset`/`flow`/`plugin`/`system`，并且未授权资源、版本 pin、连接、endpoint 和 secret reference 不会进入 `tool_id`、`metadata`、`name` 或 `content`。
10. Human Gate candidate 必须先在同一 barrier CAS 中持久化 checkpoint、冻结全图调度并将 candidate Worker lease 原子 handoff 给 host-only barrier owner；只有全图 quiescence 证明成立后，waiting 事务才递增 fence、持久化唯一 `run.waiting` 并释放 barrier owner，candidate lease 不得在 WAITING 后再次释放。断线可按 sequence 重放。中间正向 decision 必须得到 `NEXT_GATE_WAITING`，只产生下一 `run.waiting` 且没有 `run.resumed`/attempt/outbox；最后一个正向 decision 必须得到 `RUN_RESUMED`，恰好产生一个 `run.resumed`/下一 attempt/恢复 outbox；reject 必须得到 `TERMINAL_INTENT_ACCEPTED`，不产生 `run.resumed`/attempt，只唤醒唯一 finalizer。并发 submit/approve/reject/cancel 只有一个 claim 胜出，过期、actor 无权、schema 错误、operation/epoch 变化均不能执行副作用。
11. 首次 Gate decision 接受后 Gate 已不再 PENDING，相同 actor/key/intent 的重试仍先命中 mutation 幂等记录并重放原 202 outcome；只有 miss 才检查当前 Gate 状态。Run 非终态期间创建/mutation key 不释放，终态后至少覆盖 replay grace，超过 24 小时的 WAITING Run 不能因 key 过期创建第二个 Run。
12. 标准 OpenAPI 3.1 validator 必须用 `RunEvent.oneOf` 拒绝 type/data 错配、未知顶层字段、缺少 HumanGate/terminal 必填字段和未列入安全投影的公开字段，并验证 `HumanGateMutationData.outcome` 三分支与 `pending_action` 条件、`run.resumed.action` 不接受 reject、非终态 `RunSnapshot` 的账务条件；不得依赖 `x-sse-data-schemas` 才能通过。

Flow 内部节点恢复、计费去重和取消传播的语义由 [Flow IR v1 与运行时契约](../architecture/flow-ir-v1与运行时契约.md) 定义；本文件只定义其 REST/SSE 可见投影。
