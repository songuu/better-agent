---
title: "Agent 直接资源图必须同时闭合节点策略与边来源"
date: 2026-09-02
tags: [solution, release-core, capability, security, testing]
related_instincts: []
aliases: ["Agent direct resource graph"]
---

# Agent 直接资源图必须同时闭合节点策略与边来源

## 问题

根 Binding entry 已经证明路径、目标与有效策略，但最终 closure 仍需要独立的资源节点和依赖边。若直接信任调用方提供的图或为未知依赖补空策略，攻击者可以隐藏递归能力、伪造节点需求，或把装配依赖错误提升为可调用 Binding。

## 决策

- 从输入的节点、边与 manifest 重新构造 pinned dependency graph，并要求完整规范字节和 `graph_hash` 一致。
- 叶与已验证嵌套资源必须携带源派生的 `{node_id, pin, intrinsic_policy}`；节点 ID 从完整 pin 重算。
- 仅对源契约已证明不能独立执行的装配依赖生成规范零需求：G1 Instruction Skill 的脚本必须 inert，Strategy 的外部操作仍由 Agent Binding 所有。
- `SYSTEM_RELEASE`、Experience、Deployment、未闭合 Pack 与递归后代没有独立策略/来源时失败关闭。
- 每个能力挂载保留一条 `binding_target` 边；共享目标只保留一个节点但不能合并不同 Binding 路径。非 Binding 装配依赖使用根唯一规范路径与 `typed_internal_dependency`。
- 产物保持 package-private、深冻结且不生成 `closure_hash`，避免中间证据被误认作发布 authority。

## 验证

- 聚焦相关测试 **96/96**。
- release-core **974/974**（36 files）。
- 仓库 `pnpm check` 通过；既有 test-support 诊断仍为非阻断的 9 warnings + 1 info。
- 架构变异测试 **31/31**。
- L4 安全、架构、质量、性能与测试内联审查未发现剩余 P0/P1/P2。

本增量没有执行 PostgreSQL、上传、生产部署或 host-attested Acceptance。

## Related

- [[2026-09-03-skill-pack-resource-node-provenance]]
- [[session-2026-09-02]]
