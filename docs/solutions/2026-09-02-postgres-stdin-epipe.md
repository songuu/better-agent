---
title: "PostgreSQL harness 早关闭 stdin 导致 CI EPIPE"
date: 2026-09-02
tags: [solution, ci, postgres, node, testing]
related_instincts: []
aliases: ["write EPIPE", "Windows write EOF"]
---

# PostgreSQL harness 早关闭 stdin 导致 CI EPIPE

## Problem

Windows 和 Ubuntu Quality 已通过，但 Linux 架构门禁在 PostgreSQL 阶段以未处理的 `write EPIPE` 退出，遮蔽子进程原始退出码和诊断。

## Root Cause

`child.on('error')` 不处理 `child.stdin` 流的错误。子进程可以在读取完大批输入之前拒绝命令并退出；父进程仍在写入时，Linux 触发 EPIPE，Windows 对应探针触发 EOF。原先 harness 未监听这个流错误。

## Solution

抽出可直接测试的 `runPostgresCommand`，记录 stdin 错误并等待子进程 `close`，保留完整的退出码和已脱敏诊断。非零退出继续遵守原有失败规则；退出零但 stdin 写入失败仍拒绝，即使设置了 `allowFailure`。输出上限、原始敏感值扫描、数据库断言和清理规则保持不变。

五项真实子进程回归覆盖预期拒绝、普通失败、零退出但输入不完整、大输入成功完整消费以及不存在的可执行文件。成功路径发送约 9.5 MiB 多字节输入，核对接收字节数和 SHA-256。

## Verification

- 修复提交：`a1ce87d133dfaa1edf482ab9935604b7e5a2bd5d`。
- 本机：31/31 架构自测通过；三个独立审查视角无剩余问题。完整本地 PostgreSQL 尝试因 Docker Desktop 引擎未启动而未完成，不能算作通过。
- [GitHub CI 33581446892](https://github.com/songuu/better-agent/actions/runs/33581446892)：Windows Quality、Ubuntu Quality、G0-08 架构门禁全部成功。六套真实 PostgreSQL 16 集成测试均输出成功 marker，报告 `result=pass`、`cleanBefore=true`、`cleanAfter=true`。

## Prevention

使用真实子进程和超过管道缓冲区的大输入测试 stream 错误。监听子进程与 stdin 各自的错误通道；不得通过吞掉退出码、跳过 SQL 断言或仅匹配成功日志消除 EPIPE。新增 harness 支持文件变更须同步冻结 hash 与精确自测计数。

## Related

- [[2026-09-01-g008-fail-closed-architecture-gate]] — 准入协议及输出边界
- [[2026-09-01-server-deployment-and-ci-recovery]] — 独立数据库部署范围
