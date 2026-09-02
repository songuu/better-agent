---
title: "Nested policy 先传递证据再定义组合公式"
date: 2026-09-02
tags: [solution, release-core, policy, security, testing]
related_instincts: []
aliases: ["Child root policy evidence propagation"]
---

# Nested policy 先传递证据再定义组合公式

## Problem
Nested Agent/Flow operation projection已验证 child closure，但下游 entry compiler无法直接取得该 child root 的 typed requirements。

## Root Cause
只传 operation 会迫使后续调用方再次提交 policy；另一方面，直接把 child minima 当 parent minima 会漏掉父调用新增的 calls、depth 和可能的 budget。

## Solution
把 closure join 生成的完整 dependency resource node原样带入 nested operation与child-call投影，并保持deep-freeze。当前不编译parent entry，直到composite minima公式明确。

## Prevention
用非空、重封且graph hash同步更新的child policy回归证明来源；任何parent entry实现必须先给出calls/depth/parallelism/budget的拓扑组合规则。

## Related
- [[nested-intrinsic-policy-projection]]
- [[session-2026-09-02]]
