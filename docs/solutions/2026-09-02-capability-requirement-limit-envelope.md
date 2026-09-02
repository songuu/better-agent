---
title: "组合能力需求必须编译为可验证的数值包络"
date: 2026-09-02
tags: [solution, release-core, policy, security, testing]
related_instincts: []
aliases: ["CapabilityRequirementLimitEnvelope", "组合需求数值包络"]
---

# 组合能力需求必须编译为可验证的数值包络

## Problem

保留执行拓扑仍不足以阻止权限低估：如果 closure 的 flat aggregate limits 直接复制某个 child minima，攻击者可以同时重算 closure hash，却仍让实际执行需要的调用、并发或预算超过声明值。

## Root Cause

不同拓扑不能使用同一种合并方式。顺序执行与并行执行的 duration/parallelism 规则相反，alternative 需要覆盖任一分支，repeat 只放大消耗轴，nested call 还必须计入父调用自身成本和额外栈深。

## Solution

- `sequence` 累加 calls 与全部预算，depth/parallelism 取最大值；`parallel` 累加 calls、credits、tokens 与 parallelism，duration/depth 取最大值。
- `alternative` 逐轴取最大值，并维持 `total_tokens >= input_tokens + output_tokens`；规范化表达式仍是分支相关性的权威证据。
- `repeat(n)` 放大 calls、credits、tokens 和 duration，不放大 depth/parallelism。
- `nested_call` 强制显式提供至少一次 call 和一个 execution slot 的 invocation requirements；它与 child 顺序相加，depth 为 `max(invocation.depth, child.depth + 1)`。
- 普通数值用 bigint 中间算术检查 JavaScript safe-integer 上限，credits 检查 PostgreSQL bigint 上限，任何溢出都失败关闭。
- closure 接受前重算 root expression 包络，并逐轴证明不超过 aggregate limits；自洽 hash 不能绕过该检查。

## Prevention

每个资源轴都必须有“刚好可用”和“少 1 拒绝”回归；加法、乘法和 credits 分别覆盖溢出。未来 composite Binding entry 只能调用同一包络编译器，不得复制 child minima 或另写一套公式。

## Related

- [[2026-09-02-topology-aware-requirement-expression]]
- [[2026-09-02-nested-policy-evidence-propagation]]
- [[2026-09-02-compiled-capability-closure-v1]]
