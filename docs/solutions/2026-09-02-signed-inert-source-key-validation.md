---
title: "签名内容源须单独验证公钥与可信来源"
date: 2026-09-02
tags: [solution, security, contracts, testing]
related_instincts: []
aliases: ["Ed25519 源签名边界"]
---

# 签名内容源须单独验证公钥与可信来源

## Problem

合法 SPKI 编码和底层验签成功并不足以证明 Instruction Skill 来自有效发布者公钥。身份点公钥可在当前 Node 验签行为下使不真实的内容签名通过；同时，候选提供自己的公钥不能建立发布者信任。

## Root Cause

DER/key algorithm 检查只覆盖封装格式；公钥点有效性、子群约束、签名严格编码及发布者 scope 是不同边界。测试若只使用正常生成的密钥和改变字节的负例，会遗漏退化点与表示规则缺陷。

## Solution

使用独立可信 signer 配置，逐项核对 Workspace/key/publisher/source/resource。实际文件 bytes 必须匹配签名覆盖的 manifest 长度与 hash；惰性资源绝不提取或执行。SPKI 解析再导出逐字一致后，使用锁定的 @noble/curves 2.4.0：

```ts
const point = ed25519.Point.fromBytes(publicKey, false);
if (point.equals(ed25519.Point.ZERO) || !point.isTorsionFree()) invalidSignature();
if (!ed25519.verify(signature, payloadBytes, publicKey, { zip215: false })) invalidSignature();
```

真实 Node 生成签名与真实库回归保留；单独隔离 mock-boundary 只验证 guard 顺序和选项。原退化公钥、混合子群与非规范表示、错误 scope、异常脱敏均有回归。内容签名只证明给定信任输入下的内容，不证明 registry provenance、当前撤销、runtime 或 host reviewer Acceptance。

## Prevention

- 使用固定版本成熟密码学实现，不写新曲线运算、不只黑名单一个样本。
- 测 base64/chunk 表示时保持 decoded bytes、hash 和签名不变，避免其他 guard 提前拒绝遮蔽目标检查。
- 依赖安装沿用 .modules.yaml 指定 store；不要为解决 pnpm 的非交互保护而盲目重建整个模块树。

## Related

- [[g1-a1-instruction-skill-review]]
- [[g1-a1-instruction-skill-debug-journal]]
- [[2026-09-02-composite-source-restriction-floors]]
