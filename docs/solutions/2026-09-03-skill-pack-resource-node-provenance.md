---
title: "Skill Pack 资源节点必须保留完整成员证据"
date: 2026-09-03
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["Skill Pack resource node provenance"]
---

# Skill Pack 资源节点必须保留完整成员证据

## Problem

仅有 Agent→Pack 根 entry 和 Pack→leaf 图边不足以生成可信 closure：Pack 节点缺少自身固有需求，成员 Binding、禁用状态和每次挂载的来源路径也可能在聚合时丢失。

## Root Cause

资源图与 Binding 入口是两种不同证据。只保存派生边会丢失成员的 operation/effective-policy；只聚合当前可用路由会把禁用或未暴露成员错误地从资源事实中删除；对混合 Pack 补空策略则会掩盖尚未验证的递归能力。

## Solution

- 对所有成员都有 leaf source 证据时，将唯一成员 intrinsic expression 规范折叠为 Pack 的 alternative；启用状态不改变资源固有需求。
- Pack 含 Flow、内部 Agent 或嵌套 Pack 时不生成 Pack policy，等待对应 composite evidence 后再闭合。
- 根 entry-set 保留经过验证的 `descendant_binding_entries`，并把 Pack/member 禁用路径合入规范根集合。
- 资源图从成员 entry 的 canonical path segments、owner Pack pin、target pin 与 graph edge 重算 `binding_target` 边；不接受调用方自报边。
- 共享 Pack 或共享成员只合并资源节点，每条挂载路径仍保留独立 provenance edge。

## Prevention

组合资源只有在成员集合与策略证据集合完全相等时才能生成节点策略。中间件应保留可复验的源语义对象，派生 edge/hash 只能在消费边界重算。

## Verification

- 聚焦 Skill Pack/root resource suites：**39/39**。
- release-core：**977/977**（36 files）。
- 混合 Pack 缺少 composite evidence、删除 Pack policy、删除 descendant entries、篡改成员 Binding identity 均失败关闭。

## Related

- [[2026-09-02-agent-direct-resource-graph-assembly]]
- [[session-2026-09-03]]
