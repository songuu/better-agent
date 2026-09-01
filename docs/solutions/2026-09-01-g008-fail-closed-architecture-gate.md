---
title: "G0-08 fail-closed 可执行架构门"
date: 2026-09-01
tags: [solution, architecture-gate, ci, postgres, security]
related_instincts: []
aliases: ["可执行架构门", "dirty worktree clean-checkout gate"]
---

# G0-08 fail-closed 可执行架构门

## Problem

共享 dirty worktree、真实 PostgreSQL 16、跨平台 CI 与 host acceptance 属于不同信任边界；只串联退出码、文本正则或局部清理会制造假绿色证据。

## Root Cause

开放式校验只能证明“某个必需项存在”，不能证明额外 action、条件、shell、checkout ref、环境注入或残留数据库项目不存在。机器输出又存在双向风险：原始字节精确匹配会被 ANSI/空白造成假阴性，全文子串匹配则会被嵌入前缀或数字前缀造成假阳性。Windows `cmd.exe`、Git 链接身份和 Docker Compose 生命周期还会引入平台特有的解释与清理风险。

## Solution

- 用冻结 manifest 双向核对脚本、迁移、六套 PG runner/support hash、workspace tests 与语义 marker。
- dirty source 只读生成有预算的 content manifest，在 disposable checkout 中执行；前后字节级核对 HEAD/index/status 与 clean 状态。
- 将 runtime、snapshot、PostgreSQL registry/cleanup 拆成独立模块；输出、超时、process tree 与失败聚合全部有界。
- CI 先解析 YAML，拒绝重复键和 anchor/alias，再与完整冻结 schema 深度相等；checkout、action、runner、trigger、permissions 与 run 顺序都采用闭集。
- Windows pnpm 参数在进入 `cmd.exe` 前拒绝命令元字符；PG 项目名和 registry 只接受 gate 自己生成的精确格式。
- 语义 marker 先去 ANSI CSI，按 CRLF/LF/CR/VT/FF/NEL/LS/PS 完整分行，行内只折叠空格和 Tab，然后做完整行匹配；六个 PostgreSQL runner 在全部断言后分别输出唯一的 `architecture-gate-suite/1 <suite-id> pass`，人类描述日志不再承担准入协议。skip/todo 只解析闭集摘要格式。

## Prevention

任何准入门都应同时测试缺失、重复、重排、额外项、解释器注入、cleanup 首次失败和 timeout；输出 marker 还必须成对验证合法 ANSI/横向空白与非法跨行、嵌入、相邻数字反例。新增 CI 步骤或 gate suite 必须显式更新冻结 schema/manifest 与 mutation 回归，不能依赖开放式“包含”检查。

## Related

- [[2026-08-31-g0-08-executable-architecture-gate]] — Sprint 事实源
- [[session-2026-09-01]] — 最终加固与复审会话
