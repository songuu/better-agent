---
title: "Operation 与 Binding 一致性不能替代平台约束"
date: 2026-09-02
tags: [solution, contracts, security, testing]
related_instincts: []
aliases: ["双方一致但 G1 禁止", "Binding 自身加严的 operation key"]
---

# Operation 与 Binding 一致性不能替代平台约束

## Problem

初始 54 条 operation-source 回归全部通过，但只读内存变异分别删除 DB safe-effect 检查、或删除 DB config 自身更严的 key-source 检查后，测试仍全绿。实际实现原本正确；缺的是两条独立约束的回归保护。

## Root Cause

已有 effect 测试只构造 Binding 与 operation 的声明不一致，无法覆盖“双侧 unsafe 且 hash 正确，但 G1 不允许”的情形。已有 key 测试只覆盖 operation 本身要求 key，无法覆盖 operation 不要求而 Binding config 单独要求的另一方向。

## Solution

新增成对有效/无效案例，其他轴全部保持正确：

```text
DB mode=read_only + Binding effect=unsafe + operation effect=unsafe
  + matching operation hash → FEATURE_NOT_ENABLED

operation key_required=false + DB config idempotency=operation_key_required
  + no key source → CAPABILITY_OPERATION_CONTRACT_MISMATCH
  + generated key source → accept declaration compatibility
```

独立重跑变异后，两条删除各自精确触发新增失败断言。另新增独立输出大小测试：整个 source JCS 为 8 MiB−64 bytes，封装 artifact 因元数据增加而超限，必须当次拒绝；缩小 3 KiB 后 prepare 与完整 verify 都通过。最终 operation-source 回归为 60 项。

## Prevention

对跨声明协议同时测试“相互一致性”和“平台绝对约束”；对要求同时测试固有需求和消费者额外收窄，不能让同一公共失败轴掩盖另一条件。调用方自洽哈希只证明内容绑定，不证明 JSON Schema 可执行、真实资源实现、registry 来源或审批权限。

## Related

- [[2026-09-02-g1-a1-capability-closure-kernel]] — T3.2 当前实施
- [[compiled-capability-closure-v1]] — §7.1.1 operation source profile
- [[2026-09-02-policy-meet-output-budget]] — 输出预算同样必须闭合
