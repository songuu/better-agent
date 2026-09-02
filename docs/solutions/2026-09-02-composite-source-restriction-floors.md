---
title: "复合能力源必须逐层保留操作约束"
date: 2026-09-02
tags: [solution, contracts, security, testing]
related_instincts: []
aliases: ["Skill Pack restriction floors"]
---

# 复合能力源必须逐层保留操作约束

## Problem

嵌套 Skill Pack 即使 alias/hash 一致，也可能声明比已知 operation 更低的 effect/key/approval 要求。声明 requires_key 却没有键来源也是自相矛盾，不能因为原始 operation 是 safe 就接受。

## Root Cause

第一版只核嵌套曝光 ID/hash、仅在最外层合并要求；漏掉已知嵌套 member 自身的最低要求。单成员/单模型夹具还可能让“仅检查首项”“只比部分身份”“target 取首成员”等变异存活。

## Solution

`prepareCapabilityBindingSource` 拒绝 requires_key 且无 operation key source。`projectExposure` 对嵌套 member 调用与外层相同的 `coversOperation`，三轴逐项检查。外层另保留成员额外 key/approval 和分类，不能将安全要求消掉。

```text
source operation requirements
  -> nested member declaration must cover them
  -> outer selected pack declaration must cover both
  -> final compiler still verifies provenance, path policies and gates
```

本地 source 检查不是 registry seal 或授权。Strategy 模型也必须逐个比较完整 descriptor，而不只比 provider/hash。

## Prevention

永久回归包含双异构成员/双模型；逐项断言完整 pin/operation；让第二项单独违规，第一项保持合法；相同 alias 的 hash 漂移；非空 gate pin 与两类 allowset 扩大/缩减。修改 key 检查后，旧 key 负例用合法 unsafe class 隔离，避免新 requires_key guard 抢先拒绝、掩盖实际覆盖缺口。七个相关只读变异均被捕获。

## Related

- [[2026-09-02-operation-declaration-cross-checks]]
- [[2026-09-02-leaf-contract-narrowing-and-roundtrip]]
- [[g1-a1-composite-source-review]]
