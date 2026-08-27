# G0-06 Run/Billing/Outbox/Idempotency/HumanGate 事实层

> 状态：T0～T9、全部 Review/Work 回路与收口修复已在本地完成，最终增量审查无可操作 finding，最新组合门禁全绿；前置 G0-05 已在本地实现并通过 disposable PostgreSQL 16 门禁。本文记录 G0-06 Sprint 的本地完成态，不把设计或本地测试等同于生产部署。

## Think：产品边界

### 要做

- 建立 closed/versioned 的 Run acceptance、typed-principal Conversation、idempotency、Run/Attempt/Step/Event、Checkpoint、HumanGate、Outbox、credit reservation/ledger/current billing state 与 terminal snapshot 契约。
- 在 `run-core` 中统一 canonical intent、acceptance receipt、不可变 admission snapshot pin、状态转换与 terminal snapshot 的纯函数边界；在 `billing-core` 中统一 reservation/ledger intent、金额与状态不变量。
- 以新的 004 migration 建立 Workspace 直属事实、composite key/FK、append-only/immutable trigger、`ENABLE + FORCE RLS`、固定 `search_path` 的 kind-specific definer primitive 与受审 down guard。
- Conversation 同时支持可信 `credential:<uuid>` 与 `end_user:<uuid>` principal，以判别列和两组 Workspace-scoped composite FK 保证恰好命中一种；创建时固定 stable Agent Deployment、创建 revision 与 `conversation_contract_hash`。Conversation state 使用单调 `state_version`，所有 variables/session-store mutation 必须 CAS；Chat 幂等 miss 在同一事务追加唯一 user message、推进 state version并让 Run 固定该版本，禁止消息与 Run 半提交。Conversation create 不接受 `Idempotency-Key`。
- root Run 的事实装配必须区分并固定 G0-05 `admission_snapshot_hash` 与独立权威 `accepted_plan_hash`/output-schema pin，并在一个事务中保存稳定 Deployment/revision/Release pin、Conversation contract/state version、idempotency intent、恰好一个初始 Run Event、按 closed kind+dedupe intent唯一的一组 Outbox 与恰好一笔 top-level credit reservation；零成本也写额度为 `0` 的 reservation，不能省略账务事实。
- original-Run read/cancel/events 只能从持久 Run target与接受 principal解析，不重新选择 Deployment或 active pointer；service credential 必须重验同 kind、同 stable Deployment的当前 literal scope/grant/security fence。browser 路径拆成两段：先用不读 active pointer/revision 的 session identity primitive 得到 Workspace/end-user namespace，再锁幂等 key 并以持久 Run target执行第二次 session/principal/Deployment epoch授权。Gate resume还需要独立 approver policy，本轮不借用普通 `run:resume` 绕过。
- 建立 retention horizon、事先注册且不可变的 archive manifest/verification/approval receipt、EVENTS/RECOVERY purge receipt和 owner-only purge primitive；只在 disposable PostgreSQL 夹具执行正负路径，不实现生产 scheduler，也不删除 ledger或terminal tombstone。
- 为后续 G0-07/G1 保留窄 adapter seam 和真实 PostgreSQL 16 攻击夹具；在可信 Plan provider、phase attestation、lease/fencing、可信 output validator或已发布 GateSpec尚未存在时，应用 acceptance、reservation、finalization与HumanGate正向 mutation保持不可调用，只有NOLOGIN owner和disposable fixture可验证事实层装配。

### 不做

- 不实现 G1 closure canonicalizer、policy meet、`ResolvedAgentPlan`、Agent/Flow compiler/executor、模型/工具调用或真实成功输出。
- 不创建公开 HTTP handler、SSE endpoint、浏览器客户端、生产 queue/worker、真实连接池/APM 或云端部署。
- 不提前实现 G0-07 executor attestation、lease/fencing/recovery claim或retention scheduler；普通 `ba_runtime` 不获得acceptance、账务、finalization、Gate、Event、Outbox或purge原始写权限。
- 不开放 child Run；G1 之前一律拒绝 parent link。只冻结未来唯一允许的 `join + cascade + safe_summary + wait_for_settlement` 契约，不保留 detach 兼容值。
- 不允许成功终态绕过 registry-backed output validator，不允许 caller 自报 billing/terminal result，不允许caller提交自证的admission snapshot/Plan hash，不实现ledger删除。
- 不提供成功的submit/approve/reject/expire/resume应用路径；本轮只建立HumanGate/Gate mutation的closed schema、JCS纯契约、RLS和permission-denied/`0A000`零副作用夹具，等待G0-07 lease/fence与后续published GateSpec。

### 可观察的成功标准

1. **WHEN** 同一 `(workspace, authenticated principal, fixed route template, key)` 以同一canonical intent重试，**THE SYSTEM SHALL** 先锁key并通过历史Run read gate，再返回保存的canonical status/data且不新增事实；当前exchange的`request_id`/`now_time`重新生成。不同intent或target在同一namespace冲突，不同route namespace可复用相同裸key。幂等hit不得读取active pointer、Conversation contract、Plan或再次预留。
2. **WHEN** owner-only fixture提供数据库可验证的admission snapshot与独立Plan pin并接受root Run，**THE SYSTEM SHALL** 在一个事务中固定target、`billing_state=PENDING`、恰好一个accepted Event、按kind/dedupe唯一的一组Outbox和恰好一笔reservation；Agent Chat还必须从Deployment revision不可变canonical document读取并固定Conversation contract/state/message，direct Flow必须没有任何Conversation字段。任一子写入失败整体回滚，准入身份列之后不可修改。fixture的NOLOGIN owner权限不等于生产Plan authority；没有可信Plan provider时应用路径必须permission denied或`0A000`。
3. **WHEN** original-Run read/cancel/events scope被解析，**THE SYSTEM SHALL** 只读取Run已持久化的target kind/stable Deployment/revision与接受principal，随后按当前同kind grant或browser-session/security fence收窄；请求不能用selector重绑历史Run，promotion/rollback不使旧Run漂移，stable Deployment revoke永久fence旧Run。Gate resume保持独立fail-closed。
4. **WHEN** Conversation被创建或Chat miss接受，**THE SYSTEM SHALL** 验证typed principal、稳定Agent Deployment、active revision与创建时`conversation_contract_hash`，以行锁/CAS推进state version，并同写user message与Run；Chat hit必须先重放历史receipt。cross-Workspace、cross-principal、stale state或contract不兼容在Run/reservation/outbox前失败。
5. **WHEN** reservation/ledger/billing state被并发操作，**THE SYSTEM SHALL** 以稳定锁序保证余额与预留均不为负、同billing key同intent幂等且不同金额冲突、ledger append-only；每个accepted top-level billing owner即使零成本也恰好一笔reservation。G0-07角色和attestation就绪前低权角色没有billing mutation权限。
6. **WHEN** terminal、Checkpoint、HumanGate、Outbox或retention事实不满足其契约、状态前置、唯一性、保留期或可信证据，**THE SYSTEM SHALL** fail closed。G0/G1 terminal固定`terminal_billing_pending=false`；正常终态current billing为`SETTLED`，`SIDE_EFFECT_UNKNOWN`为内部`NEEDS_ATTENTION`且billing同为`NEEDS_ATTENTION`；validator未就绪时`SUCCEEDED`拒绝。EVENTS/RECOVERY disposable purge不得改变terminal墓碑、replay结果或ledger。
7. **WHEN** catalog与低权角色被独立读回，**THE SYSTEM SHALL** 证明所有新事实直属Workspace并使用composite FK、`ENABLE + FORCE RLS`、固定安全`search_path`；应用角色对新事实的raw `SELECT/INSERT/UPDATE/DELETE`全部拒绝，只能调用kind-specific original-Run definer；cross-Workspace/cross-principal、错误role EXECUTE、child/link与任何部分事实全部拒绝。

### 风险、假设与待确认项

- 风险等级为 L4：本轮同时触及不可变运行身份、并发幂等、账务与恢复事实；必须使用最窄红测、真实 PostgreSQL 16 并发/权限夹具和独立 findings-first Review。
- 假设现有 `docs/05-数据模型.md`、`docs/06-API契约.md`、ADR-004 与上一轮计划中的 G0-06 条目是当前权威设计输入；冲突时优先选择更窄权限、更少可执行路径和可独立验证的 fail-closed 方案。
- 当前 `Agent Release`/`Deployment Revision` application publisher与 G1 ResolvedPlan authority仍暂停；`admission_snapshot_hash`绝不冒充`accepted_plan_hash`。G0-06只能通过owner-only disposable fixture验证事实层装配与攻击边界，不能提供“无reservation/无权威Plan”的应用准入旁路，也不能因此声明真实Agent Run已可发布或执行。
- 未确认的生产连接池、外部计费、归档服务、支持导出与客户端行为不阻断本地事实层，但必须保留为 G0-08/部署门未知项。

### Think 独立复核结论

- 两路只读复核发现的阻断项均已按权威ADR/API/数据模型收敛：reservation改为每个top-level Run恰好一笔；幂等唯一域加入principal与fixed route；Conversation补typed principal与单调state version；application acceptance与HumanGate正向路径在Plan/G0-07/G1依赖未满足时暂停；retention只实现owner-only primitive与disposable夹具。
- 没有仍会实质改变本轮结果的开放产品决策；provider计量映射和最终合同/地域保留年限继续保持fail-closed/更长horizon，并由G0-07或首个生产租户前的部署门冻结。

### 下一步

进入 Plan，把契约、纯核心、004 migration、API 内部 seam、PG16 并发/权限夹具和组合质量门拆成有依赖的 TDD 任务；Plan 通过前不修改产品代码。

## Plan：方案与关键取舍

### 方案比选

1. **直接复制 `docs/database/004-运行与计费.sql`：拒绝。** 该文件是 5,002 行未执行设计稿，包含自管 `BEGIN/COMMIT`、与 003 重复且形状不同的 registry/Release grant，以及尚未存在的 G0-07 executor/attestation roles。直接复制既无法通过 migration loader，也会回退 G0-05 的 kind-safe registry。
2. **在本轮同时实现 ResolvedPlan、phase attestation、lease/fencing、HumanGate 正向恢复：拒绝。** 这会把 G1-01 与 G0-07 依赖倒置，并迫使 application acceptance 信任调用方自证 Plan/hash。
3. **适配现有 000～003 的事实层 + owner-only 正向夹具：采用。** 004 复用 003 的 published-resource/Deployment/typed-grant事实，新建 Conversation/Run/Billing/Outbox/Gate/Retention 事实及四个 NOLOGIN owner；application acceptance、资金、finalizer、Gate与purge默认无可执行角色权限。唯一例外是授给`ba_runtime`的target-bound `request_run_cancellation` definer，它在函数内完成current authorization并原子写cancel intent/Event/Outbox，调用者仍无任何raw relation权限。真实PG16只由migrator显式`SET LOCAL ROLE`验证其他owner路径，migration不留下测试授权。

Canonical JSON 继续复用 `@better-agent/release-core` 已验证的 JCS/hash export；本轮不复制 serializer，也不为第二个消费者提前抽取新 shared package。`run-core` 与 `billing-core` 都依赖 `domain-contracts + release-core`；两者互不依赖，且不依赖 API/DB。

### 实施依赖图

```text
T0 workspace/package skeleton
  └─ T1 closed domain contracts + documentation delta
       ├─ T2 run-core canonical/acceptance/state
       ├─ T3 billing-core amount/reservation/ledger
       └─ T4 transaction-scoped G0-05 admission refactor
T1 ──> T5 bootstrap owners + 004 static red gate
T2 + T3 + T4 + T5 ──> T6 004 facts/functions/down
T2 + T4 + T6 ──> T7 internal API original-Run/Conversation/replay seams
T6 + T7 ──> T8 PostgreSQL 16 concurrency/security/retention harness
T0..T8 ──> T9 combined quality gate and Review input
```

全部共享 L4 安全或 migration 依赖，任务按顺序执行，不标记 `[P]`。可使用子代理做只读复核或文件互斥的预研，但同一 migration、registry、API transaction seam 的实际修改保持单 owner 串行。

### Before / After 契约与消费者

| 轴 | Before | After | 消费者与一致性证据 |
|---|---|---|---|
| Domain registry | 无 Run/Conversation/Billing/Gate/Retention versioned schema | closed `*/1` schema 注册；unknown/extra key fail closed | run-core、billing-core、API internal DTO、004/PG fixture；registry/unit tests |
| JCS/identity | release-core 已有唯一 JCS/hash | run intent、receipt、billing intent复用同实现；无第二 serializer | run-core、billing-core测试与固定 digest vectors |
| Conversation principal/state | 文档草案只 FK end-user，且无 state revision/CAS | `credential|end_user` 判别复合 FK；immutable contract hash + monotonic `state_version`；Chat message/Run同事务 | domain、004、Conversation seam、PG并发夹具 |
| Run identity | 仅 G0-05 admission snapshot，无 Run | snapshot hash 与 accepted Plan hash分列；typed target/accepted principal/Conversation pin不可改 | run-core、004、original-Run resolver、readback |
| Billing | Workspace余额列存在，无 reservation/ledger runtime事实 | 每top-level Run恰好一笔reservation（含0）；append-only ledger；current billing与terminal snapshot分离 | billing-core、004、PG两连接测试 |
| Outbox/Event | 无 runtime facts | 恰好一个accepted Event；每个closed kind+dedupe intent一条Outbox，可形成集合 | 004、API receipt、PG计数/readback |
| DB owners | `ba_auth_owner` / `ba_authorization_owner`，无运行事实owner | 新增 `ba_run_owner`、`ba_billing_owner`、`ba_archive_evidence_owner`、`ba_retention`；均NOLOGIN/NOINHERIT/NOBYPASSRLS | bootstrap probe、catalog membership/ACL tests |
| Executable roles | runtime/control/auth/verifier roles | 不新增G0-07 executor；除target-bound original-Run read/events/cancel definer外，所有G0-06正向mutation默认deny；所有新事实raw SELECT/DML deny | catalog `has_table_privilege` / `has_column_privilege` / `has_function_privilege` 与真实 `42501` |
| Browser replay auth | 003 browser auth读取active pointer并返回当前revision | 004新增ba_auth_owner两段窄primitive：pointer-free identity认证 → principal-scoped key锁 → persisted-target授权 | transaction identity/API序列测试、promotion/revoke PG夹具 |
| Conversation contract authority | 003 canonical revision document已有hash，但relation未投影列 | 004 forward ALTER从不可变canonical document回填、校验并固定`conversation_contract_hash`；caller不能提供/改写 | migration backfill、owner validator、Conversation create readback |
| Idempotency serialization | Run事实尚不存在 | 持久namespace sentinel完整覆盖Workspace+typed principal+fixed route+key；`INSERT ... ON CONFLICT`后`SELECT FOR UPDATE`串行miss | 两连接same/different intent攻击夹具 |
| Registry | 003 kind-safe `published_resource_versions` | 原样复用；004不得重建旧AGENT/FLOW/SYSTEM registry或通用release grant | migration static gate、PG catalog/readback |
| API transaction | Deployment `admit()` 自己开启事务 | package-private transaction-scoped admission helper；旧boundary行为保持，Run seam可共享同一transaction | transaction identity spies、API regression tests |
| API package export | 只导出 `./auth` | 仍只导出 `./auth`；Run/Conversation/Gate seam不公开 | manifest/static export scan |
| OpenAPI | 11 operations与public response已冻结 | 本轮不改公开OpenAPI/generated projection | `pnpm contract:check`与git diff scan |
| Target DDL | `docs/database/004-运行与计费.sql` 为未执行旧草案 | production migration为`packages/db/migrations/004_run_billing.*.sql`；旧草案仅记录适配差异/canonical路径 | docs link、migration loader、PG16 |

## Plan：依赖有序任务

### T0 — run-core / billing-core workspace 骨架

- **目标：** 先让workspace显式识别两个纯核心包，不携带可执行业务能力。
- **文件集合：** 新增 `packages/run-core/{package.json,README.md,tsconfig.json,tsconfig.build.json,vitest.config.ts,src/index.ts}`、`packages/billing-core/{package.json,README.md,tsconfig.json,tsconfig.build.json,vitest.config.ts,src/index.ts}`；修改根 `tsconfig.json`、`packages/test-support/scripts/workspace-smoke.mjs`、`pnpm-lock.yaml`。
- **依赖：** Think通过。
- **风险：** L1。
- **先红测：** workspace smoke先要求两包manifest、root reference与build config；骨架缺失时稳定失败。
- **完成证据：** `pnpm workspace:smoke`；两包空壳typecheck/build；workspace graph无cycle。

### T1 — G0-06 closed contracts 与文档投影

- **目标：** 冻结数据库/API/纯核心共享的唯一版本化事实，关闭Think发现的principal、state revision、Plan identity与terminal/billing漂移。
- **文件集合：** 新增 `packages/domain-contracts/src/{conversation-v1,run-v1,run-idempotency-v1,run-event-outbox-v1,human-gate-v1,billing-v1,retention-v1}.ts`；修改 `src/{index,registry}.ts`、包README；新增三组 `test/g0-06-*.test.ts`；修改 `docs/05-数据模型.md`、`docs/adr/004-持久化执行与计费.md`、`docs/database/004-运行与计费.sql`开头的canonical migration/适配说明。
- **依赖：** T0。
- **风险：** L4。
- **契约：** `ConversationPrincipalV1`只接受credential/end_user；Conversation固定stable Agent Deployment、创建revision、contract hash与state version；Agent/Flow target判别联合；Run acceptance同时要求snapshot hash、独立Plan hash、output schema pin、principal和target。Agent Chat的Conversation ID/contract hash/accepted state version/user-message identity全部必填，direct Flow全部禁止；其他target只能通过新schema version引入。public Run status与internal scheduling status分列；idempotency namespace固定Workspace+authenticated principal+fixed route+key；credits边界只收发canonical decimal string，内部可超JS safe integer；HumanGate只冻结形状不表示可执行；archive manifest、verification、approval与purge receipt分立。
- **先红测：** extra key/future version/unknown enum；principal双填/空填/management user；state version负数/非safe/stale；Agent Chat缺任一Conversation pin、Flow携带任一Conversation字段或Agent/Flow字段混装；snapshot hash冒充Plan hash；非终态携带terminal字段、result+error并存、错误billing组合；同裸key跨route合法；resume空key拒绝而Run create/cancel可空；负数/前导零/指数credit拒绝且`"0"`接受；caller自带`verified=true`不能替代typed archive receipt。
- **完成证据：** domain-contracts test/typecheck/build全绿；文档相对链接与`git diff --check`通过。

### T2 — run-core canonical intent、replay 与状态纯边界

- **目标：** 建立不读DB/时钟/随机数的稳定Run事实准备层。
- **文件集合：** 新增 `packages/run-core/src/{errors,canonical-intent,idempotency,acceptance-receipt,acceptance,conversation-state,run-state,terminal-snapshot,human-gate,retention}.ts`、对应tests；修改`src/index.ts`与README。
- **依赖：** T1。
- **风险：** L4。
- **契约：** route-specific strict preimage后调用release-core JCS/hash；`REPLAY|CONFLICT`不承担权限；canonical receipt只保存status+安全data，当前exchange request/time另行投影；`prepareRunAcceptanceFacts`重验G0-05 snapshot并要求独立Plan/output pin，但不授予持久化；Conversation CAS只允许current=expected且next=current+1；无registry validator时`SUCCEEDED`固定拒绝；`SIDE_EFFECT_UNKNOWN`唯一映射internal/billing双`NEEDS_ATTENTION`；HumanGate正向apply固定unavailable；retention纯函数只判eligibility。
- **先红测：** key order等价/array order敏感；Chat/Flow/cancel/resume任一公开intent字段变化hash变化，而credential/Deployment/Plan不得进入intent；同namespace不同target冲突、跨route不冲突；blocking 200不能保存为acceptance receipt；forged/cross-workspace snapshot；Plan/output/Conversation pin缺失；CAS stale/overflow/message-Run identity错配；非法状态边与终态改写；Gate apply unavailable；EVENTS误用RECOVERY horizon、未settled、缺evidence/重复receipt拒绝。
- **完成证据：** run-core test/typecheck/build；固定独立digest vectors；import graph只到domain-contracts/release-core。

### T3 — billing-core bigint、reservation、ledger 与 current state

- **目标：** 用纯函数冻结账务金额、intent、三角delta与状态，不依赖API/DB。
- **文件集合：** 新增 `packages/billing-core/src/{errors,amount,intent-hash,reservation,ledger,billing-state}.ts`、对应tests；修改`src/index.ts`、README与package/TypeScript依赖投影。
- **依赖：** T1。
- **风险：** L4。
- **契约：** 内部只用`bigint`，边界只收发canonical decimal string；reservation必须绑定trusted Plan hash且`0`仍生成HELD事实；每个accepted root初始current billing固定为`PENDING`且`billing_settled_at=NULL`。reserve/settle/release/expire/reconcile intent closed；same key+intent replay、same key different amount/hash conflict；输出稳定锁序key；current billing与immutable terminal snapshot分离；child allocation输入当前一律unsupported。ledger三角delta固定为RESERVE`(-amount,+amount,0)`、SETTLE`(0,-amount,+amount)`、RELEASE`(+amount,-amount,0)`、EXPIRED`(+remaining,-remaining,0)`、RECONCILIATION`(+release,-(release+settle),+settle)`；EXPIRED只允许锁定未消费HELD reservation且`now>=expires_at`后全量释放remaining并置EXPIRED。零额事实三delta全0且不推进balance version。
- **先红测：** 超JS safe integer仍精确；零额不能省略且接受后仍为PENDING；无Plan hash拒绝；重复settle不二扣；超reservation/负余额/settled+released超held拒绝；各entry kind三角delta错误拒绝；EXPIRED提前/部分消费拒绝、到期同intent重放且different intent冲突；reconciliation只推进current state不改terminal。
- **完成证据：** billing-core test/typecheck/build；固定独立digest vector；package graph只到domain-contracts/release-core且不依赖run-core/API/DB。

### T4 — transaction-scoped G0-05 admission

- **目标：** 让未来Chat/Flow acceptance可在同一事务完成auth identity→idempotency sentinel→Workspace→Deployment admission/security→Conversation→Run/reservation，而不改变现有Deployment boundary公开行为或形成反向锁序。
- **文件集合：** 新增 `apps/api/src/modules/deployments/deployment-admission.ts`；修改`deployment-boundary.ts`与现有tests；新增`apps/api/test/deployment-admission.test.ts`。helper保持package-private，不从package export暴露。
- **依赖：** T1。
- **风险：** L4。
- **契约：** helper接受factory-owned transaction、已认证context、selector/scope；不调用`withTransaction`，不接受caller snapshot/hash/transaction；旧boundary只包一层transaction；Run seam在锁Conversation前复用同一个transaction object。所有key lookup、service/browser identity、persisted-target授权、intent compare/replay helper同样不得自开事务。
- **先红测：** helper不得开启第二事务；旧Agent/Flow boundary仍恰好一次事务；facts多余字段、伪hash、credential/context错配拒绝；任一异常收敛且不泄露DB/secret。
- **完成证据：** focused helper tests与全部既有G0-05 API tests通过。

### T5 — bootstrap owner 与 004 static red gate

- **目标：** 在写DDL前冻结新owner、inventory、ACL与阶段暂停边界。
- **文件集合：** 修改 `packages/db/bootstrap/platform-roles.sql`、`infra/test/postgres/bootstrap-test.sql`；新增 `packages/db/test/run-billing-migration.test.ts`。
- **依赖：** T1；不修改已发布000～003 migration。
- **风险：** L4。
- **角色：** 新增`ba_run_owner`、`ba_billing_owner`、`ba_archive_evidence_owner`、`ba_retention`；全部NOLOGIN/NOINHERIT/NOBYPASSRLS，互不继承并与现有executable roles双向REVOKE；只有`ba_migrator`持ADMIN OPTION。本轮不创建任何`ba_*_executor`。
- **所有权/跨owner矩阵：** `ba_run_owner`拥有Conversation/message/state、idempotency sentinel/receipt、Run/Attempt/Step/Event/Checkpoint/HumanGate/Outbox及run definer，`app.finalize_run`也必须归它所有并由它原子写Step/Event/Outbox/terminal snapshot；`ba_billing_owner`拥有reservation/ledger/reconciliation及reserve/settle/release/expire/reconcile billing definer，只获`workspaces`余额三列和Run current-billing所需列级SELECT/UPDATE，绝不获得Step/Event/Outbox或terminal snapshot写权；`ba_archive_evidence_owner`拥有manifest/verification/approval及登记函数；`ba_retention`只拥有purge receipt/function，并仅获eligible Run/evidence列级SELECT及Event/Checkpoint/DELIVERED Outbox窄DELETE。`ba_run_owner`只EXECUTE billing owner的reserve及账务收敛primitive，不获ledger DML；`finalize_run`在同一外层事务调用这些billing definer后才写终态事实。browser private facts和G0-05 admission facts分别只能经`ba_auth_owner`、`ba_authorization_owner`窄validator访问，不向新owner授整表权限。
- **先红测：** migration末尾必须是`004/run_billing`且有up/down与`55000`down guard；inventory覆盖Conversation/Run/Attempt/Step/Event/Checkpoint/Gate/Outbox/idempotency sentinel+receipt/reservation/ledger/reconciliation/retention evidence；所有事实有Workspace candidate key/FORCE RLS；所有definer safe path；无旧registry重建；除reviewed original-Run read/events/cancel definer外无executable function GRANT，所有新relation对应用角色raw SELECT/DML均deny；逐relation/function/column owner与跨owner privilege精确匹配矩阵。
- **完成证据：** DB unit tests红转绿；fresh bootstrap catalog证明owner属性和membership。

### T6 — 004 Run/Billing production migration

- **目标：** 把设计草案适配为单事务、kind-safe、默认无应用写权限的事实层。
- **文件集合：** 新增 `packages/db/migrations/004_run_billing.{up,down}.sql`；修改DB README。`docs/database/004-运行与计费.sql`仅作输入，不复制其BEGIN/COMMIT、旧registry或G0-07 role grants。
- **依赖：** T2、T3、T4、T5。
- **风险：** L4。
- **物理事实：** 004以forward ALTER从`agent_deployment_revisions.canonical_document`回填并校验不可变`conversation_contract_hash`投影，不接受caller登记hash；typed-principal Conversation/message/session-state CAS；完整namespace键的持久idempotency sentinel/receipt；top-level Run与typed Agent/Flow target、snapshot/Plan/output pins、terminal tombstone及三个retention horizon；Attempt/Step/Event/Checkpoint；HumanGate/Gate mutation schema但无正向应用函数；Outbox；parent-link/allocation目标键但所有insert/stub fail closed且不存在detach枚举；top-level reservation、append-only ledger、reconciliation；archive manifest/verification/approval/purge receipt。
- **幂等原子性：** namespace物理键固定为Workspace+principal kind+principal id+fixed route template+key；miss在同一事务`INSERT ... ON CONFLICT DO NOTHING`后`SELECT FOR UPDATE` sentinel，receipt只在全部acceptance事实成功后完成。rollback不留空sentinel；等待者在首事务commit后重读同一receipt，same intent replay、different intent conflict，不能以unique violation或应用重试替代串行协议。
- **原子primitive：** owner-only prepared root acceptance同写Run（初始current billing为PENDING）、唯一accepted Event、按kind/dedupe唯一Outbox集合、零或正额度唯一HELD reservation与RESERVE ledger；Agent Chat variant还同写Conversation user message/state并固定全部Conversation pin，direct Flow variant禁止这些字段。reserve/settle/release/expire/reconcile由`ba_billing_owner`拥有；`app.finalize_run`由`ba_run_owner`拥有，在同一外层事务先调用billing settle/release原语，再写Step/Event/Outbox/terminal，任一步失败全部回滚；archive registration与purge分别归archive evidence/retention owner。`ba_runtime`只可EXECUTE original-Run read/events和唯一受控`request_run_cancellation`：函数内按persisted target完成最终授权并原子写幂等cancel intent/Event/Outbox，重复同intent不新增事实；runtime无相关raw SELECT/DML。G0-07前不向executable role授权acceptance、billing、finalizer、Gate、checkpoint/runtime event或purge。`SUCCEEDED`、child/allocation与全部Gate正向操作返回`0A000`且零部分事实。
- **全局锁序：** transport/canonical input验证 → service credential或pointer-free browser identity认证 → idempotency namespace/sentinel → Workspace → stable Deployment/security/current literal grant（首次miss才锁pointer/revision）→ Conversation → Run（UUID序）→ Attempt/Step → reservation → allocation → charge key/ledger。历史hit可在sentinel后无锁读取Run不可变target，随后按上述顺序锁security/grant、锁Run并最终重验；不得锁Run后再反向锁Deployment。幂等hit在active pointer/Conversation/Plan前返回；账务全程余额和reserved非负。
- **Original-Run：** service路径除create-route自身scope外，还按Run接受principal、同kind stable Deployment和current literal `run:read|run:events:read|run:cancel` grant/scope/time window/security fence重验。browser路径由`ba_auth_owner`提供两个窄函数：`authenticate_browser_session_identity`只验证verifier、Workspace、session/principal lifecycle+epoch和stable Agent Deployment，不读active pointer/revision；锁principal-scoped key得到Run后，`authorize_browser_original_run`再把同一session context与persisted target及当前Deployment fence比较。003 `authenticate_browser_session_facts`读取active pointer，仅可用于首次admission，禁止复用到历史Run；`ba_run_owner`只获窄函数EXECUTE，不获auth private table SELECT。
- **Terminal：** `terminal_billing_pending=false`；正常终态current billing `SETTLED`，`SIDE_EFFECT_UNKNOWN`为internal/billing双`NEEDS_ATTENTION`；同terminal intent读墓碑重放，不同intent冲突；event删除后不影响。
- **Retention：** archive evidence writer与purge owner分离；三个horizon只能单调延长且`retention_until >= recovery_retention_until >= events_retention_until`。EVENTS只要求terminal+current billing SETTLED+`now>=events_retention_until`并删除eligible Event；延长aggregate policy horizon不得阻塞已到期EVENTS。RECOVERY同时要求`now>=recovery_retention_until`与`now>=retention_until`，只删allowlist Checkpoint+DELIVERED Outbox。两者都需要事先存在且exact-match的verified+approved evidence；永不删除ledger、reservation、idempotency receipt或Run tombstone。
- **Down：** 先拒绝后续migration；任一G0-06事实或相关invalidation存在即`55000`并保持ledger/事实/迁移记录；只允许全空回到003。apply前采集003既有对象owner/ACL/RLS policy/constraint fingerprint，down后必须逐字恢复，包含移除004对`workspaces`与G0-05对象的列级/cross-owner grants及revision conversation hash投影；bootstrap role可继续存在但不得残留003对象权限。
- **完成证据：** migration unit inventory/ACL/static tests；loader/render/replay unit tests全绿。

### T7 — API internal Run / Conversation / HumanGate seam

- **目标：** 提供可组合、无router/handler、无package export的内部边界；只允许历史Run read/replay/cancel事实，首次application acceptance与Gate正向路径继续暂停。
- **文件集合：** 新增 `apps/api/src/modules/runs/{original-run-authorization,browser-run-auth,run-transaction,run-boundary,human-gate-boundary,index}.ts`、`apps/api/src/modules/conversations/{conversation-transaction,conversation-boundary,index}.ts`和对应tests；修改API package dependency/tsconfig/lockfile，但`package.json.exports`仍只有`./auth`。
- **依赖：** T2、T4、T6。
- **风险：** L4。
- **Service/browser auth：** service绑定reviewed create/original-Run operation并只传Run ID；create route scope与current original-Run scope是两个独立gate，DB从persisted Run派生target。browser先用`withBrowserSessionVerifier`和004 pointer-free identity primitive取得end-user namespace，锁key得到Run后再调用persisted-target primitive；不能调用003 active-pointer browser admission。两段browser auth、key lookup、Run target read、current authorization、intent compare/replay必须共用Run boundary持有的同一transaction，helper不得调用`withTransaction`。输入拒绝selector/revision/principal/snapshot/Plan/transaction；secret/verifier/pepper只清理局部copy。
- **Conversation：** create不接受Idempotency-Key或caller principal/revision；principal由credential或browser session派生；transaction返回active revision/contract hash。package-private Chat loader/CAS只供同事务Run组合；user message不能提前提交。
- **Run replay/cancel：** keyed create hit严格执行route authentication→锁namespace key→original-Run current `run:read` gate→intent compare→保存receipt重放；只有create scope或只有`run:read`均不足，Agent/Flow grant不能串型。hit不得调用admission/Conversation/Plan/billing/Event/Outbox；保存的acceptance request identity不变，但当前exchange `request_id/now_time`重新生成，status/data逐字重放，blocking 200不作为acceptance receipt。create miss或unkeyed一律返回`RUN_PLAN_PROVIDER_UNAVAILABLE`且零写入；API factory不接受可由应用任意注入的“trusted Plan provider”。cancel走受控definer，same intent重放、different intent冲突，当前授权在写cancel Event/Outbox前最终重验。
- **HumanGate：** strict input与JCS intent可验证，但submit/approve/reject/expire/resume全部返回统一unavailable；不暴露claim/decision/new-attempt/finalizer transaction method，不用`run:resume`绕过approver policy。
- **先红测：** 完整调用序列与每个helper的transaction object identity；browser identity→key→persisted target两段顺序且不形成run_id/principal循环；历史目标不可读在intent compare前404；pointer/Conversation变化不影响hit；same intent replay/different intent conflict；保存accepted request identity不变、当前request/time变化、blocking 200不重放；miss零写入；create scope与`run:read`任缺其一拒绝；Agent/Flow grant串型、accepted principal不符、browser end-user/deployment/epoch错；003 active resolver未被调用；输入携带`state_version`、`next_state_version`、principal、created revision、conversation contract或transaction均在开事务前拒绝；Conversation stale expected-version/contract/cross-principal；cancel重复不新增且授权失败零Event/Outbox；所有Gate操作零副作用。
- **完成证据：** API focused+full tests/typecheck/build；static scan确认无router/handler/Run export。

### T8 — PostgreSQL 16 migration、并发与攻击门

- **目标：** 在disposable PG16证明004的事务、权限、并发账务、original-Run、terminal与retention边界。
- **文件集合：** 新增 `infra/test/postgres/run-run-billing-integration.mjs` 与 `run-run-conversation-browser-integration.mjs`；修改`run-integration.mjs`、DB package scripts与两份README。第二个 harness 隔离 Agent Chat/Conversation CAS 与 browser original-Run 夹具，仍由同一个根数据库门串行执行。
- **依赖：** T6、T7。
- **风险：** L4。
- **Catalog/ACL：** 4 owners属性/互不继承；逐relation/function/column owner与cross-owner grant匹配冻结矩阵，特别断言`finalize_run`归run owner、billing functions归billing owner、run owner仅EXECUTE账务原语且billing owner无Step/Event/Outbox/terminal mutation privilege；所有表composite FK、FORCE RLS；definer safe path。所有现有executable roles对新relation raw SELECT/DML=`42501`，仅`ba_runtime`正确original-Run definer EXECUTE为真，错误function EXECUTE=`42501`；同Workspace不同credential/end-user直接SELECT和函数越权均拒绝；不存在G0-07 executor roles/grants。
- **Acceptance/idempotency：** Agent Chat owner fixture零额accept精确1 message/state advance/1 Run/1 HELD reservation/1全零RESERVE ledger/1 accepted Event/按kind Outbox，current billing=PENDING且余额/version不变；direct Flow fixture得到同样Run/账务/Event/Outbox事实但零Conversation/message/state字段。两连接same namespace+same intent并发只得1 Run/1 reservation/1 ledger/1 event/outbox集合并由等待者稳定重放，different intent一胜一冲突；same裸key跨route合法；正额度insufficient balance、cross tenant/principal、contract/CAS错与故障注入零部分事实。
- **Original-Run：** promotion后仍用原target；create scope与original scope任缺其一、wrong kind/grant/scope/principal、grant `not_before_at`未到/`expires_at`已过/epoch变化均拒绝；concurrent grant revoke或stable revoke提交后最终锁重验拒绝；browser identity跨session重放但同end-user namespace一致，session/principal/deployment epoch永久fence；路径不读取active pointer。两连接promotion/revoke与Chat CAS按全局顺序完成且无deadlock，失败cancel不新增Event/Outbox。
- **Billing concurrency/integrity：** 两连接100余额并发reserve 80仅一胜；same charge race仅一ledger；settle/release交错无负数/无deadlock；同key不同amount/hash在资金移动前冲突；到期EXPIRED成功、提前失败、expire/release并发仅一胜且same intent重放/different intent冲突。逐entry读回含EXPIRED的三角delta与after balance/version，零额EXPIRED保留事实但version不变；runtime和owner直接UPDATE/DELETE ledger都由append-only trigger拒绝，不能伪造资金移动。
- **Terminal/Gate/child：** normal settled组合、SIDE_EFFECT_UNKNOWN+reconciliation、same/different terminal replay与event purge后墓碑；`SUCCEEDED`、child/link/allocation和Gate全部`0A000`、计数不变。
- **Retention：** wrong/missing/cross-workspace manifest、ref/hash/kind不匹配、缺verify/approve、各独立horizon未到、billing非SETTLED、pending outbox、NEEDS_ATTENTION无evidence、重复purge全部零删除；证明EVENTS只看events horizon且policy延长不阻塞，RECOVERY同时等待recovery+aggregate horizon；三个horizon缩短/乱序拒绝；EVENTS/RECOVERY正向逐表readback；archive owner不能purge、retention不能登记，双方不能碰ledger/reservation/idempotency/tombstone。
- **Search-path attack：** 对accept/reserve/finalize/purge/original-read分别创建同名`pg_temp` relation/function，证明所有持久relation均schema-qualified，结果、余额和删除范围不变；不只检查`proconfig`。
- **Migration recovery：** fresh 000～004、checksum/replay、空事实down→003→reapply；对apply前003 catalog fingerprint与down后owner/ACL/policy/constraint逐项比较；非空down `55000`且ledger/facts/migration ledger record不变；secret-log零命中。
- **完成证据：** 根`pnpm db:test:postgres16`三套既有suite加两套G0-06 suite全绿；报告只声明disposable PG16。

### T9 — 组合质量门与 Review 入口

- **目标：** 证明所有消费者一致、无阶段越界，并生成findings-first Review输入。
- **依赖：** T0～T8。
- **风险：** L4。
- **验证顺序：** 各包focused test → domain/run/billing/API/DB全包test+typecheck+build → `pnpm workspace:smoke` → `pnpm contract:check` → `pnpm check` → `pnpm db:test:postgres16` → `git diff --check`与`git diff --cached --check`。
- **阶段检索：** 无公开router/handler/SSE、无`./runs` export、无Plan provider伪实现、无snapshot=Plan降级、无G0-07 executor/attestation/lease/fencing、无positive Gate/child/SUCCEEDED、无production pointer/部署声明。
- **Review：** 独立核对domain/API transaction、DB authorization/TOCTOU、billing locks/ledger、terminal/retention四面；任何P0/P1返回Work修复。

## Plan 独立复审收敛

- API/transaction复审的三个P1已关闭：browser replay改为pointer-free identity与persisted-target authorization两段；`request_run_cancellation`冻结为唯一受控runtime mutation例外；全局锁序统一为identity→sentinel→Workspace→Deployment/security→Conversation→Run→billing。
- PostgreSQL/billing复审的P1已关闭：补全四owner逐relation/function/column矩阵和所有应用角色raw SELECT deny；`finalize_run`唯一归run owner并只调用billing owner账务原语；idempotency采用持久sentinel并增加两连接acceptance门；Conversation contract hash由003不可变canonical document forward回填；accepted root billing初值固定PENDING；零额reservation/ledger与到期EXPIRED均保持完整事实。
- P2一并进入验收：同一transaction helper、service双scope、transport request identity、Agent/Flow Conversation判别、caller CAS字段拒绝、grant time-window最终重验、精确retention horizon、真实`pg_temp`遮蔽攻击、003 down fingerprint parity与ledger三角delta。复审后无P0/P1、无仍会改变实现路线的产品决策。

## Work 与首轮 Review 修复记录（2026-08-27）

- **T0～T9 本地实现：** 已完成 domain contracts、`run-core`、`billing-core`、API seam、004 migration/bootstrap、两套 G0-06 PostgreSQL harness 与组合质量门。application acceptance、billing/finalizer、HumanGate 和 purge 仍未授予 executable/login role；`SUCCEEDED`、child Run 与 HumanGate 正向路径保持 `0A000`。
- **TypeScript/API P1 修复：** terminal snapshot 在自定义 validator 前递归冻结且返回同一已验证对象；Chat different-intent 先于 receipt/current Conversation 校验；内部 terminal fact 的 `SIDE_EFFECT_UNKNOWN` 错误保持数据库精确持久形状，不接受仅属于公开投影层的 `flow_category`；credit amount/delta、Workspace balance 与 reconciliation 总额统一限制到 PostgreSQL `bigint` 范围；旧请求的同 intent billing replay 先于新 mutation 时间单调校验。
- **数据库 P1/P2 修复：** Event/Outbox 统一为 canonical `RUN_CANCEL_REQUESTED`、`RUN_FINISHED`、`SSE_WAKE` 并增加表级 CHECK；RESERVE 归因绑定 `accepted_plan_hash`，RECONCILIATION 绑定 evidence SHA；terminal status/reason/error 形成闭合映射，finalizer 拒绝早于 reservation update 的时间；已关闭 reservation 支持严格 0/0 evidence-only reconciliation；archive verification/approval 强制时间顺序；retention 以数据库时钟判定并通过窄 owner helper 锁 Run 后重读 horizon，EVENTS 与 RECOVERY 维持不同 allowlist。
- **权限、回滚与竞态修复：** browser session revoke/auth 统一 public→private 锁序；四个 G0-06 owner 只允许 `ba_migrator` 直接成员，并拒绝 non-super LOGIN 同时拥有 executable 与 owner 传递成员关系；003 rollback fingerprint 扩展到完整函数定义/关键属性、trigger 定义与状态、普通 index 定义，004 down 同步清理 retention helper。
- **组合证据：** `pnpm check` 全绿，覆盖 173 文件格式/静态检查、9 package lint/typecheck/build、workspace smoke、OpenAPI contract gate 与全部单元测试；`pnpm db:test:postgres16` 五套 suite 串行全绿，覆盖 PostgreSQL 16.12、5 migrations、22 张 FORCE-RLS 表、迁移精确 down/reapply、billing/terminal/archive/retention 与 browser revoke 并发。沙箱内首次容器启动在断言前因 Windows `spawn EPERM` 失败，获准切换到本地 Docker 路径后完整通过；该环境失败不计为测试通过证据。
- **边界：** `git diff --check` 与 `git diff --cached --check` 通过，暂存区为空；未 commit、未 push，未访问生产数据库、云状态或客户端状态。

## 第二轮 Review 与 Work 修复记录（2026-08-27）

- **纯核心账务与 retention：** `billing-core` 支持已关闭 reservation 的严格 `0/0 RECONCILIATION` evidence-only 路径，保持 reservation/Workspace balances 不变并生成零三角 ledger；金融事实统一使用 schema clone 后递归冻结，replay 不再返回 caller-owned ledger。Workspace balances 运行时形状闭合，mutation/replay 拒绝早于 reservation 或 persisted ledger 的 balance version。`run-core` 只对 RECOVERY 增加 HELD reservation 与 PENDING/LEASED Outbox blocker，EVENTS 门禁不变。
- **API 终态与异步快照：** cancellation terminal receipt 关闭为数据库可持久化组合：status/reason/billing/error 精确映射，`SUCCEEDED.result` 只接受 JSON object，`last_sequence` 为 PostgreSQL bigint 范围内 canonical positive decimal，`billing_settled_at` 为严格 ISO date-time；result/error 均 schema clone 后递归冻结。Conversation variables 与 Agent Chat CAS 输入在首次 await 前 canonical clone + deep freeze，消除两处 caller mutation TOCTOU。
- **数据库幂等、证据与权限：** EVENTS/RECOVERY purge 在取得 Run 锁后重查 receipt，同 intent 稳定 replay、不同 intent `23505`；manifest/verification/approval/purge replay 比较完整持久 intent shape。zero-credit HELD reconciliation 与 core 统一为 `SETTLED + settled_at`。legacy `authenticate_browser_session_facts` 通过 004 forward replacement 改为 public→private 锁序，down 精确恢复 003；owner/executable 隔离扩展到 `ba_auth_owner`、`ba_authorization_owner` 在内的六个 owner；G0-05 catalog fingerprint 增加 policy permissiveness、replica identity 与 index 状态。
- **并发与时间夹具收敛：** retention 双连接夹具改为逐个入队，并递归验证 `pg_blocking_pids` 锁链最终到达持有 `public.runs ... FOR UPDATE` 的事务；完整 Billing suite 连续 3/3 通过。G0-05 browser fixture 将无关 Agent Conversation 发布移到 session exchange 前，session/assertion TTL 使用 issuer 300 秒硬上限内的 `4m40s/4m50s`，读回剩余 TTL 并要求至少 120 秒；release suite 连续 3/3 均实测 279 秒。
- **最终组合证据：** 最新工作树 `pnpm check` 全绿，覆盖 174 文件、9 package lint/typecheck/test/build、workspace smoke 与 11-operation OpenAPI contract gate；主线沙箱外 `pnpm db:test:postgres16` 五套 suite 最终 exit 0，覆盖 PostgreSQL 16.12、5 migrations、六 owner、22 张 FORCE-RLS 表、migration/down/reapply、auth/RLS、G0-05 freshness、Run/Billing 并发与 Agent Chat/browser。沙箱内仍在任何数据库断言前因 Windows `spawn EPERM` 失败，该环境失败不作为功能失败或通过证据。
- **边界：** `git diff --check` 与 `git diff --cached --check` 通过，暂存区为空；所有数据库证据来自 disposable PostgreSQL 16，未 commit、未 push，未执行生产、云端或客户端变更。

## 第三轮 Review 与 Work 修复记录（2026-08-27）

- **Findings-first 结论：** 三名新的只读审查者确认 1 个 P1、6 个 P2 与 1 个 P3。P1 是 archive manifest/verification/approval 在 identical-intent 首次双连接写入时可让等待者泄漏原生 unique violation；P2 覆盖 004 upgrade trust drift、owner-overlap 夹具真实性、API await 前输入快照、`run-core` receipt 形状与引用所有权、terminal settlement instant、数据库 terminal fact 的额外字段。L4 事实层的 P1/P2 全部返回 Work 关闭；P3 为测试客户端异常路径的动态 secret 脱敏强化，保留为后续 harness hardening，不提升为生产或数据库泄漏事实。
- **数据库并发与信任边界：** archive 写入按 `Run -> Manifest -> Verification` 的权威父事实锁序序列化，锁后重读并做完整 persisted-intent 比较；三阶段 identical-intent 双连接均成功返回同 UUID且只留一行，different-intent 均保持一胜一自定义 `23505`。004 在 DDL 前重新验证 `ba_migrator`、四个 executable NOLOGIN/非特权属性、migration `session_user` 的 LOGIN/非特权与显式 migrator membership；direct owner drift 与经 `ba_migrator` 的真实 transitive executable/六-owner overlap 使用不同夹具和精确错误断言。
- **API 与纯核心不可变性：** service/browser replay 与 cancellation 的所有 caller-owned 输入在首次 `await` 前完成 canonical clone/freeze，异步事务不再重读原始 idempotency key、Conversation/Run identity。数据库 terminal receipt 严格拒绝 `flow_category`，设计 SQL 已同步内部持久形状；OpenAPI 通用 `ErrorDetail` 的可选公开投影字段不等同于数据库 fact。`run-core` 对 idempotency fact/namespace/target/canonical 202 receipt 做 exact-key/schema clone/deep freeze，并强制 receipt Run 与 target Run 一致；普通 terminal 的 `billing_settled_at` 必须与 `finished_at` 表示同一瞬间，`NEEDS_ATTENTION` 后续 reconciliation 时间仍独立。
- **TDD 与组合证据：** API 新增 5 个可稳定失败的 caller-mutation/extra-field 测试后为 80/80；`run-core` 先复现非法 receipt、可变引用、target/receipt 错绑与 settlement drift，再为 27/27；DB 单测为 39 passed/1 skipped。最新 `pnpm check` 全绿，覆盖 174 文件、9 package lint/typecheck/test/build、workspace smoke 与 11-operation OpenAPI gate。沙箱内 PostgreSQL 门禁在首个断言前因 Windows `spawn EPERM` 失败；同一 `pnpm db:test:postgres16` 在获准本地环境五套 exit 0，覆盖 PostgreSQL 16.12 migration/down/reapply、auth/RLS、G0-05 279 秒 freshness、Run/Billing archive 并发与 Agent Chat/browser。
- **边界：** 当前证据仅覆盖共享工作树与 disposable PostgreSQL；未 commit、未 push，未执行生产数据库、云端或客户端变更。P3 harness 客户端异常输出脱敏仍是明确残余项，不影响本轮生产事实层授权与持久化契约。

## 最终 Review 与 Work 收敛记录（2026-08-27）

- **最终 findings：** 收口审查再次确认 2 个 P1：JavaScript `Date.parse` 丢失 PostgreSQL 微秒精度，使相差 1 微秒的 `finished_at`/`billing_settled_at` 被误判为同一瞬间；004 用递归 `pg_has_role(..., 'MEMBER')` 把纯间接 `LOGIN -> NOLOGIN group -> ba_migrator` 误报为显式 enrollment。另有 route-specific receipt、设计 SQL exact error shape 与 API 终态类型关系 findings，一并在 Work 关闭。
- **时间与幂等纯核心：** `run-core` 使用 BigInt epoch microseconds 比较带显式 offset 的 ISO instant，拒绝超过 PostgreSQL durable precision 的 6 位小数秒，并把支持域显式限制为 ISO year `0001..9999` 与 numeric UTC offset `-15:59..+15:59`；year `0000`、`±16:00`、`+23:59` 红测转绿，合法负 epoch、边界年份、边界 offset 与跨 offset 同瞬间继续通过。`decideIdempotency` 明确收窄为当前真实消费者的 Agent Chat/Flow create routes：Agent receipt 必须携 Conversation，Flow 禁止，cancel/resume namespace fail closed；canonical 202、target Run 绑定、schema clone 与 deep freeze 保持闭合。
- **Migration enrollment：** 004 要求 migration `session_user` 为无特权 `LOGIN+INHERIT`，并在 `pg_auth_members` 存在 `session_user -> ba_migrator` 的直接、`inherit_option=true` membership；纯间接 group、role-level `NOINHERIT` 与 membership `INHERIT FALSE` 均在 version 4 ledger/`runs`/`credits_ledger` 出现前以 `42501` 拒绝。
- **数据库负向诊断真实性：** 间接 migrator 夹具不再启用会回显输入 SQL 的 `echoErrors`；测试只从 anchored PostgreSQL verbose `ERROR: <SQLSTATE>: <message>` 诊断行提取并校验同一行中的精确 `42501` 与消息，同时用 echo-only 文本自检证明不能假绿。静态门禁还要求 004 prerequisite 完整块先于首个 mutating SQL statement。
- **收口增量 Review/Work：** 最终只读复核发现旧关键字白名单会漏掉 prerequisite 前的 `DO/CALL/COPY/MERGE` 等可执行语句，并且诊断 helper 会把 signal-style `exitCode: null` 当作非零失败。两项均先以稳定红测复现：隐藏 DDL 的 `DO` 前缀让旧 gate 返回 true，真实 ERROR 文本加 null exit 被旧 helper 接受。Work 改为要求 prerequisite 前缀只能由空白、line comment 或 block comment 组成，并要求 exit code 为正整数；不修改 004 migration 业务逻辑。
- **最终无 finding 复核：** timestamp 年份/offset/微秒与非法日历输入经纯函数和 `RunSnapshotV1Schema` 共同闭合；SQL-trivia 前缀 gate 对任意可执行文本 fail closed，正整数退出码、同一 anchored ERROR 行、精确 SQLSTATE/message 与 echo-only 自检共同闭合诊断真实性。最终增量复核未发现 P0～P3 可操作问题。
- **API 与设计契约：** `RunTerminalSnapshotData` 改为 status/error/billing 判别联合：普通终态只能 `SETTLED + billing_settled_at`；仅 `FAILED + SIDE_EFFECT_UNKNOWN` 可为 `NEEDS_ATTENTION` 且禁止 settlement time，或在对账后成为完整 SETTLED 事实。失败/取消/超时 reason 与 operator flag 使用同一 `as const` 列表派生运行时集合和类型；编译期负断言覆盖非法 result/error/reason/billing 组合。设计 SQL 的 terminal error CHECK 同 executable migration 使用精确 JSON equality。
- **最终组合证据：** 最新 `pnpm check` 全绿：175 文件、9 package lint/typecheck/test/build、workspace smoke、11-operation OpenAPI gate；关键测试为 API 80/80、`run-core` 38/38、DB 41 passed/1 skipped。获准本地环境的同一 `pnpm db:test:postgres16` 五套最终 exit 0，覆盖 PostgreSQL 16.12 migration/down/reapply、auth/RLS、G0-05 279 秒 freshness、Run/Billing enrollment+archive concurrency 与 Agent Chat/browser；本轮未把先前沙箱内 Docker 子进程的 Windows `spawn EPERM` 当成功或功能失败证据。
- **残余与边界：** 动态测试 secret 在客户端异常输出中的统一脱敏仍是已知 P3 harness hardening；PostgreSQL 容器日志扫描仍通过，但不宣称覆盖 CI/client 的所有异常路径。所有事实来自共享工作树与 disposable PostgreSQL；未 commit、未 push，未执行生产、云端或客户端变更。
- **Compound：** bounded 检索确认仓库未配置 `docs/solutions/`、solution index、self-learning 或 `sync-solution-index` 管线；当前计划已包含可复用根因、方案、预防门禁与证据，因此执行 no-op，不新建近义知识载体，不提出行为学习候选。

## 测试策略与停止条件

1. 每个任务先运行能稳定失败的最窄红测，记录失败原因，再实现到绿；不得用同一实现逻辑生成expected digest或SQL readback。
2. 004不得修改000～003，也不得重建003 registry。若必须改旧migration，立即停止并改用forward migration。
3. 找不到DB可验证的独立Plan authority时application acceptance继续暂停；绝不把admission snapshot、caller hash或mock provider升级为Plan。
4. 除已冻结的original-Run read/events/`request_run_cancellation` definer外，任何acceptance/billing/finalizer/Gate/purge或fixture owner-only function若要求永久GRANT给login/executable role，立即停止；fixture只能`SET LOCAL ROLE`且结束后catalog仍默认deny。
5. 无法以单事务保证Conversation message/state + Run + reservation/ledger + Event + Outbox时停止，不接受应用层补偿写。
6. original-Run路径若读取active pointer、重新选Deployment或混用Agent/Flow grant，停止并修复。
7. 两连接出现deadlock、不确定余额、重复ledger或负数，先修锁序，不以串行测试替代。
8. purge allowlist不精确、证据可由purge caller自证，或需要删除ledger/reservation/tombstone，停止。

## 回滚、恢复与未知项

- 004由既有renderer包裹在单事务、advisory lock和checksum guard中；失败完整回到003。全空可执行reviewed down；产生事实后只允许forward fix，不做破坏性回滚。
- Bootstrap新增NOLOGIN owner是DBA前置且不由migration down删除；真实环境未运行新版bootstrap时004应在DDL前明确fail closed。本轮只验证disposable PG16，不改变外部数据库角色。
- TypeScript packages/API seam均为可逆本地文件，且Run/Conversation不进入package export；没有公开消费者迁移。
- 未知且不阻断：真实Plan provider/registry validator、G0-07 phase attestation/lease/fence、published GateSpec、production dispatcher/scheduler、provider计量映射、合同/地域最终retention期限、真实pool/APM/support export、客户端/云部署。它们不得由本轮owner fixture或本地测试代替。

## 下一可执行动作

G0-06 T0～T9、全部 Review/Work 回路、Compound no-op 与最新组合门禁均已完成。下一 Sprint 应先冻结 G0-07 executor attestation、lease/fence、可信 Plan/validator 依赖与可执行角色授权，再开放 acceptance/finalization/HumanGate 正向路径；继续保持不 commit、不 push、不改变生产或外部状态。
