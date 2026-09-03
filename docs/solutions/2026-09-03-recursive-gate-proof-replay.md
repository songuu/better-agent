---
title: "递归 GateSpec 完整性必须在最终边界重放证明"
date: 2026-09-03
tags: [solution, release-core, capability, recursion, security, testing]
related_instincts: []
aliases: ["Recursive GateSpec proof replay", "递归审批 Gate 防借权"]
---

# 递归 GateSpec 完整性必须在最终边界重放证明

## Problem

父 Agent 虽然可以在 composite 编译阶段正确投影 child GateSpec，但最终 closure assembler 接收的是未知输入。若中间 entry set 只保留汇总后的 Gate 数组，调用者可删除未被 Binding 直接引用的 input Gate，再生成一个表面自洽但证据不完整的 closure。

## Root Cause

结构校验和自洽哈希只能证明“现有内容合法”，不能证明集合完整。Flow Gate 还同时受 source resource、terminal Flow node 与 parent mount scope 约束；只匹配路径中的任意祖先 owner 会允许跨 child 或跨挂载借权。

## Solution

- root entry set 保留按 graph node 排序且唯一的 `nested_gate_closures`，将 child closure hash、source node 与完整 child closure 一起带到最终边界。
- final assembler 从已验证资源图恢复每个直接 internal Agent/Flow 依赖，依据真实 parent Binding mount 重新执行 Gate 投影，并与 `descendant_gate_specs` 做 canonical exact comparison。
- Flow Gate 的 `source_node_id` 必须对应 path 最后一个 `flow_node` segment 的 owner，而不是任意祖先 Flow。
- approval join 按 source node、Gate ID/hash 与 mount scope 建索引，并要求完整覆盖 Binding 的 operation contract hashes。
- 在展开前对 mount×Gate 笛卡尔积执行 8,192 上限，避免先分配后拒绝。

## Prevention

任何从可信编译器产出流入 `unknown` 最终入口的授权目录，都必须携带可从更强承诺重放的完整性证据。不要用可由同一调用者同步改写的摘要 hash 代替 child closure、资源图和 mount identity 的重新连接。

## Verification

- focused Gate/Agent/Flow/root：**104/104**。
- domain-contracts：**165/165**；release-core：**1008/1008**。
- repository `pnpm check`：通过；架构 mutation gate：**37/37**。
- 三路复审收敛到 P0/P1/P2 = 0。

## Related

- [[2026-09-03-parent-relative-descendant-policy-recompilation]]
- [[2026-09-02-agent-root-gate-spec-projection]]
- [[session-2026-09-03]]
