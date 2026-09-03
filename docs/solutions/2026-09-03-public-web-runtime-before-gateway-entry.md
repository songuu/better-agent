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

- Web HTTP 回归：20/20。
- 全仓 `pnpm check`：通过 10 个 workspace。
- 架构门禁：31/31。
- 当前边界：仅完成可部署 runtime 与发布包接线，尚未声明生产路由或首页入口完成。
