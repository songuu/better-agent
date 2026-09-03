---
title: "Root Binding 路径编译应保持内部且无独立授权哈希"
date: 2026-09-02
tags: [solution, contracts, architecture, testing]
related_instincts: []
aliases: ["Agent root binding path compilation"]
---

# Root Binding 路径编译应保持内部且无独立授权哈希

## Problem

最终 capability closure 需要先把 Agent 根 Binding 转换成 typed canonical path，但局部中间结果容易被误包装成可持久化、可授权的独立契约。

## Root Cause

路径身份本身是确定性的，却不包含递归依赖、有效策略、GateSpec、route 和 registry provenance；给它独立 schema/hash 会制造超出证据范围的权威外观。

## Solution

让内部 compiler helper 只消费 `PreparedExecutableSourceV1`，用完整 root pin、Binding kind 和 local ID 构造 `root → binding` segments，并通过共享 identity registry 登记。disabled Binding 仍保留在命名空间，单独输出 `source_disabled_binding_paths`。helper 不进入 package barrel，也不生成独立 hash。

测试从 prepared source 独立构造 expected segments/path 和 disabled path，避免用被测输出反算期望；同时覆盖六种 kind、特殊字符 ID、root 隔离、canonical 排序、空 namespace、结构化错误与深冻结。

## Prevention

任何 closure 中间产物公开前，先回答它是否具备完整 verifier 和授权所需的全部事实。若答案是否定，保持内部、避免独立 hash，并在字段名中标明 source/intermediate 范围。

## Related

- [[2026-09-02-all-kind-schema-batch-validation]]
- [[session-2026-09-02]]
