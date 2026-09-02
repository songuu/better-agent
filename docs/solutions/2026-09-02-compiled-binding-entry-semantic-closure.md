# Compiled Binding entry 的跨字段语义必须在公共契约闭合

## 问题

`CompiledBindingEntryV1` 的各字段单独合法，并不代表组合后仍是一个可执行且可审计的 Binding。若只验证字段 shape，调用方可以提交错误的 config 版本、异类 operation、与 operation 不一致的 effective allow-set、缺失的审批证据，或没有 Pack route 覆盖的 operation。

## 约束

- Binding kind 决定唯一的 config schema version；除 Skill Pack 外也决定唯一 operation kind。
- operation pins、dependency node IDs 和 Pack routes 都是 canonical unique sets。
- effective policy 的 operation hash 集合与 compiled operation pins 必须完全相等。
- effective side-effect ceiling 必须覆盖全部 operation；任一 operation 要求审批时，effective approval 也必须要求审批。
- effective approval 与 `approval_gate_spec` 必须双向一致，不能有无 GateSpec 的 required，也不能在 none 下夹带 GateSpec。
- `async_child_policy_hash` 只属于 Flow/SubAgent。
- Pack route 必须属于当前 Pack path，exposed/member contract hash 一致，引用已编译 operation，并覆盖全部已编译 Pack operation。

## 结果

公共 schema 现在直接拒绝这些跨字段漂移，release-core 的正例 fixture 也必须提供真实 operation 与 GateSpec 组合。这个增量只闭合最终对象的语义，不把尚未验证的 Flow/internal Agent/Skill Pack intrinsic requirements 当作可信来源。

## 验证

- domain semantic invariants: 11/11
- related release-core suites: 91/91
- domain typecheck/lint: pass
- full repository `pnpm check`: pass
- architecture mutation gate: 31/31

项目工具链必须优先解析锁文件固定的 Biome 2.5.10，不能误用 shell 全局的 2.3.14。没有 PostgreSQL、host-attested 或生产验收声明。
