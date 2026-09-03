---
title: "Skill Pack 必须同时编译父入口与成员入口"
date: 2026-09-02
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["Skill Pack parent Binding", "Pack root closure entry"]
---

# Skill Pack 必须同时编译父入口与成员入口

## Problem

只编译 Pack 成员路径会留下一个断层：Agent 根 Binding 有 Pack 配置和公开操作，但最终闭包没有承载这些公开操作的父入口，发布与运行无法从 Agent 路径进入 Pack。

## Root Cause

成员 Binding 证明资源能力，Pack 父 Binding 证明公开操作如何路由到成员。两者是不同的权限层；用成员入口代替父入口会丢失 Pack 配置、曝光 ID、路由哈希和根路径策略。

## Solution

为每个 Agent Pack mount 编译一个独立父入口，绑定 Pack full pin、配置哈希、source contract、Pack resource node、精确 routes 和按 contract hash 去重的操作集合。有效需求按唯一成员操作组成 `alternative` 表达式，因此同一操作的多个曝光别名保留多条路由，却只计算一次能力和预算。禁用 Pack 保留完整证据，但清空 principal mode 并把调用、深度、并发和预算归零，同时将父路径及成员路径列入 disabled set。

## Prevention

- Pack 父入口和成员入口分别断言，不允许只验证其中一层。
- 每个父操作必须至少有一条同路径 route，每条 route 必须落到已验证成员 source。
- 曝光别名测试同时断言 route 数增加、operation 和 requirement 数不增加。
- 禁用但保留曝光配置时仍须保存 route 证据，并证明执行策略不可用。
- whole-root closure 聚合前先检查所有根 Binding kind 都存在父入口。

## Related

- [[2026-09-02-skill-pack-route-hash-linkage]]
- [[2026-09-02-composite-binding-requirement-envelope]]
- [[session-2026-09-02]]
