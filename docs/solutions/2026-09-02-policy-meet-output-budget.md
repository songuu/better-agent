---
title: "策略交集必须保持输出可再次组合"
date: 2026-09-02
tags: [solution, policy, security, canonicalization, testing]
related_instincts: []
aliases: ["policy meet 输出预算", "权限收窄的闭包边界"]
---

# 策略交集必须保持输出可再次组合

## Problem

两份分别满足输入大小限制的策略，可能产生无法被下一次 normalize/meet 消费的输出。逐维预算检查也不能证明输入/输出 token 的同时最低消耗可行。

## Root Cause

- Egress host 与 path 是独立轴：4 个精确 host 与 8 个精确 path 相交产生 32 条规则，重复的长 policy ID/path 使完整结果超过 1 MiB。只检查输入和规则数量漏掉了输出字节预算。
- input/output token cap 可以独立存在，但二者的最低需求必须同时放入共享 total cap；Number 求和还可能丢失 safe-integer 边界精度。
- 普通正例/通配路径负例不能独立保护 exact path 与 scheme 分支。审查内存变异移除两个比较时，原测试仍通过。

## Solution

`sealCeiling` 在深度冻结前，对完整规范结果再次执行 bounded snapshot 与闭集 Schema；resolve 输出使用同一边界。超限在当前操作直接拒绝，不截断、不留下全局状态。

```ts
return deepFreezeJson(parse(canonicalCeiling(value), CapabilityPolicyCeilingV1Schema));
```

资源最低 token 消耗使用 bigint 比较 `input_min + output_min <= total_cap`，不错误地要求 ceiling 的 input/output caps 之和低于 total cap。

永久回归包含：两个合法输入产生超限结果、缩小版本仍可重入和幂等 meet、exact host/path/scheme 双向交集和需求拒绝、token 等值/+1/安全整数边界。独立内存变异确认新 exact-path/scheme 测试能杀死错误比较。

## Prevention

- 每个有界 canonical algebra 都检查完整返回对象，不能只验证操作数。
- 区分允许集合与不可删减的固有需求；不要靠删除 required scopes/operation 使需求通过。
- 将每个授权维度的合法但冲突输入写成独立负例，再以成员模型/内存变异验证测试确实敏感。
- schema/纯内核测试不是 deployment approval、网络 SSRF 执行或真实 PG/生产验收的替代品。

## Evidence

- T2 新增 release-core 68 项、domain-contracts 69 项；受影响两包 157/122 全通过，原 T1 identity 56 项保留。
- 五视角独立审查最终无 P0/P1/P2。安全探针验证 100 组 policy、100,800 个独立请求点；架构探针另验证 150 组及 36,000 次成员断言。
- 性能观察仅限本机 Windows：1,024 长规则原子约 237 ms、堆增量约 33 MiB 后拒绝；不是生产延迟保证。

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]] — 当前实现计划
- [[compiled-capability-closure-v1]] — §4.2.1 规范
- [[2026-09-02-closure-identity-hostile-input]] — 共享输入快照的来源
