---
title: "递归 Binding 必须在父命名空间重新编译权限"
date: 2026-09-03
tags: [solution, release-core, capability, recursion, security, testing]
related_instincts: []
aliases: ["Parent-relative descendant policy recompilation"]
---

# 递归 Binding 必须在父命名空间重新编译权限

## Problem

已验证的 child Agent/Flow closure 不能直接复制到父 Agent：路径仍属于 child root，effective policy 已被 child ceiling 收窄，disabled ancestor 与 Pack route 也可能丢失语义。

## Root Cause

递归组合同时改变 namespace 与 authority boundary。只投影 operations 会丢失完整 Binding；只复制 effective policy 会把原始需求与父 mount ceiling 混为一层；只检查 disabled path 精确相等会遗漏被禁用祖先的后代。

## Solution

- 将每条 child Binding path 投影到每个精确 parent mount 下，并在分配前限制笛卡尔积不超过 8,192。
- 用保留的 `requirement_expression` 在 Workspace、root、parent mount 与 child effective ceiling 的交集下重新解析 policy。
- disabled ancestor 向下传播；不可用策略清空 principal、credential、egress 和全部数值预算，但保留 operation identity 与 Binding 级 approval Gate。
- Pack route 的 pack/member path 随 namespace 一起投影，并基于完整 versioned preimage 重算 `route_hash`。
- root assembler 重新验证 canonical digest、parent strict prefix、Agent/Flow typed boundary、parent target 与 dependency pin，以及 disabled list/zero-authority policy 的双向一致性。

## Prevention

任何递归 artifact 都应把路径投影、权限重编译、禁用闭包和内嵌路径哈希视为一个原子步骤。消费未知中间产物时，不能只依赖 schema shape；必须重新证明 namespace ownership 和依赖身份。

## Verification

- Agent/Flow/root-entry 专项：**67/67**。
- release-core：**995/995**（36 files）。
- repository `pnpm check`：通过；架构变异测试：**37/37**。
- 独立 L4 复审：P0/P1/P2 = 0。

## Related

- [[2026-09-03-binding-requirement-topology-retention]]
- [[2026-09-03-non-recursive-agent-closure-seal]]
- [[session-2026-09-03]]
