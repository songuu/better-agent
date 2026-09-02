---
title: "Schema 引用语义和 Worker 生命周期必须独立验证"
date: 2026-09-02
tags: [solution, contracts, testing, validation]
related_instincts: []
aliases: ["JSON Schema 动态引用假绿", "Worker 退出才释放并发额度"]
---

# Schema 引用语义和 Worker 生命周期必须独立验证

## Problem

JSON Schema 引擎能成功编译不代表所有引用目标都正确。另一方面，返回未修改的父线程快照会掩盖 worker 内默认值填充，自动 exit 的 fake 会掩盖并发槽过早释放。

## Root Cause

固定 Ajv 8.20.0 对部分 `$dynamicRef` pointer/普通 anchor/未激活 nested dynamic anchor 回退为 root validator：嵌套整数被拒绝，嵌套 object 反而通过。原测试只有根递归，无法捕获。默认字段非 required 时，worker 即使插入默认值，父线程仍返回原快照；fake terminate 立即 exit 则没有停止与退出之间的窗口。

## Solution

单资源 profile 禁 nested `$id`、external refs、duplicate anchors，先验证原 profile/meta-schema，再将已确认的 anchor 转 pointer、dynamicRef 转 static ref。同节点双引用向 allOf 尾部追加约束，不覆盖已有字段/索引；仅变换 worker 副本，原 source/hash 保留。这一静态降级基于单资源限制，不能推广到多资源动态作用域。[规范依据](https://json-schema.org/draft/2020-12/json-schema-core)。

```ts
// Return-value identity alone cannot detect data-changing validation.
await expect(validate({
  type: 'object',
  properties: { count: { type: 'integer', default: 1 } },
  required: ['count'],
}, {})).rejects.toThrow('JSON_SCHEMA_INSTANCE_INVALID');
```

测试使用真实引擎验证三种引用目标、根递归、双引用/sibling/旧 pointer index；生命周期单独用受控 fake 验证四槽满载、terminate 请求后仍 BUSY、实际 exit 后恢复、terminate rejection 与重复停止幂等。Worker 不是 OS sandbox；它只承担固定校验代码的响应性/资源边界。

## Prevention

- 完整 profile 参与 validation contract hash；Schema 校验证据与源身份、registry/host provenance 分开。
- 负例须触发业务判定，而不只比较返回快照。useDefaults、4096-node guard、slot release 和 stop 去重的内存变异均应被回归捕获。
- 独立检查 Schema/instance、source artifact 和新增 evidence wrapper 的预算，合法输入不保证更大输出合法。
- 返回 JCS 数据快照使用 null prototype；Node strict object equality 的冒烟断言应明确此契约，不把 prototype 差异误报为数据差异。

## Related

- [[g1-a1-json-schema-debug-journal]]
- [[g1-a1-json-schema-review]]
- [[2026-09-02-g1-a1-capability-closure-kernel]]
