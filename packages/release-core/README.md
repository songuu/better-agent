# @better-agent/release-core

`release-core` 是 G0-05 的纯函数边界：它把 strict domain contract 转为可持久化的 kind-specific prepared command，并统一计算 Release、dependency manifest、Deployment revision 与 admission snapshot 的 canonical hash。

当前边界：

- 使用 RFC 8785/JCS canonical JSON 与 `sha256:<64 lowercase hex>`；默认不重排数组，只有显式 set normalizer 可以改变集合顺序；
- Strategy Release、Flow Version 与 Experience Release 可生成 prepared command；Agent Release 在 compiler/capability-closure 前像权威化前、Deployment revision 在 conversation/change-set 前像权威化前均 fail closed；
- dependency pin 只有在本阶段物理 registry 已有 typed source/writer 时才能进入 manifest；调用方提供的 future Plugin/Skill/Knowledge 等 pin 即使哈希格式正确也会被拒绝；
- 校验 pinned dependency、Experience quick entry/public handle、credential requirement/mapping、stable Deployment 轴与 Agent/Flow admission snapshot；
- 不访问数据库或网络，不解析 secret，不创建 Run，也不产生最终授权结论。

```powershell
pnpm --filter @better-agent/release-core test
pnpm --filter @better-agent/release-core typecheck
pnpm --filter @better-agent/release-core build
```

数据库仍会用 composite FK、typed-source trigger、RLS 和受限函数独立校验持久化事实；应用层 prepared command 不是数据库授权凭据。当前数据库 publisher 只归 NOLOGIN owner，不能由 control role 直接调用；应用层边界也必须在同一事务内从数据库读取权威 registry pins，不能接受请求方提供的 registry snapshot。
