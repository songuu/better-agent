---
title: "Skill Pack leaf Binding entry 按 mount 闭合"
date: 2026-09-02
tags: [solution, release-core, architecture, security, testing]
related_instincts: []
aliases: ["Skill Pack member policy closure"]
---

# Skill Pack leaf Binding entry 按 mount 闭合

## Problem
Pack member 的 leaf capability 必须进入父 Agent 的 canonical Binding namespace，同时不能因多 mount 或共享 target 混淆来源与权限。

## Root Cause
来源身份按 full pin 去重，而有效权限与可用性按 mount-specific path 决定；把两者当作同一个集合会丢失路径隔离或重复要求来源。

## Solution
先验证唯一且精确的 leaf source set，再为每个 Pack mount/member path 编译独立 entry。有效 policy 按 Workspace、root、Pack mount、member 四层 ceiling 求交后解析真实 leaf intrinsic demand，并保留审批、依赖节点和 disabled-path 证据。

## Prevention
测试必须包含双 mount 共享 target、缺失/重复/无关 source、path ceiling 缺失/重复、不可满足 demand、禁用与无 route 场景。

## Related
- [[session-2026-09-02]]
