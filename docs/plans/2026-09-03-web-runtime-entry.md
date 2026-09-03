---
title: "Better Agent Web 运行时与公网入口"
type: sprint
status: completed
created: "2026-09-03"
updated: "2026-09-03"
tasks_total: 4
tasks_completed: 4
tags: [sprint, web, runtime, deployment]
invariants:
  - "Web 只挂载在规范路径 /better-agent/，未知路径和非只读方法失败关闭"
  - "浏览器资源与 API 同源，不向客户端暴露数据库或服务凭据"
  - "首页入口只有在公网业务路由可用后才登记，禁止发布 404 卡片"
invariant_tests:
  - "pnpm --filter @better-agent/web test"
  - "pnpm workspace:smoke"
deferred:
  - sprint: "Studio vertical slice"
    item: "将 Agent Draft 创建/编辑/发布接入 PostgreSQL 与现有 release-core"
    deadline: "2026-09-05"
    reason: "本 sprint 先建立真实 HTTP/Web 部署边界，禁止用 localStorage 假装服务端持久化"
---

# Better Agent Web 运行时与公网入口

## Phase 1: 需求分析

### 范围

- 增加可启动、可探测、可由 Nginx 反代的 Better Agent Web 运行时。
- 以 `/better-agent/` 为唯一公开基路径，提供应用壳、静态资源和同源健康 API。
- 将 Web 构建物和启动入口接入现有不可变发布包。
- 形成自动化 HTTP、安全头、路由与静态资源回归测试。

### 非范围

- 不用静态样例、浏览器本地存储或虚构接口冒充 Agent Draft/发布/运行闭环。
- 本 sprint 不修改服务器 Nginx，也不提前修改 songuu.top 首页目录；只有业务路由公网验收成功后才登记入口。

### 成功标准

- 本地启动后 `/better-agent/`、CSS、JS、`/better-agent/api/healthz` 可访问。
- 路径逃逸、未知方法、未知 API 和错误基路径均失败关闭；响应具备 CSP 等基础安全头。
- `pnpm check` 覆盖并构建新的 workspace。
- 部署工作流能验证并打包 Web runtime，不再是“仅数据库工具”的发布物。

## Phase 2: 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|---|---|---|
| 发布/运行边界 | 安全执行闭包和权限只能收窄 | Web shell 不绕过现有 API/release-core，不提供虚构写入口 |
| 部署 | accepted main SHA、不可变 release、原子 current | Web dist/public 随同一 attested release 打包 |
| 浏览器安全 | 同源交换、凭据不进入浏览器 | 仅公开非敏感 health metadata，CSP 默认拒绝外部能力 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|---|---|---|---|---|
| Web runtime | 浏览器访问 `/better-agent/` | Nginx → Node HTTP | 不适用（运行时资产） | 是 |
| Health API | 页面启动探测 | 同源 fetch → Node handler | 不适用（进程状态） | 是 |
| Agent Draft | 点击创建 | 尚未接线 | 否 | 否；明确归入下一纵向切片，不展示伪按钮 |

### 入场扫描 - 半完成债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|---|---|---|---|
| G1-A1 | 递归 closure 最终 seal | 保持独立继续，不在 Web runtime 中绕过 | G1-A1 收口前 |
| 完整应用总图 | Studio→发布→会话纵向闭环 | 下一 sprint 接入，本轮只关闭真实传输/部署入口 | 2026-09-05 |

### 设计方向

采用“operational atelier / 运行工作室”视觉：暖白工作区、墨色导航和电蓝状态线，突出资源、发布与运行三个工作面。界面必须是应用导航壳，不做营销落地页或文档站；未接线能力显示为后续阶段状态，不提供会丢数据的交互。

## Phase 3: 任务

- [x] T1 创建 `@better-agent/web` HTTP runtime、规范路由和安全响应。
- [x] T2 创建生产级应用壳及健康状态接线。
- [x] T3 增加 HTTP/静态资产/安全失败路径回归测试。
- [x] T4 接入 workspace、全仓检查和不可变部署构建。

## Phase 4: 审查结果

- 风险等级：L3（新增公网 HTTP 边界并修改部署制品）。
- 安全审查修复：拒绝 absolute-form/network-path 请求目标，限制头大小、头超时、请求超时、keep-alive 与头数量，并对所有响应加入同源资源隔离。
- 架构审查：静态路由使用固定资产表且启动时预载；健康接口仅暴露非敏感构建元数据；未接入的 Studio 写能力不提供伪交互。
- 设计审查：应用壳采用 operational atelier 方向；修正正文最小字号，并将状态文案限定为已有证据，未把 G1-A1 描述为完成。
- 测试审查：Web HTTP 回归 20/20；`pnpm check` 通过 10 个 workspace；架构门禁 31/31。全仓仍只有既有 test-support 9 warnings + 1 info。
- 集成缺口：部署工作流现已打包并校验 Web runtime，但尚未在生产宿主启动进程、配置 Nginx 或通过公网浏览器验收。因此 songuu.top 首页入口仍按 invariant 保持不登记。
- 最终审查：P0/P1/P2 = 0（限本 sprint 的 Web runtime/build 范围）。

## Phase 5: 复利记录

- 新架构规则：公网目录入口必须以真实同源 runtime、公网健康检查和浏览器验收为前置条件。
- 新解决方案：`docs/solutions/2026-09-03-public-web-runtime-before-gateway-entry.md`。
- 下一交付切片：建立受管进程生命周期与 Nginx `/better-agent/` 反代；公网验收成功后再修改独立 gateway 项目。
