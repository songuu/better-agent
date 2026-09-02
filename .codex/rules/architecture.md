# Architecture decisions

## Product target and deployment reference are separate

- 用户于 2026-09-02 明确纠正：Better Agent 是对标 `ai.betteryeah.com` 的完整 Agent 应用，既有设计覆盖 Agent、工作流、知识库、数据库、工具集成、发布、运行与观测；不是文档站或数据库演示。
- `E:/project/ai/agent` 只作为服务器部署方式的参考，不用于替换本项目的产品定位、页面或功能范围。数据库、凭据与持久化数据保持独立。
- 代码尚缺前端、HTTP 服务或执行器时，归类为既定产品目标下的实施缺口，不再要求用户重新选择“文档站还是业务应用”。具体功能仍遵循既有设计、依赖与安全验收门。
- CI、PostgreSQL 健康、页面 HTTP 200 均不能单独代表完整应用交付；须分别核验页面、业务 API、真实运行、数据持久化与端到端用户流程。系统分区修改等运维权限仍单独处理。

## Executable admission gates are closed-world

- G1 前门以冻结 manifest 和 parsed CI schema 为事实源；“包含必需命令/文本”不足以准入。
- dirty source 只能物化到 content-addressed disposable checkout；不得 stash/reset/checkout 当前工作树。
- 本地机器证据与 host-attested acceptance 分层，Provider 不得自签 Receipt。

## Closure identity kernel

- G1-A1 identity primitives live in release-core and reuse closed domain schemas / canonical JSON. Agent and Flow will share this implementation; no runtime or network fallback is added to identity generation.
- `binding-path-lp-utf8/1` uses fixed typed tags and uint32be UTF-8 framing; `rn1` hashes the full JCS pin. Input is snapshotted without getters or Proxy traps; path bytes and per-compilation registry memory have separate absolute limits.
- Historical G0 admission is scoped to its recorded subject. A local environment outage does not itself revoke that admission or prevent pure kernel TDD; new source still needs fresh real database/full-gate evidence before completion or release.
