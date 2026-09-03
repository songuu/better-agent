---
title: "Agent 根需求必须从原始表达式重新求解聚合权限"
date: 2026-09-02
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["Agent root demand policy", "root aggregate capability policy"]
---

# Agent 根需求必须从原始表达式重新求解聚合权限

## Problem

根 Binding entry 已经各自带有有效权限，但直接合并这些结果会丢失分支相关性，也可能把路径 ceiling 的局部结论误当成根级权限来源。

## Root Cause

`effective_policy` 是需求与 ceiling 求解后的结果，不再包含完整原始需求。多个挂载还可能指向同一个目标；按路径累加会重复计算，而按策略取并集会扩大授权。

## Solution

保留 path-keyed 表达式作为路由证据，再按 canonical bytes 去重，并把可选择的根能力折叠为 `alternative`。用该表达式编译保守需求包络，再与 Workspace/root ceiling 的 meet 重新求解唯一 aggregate policy。全禁用根使用零调用、零预算、`none` 主体的规范叶子，因此策略必须显式允许无主体执行。

## Prevention

- 根需求只能来自 source-derived intrinsic expressions，不能从 entry effective policy 反推。
- 重复挂载保留多条路径，但相同需求只出现一次。
- aggregate policy 必须重新经过 ceiling meet 与完整需求验证。
- policy 的 Binding path 集合必须与源根路径完全一致。
- 中间产物不生成 `closure_hash`，resource nodes、edges 与 provenance 未闭合前不授予发布权威。

## Related

- [[2026-09-02-agent-root-binding-entry-set]]
- [[2026-09-02-capability-requirement-limit-envelope]]
- [[2026-09-02-composite-binding-requirement-envelope]]
