---
title: "Compiled Binding 必须保留可重编译的原始需求拓扑"
date: 2026-09-03
tags: [solution, release-core, domain-contracts, capability, security, testing]
related_instincts: []
aliases: ["Binding requirement topology retention"]
---

# Compiled Binding 必须保留可重编译的原始需求拓扑

## Problem

最终 Binding 过去只保存 ceiling 解析后的 `effective_policy`。嵌套 Agent/Flow 投影能复制 operation，却无法在父命名空间和父 ceiling 下重新求解该路径的原始需求。

## Root Cause

有效权限不是原始需求的可逆编码：ceiling 会删除不可用模式并压低预算。更隐蔽的是，资源 intrinsic demand 也不等于完整路径需求，因为 Binding、Pack mount 和 Pack member 可以追加更严格的 approval；只保存资源需求会在递归重编译时降级审批。

## Solution

- `CompiledBindingEntryV1` 强制携带闭合的 `requirement_expression`。
- leaf、Pack parent/member 和 Flow/internal-Agent composite 生产器保存与首次 policy resolve 完全相同的 demand topology。
- Binding/Pack/member 追加的 approval 在写入 expression 前合并，不能只体现在 `effective_policy`。
- compiled closure verifier 检查每条 expression 的规范分支/叶顺序，并证明启用路径的数值需求不超过其 effective policy。
- nested Agent/Flow operation projections按精确 child Binding path 复制并深冻结该 expression；父 mount placeholder 不伪造 descendant demand。

## Prevention

任何需要跨命名空间重新求解权限的中间件，都必须保存 pre-ceiling demand，而不是从 effective policy 反推。生产器应先构造唯一 demand 对象，再同时用于 expression 与 policy resolve，防止两条语义路径漂移。

## Verification

- 缺失 requirement、非规范 alternative、自洽重哈希但超出 policy limit 均失败关闭。
- leaf、Pack、composite 与 nested Agent/Flow fixtures 全部迁移并验证 exact expression retention。
- Domain contracts：**162/162**；release-core：**982/982**（36 files）。
- 架构变异测试：**31/31**。

## Related

- [[2026-09-03-non-recursive-agent-closure-seal]]
- [[2026-09-02-agent-root-demand-policy]]
- [[session-2026-09-03]]
