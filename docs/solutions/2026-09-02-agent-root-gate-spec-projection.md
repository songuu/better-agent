---
title: "Agent 与 Flow GateSpec 必须绑定精确 source identity"
date: 2026-09-02
tags: [solution, contracts, architecture, security, testing]
related_instincts: []
aliases: ["Agent GateSpec projection", "Flow GateSpec projection"]
---

# Agent 与 Flow GateSpec 必须绑定精确 source identity

## Problem

GateSpec 若只按 ID 查找，无法区分同 closure 不同 source，运行时还可能注入 approver/disposition；若复用 Flow shape，又会给 Agent root 伪造 source path。

## Root Cause

源 GateSpec 与 compiled GateSpec 的字段集合不同，必须显式投影并绑定 closure resource node，而不是透传任意对象。

## Solution

从已验证 Agent executable source 提取全部 gate，绑定 canonical root resource node，逐字段构造 `CompiledGateSpecEntryV1` 并再次 schema parse。Flow 则递归收集 human-gate，并通过独立 path compiler绑定 Flow resource node、完整 graph-aware source path 与 node ID。两类均保留规范化 protected operation set 与可选 notification hash，输出私有、排序、deep-frozen且无 closure hash。

## Prevention

- root gate 明确断言不存在 `source_binding_path`/`source_flow_node_id`。
- Flow gate 同时断言 resource node、opaque source path 与 local node ID。
- 测试用独立排序的 operation hash 期望，不依赖源声明顺序。
- Binding approval coverage 未连接前不称 closed Gate authorization。

## Related

- [[2026-09-02-uniform-direct-slice-graph-composition]]
- [[2026-09-02-private-root-binding-path-compilation]]
- [[session-2026-09-02]]
