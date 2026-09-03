---
title: "Composite Binding 的完整需求包络与父路径收窄"
date: 2026-09-02
tags: [solution, release-core, capability, authorization]
related_instincts: []
aliases: ["composite requirement envelope", "nested call binding entry"]
---

# Composite Binding 的完整需求包络与父路径收窄

## Problem

Flow/SubAgent 父调用已有可信 invocation demand，child closure 也已有完整 requirements expression，但缺少一个不会扩大父路径操作权限的 composite Binding entry。

## Root Cause

只复制 child 数值下限会漏掉 credential、principal、egress、classification、effect、approval 与 operation；直接把 child operations 写入父 entry 又会创建新的授权别名。

## Solution

从同一棵 canonical expression 编译完整 requirements envelope：合取节点对 mode 取交集、对需求集合取并集，alternative 生成保守上包络，并始终保留原表达式。父 invocation 与 child root 组成 `nested_call`，完整 demand 先通过 exact path ceiling；证明成功后，父 entry 的 operation allow-set 再收窄为唯一 call operation，child operations 只保留在 child-prefixed entries。共享的 bounded policy parser 同时服务 leaf 与 composite compiler，避免两套 ceiling 语义漂移。

## Prevention

回归同时断言完整轴聚合、相同 requirement ID authority 冲突、canonical permutation/deep freeze，并证明 child operation 会影响 ceiling 判定但永远不会出现在 parent entry 的 operation set。

## Related

- [[2026-09-02-child-call-invocation-demand-provenance]]
- [[2026-09-02-capability-requirement-limit-envelope]]
- [[session-2026-09-02]]
