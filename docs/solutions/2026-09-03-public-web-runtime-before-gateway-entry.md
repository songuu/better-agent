---
title: "公网目录入口必须晚于真实 Web Runtime"
date: "2026-09-03"
tags: [solution, web, deployment, nginx, security]
related:
  - "[[2026-09-03-web-runtime-entry]]"
  - "[[2026-09-01-g008-fail-closed-architecture-gate]]"
---

# 公网目录入口必须晚于真实 Web Runtime

## 问题

首页卡片容易被误当作“应用已经部署”。如果业务路径仍返回 404，提前登记入口只会制造一个可见但不可用的发布状态；静态页面若再伪造保存或发布交互，会进一步掩盖服务端闭环缺失。

## 方案

先建立独立的 `@better-agent/web` 运行时，以 `/better-agent/` 为唯一基路径，提供固定静态资产映射与同源健康接口。未知路径、未知方法、编码边界和非 origin-form 请求均失败关闭；所有响应携带 CSP、浏览器隔离与禁止缓存头。部署包必须验证 server、HTML、CSS、JS 均存在。

公网发布按固定顺序执行：启动受管进程 → 配置 Nginx 同源反代 → 验证 loopback health → 验证公网 health 与页面资源 → 浏览器验收 → 最后在独立 gateway 项目登记卡片。任一步失败都不发布入口。

## 验证

- Web HTTP 回归：22/22；部署资产回归：26/26。
- G0-08 架构门禁：37/37，mutation、quality、PostgreSQL 16 均通过并保持 clean-before/clean-after。
- GitHub `main` CI 与生产部署工作流均成功；systemd active/enabled，独立 PostgreSQL running/healthy。
- 公网 `/better-agent/`、health、CSS、JS 均为 200，health 精确返回 accepted build SHA。
- `songuu.top` gateway 显示 07 routes，Better Agent 卡片与无脚本入口均指向 `/better-agent/`，浏览器点击验收通过。

## 部署踩坑与预防

- 通过 release 软链启动时，入口文件判断必须比较 `realpath`，否则服务会加载模块后立即退出。
- Nginx graceful reload 期间旧 worker 可能短暂返回旧路由 404；TLS 验收应在有界次数内重试，并且每次同时校验 health 状态与 accepted build SHA。
- 工作流页面 marker 必须取自实际发布 HTML，并由测试双向绑定；禁止依赖已经删除的展示文案。
- gateway 发布采用上传哈希校验、旧首页备份、原子安装和本机 HTTPS 验收，失败自动恢复备份。
