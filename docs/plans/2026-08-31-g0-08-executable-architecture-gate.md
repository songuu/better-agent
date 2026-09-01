<!-- tech-persistence:acceptance-protocol=v1 -->

# G0-08 可执行架构门

> 状态：实现与 L4 五视角独立 Review 已完成，最终终审为 P1/P2=0；最终本机 clean-checkout 重跑结果写入 `.handoff/g0-08-final-local-gate.json`，避免证据回填改变已验 source digest。Sprint Acceptance v1 仍为 `pending`，尚未获得 host-attested passed Receipt，因此当前不能关闭 G0-08 或进入 G1。

## 原始请求

在 G0-07 已完成且 Sprint 已关闭的基础上继续后续流程；严格先完成 G0-08，再决定是否进入 G1。

## Think：要做 / 不做

### 要做

- 把 G0-02、G0-04～G0-07 已有的 contract、OpenAPI、PostgreSQL 16、RLS/security、Run/billing、lease/fencing 与 recovery 证据聚合为单一 `pnpm architecture:gate`。
- 让聚合门对 mock、skip、缺失 suite、未解析 OpenAPI 引用、迁移集合漂移和非零子进程显式 fail closed。
- 在不修改用户 Git 索引、不提交当前分支、不覆盖共享工作区变更的前提下，提供 disposable clean-checkout 验证与可审计报告。
- 将机器证据、失败原因、环境边界和 G1 准入结论写回唯一 G0-08 计划事实源。

### 不做

- 不实现 G1 的 Capability Closure、ResolvedPlan、Agent、Flow、Knowledge、Database capability、Plugin/MCP、Skill 或 SubAgent runtime。
- 不把本地 disposable PostgreSQL、临时 clean-checkout 或静态 OpenAPI 检查冒充生产、云端、客户端、pooler 或真实 driver 证明。
- 不通过删测、改成 mock、允许 skip、放宽安全断言、提交当前分支或隐藏首次失败来制造绿色结果。

## 可观察成功标准

1. **WHEN** 从仓库根运行 `pnpm architecture:gate`，**THE SYSTEM SHALL** 以一个命令聚合 OpenAPI 3.1 semantic lint/bundle/example/local-ref、workspace contract、完整 migration/RLS/security、Run/billing/recovery 与现有六套 PostgreSQL 16 证据；任一子门失败时保留原始上下文并返回非零。
2. **WHEN** suite、migration、OpenAPI operation/ref、关键安全 fixture 或架构门注册表发生缺失/重复/顺序漂移，**THE SYSTEM SHALL** 在执行 G1 前 fail closed，且不得以 mock、skip、空匹配或仅检查退出码放行。
3. **WHEN** 架构门在当前共享 dirty worktree 与 disposable clean-checkout 中运行，**THE SYSTEM SHALL** 不修改用户 Git index/branch，不丢失现有改动，并证明 clean-checkout 输入有确定的 manifest/digest 与零非忽略工作树漂移。
4. **WHEN** PostgreSQL 16 集成门完成，**THE SYSTEM SHALL** 对空库 up、down/reapply、RLS/跨租户/连接复用/临时表遮蔽/权限拒绝、Run/账务/child allocation/HumanGate/retention、lease/fencing/recovery 产出无 mock/skip 的逐套结果，并保留独立 readback 边界。
5. **WHEN** 所有 G0-08 机器门和独立 Review 均通过，**THE SYSTEM SHALL** 明确输出 G1 准入结论、证据哈希与仍未知的生产/云端边界；否则状态保持 G0-08 阻断。

## 风险、假设与待验证项

- **L4 风险假设：** 虽然原总计划将聚合脚本标为 L3，但它决定是否进入 G1，并执行完整安全/数据库门，因此本 Sprint 按 L4 验证。
- 当前工作区包含 G0-07 及其他共享改动；clean-checkout 实现必须使用独立临时目录和隔离 Git 元数据，禁止 stash/reset/checkout 覆盖用户文件。
- 当前仓库只有 `architecture:framework`，尚未确认 OpenAPI 工具、CI provider、clean-checkout 依赖安装和架构门 registry 是否齐全；这些属于 Plan 前的代码库事实检查。
- Sprint Acceptance v1 当前没有 host-attested reviewer channel；这不会被伪装成 passed。若运行时在 Review 阶段只能签发 `unknown`，必须按协议保持阻断并报告该控制面限制。

## 下一步

读取 `.handoff/g0-08-final-local-gate.json` 的最终本机证据；随后等待宿主提供不可由 Provider 自签的 host-attested reviewer capability。Receipt 未通过时保持 Review 阻断，不以本地机器门或模型自评替代。

## Plan：当前事实与关键取舍

### 已验证代码库事实

- 当前 `HEAD=e66f4ca25b43f77872c8f4e5fd9a9678b125ecb2` 已包含 G0-07；本轮启动前的剩余工作树差异只有 Sprint completed record 被状态机消费，以及新 active pointer/本计划。
- `@better-agent/api-contract` 已使用 Redocly OpenAPI Core、YAML duplicate-key preflight 与 `openapi-typescript`，覆盖 OpenAPI 3.1 lint、bundle、example、local ref、external ref 拒绝、generated artifact drift、response breaking baseline 和 credential-operation policy baseline。当前权威结果为 11 operations、314 local refs。
- migration 物理集合为 `000..005`，其中 `000..002` 只有 up，`003..005` 有 up/down；`@better-agent/db test:integration` 串行运行六套真实 PostgreSQL 16 harness。
- 当前 CI 将质量门和 PostgreSQL 门分开执行，尚无 `architecture:gate`；`migration-loader.test.ts` 在 Windows 以 `it.runIf` 跳过 symlink fixture，不满足本轮“无 skip 放行”的聚合门要求。

### 方案概述

采用“**一个声明式 manifest + 一个纯校验核心 + 一个外层 clean-snapshot runner**”的单事实源方案：

1. `tests/architecture-gate/manifest.json` 精确冻结 OpenAPI operation/ref、迁移文件、六套 PG runner、根/DB scripts 与必须真实执行的 gate；任何缺失、重复、顺序变化或 `mock|skip` mode 均拒绝。
2. `scripts/architecture-gate-core.mjs` 只做无副作用的 schema、inventory、源码注册表和结果归一化；Node 原生 mutation tests 证明每类弱化都变红。
3. `scripts/architecture-gate.mjs` 在 clean CI checkout 中直接执行；在本地 dirty source 中只读取 Git tracked+untracked/non-ignored 当前文件，计算确定性 source manifest digest，复制到 `mkdtemp` 隔离目录、建立仅属于临时目录的 Git commit、离线安装依赖，再在 clean snapshot 中执行同一内部 gate。它禁止 stash/reset/checkout、禁止修改用户 index/branch，并在退出前核对 source status digest 未变化。
4. 内部门严格串行运行 manifest preflight、`pnpm check` 和 `pnpm db:test:postgres16`；命令按参数数组 spawn，不经 shell，不只消费 exit 0，还核验 registry/产物/测试摘要与 clean status before/after。
5. CI 的 PostgreSQL job 收敛为专用 G0-08 job，唯一执行入口为 `pnpm architecture:gate`；Windows/Ubuntu quality matrix 保留，以继续覆盖平台差异。

### Before / After 契约

| 表面 | Before | After | 消费者 / 一致性门 |
|---|---|---|---|
| 根架构命令 | `architecture:framework = check + db:test`，不证明 clean checkout/registry | `architecture:gate` 是唯一 G1 前聚合入口；framework 保留为开发反馈环 | 本地开发、CI、G0-08 Review、后续 G1 准入 |
| OpenAPI | checker 自己证明 11 operations/314 refs 与 generated/breaking | gate manifest 额外精确登记 operation/ref 与 toolchain entry | api-contract tests、gate core mutation、CI |
| Migration / PG suites | DB package 内字符串串联六套 runner | manifest 精确登记 000～005 物理集合、方向和六套顺序，并与 package script 双向核对 | DB package、PG harness、gate core |
| Git 工作树 | dirty source 只能运行 framework；CI checkout clean 但未显式断言 | dirty source 只用于生成 content-addressed disposable snapshot；内部执行前后必须 clean | local runner、CI、Review evidence |
| Skip/mock | Windows 有一个条件 skip；真实/模拟由各 test 自己表达 | gate 自身和数据库关键链禁止 skip/mock/empty registration；symlink fixture 跨平台运行 | Vitest、gate mutation、CI |

## 有序任务与依赖

### T1 — 架构门 manifest、纯核心与 mutation red gate

- **目标：** 先让缺 suite、重复 migration、operation/ref 漂移、错误 command、`mock|skip` mode、空结果和非零子门全部确定失败。
- **文件：** 新增 `tests/architecture-gate/manifest.json`、`tests/architecture-gate/architecture-gate.test.mjs`、`scripts/architecture-gate-core.mjs`。
- **依赖：** Think/Plan；无实现依赖。
- **风险：** L3，串行。
- **完成证据：** `node --test tests/architecture-gate/architecture-gate.test.mjs` 先红后绿；至少覆盖每个 registry 维度一项 mutation，且 fixture 不调用 Docker。

### T2 — Dirty source 到 disposable clean checkout 的 runner

- **目标：** 单命令安全物化当前非忽略工作树，在临时 Git checkout 中离线安装并执行内部门，输出 source/gate manifest digest 与逐门结果。
- **文件：** 新增 `scripts/architecture-gate.mjs`；修改根 `package.json`。
- **依赖：** T1。
- **风险：** L4，串行。
- **完成证据：** runner 单元/进程测试证明 path traversal/symlink/源状态漂移/临时 checkout 漂移/安装或子门失败均非零；真实执行前后 `git status --porcelain=v1 -z --untracked-files=all` 字节摘要一致，用户 index/HEAD 不变。

### T3 — 无 skip 与真实 PG 注册表闭合

- **目标：** 移除 Windows 条件 skip，并让 symlink/non-regular migration guard 在各平台执行；双向核对六套 runner 与 000～005 migration inventory。
- **文件：** 修改 `packages/db/test/migration-loader.test.ts`，必要时只调整 `packages/db/src/migrations/load.ts`；修改 `packages/db/package.json` 仅在 registry 一致性需要时进行。
- **依赖：** T1。
- **风险：** L3，串行；不与 T2 并行修改 gate registry。
- **完成证据：** DB unit suite 无 skipped test；manifest mutation 和实际 package script inventory 一致；六套真实 PG16 都运行且逐套成功。

### T4 — CI 与运行手册接入

- **目标：** CI 使用唯一架构门，文档明确本地 dirty snapshot、clean CI、失败边界与 G1 阻断关系。
- **文件：** 修改 `.github/workflows/ci.yml`、`README.md`、`infra/test/postgres/README.md`、`docs/07-实施计划.md`、`docs/plans/2026-08-25-architecture-readiness-and-implementation.md`。
- **依赖：** T1～T3。
- **风险：** L2，但因共享入口与状态文档串行。
- **完成证据：** workflow 静态检查精确包含 `pnpm architecture:gate` 且无跳过参数；文档不把本地证据升级为生产/云端完成。

### T5 — L4 全量执行、证据回填与 G1 准入判定

- **目标：** 先跑最窄 gate core，再跑 dirty-source disposable clean checkout 的完整 `pnpm architecture:gate`，最后复查原工作树未变并回填哈希/计数/首次失败。
- **文件：** 只更新本计划及上层状态文档；不修改测试来迁就失败。
- **依赖：** T1～T4。
- **风险：** L4，串行。
- **完成证据：** clean snapshot 内 `pnpm check`、六套 PG16、zero skip、zero tracked/untracked drift 均通过；独立 Review 无 P0/P1/P2 后才形成 G1 准入候选。Acceptance v1 若无 host-attested passed Receipt，Sprint 仍停在 Review，不能由这些本地证据越权关闭。

## 测试策略与停止条件

1. `node --test tests/architecture-gate/architecture-gate.test.mjs`：manifest/schema/mutation/snapshot helper 最窄环。
2. `pnpm --filter @better-agent/db test`：跨平台 non-regular migration fixture 和 static registry。
3. 内部 clean gate 的 `pnpm check`：format/lint/workspace/contracts/typecheck/unit/build，要求无 skip。
4. 内部 clean gate 的 `pnpm db:test:postgres16`：六套真实 disposable PostgreSQL 16 串行门。
5. 外部 runner readback：source status/HEAD/index 不变、snapshot clean before/after、manifest/report digest 可重算。

以下任一出现立即停在 G0-08：registry 空匹配或漂移、OpenAPI generated/breaking/example失败、migration/suite 不是精确集合、任何关键 gate skip/mock、Docker/PG16不可用、离线依赖不能物化、snapshot 非 clean、源工作树被 runner 改写、子命令退出 0 但缺少语义结果、Acceptance Receipt 不是 host-attested passed。

## Work 执行结果

### 实现范围

- 新增 `tests/architecture-gate/manifest.json`，冻结 000～005 migration、六套 PostgreSQL 16 runner、11 个 OpenAPI operation、314 个 local ref、关键生成物哈希与两个真实 gate。
- 新增 `scripts/architecture-gate-core.mjs` 与 11 项 Node mutation/snapshot 单测；对缺失、重复、重排、mock/skip、命令/marker 漂移、结果缺失、非零退出、路径越界、单链接文件身份和源状态漂移 fail closed。
- 新增 `scripts/architecture-gate.mjs`：dirty source 只读生成 source manifest，在 `mkdtemp` 隔离目录复制非忽略 single-link regular product files、排除 `.handoff`/Acceptance 控制面 sidecar、建立临时 Git commit、离线安装并执行内部门；前后核对源 status/HEAD/index 与临时 checkout clean 状态。
- 根命令新增 `pnpm architecture:gate`；CI PostgreSQL job 收敛到该唯一入口，workspace smoke 同时拒绝 CI 绕过架构门直接调用数据库门。
- Windows migration non-regular fixture 改为 junction/symlink 跨平台真实执行，DB unit suite 不再条件 skip；Biome 排除 Sprint 状态机 sidecar 与已生成 API 目录。
- README、PostgreSQL 运行手册、实施计划与总架构计划均已更新本地/CI/生产证据边界。

### TDD 与失败账本

1. gate test 首次因纯核心尚不存在而以 `ERR_MODULE_NOT_FOUND` 变红；实现后 mutation/snapshot tests 10/10。
2. CI rule 测试首次因 `validateCiWorkflow` 尚不存在而变红；实现后 test-support 11/11，并拒绝 workflow 绕过 `pnpm architecture:gate`。
3. 首次完整快照门在 lint 阶段暴露控制字符正则、Turbo 未声明环境变量和 `finally` 抛错覆盖原失败；逐项修正并保留明确错误上下文。
4. 第二次完整门在 workspace smoke 暴露旧规则仍要求 CI 直接运行 `pnpm db:test:postgres16`；规则改为只允许唯一架构门并由测试覆盖。
5. 第三次完整门的六套 PostgreSQL 16 均通过，但汇总器把 Node 报告 `skipped 0` 误判为存在 skip；新增先红后绿回归，允许显式零计数且继续拒绝 `1 test skipped`。
6. 后续验证先被 Biome 的确定性换行格式拦截，未进入数据库阶段；应用同一格式后，最窄 gate tests 10/10 与 `git diff --check` 均通过。
7. 第一轮 Review 的负向探针确认三项 P2：PostgreSQL suite marker 可与 gate marker 脱钩、CI 注释文本可伪装真实 `run:`、snapshot 读前检查后缺少同一文件句柄身份复核。状态机按协议 `review -> work`；新增红测后分别绑定六个 suite marker、要求精确可执行 `run:` 行、以单链接 regular file handle 做读前/打开后/读后 identity 校验。修复后 gate tests 11/11、test-support 12/12、`pnpm check` 全绿。
8. Review 修复后的首次完整重跑在 temporary `git add` 以 exit 128 失败；原错误包装只显示退出码，先补充 8 KiB 有界 stderr 尾部后复现，确认根因是 Sprint attempt seal 被错误纳入产品源码快照并触发 Windows 长路径。runner 现显式排除 `docs/plans/.handoff/**` 与 `*.acceptance.json`，保留这些控制面文件原样且新增 Git path-list 回归；gate tests 11/11、format 与 `git diff --check` 通过。
9. 控制面排除修复后的完整门已通过 quality 与前五套 PostgreSQL 16，但 runtime-security 的“缺失账务回执”手工 fixture 以 SQLSTATE 23514 失败：同一 `UPDATE` 对 `settled_at`/`updated_at` 分别调用 volatile `clock_timestamp()`，本次产生 1 微秒逆序。确认生产 kernel 共用单一 `authorized_at` 后，仅将该 disposable fixture 两列改为同一 `statement_timestamp()` 并加静态回归；runtime-security migration tests 40/40。
10. 最终加固把 runner 拆为 runtime/snapshot/PostgreSQL 生命周期模块，所有命令增加有界输出、超时和错误聚合；dirty outer 与内部 PG harness 共享精确临时 registry，清理失败保留 registry 并在外层重试，拒绝重复、非规范或生产样式 project id。
11. CI 审查从文本存在性升级为 YAML `uniqueKeys` + 禁 anchor/alias + parsed object 与冻结 G0-08 schema 深度相等，精确锁定 push/PR 触发器、read-only permissions、Ubuntu/Windows matrix、action 版本/输入、run 顺序与执行上下文；37 项弱化探针全部拒绝。
12. Windows runner 不再继承 npm executable 环境路径，固定经 `cmd.exe /d /s /c pnpm.cmd` 启动，并在解释前拒绝命令元字符；最终回归为 gate 26/26、test-support 13/13，code-quality 与 security/integrity 终审均 PASS。
13. 终端的 ANSI/空格差异曾导致真实 `80 passed` 被 exact-byte marker 误拒；逐行归一化的首版又被 Review 发现存在跨行、数字前缀和 PostgreSQL 短 marker 互相代签。最终改为完整逻辑分行 + 横向空白归一化 + 整行相等，六个 PG runner 在全部断言后输出唯一 `architecture-gate-suite/1 <suite-id> pass`；逐套删除、嵌入、相邻数字与八类行终止符回归全部 fail closed。

### 2026-09-01 最终冻结边界

- 产品输入在本段写入后冻结；最终 `pnpm architecture:gate` 的 source/gate manifest、quality/PG 输出摘要、cleanBefore/cleanAfter 与源 readback 只写控制面 sidecar `.handoff/g0-08-final-local-gate.json`。
- L4 五视角结论：architecture PASS、performance PASS、test-strategy PASS、code-quality PASS、security/integrity PASS；blocker/P1/P2 均为 0。
- 这些结论仅形成本地 G1 准入候选，不改变 Acceptance authority：没有 host-attested passed Receipt，G0-08 仍是阻断态。

### 首轮 L4 机器证据（Review 修复前）

| 证据 | 已验证结果 |
|---|---|
| disposable source | 277 files、4,824,594 bytes、`sha256:c26b5b4d2594b4505d13f4d391b3eddf48b6600ff236a62634de958e30197735` |
| gate manifest | `sha256:1394cf5951d0d2a0171a1e1ae3518333e3be48cd4dca542d4589e7f70459f520` |
| quality gate | exit 0、45,309 ms、output `sha256:7159184feccb9a85305e79f4d304b7ceb6f016352e24e191babcda4575ab35f8` |
| PostgreSQL 16 gate | exit 0、634,495 ms、output `sha256:cf88d407bbed390083cd64c7f93744f62fcfa2b0024bcf0a206b93c884c088d0` |
| format/lint/workspace | 200 files format clean；9/9 package lint；workspace smoke 9 packages |
| contract/type/build | OpenAPI 11 operations/314 refs；type/build 14/14；final build 9/9 |
| unit tests | 472 passed：test-support 11、api-contract 16、domain 53、auth 48、release 33、billing 43、run 103、API 80、DB 85；zero fail/skip |
| PostgreSQL suites | migration lifecycle、auth/RLS、release/deployment、Run/Billing、Conversation/browser、runtime-security 六套逐套通过 |
| checkout integrity | report `cleanBefore=true`、`cleanAfter=true`；原工作树 `HEAD=e66f4ca25b43f77872c8f4e5fd9a9678b125ecb2` 未变，`git diff --check` 通过 |

机器门只证明 disposable clean checkout 与 disposable PostgreSQL 16。生产 DB、pooler/session affinity、真实 driver bind、server/WAL crash、Worker/provider/client/cloud/APM 仍未验证；CI workflow 已静态接入但云端 run 状态未知。

### Review 修复后的最终 L4 机器证据

| 证据 | 已验证结果 |
|---|---|
| disposable source | 275 files、4,830,220 bytes、`sha256:0b18450a80885bdfb68ec6d9d7a547c97e92054aa3b70bfad9d12d9dc218cb12`；该 digest 对应最终门禁输入，排除 `.handoff`/Acceptance sidecar，证据回填文本在命令成功后追加 |
| gate manifest | `sha256:1394cf5951d0d2a0171a1e1ae3518333e3be48cd4dca542d4589e7f70459f520` |
| quality gate | exit 0、43,416 ms、output `sha256:9898b31d29237b9f672a89fc2f76463cc0df66ddacef30250b71361ea386c647` |
| PostgreSQL 16 gate | exit 0、620,799 ms、output `sha256:11c25419b66fa4f126f9960e33740b93ecf8c49a49fe9ebd4ae1d04f9fd14cc9` |
| mutation / package tests | gate tests 11/11；473 package tests（test-support 12、api-contract 16、domain 53、auth 48、release 33、billing 43、run 103、API 80、DB 85）；zero fail/skip |
| static / build | 200 files format clean；9/9 lint；workspace smoke 9 packages；OpenAPI 11 operations/314 refs；14/14 type/build；final build 9/9 |
| PostgreSQL suites | migration lifecycle、auth/RLS、release/deployment、Run/Billing、Conversation/browser、runtime-security 六套逐套通过；runtime-security 已覆盖修复后的 metering-first fixture |
| checkout integrity | report `cleanBefore=true`、`cleanAfter=true`、`result=pass`；原工作树状态由 runner 字节级复核未漂移 |

这些证据仍只证明 disposable clean checkout 与 disposable PostgreSQL 16；生产 DB、pooler/session affinity、真实 driver bind、server/WAL crash、Worker/provider/client/cloud/APM 仍未验证，CI provider 云端 run 状态未知。

## 回滚、恢复和未知项

- 所有产品代码改动均为新增 gate/测试或可逆 script/workflow 文本；失败时保留当前分支与 index，临时目录由 runner 在核对其 `mkdtemp` 前缀后清理。
- runner 不操作 stash、reset、checkout、当前分支引用或当前 index；临时 Git commit 仅存在于临时目录，不能被报告为仓库 commit。
- CI provider 的真实云端执行状态在本地不可知；本轮只能验证 workflow definition 与本地等价 gate。
- 生产 DB、pooler/session affinity、真实 driver bind、server/WAL crash、Worker/provider/client/cloud/APM 继续未知，不属于 G1 准入的本地假证明。

## Sprint Acceptance v1 输入

```json acceptance-contract-input-v1
{
  "acceptanceProtocol": "v1",
  "sourceRequirement": "继续 G0-07 之后的后续流程，先完成 G0-08 可执行架构门，再决定是否允许进入 G1。",
  "criteria": [
    {
      "id": "ac-g0-08-aggregate",
      "statement": "pnpm architecture:gate 以单一 fail-closed 入口聚合 OpenAPI、workspace contract、完整 migration/RLS/security、Run/billing/recovery 与六套 PostgreSQL 16 证据，并为任一子门失败返回非零和有上下文的结果。",
      "sourceRefs": ["docs/plans/2026-08-31-g0-08-executable-architecture-gate.md#可观察成功标准", "docs/plans/2026-08-25-architecture-readiness-and-implementation.md#g0-08--可执行架构门"],
      "oracle": {
        "type": "independent-review",
        "procedure": "独立审查架构门 manifest、runner、命令结果与失败传播，核对所有声明子门均真实执行且错误上下文保留。",
        "expected": "聚合入口不存在空匹配、仅退出码放行或遗漏子门，任一 mutation 和真实子门失败均阻断。"
      }
    },
    {
      "id": "ac-g0-08-registry",
      "statement": "suite、migration、OpenAPI operation/ref、关键安全 fixture 或 gate command 的缺失、重复、顺序漂移和 mock/skip mode 必须在进入 G1 前 fail closed。",
      "sourceRefs": ["docs/07-实施计划.md#g0-08-可执行门进入-g1-前阻断", "tests/architecture-gate/manifest.json"],
      "oracle": {
        "type": "independent-review",
        "procedure": "独立复核 manifest schema、双向 inventory readback 与 mutation tests，逐项变异 registry。",
        "expected": "每一类缺失、重复、顺序、mode 或结果弱化 mutation 都产生确定非零失败。"
      }
    },
    {
      "id": "ac-g0-08-clean-checkout",
      "statement": "dirty source 只能通过隔离的 content-addressed disposable clean checkout 执行，不修改用户 Git index、HEAD、branch 或现有文件，并证明 snapshot 执行前后 clean。",
      "sourceRefs": ["docs/plans/2026-08-31-g0-08-executable-architecture-gate.md#方案概述", "scripts/architecture-gate.mjs"],
      "oracle": {
        "type": "independent-review",
        "procedure": "独立核对 snapshot file selection、path/link 边界、source status digest、临时 Git 元数据、cleanup 和真实 dirty-source 执行前后 readback。",
        "expected": "source HEAD/index/status 字节不变，snapshot digest 可重算，临时 checkout 在 gate 前后均无非忽略漂移。"
      }
    },
    {
      "id": "ac-g0-08-postgres",
      "statement": "PostgreSQL 16 门真实执行六套 migration/RLS/security/Run/billing/browser/recovery harness，覆盖 up/down/reapply、角色拒绝、并发与独立 readback，且无 mock/skip 放行。",
      "sourceRefs": ["infra/test/postgres/README.md", "packages/db/package.json", "tests/architecture-gate/manifest.json"],
      "oracle": {
        "type": "independent-review",
        "procedure": "独立审查六套 runner 注册、逐套输出、PostgreSQL server/extension metadata、失败传播和 skip 统计。",
        "expected": "六套精确各运行一次并成功，测试摘要 skip=0，真实 PostgreSQL 证据与独立 readback 边界完整。"
      }
    },
    {
      "id": "ac-g0-08-admission",
      "statement": "只有全部 G0-08 机器门和独立 Review 通过才可形成 G1 准入结论，同时必须保留生产、云端、driver、pooler、Worker 与客户端未知边界。",
      "sourceRefs": ["docs/plans/2026-08-31-g0-08-executable-architecture-gate.md#风险假设与待验证项", "docs/07-实施计划.md#g0-08-可执行门进入-g1-前阻断"],
      "oracle": {
        "type": "independent-review",
        "procedure": "独立核对最终证据表、首次失败记录、G1 准入文字、未验证边界和 Sprint Acceptance authority 状态。",
        "expected": "没有把本地/临时证据升级为生产完成；任一门或 Receipt authority 未通过时继续标记 G0-08 阻断。"
      }
    }
  ]
}
```
