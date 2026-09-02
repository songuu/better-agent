---
title: "Canonical identity 输入的数组别名与 Proxy 重入"
date: 2026-09-02
tags: [solution, typescript, canonicalization, security, testing]
related_instincts: []
aliases: ["closure identity hostile input"]
---

# Canonical identity 输入的数组别名与 Proxy 重入

## Problem

能力路径编码的常规测试通过，但独立审查发现两种恶意 JavaScript 输入仍可能被接受：数字非索引属性掩盖数组空洞，以及 Proxy 在结构校验时执行陷阱并重入身份登记器。

## Root Cause

- `/^[0-9]+$/` 和属性数量不能证明连续数组；`4294967295` 是普通属性名，不是 JavaScript array index。复制后的 `map` 会忽略它，从而让带隐藏内容的输入与较短数组拥有相同摘要。
- `getPrototypeOf`、`ownKeys`、`getOwnPropertyDescriptor` 和 `length` 读取本身可能触发 Proxy 代码。拒绝 getter 并不等于禁止输入代码执行。

## Solution

`packages/release-core/src/closure-identity.ts` 在一切反射前通过 `node:util.types.isProxy` 拒绝 Proxy；数组索引同时要求规范数字形状、安全整数及小于原始 length，且 own-key 数量必须证明无空洞。先构造有界普通数据快照，再调用 closed schema 和 canonical encoding。

身份登记器仅在重复/碰撞/容量检查全部通过后写入 Map。公开接口没有可替换 hash 函数；SHA-256 碰撞通过测试模块 mock 注入，不进入生产 API。

## Prevention

- 永久保留 hole + numeric non-index、Proxy zero-trap、reentrant failure、forged array 和 revoked Proxy 回归。
- 分别测试原始字符串预算与最终 length-prefixed 编码开销；不能用同一个先触发的限制掩盖另一个限制缺失。
- 容量失败后重试同一个候选，必须持续 LIMIT；只查询旧条目不能证明失败没有提前污染 Map。
- 规范摘要验证覆盖每个 root/owner/target/resource pin，结构性 non-empty string 不是 SHA-256 校验。

## Related

- [[g1-a1-identity-debug-journal]] — TDD、独立审查和回修证据。
- [[2026-09-02-g1-a1-capability-closure-kernel]] — 后续编译器与 admission 任务边界。
