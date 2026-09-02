---
title: "Child call 的 invocation demand 必须独立验证"
date: 2026-09-02
tags: [solution, contracts, policy, security, testing]
related_instincts: []
aliases: ["capability-invocation-requirements/1", "Child call invocation provenance"]
---

# Child call 的 invocation demand 必须独立验证

## Problem

仅验证 `flow_call` 或 `subagent_call` operation pin，只能证明输入输出与副作用合同，不能证明父调用自身需要的凭证、egress、数据分类和预算。此时 composite entry 只能猜测或使用隐含零成本。

## Root Cause

Operation contract 与 capability demand 是不同证据；把两者混在一个可自报对象中又会允许调用方伪造 operation allow-set、side effect 或 approval。

## Solution

- 用闭合的 `capability-invocation-requirements/1` 只承载需求轴，并强制 calls 与 parallelism 至少为 1。
- 先按 exact Binding 验证 operation source，再从 operation pin 派生 operation hash、side effect 和 approval，生成完整规范化 `CapabilityRequirementsV1`。
- 以 canonical parent path 决定附着位置；child closure 中复用同一 local Binding ID 的 entry 不获得 parent invocation requirements。
- 输入先经过有界快照，输出深冻结；无关异常继续抛出，只有 policy contract 错误被映射为带路径的 call-contract mismatch。

## Prevention

Composite `nested_call` 只能消费这份已验证 requirements 和 verified child-root expression。回归必须覆盖缺失、零成本、自报授权字段、schema drift、同 ID 隔离和深冻结。

## Related

- [[2026-09-02-capability-requirement-limit-envelope]]
- [[2026-09-02-nested-policy-evidence-propagation]]
- [[session-2026-09-02]]
