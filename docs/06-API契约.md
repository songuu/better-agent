# API 契约（照抄）

## 1. 公共请求头

| 头 | 说明 |
|---|---|
| `Content-Type` | 固定 `application/json` |
| `Access-Key` | 用于认证的访问密钥（Workspace 级） |
| `Workspace-Id` | 工作空间 ID |

## 2. Agent 会话族

```http
POST /v1/oapi/agent/chat                    # 发送会话消息（聊天）
POST /v1/oapi/agent/conversation            # 创建新会话
GET  /v1/oapi/agent/conversations           # 获取会话列表
GET  /v1/oapi/agent/conversation/messages   # 获取会话历史消息
POST /v1/oapi/agent/push                    # 推送 Assistant 消息
GET  /v1/oapi/info                          # 获取请求相关信息
```

`POST /v1/oapi/agent/chat` body（五字段，全部必填）：

```json
{
  "robot_id": "agent 的唯一标识符",
  "conversation_id": "会话 id",
  "content": "总结书籍内容",
  "inputs": { "bookName": "孙子兵法" },
  "response_mode": "blocking"
}
```

- `inputs` 两种用途：Agent 变量（角色设定中 `{{}}` 引用）、工作流 start 节点表单变量
- `response_mode`：`blocking` 等待完成、长任务可能被中断；`streaming` 基于 SSE 流式返回；默认 `blocking`

## 3. 响应结构（照抄）

顶层：

```json
{
  "code": 200,
  "success": true,
  "message": "",
  "data": {
    "status": "SUCCEEDED",
    "duration_time": 3.2,
    "message": "",
    "tasks": [],
    "timestamp": 1700000000
  },
  "now_time": 1700000000
}
```

`data.status`：`FAILED` | `SUCCEEDED`。`duration_time` 单位秒。

task 对象：

| 字段 | 取值 |
|---|---|
| `name` | `llm_response` \| 技能/知识库/插件名 \| `related_questions` |
| `type` | `TEXT` \| `FUNCTION` \| `RELATED_QUESTIONS` |
| `tool_type` | `dataset` \| `flow` \| `plugin` \| `system` |
| `tool_id` | 资源 ID |
| `status` | `STARTED` \| `SUCCEEDED` \| `FAILED` |
| `content` | object \| string，含 `input` / `output` |
| `duration_time` | 秒 |
| `metadata` | icon、color、property 描述符 |
| `upgrade_consume` | 完成的 FUNCTION 事件携带 |

## 4. SSE 流式

`response_mode: "streaming"`。每行 `data: ` + 单个 task JSON。

- `llm_response` 逐 token 推送，每事件 `content` 一个字符
- FUNCTION 类先发 `STARTED`，再发 `SUCCEEDED`（带 `content.input` / `content.output`）
- `related_questions` 收尾，`content.related_questions` 为建议追问数组

## 5. 工作流

```http
POST /v1/oapi/flow/run                       # body: { inputs: {...} }
POST /v1/webhook/flow/{flowId}?api_key=YOUR_API_KEY
```

Webhook 场景：钉钉一类平台配置第三方 URL 时通常无法自定义参数和请求头，因此验证信息直接写进 URL。

## 6. MCP 服务（三种接入）

| 方式 | 鉴权位置 |
|---|---|
| SSE 添加 | URL 末尾拼 `YOUR_API_KEY` 占位符 |
| 可流式传输的 HTTP | 请求头 `access_key`，替换 `YOUR_API_KEY` |
| 配置文件 | 平台给出 JSON，替换 URL 中的 `YOUR_API_KEY` |

可暴露资源：工作流 · 插件（含自定义）· 三类知识库（文档/问答/多模态）。

## 7. 权限 SPI（企业侧实现）

```http
POST {企业提供地址}?action=external_user_auth
Headers: Workspace-Id, Access-Key, Content-Type
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

- `allow` 不填 = 不做任何权限限制
- 「测试连接」按钮发空数组请求，接口必须容忍
- 身份未设置或设置不全 → 权限管控不生效（fail-open，复刻时由 `strict_permission_mode` 控制）
- 建议企业侧设置超时处理机制

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

`init` 参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `root` | 是 | DOM ID，init 时该节点必须已存在（Vue 放 `onMounted`） |
| `agentId` / `accessKey` / `workspaceId` | 是 | Agent ID / 鉴权标识 / 工作空间 ID |
| `user.id` | 是 | 使用者唯一身份标识 |
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

`CopyPayload.type`：`text` | `html` | `image` | `video` | `table`。`ChatError.code = 60001` → 套餐余额不足或空间过期。



