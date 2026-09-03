---
title: "Agent 根入口集合必须保留原始需求拓扑"
date: 2026-09-02
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["Agent root Binding entry set", "root intrinsic demand assembly"]
---

# Agent 根入口集合必须保留原始需求拓扑

## Problem

各资源编译器可以分别产出合法 Binding entry，但最终 Agent closure 仍需要证明所有根 Binding 恰好覆盖一次，并从原始 intrinsic requirements 形成根需求，而不是从已收窄的有效权限反推。

## Root Cause

`effective_policy` 是 Workspace、root 与路径 ceiling 同资源需求求解后的结果，已丢失原始需求边界。只合并 entry 会把“需求是什么”和“最终允许什么”混为一谈；仅按 `binding_kind=subagent` 分类还会混淆外部 A2A 叶子与内部 Agent 调用。

## Solution

叶子与复合入口分别保留 path-keyed canonical requirement expression，source-disabled 路径保留 entry 但不贡献 root demand。新增 package-private 根集合 assembler，在同一 graph hash 下验证每个 Agent 根路径恰好一次，并从 source 重算 path segments、target、config hash、source contract 与 dependency node。Slice discriminator 同时校验 Binding kind 和 target resource kind，明确隔离 A2A 与内部 Agent。

## Prevention

- 原始需求表达式与有效权限并行保存，禁止互相反推。
- 启用根路径与 requirement-expression path 集合必须完全相等。
- 所有 per-kind slice 必须使用同一 graph hash，并保持内部 canonical 顺序。
- 聚合时重算 source-owned 字段；unknown、重复、遗漏或跨 root slice 全部失败关闭。
- 中间 entry set 不生成 `closure_hash`，完整 resource nodes、edges、aggregate limits 和 publisher provenance 接入前不称 closure。

## Related

- [[2026-09-02-skill-pack-parent-binding-closure]]
- [[2026-09-02-composite-binding-requirement-envelope]]
- [[session-2026-09-02]]
