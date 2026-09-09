---
title: "Better Agent 完整应用交付总图"
date: 2026-09-02
status: active
tags: [plan, product, agent, frontend, backend, deployment]
---

# Better Agent 完整应用交付总图

## 目标与边界

`ai.betteryeah.com` 是产品形态参考：本项目要交付可登录、可创建、可编排、可调试、可发布、可运行和可运维的完整 Agent 平台。`E:/project/ai/agent` 只参考服务器部署拓扑，不是产品功能或 UI 来源。参考产品的代码、商标和受保护素材不复制；实现使用本项目独立契约、视觉系统和运行时。

当前 G1-A1 capability closure 只是安全执行内核。即使内核全部通过，也不能宣称 Studio、聊天端或 `songuu.top` 已交付。

## 参考产品功能面

公开产品资料确认的能力面：Agent 零代码搭建与角色/变量/技能/任务；多模型；文档、问答和多模态知识库；持久数据库；可视化 Flow 与代码/API/逻辑/插件节点；官方与自定义插件；MCP 服务；子 Agent；异步和定时任务；应用模板；会话与多模态 Chat；API/SDK/Webhook 及企业渠道发布；版本、权限、监控和评测。

来源：

- https://ai-docs.betteryeah.com/
- https://www.betteryeah.com/
- https://www.betteryeah.com/agentstore

## 可验收产品切片

1. **平台壳与身份**：登录、Workspace 切换、主导航、资源列表、审计入口。
2. **Agent Studio**：Draft/Release、角色与模型、变量、技能与子 Agent、开场白、推荐问题、预览、版本发布。
3. **Flow Studio**：画布、节点配置、变量映射、调试日志、版本与多环境发布。
4. **资源中心**：知识库摄取/切分/检索测试，Database Operation，Plugin，自定义 API，Skill Pack 与 MCP。
5. **运行应用**：会话、消息流、附件、多模态、工具过程、HumanGate、取消/重试、任务与历史。
6. **发布集成**：Web 应用、API key/SDK/Webhook、Deployment、权限映射、版本回滚。
7. **运营治理**：Run/Step 日志、成本、用量、评测、告警、成员/角色/凭据、安全审计。
8. **独立部署**：PostgreSQL、对象存储、队列/worker、Web/API、TLS、备份恢复、升级回滚；最终以 `songuu.top` 真实浏览器端到端验收。

## 交付顺序

现阶段先关闭 G1-A1 closure/policy/admission，随后以“Agent Studio 创建 → 发布 → Web 会话运行 → Run 日志可查”作为首个纵向闭环；再扩展 Flow、知识库、插件/MCP、任务与运营治理。每个切片必须同时具有 UI、API、持久化、权限、失败路径和浏览器 E2E，禁止只交付静态页面或只有后端接口。

## 完成判据

- 新 Workspace 能从空状态创建 Agent，配置至少模型、提示词和一个能力，发布后在 Web 会话真实运行。
- Agent 可组合 Flow、Knowledge、Database Operation、Plugin/MCP、Skill Pack 和 SubAgent，且权限只能收窄。
- Draft、不可变版本、Deployment、会话、任务、Run/Step、用量和审计在重启后保持一致。
- 用户可在 UI 完成创建、调试、发布、撤销、回滚和问题定位，关键失败有明确恢复路径。
- CI、真实 PostgreSQL、浏览器 E2E、部署重启/回滚和 host-attested Acceptance 全部基于同一提交通过。
- `https://songuu.top/` 及其业务路由、API、静态资源、登录态和刷新均可从公网完整访问。

## 当前事实

截至 2026-09-08，独立 Web/Studio、同源认证 API、Agent Draft/不可变 Product Release、PostgreSQL 持久化和首页路由已部署到 `songuu.top`。迁移 021 补齐 Release 绑定的 Conversation、顺序 Run、模型 Responses 适配器、失败终态、token 用量和 Run Console。迁移 022 继续交付 Flow Studio 首个纵向闭环：Input/Template/Output 有向无环图、变量映射、调试日志、Draft revision CAS、不可变 Release 以及 development/staging/production 环境发布；UI、API、PostgreSQL RLS/ACL 和一次性 PostgreSQL 16 集成验证绑定在同一架构门禁中。迁移 023～028 已继续交付 Knowledge Center、发布评测、Agent 知识/数据库绑定、Database Studio 以及角色设定的文本/结构化双模式和不可变发布快照；角色编辑器另提供同源 AI 生成/优化、按已绑定能力优化、最终指令透视图和无损全屏编辑。生产模型执行与 AI 角色助手仍须由独立 `BETTER_AGENT_MODEL_API_KEY` Secret 激活，禁止借用相邻项目凭据或用模拟响应冒充生产模型完成。

迁移 029～034 已实现 Agent Strategy 的版本化 Draft/Release 快照、说明书驱动的模型路由、强制能力、参数抽取、Token/工具调用上限、闭合参数默认值，以及 Strategy v3/v4/v5 的 1～4 次有界执行。v4 允许模型在每轮从不可变 Release 已绑定的 Knowledge/Database 能力与最终回答中做闭合选择；v5 增加一层有界 SubAgent 委派，父 Release 固定精确子 Agent Release，子模型输出以非指令证据回灌，子模型 token 和 provider 证据纳入父 Run 的 PostgreSQL 复核与留存。递归 SubAgent、并行/异步委派仍未完成。

Flow Studio 已在既有 Draft/Release/Deployment/调试闭环上增加首个可执行条件逻辑节点：支持闭合的 equals/contains/starts_with/ends_with 运算符、连接上游值校验、真假结果模板和持久化四步调试证据，并保持旧三节点 Flow 兼容。迁移 035 进一步交付最多 200 个不可变历史版本、环境部署指针 CAS 回滚、最多 100 条不可变回滚收据，以及对应 UI/API/RLS/ACL/PostgreSQL 16 验收。迁移 036 已交付 Agent Draft 选择已发布 Flow、Agent 发布时固定精确 Flow Release、Conversation Run 只读取该不可变版本并将确定性执行输出注入模型上下文；Draft 绑定、Release 证据分别采用 owner-only FORCE RLS 与不可变触发器。Flow 运行时已进一步加入受控代码变换节点，以 trim/uppercase/lowercase 闭合操作白名单替代任意脚本执行；同时加入版本化内置插件节点 `builtin.text.v1`，通过冻结执行器注册表支持 Unicode 码点数和空白分隔词数统计，未知插件/操作和未连接输入均失败关闭；两类节点均贯通 UI、校验、调试和不可变发布。迁移 037 新增不可变插件目录与 Workspace 级精确版本安装，Flow 保存、调试和发布均拒绝未安装插件，并由同源 API、Plugin Center UI、owner-only FORCE RLS/ACL 和 PostgreSQL 16 集成套件形成纵向闭环。迁移 038 已交付 Workspace 级版本化 Custom HTTPS API 资源、GET/POST Flow 节点和调试/发布/Agent Run 同快照执行；运行时强制 HTTPS 443、公共 DNS/IP、TLS SNI、重定向重验证、超时、响应体上限、2xx 与标量响应路径，Draft/Release 绑定精确 API revision，资源头与不可变历史版本由 owner-only FORCE RLS/ACL 保护。迁移 039 已交付 Workspace 级版本化 Skill Pack：Agent Draft 绑定精确版本，发布时生成不可变快照，Run 只读取该快照并以受平台和 Agent 指令约束的指令段注入模型；资源管理、CAS 更新、UI/API、owner-only FORCE RLS/ACL 和 PostgreSQL 16 集成验证形成同一纵向闭环。迁移 040 已交付 Workspace 级版本化 MCP Streamable HTTP 服务：Agent Draft/Release 固定精确 Endpoint 与工具版本，Run 按 MCP 初始化协议调用该工具，并把有界文本结果作为非指令证据注入模型；公网 HTTPS/DNS/IP/TLS、超时、响应上限、协议版本、UI/API、RLS/ACL 和真实 PostgreSQL 16 验证形成闭环。迁移 041 已交付 Workspace 级自定义 HTTPS Plugin：资源 CAS 更新生成不可变 Release，自动安装最新精确版本，Flow 保存/调试/发布逐字段核验执行快照，运行复用 SSRF 防护的 HTTPS 执行器，并贯通 Plugin Center、产品 API、owner-only FORCE RLS/ACL 与 PostgreSQL 16 门禁。迁移 042 已为 Database Studio 补齐受控行更新与删除：基础记录继续不可变，修改通过逐行 CAS 追加版本或墓碑，UI/API 返回可审计收据，查询与行数只投影当前有效版本；Agent Release 同时固定精确行版本，源表后续变化不会让历史 Conversation 漂移。迁移 043 已补齐 Database Operation 完整纵向闭环：用户可在 Database Studio 声明返回列、过滤列、排序方向和 1～100 行上限，CAS 更新生成不可变 Release；同源 API 只执行固定策略而不接受任意 SQL，Flow 节点与 Agent Draft 均绑定精确 Operation revision，Agent 发布还固定当时的精确行版本。该能力已由 UI、Web/API 测试、owner-only FORCE RLS/ACL、回滚保护和真实 PostgreSQL 16 集成套件共同约束。其他尚未完成的产品面包括递归或异步 SubAgent 编排、异步任务、Deployment/API/Webhook、成员权限以及完整运营治理。现有 G1 内核和门禁是这些能力的安全基础，不能替代最终产品验收。
