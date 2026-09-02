# Nested intrinsic policy 只能从验证后的 child root 投影

## 问题

父 closure 需要为内部 Agent/Flow dependency 生成 resource node，但 pinned graph 只承诺版本、manifest 和 nested closure hash，不携带 capability requirements。让调用方额外提交 policy 会形成第二个未经证明的事实源。

## 解决

1. 严格解析 graph dependency commitment，并重算 published pin 对应的 node ID。
2. 完整验证 nested closure 的 canonical bytes、身份与 closure hash。
3. 以 version tuple 和 nested closure hash 连接 graph 与 child；published contract hash 不与 semantic seed hash混用。
4. 要求 graph dependency manifest 等于 child root resource node manifest。
5. 只从已验证 child root 复制 typed `CapabilityRequirementsV1`，在 graph published pin 下生成父 dependency resource node。

## 验证

Focused closure/nested suites 39/39，release-core 901/901；包含 manifest drift、hash drift、version drift 和 published/semantic hash 分层正例。Fresh repository-wide `pnpm check` 通过。Root 与 Skill Pack 的复合聚合仍未完成，也没有 PostgreSQL、host-attested 或生产验收声明。
