---
title: "内部与外部 SubAgent 目标必须使用不同路径边界"
date: 2026-09-02
tags: [solution, contracts, architecture, security, testing]
related_instincts: []
aliases: ["SubAgent target paths", "internal Agent vs external A2A paths"]
---

# 内部与外部 SubAgent 目标必须使用不同路径边界

## Problem

把 internal Agent 与 external A2A 当作同一种 target，会为远端服务虚构内部 Binding，或在内部 Agent 路径上丢失真实目标 namespace、循环与禁用事实。

## Root Cause

两类 SubAgent 共用 Binding config，但发布证据形态不同：internal target 是需要既有 nested closure seal 的 Agent Release；external target 是有 transport/credential/remote identity 的 A2A leaf。

## Solution

Internal adapter 独立准备 parent/target Agent sources，要求 exact full pin，拒绝同版本直接循环，并生成 `root → parent binding → subagent_target → dependency-owned binding`。External adapter只接受 A2A leaf，通过一次 prepared leaf 的 bounded Binding-set verifier核对 manual、schemas、operation、credential、classification 和 transport，再生成 terminal target path。两者共享完整 parent root namespace、保留显式 disabled path，且都不生成 nested closure hash。

## Prevention

- 按 target kind 分离 source verifier 和 path terminal shape。
- internal 测完整目标 Binding namespace、自循环与 owner pin；external 测 leaf evidence 和“没有 nested bindings”。
- credential requirement ID 唯一性是 Agent 级安全合同，测试不得为了复制 Binding 而绕过。

## Related

- [[2026-09-02-skill-pack-member-path-expansion]]
- [[2026-09-02-flow-node-graph-namespace-identity]]
- [[session-2026-09-02]]
