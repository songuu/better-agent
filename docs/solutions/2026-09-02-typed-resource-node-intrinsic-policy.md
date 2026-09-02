# Resource node intrinsic policy 必须类型化，graph commitment 不得伪装

## 问题

Closure resource node 的 `intrinsic_policy` 曾接受任意 JSON。嵌套 Agent/Flow 适配器又把 pinned-graph node 展开后补上 `intrinsic_policy: {}` 与 `node_role: dependency`，以便调用 closure-node 校验器。这既允许 ad-hoc policy，也把“图承诺”和“closure 语义节点”混成同一 artifact。

## 解决

- `ClosureResourceNodeV1Schema` 的 root/dependency 分支统一要求完整 `CapabilityRequirementsV1`。
- `{}`、未知字段和资源私有结构均在公共 schema 处拒绝。
- nested closure join 改为严格解析 graph dependency commitment，仅允许 `node_id`、完整 pin、dependency manifest hash 和 nested closure hash。
- 该 commitment 只证明版本、图装配和 nested closure hash；真正的 typed intrinsic policy 从 independently verified nested closure 读取，适配器不再制造空 policy。

## 结果

领域合同 160/160、release-core 899/899。这个增量闭合了载体和 join 边界，但没有声称已经推导 Flow/internal Agent/Skill Pack 的 composite requirements；该推导仍必须使用验证过的源码和成员事实。
