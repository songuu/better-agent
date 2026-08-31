# G0-07 Executor Attestation、Lease/Fencing 与恢复安全

> 状态：截至 2026-08-31，本轮有界 Review/回修循环累计发现的 7 个 P2 已在 Work 定点修复；当前最窄包门、单独 runtime-security PostgreSQL 16 suite、完整六套 `pnpm db:test:postgres16`、`pnpm check` 与连续执行的完整 `pnpm architecture:framework` 均已通过。最终三路有界 Review 结论为 P0=0、P1=0、P2=0；Compound 已以可审计 no-op 完成，Sprint 状态机已关闭。本文是 G0-07 Sprint 事实源；下一切片为 G0-08，G1、生产、业务 Worker、provider、客户端与云端仍未执行。

## Think：产品边界

### 要做

- 在 G0-06 的 Run/Attempt/Step/Event/Checkpoint/Outbox/Billing 事实层之上增加可信内部阶段身份：独立 `ba_internal_service_attestation_issuer` 签发最长 15 分钟、绑定 `workspace_id + session_user + exact phase` 的 attestation；阶段角色只能在同一连接的新事务中建立签名 tenant context。
- 冻结并实现互不继承的阶段词汇与执行角色：`admission`/`ba_admission_executor`、`execution`/`ba_execution_executor`、`metering`/`ba_metering_executor`、`finalizer`/`ba_finalizer_executor`、`reclaimer`/`ba_reclaimer_executor`、`reconciliation`/`ba_reconciliation_executor`、`archive_evidence`/`ba_archive_evidence_executor`、`retention`/`ba_retention_executor`。issuer、executor、owner、`ba_runtime` 之间不得形成传递提权。
- 通过 forward-only 005 migration 建立 Attempt claim/renew/relinquish/recovery-fence、单调 fencing、受控 Event/Checkpoint/side-effect receipt/Outbox delivery 与账务/finalizer 写入路径。authority 必须逐 phase 闭合：execution mutation 验证当前完整 lease；metering/finalizer 消费由 execution 在 lease 有效时写入的 immutable producer attribution，并验证其历史 `(workspace, run, attempt, lease token, fence[, step/reservation])` 与一次性 CAS，不要求消费时旧 lease 仍 current；admission 验证 acceptance miss + accepted Plan；reclaimer 验证已到期旧 lease + retry/effect envelope，只形成 recovery ticket/hold，若已有 termination intent 则只 fence/清 lease并保持原 intent 未消费；无 Worker lease 的 terminal intent 只接受既有 durable cancel fact 或 recovery-hold fact；reconciliation 使用不可变人工 evidence；archive/retention 使用 manifest/receipt/horizon。任何路径都不得用空 lease、伪 Attempt、caller 自报 reason 或其他 phase 的 evidence 代替自己的 authority。
- 冻结 lease policy：调用者必须显式提供 `1s..5m` 的 duration，数据库不提供隐式默认；测试夹具使用 30 秒。renew 只能在到期前由同一 token/fence 延长且新 expiry 不超过数据库当前时间加 5 分钟。到期 takeover 是两阶段：reclaimer 在锁后只清 lease、把 fence 增为 `N+1` 并写不可变 recovery ticket；随后 execution claim 再产生自己的 token/owner 与 fence `N+2`，旧 Worker 永久失权。
- 建立不可变 retry/effect envelope seam，绑定 accepted Run/Plan、Attempt/Step、side-effect class 与稳定 operation key。execution façade 必须在外部调用前先独立提交 immutable envelope；外部调用结束后，receipt façade 只能关闭既有 envelope，不能补建或覆盖 provenance。NOLOGIN owner/disposable fixture 仅用于测试准备，不是唯一生产路径；没有 envelope、`unsafe`、`requires_key` 缺 key 或外部结果未知时均不得自动恢复，必须收敛到 `SIDE_EFFECT_UNKNOWN/NEEDS_ATTENTION` 与独立人工对账路径。
- 增加真实 PostgreSQL 16 的角色/ACL/RLS、attestation、两连接 claim/renew/recovery-fence/takeover、stale writer、backend termination、mixed tuple、finalizer 与零副作用失败夹具，并为后续 G0-08 暴露无 mock/skip 的聚合输入。

### 不做

- 不实现 G1-01 的 capability closure、policy meet、可信 `ResolvedAgentPlan` 或 output registry validator；`admission_snapshot_hash` 不得冒充 Plan，`SUCCEEDED` 继续 fail closed。
- 不实现 Agent/Flow NodeExecutor、模型/工具调用、生产 queue/Worker/scheduler、公开 HTTP/SSE/browser handler或真实 provider 计量映射。
- 不开放 child Run、join-only SubAgent、HumanGate barrier/resume 正向业务路径、Gate reject/expire disposition 或 production pointer；这些分别属于 G1-05、G1-06、G1-07。
- 不修改 checksum 已冻结的 000～004 migration，不复制 `docs/database/*.sql` 历史设计稿，不用 DBA/owner 造数替代阶段 login 的正向与拒绝证据。
- 不宣称 client/backend termination 等同于 PostgreSQL server/WAL crash；当前 tmpfs harness 只证明事务断连、租约过期与接管语义。

### 可观察的成功标准

1. **WHEN** 正确 phase role 以未过期、未撤销、绑定同一 `session_user/workspace/phase` 的 attestation 建立上下文，**THE SYSTEM SHALL** 只在当前事务返回该 Workspace；同一 raw attestation 可由相同绑定 login 在 TTL 内的新事务/连接重新验真，但外部 credential、wrong phase/role/verifier/workspace、过期/撤销、复制或复用旧 transaction proof 全部得到空 context、RLS 零行和零副作用。
2. **WHEN** PostgreSQL catalog 与低权连接独立读回角色和 ACL，**THE SYSTEM SHALL** 证明每个 executor 只有精确函数 EXECUTE、无原始事实表 DML/schema CREATE/TEMP/其他 phase 权限，`ba_runtime` 无 reserve/settle/release/correct/finalize 权限，issuer 与 owner/executor 无传递重叠。
3. **WHEN** 两个 execution worker 并发 claim 同一可执行单位，**THE SYSTEM SHALL** 只有一个 winner；到期前 recovery-fence、到期后 renew、fence 重用/倒退/溢出均失败；到期后合法 takeover 必须先形成 lease-free `N+1` ticket，再由 execution claim 形成新 token/owner 与 `N+2` fence。
4. **WHEN** stale worker 或攻击者以旧/混合 token、fence、Run、Attempt、Step、reservation 或 attribution 调用 leased mutation，或以错误 Plan/finalizer claim/reconciliation evidence/archive manifest/retention horizon 调用其他 phase mutation，**THE SYSTEM SHALL** 在任何事实或资金移动前拒绝，并由独立 readback 证明 digest 与行数不变。
5. **WHEN** client 在 claim 前后、外部调用前后或 checkpoint 前后失联，**THE SYSTEM SHALL** 只从最后提交 checkpoint 和不可变 retry/effect envelope恢复 `safe` 或带已提交 operation key 的 `requires_key` 工作；没有可信 envelope、`unsafe` 或结果未知不得自动重放，并只形成一个 operator-hold terminal/reconciliation path。
6. **WHEN** leased completion、durable cancel、recovery-hold、已 fence 但尚未 claim 的 recovery ticket 与 finalizer 并发竞争，**THE SYSTEM SHALL** 只有一个绑定当前 producer attribution 或 closed durable intent 的 transaction-scoped finalizer claim 胜出，并在同一外层事务收敛账务、Attempt/recovery-ticket disposition、活动 Step、唯一 terminal Event/tombstone、terminal snapshot 与 Outbox；same intent 重放，different intent 冲突，失败不留半终态，旧 recovery claim 永久失权。caller 自报 timeout 在可信持久 deadline/timeout fact 到位前必须 fail closed。
7. **WHEN** G0-07 完成，**THE SYSTEM SHALL** 通过全仓 `pnpm check`、显式 000～005 migration/down/reapply边界、现有五套加 G0-07 第六套 PostgreSQL 16 集成，并保持 G0-08/G1、生产、云端与客户端状态为未执行。

### 风险、假设与待确认项

- 风险等级为 L4：内部服务身份、数据库最小权限、旧 Worker fencing、账务与终态原子性任一错误都可能形成越权或重复扣费。
- 同一仍有效的 raw attestation 可由绑定的 `session_user` 在 TTL 内于新事务或另一连接重新验真并建立新的 transaction-bound proof；禁止的是复制/复用旧 proof、跨登录/phase 使用或延长原 attestation。这与现有管理 attestation 语义一致，不实现一次性 token 消费。
- 005 不伪造旧事实 provenance：若存在非终态 Run、活动 Attempt、`billing_state <> SETTLED`、未关闭 reservation/allocation、非 `DELIVERED` Outbox，或任何仍需新 provenance 才能安全对账、释放、投递或接管的事实，upgrade 在完整 NOWAIT 锁后的事务性 owner/RLS inspection window 内 fail closed，并在恢复 `FORCE RLS` 后才进入 protocol-v5 schema/data/ledger 变更。只有账务已收敛、投递已完成且后续仅需既有 evidence-driven retention 的终态历史事实可保留；所有新 executor primitive 只接受 005 协议建立的完整 authority tuple。
- 可信 Plan、provider usage mapping、published GateSpec、业务 Worker 和生产连接池仍未知且不阻断本轮数据库安全原语；它们不得由 owner fixture 或 caller JSON 代替。
- G0-08 的 crash/failure 门在 G1 前只聚合数据库原语与最小 host harness；完整 NodeExecutor、HumanGate 多 cohort、child join 和纵向业务崩溃矩阵留给 G1-05/G1-08。

### 下一步

进入 Plan，把 domain/runtime contract、role bootstrap、005 migration、run-core lease/event纯边界、PostgreSQL 16 failure harness、旧 migration 边界修复与组合质量门拆成依赖有序的 TDD 任务；Plan 通过前不修改产品代码。

## Plan：实施结论与边界

G0-07 可以直接进入实现，但必须作为 **L4 串行安全切片** 落地：contract → pure core → static migration red gate → bootstrap roles → 005 migration → migration lifecycle → PG16 attack/failure harness → 全量质量门。005、bootstrap 和 runtime-security harness 共享同一授权与恢复边界，不标记 `[P]`；只有只读独立审查可并行。

`forward-only` 表示生产环境只允许向前修复。`005_runtime_security.down.sql` 只用于“005 从未被实际使用”的本地 disposable PostgreSQL 16 空事实回退证据，不是生产数据回滚方案。

### 变更前后契约

| 表面 | G0-06 当前事实 | G0-07 完成后的唯一目标 | 明确不升级的结论 |
|---|---|---|---|
| 内部身份 | 管理/运行时 context，没有 phase attestation | 最长 15 分钟、绑定 Workspace + `session_user` + exact phase 的内部 attestation；transaction proof 逐事务建立 | 不证明生产连接池、mTLS、外部 credential 或云端身份 |
| Attempt lease | 只有结构列，无闭合 claim/renew/reclaim authority | DB-clock、显式 1～300 秒 duration、DB 派生 `lease_owner=session_user`、完整 token/fence/expiry 校验；reclaimer 只 fence 并产生 recovery ticket，execution 再 claim 新 generation | pure core 不构成持久化授权；无真实 Worker/scheduler |
| durable write | Event/Checkpoint/Billing 不能完整证明 producer lease | Event、Checkpoint、effect receipt绑定 exact Run/Attempt/Step/session-user/lease tuple；phase 账务使用显式 authority union 的 `billing-intent/2` + `credit-ledger-entry/2` | 已有 Billing/Ledger `/1` 保持不变；005 的 `/2` 只解决 authority shape，fence 上限仍是 JS safe integer |
| 恢复 | 没有可信 retry/effect provenance | immutable accepted-plan envelope、operation key、receipt 与 checkpoint 决定 safe/keyed/hold | caller JSON、`admission_snapshot_hash` 和 owner 造数不能冒充可信 Plan |
| 终态 | failure-only finalizer，账务 helper 只校验 fence | leased 或 dedicated finalizer claim 单赢家，账务/Step/Event/tombstone/snapshot/Outbox 同事务 | `SUCCEEDED`、HumanGate 正向、child Run 继续 fail closed |
| Outbox | 结构 lease，无阶段 dispatcher authority | G0-07 只闭合 `RUN_DISPATCH` claim/recovery-fence/takeover/ack 失败夹具 | SSE/WEBHOOK/ANALYTICS 通用 delivery 留给 G1-06 或后续 ADR |
| 归档/保留 | owner 函数和 evidence facts 已存在 | archive executor 只登记 manifest；retention 仅凭独立 verified+approved receipts/horizon 清理 | archive executor 不得自验、自批；ledger 不可清理 |
| 验证 | 五套 disposable PG16 suite | 六套串行 suite，增加 ACL、attestation、两连接 fencing 与 backend termination | backend termination 不等于 PostgreSQL server/WAL crash |

## Plan：精确 phase authority matrix

所有 phase executor 共同只获得 `auth.establish_internal_service_workspace_context(uuid, bytea, text)` 与本 phase 的显式 façade；数据库必须从 attestation 导出 Workspace，并重验 TTL、撤销、`session_user`、exact phase、exact role membership 与当前 transaction proof。execution claim 必须把 `lease_owner` 从当前 proof 的 `session_user` 派生，后续 renew/relinquish/write/ack 必须再次重验；另一个属于同 phase 的 login 即使获得完整 token/fence 也没有 authority。reclaimer 不取得 active Worker lease：它只 fence 旧 generation、清 lease 并产生不可变 recovery ticket/hold intent。所有 executor 均无原始事实表 DML、schema `CREATE`、database `TEMP`、owner/runtime/issuer membership，且互不继承。

| role / phase | 005 可执行表面 | 必须重验的 authority | 继续拒绝 |
|---|---|---|---|
| `ba_internal_service_attestation_issuer` | issue/revoke façade | Workspace、目标真实 `session_user`、closed phase、TTL ≤ 15m、32-byte HMAC verifier、单向撤销 | establish、tenant DML、任一 phase mutation；issuer/executor/owner/runtime 重叠 |
| `ba_admission_executor` / `admission` | 本轮只有 common establish，无产品 mutation grant | 未来必须同时证明 acceptance miss、可信 accepted Plan 与冻结 `accepted_plan_hash` | `accept_prepared_*`、`reserve_credits`、caller JSON/fixture 冒充 Plan |
| `ba_execution_executor` / `execution` | claim/renew/relinquish Attempt；固定语义的 Event/Checkpoint/effect receipt/usage attribution/leased termination intent；仅 `RUN_DISPATCH` outbox claim/renew/complete/fail | protocol-v5 provenance、可执行 Run/Attempt、proof `session_user=lease_owner`、完整未过期 lease tuple、正确 Step、固定 event/action | billing/finalizer/recovery-fence/reconcile/archive/retention；任意 event type；通用 dispatcher |
| `ba_metering_executor` / `metering` | `settle_attributed_credits` façade | execution owner 在当时 active lease 下持久化的 immutable usage attribution、Step、reservation、稳定计量幂等键；消费时锁 attribution/provenance 并一次性 CAS，不要求旧 lease 仍 current，也不要求 consumer login 等于 producer owner | reserve/release/expire/reconcile；caller 自报 usage；旧 `settle_credits` 直接授权 |
| `ba_finalizer_executor` / `finalizer` | attributed/claimed finalizer façade；dedicated claim 只在同一 outer transaction 内 row-lock/CAS 获取并立即消费 | attributed path 使用 execution owner 在当时 active lease 下写入的 immutable termination intent；claimed path 只接受 durable cancel mutation/event 或 recovery-hold ID；Run-wide quiescence + terminal CAS；对已 fence 但未 claim 的 Attempt recovery ticket 必须生成 terminal disposition 并使旧 claim 失效 | caller 自报 reason/timeout、standalone claim、空 attribution、直接 billing helper、`SUCCEEDED`、child/HumanGate 正向 |
| `ba_reclaimer_executor` / `reclaimer` | fence expired Attempt/`RUN_DISPATCH`，根据锁定事实派生 recovery ticket/hold；若 termination intent 已存在，仅 fence/清 lease并保持 intent 未消费；从不取得 active lease | DB time 已过 expiry、旧 token/fence、retry/effect envelope、effect class/key/receipt、未消费 termination attribution | 到期前 fence、到期后 renew、termination intent 存在时消费/替换 intent 或创建 replay ticket、unsafe/unknown 自动重放、直接 claim/执行/ack/计量/终态 |
| `ba_reconciliation_executor` / `reconciliation` | `reconcile_needs_attention_billing` façade | terminal/billing 均 `NEEDS_ATTENTION`、不可变 resolution/approval evidence、幂等键、精确 reservation/allocation | resume/retry/finalize、任意 correction、archive/purge |
| `ba_archive_evidence_executor` / `archive_evidence` | 新 phase façade；旧 004 register primitive 保持 owner-only | context-derived Workspace、terminal Run、material kind、immutable ref/hash、registration miss | caller-selected Workspace、verify、approve、purge、manifest DML |
| `ba_retention_executor` / `retention` | 新 phase purge façades；旧 004 purge primitives 保持 owner-only | context-derived Workspace、terminal、billing settled、独立 VERIFIED+APPROVED receipts、分类 horizon、purge receipt miss | caller-selected Workspace、register/verify/approve、ledger/reservation/idempotency tombstone 删除 |

旧 004 业务函数不直接授给 phase executor。005 以 NOLOGIN owner primitive + narrow phase façade 组合；`app.current_workspace_id()` 由 005 forward-replace 以识别 internal-service proof，`app.current_authenticated_principal_id()` 对 phase context 必须返回 `NULL`，防止内部 executor 进入 principal-scoped endpoint。旧 `app.validate_billing_producer(...)` 保持 004 body/owner/ACL；005 forward-replace owner-only `app.settle_credits(...)`/`app.release_credits(...)` 为“原 current-fence authority wrapper + shared financial kernel”，并在 down 恢复精确 004 body。owner-only `app.finalize_run(jsonb)` 的 004 `/1` 输入、current-fence authority、replay、SQLSTATE 与终态写集也保留为独立 compatibility branch；phase finalizer 只能调用新 `/2` façade，不能进入该 branch。protocol-v5 historical attribution 和 transaction-scoped cancel claim 使用各自严格 validator 后进入同一个 kernel，不能复制或弱化 004 金额、reservation/allocation、charge-key、workspace balance/version、ledger 去重与状态转移不变量。

### 账务 authority 与版本化唯一决策

004 的 `BillingIntentV1`/`CreditLedgerEntryV1` 和 `credits_ledger_producer_shape_check` 都把 `SETTLE|RELEASE` 限定为真实 producer Attempt + fence。因此 pre-claim/keyless durable cancel 不能声称是 `/1`，不能伪造 Attempt/fence，也不能借 `EXPIRED` 或 `RECONCILIATION` 搬动正常取消资金。G0-07 冻结下列新 ABI：

- `billing-intent/1` 与 `credit-ledger-entry/1` 原样保留；through-004 历史和 owner-only current-fence compatibility wrapper 仍投影为 `/1`。
- 新增 strict `BillingIntentV2` 与 `CreditLedgerEntryV2`，只允许 protocol-v5 `SETTLE|RELEASE`；两者都带 discriminated authority：`USAGE_ATTRIBUTION` settlement、`TERMINATION_ATTRIBUTION` release 或 `CANCELLATION_RELEASE` release。`/2` 不放大 fencing 数值范围。
- 新增 DB-authored `RunCancellationReleaseAuthorityV1`；它只绑定 source layer：Workspace/Run/billing-owner Run/reservation、exact `RUN_CANCEL_REQUESTED` event ID+sequence+cancel intent hash、terminal intent/effect-closure hash、exact remaining amount、operation/reason 与 DB `authorized_at`。不带 Attempt/fence，也不带 ledger ID、charge key、billing-intent hash、charge-attribution hash 或任何依赖自身 hash 的 derived 字段；caller 提交的同形 JSON 永远不是 bearer。
- 三种 `/2` authority 共用一个单向 hash DAG：`source_authority_hash = SHA-256(domain || JCS(source-layer fields))` → `charge_attribution_hash = source_authority_hash` → DB 从 locked source facts + source hash 派生 stable charge key → 对不含自身 hash 的 `BillingIntentV2` 计算 `billing_intent_hash` → 预选 ledger/authority receipt ID 并写 receipt/ledger。三个 domain 分别为 `better-agent/execution-usage-source/1\\0`、`better-agent/execution-termination-source/1\\0`、`better-agent/run-cancellation-release-source/1\\0`；不得共用无 domain 的泛化 hash。
- `EXECUTION_USAGE` source preimage 只含 Workspace/billing-owner Run/metered Run/reservation、usage attribution ID、Attempt/Step/token/fence/producer session user、metering unit/quantity/amount/operation、当时 lease expiry、DB `authorized_at` 与 execution/effect payload hash；`EXECUTION_TERMINATION` 只含 Workspace/Run/billing-owner/reservation、termination source ID、Attempt/Step/token/fence/producer session user、terminal intent/effect-closure hash、排序的 usage-attribution ID 集合、intended settle/release amount/operation/reason、当时 lease expiry 与 DB `authorized_at`；`DURABLE_CANCEL` 只含上述 `RunCancellationReleaseAuthorityV1` source layer。三者 preimage 都明确排除 source/whole-record hash 自身、charge key、billing-intent/charge-attribution hash、authority receipt/ledger ID 及 hash、consumption/disposition 字段和所有其他 financial/receipt-derived 值。
- authority receipt 封存 source ID/hash + 全部 downstream financial binding，ledger 反向引用 authority ID/source hash。若 contract 需要 whole-record hash，它只能在 receipt/ledger 完整投影之后作为最末层计算，不得回流到 source/BillingIntent preimage。任一 canonical input 只能向下游传播，不存在 hash 固定点或环。
- 004 的 `run_mutation_idempotency` 只在请求携带 Idempotency-Key 时存在，所以它不是 claimed-cancel 的必需 authority。权威 cancel fact 是经 004 认证函数原子写入的 Run `CANCEL_REQUESTED` 转移 + exact `RUN_CANCEL_REQUESTED` event；有 mutation receipt 时只作额外审计关联。
- 005 新增 run-owned、append-only、不受技术 retention 删除的 `run_billing_authority_receipts`；它以 strict XOR 封存 `EXECUTION_USAGE | EXECUTION_TERMINATION | DURABLE_CANCEL` 的 source ID/hash、历史 producer tuple（如适用）、Run/reservation/operation/amount/charge 事实与 `authorized_at`。它在写入时锁定并验证原 source，随后只保留封存 ID/hash；不建立到未来可清理 Event/effect/attribution 行的长期 FK，避免账本 provenance 阻断合法 retention。
- 005 向 `credits_ledger` 增加 `entry_schema_version`、`authority_schema_version`、`authority_kind`、`authority_id`；旧行固定为 `/1` 且 authority 三列均空。`/2` usage/termination 行仍要求真实 producer tuple 并以复合 FK 绑定封存 receipt；cancellation 行仅能是 `RELEASE`、`producer_run_id=run_id`、Attempt/fence/Step 全空，并以复合 FK 绑定 `DURABLE_CANCEL` receipt。新 shape constraint 是 legacy `/1` + 三个 `/2` authority 分支的严格 XOR；原 delta/balance/charge-key/FK/append-only 不变量不放宽。
- authority receipt 与 ledger 是同一 outer transaction 内的一对一事实：预选 ledger ID，receipt 以 deferred FK/约束绑定该 ledger，ledger 反向复合 FK 绑定 receipt，partial unique 保证一个 authority 最多消费一次；任一侧缺失均不能 commit。cancellation receipt 还必须在同一 finalizer 事务绑定 terminal Run。零 remainder 要分两类：若 reservation 仍是 zero-credit `HELD`，写唯一零 delta `/2` cancel-release receipt/ledger 并关闭为 `RELEASED`，balance version 不增加；若正数 reservation 已被先前或同事务 confirmed usage 全额结算为 `SETTLED`，或已合法 `RELEASED|EXPIRED`，finalizer 只验证既有 ledger 完整关闭且不再写 release receipt。任何 nonzero remainder 或未闭合的 terminal reservation 都拒绝。
- `/2` 的 exact replay 必须同时匹配财务 intent 和 authority kind/source ID/hash；“同 charge key + 同金额但不同 attribution/cancel source”是冲突，不得消费新 source 后返回旧 ledger。
- billing wrapper 共用 004 的 crash-retry 前缀：先完成 operation 的 non-authority input-shape validation（amount/hash/key/detail/reason/time），再以 charge key 读取已提交 ledger。V1 的 004 replay financial match set 固定为 `entry_kind + billing_intent_hash + run_id + reservation_id + amount`；005 显式 strengthening 还要求 complete producer binding，V2 还要求 authority kind/source ID/hash。全部精确相同时直接返回首次 ledger ID，不重验 current fence/Run 当前态、不再消费 source；不同则 `23505`。owner-only current-fence `/1` settle/release compatibility wrapper 在 committed miss 后必须继续精确 004 顺序：Workspace lock → ledger recheck → 旧 producer/reservation validator → shared kernel；不新增 Run terminal/billing-state gate，以保持 V1 exact differential。只有 protocol-v5 `/2` attributed/claimed first-consumption miss 才在 Workspace lock + ledger recheck 后锁定 billing-owner/metered Run；任一 Run 已有 `terminal_intent_hash`、已是 terminal status，或 billing-owner Run 的 `billing_state=NEEDS_ATTENTION`，都必须在 authority source CAS/receipt/ledger/资金变动前 fail closed。只有仍 nonterminal 且 billing 可结算的 `/2` miss 才验证/CAS authority 并调用 kernel。这不阻止 HOLD 之前已提交 `/2` financial operation 在 HOLD 之后做 exact replay，但阻止任何新 `/2` operation 在 terminal/NEEDS_ATTENTION 后消费保留的 attribution。finalizer 同理按全局顺序先锁 Workspace billing fence、再锁 Run/读 tombstone：exact intent replay 在检查 consumed source/transient claim 前返回，different intent 先冲突。

### Fencing 数值唯一决策

G0-07 protocol-v5 全链 fencing 范围冻结为 `1..9007199254740991`。新 execution 与 Billing `/2` contract 使用 canonical decimal string，但必须能无损转换为 positive safe integer；005 的 provenance-aware constraint 与所有 mutation helper 对新行拒绝更大值，`9007199254740991 + 1` 立即 fail closed。upgrade 不得把无法通过完整 `CreditLedgerEntryV1`/`BillingIntentV1` parser 的 SQL-only 004 行伪标为 `/1`；preflight 对任一 oversized producer fence 或其他无法无损投影为 `/1` 的旧 ledger 返回 `55000`，失败事务结束后的 migration ledger、所选 catalog（含 RLS 位）与夹具事实逻辑 digest 零变化。只有通过 `/1` 重算的 through-004 行才能回填 `entry_schema_version=1`。本切片新增 Billing/Ledger `/2` 是因为 authority union 发生语义变化，不是为了放大 fence；`run-event/1`、`run-outbox-message/1` 和旧 Billing/Ledger `/1` 仍不变。若未来需要使用超过 safe integer 的 fence，必须再新增独立版本 contract/migration。

### Schema-qualified function / owner / ACL oracle

除下表唯一 grantee 外，所有函数均 `REVOKE ALL ... FROM PUBLIC, ba_runtime, ba_control_executor` 及其他 phase executor；owner/private helper 之间只授精确 `EXECUTE`，不授 membership。所有 phase façade 从 signed context 派生 Workspace，caller JSON 中的 `workspace_id` 必须缺失或被拒绝，绝不作为 authority。

| inventory | exact signature（005） | owner | 唯一 direct EXECUTE grantee / internal caller |
|---|---|---|---|
| new auth issue | `auth.issue_internal_service_attestation(uuid, uuid, name, text, text, bytea, bytea, timestamptz) RETURNS void` | `ba_auth_owner` | `ba_internal_service_attestation_issuer` |
| new auth revoke | `auth.revoke_internal_service_attestation(uuid, text) RETURNS void` | `ba_auth_owner` | `ba_internal_service_attestation_issuer` |
| new common establish | `auth.establish_internal_service_workspace_context(uuid, bytea, text) RETURNS uuid` | `ba_auth_owner` | 八个 phase executor，不含 issuer |
| new private phase proof | `auth.require_internal_service_phase(text) RETURNS uuid` | `ba_auth_owner` | `ba_run_owner`、`ba_billing_owner`、`ba_archive_evidence_owner`、`ba_retention` only |
| replaced context projection | `app.current_workspace_id() RETURNS uuid`；`app.current_authenticated_principal_id() RETURNS text` | `ba_auth_owner` | 保持 004 签名/ACL；只新增 internal proof 分支，principal 对 phase 永远 `NULL`；static/up/down fingerprint 必须对 `pg_proc.prorettype` 断言 `text` |
| new execution-owner validator | `app.require_execution_owner_lease(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_run_owner` only；必须比较当前 proof session user |
| new cross-phase producer validator | `app.require_committed_producer_attribution(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_run_owner`、`ba_billing_owner` only；锁定 usage/termination source、验证历史 tuple、以 operation-specific CAS 消费并封存一次性 billing authority receipt；不比较 consumer login 与 producer owner，不要求旧 lease 仍 current |
| new private finalizer claim validator | `app.require_transaction_finalizer_claim(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_billing_owner` only；绑定当前 txid/Run/reservation/source kind+ID/hash/finalizer intent 与 exact financial operation，消费 transient claim 并封存 receipt，claim 不可提交或复用 |
| new shared financial kernel | `app.apply_credit_settlement_kernel(jsonb) RETURNS uuid`；`app.apply_credit_release_kernel(jsonb) RETURNS uuid` | `ba_billing_owner` | 无 direct grantee；仅 billing owner wrappers 内部调用，保持 004 财务语义等价 |
| new private attributed billing | `app.apply_attributed_settlement(jsonb) RETURNS uuid`；`app.apply_attributed_release(jsonb) RETURNS uuid` | `ba_billing_owner` | `ba_run_owner` only；settlement 消费 usage attribution receipt，release 只消费 outer finalizer 已锁定/消费 termination intent 后建立的 transaction claim；两者再调用 shared kernel |
| new private claimed release | `app.apply_claimed_release(jsonb) RETURNS uuid` | `ba_billing_owner` | `ba_run_owner` only；只接受 CLOSED durable-cancel transaction claim，金额由锁后 reservation remainder 派生，拒绝 hold/attribution/空或 caller-authored claim，再调用 shared release kernel |
| execution lease | `app.claim_run_attempt(jsonb) RETURNS jsonb`；`app.renew_run_attempt_lease(jsonb) RETURNS jsonb`；`app.relinquish_run_attempt_lease(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_execution_executor` |
| execution progress | `app.record_attempt_started(jsonb) RETURNS jsonb`；`app.record_attempt_retry_wait(jsonb) RETURNS jsonb`；`app.record_attempt_recovering(jsonb) RETURNS jsonb`；`app.record_attempt_finished(jsonb) RETURNS jsonb`；`app.record_step_started(jsonb) RETURNS jsonb`；`app.record_step_finished(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_execution_executor` |
| execution durable writes | `app.record_execution_checkpoint(jsonb) RETURNS jsonb`；`app.record_execution_effect_envelope(jsonb) RETURNS jsonb`；`app.record_execution_effect_receipt(jsonb) RETURNS jsonb`；`app.record_usage_attribution(jsonb) RETURNS jsonb`；`app.record_leased_termination_intent(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_execution_executor`；全部先通过 execution-owner validator；effect 路径先提交 immutable envelope，receipt 只能关闭既有 envelope |
| execution dispatch | `app.claim_run_dispatch(jsonb) RETURNS jsonb`；`app.renew_run_dispatch_lease(jsonb) RETURNS jsonb`；`app.complete_run_dispatch(jsonb) RETURNS jsonb`；`app.fail_run_dispatch(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_execution_executor` |
| private terminal Attempt retirement | `app.retire_run_attempts_for_finalizer(jsonb) RETURNS jsonb` | `ba_run_owner` | 无 direct grantee；仅 attributed/claimed finalizer 在 Run-wide locks 内调用，终止 active/PENDING Attempt 并为未消费 recovery ticket 生成 one-to-one terminal disposition |
| private terminal dispatch retirement | `app.retire_run_dispatches_for_finalizer(jsonb) RETURNS jsonb` | `ba_run_owner` | 无 direct grantee；仅 attributed/claimed finalizer 在 Run-wide locks 内调用，生成 immutable retirement receipt |
| metering | `app.settle_attributed_credits(jsonb) RETURNS jsonb` | `ba_billing_owner` | `ba_metering_executor`；exact ledger replay 可在 terminal 后返回；committed miss 必须先锁 billing-owner/metered Run 并拒绝 terminal/`NEEDS_ATTENTION`，再调用 committed-attribution validator + new private attributed settlement |
| replaced current-fence billing | `app.settle_credits(uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint, text, text, text, jsonb, timestamptz) RETURNS uuid`；`app.release_credits(uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint, text, text, text, text, timestamptz) RETURNS uuid` | `ba_billing_owner` | 保持 004 owner/ACL；先执行 exact committed replay，miss 才在 Workspace lock + recheck 后调用旧 validator 与 shared kernel；down 恢复 004 body |
| replaced owner finalizer | `app.finalize_run(jsonb) RETURNS jsonb` | `ba_run_owner` | owner-only 004 `/1` compatibility branch；保留原 p_fact shape、current Attempt/active lease/fence validator、tombstone replay顺序、terminal mapping、timestamp/remainder 检查、terminal write set 与 SQLSTATE，账务调用经 owner-only `/1` settle/release wrapper 进入 shared kernel；无 executor grant，phase façade 永不调用；down 恢复精确 004 body/owner/ACL |
| finalizer | `app.finalize_attributed_run(jsonb) RETURNS jsonb`；`app.finalize_claimed_run(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_finalizer_executor`；attributed path 只用 attributed billing；CLOSED cancel path 只用 claimed release；hold path不得移动未知资金 |
| reclaimer | `app.fence_expired_run_attempt(jsonb) RETURNS jsonb`；`app.record_recovery_hold_intent(jsonb) RETURNS jsonb`；`app.fence_expired_run_dispatch(jsonb) RETURNS jsonb` | `ba_run_owner` | `ba_reclaimer_executor`；函数命名明确不产生 active lease |
| reconciliation | `app.reconcile_needs_attention_billing(jsonb) RETURNS uuid` | `ba_billing_owner` | `ba_reconciliation_executor`；内部调用 owner-only 004 reconcile primitive |
| archive | `app.register_phase_run_archive_manifest(jsonb) RETURNS uuid` | `ba_archive_evidence_owner` | `ba_archive_evidence_executor`；内部调用 owner-only 004 register primitive |
| retention | `app.purge_phase_run_events(jsonb) RETURNS uuid`；`app.purge_phase_run_recovery_material(jsonb) RETURNS uuid` | `ba_retention` | `ba_retention_executor`；内部调用 owner-only 004 purge primitives |

004 的 `accept_prepared_*`、reserve/expire/reconcile primitives、child/HumanGate、archive register/verify/approve 与 retention purge 全部保持 owner-only且正文不变。005 仅 forward-replace 两个 context projection、owner-only settle/release 与 `app.finalize_run(jsonb)`；down 必须恢复五者精确 004 body/owner/ACL，其他 004 函数不得发生 catalog 变化。

### Transaction-scoped finalizer claim 与全局锁顺序

`transaction-scoped` 不使用 caller nonce、`set_config`、TEMP 或可单独提交的 capability。005 建立 private `finalizer_transaction_claims` 工作表，只由 `ba_run_owner` 在完成 Run-wide locks/source CAS 后写入，绑定 `txid_current()`、Workspace/Run/reservation、source kind+ID+hash、effect closure/finalizer intent 和 exact settle/release operation。`ba_billing_owner` 只能经 `app.require_transaction_finalizer_claim` 以当前 txid 锁定并消费该行，同一语句封存 durable billing receipt；表无 PUBLIC/executor DML/SELECT。deferred constraint trigger 要求 transaction end 时不存在未消费 claim，所以任何“只 acquire 就 commit”均以 `55000` 失败；outer rollback 同时恢复 source CAS、receipt、ledger、reservation 与 terminal facts。

所有账务/finalizer wrapper 冻结同一锁顺序：Workspace billing row/fence → Run → 按 ID 排序的 Attempts → 各 Attempt 的 recovery ticket/disposition → Steps → effect/usage/termination facts → `RUN_DISPATCH` 及其 recovery ticket/disposition → reservation/allocation → authority/charge-key/ledger。historical attribution 的验证/CAS 必须在获得 Workspace billing lock 之后执行；shared kernel 不得以相反顺序重新获取 Run/Attempt 锁。该顺序与 004 的 Workspace 先行资金串行化保持一致，PG16 必须观测阻塞边而不是靠 sleep 推断。

### Terminal 时 Attempt recovery ticket 退役决策

reclaimer 可能已在 expired Attempt 上线性化，产生 `PENDING + ticket N+1`，但 execution recovery claim 尚未获得 Run/Attempt 锁。finalizer 不能只终止 active lease 或断言“无 recoverable Attempt”；005 必须新增 strict `RunRecoveryTicketDispositionV1`、private `run_recovery_ticket_dispositions` 与 owner-only `app.retire_run_attempts_for_finalizer(jsonb)`：

- recovery ticket 本体保持 immutable。execution recovery claim 在 Run → Attempt → ticket 锁序内以唯一行插入 `CLAIMED`，封存 ticket ID/hash、resource identity、`N+1 → N+2`、claiming session user/token 与 DB time；finalizer 在同一唯一键上插入 `TERMINAL_RETIRED`，封存 exact terminal source/intent、old fence、Attempt post-state 与 DB time。两者只能一个提交。
- finalizer 在锁定全部 Attempt 及 ticket/disposition 后，对未 disposition 的 `PENDING + ticket`：CLOSED branch 把 Attempt 转为与 terminal reason 对应的 `CANCELLED|FAILED`；HOLD branch 转为 `RELINQUISHED` 并绑定 immutable hold evidence。两者都保留 `N+1` generation、确保 owner/token/expiry 为空，并插入 `TERMINAL_RETIRED` disposition。已 `CLAIMED` 则按当前 active Attempt 终止语义处理，不伪造 ticket retirement。
- same terminal intent 从 Run tombstone + disposition 精确重放；different terminal intent 与既有 disposition 冲突。旧/missing/replayed ticket 的 recovery claim 在 Run terminal/finalizer CAS、Attempt status 和 unique disposition 三层均失败。outer rollback 必须同时恢复 Attempt、ticket disposition、hold/terminal facts，不得留下“ticket 已退役但 Run 未终态”。

### Terminal 时 `RUN_DISPATCH` 退役决策

004 acceptance 会在 Attempt 存在之前写入 initial `RUN_DISPATCH/PENDING`，而 durable cancel 不会关闭它。因此 finalizer 不能只“等待无 pending dispatch”；005 必须新增 strict `RunDispatchRetirementReceiptV1`、private `run_dispatch_retirement_receipts` 与 owner-only `app.retire_run_dispatches_for_finalizer(jsonb)`，并在同一 terminal outer transaction 内执行：

- finalizer 在 Run/Attempt/effect 锁后按 Outbox ID 锁定全部 `RUN_DISPATCH` 及 recovery ticket。`PENDING` 原子转 `DEAD`，`last_error_redacted` 只能是 DB-authored `RUN_TERMINATED_BEFORE_DISPATCH`；`LEASED` 无论当前是否过期，都先将 protocol-v5 durable delivery generation fence 增加 1，再清 owner/token/expiry、转 `DEAD`。receipt 封存旧 status/owner/token/fence、新 generation、terminal source/intent 与 retired_at；任何未消费 recovery ticket 同事务标记为 terminal-retired，不得后续 takeover。
- 005 的 protocol-v5 Outbox provenance 保留 independent durable delivery generation，即使 live lease 列在 `DEAD` 时按 004 shape 清空，也不丢失最后 fence。stale complete/fail/renew 必须同时因 status + generation + receipt 失配而零副作用。`run-outbox-message/1` 的现有 DEAD 投影不改版，retirement 证据由独立 contract 表达。
- `DELIVERED` 不改写，但 finalizer 仍要求 Run/Attempt/effect closure 闭合；即使外部 dispatch 已发生，任何后到 Worker 也必须在 Attempt claim 锁 Run 后因 terminal/finalizer CAS 被拒绝。已有 `DEAD` 必须带合法 protocol-v5 delivery-failure/retirement evidence；伪 DEAD 不能帮助终态化。
- 退役完成后再断言无 `PENDING|LEASED RUN_DISPATCH`；terminal 事务自身可新写 `SSE_WAKE`，它不是本轮退役对象。dispatcher 的 claim/complete/fail/recovery-fence 必须统一按 Run → Outbox 锁顺序并重验 Run 非 terminal，与 finalizer 只能一方在线性化点获胜。outer rollback 恢复 Outbox lease/status/generation/ticket/receipt。

## Plan：依赖有序的 TDD 任务

### T1 — 前向修订 ADR 并冻结 G0-07 execution/billing contracts

- **文件集合：** 修改 `docs/adr/004-持久化执行与计费.md`、`packages/domain-contracts/src/{index,registry}.ts`、`packages/billing-core/src/index.ts`；新增 `packages/domain-contracts/src/{run-execution-v1,billing-v2}.ts`、`packages/domain-contracts/test/g0-07-{run-execution,billing,registry}.test.ts`、`packages/billing-core/src/{intent-hash-v2,ledger-v2}.ts`、`packages/billing-core/test/g0-07-billing-v2.test.ts`。
- **依赖：** Think 的 phase/lease/recovery 词汇。
- **风险：** L3（持久化 ABI 前像）。
- **先红：** partial/terminal active lease、zero/`MAX_SAFE_INTEGER + 1` fence、`lease_owner` 与 authority `session_user` 缺失/不等、recovery PENDING 缺 ticket、ticket 无/双 disposition 或 `CLAIMED|TERMINAL_RETIRED` 混搭、unknown field、`requires_key` 缺 operation key、receipt ref/hash 不闭合、checkpoint 缺 Attempt/fence、usage/termination attribution 缺 producer lease identity、termination intent × missing/unsafe/UNKNOWN effect closure、recovery-hold 缺旧 generation/reason、cancellation authority 缺 event/effect/reservation 绑定或 hash DAG 任一层篡改、`/2` authority 双空/双写或误标 `/1`、registry 漏注册。
- **实现：** 先在 ADR-004 forward-replace“metering/finalizer 消费时必须 current active lease”为唯一新语义：execution mutation 仍要求 current active lease；由 execution-owner façade 在 lease 有效时原子建立的 immutable producer attribution 是 historical authority source，cross-phase consumer 可在 lease 过期/fenced 后凭 exact tuple + operation-specific CAS 消费并封存不可清理的 billing receipt。随后实现 strict `RunAttemptLeaseStateV1`、`RunAttemptLeaseAuthorityV1`、1～300 秒 duration primitive、`RunRetryEffectEnvelopeV1`、`RunSideEffectReceiptV1`、`RunExecutionCheckpointV1`、`RunUsageAttributionV1`、`RunTerminationIntentV1`、`RunRecoveryTicketV1`、`RunRecoveryTicketDispositionV1`、`RunRecoveryHoldIntentV1`、`RunDispatchRetirementReceiptV1`、`RunCancellationReleaseAuthorityV1`、`BillingIntentV2`、`CreditLedgerEntryV2`。Attempt/`RUN_DISPATCH` 的 recovery PENDING 必须带唯一 `recovery_ticket_id`；ticket 只绑定 resource identity、旧 fence、N+1 fence、checkpoint/effect decision 与 created generation；后续 `CLAIMED|TERMINAL_RETIRED` 只能写入 one-to-one immutable disposition，不回写 ticket。usage/termination attribution 必须绑定 exact Run/Attempt/Step/token/fence/producer session user、DB-authored `authorized_at`/当时 `lease_expires_at`、intent hash 与 consumed generation；termination intent 还必须携 `effect_disposition=CLOSED`、DB 重算的 `effect_closure_sha256` 与 source-layer billing-close intent（排序的 usage attribution IDs、intended settle/release amount/operation/reason），不得携 ledger/receipt ID、charge key、billing/charge/whole-record hash或消费状态；真正的 derived financial plan 只在下游 authority receipt 封存。record façade 对 missing envelope、unsafe、UNKNOWN receipt 一律拒绝。usage/termination/cancellation 三种 authority 都只能由 DB 从各自锁定 source facts 派生 source layer，按上述无环 DAG 依次计算 `source_authority_hash`、`charge_attribution_hash`、stable charge key 与 `billing_intent_hash`，caller 不能选金额/ID/key/hash/time。contract test 必须对三个 authority kind 各用 known vector 独立重算每层 preimage，逐字段 single-bit tamper 必须只向下游改变并拒绝旧 binding，response-loss exact replay 保持全部 derived hash/ID 稳定。dispatch retirement 绑定 old/new delivery generation、terminal source 和 DB time，不伪造 DELIVERED。新 fencing 使用上限为 `9007199254740991` 的 canonical decimal string；ticket/hold 永远不带 active lease。不原地修改 `run-event/1`、`run-outbox-message/1`、Billing/Ledger `/1`。
- **跨层 JSON 与时间语义：** `JsonValue` 的 number 分支只接受 JavaScript finite number；PostgreSQL `jsonb numeric` 比 JavaScript Number 范围更宽，任何要进入 usage/ledger contract 的 detail 必须递归拒绝在 JavaScript 侧会成为 `±Infinity` 的数值。PostgreSQL instant 比较保留完整小数秒与 offset，不得经 `Date.parse` 降格为毫秒；normal terminal 的 `billing_settled_at === finished_at` 必须达到 PostgreSQL 微秒精度。
- **证据：** focused contract/registry/V2 hash+ledger tests、domain-contracts 与 billing-core package test/typecheck/build。

### T2 — Attempt lease 与 authority pure state machine

- **文件集合：** 新增 `packages/run-core/src/{postgres-instant,attempt-lease}.ts`、`packages/run-core/test/attempt-lease.test.ts`；修改 `terminal-snapshot.ts`、`errors.ts`、`index.ts` 与 fixtures。
- **依赖：** T1。
- **风险：** L4（并发 generation 与过期语义）。
- **先红：** 第二次 claim、mixed Workspace/Run/Attempt/token/fence/session-user、expired authority、renew 缩短或超过 `now + 5m`、到期后 renew、relinquish + missing/unsafe/UNKNOWN effect closure、relinquish 后再次 claim/recovery-fence、旧 writer、safe-integer overflow、PENDING recovery ticket 被 claim 与 terminal retire 双消费、retire 后 stale claim、same/different terminal intent replay。
- **实现：** `assertRunAttemptLeaseAuthority`、claim/renew/relinquish 与 recovery-ticket disposition immutable decisions。函数不读时钟/数据库/随机源；pure core 接收 adapter 已从 signed proof/DB 派生的 `now`、session user、token、expiry，不接受业务调用者自报 owner。普通 relinquish 只接受 DB 已重算为 CLOSED 的 effect closure；missing/unsafe/UNKNOWN 时 fail closed且原 lease不变，断连后由 expiry reclaimer 或 cancel finalizer 的 HOLD-first路径处理。recovery ticket 不可变，pure decision 只返回可由 DB 在 unique `(workspace_id, recovery_ticket_id)` 上插入的 `CLAIMED|TERMINAL_RETIRED` disposition intent。
- **时间精度：** run-core 以 bigint 微秒解析 PostgreSQL instant，拒绝超过 6 位小数；domain contract 用完整小数部分比较跨 offset instant。锁后 `clock_timestamp()` 决定数据库线性化时点，跨层序列化不得把 `.123400` 与 `.123900` 折叠成同一毫秒。
- **证据：** focused lease test 后运行 run-core test/typecheck。

| operation | 允许的 pre-state | 唯一 post-state | 其他状态 |
|---|---|---|---|
| initial claim | `PENDING` 且无 recovery ticket，fence generation 尚可 `+1` | `RUNNING` + 完整 lease + derived session user | 全拒 |
| recovery claim | `PENDING` + exact ticket + 无 disposition；同事务锁 Run/Attempt/dispatch + ticket 并重验 identity/old fence/checkpoint/effect decision | 插入唯一 `CLAIMED` disposition，于 `N+2` 形成 `RUNNING/LEASED` + execution-derived owner/token | missing/wrong/replayed/terminal-retired ticket 全拒；回滚不得留 disposition |
| renew | active、未过期 `RUNNING`，同 session user/token/fence | 仍 `RUNNING`，仅 expiry 严格延长且 ≤ lock 后 DB time + 5m | 全拒 |
| relinquish | active、未过期 `RUNNING`，同完整 authority，且全 Attempt effect closure=CLOSED | `RELINQUISHED`，清 token/owner/expiry，保留 generation | missing/unsafe/UNKNOWN 全拒且 lease 原样保留 |
| recovery fence | 已过期 `RUNNING` + replayable recovery decision | fence `N+1`、无 owner/token/expiry 的 `PENDING` + immutable recovery ticket | 全拒；reclaimer 不得取得 Worker lease |
| recovery hold | 已过期 `RUNNING` + HOLD | fence `N+1`、无 owner/token/expiry 的 `RELINQUISHED` + immutable hold intent | 全拒；只允许 finalizer claim 消费 hold ID |
| terminal retirement | `PENDING` + exact ticket + 无 disposition，且 finalizer 已锁 Run/Attempt 并取得 terminal CAS | CLOSED → `CANCELLED|FAILED`，HOLD → `RELINQUISHED` + hold evidence；均保留 `N+1`、插入 `TERMINAL_RETIRED` disposition | 与 recovery claim 单赢家；same intent 重放，different intent/旧 claim 拒绝；回滚全恢复 |
| terminal | `SUCCEEDED|FAILED|CANCELLED` | immutable | 全部 mutation 拒绝 |

`RELINQUISHED` 在 G0-07 是本切片不可重领状态，claim/recovery-fence 均拒绝；Gate/barrier handoff 的重新领取语义留给 G1，不允许借普通 claim 绕过 recovery envelope。

### T3 — Recovery policy 与 expired-generation fence pure decisions

- **文件集合：** 新增 `packages/run-core/src/recovery-decision.ts`、`packages/run-core/test/recovery-decision.test.ts`；修改 exports/errors/fixtures。
- **依赖：** T2。
- **风险：** L4（重复外部副作用）。
- **先红：** missing/invalid envelope、unsafe×CONFIRMED、safe×UNKNOWN、keyed×UNKNOWN、keyed×未持久化 key、Plan/Run/Attempt/Step/checkpoint/fence 混搭、到期前 recovery-fence、旧 fence post-takeover。
- **实现：** recovery 只返回 `REPLAY_SAFE | REPLAY_WITH_KEY | RESUME_FROM_RECEIPT | OPERATOR_HOLD`；identity/Plan/checkpoint/fence mismatch 是 hard reject，不得降级为 HOLD。reclaimer 仅接受 expired RUNNING，并先锁定/重算所有 effect envelope/receipt，再处理 termination intent：missing/unsafe/UNKNOWN 导出的 HOLD 始终优先，fence `N+1`、清 lease并建立 hold，任何普通 termination intent 不得被 finalizer消费；只有 effect closure 仍为 CLOSED 且 digest 匹配时，才可在 termination intent 存在时 fence/清 lease/转 `RELINQUISHED`并保持原 intent 未消费且不建 ticket；否则 replayable recovery 才产生 `PENDING` + ticket并允许 execution claim `N+2`。已提交 usage attribution 不阻止 recovery-fence，且在 N+1/N+2 后仍可由 metering 以历史 authority receipt 一次性 settle；所有路径都不把 reclaimer login 变成 lease owner。
- **证据：** focused recovery tests 与 run-core test/typecheck。

| committed envelope | receipt | 唯一 decision |
|---|---|---|
| missing/invalid | 任意 | `OPERATOR_HOLD` |
| `unsafe` | 任意（含 CONFIRMED） | `OPERATOR_HOLD` |
| `safe` | missing | `REPLAY_SAFE` |
| `safe` | CONFIRMED | `RESUME_FROM_RECEIPT` |
| `safe` | UNKNOWN | `OPERATOR_HOLD` |
| `requires_key` 且 key 已随 envelope 提交 | missing | `REPLAY_WITH_KEY` |
| `requires_key` 且 key 已随 envelope 提交 | CONFIRMED | `RESUME_FROM_RECEIPT` |
| `requires_key` 缺 key/未持久化，或 receipt UNKNOWN | 任意适用组合 | `OPERATOR_HOLD` |

`缺 envelope → HOLD` 只适用于已存在且进入执行的 Attempt/Step。accepted Run 若从未建立 Attempt，且无 execution-start/progress/checkpoint/effect/usage/termination facts，Run-wide effect closure 是带 domain-separated canonical empty digest 的空集 `CLOSED`，不把“从未执行”误判为“已执行但缺失 envelope”。这一例外只用于 no-worker cancel；只要存在 Attempt 执行痕迹而 envelope/receipt 不闭合，仍 HOLD-first。no-worker terminal Step 的 `attempt_id` 必须为 `NULL`，不创建 sentinel Attempt。

005 中 `app.record_recovery_hold_intent(jsonb)` 只能由数据库基于 expired tuple + 已锁定 envelope/receipt 原子派生唯一 durable intent；reclaimer 不能 finalize。`ba_finalizer_executor` 只能把该 intent ID 交给 `finalize_claimed_run(jsonb)`；函数在同一 outer transaction 内锁定 intent/Run、建立 idempotency CAS、完成终态并消费 intent。不存在可单独提交的 finalizer claim，也没有其 TTL、renew 或 reclaim seam；caller 不能自报 reason/evidence。

### T4 — Leased durable mutation decisions

- **文件集合：** 新增 `packages/run-core/src/leased-mutation-decisions.ts`、`packages/run-core/test/leased-mutation-decisions.test.ts`；修改 exports/errors；更新两包 README 的证据边界。
- **依赖：** T3。
- **风险：** L4（stale writer 与 producer/delivery fence 混淆）。
- **先红：** stale/mixed tuple 对 Event/Checkpoint/Receipt/Outbox 零 mutation；同 phase 第二 login 窃取；terminal/billing/SSE event；非 `RUN_DISPATCH` message；expired delivery ack；重复 DELIVERED；错误 message/run/token/fence；producer fence 与 delivery fence 混用；PENDING/LEASED/DELIVERED/DEAD × terminal retirement、retirement 与 recovery ticket/complete/fail 冲突。
- **实现：** 只提供 action-specific discriminated inputs：execution progress allowlist 精确为 `RUN_STARTED|RUN_RETRY_WAIT|RUN_RECOVERING|ATTEMPT_LEASED|ATTEMPT_FINISHED|STEP_STARTED|STEP_FINISHED`，每个 DB façade 固定一个 action；`RUN_ACCEPTED|RUN_QUEUED|RUN_FINISHED|CREDIT_RESERVED|CREDIT_SETTLED|OUTBOX_ENQUEUED|SSE_TASK` 全拒。Outbox enqueue/claim/renew/complete/fail/recovery-fence decisions 全部强制 `message_type=RUN_DISPATCH`，并新增只供 finalizer 使用的 retirement decision：PENDING/LEASED 转 DEAD + immutable receipt，DELIVERED 不改写，DEAD 必须验证既有 evidence。输出仅为不可变 persistence intent，不提供 caller-selected generic append/delivery，也不承担 DB authorization 或 dispatch。
- **证据：** focused tests；domain-contracts/run-core test/typecheck/build；`pnpm contract:check`。

### T5 — 005 static migration red gate

- **文件集合：** 新增 `packages/db/test/runtime-security-migration.test.ts`；修改 `packages/db/test/run-billing-migration.test.ts`。
- **依赖：** T1～T4 已冻结 schema/authority。
- **风险：** L2（只读静态红门）。
- **先红：** 精确断言 `005_runtime_security.{up,down}.sql`、upgrade guard 在受锁 owner/RLS inspection window 内且先于 protocol-v5 schema/data/ledger 变更、九个角色、owner/function inventory、definer path、ACL、down guard、004 replacement inventory、`run_billing_authority_receipts` 一对一/deferred 约束、ledger `/1|/2` XOR shape 与 Billing/Ledger `/1` 防漂移；失败原因只能是 005/roles 尚不存在。
- **约束：** 原“bootstrap 不含 phase roles”测试改成“004 自身不引入 phase roles”；记录 000～004 checksum 不变。
- **fail-closed 静态 oracle：** 固定 `app.g007_json_numbers_are_finite(jsonb)` 的递归、ACL、owner 与 down 依赖顺序，固定 usage/ledger 两个 JSON CHECK 和三个 façade/kernel guard；同时要求 `run_attempts_protocol_v5_state_check`、`run_checkpoints_protocol_v5_shape_check`、`run_recovery_hold_intents_evidence_shape_check`、`run_dispatch_retirement_receipts_lease_shape_check`、`run_billing_authority_receipts_shape_check`、`credits_ledger_authority_shape_check` 的完整谓词以 `(...) IS TRUE` 收口，不能让 SQL `UNKNOWN` 绕过 required tuple。
- **证据：** focused DB test 出现预期红，不接受 parse/config 假失败。

### T6 — Bootstrap phase roles 与测试 login graph

- **文件集合：** `packages/db/bootstrap/platform-roles.sql`、`infra/test/postgres/bootstrap-test.sql`、`packages/db/README.md` 与 T5 tests。
- **依赖：** T5。
- **风险：** L4（集群级角色与传递提权）。
- **先红：** issuer、八 executor、second execution login、exact membership、owner/runtime/control/migrator overlap 检查均缺失。
- **实现：** 九个 NOLOGIN/NOINHERIT/NOBYPASSRLS 角色；测试 login 每个只继承一个 phase，另有同 phase wrong `session_user` login。migration 不创建宽权限角色，只在任何 DDL 前核验 catalog/graph；实际 LOGIN enrollment 属于 DBA/deployment 配置。executor 仅 CONNECT/USAGE，无 TEMP/CREATE。
- **证据：** bootstrap/static tests；现有 auth/RLS PG16 suite 无回归。

### T7 — 005 schema、attestation 与 durable provenance

- **文件集合：** 新增 `packages/db/migrations/005_runtime_security.{up,down}.sql`；持续完善 `runtime-security-migration.test.ts`。
- **依赖：** T6。
- **风险：** L4（RLS、不可逆事实、恢复 provenance）。
- **串行红绿切片：** quiescence locks + prerequisite + legacy guard → attestation issue/revoke/establish → protocol-v5 Attempt provenance → execution claim/renew/relinquish → retry/effect envelope + receipt + effect-closure termination attribution → reclaimer fence + immutable recovery ticket/hold + one-to-one `CLAIMED|TERMINAL_RETIRED` disposition（只有 CLOSED termination intent 可原样保留）→ Event/Checkpoint producer binding → `RUN_DISPATCH` delivery generation/recovery/retirement provenance → `run_billing_authority_receipts` + ledger `/1|/2` schema/constraint → historical attributed billing primitives → transient finalizer claim + durable cancel receipt/CAS。
- **attestation bearer：** private `auth` relation只保存固定 32-byte、domain `better-agent/internal-service-attestation-verifier/1\0` 派生的 HMAC verifier；raw secret 不入库。issue/establish 参数必须 binary-bound、never-log，issuer/executor 无 relation SELECT；establish 只通过既有 owner-only `auth.constant_time_equal_32(bytea, bytea)` 比较。static test 检查函数 body 调用，PG16 检查首/末字节错误与相同 fail-closed 结果；不使用有噪声的 wall-clock timing 断言冒充恒时证明。
- **约束：** 完整 locks/prerequisite 后只允许精确 owner、精确表集合的事务性 `NO FORCE` 只读 inspection window；RLS 始终保持 ENABLE，成功时恢复 FORCE，失败时整体回滚。legacy guard 与 FORCE 恢复必须先于 protocol-v5 schema/data/ledger 变更；不回填伪 provenance；保留的 004 ledger 只标记 `/1` 且 authority 列为空，不伪造 receipt。token 由数据库生成。claim/renew/recovery-fence 的线性化点是取得 authoritative Attempt/Outbox row lock之后，随后重新读取 `clock_timestamp()`；不得缓存锁前时间。protocol-v5 fence 单调且超过 `9007199254740991` fail closed；只有 execution claim 派生 owner/token，reclaimer 只清 lease并写 ticket/hold；不提供 caller-selected generic event/mutation。
- **JSON/nullable backstop：** `app.g007_json_numbers_are_finite` 由 `ba_run_owner` 持有、PUBLIC/phase executor 不可直调，仅授 `ba_billing_owner`；它递归 object/array 并把 PostgreSQL numeric 投影到 double precision，拒绝 JavaScript overflow、接受会下溢为 finite zero 的数值。usage/ledger 表 CHECK 与 record/settlement façade 双层拒绝 non-finite detail；六个 protocol-v5 nullable shape CHECK 对完整谓词使用 `IS TRUE`，使 raw owner-plane NULL DML 也得到 `23514`。
- **证据：** static tests、migration render 含 `ba_apply_005/ba_revert_005`、旧 checksum 不变。

### T8 — 005 phase façade、账务/finalizer 与 exact ACL

- **文件集合：** 继续 `005_runtime_security.{up,down}.sql` 与 static test。
- **依赖：** T7。
- **风险：** L4（资金、终态、最小权限）。
- **实现：** 按 function oracle 分别实现 execution-owner validator、committed-attribution validator、transient finalizer claim、005 owner-only historical settle/release primitives，以及 metering/finalizer/reclaimer/reconciliation narrow façade。owner-only current-fence settle/release compatibility wrapper 以 `/1` 先执行 exact committed replay，只在 miss 且 Workspace lock + recheck 后用 004 validator 进入 shared kernel；owner-only `app.finalize_run(jsonb)` 同时保留一个不向 executor 授权的 exact 004 `/1` branch，其原 p_fact 字段、current-fence 检查、tombstone replay 先后、terminal/remainder/timestamp 验证、SQLSTATE 和外部写集全部冻结，内部金融调用只替换为等价 `/1` wrapper + shared kernel。phase metering/finalizer 不得调用任何 `/1` 路径，必须消费/封存 exact `/2` authority receipt，也不得把 N+1/N+2 冒充 attribution 的 producer fence N。forward-replaced `app.finalize_run(jsonb)` 与 down restoration 必须进入 static catalog fingerprint。archive/retention 只能执行新的 context-derived façade，旧 004 register/purge 函数始终 owner-only；`current_workspace_id`/`current_authenticated_principal_id` forward replacement；fixed-search-path owner functions；PUBLIC/`ba_runtime`/其他 phase deny。
- **closed finalizer intent：** `finalize_attributed_run` 只接受 execution owner 在 active lease 下写入、尚未消费且 effect closure 重算仍为 CLOSED/digest 匹配的 `RunTerminationIntentV1`；missing/unsafe/UNKNOWN 时 HOLD 优先并拒绝普通 intent。producer lease 后续过期/fenced不影响合法 historical attribution。`finalize_claimed_run` 接受 exact `RUN_CANCEL_REQUESTED` event ID 或 recovery-hold ID；Run mutation receipt 可缺失，存在时必须交叉核验但不能替代 event。函数必须在锁定全 Run Attempt/effect facts 后重新分类：CLOSED cancel 若 reservation 仍为 `HELD`，由 DB 建立 transaction claim、封存 `DURABLE_CANCEL` receipt 并用 `apply_claimed_release` 精确关闭 remainder（含 zero-credit HELD）；若 reservation 已经 `SETTLED|RELEASED|EXPIRED` 且既有 ledger 证明 remaining=0，则走 no-financial-mutation terminal CAS，不创建 billing claim/receipt/ledger。任一 missing/unsafe/UNKNOWN effect，或 terminal reservation 未闭合，均不得写 CANCELLED/释放资金，而是原子派生/消费 hold并终态为 Run/billing `NEEDS_ATTENTION`。timeout 没有可信持久 deadline/timeout fact，G0-07 一律拒绝；caller JSON 中的 Workspace/Run/reservation/amount/ID/key/hash/time/reason/outcome/evidence 不是 authority。
- **Run-wide quiescence：** finalizer 按上述全局锁顺序获取 Workspace billing fence、Run、全部 Attempt 及 recovery ticket/disposition、Step、effect envelope/receipt、usage/termination attribution、`RUN_DISPATCH` 及 recovery ticket/disposition 和 reservation/allocation，并以 transaction-scoped finalizer CAS 阻止新的 dispatch/Attempt claim。它先重算每个 Attempt 的 effect closure，HOLD-first 优先于 completion/cancel/relinquish。无论走 CLOSED 还是 HOLD terminal branch，都必须在同事务终止 active/PENDING Attempt（CLOSED 映射为 CANCELLED/FAILED，HOLD 映射为 RELINQUISHED + hold evidence）、清 owner/token/expiry、保留或单调推进可审计 generation，对每个未消费 Attempt ticket 插入 `TERMINAL_RETIRED` disposition，并退役 PENDING/LEASED `RUN_DISPATCH`/关闭其 recovery ticket；随后断言全 Run `active executable lease = 0`、无未 disposition 的 Attempt/dispatch recovery ticket、无其他 active/recoverable Attempt、无 pending/leased dispatch，之后才可触碰账务/Run 终态。只有全 Run CLOSED path 才先 exactly-once settle 所有 confirmed usage、再释放 remainder；只要任一 responsibility missing/unsafe/UNKNOWN，HOLD path 不消费 usage/termination billing source、不写 billing receipt、不移动任何资金，而是原子写 Run/billing `NEEDS_ATTENTION` 并保留全部未决 evidence，终态后 reconciliation 才能追加 evidence/修正 current billing state。terminal snapshot 永不被 reconciliation 改写。
- **先红：** wrong phase EXECUTE、raw DML、old 004 helper 直授、empty/mixed/session-user-mismatched lease、cross-phase consumer 缺/wrong/stolen attribution、已消费 source 搭配 different intent/charge/amount/source、attribution committed 后 lease 过期、HOLD terminal 后 queued metering miss 仍消费 attribution、termination intent vs recovery-fence、attributed terminal readback active lease 非零、finalizer rollback 未恢复 source lease/intent、hold + unknown responsibility 未先 terminal NEEDS_ATTENTION、两个不同 Attempt、PENDING Attempt + ticket 漏退役/双 disposition/stale claim、PENDING/LEASED `RUN_DISPATCH` 漏退役或伪退役、keyless no-worker cancel、取消 event/Run/reservation 混搭、caller 自报 amount/ID/key/hash/time/timeout/reason、transient claim 单独 commit/跨事务窃取、authority/ledger 任一侧孤儿、`/1|/2` 伪标/双 authority、archive/retention caller-selected Workspace、archive 自验/自批、retention 提前 purge、SUCCEEDED/child/HumanGate 正向。exact same authority + financial intent/charge/amount 的 response-loss replay 是必须成功的对照用例，包括 HOLD 之前已 commit 而响应丢失的 ledger；不得当作“replayed attribution 一律拒绝”。
- **终态事务：** 按全局顺序先锁 Workspace billing fence、再锁 Run 并检查 tombstone；same intent replay 在任何 source consumption/claim 前返回，different intent conflict。账务、活动 Step、`RUN_DISPATCH` retirement、唯一 terminal Event/tombstone、terminal snapshot、Outbox 必须在同一外层事务完成，异常全部回滚。
- **补充红测：** historical producer fence N 在 Attempt 已为 N+1/N+2 后仍通过 005 attributed primitives exactly-once settle/release，ledger `/2` receipt 保留 N；termination intent 分别与 missing/unsafe/UNKNOWN/CONFIRMED effect closure 组合，前三者 HOLD 优先且普通 intent 不可消费，只有 CONFIRMED/CLOSED 可终态化。reclaimer 已生成 `PENDING + ticket N+1` 后，recovery claim 与 CLOSED/HOLD finalizer 必须以两种线性化顺序分别得到 `CLAIMED/N+2` 或 `TERMINAL_RETIRED/N+1`，不得双消费；outer rollback 后 ticket 仍可由正确路径处理。no-worker/keyless cancel 在 Attempt 数为零时以 direct-Run `/2` release 关闭正数 `HELD` 与 zero-credit `HELD` reservation，producer Attempt/fence/Step 必须为空；正数 reservation 在 finalizer 前已全额 SETTLED、在同事务被 confirmed usage 刚好全额 SETTLED、以及既有 RELEASED/EXPIRED 竞争分别验证 no-financial-mutation 分支；任何未闭合/nonzero mismatch 拒绝。HOLD 不得生成 billing receipt 或移动资金。
- **证据：** static ACL/function inventory 与 down restoration fingerprint。

#### 004 → 005 财务等价/差分门

该门不以“shared kernel 被调用”代替行为证据，且严禁为了测试可重现而向 phase façade 注入时间/ID/key/hash。门分两层：

1. **V1 compatibility exact differential：** 两个 fresh PostgreSQL 16 fixture 使用相同的 caller-owned UUID、显式 timestamp 与 Workspace/Run/Attempt/reservation 前态；baseline 停在 through-004 并调用原 settle/release/finalize，candidate 停在 through-005 并调用 owner-only `/1` settle/release compatibility wrapper 以及 owner-only `app.finalize_run(jsonb)` 的 exact 004 `/1` branch。candidate finalizer 必须接受原 004 p_fact，相同的 current Attempt/lease/fence 与 tombstone replay 必须产生相同返回值/SQLSTATE/外部写集；phase `/2` façade不参与此层。finalizer 等价 fixture 先将两边 initial `RUN_DISPATCH` 置为 `DELIVERED`，避免把 005-only retirement 安全差异混入核心财务差分。除已声明的 authority-binding strengthening 外逐字段 exact compare。
2. **V2 semantic differential：** 只固定 Workspace/Run/Attempt/reservation/source facts。先在 through-005 运行 phase façade，用同一 DB 的 transaction-before/after `clock_timestamp()` 夹住 DB-authored ID/time/key/hash，验证 canonical contract/hash、时间区间/单调和 exact replay 稳定性；再把读回的 amount/timestamp/financial IDs+hashes 作为 reference input 用于 fresh through-004 的合法 producer fixture，只比较 Workspace/reservation/delta/status/timestamp 等共享财务投影。V2 authority/producer shape 是 candidate 独立证据，不伪造成 004 no-worker authority。

对 005 新增的 schema-version/authority receipt 做显式投影后，以下核心字段必须逐字段相等，失败场景还要求同 SQLSTATE 与零副作用：

| matrix | 必须冻结的等价性 |
|---|---|
| intent validation | negative/null amount、hash/key/detail/reason/timestamp 无效；core 财务校验的 SQLSTATE 一致，authority-specific 拒绝另列证明 |
| settle/release amount | zero、partial、full、partial settle + remainder release、over-settle/release、Workspace reserved 不一致、reservation 非 HELD；只有正 delta 增加 balance version，zero 不增加 |
| reservation closure | `settled_credits + released_credits = reserved_credits`；只 settle 终为 SETTLED，只 release 终为 RELEASED，混合关闭终为 SETTLED；`settled_at/released_at/status_reason_code/updated_at/balance_version` 精确一致 |
| Workspace state | `credits_balance`、`credits_reserved_balance`、`credits_balance_version` 的 before/after 与行锁串行化一致，不允许负 reserved |
| ledger | entry kind、amount delta triangle、balance triangle、billing/charge hash、charge key、producer Run/Attempt/fence/Step、metering detail/reason、balance version、created_at 逐字段读回；append-only 触发器仍拒绝 update/delete |
| idempotency | exact charge + exact financial/authority binding 在首次响应丢失后返回原 ledger ID 且不再增加 version/delta；different intent 或 different authority 冲突，不消费新 source |
| concurrency | 相同 charge 两连接只有一行/一次 delta；不同 charge 的 amount 合计 `<= current remainder` 时必须串行化后两者都成功、两条 ledger、balance version 按正 delta 次数增加；两请求各自要求 full same remainder 或合计 `> remainder` 时只有仍能满足 remaining 的 winner，loser 零副作用；总 delta 始终守恒，通过 `pg_blocking_pids` 观测 Workspace lock |
| rollback/crash | kernel 后强制异常、client terminate、finalizer 后续 terminal 写失败均不留 balance/reservation/ledger/authority/source-CAS 半状态，原 intent 可重试 |
| finalizer | 授权等价时，Run status/execution/billing state、billing timestamp、active Step 关闭、唯一 terminal Event/tombstone/snapshot/Outbox 与 financial rows 同事务；`NEEDS_ATTENTION` 不移动资金 |

允许的 reviewed differences 只有四类：（1）authority 层——005 `/2` 增加封存 receipt，并对 004 曾可能返回旧 ledger 的“同财务 intent、不同 producer/source”改为冲突；（2）phase-owned ID/key/hash/time 以 canonical 关系和 DB-time 区间验证，不要求与 caller-authored 004 identity 相同；（3）pre-claim cancel 的 005-only `RUN_DISPATCH` retirement，预期旧 dispatch 为 DEAD、generation/receipt 存在，terminal `SSE_WAKE` 仍与终态投影同构；（4）zero-credit `HELD` cancel 在 004 reference 会产生 zero `SETTLE`/`SETTLED` reservation，005 direct-cancel 显式产生 zero `/2 RELEASE`/`RELEASED`，两者 Workspace delta/version 都不变且 Run billing 最终为 SETTLED，该 case 不参加 V1 逐字段等价。current-fence `/1` 的 exact same-binding committed replay 在 fence 后续变更后仍必须返回首次 ID；这些安全 strengthening 不得改变其他已提交资金结果。另跑 `/2` authority 攻击矩阵：historical N 在 N+1/N+2 后的 settle/release、keyless/keyed no-worker cancel、零/正数 remainder、same-source response-loss replay、different/mixed/replayed source、HOLD 和 outer rollback。

### T9 — 显式 migration milestone 与受审 down/reapply

- **文件集合：** `infra/test/postgres/run-integration.mjs`。
- **依赖：** T8。
- **风险：** L3（迁移工具回归）。
- **先红：** 加入 005 后，现有 `productionMigrationCount - 1/-2` 在 through-003/004 边界产生可观察失败。
- **实现：** `requireMigration(id)`、`prefixThrough(id)` 与显式 through-003/004/005 fingerprints；`productionMigrationCount` 只用于动态 probe 版本和统计，不再表达 milestone/rollback target。
- **生命周期：** through-003 → through-004 → through-005 → probe-006；随后 `targetVersion=5` 只 revert 006，`targetVersion=4` 精确执行 005 down，`targetVersion=3` 精确执行 004 down，再从 through-003 reapply 004+005。测试必须断言 renderer 实际 selected migration IDs 与 ledger/checksum/catalog，不能用文字标签或 count 推断。legacy blocker apply 005 必须在受控 RLS inspection window 内、protocol-v5 schema/data/ledger mutation 前返回 `55000`，失败事务结束后的逻辑 catalog/data digest 不变。
- **证据：** fresh/idempotent/checksum tamper/空事实 down-reapply/非空 fail-closed PG16 全绿。

### T10 — Interactive/backend-termination harness

- **文件集合：** `infra/test/postgres/harness.mjs`、两套现有 Run PG scripts；新增 `infra/test/postgres/run-runtime-security-integration.mjs` 最小骨架。
- **依赖：** T9。
- **风险：** L3（测试可信度与进程清理）。
- **先红：** 新 suite 要求 interactive psql、backend pid、abrupt disconnect、bounded backend exit、真实 blocking edge helper，而当前 harness 尚无这些能力。
- **实现：** 抽取 marker 驱动 execute/close、`application_name`/backend PID、突然断连、DBA `pg_terminate_backend`、`pg_stat_activity + pg_blocking_pids` 条件轮询；禁止裸 sleep 作为 correctness barrier。用户可见输出继续脱敏，但先在未脱敏 raw buffer 上扫描动态 secret/canary，只返回 `leakDetected/count/source`，绝不回显 secret；“零命中”验收只读取 raw-scan metadata，不能扫描脱敏后文本制造假阴性。
- **证据：** 原 billing/conversation PG16 suites 无回归；timeout 自动关闭 client/container，不遗留进程。仅将证据命名为 client/backend termination。

### T11 — 第六套 PG16：attestation、ACL/RLS 与 two-connection fencing

- **文件集合：** `infra/test/postgres/run-runtime-security-integration.mjs` 与必要的 005 修正。
- **依赖：** T10。
- **风险：** L4。
- **身份矩阵：** correct phase；wrong role/phase/`session_user`/Workspace/verifier；expired/revoked/old transaction proof；外部 credential 冒充；raw DML/read/TEMP/CREATE；issuer/executor/owner 传递重叠。同一仍有效 raw attestation 在 TTL 内由同一绑定 `session_user` 于新事务、另一连接重新验真必须成功；复制旧 `tenant_context` proof 到另一事务/连接必须失败。每次拒绝由独立 DBA digest 与低权 projection 证明零副作用。
- **lease 矩阵：** claim/claim 单赢家；expiry 前 renew 胜 recovery-fence；expiry 后三分支闭合：有 unconsumed termination attribution 时 fence `N+1`、清 lease、保持原 intent 未消费且无 ticket，有 HOLD 时 fence `N+1` + hold，有 replayable recovery 时才写 ticket并允许 execution 原子消费后 claim `N+2`；missing/wrong/replayed/terminal-retired ticket、claim 后 rollback、reclaimer execute/ack 全拒；第二个同 phase login 即使拿到第一 login 的 token/fence 也全拒；stale writer 的 Event/Checkpoint/meter/finalize 全拒；finalizer same intent replay/different intent 单赢家，不存在可单独提交的 acquire claim，并在 terminal mutation 前独立读回 `active executable lease = 0` 且每个 recovery ticket 有唯一 disposition；`RUN_DISPATCH` 使用相同 two-stage fence/ticket 规则。另做锁跨 expiry 夹具：A 持 Attempt 行锁，B 在 expiry 前发起 renew/recovery-fence；B 取得锁后必须以新的 DB time 判定 renew 失败、fence 成功。
- **Attempt ticket retirement 矩阵：** 先由 reclaimer 提交 `PENDING + ticket N+1`，再以两连接让 recovery claim 与 CLOSED/HOLD finalizer 竞争。claim 先线性化时必须只有 `CLAIMED` disposition、Attempt `RUNNING N+2`，finalizer 随后终止 active Attempt；finalizer 先线性化时必须只有 `TERMINAL_RETIRED` disposition、Attempt 保留 `N+1` 并进入 `CANCELLED|FAILED|RELINQUISHED`，stale claim 零副作用。两个顺序都要观察 Run → Attempt → ticket 的 blocking edge，独立读回 disposition/ticket hash/generation/owner/token/hold/terminal facts；terminal outer rollback 后 disposition 不存在且 ticket 仍可 claim，claim outer rollback 后仍可 terminal-retire。
- **dispatch retirement 矩阵：** no-worker cancel 从 initial PENDING 正向退役为 DEAD；PENDING/active LEASED/expired LEASED 分别与 claim、complete、fail、recovery-fence、takeover 两连接竞争，只有一个线性化 winner。finalizer 胜时必须增加 durable delivery generation、清 live lease、退役 recovery ticket、写一个 receipt，stale dispatcher 全拒；dispatcher 先 DELIVERED 时 finalizer 不改该行，但后到 Worker 在 terminal Run 上 claim 失败。伪 DEAD/缺 receipt、wrong old/new generation、重复 retirement/different terminal intent 全拒。outer rollback 独立读回 Outbox status/lease/generation/ticket/receipt 全恢复。
- **mixed tuple：** old/old、old/new、new/old、正确 pair + 错 Run/Attempt/Step/reservation/attribution，以及 expired/terminal tuple。execution-owner validator 必测 second-login stolen tuple 拒绝；metering/finalizer 必测自身 login 不等于 Worker owner、且 producer lease 已过期/fenced时，携 exact committed attribution 在 Run 仍 nonterminal/billing 可结算时可首次成功。首次 commit 后响应丢失的 same authority + intent/charge/amount 重试必须返回原 ledger/receipt；缺/wrong/stolen source，已消费 source 搭配 different intent/charge/amount，或 terminal/`NEEDS_ATTENTION` Run 上的 committed miss 必须拒绝且 CAS/digest 不变。
- **时间策略：** fixture 使用 30 秒 lease；只等待一次 DB time 到期并复用 post-expiry 场景，bounded poll `clock_timestamp() >= lease_expires_at`，不得以本机时间推断。
- **JSON/NULL golden vectors：** helper 对嵌套 `1e1000`、`-1e1000` 返回 false，对 `1e-1000` 返回 true；临界值 `1.7976931348623158e308` 接受而 `1.7976931348623159e308` 拒绝。fresh usage overflow 与 committed replay overflow 都精确返回 `22023` 且 digest 不变；上述六个 required tuple 各用一条 NULL raw DML 精确返回 `23514 + constraint name`，ledger raw nested overflow 由表约束兜底，所有组前后 digest 不变。时间 contract 另覆盖 `.123400/.123900` 正反序、相等和超过 6 位小数拒绝。
- **historical billing readback：** metering/finalizer login 不等于 Worker owner且 producer lease N 已变为 N+1/N+2 时，exact committed N attribution仍须通过新 v5 primitives settle/release；response-loss exact replay 返回原 ID，缺/wrong/different-binding 拒绝。ledger `/2` 的 `producer_lease_fencing_token` 必须仍为 N，authority receipt 必须封存原 source ID/hash，不能记录当前 fence 冒充来源。
- **证据：** role/ACL matrix、blocking edge、winner row、fence/token/session-user readback、拒绝后的 digest、raw-buffer leak scan metadata 零命中。

### T12 — 第六套 PG16：恢复故障、聚合与文档投影

- **文件集合：** `run-runtime-security-integration.mjs`、`infra/test/postgres/README.md`、`packages/db/{package.json,README.md}`、本计划与上位实施计划的状态/证据链接。
- **依赖：** T11。
- **风险：** L4。
- **故障矩阵：** Worker claim 未提交 terminate 全回滚；Worker claim 已提交 terminate 时 lease 保留且到期前不能 recovery-fence；recovery claim 未提交 terminate 时 ticket 保持无 disposition，之后可被 execution claim 或 finalizer terminal-retire；checkpoint 未提交/已提交 terminate 后只恢复最后提交点；usage attribution 已提交但 lease 在 settle 前过期时仍能由 metering exactly-once消费；termination intent 与 recovery-fence 竞争时，finalizer 胜则同事务清 source lease 后 terminal，reclaimer 胜则只 fence/清 lease并保持原 intent 未消费，之后 finalizer仍以同一 intent exactly-once消费；两者都不创建 replay ticket；另以 replayable recovery 显式覆盖 `PENDING ticket` 与 finalizer/recovery claim 的两种线性化顺序。finalizer outer rollback 后 source lease/intent/attribution/recovery-ticket disposition/transaction claim/authority receipt/ledger 全部原样可重试。
- **cancel/HOLD 竞争矩阵：** `cancel + missing|unsafe|UNKNOWN effect + relinquish` 中 relinquish 必须拒绝并保留 lease，finalizer/reclaimer 任一 winner 都只能 HOLD-first 收敛 `NEEDS_ATTENTION`、零资金移动；`cancel + CLOSED + relinquish/finalizer` 可按锁顺序产生一个 terminal winner，但必须在 terminal 前读回 active lease=0。no-worker keyless cancel、cancel vs confirmed-usage settlement、cancel vs recovery-fence、零/正数 remainder、双 finalizer、response-loss exact replay 与 terminal-write-after-release 强制失败全部要有 PG16 场景；confirmed usage 先 settle，只用 durable cancel receipt release 剩余，不借 Worker fence。特别以两连接让 metering 在 Workspace lock 上排队：HOLD finalizer 先 commit 后，metering committed miss 必须在 Run-state gate 零副作用失败；若该 exact ledger 已在 HOLD 前 commit，HOLD 后 response-loss replay 必须返回原 ID 且不再移资。unknown responsibility 必须先由 hold finalizer 原子写 Run/billing `NEEDS_ATTENTION` 与 immutable snapshot，再由 reconciliation 追加 evidence，禁止反向改 snapshot；caller 自报 timeout 始终零副作用。另加入 concurrent legacy/runtime mutation vs 005 up/down：NOWAIT quiescence 后单赢家，失败侧 facts 不丢失且 ledger/catalog/digest 不动。
- **聚合顺序：** `run-integration` → `run-auth-rls` → `run-release-deployment` → `run-run-billing` → `run-run-conversation-browser` → `run-runtime-security`，保持串行，不允许 mock/skip/xpass。
- **文档投影：** producer-attribution authority 的规范前向修订写入 ADR-004；详细函数/测试矩阵只保留在本 Sprint；`docs/plans/2026-08-25-architecture-readiness-and-implementation.md` 与 `docs/07-实施计划.md` 只记录状态、依赖和证据链接；不修改 `docs/database/*.sql` 历史设计稿。
- **证据：** package/local tests → `pnpm contract:check` → `pnpm check` → `pnpm db:test:postgres16` → `pnpm architecture:framework` → `git diff --check`。`architecture:gate` 由 G0-08 在 clean checkout 聚合，不用它替换本轮 framework 门。

## Plan：005 upgrade/down 安全策略

### Upgrade preflight

005 的第一个可能失败点是 quiescence gate，它是事务内第一条语句，位于任何 blocker read、catalog adjustment、数据改写和 migration ledger insert 之前。真实 004 writer 不共享单一首锁：keyed acceptance 先写 `public.run_idempotency_sentinels` 再锁 Workspace，账务/finalizer 从 Workspace 开始，cancel 可从 Run 开始。因此 migration 不宣称一个 blocking table-lock 顺序能与所有 legacy writer 同序，而是在单一事务的第一条语句中对完整 inventory 执行 schema-qualified `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE NOWAIT`。任一 relation 有 in-flight writer/reader lock 时整个 migration 立即以 `55P03` 失败并回滚已取得的锁，不在 SQL 事务内 sleep/retry；部署层只能在已停流/旧 writer 结束后从 fresh transaction 有界重跑。一旦该单语句成功，全部锁持有到 commit，才执行完整 preflight。

static test 固定该单语句的不重不漏 inventory：`public.workspaces`、`public.conversations`、`public.conversation_states`、`public.conversation_messages`、`public.run_idempotency_sentinels`、`public.runs`、`public.run_acceptance_receipts`、`public.run_mutation_idempotency`、`public.run_attempts`、`public.run_steps`、`public.run_events`、`public.run_checkpoints`、`public.human_gates`、`public.outbox`、`public.run_parent_links`、`public.credit_reservations`、`public.credits_ledger`、`public.run_budget_allocations`、`public.run_billing_reconciliations`、`public.run_archive_manifests`、`public.run_archive_verification_receipts`、`public.run_archive_approval_receipts`、`public.run_retention_purge_receipts`。清单来自 004 的全部可变 public relations，不以“大多数 writer 会经过 Workspace”代替完整 quiescence。锁成功后 preflight 执行：

1. 验证九个 bootstrap role 的属性、直接/传递 membership graph 与 prerequisite catalog；并对 `runs/run_attempts/outbox` 的 `ba_run_owner` 以及 `credit_reservations/run_budget_allocations/credits_ledger/run_billing_reconciliations` 的 `ba_billing_owner` 精确核验 relation owner、`relrowsecurity=true`、`relforcerowsecurity=true`，任何 drift 以 `55000` 拒绝。
2. 在完整锁持续持有时，分别 `SET LOCAL ROLE` 到 exact NOLOGIN owner，仅对上述精确表临时 `NO FORCE ROW LEVEL SECURITY`；RLS 不得 DISABLE。run 与 billing guard 扫描全量历史后对称恢复 FORCE 并 `RESET ROLE`，才允许进入 protocol-v5 schema expansion、ownership transfer、grant 或 data backfill；任一 guard 失败时整个事务回滚，包括临时 catalog 位。
3. 任一非终态 Run、活动/可接管 Attempt、活跃 lease、`billing_state <> SETTLED`、未关闭 reservation/allocation、`status <> DELIVERED` 的 Outbox（含 DEAD），或任何仍需新 provenance 才能 release/reconcile/deliver/recovery-fence/takeover 的事实存在时，返回 SQLSTATE `55000`。任一 through-004 SETTLE/RELEASE ledger 若 producer fence 超过 `9007199254740991` 或其他字段无法完整重算为 `CreditLedgerEntryV1` + `BillingIntentV1`，也在此 fail closed，不伪回填 `/1`。
4. 只允许账务已收敛、Outbox 已完成、后续仅需 evidence-driven retention 的 terminal history；所有新 mutation 必须引用 protocol-v5 authority root/operation receipt，保留的旧历史不能被 005 executor primitive 接管。

每类 blocker 都必须在真实 PG16 独立证明失败事务结束后的 migration ledger、所选 schema catalog（含 RLS 位）与夹具事实逻辑 digest 零变化；这不等价于“没有执行 catalog statement/WAL/审计事件”，也不泛化为全数据库字节级证明。并发夹具分别把 keyed Agent/Flow acceptance 暂停在 sentinel INSERT 后/Workspace lock 前，把 reserve/settle/release/finalize 暂停在 Workspace 线性化后，并把 cancel 暂停在 Run lock 后；此时 upgrade 必须立即 `55P03`而不是等待/死锁。legacy writer 提交后 fresh migration 必须取得全部锁、在 preflight 以 `55000` 拒绝不兼容 facts；migration 先完成时，后到旧调用必须因 catalog/ACL/prerequisite guard 失败且零写入。MAX_SAFE_INTEGER 边界行可 upgrade，`+1` 与 owner/RLS metadata drift 必须在 protocol-v5 schema/data 变更前 `55000`，且拒绝后的受测逻辑 digest 不变。

### Down guard

- down 的第一条语句同样以单一 schema-qualified `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE NOWAIT` 同时覆盖上述完整 legacy inventory 和全部 005 relations，任一 in-flight executor/legacy writer 都以 `55P03` 使整个 down 回滚；成功后所有锁持有至 commit。事务内 `REVOKE` 不是并发屏障，测试不能依赖它阻止已开始或等待中的 executor。
- down 对 `run_attempts/run_checkpoints/outbox` 与 `credits_ledger` 先验证 exact owner + ENABLE/FORCE RLS，再分别以 run/billing owner 打开同样受锁的 `NO FORCE` inspection window，检查 protocol-v5 列并恢复 FORCE；不得由无 tenant context 的 migrator 直接扫描而得到空集假绿。
- 若 ledger 存在 version > 5，或存在任一 attestation（含过期/撤销）、envelope、effect receipt、recovery ticket/disposition/hold intent、usage/termination attribution、billing authority receipt、ledger `/2` authority link、phase-operation audit、protocol-v5 Attempt/Outbox provenance，立即 `55000`。`finalizer_transaction_claims` 是永不允许带行 commit 的 private 工作表；down 仍要在锁后断言其为空，但不把表结构本身当作“已使用”事实。
- 不清空安全审计事实来强制回退；005 使用过后只能 forward-fix。
- 任一 protocol-v5 attributed/cancellation billing receipt、ledger `/2` 或 consumption fact 同样阻止 down；必须同时检查 receipt 表与 ledger authority 列，不能因为 private primitive 已被 revoke 就删除其来源证据。
- pristine down 在同一事务 revoke phase EXECUTE，逐项 drop façade/relation/constraint，恢复被替换的 004 helper body/owner/ACL/catalog fingerprint；禁止 `CASCADE`。
- `app.g007_json_numbers_are_finite(jsonb)` 必须在 usage/ledger CHECK、所有调用它的 façade/kernel 和恢复后的 004 `settle_credits` 均不再依赖它之后，才由 `ba_run_owner` 最后删除；down 不得依赖 `CASCADE` 隐式清理。
- bootstrap NOLOGIN roles 不由 migration down 删除；默认保留为无权限 dormant roles。
- 必须验证 pristine `004→005→down→005`、每类 legacy blocker、terminal-settled-delivered history upgrade 后不可被 005 mutation、005 使用后 down fail closed，以及 concurrent executor mutation vs down 单赢家且不丢事实五条路径。

## Plan：测试层次、停止条件与 G0-08 交接

### 最窄到全量验证

```powershell
pnpm --filter @better-agent/domain-contracts test
pnpm --filter @better-agent/billing-core test
pnpm --filter @better-agent/run-core test
pnpm --filter @better-agent/db test
pnpm contract:check
pnpm --filter @better-agent/db build
node infra/test/postgres/run-integration.mjs
node infra/test/postgres/run-runtime-security-integration.mjs
pnpm db:test:postgres16
pnpm check
pnpm architecture:framework
git diff --check
```

### 立即停止在 G0-07 的条件

- 000～004 任一 checksum 或正文改变；
- migration count 算术仍承担 milestone/rollback 语义；
- 005 prerequisite/upgrade/down 拒绝后 ledger/catalog/data digest 改变；
- phase role 具有 owner/runtime/control/issuer/migrator overlap、原始 DML、TEMP/CREATE 或跨 phase EXECUTE；
- wrong/expired/revoked attestation 建立 context，旧 transaction proof 跨事务/连接复用，或有效 raw attestation 无法由同一绑定 login 在新事务/连接重新验真；
- 两连接双 winner，未观察真实 blocking edge 却只凭时间推断，或 fence/token 可重用/倒退/溢出；
- stale/mixed/session-user-mismatched tuple 导致事实、余额、terminal 或 Outbox 移动；
- crash/terminate 后出现半终态，unsafe/unknown 被自动重放，或 recovery-hold intent 可由 reclaimer 直接终态化；
- admission fixture 被宣称为可信 Plan、archive executor 可自验自批、通用 Outbox dispatcher 被顺带开放；
- 原五套任一回归、cleanup 失败、测试含 mock/skip/xpass，或 backend termination 被表述成 server/WAL crash；
- `pnpm check`、完整六套 PG16、`architecture:framework`、`git diff --check` 任一未通过。

### G0-08 handoff envelope

只有上述门全部通过，才可把 005 up/down checksum、PG16 image digest/server version、六套逐项结果、through-003/004/005 catalog fingerprints、role/ACL matrix、attestation 攻击矩阵、two-connection/blocking/failure observations、零副作用 digest 与“生产/pooler/API/云端未验证”边界交给 G0-08。G0-08 通过前不得进入 G1。

### Plan Review 入口

对本计划执行三个独立只读审查面：contract/pure-core 是否存在隐式产品决策，role/ACL/005 是否存在提权或伪 provenance，PG16 harness 是否能真正观察竞态与回滚。P0/P1 未清零前不进入 Work。

### Plan Review 闭环

- 受审业务内容 SHA256：`fda8ffefd33420715d6b85fd9872dc7892307931b972c9dee94c1215961f2e08`。
- architecture/state-machine 独立审查：P0=0，P1=0。
- PostgreSQL migration/ACL 独立审查：P0=0，P1=0。
- TDD/concurrency/failure-harness 独立审查：P0=0，P1=0。
- 已收敛的关键缺口包括：三类 authority 无环 hash DAG、`RETURNS text` 004 签名、owner-only finalize `/1` 兼容、HOLD 清 lease、Attempt ticket terminal disposition、partial-charge 并发、oversized legacy fail-closed、NOWAIT quiescence，以及 HOLD 后 `/2` metering first-consumption gate。

## Work：2026-08-28 本地框架实现与停止判定

### 已实现

- **T1～T4 contract 与 pure core：** 新增 strict Run execution、recovery、billing `/2` authority、lease/fencing、ticket disposition、dispatch retirement、historical attribution 与 terminal replay 契约；三类 source → charge attribution → BillingIntentV2 hash DAG 使用独立冻结向量。terminal replay 绑定完整持久事实，failure evidence 使用 strict canonical SHA-256，retirement receipt 不再由调用者自证。
- **T5～T9 PostgreSQL 框架：** 新增 forward-only `005_runtime_security.{up,down}.sql`、九个 phase role/bootstrap graph、transaction-bound internal attestation、Attempt/`RUN_DISPATCH` 两阶段 fencing、narrow façade、authority receipt/ledger reciprocal binding、HOLD-first finalizer、explicit migration milestone 与受审 pristine down。005 upgrade 在首个 DDL 前执行完整 NOWAIT inventory 和 through-004 `CreditLedgerEntryV1 + BillingIntentV1` fail-closed 重算；`/2` receipt/ledger 均实施 `USAGE+SETTLE | TERMINATION+RELEASE | CANCEL+RELEASE` strict XOR。
- **T10～T12 failure harness：** harness 支持 interactive marker、backend PID、突然断连、backend termination、真实 blocking edge 与 raw-buffer secret scan；第六套 runtime-security suite 已实现并在 disposable PostgreSQL 16 上通过 attestation/ACL、Attempt 与 Dispatch 双连接竞态、recovery、HOLD、historical billing、reconciliation、no-financial terminal、up/down NOWAIT、rollback 与 response-loss 场景。共享 catalog fingerprint 覆盖 class/column/default/index/constraint/trigger/policy/function body/owner/ACL/RLS/schema，并供 migration 与 runtime suite 复用。
- **上一轮 Review 回修基线：** 独立 SQL 审查曾关闭缺 envelope/receipt 被误判 CLOSED、through-004 ledger hash 未在 DDL 前重算、`/2` kind/operation XOR、runtime oracle 漏测与错误匹配假绿；这些记录解释修复历史，不代表当前 Review 已清零。
- **Review 回修已实现：** `record_attempt_finished` 仅在锁定的全量 effect set 为安全 `CONFIRMED` 时清 lease；usage/termination 通过稳定 `producer_operation_key + producer_request_sha256` 支持并发 miss、响应丢失、租约过期与终态后的 exact replay；checkpoint 返回完整注册 contract；canonical amount、result wrapper、effect operation-key parity 与 HOLD evidence 排序已跨 SQL/domain/run-core/billing 对齐。Harness 真实到达三类 used-installation down `55000`、through-004/005 精确 catalog lifecycle、effect 双连接 blocking/response-loss、OPEN/UNKNOWN/UNSAFE completion 拒绝，以及 termination-first/metering-first 两种账务顺序。
- **最终 Work 收敛：** domain 与 run-core 统一以完整 PostgreSQL 微秒比较 instant；SQL 新增递归 finite-JSON helper、usage/ledger 表 CHECK 与三处 façade/kernel guard；六个 nullable protocol-v5 shape CHECK 以整体 `IS TRUE` fail closed。真实 PG harness 同时验证 overflow/underflow 临界、fresh/replay 零副作用、六组 NULL raw DML 的精确 `23514`、以及长耗时测试中的主租约续期和专项 30 秒锁跨期线性化。
- **前 5 个 P2 回修历史：** attestation 撤销约束现要求 `revoked_at` 与非空 `revocation_reason` 成对出现，并以完整谓词 `IS TRUE` 收口；owner-plane `revoked_at + NULL reason` 负向向量精确得到 `23514 + internal_service_attestations_revocation_check`，行数与 digest 不变。Run/Billing V1/V2 的父级 refine 在调用 `BigInt` 前先完成 canonical decimal 词法守卫，使非法输入由 `safeParse` 返回 typed issues 而不是抛出 `SyntaxError`。共享 `PostgresInstantV1Schema` 统一拒绝超过 6 位的小数秒与超过 PostgreSQL 数值时区上限 `15:59` 的 offset。dispatch failure discriminator 关闭为 `RETRY | DEAD`，error code 同步执行非空、最长 200 字符与 NUL 拒绝。最后，005 static CHECK oracle 不再使用可跨约束匹配的宽正则，而是以 balanced-parenthesis 提取本地约束表达式，并对 attestation 加六个 protocol-v5 nullable shape 约束执行 7 组“删除自身 `IS TRUE` 后必须失败”的 mutation 回归。
- **后续 2 个 P2 回修历史：** shared domain instant 曾接受 ISO `year=0000`，而 run-core/PostgreSQL 边界拒绝；`PostgresInstantV1Schema` 现统一把年份限制为 `0001..9999`，Run/Billing domain 与 run-core 都加入 `0000` 拒绝、`0001` 接受语料，focused domain `14/14`、run-core `7/7` 通过。另一项 P2 是本事实源没有记录当前 `architecture:framework` 的完整证据链；下方现按时间顺序保留首次环境挂起失败、无挂起单套复验和连续完整聚合成功，不能只摘取其中一次结果。

### Work 复验进展（截至 2026-08-31）

- 最窄包门已通过：domain contracts `53/53`、run-core `103/103`、billing-core `43/43`、DB static migration oracle `84 passed + 1` 个既有 Windows symlink 条件 skip；year-boundary focused corpus 为 domain Run/Billing `14/14`、run-core `7/7`；runtime-security harness `node --check`、全仓 `pnpm format:check`（196 files）与 `git diff --check` 均通过。
- 单独 `node infra/test/postgres/run-runtime-security-integration.mjs` 已在真实 disposable PostgreSQL `16.12` 上以退出码 `0` 通过。沙箱内首次调用只在 Node 启动 Docker 子进程前得到 `spawn EPERM`；使用已批准的直接外部命令后进入并通过全部语义断言，该环境边界不计作产品失败。
- `pnpm db:test:postgres16` 以退出码 `0` 完成六套串行 suite：migration lifecycle/dynamic probe、auth/RLS、release/deployment、Run/Billing、Agent Chat/browser 与 runtime-security。Lifecycle 首轮暴露 OID-derived internal RI trigger 名称导致的非语义 catalog 漂移；指纹现保留用户 trigger，并由 constraint 行覆盖自动 RI trigger 语义，focused lifecycle 与完整六套重跑均通过。
- 运行时报告 PostgreSQL `16.12 (Debian 16.12-1.pgdg12+1)`、pgvector `0.8.1`、pgcrypto `1.3`；固定镜像 digest 为 `sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337`。
- 修复后 005 SHA-256：up `8c2d1beb20b41985c8809a12bb64f8a9335b2b14e9abca5fe0fbac256471ca1e`；down `0fd30b25f97d106368b594914047a60d878ff41b63e7774897089c52a4ea0942`。
- `pnpm check` 以退出码 `0` 通过 196 个文件的格式检查和 9 个 workspace 的 lint/typecheck/test/build；关键单测计数为 domain contracts `53/53`、run-core `103/103`、billing-core `43/43`、DB static `84 passed + 1 skipped`、API `80/80`。
- `pnpm architecture:framework` 的首次聚合运行在 release suite 后被外部工具/调度挂起约 `5610` 秒，超过 G0-06 测试内部 attestation 的 `10m` TTL；进程恢复后 run-billing 以 owner context `P0001` 失败。该次命令是明确的非绿色结果，根因边界是环境暂停后的短期凭据过期，不能改写为产品断言通过。
- 随后在没有外部暂停的条件下单独运行 run-billing suite，以退出码 `0` 通过，证明同一 suite 的语义断言可以在凭据有效期内完成；这项局部复验不能单独替代聚合门。
- 最后再次连续执行完整 `pnpm architecture:framework`，在同一命令中完成 `pnpm check +` 六套 PostgreSQL suite 并以退出码 `0` 结束。该证据只覆盖当前仓库与本地 disposable PostgreSQL，不覆盖生产调度、生产凭据生命周期或云端运行。

### 当前尚未验证与边界

- 生产 phase role/login enrollment、生产数据库、真实 pooler transaction affinity、driver text/binary bind、JSONB numeric/timestamptz 序列化、真实 legacy installation 的 upgrade-lock/data 变体与 PostgreSQL server/WAL crash 均未验证；client/backend termination 和 disposable fixture 不能替代这些证据。
- 业务 Worker/scheduler/NodeExecutor、可信 Plan、published GateSpec、provider usage mapping、HTTP/SSE/browser/CORS、APM/error/support-export 脱敏、客户端、云端与生产部署均未执行。
- G0-08 的 clean-checkout `architecture:gate` 尚未执行；本轮最终独立 Review 已完成，但不能由本地 framework 或审查结论替代后续 G0-08 聚合门。

### 最终有界 Review 结论

- **SQL/安全面：P0=0、P1=0、P2=0。** 005 up/down、65 个 safe-definer 函数、ACL/RLS、finite-JSON、reciprocal FK、safe integer/fencing、down/reapply 和七组 fail-closed CHECK mutation 均已复核；005 up/down 与 runtime/static harness 哈希边界未漂移。
- **契约/pure-core 面：P0=0、P1=0、P2=0。** PostgreSQL instant 的年份/微秒/offset、BigInt typed parse、dispatch discriminator/error code、recovery/fencing/idempotency 与 billing V2 边界均已复核；domain `53/53`、run-core `103/103`、billing-core `43/43` 和相关 typecheck 通过。
- **harness/文档面：P0=0、P1=0、P2=0。** 七个 P2 的修复、005 SHA-256、六套 PG16、`architecture:framework` 的环境挂起失败/单套复验/连续聚合成功，以及生产/云端未知边界均已分层记录。
- **剩余 P3：** static CHECK 提取器不是完整 SQL lexer；当前七个约束不含注释或 dollar-quoted literal，现有 mutation 不受影响。未来约束若引入这些结构，应扩展解析器。
- **仍未知且不冒充完成：** 生产 role enrollment/数据库/pooler/driver、真实 legacy upgrade、server/WAL crash、Worker/provider/client/cloud/APM，以及 G0-08 clean-checkout `architecture:gate`。

G0-07 的 Work、L4 本地门与最终 Review 已关闭，随后已通过 Sprint 状态机从 `review` 进入 `compound`；这不等于 G0-08/G1 或生产交付完成。

## Compound：2026-08-31

### 筛选与证据分层

- **已验证且可复用：** nullable PostgreSQL `CHECK` 必须以完整谓词 `IS TRUE` fail closed，并以单约束局部提取加 mutation 防止静态正则跨约束假绿；跨 domain/run-core/PostgreSQL 的 instant 必须共享年份 `0001..9999`、微秒精度和数值 offset 上限；短期 attestation 的集成门若遭外部长暂停，必须保留失败、TTL 根因、局部复验和最终聚合退出码四层证据。
- **推断：** 这些模式可复用于后续 G0-08/G1 的数据库约束、时间 contract 与短期凭据 harness，但本轮没有用它们推断生产连接池、Worker 或云端行为。
- **未知：** 生产 role enrollment/pooler/driver、真实 legacy upgrade、server/WAL crash、APM/secret、客户端与云端状态仍无证据。

### 去重与写入判定

- 针对 `CHECK UNKNOWN`、PostgreSQL instant、attestation TTL/fencing 与 `architecture:framework` 做了有界检索；仓库当前没有 `docs/solutions/`、`scripts/sync-solution-index.js`、`scripts/self-learning.js` 或既有同主题 solution/rule/instinct。
- 上述根因、修复、预防和验证已存在于本文与 ADR-004；另建不可索引 solution 会产生第二事实源，因此 solution 采用 no-op。
- 当前任务没有需要行为学习的真实用户纠正信号，且仓库未配置 candidate writer；未走旧 direct-write 路径，未写 rule/instinct/skill/command/runtime marker，未执行 approve/promote。

Solution index: unchanged 0 entries -> docs/solutions/index.jsonl; Claude projection: unchanged; AGENTS projection: disabled

Learning candidates: proposed 0; needs-review 0; evaluated 0; shadow 0; approve/promote: not run
