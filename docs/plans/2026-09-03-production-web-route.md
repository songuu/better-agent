---
title: "Better Agent 生产 Web 路由"
type: sprint
status: in-progress
created: "2026-09-03"
updated: "2026-09-03"
tasks_total: 5
tasks_completed: 4
tags: [sprint, deployment, systemd, nginx, production]
invariants:
  - "Better Agent 使用独立 loopback 端口、systemd unit、release symlink 与 Nginx snippet"
  - "Nginx 修改前后均执行语法检查，失败时恢复原配置和原 Web release"
  - "先通过 loopback 与公网 health/asset 验收，最后才向独立首页登记入口"
invariant_tests:
  - "node --test tests/deployment/*.test.mjs"
  - "pnpm --filter @better-agent/test-support test"
---

# Better Agent 生产 Web 路由

## Phase 1: 需求分析

### 目标

- 在已确认的 songuu.top 宿主上以专用低权限 systemd 服务运行 `@better-agent/web`。
- 通过独立 Nginx location snippet 暴露 `/better-agent/`，不侵入其他应用的路由实现。
- 将安装、回滚、健康检查纳入受保护的 GitHub Actions immutable-release 部署。
- 公网验证成功后，才修改独立 `agent` 项目的首页卡片。

### 非范围

- 不复用其他应用进程、数据库、密钥或前端状态。
- 不修改既有 `/agent-build/`、`/aicrew/`、`/pipeline/` 等 location。
- 本 sprint 不把静态应用壳描述为完整 Agent 业务闭环。

## Phase 2: 技术方案

采用 `/opt/better-agent/web-current` 独立原子软链和 `better-agent-web.service`。部署脚本先验证 accepted release，再切换 Web 软链并启动 127.0.0.1:4310；随后安装 `/etc/nginx/snippets/better-agent.location.conf`，只在唯一锚点后插入 include，执行 `nginx -t`、reload、loopback TLS health。失败 trap 恢复原软链、环境文件、unit、snippet 与主配置。

## Phase 3: 任务

- [x] T1 增加 hardened systemd unit 与独立 Nginx snippet。
- [x] T2 增加幂等、可回滚的生产 Web 安装脚本。
- [x] T3 增加部署资产与失败关闭约束测试。
- [x] T4 接入受保护工作流并更新部署文档/冻结门禁。
- [ ] T5 上传 accepted main、验证 Actions、宿主与公网，再登记首页入口。

## Phase 4: 审查结果

待实施后填写。

## Phase 5: 复利记录

待实施后填写。
