---
title: "Compiled nested closure 必须重算身份与完整 hash"
date: 2026-09-02
tags: [solution, contracts, architecture, security, testing]
related_instincts: []
aliases: ["nested closure verification", "compiled closure hash"]
summary: "对compiled closure先做有界无损closed parse，再重算node/path identity与完整closure hash；nested Agent/Flow按version tuple和graph承诺hash join，不混淆published hash与semantic seed。"
---

# Compiled nested closure 必须重算身份与完整 hash

## Problem

Agent/Flow dependency 的 `nested_closure_hash` 若只做格式校验，调用方可以提交自洽但未被实际闭包内容支持的 identity 或 hash。

## Root Cause

领域 Schema 负责结构与引用完整性，不会自动证明 content-addressed identity。并且 registry 上的最终 published contract hash 与 closure root 的 semantic seed hash 属于不同阶段，不能强制相等。

## Solution

新增私有 verifier：先在独立 closure 预算内复制纯数据，再做 closed Schema parse 与 canonical byte preservation；重算所有 resource node ID、可重建 Binding path 和排除 `closure_hash` 后的完整 artifact hash。nested Agent/Flow 再以 workspace、kind、resource、version、pinned mode 和 dependency graph 承诺的 nested hash 精确 join。

所有 set-like 顶层集合还必须按各自协议 key 严格递增且唯一；即使调用方为乱序或重复集合重算出自洽 hash，仍然拒绝。

## Prevention

保留 published hash 与 semantic seed 不同的正例，同时对 identity/hash/version drift、proxy/accessor 和超界集合做负例。

## Related

- [[2026-09-02-uniform-direct-slice-graph-composition]]
- [[session-2026-09-02]]
