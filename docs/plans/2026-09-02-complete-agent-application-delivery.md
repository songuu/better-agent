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

截至 2026-09-05，独立 Web/Studio、同源认证 API、Agent Draft/不可变 Product Release、PostgreSQL 持久化和首页路由已部署到 `songuu.top`。迁移 021 继续补齐 Release 绑定的 Conversation、顺序 Run、模型 Responses 适配器、失败终态、token 用量和 Run Console；本地真实 PostgreSQL 与浏览器纵向链已通过。生产模型执行仍须由独立 `BETTER_AGENT_MODEL_API_KEY` Secret 激活，禁止借用相邻项目凭据或用模拟响应冒充生产模型完成。

尚未完成的产品面包括 Flow Studio、知识摄取与检索、Plugin/MCP/Skill Pack/SubAgent 编排、异步任务、Deployment/API/Webhook、成员权限以及完整运营治理。现有 G1 内核和门禁是这些能力的安全基础，不能替代最终产品验收。
