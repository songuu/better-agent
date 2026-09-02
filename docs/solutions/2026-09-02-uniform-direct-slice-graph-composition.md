---
title: "所有 direct slice 必须统一组合 graph proof"
date: 2026-09-02
tags: [solution, contracts, architecture, security, testing]
related_instincts: []
aliases: ["direct slice graph composition"]
---

# 所有 direct slice 必须统一组合 graph proof

## Problem

只让 Skill Pack route 绑定 pinned graph，会留下 Flow 与 SubAgent adapter 可绕过完整图快照的旁路；同时泛型包装容易抹平 nested 与 terminal target 的差异。

## Root Cause

不同 dependency kind 的 path shape 不同，但它们共享相同 direct-edge join contract。若分别复制 graph lookup，校验强度会逐步漂移。

## Solution

用一个 private graph-bound direct dependency primitive 组合三个既有 path adapter。Flow 与 internal Agent 返回图记录中强制存在的 nested closure hash；external A2A 返回 terminal leaf node且无该字段。wrapper 保留原 prepared paths，不重新解释或缩减 source evidence。

## Prevention

- 每个 target kind 至少用一个真实 source fixture 穿透 wrapper。
- internal/Flow 与 external A2A 成对断言 nested seal presence/absence。
- graph wrapper 不导出到 package barrel，直到完整 nested verifier 和 publisher contract 成立。

## Related

- [[2026-09-02-pinned-graph-direct-edge-binding]]
- [[2026-09-02-subagent-target-path-boundaries]]
- [[session-2026-09-02]]
