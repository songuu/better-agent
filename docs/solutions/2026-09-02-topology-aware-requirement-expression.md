---
title: "组合能力需求必须保留执行拓扑"
date: 2026-09-02
tags: [solution, contracts, policy, security, canonicalization]
related_instincts: []
aliases: ["CapabilityRequirementExpressionV1", "组合能力最小需求表达式"]
---

# 组合能力需求必须保留执行拓扑

## Problem

`CapabilityRequirementsV1` 表达的是同时成立的扁平需求。直接合并 Skill Pack 可选路由、Flow 顺序/并行节点或嵌套调用，会把 `any_of` 误写成全需满足，或丢失调用次数、深度与预算的组合依据。

## Root Cause

载体已类型化，但类型只有 leaf 的合取语义，没有描述控制拓扑。仅复制子节点最小值也会漏算父调用自身消耗。

## Solution

- 引入闭合递归语法：`leaf`、`sequence`、`parallel`、`alternative`、`repeat`、`nested_call`；nested call 另带已验证 invocation requirements。
- 每个 leaf 继续使用完整 `CapabilityRequirementsV1`；每节点最多 128 个子项，整树最多 1,024 节点、32 层。
- `sequence` 保留业务顺序；`parallel` 与 `alternative` 按 canonical JSON 排序并拒绝重复分支。
- closure 校验逐节点重算规范表达式；即使攻击者同步重算 closure hash，非规范分支顺序仍失败关闭。
- 为递归表达式使用独立的预解析快照深度预算，避免公共 32 层契约被旧 flat-policy 的 12 层预算误拒绝。

## Prevention

数值组合使用 [[2026-09-02-capability-requirement-limit-envelope]]；root/composite Binding entry 必须调用该编译器，不能复制 child minima。测试必须同时覆盖顺序敏感、无序置换稳定、重复拒绝，以及 32/33 层边界。

## Related

- [[2026-09-02-typed-resource-node-intrinsic-policy]]
- [[2026-09-02-nested-policy-evidence-propagation]]
- [[session-2026-09-02]]
