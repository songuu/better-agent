---
title: "闭包根依赖必须与源码独立派生的 manifest 相等"
date: 2026-09-03
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["根依赖漏边", "source root manifest binding"]
---

# 闭包根依赖必须与源码独立派生的 manifest 相等

## Problem

Agent 源码保留 Strategy，而调用者提供的自洽依赖图可以漏掉、增加或替换 Strategy。图自身的 hash 校验通过，不等于图表达了源码真实声明的直接依赖。

## Root Cause

最终 assembler 从源码填写 `assembly_pins`，却从另一输入读取资源图。两侧分别验证后没有连接根 manifest；Strategy/Instruction 不经过 capability Binding 的逐项匹配，因此这个缺口会保留到 closure 封装。

## Solution

在 `prepareAgentCapabilityClosure` 中，先复用既有有界源码解析及按真实直连边重建的图校验，再比较两个独立来源的根 manifest hash。根缺失或 manifest 不同立即拒绝，不产生 closure hash。

```ts
rootResource.dependency_manifest_hash === source.dependency_manifest.manifest_hash
```

该相等关系包含 owner 和规范化的完整直接依赖 pins；不能用全部可达节点集合替代。共享 Strategy 在子 Agent 中可达，也不允许删除父 Agent 自己声明的直连边。新增检查最坏 O(V)、额外空间 O(1)，不引入新的哈希、递归或 IO。

## Prevention

- 负例修改依赖事实后重新准备合法 graph，并同步 entrySet 的 graph hash，保证测试命中缺失的跨证据连接，而不是旧 hash。
- Strategy/Instruction × 源 Binding 启用/禁用 × 缺失/额外/替换 hash，共 12 个回归；每个负例先证明原始输入成功。
- 保留双 SubAgent mount 正例，单独删除根 Strategy 边但保留子图中的同一节点。
- 最终封装 fixture 必须用真实 source manifest；用于验证单一依赖投影的部分图不能冒充可发布根图。
- 门禁 testCount 和精确 success marker 必须跟随实际测试结果同步，不放宽跳过、失败或清洁快照检查。

## Verification

- 根/嵌套相关测试：76/76；release-core：1059/1059（39 个文件）；domain-contracts：169/169（16 个文件）。
- `pnpm check` 和 architecture mutation tests 37/37 通过。
- 独立安全、架构、性能、质量、测试五视角审查：无遗留 P0/P1/P2。
- PostgreSQL 与完整 architecture gate 的运行结果另记录于本轮验证交接；上述单元证据不代替数据库/生产验收。

## Remaining boundary

这是 T6 前置完整性修复，不是 registry 身份来源证明或 publisher 原子提交。当前 Agent Release/Deployment publisher 暂停保持不变。嵌套依赖原文读回、完整 compiler 组合、事务证据及完整业务应用上线仍待后续任务。没有上传、部署或更新历史 host-attested Receipt。

## Maintenance

仓库仍无 `scripts/sync-solution-index.js`；按既有 JSONL 索引格式同步本条，不创建替代 runtime 指令或全局本能。

## Related

- [[2026-09-03-typed-resolved-plan-admission]]
- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[2026-09-03-source-root-manifest-debug-journal]]
