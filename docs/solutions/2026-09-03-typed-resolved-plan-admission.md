---
title: "Typed ResolvedPlan 必须连接真实授权身份与可信执行承诺"
date: 2026-09-03
tags: [solution, release-core, domain-contracts, admission, security, testing]
related_instincts: []
aliases: ["ResolvedPlan admission", "强制调用与凭证证据闭合"]
---

# Typed ResolvedPlan 必须连接真实授权身份与可信执行承诺

## Problem

闭包、Deployment、credential mapping 与 decision 各自的 schema/hash 合法，仍不代表它们属于同一个主体、版本或执行作用域。仅重算 Plan 自身 hash 也不能拒绝攻击者重新封装的 target、operation 或 mapping。

## Root Cause

- source semantic seed 与最终 published compiled hash 被混同；测试手写相同 hash 掩盖真实编译产物被拒绝。
- credential epoch 没有固定真实 material 身份；grant 只按 version ID 匹配；team/shared、browser/service 入口可能混用。
- Release 局部强制顺序被误当全局顺序，源停用与权限拒绝被混同；source→entry→descendant→final boundary 没有完整重放执行义务。
- optional capability 也出现在 assembly manifest；无条件要求全部 grant 会破坏合法收窄。反过来仅依赖图中的边，会让漏边抹掉根源码的必需 Strategy/Instruction。
- 同 provider/audience 的多个 requirement 会产生重复 allowance；共享 input Gate 在多 mount/call 中重复展开会放大输出。

## Solution

`resolveExecutionPlan` 独立连接 source、closure、typed revision、snapshot、decision、当前 epoch vector 和事务时钟。实际 credential 的 id/version/provider/audience/scopes/mode/subject/handle/fingerprint 固定为 material identity hash；Release grant 固定 Workspace、authenticated principal、完整 typed pin。

```ts
const plan = resolveExecutionPlan(transactionFacts);
// Future T6 transaction persists this hash with the accepted admission facts.
const verified = verifyResolvedExecutionPlan(storedPlan, trustedReceipt.accepted_plan_hash);
```

第二个参数是外部可信承诺，不是 `storedPlan.plan_hash` 的自证。当前内核不产生 Receipt，也不从网络/环境解析秘密。

执行义务从 source.enabled/discoverability/config 统一推导，并在 root、nested 和 final boundary 重放。required call 使用 mount scope + local order，并固定同 owner 的 input Gate。父 mount 未启用时子项不可执行；源停用项不创建执行义务，权限不可满足的源启用 forced 项仍拒绝。

装配授权按 exact `(node_id, source_path)` 的活动 scope 推导，根 Strategy/Instruction 另从独立重算的 source manifest 导出。多个 credential requirement 的 ceiling 按 provider/audience 合并，但每个 mapping/material 仍独立校验。展开后的 Plan 在 JCS 前重新检查 32 MiB key/text 和结构预算，预留最终 hash 字段成本。

## Prevention

- 为 authority equality 负例同步其他合法证据，避免最后一个 epoch guard 掩盖前面的缺失防护；凭证轮换/撤销负例则单独保留旧 vector。
- compiler→published revision→Plan 集成必须允许 semantic/published hash 不同。无权访问 optional capability 的正例必须真的删除其 grant/state，而非只清空 selected paths。
- 验证 source-disabled forced、policy-disabled forced、同 child 双 mount、只启用一个 mount、根装配缺权限，以及嵌入 Flow 非空父凭证/默认映射拒绝。
- exact/+1 字节预算用独立计数和 hash spy 确认拒绝发生在编码之前；同时保留真实编译调用路径的共享 Gate 扇出回归。

## Verification

- release-core：**1047/1047**，39 个文件；domain-contracts：**169/169**，16 个文件。
- repository `pnpm check`：通过（format、lint、workspace/contracts、typecheck、test、build）；已有 test-support 9 warnings/1 info 未扩大。
- architecture mutation tests：**37/37**。不等于完整 PostgreSQL architecture gate。
- 三路独立复审：architecture、quality/security、test，最终 P0/P1/P2=0。
- 未执行当前源码的真实 PostgreSQL、publisher readback、host-attested Acceptance、上传或部署。T3.2 不支持的组合与 T6 集成保持待办。

## Maintenance

仓库未提供 `scripts/sync-solution-index.js`，按现有 JSONL 格式同步本条摘要；不存在根 AGENTS.md/CLAUDE.md 投影，本轮不创建替代 runtime 指令。未写全局本能目录，跨会话知识保存在项目规则和本解决方案。

## Related

- [[2026-09-03-recursive-gate-proof-replay]]
- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[2026-09-03-resolved-plan-debug-journal]]
- [[session-2026-09-03]]
