---
title: "Agent 根 manifest 连接调试记录"
date: 2026-09-03
tags: [debug-journal, capability, security, testing]
---

# Agent 根 manifest 连接调试记录

1. T6 发布前检查发现 source 与 graph 各自合法，却没有根直接依赖连接。先写三项 Strategy 缺失/额外/换 hash 回归，重建 graph 并同步 entrySet hash：三项均 RED，实际错误为预期拒绝未发生。
2. 最终 assembler 连接独立 root manifest。合法双子 Agent fixture 原只提供被投影的子 Agent，改为真实根 source manifest；两个相关文件 67/67 GREEN。
3. 扩展到 Instruction 与源停用矩阵时，rich fixture 仍引用已移除的 subagent Binding，测试先在 source schema 失败。仅修 fixture 的 Instruction allowlist，使其对应保留的 Binding；不调整生产 schema。资源删减按完整 pin 的规范节点 ID 匹配，避免引用对象身份造成假测试。
4. 完整 12 项矩阵及共享 Strategy 的根直连漏边回归均命中精确 `root dependency manifest` 错误；相关 76/76 GREEN，全仓 release-core 1059/1059。
5. 门禁冻结清单仍是上一增量的 domain 165 / release-core 1008。根据实际 test log 同步至 169 / 1059，保留所有严格失败和禁止跳过约束；37 个门禁测试通过。

参见 [[2026-09-03-source-root-manifest-binding]]。真实 registry/publisher provenance 不包含在此修复结论中。
