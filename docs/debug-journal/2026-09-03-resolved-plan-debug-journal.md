---
title: "ResolvedPlan 准入边界调试记录"
date: 2026-09-03
tags: [debug-journal, admission, security, testing]
---

# ResolvedPlan 准入边界调试记录

## 最小反馈环

使用 Vitest 定向 admission、nested Agent、root entry 集成和独立 reviewer 反例。每次负例重封非目标字段，确保观察到的是当前假设对应的失败边界；不以绿 CI 代替身份一致性证明。

## 主要轮次

1. 初版 typed Plan 正例全绿，复审指出 source seed/published hash、actual credential、grant subject、trusted expected hash 缺口。加入真实父编译器到 admission 的桥接与凭证 material identity join。
2. 同 child 双挂载暴露 Release-local order 冲突。改为 scope-local order，并固定真实 input Gate；root/nested/final entry replay 拒绝 forced→optional 的重封篡改。
3. source-disabled forced 和 policy-disabled forced 不能混同。所有 producer 统一源执行义务函数，保留 source hash，但源停用不执行。正例 fixture 的 `none` mode 重复导致 schema 拒绝，仅修测试集合去重。
4. 直接构造 257 个 root policy entries 先触发既有 128-entry policy 输入预算，未到达输出扇出边界。改为两个 parent mounts × 129 child forced calls，合法编译输入下，重复 input Gates 在 Plan 输出超过 32 MiB。
5. optional grant 删减揭示根 Strategy 与 child 共享 pin：删掉所有非根 node 权限会顺带移除根必需权限。从 source manifest 独立导出根 Strategy/Instruction，测试保留根权利并单独证明删除即拒绝。
6. credential authority-axis 负例原被旧 epoch vector 遮蔽。拆分 identity mismatch（同步新 vector）与 material rotation（保留旧 vector）两个反馈环。嵌入 Flow 正例改为真实非空父 Agent mapping/material。
7. TypeScript 对 structuredClone 后的判别 union 与 Set 字面量 key 推断更窄；补显式判别收窄、schema parse 与 string key Set，不使用 any 或降低 typecheck。

## 最终证据

release-core 1047、domain 169、architecture 37；`pnpm check` 通过。三个 reviewer 无剩余 P0/P1/P2。输出预算回归独立断言 exact/+1 且 hash 调用次数在拒绝路径为零。

## 尚未证明

真实 registry/source graph 完整性与 publisher 原子提交、权威当前 epoch 读取、PG/host-attested Acceptance、业务应用生产端到端仍需 T6 及后续阶段。见 [[2026-09-03-typed-resolved-plan-admission]]。
