---
title: "共享 DAG 子图高度的回归盲区"
date: 2026-09-02
tags: [solution, graph, testing, security]
related_instincts: []
aliases: ["最长路径 memoization 测试"]
---

# 共享 DAG 子图高度的回归盲区

## Problem

T3.1 的初始 48 条依赖图测试全部通过，但只读变异把缓存分支 `return known` 改为 `return 0` 后仍全绿。实际实现没有这个缺陷；缺的是保护共享非叶子子图高度的回归。

## Root Cause

已有“短路径先访问”案例共享的是叶节点，其真实 height 本来就是 0。清零缓存不会改变该案例。只反转输入数组也无效，因为编译器会先按 canonical node ID 排序。

## Solution

新增固定拓扑：root 同时引用链头 pin(1) 和链中段 pin(6)，显式断言 pin(6) 的 canonical node ID 排在 pin(1) 前。先访问的中段有非零子树高度，随后较长路径必须复用完整高度。

```ts
expect(canonicalResourceNodeId(middle) < canonicalResourceNodeId(head)).toBe(true);
expect(preparePinnedDependencyGraph(sharedSubtree(32)).nodes).toHaveLength(33);
expect(() => preparePinnedDependencyGraph(sharedSubtree(33))).toThrow(
  'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
);
```

最终 81 条 graph 回归中，变异仅使新增 33-edge 拒绝断言失败，其余 80 条通过；正常实现 release-core 238/238 通过。另保留 12 个固定 seed 的 DAG 边集合、依赖先序、排列不变性和注入环回归。

## Prevention

对 memoization 的测试同时构造零值和非零缓存结果；冻结实际访问顺序，不能凭输入数组顺序猜测遍历。预算分别测试字段、总 UTF-8、编码膨胀、结构值数、节点数、边数与最长路径；中间图通过不能替代最终 closure、registry 或应用验收。

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]] — 当前实施计划
- [[compiled-capability-closure-v1]] — 最终闭包与中间图边界
- [[2026-09-02-policy-meet-output-budget]] — 规范输出也必须满足输入预算
