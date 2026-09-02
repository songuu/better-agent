---
title: "Flow 节点身份必须包含图命名空间"
date: 2026-09-02
tags: [solution, contracts, architecture, testing]
related_instincts: []
aliases: ["Flow node graph namespace identity", "递归 Flow 路径身份"]
---

# Flow 节点身份必须包含图命名空间

## Problem

递归 Flow 的不同分支图可以复用同一个 `node_id`。只编码 owner 与 node ID 会让两个真实不同的节点得到同一路径，且合法的 4,096 节点源可能在路径注册阶段意外耗尽预算。

## Root Cause

旧路径把图内局部 ID 当成闭包全局 ID，并独立设计 source 与 identity registry 上限。测试只覆盖浅层路径和小型输入，没有检验命名空间分离、完整祖先链和 producer→consumer 的精确最大边界。

## Solution

`flow_node` `/1` 段按 owner、完整 pin、`graph_id`、`node_id` 的顺序编码。Flow 文档固定 entry graph ID 为 `root`，并在 case、else、loop body 全递归范围拒绝重复 graph ID。私有编译器只接受 raw source，先执行规范化验证，再递归派生包含全部祖先节点段的不可变路径；注册表允许 8,192 条目但仍受 16 MiB retained-byte 上限约束。

Direct Agent→Flow 编译还会独立重算双方 source pin，要求 root `flow` Binding 的完整 target pin 精确命中依赖，并以一个 registry 登记 root、dependency、完整 root Binding namespace 和匹配 Binding 下的全部 Flow nodes。未命中的兄弟 Binding 保留但没有该依赖的 node expansion；同一 Flow 被两个 Binding 引用时产生两个隔离前缀。

该 `/1` 调整只发生在 publisher、持久化表与公共导出出现之前，并在架构文档中记录基线重置证据。身份一旦持久化，后续语义变化必须发布新版本。

## Prevention

- 对任何局部 ID 明确写出唯一性作用域，并把该作用域放进 canonical preimage。
- 用 sibling 同 ID、全局 graph ID 重复、深层完整祖先链三类 mutation 回归保护身份语义。
- 用同一个 exact-max fixture 贯穿 source admission 与下游 registry，而不是分别验证预算。
- 选择性展开的测试必须证明完整 root namespace 仍被登记，不能只观察匹配后的子树。

## Related

- [[2026-09-02-private-root-binding-path-compilation]]
- [[session-2026-09-02]]
