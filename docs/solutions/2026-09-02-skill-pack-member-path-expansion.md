---
title: "Skill Pack 成员路径必须覆盖禁用与未曝光成员"
date: 2026-09-02
tags: [solution, contracts, architecture, testing]
related_instincts: []
aliases: ["Skill Pack member path expansion", "Pack 成员闭包身份"]
---

# Skill Pack 成员路径必须覆盖禁用与未曝光成员

## Problem

只为已曝光或启用成员建立路径，会从闭包身份和循环分析中删除仍然存在的 source dependency；逐个 root Binding 重解析 Pack 又会让最坏成本随 Binding 数放大。

## Root Cause

运行时可调用集合、source 声明集合和最终 policy-enabled 集合被混为一谈，同时缺少“一个 Pack、多个 root Bindings”的批量验证边界。

## Solution

Direct Agent→Pack adapter 分别准备 raw Agent 与 Pack，按完整 pin 找到 root Pack Bindings，并用一个 bounded set verifier 只准备一次 Pack、逐项核验 envelope、member projection、selected exposures 与 policy floor。完整 root Binding namespace 先进入 closure-local identity registry；随后所有 Pack members 追加携带完整 Pack pin 与 local member ID 的 typed segment。显式禁用的 root/member path 单独投影，未曝光成员仍保留地址。

该中间层不生成 route 或 closure hash。曝光 operation 到 member path 的唯一 sealed route、route hash、传递 member expansion 和有效策略仍由后续 compiler 完成。

## Prevention

- source namespace 与 runtime enabled set 分开建模，disabled/unexposed 不等于不存在。
- 一个 shared dependency 的多 Binding 校验要准备 dependency 一次，并覆盖非首项失败与重复 ID。
- producer→consumer 回归使用 exact 128-member Pack，且断言没有提前生成权威 route/hash。

## Related

- [[2026-09-02-flow-node-graph-namespace-identity]]
- [[2026-09-02-private-root-binding-path-compilation]]
- [[session-2026-09-02]]
