---
title: "Leaf operation 只能附着到 exact matching path"
date: 2026-09-02
tags: [solution, contracts, architecture, security, testing]
related_instincts: []
aliases: ["leaf Binding operation collection"]
---

# Leaf operation 只能附着到 exact matching path

## Problem

最终 Binding entry 需要 concrete operation pin，但逐个处理依赖时若过滤 root namespace 或按数组位置拼接，会丢失 sibling collision/budget 事实，甚至把一个 leaf operation 泄漏给其他 Binding。

## Root Cause

依赖 verifier 返回资源级 operation，而 path compiler 返回完整 Agent namespace；二者必须按 exact full pin 与 binding kind 做显式 join。

## Solution

独立准备 Agent 与 leaf source，按 Knowledge/Database/Plugin/A2A 映射筛选 exact full-pin Bindings，一次 batch verifier 检查全部匹配项，再把 leaf operation pin 只附着到这些 binding IDs 对应的 canonical root paths。所有 sibling paths 原样保留且 operation set 为空，intrinsic requirements 作为 dependency-level 输入单独返回。

## Prevention

- 四种 leaf kind 共用参数化真实 fixture。
- 单独断言非匹配 sibling path 存在且 operation set 为空。
- source-disabled path 仍是 source fact，不能在 operation collector 被删除。

## Related

- [[2026-09-02-pinned-graph-direct-edge-binding]]
- [[2026-09-02-agent-root-gate-spec-projection]]
- [[session-2026-09-02]]
