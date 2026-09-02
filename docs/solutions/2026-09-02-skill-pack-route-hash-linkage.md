---
title: "Skill Pack 路由哈希必须连接暴露与成员路径"
date: 2026-09-02
tags: [solution, contracts, architecture, security, testing]
related_instincts: []
aliases: ["Skill Pack route hash", "Pack exposure member linkage"]
---

# Skill Pack 路由哈希必须连接暴露与成员路径

## Problem

只对 exposed operation 或 member operation 做哈希，无法证明某个 Agent 根 Binding 下的公开操作实际路由到了哪一个 Pack 成员，也无法隔离同一 Pack 的多个挂载位置。

## Root Cause

暴露合同、Pack Binding path、member Binding path、member target 和 member operation 是不同层的事实；缺少统一 preimage 时，任一层都可能在后续编译中被替换而不改变路由身份。

## Solution

先用 exact full pin 和 selected projection 校验 Agent→Pack，再为每个选择的 exposure 精确查找一个 member path。路由哈希使用 canonical JSON SHA-256，并绑定版本标记、Pack path、exposed ID/hash、member path/target/operation hash。输出保持 private、deep-frozen、stable-sorted 且没有 aggregate closure hash。Disabled Binding 的路由仍是 source fact，runtime availability 留给 effective policy。

## Prevention

- 测试独立重算完整 route preimage，而非只匹配哈希格式。
- 同一 Pack 在两个 root Binding 及两个 root release 下必须产生不同路径和 route hash。
- stale member projection 在路由编译前 fail closed。
- publisher/registry seal 未接入前只称 seal-ready intermediate，不称 sealed closure。

## Related

- [[2026-09-02-skill-pack-member-path-expansion]]
- [[2026-09-02-private-root-binding-path-compilation]]
- [[session-2026-09-02]]
