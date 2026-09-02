---
title: "Skill Pack graph 必须封闭两层父子关系"
date: 2026-09-02
tags: [solution, release-core, graph, security, testing]
related_instincts: []
aliases: ["Agent Pack leaf graph sealing"]
---

# Skill Pack graph 必须封闭两层父子关系

## Problem
Pack leaf 出现在依赖图中并不证明它属于该 Pack；错误的直属边可能让来源身份看似完整却绕过组合资源边界。

## Root Cause
Skill Pack 的 provenance 是 Agent→Pack→leaf 两层关系，并且每层的完整 dependency manifest 都是权限事实，不只是节点集合。

## Solution
在一次有界 pinned-graph 重算中验证 Agent root→Pack 及 Pack→每个唯一 leaf，并将 root/Pack graph-node manifest hash 分别与准备后的 Agent/Pack source manifest 精确比较。

## Prevention
保留错误父边、root manifest 额外依赖、Pack manifest 额外依赖三个独立回归；不能用“预期节点都存在”代替 parent edge 与 manifest exactness。

## Related
- [[skill-pack-leaf-binding-entry-set]]
- [[session-2026-09-02]]
