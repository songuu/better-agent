---
title: "可执行源哈希前的无损解析与递归分派"
date: 2026-09-02
tags: [solution, canonicalization, zod, security, performance, testing]
related_instincts: []
aliases: ["Source 字段静默丢失", "Flow condition loop 指数解析"]
---

# 可执行源哈希前的无损解析与递归分派

## Problem

G1-A1 source-preimage 实现中，两个不同业务 JSON 可能因解析丢字段而得到同一语义哈希；很小且合法的嵌套 Flow 也可能消耗指数级解析工作。这两项是实际复现的实现缺陷，不是生产事故报告。

## Root Cause

1. 当前 Zod record 对 `JSON.parse('{"__proto__":{"semantic":"must remain"},"content":"visible"}')` 的结果静默丢弃 own `__proto__` 键。只验证解析成功并哈希解析结果不够；本次未观察到全局 prototype pollution。
2. `LoopConfigV1Schema` 的 trial union 在 collection 分支失败前已递归解析 body，再在 condition 分支重复解析。嵌套后重复工作相乘。Flow node 的 trial union 也在选中 node 类型前试解析其他配置。

## Solution

在 Agent 和 Flow 两条分支中，先 snapshot 并通过 schema，再在任何显式规范化前比较完整 canonical bytes；任何未声明的数据丢失都拒绝：

```ts
if (!canonicalJsonBytes(raw).equals(canonicalJsonBytes(parsed.data))) {
  invalid();
}
```

随后才排除 Agent 顶层 release number/source revision、Flow 顶层 title/ui，并规范显式集合顺序；嵌套业务键和业务数组不得递归剥离或排序。

递归 schema 改为 `z.discriminatedUnion('mode', ...)` 与 lazy `z.discriminatedUnion('type', ...)`。既有 body/refinement 和未知、缺失、混合 variant 的拒绝行为保持不变。

## Evidence

- 回归先红：own `__proto__` 的 source 应拒绝却未抛错；13 层 condition loop 读取 leaf 16383 次，超过测试上限 64。
- 修复后：source 81/81，release-core 319/319，domain-contracts 127/127；新的 Flow recursion 测试为 5 项。
- 独立同宿主诊断：深度 12 的小 Flow 从约 2459 ms 降至约 6 ms。此数据不是跨机器性能 SLA；永久回归检查工作次数，不检查墙钟时间。
- 只读内存变异：仅撤销 Flow 无损屏障导致三个 Flow 负例失败；仅撤销 loop discriminator 导致复杂度回归失败。另补齐 Binding 投影、共享 gate refinement、递归子图遍历的变异敏感性。

## Prevention

内容寻址先验证解析无损，再进行明确列出的语义归一化。递归闭集类型在读取递归 body 前分派标签。测试同时覆盖完整文档投影、不同业务字段、每个递归位置、准确预算边界与 +1，而不是只检查外层哈希自洽。

这个 source helper 只计算中间证据；合法 typed hash 不代表资源内容或 registry 来源已验证，不能替代最终 closure、准入或完整应用验收。

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]] — 当前实施计划
- [[compiled-capability-closure-v1]] — §7.1 源规范化边界
- [[g1-a1-executable-source-debug-journal]] — 回归与变异修复过程
- [[2026-09-02-shared-dag-depth-regression]] — 非零共享子图与访问顺序回归
