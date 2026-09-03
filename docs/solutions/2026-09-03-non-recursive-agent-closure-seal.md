---
title: "仅为证据完整的非递归 Agent 生成 closure seal"
date: 2026-09-03
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["Non-recursive Agent closure seal"]
---

# 仅为证据完整的非递归 Agent 生成 closure seal

## Problem

根 Binding、叶子资源策略和资源图已经可以独立验证，但它们仍是无 hash 的中间件。直接扩大到嵌套 Agent/Flow 会遇到一个权限边界：子 closure 保存的是在子级 ceiling 下解析后的权限，缺少在父级重新求解所需的完整原始 descendant demand。

## Root Cause

`effective_policy` 不是资源固有需求。把子级已解析权限复制到父级会丢失原始 requirement topology，既无法证明父 ceiling 覆盖全部需求，也可能让子能力借用父级上下文扩大权限。另一方面，已验证的直连 leaf 与 leaf-only Pack 已经具备完整的 source、entry、policy、node、edge 与 disabled-path 证据，不需要继续停留在伪 closure 中间态。

## Solution

- 新增 package-private `prepareNonRecursiveAgentCapabilityClosure`，重新准备 Agent source，并把 source root 与 entry-set/gate root 做完整 canonical byte equality。
- 从同一精确 pinned graph 重建 resource nodes 和 provenance edges；任何 Agent/Flow dependency 立即失败关闭。
- 将根 entries 与已验证的 Pack descendant entries 按 canonical Binding path 合并，保留禁用路径、根 GateSpec、source dependency manifest pins 和重新求解的 aggregate limits。
- 计算排除 `closure_hash` 本身的完整 canonical hash，再调用 `prepareCompiledCapabilityClosure` 进行 lossless schema、identity、ordering、limit-envelope 与 hash round-trip 验证。
- 不 barrel-export，不连接 publisher/registry，也不声称递归 closure 或生产准入已完成。

## Prevention

封口函数必须同时证明“输入属于当前 source”和“支持集合闭合”。遇到尚未保留原始需求的递归边界，宁可拒绝整个 seal，也不能从已解析权限反推需求。

## Verification

- 直连 leaf、禁用 leaf、跨 source graph/entry-set、leaf-only Pack 双挂载与 descendant provenance 均有回归。
- 聚焦 changed suites：**43/43**。
- release-core：**981/981**（36 files）。
- 架构变异测试：**31/31**。

## Related

- [[2026-09-03-skill-pack-resource-node-provenance]]
- [[2026-09-02-agent-direct-resource-graph-assembly]]
- [[session-2026-09-03]]
