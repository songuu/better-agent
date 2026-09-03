---
title: "Direct slice 必须绑定 pinned graph 有向边"
date: 2026-09-02
tags: [solution, contracts, architecture, security, testing]
related_instincts: []
aliases: ["graph-bound dependency slice", "pinned graph direct edge"]
---

# Direct slice 必须绑定 pinned graph 有向边

## Problem

direct source adapter 单独验证 exact pin 仍不能证明该依赖属于发布事务使用的完整依赖图；只检查节点存在又会让 transitive dependency 冒充 root 的直接依赖。

## Root Cause

source、path 与 graph 是分离阶段，缺少显式 join boundary。图中的 node membership 不携带父子关系，graph hash 也不能替代对 expected bytes 的完整重算。

## Solution

先从 candidate 重建完整 pinned graph 并逐字节核对 expected artifact，再按 full pin 匹配 requested root/dependency 节点，要求 requested root 等于 graph root，最后证明存在方向正确的 root→dependency edge。返回的 linkage 保留 graph hash、节点 manifest hash 与 nested closure hash，但明确不声明 registry provenance。

## Prevention

- 用存在于图中的 transitive node 验证 direct-edge guard。
- expected graph drift 与 candidate drift 分别测试。
- Flow/Agent 节点的 nested closure hash 原样保留，leaf 不虚构该字段。
- authoritative snapshot 只能由发布事务/registry 提供，helper 名称不得使用 attested。

## Related

- [[2026-09-02-skill-pack-route-hash-linkage]]
- [[2026-09-02-private-root-binding-path-compilation]]
- [[session-2026-09-02]]
