---
title: "禁用 Binding 不能删除依赖资源的 intrinsic policy"
date: 2026-09-02
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["disabled dependency policy evidence", "resource intrinsic policy retention"]
---

# 禁用 Binding 不能删除依赖资源的 intrinsic policy

## Problem

禁用 Binding 正确地不应贡献根需求，但后续 resource-node 组装仍需知道目标资源自身的 intrinsic policy。若只保存启用路径表达式，全禁用资源会丢失这一事实。

## Root Cause

路径可执行性与资源固有需求属于不同维度：前者由父 Binding 控制，后者由已验证的发布资源来源决定。把两者共用一个“仅启用时存在”的数组，会让路由状态意外删除资源证据。

## Solution

Agent 直连叶切片和 Skill Pack 叶成员切片分别输出规范化的 `{node_id, pin, intrinsic_policy}` 集合。策略直接来自已验证 leaf source，并包装为 canonical leaf requirement expression；集合按 node id 排序且深冻结。Skill Pack 叶切片只声明叶节点策略，不在复合成员尚未汇合时伪造完整 Pack 节点策略。

## Prevention

- Binding enablement 只控制根需求与 disabled path，不控制资源事实是否存在。
- 节点策略必须从 source intrinsic policy 产生，禁止从 effective policy 反推。
- node id 必须由完整 pin 重算，集合保持 canonical 顺序。
- 部分成员切片的字段名必须表明证据范围，禁止将 partial 结果命名为完整 Pack policy。
- 最终 resource-node assembler 必须重新校验这些元组与同一 pinned graph。

## Related

- [[2026-09-02-agent-root-binding-entry-set]]
- [[2026-09-02-agent-root-demand-policy]]
- [[2026-09-02-skill-pack-parent-binding-closure]]
