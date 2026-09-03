---
title: "资源 Binding 的隐式读取与可往返预算"
date: 2026-09-02
tags: [solution, contracts, security, testing, canonicalization]
related_instincts: []
aliases: ["列 allowlist 不只管 SELECT", "prepare verify 预算闭合"]
---

# 资源 Binding 的隐式读取与可往返预算

## Problem

真实资源 source adapter 需要把完整内容、固有需求与 Binding 联系起来。初版 53 项测试全绿，但附加过滤可能读取未声明的高分类列，原查询 predicate/order 也可能绕过仅针对 SELECT 列的 allowlist。较大合法 artifact 则可能 prepare 成功却 verify 失败。

## Root Cause

- 结果值不是唯一的信息流：过滤影响成员、排序影响位置，也会泄露数据。附加 filter 是新的读取，不能仅校验列存在与参数声明。
- 先验证列 allowlist 的负例，可能遮蔽后续 classification guard 已失效；source 侧的凭证测试也不能代替 Binding 侧身份检查。
- `bounded([expected, source])` 把两个各自合法的 8 MiB operands 塞入一个共享预算，破坏 prepare→verify 往返。验证自身有界不等于预算与生成端相容。

## Solution

数据库用户读取列为 SELECT ∪ predicates ∪ order_by ∪ additional-filter。Binding allowlist 覆盖全部用户读取列；固定 tenant/principal 安全过滤独立强制，所有读取又必须满足源 read clearance 与 output taint。附加 filter 仅能 AND 追加，不能替换租户过滤。无谓词时空 object input schema 不要求冗余 properties。

```text
read column rank <= intrinsic readable classification
read column rank <= intrinsic output classification
user read columns ⊆ Binding allowed columns
```

完整 artifact 验证分别限制 expected 与 source，再重算逐字段比较；每个 operand 和生成结果仍受 8 MiB、节点/深度/字符串预算约束。Binding+source 保留它自己的组合调用预算。大 artifact 正例与“合法输入、超限输出”负例成对保护。

## Prevention

- 让待测 guard 成为唯一拒绝原因：分类负例先允许该列、使另一分类维度足够、Binding output 同步；随后分别删除每个 guard 验证回归会失败。
- 对 Binding requirement ID/provider/audience 逐字段错配，模式扩张拒绝/子集接受成对；operation→intrinsic 不能只测默认 safe/false，必须包含 requires_key + approval true。
- 数据格式/哈希自洽不等于来源可信。返回的 source intrinsic policy 也不是合并 Binding 更严要求后的 effective path policy；后续编译/准入必须继续处理。

## Related

- [[2026-09-02-operation-declaration-cross-checks]] — 平台约束与双侧声明一致性分开
- [[2026-09-02-policy-meet-output-budget]] — 输出预算与可再次组合
- [[2026-09-02-g1-a1-capability-closure-kernel]] — 本地 kernel 实施计划
