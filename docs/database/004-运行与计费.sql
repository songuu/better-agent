-- 设计冻结 SQL 草案（未执行）
-- 目标：PostgreSQL 16
-- 用途：ADR-004 与 docs/05-数据模型.md §10.3 的运行、恢复与计费事实模型。
-- 本文件不是已应用的 migration；评审通过后应以独立 migration 方式执行，并保留 up/down、
-- 备份恢复、RLS 和并发扣费验证证据。
-- 2026-08-25 架构复审已把 WAITING/RESUMING、resume idempotency、current billing state
-- 与 executor fencing 收回通用基线；本文件仍尚未包含 HumanGate 实体、Instruction Skill activation
-- 或 Deployment/credential snapshot。它不能单独满足 G1-Agent；这些表、状态、受控函数、
-- RLS、retention 与故障注入补齐前不得执行或宣称设计冻结完成。
-- api_credential_release_grants 在本基线只能授权 service_api -> SYSTEM 版本，不是
-- 公开 Agent/Flow entry 事实源。G0-05 的 stable Agent/Flow typed grants 是唯一
-- 公开入口；preview/test 若需要直连，必须使用未来独立、management-attested
-- schema/migration，不得扩大本表的 SYSTEM 封闭约束。
--
-- 前置条件：
--   1. 001 migration 已创建 workspaces(id uuid primary key)。
--   2. 001 migration 已创建 app.current_workspace_id()。外部 API 只能通过
--      auth.authenticate_api_credential() 建立 runtime context；四个内部阶段必须
--      通过 auth.establish_internal_service_workspace_context() 建立短时、阶段绑定
--      的 service context。未验证、过期或 wrong-phase 时 helper 返回 NULL。
--   3. ba_runtime 仅表示普通 API/Worker 执行面，且不是表 owner、superuser
--      或 BYPASSRLS。资金与终态路径已拆为互不继承的
--      ba_admission_executor / ba_metering_executor / ba_finalizer_executor /
--      ba_reconciliation_executor；四者只获本阶段 narrow function 的 EXECUTE，
--      不获表 DML，也不继承
--      ba_runtime 或任一 owner。ba_admission_owner / ba_metering_owner /
--      ba_finalizer_owner、ba_reconciliation_owner、ba_billing_owner、
--      ba_retention 与 ba_authorization_owner 都是互不继承的 NOLOGIN
--      SECURITY DEFINER owner。
--      ba_archive_evidence_owner 是另一个 NOLOGIN SECURITY DEFINER owner；
--      ba_archive_evidence_executor 仅是已验证归档/审批回执的受信适配器，
--      它不得继承 ba_retention_executor 或 ba_retention，反之亦然。
--
-- 安全边界：
--   * 所有 *ref / *hash / *_redacted 字段只可保存对象引用、内容哈希或已脱敏摘要。
--   * 不在本组表中存储 Access-Key、Webhook/MCP token、Cookie、Authorization、
--     provider secret 或原始请求头/原始密钥。
--   * 发布版本通过本文件的 published_resource_versions registry 先冻结，再由
--     复合外键约束 Run 与版本同 Workspace；不依赖尚未存在的 Flow/Agent 物理表。
--   * 对外 runs.status 遵循 API 冻结枚举；execution_status 仅保存恢复与调度所需的内部细分。

BEGIN;

-- 此 registry 是 Flow/Agent 的“可被 Run 引用的已发布不可变快照”投影，而不是
-- 对尚未迁入的业务表作假设。后续 agent_releases/flow_versions migration 必须：
--   1. 在同一事务写入/更新对应 registry 行，且只允许 PUBLISHED immutable snapshot；
--   2. 为 (workspace_id, source_version_id) 建复合唯一键和复合 FK 或约束触发器；
--   3. 回填后校验 registry 与源表行数、workspace、compiled_hash 一致。
-- 在这些依赖就绪前，Run 只引用 registry，绝不接受裸 UUID pin。
CREATE TABLE published_resource_versions (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    resource_kind text NOT NULL CHECK (resource_kind IN ('AGENT', 'FLOW', 'SYSTEM')),
    -- 包含 SYSTEM 在内的所有可运行资源均有稳定 resource_id；SYSTEM 不使用
    -- source_version_id，但不能以 NULL 绕过 Run 的复合版本/资源外键。
    resource_id uuid NOT NULL,
    source_version_id uuid,
    version_ordinal integer NOT NULL CHECK (version_ordinal > 0),
    snapshot_object_ref text,
    compiled_hash text NOT NULL CHECK (compiled_hash ~ '^[0-9a-f]{64}$'),
    state text NOT NULL DEFAULT 'PUBLISHED' CHECK (state = 'PUBLISHED'),
    published_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT published_resource_versions_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT published_resource_versions_workspace_id_id_kind_resource_key
        UNIQUE (workspace_id, id, resource_kind, resource_id),
    CONSTRAINT published_resource_versions_workspace_resource_version_key
        UNIQUE NULLS NOT DISTINCT (workspace_id, resource_kind, resource_id, version_ordinal),
    CONSTRAINT published_resource_versions_shape CHECK (
        (resource_kind IN ('AGENT', 'FLOW')
          AND source_version_id IS NOT NULL)
        OR (resource_kind = 'SYSTEM'
          AND source_version_id IS NULL)
    )
);

COMMENT ON COLUMN published_resource_versions.resource_kind IS
    '004 通用 Run 基线的过渡枚举，仅覆盖顶层 AGENT/FLOW/SYSTEM 入口；G0-05 必须迁移为 PublishedResourceKind registry，并以类型化映射区分 AGENT_RELEASE、FLOW_VERSION 及传递依赖资源，禁止直接扩展此三值枚举后冒充 kind-safe closure。';

COMMENT ON TABLE published_resource_versions IS
    'Run-pin registry. It stores only immutable release identity, object reference and compiled hash; no secret or mutable draft payload.';

-- A registry row is a published snapshot, not an editable catalogue entry.
-- The source-release migration must provide the sole writer
-- app.register_published_resource_version(...) as a SECURITY DEFINER publisher:
-- it reads a published source release, derives workspace/kind/resource/version/
-- compiled_hash from that source, and inserts this row in the same release
-- transaction. It never accepts a caller supplied hash or source identity as
-- an authority. Registry retirement, if ever needed, is a future append-only
-- relationship; it must not UPDATE this snapshot.
CREATE OR REPLACE FUNCTION app.prevent_published_resource_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION 'published resource version is immutable; publish a new version'
        USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER published_resource_versions_prevent_mutation
BEFORE UPDATE OR DELETE ON published_resource_versions
FOR EACH ROW
EXECUTE FUNCTION app.prevent_published_resource_version_mutation();

-- These two tables intentionally use the registry version key, not a polymorphic
-- resource_type/resource_id/release_id triple. They are created only after both
-- 001 credentials and the immutable release registry are available.
CREATE TABLE published_release_visibility (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    published_resource_version_id uuid NOT NULL,
    visibility text NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'authenticated', 'public')),
    allowed_ingress text[] NOT NULL DEFAULT '{}'::text[],
    published_at timestamptz,
    revoked_at timestamptz,
    authorization_epoch bigint NOT NULL DEFAULT 0
        CHECK (authorization_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT published_release_visibility_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT published_release_visibility_one_per_version_key
        UNIQUE (workspace_id, published_resource_version_id),
    CONSTRAINT published_release_visibility_registry_fkey
        FOREIGN KEY (workspace_id, published_resource_version_id)
        REFERENCES published_resource_versions(workspace_id, id)
        ON DELETE RESTRICT
);

CREATE TABLE api_credential_release_grants (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    credential_id uuid NOT NULL,
    credential_kind text NOT NULL DEFAULT 'service_api'
        CHECK (credential_kind = 'service_api'),
    published_resource_version_id uuid NOT NULL,
    resource_kind text NOT NULL DEFAULT 'SYSTEM'
        CHECK (resource_kind = 'SYSTEM'),
    resource_id uuid NOT NULL,
    grant_state text NOT NULL DEFAULT 'active'
        CHECK (grant_state IN ('active', 'revoked')),
    authorization_epoch bigint NOT NULL DEFAULT 0
        CHECK (authorization_epoch >= 0),
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    PRIMARY KEY (workspace_id, credential_id, published_resource_version_id),
    CONSTRAINT api_credential_release_grants_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT api_credential_release_grants_credential_fkey
        FOREIGN KEY (workspace_id, credential_id, credential_kind)
        REFERENCES api_credentials(workspace_id, id, credential_kind)
        ON DELETE RESTRICT,
    CONSTRAINT api_credential_release_grants_registry_fkey
        FOREIGN KEY (
            workspace_id, published_resource_version_id, resource_kind, resource_id
        )
        REFERENCES published_resource_versions(
            workspace_id, id, resource_kind, resource_id
        )
        ON DELETE RESTRICT
);

COMMENT ON TABLE published_release_visibility IS
    'Visibility for a top-level immutable Agent/Flow/System registry version. A revocation increments authorization_epoch atomically.';
COMMENT ON TABLE api_credential_release_grants IS
    'Internal SYSTEM-only grant for service_api credentials. It cannot represent public Agent/Flow entry, publish exchange, or dependency capability grants; G0-05 typed Agent/Flow grants are the sole public entry authority. id is the stable authorization epoch source identity.';

-- Defense in depth for top-level visibility and grants. Direct runtime DML is
-- revoked below; these triggers additionally make every approved management
-- mutation advance the source epoch and, through 001's durable invalidation
-- function, the workspace epoch in the SAME RLS transaction. A missed NOTIFY is
-- safe because an unstarted call always compares database epochs.
-- The row id and grant/visibility association are the stable source identity
-- stored by Authorization Decisions. They must never be repointed to another
-- workspace, credential or release under the same epoch; revoke and create a
-- new row instead.
CREATE OR REPLACE FUNCTION app.reject_published_release_visibility_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.published_resource_version_id IS DISTINCT FROM OLD.published_resource_version_id THEN
        RAISE EXCEPTION 'published release visibility identity is immutable; revoke and create a new row'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.reject_api_credential_release_grant_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
       OR NEW.credential_kind IS DISTINCT FROM OLD.credential_kind
       OR NEW.published_resource_version_id IS DISTINCT FROM OLD.published_resource_version_id
       OR NEW.resource_kind IS DISTINCT FROM OLD.resource_kind
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id THEN
        RAISE EXCEPTION 'credential release grant identity is immutable; revoke and create a new grant'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.bump_published_release_visibility_epoch_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.authorization_epoch := GREATEST(COALESCE(NEW.authorization_epoch, 0), 1);
    ELSIF NEW.visibility IS DISTINCT FROM OLD.visibility
       OR NEW.allowed_ingress IS DISTINCT FROM OLD.allowed_ingress
       OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        NEW.authorization_epoch := OLD.authorization_epoch + 1;
        NEW.updated_at := clock_timestamp();
    ELSIF NEW.authorization_epoch < OLD.authorization_epoch THEN
        RAISE EXCEPTION 'authorization_epoch is monotonic and cannot decrease'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.record_published_release_visibility_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, auth, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
        PERFORM auth.record_authorization_epoch_change(
            NEW.workspace_id, 'published_release_visibility', NEW.id, '', NEW.authorization_epoch
        );
    END IF;
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION app.bump_api_credential_release_grant_epoch_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.authorization_epoch := GREATEST(COALESCE(NEW.authorization_epoch, 0), 1);
    ELSIF NEW.grant_state IS DISTINCT FROM OLD.grant_state
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        NEW.authorization_epoch := OLD.authorization_epoch + 1;
    ELSIF NEW.authorization_epoch < OLD.authorization_epoch THEN
        RAISE EXCEPTION 'authorization_epoch is monotonic and cannot decrease'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.reject_published_authorization_source_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION 'published visibility/grant rows are revoked, not deleted'
        USING ERRCODE = '42501';
END;
$function$;

CREATE OR REPLACE FUNCTION app.record_api_credential_release_grant_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, auth, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
        PERFORM auth.record_authorization_epoch_change(
            NEW.workspace_id, 'internal_system_release_grant', NEW.id,
            NEW.published_resource_version_id::text, NEW.authorization_epoch
        );
    END IF;
    RETURN NULL;
END;
$function$;

CREATE TRIGGER published_release_visibility_reject_identity_change
BEFORE UPDATE OF id, workspace_id, published_resource_version_id ON published_release_visibility
FOR EACH ROW EXECUTE FUNCTION app.reject_published_release_visibility_identity_change();
CREATE TRIGGER api_credential_release_grants_reject_identity_change
BEFORE UPDATE OF id, workspace_id, credential_id, credential_kind,
    published_resource_version_id, resource_kind, resource_id
ON api_credential_release_grants
FOR EACH ROW EXECUTE FUNCTION app.reject_api_credential_release_grant_identity_change();
CREATE TRIGGER published_release_visibility_authorization_epoch_before_write
BEFORE INSERT OR UPDATE ON published_release_visibility
FOR EACH ROW EXECUTE FUNCTION app.bump_published_release_visibility_epoch_before_write();
CREATE TRIGGER published_release_visibility_authorization_epoch_after_write
AFTER INSERT OR UPDATE ON published_release_visibility
FOR EACH ROW EXECUTE FUNCTION app.record_published_release_visibility_epoch_after_write();
CREATE TRIGGER published_release_visibility_reject_delete
BEFORE DELETE ON published_release_visibility
FOR EACH ROW EXECUTE FUNCTION app.reject_published_authorization_source_delete();
CREATE TRIGGER api_credential_release_grants_authorization_epoch_before_write
BEFORE INSERT OR UPDATE ON api_credential_release_grants
FOR EACH ROW EXECUTE FUNCTION app.bump_api_credential_release_grant_epoch_before_write();
CREATE TRIGGER api_credential_release_grants_authorization_epoch_after_write
AFTER INSERT OR UPDATE ON api_credential_release_grants
FOR EACH ROW EXECUTE FUNCTION app.record_api_credential_release_grant_epoch_after_write();
CREATE TRIGGER api_credential_release_grants_reject_delete
BEFORE DELETE ON api_credential_release_grants
FOR EACH ROW EXECUTE FUNCTION app.reject_published_authorization_source_delete();

ALTER FUNCTION app.bump_published_release_visibility_epoch_before_write()
    OWNER TO ba_authorization_owner;
ALTER FUNCTION app.reject_published_release_visibility_identity_change()
    OWNER TO ba_authorization_owner;
ALTER FUNCTION app.reject_api_credential_release_grant_identity_change()
    OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_published_release_visibility_epoch_after_write()
    OWNER TO ba_authorization_owner;
ALTER FUNCTION app.bump_api_credential_release_grant_epoch_before_write()
    OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_api_credential_release_grant_epoch_after_write()
    OWNER TO ba_authorization_owner;
ALTER FUNCTION app.reject_published_authorization_source_delete()
    OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.prevent_published_resource_version_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_published_release_visibility_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_api_credential_release_grant_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_published_authorization_source_delete() FROM PUBLIC;

CREATE TABLE runs (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

    -- API/调度的幂等范围。无 Idempotency-Key 时不承诺去重。
    operation_kind text NOT NULL CHECK (
        operation_kind IN (
            'AGENT_CHAT',
            'FLOW_RUN',
            'WEBHOOK',
            'SCHEDULE',
            'INTERNAL'
        )
    ),
    -- The immutable request identity that first accepted this Run. Per-HTTP
    -- request_id belongs to audit/transport records and must never overwrite it
    -- when an idempotency replay returns this Run.
    accepted_request_id uuid NOT NULL,
    -- Only the stable public data of the accepted Operation is persisted. The
    -- current exchange request_id/now_time are regenerated for every HTTP
    -- response and therefore never become part of the idempotency fact.
    acceptance_receipt_http_status smallint NOT NULL DEFAULT 202,
    acceptance_receipt_data_redacted jsonb NOT NULL,
    principal_id text NOT NULL CHECK (char_length(principal_id) BETWEEN 1 AND 255),
    route text NOT NULL CHECK (
        char_length(route) BETWEEN 1 AND 255
        AND left(route, 1) = '/'
        AND position('?' IN route) = 0
    ),
    idempotency_key text CHECK (
        idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128
    ),
    -- Replay horizon is a lower bound, not a wall-clock lease. A keyed Run keeps
    -- the key active for its entire nonterminal lifetime; terminal transition
    -- monotonically extends this value to at least finished_at + 24 hours. Only
    -- the controlled retention expiry function may later deactivate the key.
    idempotency_expires_at timestamptz,
    idempotency_active boolean NOT NULL DEFAULT false,
    -- Stable client intent only: it deliberately excludes resolved target/release,
    -- credential binding, authorization decision and plan so an authorized replay
    -- returns the original Run after those current facts change.
    intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
    -- First accepted, fully resolved plan. It is audit/recovery evidence, never
    -- the equality key for an Idempotency-Key replay.
    accepted_plan_hash text NOT NULL CHECK (accepted_plan_hash ~ '^[0-9a-f]{64}$'),
    -- The finalizer validates a successful public result against this immutable
    -- acceptance-time schema identity. A caller-provided object shape is never
    -- sufficient evidence of output-contract compliance.
    accepted_output_schema_ref text NOT NULL CHECK (
        char_length(accepted_output_schema_ref) BETWEEN 1 AND 1024
        AND position('?' IN accepted_output_schema_ref) = 0
        AND position('#' IN accepted_output_schema_ref) = 0
    ),
    accepted_output_schema_hash text NOT NULL
        CHECK (accepted_output_schema_hash ~ '^[0-9a-f]{64}$'),

    trigger_kind text NOT NULL CHECK (
        trigger_kind IN ('API', 'WEBHOOK', 'SCHEDULE', 'INTERNAL', 'RECOVERY')
    ),
    -- This baseline is deliberately top-level-only. A later dedicated child
    -- allocation migration must atomically widen this constraint and install
    -- child/link/allocation/event/outbox/exactly-one/cascade semantics.
    run_kind text NOT NULL DEFAULT 'top_level'
        CHECK (run_kind = 'top_level'),
    billing_owner_run_id uuid NOT NULL,
    target_kind text NOT NULL CHECK (target_kind IN ('AGENT', 'FLOW', 'SYSTEM')),
    target_id uuid NOT NULL,
    target_version_pin uuid NOT NULL,
    target_version_kind text NOT NULL CHECK (
        target_version_kind IN ('AGENT', 'FLOW', 'SYSTEM')
    ),
    flow_version_pin uuid,
    agent_version_pin uuid,
    dependency_pins_hash text NOT NULL CHECK (dependency_pins_hash ~ '^[0-9a-f]{64}$'),

    -- 原始输入可置于对象存储；此处只能放 workspace 内对象引用、哈希及脱敏摘要。
    input_object_ref text,
    input_sha256 text CHECK (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'),
    input_summary_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Agent/Flow/database 的内部运行状态。GET/SSE 只能经显式 public
    -- projector 读取；WAITING -> RUNNING，NEEDS_ATTENTION -> FAILED。
    status text NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN (
            'QUEUED',
            'RUNNING',
            'WAITING_FOR_INPUT',
            'WAITING_FOR_APPROVAL',
            'RESUMING',
            'CANCEL_REQUESTED',
            'SUCCEEDED',
            'FAILED',
            'CANCELLED',
            'TIMED_OUT',
            'NEEDS_ATTENTION'
        )
    ),
    -- 内部状态映射见 runs_external_status_mapping；不能直接暴露给外部调用方。
    execution_status text NOT NULL DEFAULT 'ACCEPTED' CHECK (
        execution_status IN (
            'ACCEPTED',
            'QUEUED',
            'RUNNING',
            'WAITING_FOR_INPUT',
            'WAITING_FOR_APPROVAL',
            'RESUMING',
            'RETRY_WAIT',
            'RECOVERING',
            'CANCELLING',
            'SUCCEEDED',
            'FAILED',
            'CANCELLED',
            'EXPIRED',
            'NEEDS_ATTENTION'
        )
    ),
    current_attempt_number integer NOT NULL DEFAULT 0 CHECK (current_attempt_number >= 0),
    next_attempt_at timestamptz,
    status_reason_code text,
    termination_reason text CHECK (
        termination_reason IS NULL OR termination_reason IN (
            'COMPLETED',
            'MAX_ITERATIONS',
            'MAX_MODEL_ATTEMPTS',
            'MAX_TOOL_CALLS',
            'BUDGET_EXHAUSTED',
            'USER_CANCELLED',
            'RUN_TIMED_OUT',
            'AUTHORIZATION_REVALIDATION_FAILED',
            'RESOURCE_REVOKED',
            'MODEL_FAILED',
            'MODEL_OUTCOME_UNKNOWN',
            'CAPABILITY_FAILED',
            'SIDE_EFFECT_UNKNOWN',
            'HUMAN_REJECTED',
            'HUMAN_GATE_EXPIRED',
            'INVALID_DECISION',
            'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
            'INTERNAL_FAILURE'
        )
    ),
    status_detail_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    -- The canonical, monotonic event cursor survives event retention. It is
    -- allocated only by the run_events append trigger, never recomputed from
    -- purgeable rows.
    last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
    -- Durable terminal-event tombstone. Unlike run_events, these fields survive
    -- technical retention so identical finalizer intent can replay canonically.
    terminal_event_id uuid,
    terminal_event_sequence bigint CHECK (
        terminal_event_sequence IS NULL OR terminal_event_sequence > 0
    ),
    -- Terminal snapshot is deliberately stored on the Run, not inferred later
    -- from mutable parent links, allocations or purgeable run_events.
    terminal_billing_pending boolean,
    terminal_billing_pending_at timestamptz,
    -- Immutable, already-redacted terminal public payload. Keeping it on the
    -- Run makes GET/cancel replay possible after Step/Event retention. The
    -- finalizer is the only writer; raw output stays behind governed refs.
    terminal_result_redacted jsonb,
    terminal_error_redacted jsonb,
    -- Current settlement projection is deliberately separate from the immutable
    -- terminal-time snapshot. A detached child may move PENDING -> SETTLED after
    -- the parent terminal event without rewriting that historical event.
    billing_state text NOT NULL DEFAULT 'PENDING'
        CHECK (billing_state IN ('PENDING', 'SETTLED', 'NEEDS_ATTENTION')),
    billing_settled_at timestamptz,
    -- Event replay and recovery materials have independent minimum horizons.
    -- retention_until is the conservative aggregate/policy horizon and cannot
    -- be earlier than either technical minimum.
    events_retention_until timestamptz,
    recovery_retention_until timestamptz,
    retention_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT runs_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT runs_workspace_id_id_billing_owner_key
        UNIQUE (workspace_id, id, billing_owner_run_id),
    CONSTRAINT runs_workspace_accepted_request_id_key
        UNIQUE (workspace_id, accepted_request_id),
    CONSTRAINT runs_workspace_terminal_event_id_key
        UNIQUE (workspace_id, terminal_event_id),
    CONSTRAINT runs_acceptance_receipt_shape CHECK (
        acceptance_receipt_http_status = 202
        AND jsonb_typeof(acceptance_receipt_data_redacted) = 'object'
        AND acceptance_receipt_data_redacted ?& ARRAY[
            'run_id', 'accepted_request_id', 'status',
            'operation_url', 'events_url', 'cancel_url'
        ]
        AND acceptance_receipt_data_redacted - ARRAY[
            'run_id', 'accepted_request_id', 'status',
            'operation_url', 'events_url', 'cancel_url', 'conversation_id'
        ] = '{}'::jsonb
        AND acceptance_receipt_data_redacted->>'run_id' = id::text
        AND acceptance_receipt_data_redacted->>'accepted_request_id' = accepted_request_id::text
        AND acceptance_receipt_data_redacted->>'status' = 'QUEUED'
        AND acceptance_receipt_data_redacted->>'operation_url'
            = '/v1/oapi/runs/' || id::text
        AND acceptance_receipt_data_redacted->>'events_url'
            = '/v1/oapi/runs/' || id::text || '/events'
        AND acceptance_receipt_data_redacted->>'cancel_url'
            = '/v1/oapi/runs/' || id::text || '/cancel'
        AND (
            NOT (acceptance_receipt_data_redacted ? 'conversation_id')
            OR jsonb_typeof(acceptance_receipt_data_redacted->'conversation_id') = 'string'
        )
    ),
    CONSTRAINT runs_target_pin_shape CHECK (
        (
            target_kind = 'AGENT'
            AND target_version_kind = 'AGENT'
            AND target_id IS NOT NULL
            AND agent_version_pin = target_version_pin
            AND flow_version_pin IS NULL
        )
        OR (
            target_kind = 'FLOW'
            AND target_version_kind = 'FLOW'
            AND target_id IS NOT NULL
            AND flow_version_pin = target_version_pin
            AND agent_version_pin IS NULL
        )
        OR (
            target_kind = 'SYSTEM'
            AND target_version_kind = 'SYSTEM'
            AND target_id IS NOT NULL
            AND flow_version_pin IS NULL
            AND agent_version_pin IS NULL
        )
    ),
    CONSTRAINT runs_retry_wait_requires_time CHECK (
        execution_status <> 'RETRY_WAIT' OR next_attempt_at IS NOT NULL
    ),
    CONSTRAINT runs_idempotency_shape CHECK (
        (
            idempotency_key IS NULL
            AND idempotency_expires_at IS NULL
            AND idempotency_active = false
        )
        OR (
            idempotency_key IS NOT NULL
            AND idempotency_expires_at IS NOT NULL
        )
    ),
    CONSTRAINT runs_idempotency_expiry_after_acceptance CHECK (
        idempotency_expires_at IS NULL
        OR idempotency_expires_at >= accepted_at + interval '24 hours'
    ),
    CONSTRAINT runs_terminal_idempotency_replay_grace CHECK (
        idempotency_key IS NULL
        OR finished_at IS NULL
        OR idempotency_expires_at >= finished_at + interval '24 hours'
    ),
    CONSTRAINT runs_terminal_retention_horizons CHECK (
        (
            finished_at IS NULL
            AND events_retention_until IS NULL
            AND recovery_retention_until IS NULL
        )
        OR (
            finished_at IS NOT NULL
            AND events_retention_until >= finished_at + interval '7 days'
            AND recovery_retention_until >= finished_at + interval '30 days'
            AND recovery_retention_until >= events_retention_until
            AND retention_until >= recovery_retention_until
        )
    ),
    CONSTRAINT runs_external_status_mapping CHECK (
        (
            execution_status IN ('ACCEPTED', 'QUEUED', 'RETRY_WAIT', 'RECOVERING')
            AND status = 'QUEUED'
        )
        OR (
            execution_status = 'RUNNING'
            AND status = 'RUNNING'
        )
        OR (execution_status = 'WAITING_FOR_INPUT' AND status = 'WAITING_FOR_INPUT')
        OR (execution_status = 'WAITING_FOR_APPROVAL' AND status = 'WAITING_FOR_APPROVAL')
        OR (execution_status = 'RESUMING' AND status = 'RESUMING')
        OR (execution_status = 'CANCELLING' AND status = 'CANCEL_REQUESTED')
        OR (execution_status = 'SUCCEEDED' AND status = 'SUCCEEDED')
        OR (execution_status = 'FAILED' AND status = 'FAILED')
        OR (execution_status = 'CANCELLED' AND status = 'CANCELLED')
        OR (execution_status = 'EXPIRED' AND status = 'TIMED_OUT')
        OR (execution_status = 'NEEDS_ATTENTION' AND status = 'NEEDS_ATTENTION')
    ),
    CONSTRAINT runs_terminal_requires_finished_at CHECK (
        (
            status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND finished_at IS NOT NULL
        )
        OR (
            status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND finished_at IS NULL
        )
    ),
    CONSTRAINT runs_terminal_reason_mapping CHECK (
        (
            status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND termination_reason IS NULL
        )
        OR (status = 'SUCCEEDED' AND termination_reason = 'COMPLETED')
        OR (status = 'CANCELLED' AND termination_reason IN (
            'USER_CANCELLED', 'HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED'
        ))
        OR (status = 'TIMED_OUT' AND termination_reason = 'RUN_TIMED_OUT')
        OR (status = 'NEEDS_ATTENTION' AND termination_reason = 'SIDE_EFFECT_UNKNOWN')
        OR (status = 'FAILED' AND termination_reason IN (
            'MAX_ITERATIONS', 'MAX_MODEL_ATTEMPTS', 'MAX_TOOL_CALLS',
            'BUDGET_EXHAUSTED', 'AUTHORIZATION_REVALIDATION_FAILED',
            'RESOURCE_REVOKED', 'MODEL_FAILED', 'MODEL_OUTCOME_UNKNOWN',
            'CAPABILITY_FAILED', 'HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED',
            'INVALID_DECISION', 'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
            'INTERNAL_FAILURE'
        ))
    ),
    CONSTRAINT runs_terminal_billing_snapshot_shape CHECK (
        (
            status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND terminal_billing_pending IS NOT NULL
            AND terminal_billing_pending_at IS NOT NULL
            AND last_event_sequence > 0
            AND terminal_event_id IS NOT NULL
            AND terminal_event_sequence = last_event_sequence
        )
        OR (
            status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND terminal_billing_pending IS NULL
            AND terminal_billing_pending_at IS NULL
            AND terminal_event_id IS NULL
            AND terminal_event_sequence IS NULL
        )
    ),
    CONSTRAINT runs_terminal_public_projection_shape CHECK (
        (
            status = 'SUCCEEDED'
            AND terminal_result_redacted IS NOT NULL
            AND jsonb_typeof(terminal_result_redacted) = 'object'
            AND terminal_error_redacted IS NULL
        )
        OR (
            status IN ('FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND terminal_result_redacted IS NULL
            AND terminal_error_redacted IS NOT NULL
            AND jsonb_typeof(terminal_error_redacted) = 'object'
            AND terminal_error_redacted ?& ARRAY['code', 'retryable', 'category']
            AND terminal_error_redacted->>'code' = termination_reason
            AND terminal_error_redacted->'retryable' = 'false'::jsonb
            AND terminal_error_redacted->>'category' = 'EXECUTION'
            AND terminal_error_redacted - ARRAY[
                'code', 'retryable', 'category', 'flow_category',
                'requires_operator_action'
            ] = '{}'::jsonb
        )
        OR (
            status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND terminal_result_redacted IS NULL
            AND terminal_error_redacted IS NULL
        )
    ),
    CONSTRAINT runs_side_effect_unknown_public_projection CHECK (
        status <> 'NEEDS_ATTENTION'
        OR (
            terminal_error_redacted IS NOT NULL
            AND terminal_error_redacted->>'code' = 'SIDE_EFFECT_UNKNOWN'
            AND terminal_error_redacted->'retryable' = 'false'::jsonb
            AND terminal_error_redacted->>'category' = 'EXECUTION'
            AND terminal_error_redacted->'requires_operator_action' = 'true'::jsonb
        )
    ),
    CONSTRAINT runs_current_billing_state_shape CHECK (
        (billing_state = 'SETTLED' AND billing_settled_at IS NOT NULL)
        OR (billing_state <> 'SETTLED' AND billing_settled_at IS NULL)
    ),
    CONSTRAINT runs_g1_terminal_billing_shape CHECK (
        status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
        OR (
            status = 'NEEDS_ATTENTION'
            AND terminal_billing_pending = false
            AND billing_state IN ('NEEDS_ATTENTION', 'SETTLED')
        )
        OR (
            status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
            AND terminal_billing_pending = false
            AND billing_state = 'SETTLED'
        )
    ),
    CONSTRAINT runs_billing_owner_shape CHECK (
        run_kind = 'top_level' AND billing_owner_run_id = id
    ),
    CONSTRAINT runs_billing_owner_fkey
        FOREIGN KEY (workspace_id, billing_owner_run_id)
        REFERENCES runs(workspace_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT runs_target_version_same_workspace_fkey
        FOREIGN KEY (workspace_id, target_version_pin, target_version_kind, target_id)
        REFERENCES published_resource_versions(workspace_id, id, resource_kind, resource_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE runs IS
    '运行聚合与准入事实源；当前基线仅允许 top_level 且 billing_owner_run_id=self。child 必须由后续专属 allocation migration 原子启用；不保存原始 secret 或未脱敏请求内容。';
COMMENT ON COLUMN runs.status IS
    'Agent/Flow/database 共享的内部 RunStatusV1：QUEUED/RUNNING/WAITING_FOR_INPUT/WAITING_FOR_APPROVAL/RESUMING/CANCEL_REQUESTED/SUCCEEDED/FAILED/CANCELLED/TIMED_OUT/NEEDS_ATTENTION。公开 REST/SSE 是独立兼容投影：WAITING 映射 RUNNING，内部 NEEDS_ATTENTION 映射 FAILED + SIDE_EFFECT_UNKNOWN；公开投影不能反向成为运行事实源。';
COMMENT ON COLUMN runs.execution_status IS
    '内部调度与恢复细分；WAITING/RESUMING/NEEDS_ATTENTION 逐字投影到共享 RunStatusV1，仅 ACCEPTED/RETRY_WAIT/RECOVERING 等内部阶段折叠。';
COMMENT ON COLUMN runs.termination_reason IS
    'terminal-only StrategyTerminationReasonV1。状态映射由 runs_terminal_reason_mapping fail-closed；SIDE_EFFECT_UNKNOWN 只能得到 terminal NEEDS_ATTENTION。';
COMMENT ON COLUMN runs.principal_id IS
    '不可变的受认证主体标识。v1 API ingress 必须等于 app.current_authenticated_principal_id() 派生的 service credential 或 browser-session end_user principal；不得存调用方任意声明的 user.id。';
COMMENT ON COLUMN runs.acceptance_receipt_data_redacted IS
    '首次接受事务保存的 canonical 202 Operation 稳定 data。重放原样读取；仅允许公开 run selector/URL 和可选 conversation selector，不含当前 exchange 字段或内部 pin。';
COMMENT ON COLUMN runs.terminal_billing_pending IS
    '终态时由受控 finalizer 一次写定的 billing_pending；G1 join-only 固定 false，GET、blocking 与 SSE terminal 共同读取，绝不由可变 allocation 或可删除事件重新推导。';
COMMENT ON COLUMN runs.terminal_result_redacted IS
    '不可变成功公开结果投影；仅 SUCCEEDED 必填，由可信 finalizer 在 accepted output schema 校验后写入。';
COMMENT ON COLUMN runs.terminal_error_redacted IS
    '不可变失败公开错误投影；内部 NEEDS_ATTENTION 固定为 SIDE_EFFECT_UNKNOWN、retryable=false、requires_operator_action=true。';
COMMENT ON COLUMN runs.billing_state IS
    '当前可查询的账务结算状态，与不可变 terminal_billing_pending 历史快照分离；客户端以此判断费用是否已最终结算。';
COMMENT ON COLUMN runs.last_event_sequence IS
    'Run 的权威单调 event cursor；append trigger 在同一事务为每个事件分配，retention 不得回退或重算它。GET、410 恢复数据、取消终态响应和 terminal SSE 均从此列投影十进制字符串。';
COMMENT ON COLUMN runs.terminal_event_id IS
    '不可变 terminal event 墓碑；run_events 清理后 finalizer 仍以此 id 和 terminal_event_sequence 区分 canonical replay 与冲突。';
COMMENT ON COLUMN runs.events_retention_until IS
    '终态 SSE/event 技术重放的最早清理时间，不早于 finished_at + 7 days。';
COMMENT ON COLUMN runs.recovery_retention_until IS
    '终态 checkpoint/outbox 恢复材料的最早清理时间，不早于 finished_at + 30 days。';
COMMENT ON COLUMN runs.idempotency_active IS
    'Keyed Run 在全部非终态（含长期 WAITING）始终为 true；终态后至少保留 24 小时重放宽限，且仅受控 retention expiry 函数可置 false。';
COMMENT ON COLUMN runs.target_version_pin IS
    '不可变目标发布版本 UUID；与 workspace_id、target_version_kind、target_id 共同通过四元复合 FK 指向 registry。';
COMMENT ON COLUMN runs.accepted_request_id IS
    '首次接受 Run 的 immutable UUID。每次 HTTP 请求的 request_id 不写入此列，也不因幂等重放改变。';
COMMENT ON COLUMN runs.dependency_pins_hash IS
    '冻结依赖版本清单的 SHA-256；完整清单应置于受控对象或未来规范化关联表。';
COMMENT ON COLUMN runs.input_summary_redacted IS
    '仅允许可展示的脱敏摘要，禁止存入 Header、Cookie、token、password 或密钥。';

-- Acceptance identity is append-once. Runtime/finalizer updates may advance
-- execution, event and billing state, but must never rewrite what operation was
-- accepted, for whom, against which immutable plan/target/dependencies/input, or
-- under which root billing owner. Idempotency replay-horizon extension and final
-- deactivation are handled separately by normalize_run_idempotency() and the
-- retention-only expiry function below.
CREATE OR REPLACE FUNCTION app.prevent_run_acceptance_identity_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.operation_kind IS DISTINCT FROM OLD.operation_kind
       OR NEW.accepted_request_id IS DISTINCT FROM OLD.accepted_request_id
       OR NEW.acceptance_receipt_http_status IS DISTINCT FROM OLD.acceptance_receipt_http_status
       OR NEW.acceptance_receipt_data_redacted IS DISTINCT FROM OLD.acceptance_receipt_data_redacted
       OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
       OR NEW.route IS DISTINCT FROM OLD.route
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.intent_hash IS DISTINCT FROM OLD.intent_hash
       OR NEW.accepted_plan_hash IS DISTINCT FROM OLD.accepted_plan_hash
       OR NEW.accepted_output_schema_ref IS DISTINCT FROM OLD.accepted_output_schema_ref
       OR NEW.accepted_output_schema_hash IS DISTINCT FROM OLD.accepted_output_schema_hash
       OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
       OR NEW.run_kind IS DISTINCT FROM OLD.run_kind
       OR NEW.billing_owner_run_id IS DISTINCT FROM OLD.billing_owner_run_id
       OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
       OR NEW.target_id IS DISTINCT FROM OLD.target_id
       OR NEW.target_version_pin IS DISTINCT FROM OLD.target_version_pin
       OR NEW.target_version_kind IS DISTINCT FROM OLD.target_version_kind
       OR NEW.flow_version_pin IS DISTINCT FROM OLD.flow_version_pin
       OR NEW.agent_version_pin IS DISTINCT FROM OLD.agent_version_pin
       OR NEW.dependency_pins_hash IS DISTINCT FROM OLD.dependency_pins_hash
       OR NEW.input_object_ref IS DISTINCT FROM OLD.input_object_ref
       OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
       OR NEW.input_summary_redacted IS DISTINCT FROM OLD.input_summary_redacted
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Run acceptance identity is immutable after INSERT'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER runs_prevent_acceptance_identity_rewrite
BEFORE UPDATE OF
    id,
    workspace_id,
    operation_kind,
    accepted_request_id,
    acceptance_receipt_http_status,
    acceptance_receipt_data_redacted,
    principal_id,
    route,
    idempotency_key,
    intent_hash,
    accepted_plan_hash,
    accepted_output_schema_ref,
    accepted_output_schema_hash,
    trigger_kind,
    run_kind,
    billing_owner_run_id,
    target_kind,
    target_id,
    target_version_pin,
    target_version_kind,
    flow_version_pin,
    agent_version_pin,
    dependency_pins_hash,
    input_object_ref,
    input_sha256,
    input_summary_redacted,
    accepted_at,
    created_at
ON runs
FOR EACH ROW
EXECUTE FUNCTION app.prevent_run_acceptance_identity_rewrite();

ALTER FUNCTION app.prevent_run_acceptance_identity_rewrite() OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.prevent_run_acceptance_identity_rewrite() FROM PUBLIC;

-- The ingress authentication layer is the only source of an API principal.
-- app.current_authenticated_principal_id() may resolve a service credential or
-- a verified short-lived browser session principal; request fields such as
-- user.id never establish identity.
CREATE OR REPLACE FUNCTION app.enforce_api_run_principal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
DECLARE
    v_current_principal text;
BEGIN
    IF TG_OP = 'UPDATE'
       AND (
           NEW.principal_id IS DISTINCT FROM OLD.principal_id
           OR NEW.accepted_request_id IS DISTINCT FROM OLD.accepted_request_id
           OR NEW.acceptance_receipt_http_status IS DISTINCT FROM OLD.acceptance_receipt_http_status
           OR NEW.acceptance_receipt_data_redacted IS DISTINCT FROM OLD.acceptance_receipt_data_redacted
       ) THEN
        RAISE EXCEPTION 'Run principal, accepted request and canonical acceptance receipt are immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.trigger_kind = 'API' THEN
        v_current_principal := app.current_authenticated_principal_id();
        IF v_current_principal IS NULL
           OR NEW.principal_id IS DISTINCT FROM v_current_principal THEN
            RAISE EXCEPTION 'API Run principal must equal the verified ingress principal'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER runs_enforce_api_principal
BEFORE INSERT OR UPDATE OF
    principal_id,
    trigger_kind,
    accepted_request_id,
    acceptance_receipt_http_status,
    acceptance_receipt_data_redacted
ON runs
FOR EACH ROW
EXECUTE FUNCTION app.enforce_api_run_principal();

ALTER FUNCTION app.enforce_api_run_principal() OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.enforce_api_run_principal() FROM PUBLIC;

CREATE FUNCTION app.normalize_run_idempotency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $function$
DECLARE
    v_required_until timestamptz;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.idempotency_key IS NULL THEN
            NEW.idempotency_expires_at := NULL;
            NEW.idempotency_active := false;
        ELSE
            NEW.idempotency_expires_at := GREATEST(
                COALESCE(NEW.idempotency_expires_at, NEW.accepted_at + interval '24 hours'),
                NEW.accepted_at + interval '24 hours'
            );
            NEW.idempotency_active := true;
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
        RAISE EXCEPTION 'Run idempotency key is immutable after acceptance'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.idempotency_key IS NULL THEN
        IF NEW.idempotency_expires_at IS NOT NULL OR NEW.idempotency_active THEN
            RAISE EXCEPTION 'unkeyed Run cannot acquire idempotency state after acceptance'
                USING ERRCODE = '55000';
        END IF;
        NEW.idempotency_expires_at := NULL;
        NEW.idempotency_active := false;
        RETURN NEW;
    END IF;

    v_required_until := OLD.idempotency_expires_at;
    IF NEW.idempotency_expires_at IS DISTINCT FROM OLD.idempotency_expires_at THEN
        IF current_user <> 'ba_retention'
           OR NEW.idempotency_expires_at < OLD.idempotency_expires_at THEN
            RAISE EXCEPTION 'Run idempotency replay horizon is retention-controlled and monotonic'
                USING ERRCODE = '55000';
        END IF;
        v_required_until := NEW.idempotency_expires_at;
    END IF;

    IF NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
       AND NEW.finished_at IS NOT NULL THEN
        v_required_until := GREATEST(
            v_required_until,
            NEW.finished_at + interval '24 hours'
        );
    END IF;
    NEW.idempotency_expires_at := v_required_until;

    IF NEW.idempotency_active IS DISTINCT FROM OLD.idempotency_active THEN
        IF NOT (
            current_user = 'ba_retention'
            AND OLD.idempotency_active
            AND NOT NEW.idempotency_active
            AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
            AND NEW.finished_at IS NOT NULL
            AND clock_timestamp() >= v_required_until
        ) THEN
            RAISE EXCEPTION 'Run idempotency key may deactivate only after terminal replay grace via retention control'
                USING ERRCODE = '55000';
        END IF;
    ELSIF NEW.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION') THEN
        NEW.idempotency_active := true;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER runs_normalize_idempotency
BEFORE INSERT OR UPDATE OF
    idempotency_key,
    idempotency_expires_at,
    idempotency_active,
    status,
    finished_at
ON runs
FOR EACH ROW
EXECUTE FUNCTION app.normalize_run_idempotency();

CREATE OR REPLACE FUNCTION app.expire_run_acceptance_idempotency(
    p_workspace_id uuid,
    p_run_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_status text;
    v_finished_at timestamptz;
    v_expires_at timestamptz;
    v_active boolean;
    v_required_until timestamptz;
BEGIN
    SELECT status, finished_at, idempotency_expires_at, idempotency_active
      INTO v_status, v_finished_at, v_expires_at, v_active
      FROM public.runs
     WHERE workspace_id = p_workspace_id
       AND id = p_run_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Run not found for idempotency expiry'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_expires_at IS NULL OR NOT v_active THEN
        RETURN false;
    END IF;
    IF v_status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
       OR v_finished_at IS NULL THEN
        RAISE EXCEPTION 'nonterminal Run idempotency key cannot expire'
            USING ERRCODE = '55000';
    END IF;

    v_required_until := GREATEST(v_expires_at, v_finished_at + interval '24 hours');
    IF clock_timestamp() < v_required_until THEN
        IF v_expires_at < v_required_until THEN
            UPDATE public.runs
               SET idempotency_expires_at = v_required_until
             WHERE workspace_id = p_workspace_id
               AND id = p_run_id;
        END IF;
        RETURN false;
    END IF;

    UPDATE public.runs
       SET idempotency_expires_at = v_required_until,
           idempotency_active = false
     WHERE workspace_id = p_workspace_id
       AND id = p_run_id;
    RETURN true;
END;
$function$;

ALTER FUNCTION app.expire_run_acceptance_idempotency(uuid, uuid)
    OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.expire_run_acceptance_idempotency(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_run_acceptance_idempotency(uuid, uuid)
    TO ba_retention_executor;

-- app.finalize_run(...) is the only terminal transition path. In one outer
-- transaction it appends the single RUN_FINISHED event first (which allocates
-- runs.last_event_sequence), then writes status/finished_at/billing snapshot
-- and the public result-or-error snapshot, settles/preserves responsibility,
-- and emits outbox. Runtime
-- callers do not receive raw UPDATE permission on terminal facts.
CREATE OR REPLACE FUNCTION app.enforce_terminal_billing_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    -- Intentionally SECURITY INVOKER: the only permitted writers are isolated
    -- phase-owner functions, and the transition matrix below must observe that
    -- outer function owner as current_user. SECURITY DEFINER here would collapse
    -- all phases to the trigger owner and either deny every valid transition or
    -- erase the phase boundary.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.last_event_sequence < OLD.last_event_sequence THEN
            RAISE EXCEPTION 'Run event sequence cannot move backwards'
                USING ERRCODE = '55000';
        END IF;

        IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
           AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'terminal run status is immutable'
                USING ERRCODE = '55000';
        END IF;

        IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
           AND NEW.termination_reason IS DISTINCT FROM OLD.termination_reason THEN
            RAISE EXCEPTION 'terminal Run termination reason is immutable'
                USING ERRCODE = '55000';
        END IF;

        IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
           AND (
               NEW.last_event_sequence IS DISTINCT FROM OLD.last_event_sequence
               OR NEW.terminal_event_id IS DISTINCT FROM OLD.terminal_event_id
               OR NEW.terminal_event_sequence IS DISTINCT FROM OLD.terminal_event_sequence
           ) THEN
            RAISE EXCEPTION 'terminal Run event cursor and tombstone are immutable'
                USING ERRCODE = '55000';
        END IF;

        IF OLD.events_retention_until IS NOT NULL
           AND (
               NEW.events_retention_until IS NULL
               OR NEW.events_retention_until < OLD.events_retention_until
           ) THEN
            RAISE EXCEPTION 'event retention horizon is monotonic'
                USING ERRCODE = '55000';
        END IF;
        IF OLD.recovery_retention_until IS NOT NULL
           AND (
               NEW.recovery_retention_until IS NULL
               OR NEW.recovery_retention_until < OLD.recovery_retention_until
           ) THEN
            RAISE EXCEPTION 'recovery retention horizon is monotonic'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.retention_until < OLD.retention_until THEN
            RAISE EXCEPTION 'aggregate Run retention horizon is monotonic'
                USING ERRCODE = '55000';
        END IF;

        IF NEW.billing_state IS DISTINCT FROM OLD.billing_state
           OR NEW.billing_settled_at IS DISTINCT FROM OLD.billing_settled_at THEN
            IF NOT (
                (OLD.billing_state = 'PENDING'
                 AND NEW.billing_state = 'SETTLED'
                 AND current_user IN ('ba_metering_owner', 'ba_finalizer_owner'))
                OR (OLD.billing_state = 'PENDING'
                    AND NEW.billing_state = 'NEEDS_ATTENTION'
                    AND current_user = 'ba_finalizer_owner')
                OR (OLD.billing_state = 'NEEDS_ATTENTION'
                    AND NEW.billing_state = 'SETTLED'
                    AND current_user = 'ba_reconciliation_owner'
                    AND EXISTS (
                        SELECT 1
                        FROM public.run_billing_reconciliations AS reconciliation
                        WHERE reconciliation.workspace_id = NEW.workspace_id
                          AND reconciliation.run_id = NEW.id
                    ))
            ) THEN
                RAISE EXCEPTION 'billing state transition is not authorized for this isolated phase'
                    USING ERRCODE = '42501';
            END IF;
            IF OLD.billing_settled_at IS NOT NULL
               AND NEW.billing_settled_at IS DISTINCT FROM OLD.billing_settled_at THEN
                RAISE EXCEPTION 'billing settlement timestamp is immutable'
                    USING ERRCODE = '55000';
            END IF;
        END IF;

        IF OLD.terminal_billing_pending_at IS NOT NULL
           AND (
               NEW.terminal_billing_pending IS DISTINCT FROM OLD.terminal_billing_pending
               OR NEW.terminal_billing_pending_at IS DISTINCT FROM OLD.terminal_billing_pending_at
               OR NEW.terminal_result_redacted IS DISTINCT FROM OLD.terminal_result_redacted
               OR NEW.terminal_error_redacted IS DISTINCT FROM OLD.terminal_error_redacted
           ) THEN
            RAISE EXCEPTION 'terminal public and billing snapshots are immutable'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    IF NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
       AND (
           NEW.terminal_billing_pending IS NULL
           OR NEW.terminal_billing_pending_at IS NULL
       ) THEN
        RAISE EXCEPTION 'terminal Run requires an immutable billing_pending snapshot'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER runs_enforce_terminal_billing_snapshot
BEFORE INSERT OR UPDATE ON runs
FOR EACH ROW
EXECUTE FUNCTION app.enforce_terminal_billing_snapshot();

-- Future durable async Flow/SubAgent calls use this shape, but the current
-- baseline is intentionally non-executable for child Runs. A dedicated migration
-- must atomically add child Run admission, allocation, exactly-one link,
-- allocation/event/outbox writes and cancel cascade before replacing the reject
-- trigger below. Keeping only half that transaction would create unowned cost or
-- an uncancelled child, so fail closed is part of the current contract.
CREATE TABLE run_parent_links (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    child_run_id uuid NOT NULL,
    parent_run_id uuid NOT NULL,
    parent_call_id uuid,
    billing_owner_run_id uuid NOT NULL,
    relation_kind text NOT NULL CHECK (relation_kind IN ('flow', 'subagent')),
    -- G0/G1 admits exactly one async child profile. Future detach or relaxed
    -- cancellation/projection semantics require a new schema version, migration
    -- and independently sealed admission gate; they are not dormant enum values.
    completion_policy text NOT NULL CHECK (completion_policy = 'join'),
    cancel_propagation text NOT NULL CHECK (cancel_propagation = 'cascade'),
    result_projection text NOT NULL CHECK (result_projection = 'safe_summary'),
    parent_terminal_policy text NOT NULL CHECK (
        parent_terminal_policy = 'wait_for_settlement'
    ),
    created_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (workspace_id, child_run_id),
    CONSTRAINT run_parent_links_workspace_child_parent_owner_key
        UNIQUE (workspace_id, child_run_id, parent_run_id, billing_owner_run_id),
    CONSTRAINT run_parent_links_child_owner_fkey
        FOREIGN KEY (workspace_id, child_run_id, billing_owner_run_id)
        REFERENCES runs(workspace_id, id, billing_owner_run_id)
        ON DELETE RESTRICT,
    CONSTRAINT run_parent_links_parent_owner_fkey
        FOREIGN KEY (workspace_id, parent_run_id, billing_owner_run_id)
        REFERENCES runs(workspace_id, id, billing_owner_run_id)
        ON DELETE RESTRICT,
    CONSTRAINT run_parent_links_not_self CHECK (child_run_id <> parent_run_id),
    CONSTRAINT run_parent_links_policy_shape CHECK (
        completion_policy = 'join'
        AND cancel_propagation = 'cascade'
        AND result_projection = 'safe_summary'
        AND parent_terminal_policy = 'wait_for_settlement'
    )
);

COMMENT ON TABLE run_parent_links IS
    'Future immutable direct parent relation. This baseline rejects every INSERT; a dedicated migration may enable only an atomic child+link+allocation+event+outbox transaction with deferred exactly-one and cascade cancellation.';

CREATE OR REPLACE FUNCTION app.reject_unsealed_run_parent_link_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION 'child Run allocation is unavailable until the sealed allocation migration is installed'
        USING ERRCODE = '0A000';
END;
$function$;

CREATE TRIGGER run_parent_links_reject_unsealed_insert
BEFORE INSERT ON run_parent_links
FOR EACH ROW
EXECUTE FUNCTION app.reject_unsealed_run_parent_link_insert();

CREATE OR REPLACE FUNCTION app.prevent_run_parent_link_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION 'run parent links are immutable; create a new child Run for a new topology'
        USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER run_parent_links_prevent_mutation
BEFORE UPDATE OR DELETE ON run_parent_links
FOR EACH ROW
EXECUTE FUNCTION app.prevent_run_parent_link_mutation();

CREATE OR REPLACE FUNCTION app.assert_run_parent_link_acyclic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
DECLARE
    v_cycle boolean;
BEGIN
    -- A root-scoped advisory lock serializes all topology changes that could
    -- otherwise each observe a different half of a concurrently created cycle.
    -- Row locks then follow the documented stable order by UUID.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'run-parent-root:' || NEW.workspace_id::text || ':' || NEW.billing_owner_run_id::text,
            0
        )
    );
    PERFORM 1
    FROM public.runs
    WHERE workspace_id = NEW.workspace_id
      AND id = ANY (ARRAY[NEW.billing_owner_run_id, NEW.parent_run_id, NEW.child_run_id])
    ORDER BY id
    FOR UPDATE;

    IF NOT EXISTS (
        SELECT 1
        FROM public.runs owner_run
        JOIN public.runs parent_run
          ON parent_run.workspace_id = owner_run.workspace_id
         AND parent_run.id = NEW.parent_run_id
        JOIN public.runs child_run
          ON child_run.workspace_id = owner_run.workspace_id
         AND child_run.id = NEW.child_run_id
        WHERE owner_run.workspace_id = NEW.workspace_id
          AND owner_run.id = NEW.billing_owner_run_id
          AND owner_run.run_kind = 'top_level'
          AND owner_run.billing_owner_run_id = owner_run.id
          AND parent_run.billing_owner_run_id = owner_run.id
          AND child_run.billing_owner_run_id = owner_run.id
          AND child_run.run_kind = 'child'
    ) THEN
        RAISE EXCEPTION 'child/parent/root billing-owner topology is invalid'
            USING ERRCODE = '23514';
    END IF;

    WITH RECURSIVE ancestors(run_id, path) AS (
        SELECT NEW.parent_run_id, ARRAY[NEW.parent_run_id]
        UNION ALL
        SELECT link.parent_run_id, ancestors.path || link.parent_run_id
        FROM public.run_parent_links AS link
        JOIN ancestors
          ON ancestors.run_id = link.child_run_id
        WHERE link.workspace_id = NEW.workspace_id
          AND NOT link.parent_run_id = ANY (ancestors.path)
    )
    SELECT EXISTS (
        SELECT 1
        FROM ancestors
        WHERE run_id = NEW.child_run_id
    )
    INTO v_cycle;

    IF v_cycle THEN
        RAISE EXCEPTION 'run parent link would create a cycle'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER run_parent_links_acyclic_guard
AFTER INSERT ON run_parent_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION app.assert_run_parent_link_acyclic();

ALTER FUNCTION app.prevent_run_parent_link_mutation() OWNER TO ba_billing_owner;
ALTER FUNCTION app.assert_run_parent_link_acyclic() OWNER TO ba_billing_owner;
ALTER FUNCTION app.reject_unsealed_run_parent_link_insert() OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.reject_unsealed_run_parent_link_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_run_parent_link_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assert_run_parent_link_acyclic() FROM PUBLIC;

CREATE TABLE run_attempts (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),

    status text NOT NULL DEFAULT 'PENDING' CHECK (
        status IN (
            'PENDING',
            'LEASED',
            'EXECUTING',
            'SUCCEEDED',
            'FAILED',
            'TIMED_OUT',
            'ABANDONED',
            'SUSPENDED',
            'CANCELLED',
            'UNKNOWN'
        )
    ),
    queue_job_key text,
    lease_owner text,
    lease_token uuid,
    lease_fencing_token bigint NOT NULL CHECK (lease_fencing_token > 0),
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    retry_not_before timestamptz,
    failure_class text CHECK (
        failure_class IS NULL OR failure_class IN (
            'RETRYABLE',
            'NON_RETRYABLE',
            'CANCELLED',
            'UNKNOWN_EXTERNAL_EFFECT'
        )
    ),
    failure_code text,
    failure_detail_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    leased_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_attempts_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT run_attempts_workspace_run_attempt_key
        UNIQUE (workspace_id, run_id, attempt_number),
    CONSTRAINT run_attempts_workspace_run_fence_key
        UNIQUE (workspace_id, run_id, lease_fencing_token),
    CONSTRAINT run_attempts_workspace_run_id_fence_key
        UNIQUE (workspace_id, run_id, id, lease_fencing_token),
    CONSTRAINT run_attempts_workspace_queue_job_key
        UNIQUE (workspace_id, queue_job_key),
    CONSTRAINT run_attempts_active_lease_requires_fields CHECK (
        status NOT IN ('LEASED', 'EXECUTING')
        OR (
            lease_owner IS NOT NULL
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
        )
    ),
    CONSTRAINT run_attempts_suspended_releases_lease CHECK (
        status <> 'SUSPENDED'
        OR (
            lease_owner IS NULL
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
        )
    ),
    CONSTRAINT run_attempts_run_fk
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_attempts_workspace_run_id_key
        UNIQUE (workspace_id, run_id, id)
);

COMMENT ON TABLE run_attempts IS
    'Worker 执行尝试；提交状态、步骤和 checkpoint 时必须在同一事务校验 lease_token 与 lease_fencing_token。';
COMMENT ON COLUMN run_attempts.lease_fencing_token IS
    '同一 run 上单调递增的栅栏号；过期 Worker 使用旧栅栏号不得覆盖新尝试。';

CREATE TABLE run_steps (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    scope_path text NOT NULL CHECK (char_length(scope_path) BETWEEN 1 AND 1000),
    node_id text NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 255),
    node_type text NOT NULL CHECK (char_length(node_type) BETWEEN 1 AND 100),

    status text NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN (
            'QUEUED', 'RUNNING', 'SUSPENDED', 'RESUMING',
            'SUCCEEDED', 'SKIPPED', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION'
        )
    ),
    last_attempt_id uuid,
    external_operation_key text,
    is_idempotent boolean NOT NULL DEFAULT false,
    requires_manual_review boolean NOT NULL DEFAULT false,

    input_object_ref text,
    input_sha256 text CHECK (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'),
    output_object_ref text,
    output_sha256 text CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
    result_summary_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    metered_credits bigint NOT NULL DEFAULT 0 CHECK (metered_credits >= 0),
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_steps_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT run_steps_workspace_run_scope_node_key
        UNIQUE (workspace_id, run_id, scope_path, node_id),
    CONSTRAINT run_steps_workspace_run_id_key
        UNIQUE (workspace_id, run_id, id),
    CONSTRAINT run_steps_workspace_run_operation_key
        UNIQUE (workspace_id, run_id, external_operation_key),
    CONSTRAINT run_steps_run_fk
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_steps_last_attempt_fk
        FOREIGN KEY (workspace_id, run_id, last_attempt_id)
        REFERENCES run_attempts(workspace_id, run_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_steps_needs_attention_requires_review CHECK (
        status <> 'NEEDS_ATTENTION' OR requires_manual_review
    )
);

COMMENT ON TABLE run_steps IS
    '编译后节点的逻辑进度；status 逐字使用共享 StepStatusV1，SUSPENDED 是持久等待而 NEEDS_ATTENTION 是 operator-hold 终态。scope_path 必须包含循环/分支实例，使 (run, scope_path, node) 稳定唯一。';
COMMENT ON COLUMN run_steps.external_operation_key IS
    '传给支持幂等的外部系统的稳定操作键，不得放置 credential。NULL 表示不能证明外部副作用幂等。';

CREATE TABLE run_events (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    attempt_id uuid,
    step_id uuid,
    sequence bigint NOT NULL CHECK (sequence > 0),
    event_kind text NOT NULL CHECK (
        event_kind IN (
            'RUN_ACCEPTED',
            'RUN_QUEUED',
            'RUN_STARTED',
            'RUN_RETRY_WAIT',
            'RUN_RECOVERING',
            'RUN_CANCEL_REQUESTED',
            'RUN_FINISHED',
            'ATTEMPT_LEASED',
            'ATTEMPT_FINISHED',
            'STEP_STARTED',
            'STEP_FINISHED',
            'CREDIT_RESERVED',
            'CREDIT_SETTLED',
            'OUTBOX_ENQUEUED',
            'SSE_TASK'
        )
    ),
    sse_visible boolean NOT NULL DEFAULT false,
    payload_object_ref text,
    payload_sha256 text CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
    payload_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_events_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT run_events_workspace_run_sequence_key
        UNIQUE (workspace_id, run_id, sequence),
    CONSTRAINT run_events_run_fk
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_events_attempt_fk
        FOREIGN KEY (workspace_id, run_id, attempt_id)
        REFERENCES run_attempts(workspace_id, run_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_events_step_fk
        FOREIGN KEY (workspace_id, run_id, step_id)
        REFERENCES run_steps(workspace_id, run_id, id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE run_events IS
    '只追加的运行事件流；(run_id, sequence) 是 SSE replay 的稳定顺序。BEFORE INSERT trigger 在锁定 Run 后分配 sequence，调用者不得传入它；runs.last_event_sequence 是 retention 后仍存在的权威游标。SSE projector 必须从同一 workspace 的 runs 关联读取 accepted_request_id，而不是把每次 HTTP request_id 复制进事件。应用角色不能 update/delete；受控 retention 仅可在终态后至少 7 天删除。';
COMMENT ON COLUMN run_events.payload_redacted IS
    'SSE/审计可见的脱敏载荷；原始 token、输入或输出内容需用 payload_object_ref 的受控对象引用。';

-- One Run row is the sequencing lock. Every append allocates the next cursor
-- in the same transaction, so retention cannot make a later event reuse an old
-- value. Writers omit sequence; accepting caller-supplied cursors would make
-- the persisted Run snapshot and the event stream disagree under concurrency.
CREATE OR REPLACE FUNCTION app.assign_run_event_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_sequence bigint;
BEGIN
    IF NEW.sequence IS NOT NULL THEN
        RAISE EXCEPTION 'run event sequence is assigned by the database'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.runs
    SET last_event_sequence = last_event_sequence + 1,
        updated_at = clock_timestamp()
    WHERE workspace_id = NEW.workspace_id
      AND id = NEW.run_id
    RETURNING last_event_sequence INTO v_sequence;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot append an event for an unknown Run'
            USING ERRCODE = '23503';
    END IF;

    NEW.sequence := v_sequence;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER run_events_assign_sequence
BEFORE INSERT ON run_events
FOR EACH ROW
EXECUTE FUNCTION app.assign_run_event_sequence();

ALTER FUNCTION app.assign_run_event_sequence() OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.assign_run_event_sequence() FROM PUBLIC;

-- ba_runtime cannot insert directly into run_events. This narrow entry point
-- admits only non-authoritative progress events; cancel, terminal, credit and
-- outbox facts stay exclusive to their reviewed billing/finalizer paths.
CREATE OR REPLACE FUNCTION app.append_runtime_run_event(
    p_event_id uuid,
    p_workspace_id uuid,
    p_run_id uuid,
    p_attempt_id uuid,
    p_lease_token uuid,
    p_lease_fencing_token bigint,
    p_step_id uuid,
    p_event_kind text,
    p_sse_visible boolean,
    p_payload_object_ref text,
    p_payload_sha256 text,
    p_payload_redacted jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_sequence bigint;
BEGIN
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id()
       OR p_event_id IS NULL
       OR p_run_id IS NULL
       OR p_attempt_id IS NULL
       OR p_lease_token IS NULL
       OR p_lease_fencing_token IS NULL
       OR p_event_kind IS NULL
       OR p_event_kind NOT IN (
           'RUN_STARTED', 'ATTEMPT_FINISHED',
           'STEP_STARTED', 'STEP_FINISHED', 'SSE_TASK'
       ) THEN
        RAISE EXCEPTION 'runtime event is outside the permitted append contract'
            USING ERRCODE = '42501';
    END IF;

    -- Admission, lease claim/recovery and terminal events use separate reviewed
    -- functions. This executor-only path proves that the caller still owns the
    -- exact active attempt; an expired worker cannot append facts after fencing.
    PERFORM 1
    FROM public.run_attempts AS attempt
    WHERE attempt.workspace_id = p_workspace_id
      AND attempt.run_id = p_run_id
      AND attempt.id = p_attempt_id
      AND attempt.lease_token = p_lease_token
      AND attempt.lease_fencing_token = p_lease_fencing_token
      AND attempt.status IN ('LEASED', 'EXECUTING')
      AND attempt.lease_expires_at > clock_timestamp()
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'runtime event attempt lease is missing, expired or fenced'
            USING ERRCODE = '42501';
    END IF;

    IF p_event_kind IN ('STEP_STARTED', 'STEP_FINISHED') THEN
        IF p_step_id IS NULL THEN
            RAISE EXCEPTION 'step event requires a step identity'
                USING ERRCODE = '22023';
        END IF;
        PERFORM 1
        FROM public.run_steps AS step
        WHERE step.workspace_id = p_workspace_id
          AND step.run_id = p_run_id
          AND step.id = p_step_id
          AND step.last_attempt_id = p_attempt_id
        FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'step event is not bound to the active attempt'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO public.run_events (
        id, workspace_id, run_id, attempt_id, step_id, event_kind,
        sse_visible, payload_object_ref, payload_sha256, payload_redacted
    ) VALUES (
        p_event_id, p_workspace_id, p_run_id, p_attempt_id, p_step_id,
        p_event_kind, COALESCE(p_sse_visible, false), p_payload_object_ref,
        p_payload_sha256, COALESCE(p_payload_redacted, '{}'::jsonb)
    )
    RETURNING sequence INTO v_sequence;

    RETURN v_sequence;
END;
$function$;

ALTER FUNCTION app.append_runtime_run_event(
    uuid, uuid, uuid, uuid, uuid, bigint, uuid, text, boolean, text, text, jsonb
) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.append_runtime_run_event(
    uuid, uuid, uuid, uuid, uuid, bigint, uuid, text, boolean, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.append_runtime_run_event(
    uuid, uuid, uuid, uuid, uuid, bigint, uuid, text, boolean, text, text, jsonb
) TO ba_runtime;

-- A terminal Run is only valid when its durable cursor/tombstone names the one
-- terminal event. The constraint is deferred so app.finalize_run can append
-- first and write the terminal snapshot in the same outer transaction. Later
-- technical retention may delete that event row; the immutable tombstone stays
-- on runs and is not a foreign key to purgeable material.
CREATE OR REPLACE FUNCTION app.assert_terminal_run_event_is_last()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.last_event_sequence IS NOT DISTINCT FROM OLD.last_event_sequence THEN
        RETURN NULL;
    END IF;

    IF NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
       AND NOT EXISTS (
           SELECT 1
           FROM public.run_events
           WHERE workspace_id = NEW.workspace_id
             AND run_id = NEW.id
             AND id = NEW.terminal_event_id
             AND sequence = NEW.last_event_sequence
             AND sequence = NEW.terminal_event_sequence
             AND event_kind = 'RUN_FINISHED'
       ) THEN
        RAISE EXCEPTION 'terminal Run cursor must reference its RUN_FINISHED event'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER runs_terminal_event_cursor_guard
AFTER INSERT OR UPDATE ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION app.assert_terminal_run_event_is_last();

ALTER FUNCTION app.assert_terminal_run_event_is_last() OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.assert_terminal_run_event_is_last() FROM PUBLIC;

CREATE FUNCTION app.prevent_run_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_user = 'ba_retention' THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'run_events are append-only; only ba_retention may delete an eligible terminal run event'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER run_events_prevent_mutation
BEFORE UPDATE OR DELETE ON run_events
FOR EACH ROW
EXECUTE FUNCTION app.prevent_run_event_mutation();

-- The unique index is the final race guard. app.request_run_cancellation()
-- also locks runs before appending, so it never intentionally relies on a
-- unique-violation control path.
CREATE UNIQUE INDEX run_events_one_cancel_requested_per_run_idx
    ON run_events (workspace_id, run_id)
    WHERE event_kind = 'RUN_CANCEL_REQUESTED';

CREATE UNIQUE INDEX run_events_one_terminal_per_run_idx
    ON run_events (workspace_id, run_id)
    WHERE event_kind = 'RUN_FINISHED';

-- Creation-idempotency lives on runs because it owns Run acceptance. Mutating an
-- existing Run (currently cancellation) has a separate durable record, so a
-- cancellation key cannot be mistaken for a creation key or replayed against a
-- different Run. response_body_redacted is the first safe API projection; the
-- transport request_id is intentionally not stored because each replay gets a
-- new one.
CREATE TABLE run_mutation_idempotencies (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    principal_id text NOT NULL CHECK (char_length(principal_id) BETWEEN 1 AND 255),
    route text NOT NULL CHECK (route IN (
        '/v1/oapi/runs/{run_id}/cancel',
        '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'
    )),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
    intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
    target_run_id uuid NOT NULL,
    -- HumanGate is introduced by the Agent runtime migration; that migration
    -- must add the same-workspace composite FK before enabling resume writes.
    target_gate_id uuid,
    response_status smallint NOT NULL CHECK (response_status IN (200, 202)),
    response_run_status text NOT NULL CHECK (
        response_run_status IN (
            'QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED',
            'CANCELLED', 'TIMED_OUT'
        )
    ),
    response_body_redacted jsonb NOT NULL,
    response_event_sequence bigint,
    idempotency_expires_at timestamptz NOT NULL,
    idempotency_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_mutation_idempotencies_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT run_mutation_idempotencies_target_run_fkey
        FOREIGN KEY (workspace_id, target_run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_mutation_idempotencies_target_shape CHECK (
        (route = '/v1/oapi/runs/{run_id}/cancel' AND target_gate_id IS NULL)
        OR (
            route = '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'
            AND target_gate_id IS NOT NULL
        )
    ),
    CONSTRAINT run_mutation_idempotencies_response_shape CHECK (
        (response_status = 202 AND response_event_sequence IS NOT NULL)
        OR response_status = 200
    ),
    CONSTRAINT run_mutation_idempotencies_expiry_after_create CHECK (
        idempotency_expires_at >= created_at + interval '24 hours'
    )
);

COMMENT ON TABLE run_mutation_idempotencies IS
    'Durable idempotency record for cancel/resume. Active uniqueness is workspace/principal/fixed-route/key; target Run/Gate is part of the JCS intent, never the unique scope. A record remains active through the owning Run lifecycle (including long WAITING) and for at least 24 hours after terminal completion.';

CREATE OR REPLACE FUNCTION app.prevent_run_mutation_idempotency_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_target_status text;
    v_target_finished_at timestamptz;
    v_required_until timestamptz;
BEGIN
    SELECT status, finished_at
      INTO v_target_status, v_target_finished_at
      FROM public.runs
     WHERE workspace_id = OLD.workspace_id
       AND id = OLD.target_run_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'mutation idempotency target Run is missing'
            USING ERRCODE = 'P0002';
    END IF;
    v_required_until := GREATEST(
        OLD.idempotency_expires_at,
        COALESCE(v_target_finished_at + interval '24 hours', OLD.idempotency_expires_at)
    );

    IF TG_OP = 'DELETE' THEN
        IF current_user = 'ba_retention'
           AND NOT OLD.idempotency_active
           AND v_target_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
           AND v_target_finished_at IS NOT NULL
           AND clock_timestamp() >= v_required_until THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'mutation idempotency record cannot be deleted before controlled terminal expiry'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
       AND NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
       AND NEW.route IS NOT DISTINCT FROM OLD.route
       AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
       AND NEW.intent_hash IS NOT DISTINCT FROM OLD.intent_hash
       AND NEW.target_run_id IS NOT DISTINCT FROM OLD.target_run_id
       AND NEW.target_gate_id IS NOT DISTINCT FROM OLD.target_gate_id
       AND NEW.response_status IS NOT DISTINCT FROM OLD.response_status
       AND NEW.response_run_status IS NOT DISTINCT FROM OLD.response_run_status
       AND NEW.response_body_redacted IS NOT DISTINCT FROM OLD.response_body_redacted
       AND NEW.response_event_sequence IS NOT DISTINCT FROM OLD.response_event_sequence
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
       AND current_user = 'ba_retention'
       AND NEW.idempotency_expires_at >= OLD.idempotency_expires_at THEN
        v_required_until := GREATEST(
            NEW.idempotency_expires_at,
            COALESCE(v_target_finished_at + interval '24 hours', NEW.idempotency_expires_at)
        );
        IF NEW.idempotency_active IS DISTINCT FROM OLD.idempotency_active THEN
            IF NOT (
                OLD.idempotency_active
                AND NOT NEW.idempotency_active
                AND v_target_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
                AND v_target_finished_at IS NOT NULL
                AND clock_timestamp() >= v_required_until
            ) THEN
                RAISE EXCEPTION 'mutation idempotency may deactivate only after target terminal replay grace'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
        NEW.idempotency_expires_at := v_required_until;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'run mutation idempotency records are immutable until controlled expiry'
        USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER run_mutation_idempotencies_prevent_rewrite
BEFORE UPDATE OR DELETE ON run_mutation_idempotencies
FOR EACH ROW
EXECUTE FUNCTION app.prevent_run_mutation_idempotency_rewrite();

CREATE OR REPLACE FUNCTION app.expire_run_mutation_idempotency(
    p_workspace_id uuid,
    p_mutation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_target_run_id uuid;
    v_expires_at timestamptz;
    v_active boolean;
    v_target_status text;
    v_target_finished_at timestamptz;
    v_required_until timestamptz;
BEGIN
    SELECT target_run_id, idempotency_expires_at, idempotency_active
      INTO v_target_run_id, v_expires_at, v_active
      FROM public.run_mutation_idempotencies
     WHERE workspace_id = p_workspace_id
       AND id = p_mutation_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'mutation idempotency record not found for expiry'
            USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_active THEN
        RETURN false;
    END IF;

    SELECT status, finished_at
      INTO v_target_status, v_target_finished_at
      FROM public.runs
     WHERE workspace_id = p_workspace_id
       AND id = v_target_run_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'mutation idempotency target Run not found for expiry'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_target_status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
       OR v_target_finished_at IS NULL THEN
        RAISE EXCEPTION 'mutation idempotency remains active while target Run is nonterminal'
            USING ERRCODE = '55000';
    END IF;

    v_required_until := GREATEST(
        v_expires_at,
        v_target_finished_at + interval '24 hours'
    );
    IF clock_timestamp() < v_required_until THEN
        IF v_expires_at < v_required_until THEN
            UPDATE public.run_mutation_idempotencies
               SET idempotency_expires_at = v_required_until
             WHERE workspace_id = p_workspace_id
               AND id = p_mutation_id;
        END IF;
        RETURN false;
    END IF;

    UPDATE public.run_mutation_idempotencies
       SET idempotency_expires_at = v_required_until,
           idempotency_active = false
     WHERE workspace_id = p_workspace_id
       AND id = p_mutation_id;
    RETURN true;
END;
$function$;

ALTER FUNCTION app.expire_run_mutation_idempotency(uuid, uuid)
    OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.expire_run_mutation_idempotency(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_run_mutation_idempotency(uuid, uuid)
    TO ba_retention_executor;

-- Cancellation uses a concrete, local v1 Run-read gate rather than a future
-- application hook. Its principal is derived from the signed runtime context,
-- and an unreadable/missing/mismatched Run always maps to P0002 so an
-- idempotency hit cannot become an existence oracle. Future delegate grants
-- may extend this one function only after they carry the same verified identity.
CREATE OR REPLACE FUNCTION app.assert_current_principal_can_read_run(
    p_workspace_id uuid,
    p_run_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_principal_id text;
BEGIN
    v_principal_id := app.current_authenticated_principal_id();
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id()
       OR v_principal_id IS NULL THEN
        RAISE EXCEPTION 'run not found in authenticated principal scope'
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM 1
    FROM public.runs
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id
      AND principal_id = v_principal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'run not found in authenticated principal scope'
            USING ERRCODE = 'P0002';
    END IF;
END;
$function$;

ALTER FUNCTION app.assert_current_principal_can_read_run(uuid, uuid)
    OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.assert_current_principal_can_read_run(uuid, uuid) FROM PUBLIC;

-- The cancel endpoint has a closed, scalar-only RFC 8785/JCS shape. Building
-- that exact UTF-8 byte sequence in trusted SQL avoids accepting a caller's
-- opaque hash and avoids pretending jsonb::text is a general JCS encoder. A
-- route/body/schema change MUST introduce a new versioned function and fixture;
-- arbitrary JSON inputs are deliberately unsupported here.
CREATE OR REPLACE FUNCTION app.cancel_intent_hash_v1(p_run_id uuid)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
BEGIN
    IF p_run_id IS NULL THEN
        RAISE EXCEPTION 'cancel intent requires a canonical run UUID'
            USING ERRCODE = '22023';
    END IF;
    RETURN encode(
        public.digest(
            convert_to(
                format(
                    '{"intent_schema":"intent/1","request":{"body":{},"run_id":"%s"},"route":"/v1/oapi/runs/{run_id}/cancel"}',
                    p_run_id::text
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
END;
$function$;

ALTER FUNCTION app.cancel_intent_hash_v1(uuid) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.cancel_intent_hash_v1(uuid) FROM PUBLIC;

-- Every writer locks both the authenticated key scope and the Run row before
-- allocating a sequence.
CREATE OR REPLACE FUNCTION app.request_run_cancellation(
    p_workspace_id uuid,
    p_run_id uuid,
    p_idempotency_key text,
    p_mutation_id uuid,
    p_event_id uuid,
    p_requested_at timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
    response_status smallint,
    run_status text,
    -- API-facing sequences are decimal strings; the durable table column stays
    -- bigint for ordering and constraints.
    event_sequence text,
    response_body_redacted jsonb,
    idempotent_replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
    v_status text;
    v_principal_id text;
    v_terminal_billing_pending boolean;
    v_terminal_result_redacted jsonb;
    v_terminal_error_redacted jsonb;
    v_billing_state text;
    v_billing_settled_at timestamptz;
    v_accepted_request_id uuid;
    v_sequence bigint;
    v_existing_id uuid;
    v_existing_intent_hash text;
    v_existing_target_run_id uuid;
    v_existing_response_status smallint;
    v_existing_response_run_status text;
    v_existing_response_sequence bigint;
    v_existing_response_body jsonb;
    v_existing_expires_at timestamptz;
    v_intent_hash text;
    v_response_status smallint;
    v_response_body jsonb;
BEGIN
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id() THEN
        RAISE EXCEPTION 'workspace context does not authorize cancellation'
            USING ERRCODE = '42501';
    END IF;
    v_principal_id := app.current_authenticated_principal_id();
    IF v_principal_id IS NULL THEN
        RAISE EXCEPTION 'verified runtime principal is required for cancellation'
            USING ERRCODE = '42501';
    END IF;
    IF p_event_id IS NULL THEN
        RAISE EXCEPTION 'cancellation event id is required'
            USING ERRCODE = '22004';
    END IF;

    -- Trusted canonicalization occurs before the idempotency lookup and uses
    -- only the fixed route/schema/body plus the typed UUID path parameter.
    v_intent_hash := app.cancel_intent_hash_v1(p_run_id);

    IF p_idempotency_key IS NOT NULL THEN
        IF char_length(p_idempotency_key) NOT BETWEEN 1 AND 128
           OR p_mutation_id IS NULL THEN
            RAISE EXCEPTION 'keyed cancellation requires valid key and mutation id'
                USING ERRCODE = '22023';
        END IF;

        -- This advisory lock is scoped to the logical uniqueness key rather
        -- than run_id. Two simultaneous uses of the same key against different
        -- Runs therefore resolve to one first response and one 409, never two
        -- cancellation events followed by a unique-index surprise.
        PERFORM pg_advisory_xact_lock(
            hashtextextended(
                p_workspace_id::text || E'\x1f' || v_principal_id || E'\x1f'
                || '/v1/oapi/runs/{run_id}/cancel' || E'\x1f' || p_idempotency_key,
                0
            )
        );

        SELECT mutation.id, mutation.intent_hash, mutation.target_run_id,
               mutation.response_status, mutation.response_run_status,
               mutation.response_event_sequence, mutation.response_body_redacted,
               mutation.idempotency_expires_at
        INTO v_existing_id, v_existing_intent_hash, v_existing_target_run_id,
             v_existing_response_status, v_existing_response_run_status, v_existing_response_sequence,
             v_existing_response_body, v_existing_expires_at
        FROM public.run_mutation_idempotencies AS mutation
        WHERE mutation.workspace_id = p_workspace_id
          AND mutation.principal_id = v_principal_id
          AND mutation.route = '/v1/oapi/runs/{run_id}/cancel'
          AND mutation.idempotency_key = p_idempotency_key
          AND mutation.idempotency_active
        FOR UPDATE;

        IF v_existing_id IS NOT NULL THEN
            PERFORM app.assert_current_principal_can_read_run(
                p_workspace_id, v_existing_target_run_id
            );
            IF v_existing_target_run_id IS DISTINCT FROM p_run_id
               OR v_existing_intent_hash IS DISTINCT FROM v_intent_hash THEN
                RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'
                    USING ERRCODE = 'P0001',
                          DETAIL = 'API maps this keyed-mutation conflict to HTTP 409';
            END IF;
            RETURN QUERY SELECT v_existing_response_status, v_existing_response_run_status,
                                v_existing_response_sequence::text,
                                v_existing_response_body, true;
            RETURN;
        END IF;
    END IF;

    PERFORM app.assert_current_principal_can_read_run(p_workspace_id, p_run_id);

    SELECT status, terminal_billing_pending, terminal_result_redacted,
           terminal_error_redacted, billing_state, billing_settled_at,
           accepted_request_id, last_event_sequence
    INTO v_status, v_terminal_billing_pending, v_terminal_result_redacted,
         v_terminal_error_redacted, v_billing_state, v_billing_settled_at,
         v_accepted_request_id, v_sequence
    FROM public.runs
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'run not found in authenticated workspace'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION') THEN
        IF v_status = 'NEEDS_ATTENTION' THEN
            v_status := 'FAILED';
        END IF;
        v_response_status := 200;
        v_response_body := jsonb_build_object(
            'run_id', p_run_id,
            'accepted_request_id', v_accepted_request_id,
            'status', v_status,
            'last_sequence', v_sequence::text,
            'billing_pending', v_terminal_billing_pending,
            'billing_state', v_billing_state
        )
        || CASE WHEN v_terminal_result_redacted IS NOT NULL
            THEN jsonb_build_object('result', v_terminal_result_redacted)
            ELSE '{}'::jsonb END
        || CASE WHEN v_terminal_error_redacted IS NOT NULL
            THEN jsonb_build_object('error', v_terminal_error_redacted)
            ELSE '{}'::jsonb END
        || CASE WHEN v_billing_settled_at IS NOT NULL
            THEN jsonb_build_object('billing_settled_at', v_billing_settled_at)
            ELSE '{}'::jsonb END;
    ELSE
        IF EXISTS (
            SELECT 1
            FROM public.run_parent_links AS link
            WHERE link.workspace_id = p_workspace_id
              AND (link.parent_run_id = p_run_id OR link.child_run_id = p_run_id)
        ) THEN
            RAISE EXCEPTION 'child/parent cancellation requires the sealed cascade-intent migration'
                USING ERRCODE = '0A000';
        END IF;

        SELECT sequence
        INTO v_sequence
        FROM public.run_events
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
          AND event_kind = 'RUN_CANCEL_REQUESTED';

        IF NOT FOUND THEN
            UPDATE public.runs
            SET status = 'CANCEL_REQUESTED',
                execution_status = 'CANCELLING',
                updated_at = clock_timestamp()
            WHERE workspace_id = p_workspace_id
              AND id = p_run_id;

            INSERT INTO public.run_events (
                id,
                workspace_id,
                run_id,
                event_kind,
                sse_visible,
                payload_redacted
            ) VALUES (
                p_event_id,
                p_workspace_id,
                p_run_id,
                'RUN_CANCEL_REQUESTED',
                true,
                jsonb_build_object('requested_at', p_requested_at, 'status', 'CANCEL_REQUESTED')
            )
            RETURNING sequence INTO v_sequence;
        END IF;

        v_status := 'CANCEL_REQUESTED';
        v_response_status := 202;
        v_response_body := jsonb_build_object(
            'run_id', p_run_id,
            'accepted_request_id', v_accepted_request_id,
            'status', v_status,
            'operation_url', '/v1/oapi/runs/' || p_run_id::text,
            'events_url', '/v1/oapi/runs/' || p_run_id::text || '/events',
            'cancel_url', '/v1/oapi/runs/' || p_run_id::text || '/cancel',
            'last_sequence', v_sequence::text
        );
    END IF;

    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.run_mutation_idempotencies (
            id, workspace_id, principal_id, route, idempotency_key, intent_hash,
            target_run_id, response_status, response_run_status, response_body_redacted,
            response_event_sequence, idempotency_expires_at, idempotency_active
        ) VALUES (
            p_mutation_id, p_workspace_id, v_principal_id,
            '/v1/oapi/runs/{run_id}/cancel', p_idempotency_key, v_intent_hash,
            p_run_id, v_response_status, v_status, v_response_body, v_sequence,
            clock_timestamp() + interval '24 hours', true
        );
    END IF;

    RETURN QUERY SELECT v_response_status, v_status, v_sequence::text, v_response_body, false;
END;
$$;

ALTER FUNCTION app.request_run_cancellation(uuid, uuid, text, uuid, uuid, timestamptz)
    OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.request_run_cancellation(uuid, uuid, text, uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_run_cancellation(uuid, uuid, text, uuid, uuid, timestamptz) TO ba_runtime;

CREATE TABLE run_checkpoints (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    checkpoint_number bigint NOT NULL CHECK (checkpoint_number > 0),
    last_event_sequence bigint NOT NULL CHECK (last_event_sequence > 0),
    lease_fencing_token bigint NOT NULL CHECK (lease_fencing_token > 0),

    -- checkpoint 状态本体放受控对象；数据库不记录变量中的 secret 原文。
    state_object_ref text NOT NULL,
    state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
    cursor_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_recoverable boolean NOT NULL DEFAULT true,
    invalidated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_checkpoints_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT run_checkpoints_workspace_run_number_key
        UNIQUE (workspace_id, run_id, checkpoint_number),
    CONSTRAINT run_checkpoints_workspace_run_hash_key
        UNIQUE (workspace_id, run_id, state_sha256),
    CONSTRAINT run_checkpoints_run_fk
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_checkpoints_attempt_fk
        FOREIGN KEY (workspace_id, run_id, attempt_id)
        REFERENCES run_attempts(workspace_id, run_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_checkpoints_attempt_fence_fk
        FOREIGN KEY (workspace_id, run_id, attempt_id, lease_fencing_token)
        REFERENCES run_attempts(workspace_id, run_id, id, lease_fencing_token)
        ON DELETE RESTRICT
);

COMMENT ON TABLE run_checkpoints IS
    '节点边界的可恢复快照；恢复器必须以匹配的 fencing token 验证该 checkpoint 属于当前/可恢复尝试。last_event_sequence 在写入时校验不超过 Run 权威 cursor，但不外键到可在 7 天后清理的 event 行；checkpoint 自身保留至少 30 天。';

CREATE OR REPLACE FUNCTION app.enforce_checkpoint_cursor_and_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_last_event_sequence bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_user = 'ba_retention' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'run checkpoints are immutable; only eligible retention may delete them'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'run checkpoints are immutable; append a new checkpoint'
            USING ERRCODE = '55000';
    END IF;

    SELECT last_event_sequence
      INTO v_last_event_sequence
      FROM public.runs
     WHERE workspace_id = NEW.workspace_id
       AND id = NEW.run_id
     FOR SHARE;
    IF NOT FOUND OR NEW.last_event_sequence > v_last_event_sequence THEN
        RAISE EXCEPTION 'checkpoint cursor is not present in the authoritative Run sequence'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER run_checkpoints_cursor_and_immutability
BEFORE INSERT OR UPDATE OR DELETE ON run_checkpoints
FOR EACH ROW
EXECUTE FUNCTION app.enforce_checkpoint_cursor_and_immutability();

ALTER FUNCTION app.enforce_checkpoint_cursor_and_immutability()
    OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.enforce_checkpoint_cursor_and_immutability() FROM PUBLIC;

CREATE TABLE outbox (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    message_type text NOT NULL CHECK (
        message_type IN (
            'RUN_DISPATCH',
            'SSE_WAKE',
            'WEBHOOK_DELIVERY',
            'ANALYTICS_PROJECTION'
        )
    ),
    dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),

    delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (
        delivery_status IN ('PENDING', 'LEASED', 'DELIVERED', 'DEAD')
    ),
    lease_owner text,
    lease_token uuid,
    lease_fencing_token bigint NOT NULL DEFAULT 0 CHECK (lease_fencing_token >= 0),
    lease_expires_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    last_error_code text,
    last_error_detail_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- 派发器只读取对象引用/脱敏元数据；不得将认证头或 secret 放进 outbox。
    payload_object_ref text NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    payload_metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT outbox_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT outbox_workspace_type_dedupe_key
        UNIQUE (workspace_id, message_type, dedupe_key),
    CONSTRAINT outbox_run_fk
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT outbox_active_lease_requires_fields CHECK (
        delivery_status <> 'LEASED'
        OR (
            lease_owner IS NOT NULL
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
        )
    )
);

COMMENT ON TABLE outbox IS
    '与运行状态同事务写入的可靠投递表。下游必须按 message_type + dedupe_key 至少一次、可重复投递处理。';

CREATE TABLE credit_reservations (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'HELD' CHECK (
        status IN ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED')
    ),
    reserved_credits bigint NOT NULL CHECK (reserved_credits > 0),
    settled_credits bigint NOT NULL DEFAULT 0 CHECK (settled_credits >= 0),
    released_credits bigint NOT NULL DEFAULT 0 CHECK (released_credits >= 0),
    balance_version bigint NOT NULL CHECK (balance_version >= 0),
    expires_at timestamptz NOT NULL,
    status_reason_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    released_at timestamptz,

    CONSTRAINT credit_reservations_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT credit_reservations_workspace_run_key UNIQUE (workspace_id, run_id),
    CONSTRAINT credit_reservations_workspace_run_id_key UNIQUE (workspace_id, run_id, id),
    CONSTRAINT credit_reservations_workspace_id_run_id_key UNIQUE (workspace_id, id, run_id),
    CONSTRAINT credit_reservations_run_fk
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT credit_reservations_totals_within_reserve CHECK (
        settled_credits + released_credits <= reserved_credits
    ),
    CONSTRAINT credit_reservations_terminal_timestamp CHECK (
        (status = 'HELD' AND settled_at IS NULL AND released_at IS NULL)
        OR (status = 'SETTLED' AND settled_at IS NOT NULL)
        OR (status IN ('RELEASED', 'EXPIRED') AND released_at IS NOT NULL)
    ),
    CONSTRAINT credit_reservations_status_totals_shape CHECK (
        (status = 'HELD' AND settled_credits + released_credits < reserved_credits)
        OR (
            status = 'SETTLED'
            AND settled_credits > 0
            AND settled_credits + released_credits = reserved_credits
        )
        OR (
            status IN ('RELEASED', 'EXPIRED')
            AND settled_credits = 0
            AND released_credits = reserved_credits
        )
    )
);

COMMENT ON TABLE credit_reservations IS
    '运行准入时的预算占用；预留、增量预留、实际结算与释放须在锁定 workspace 余额版本的事务中进行。';

CREATE TABLE credits_ledger (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid,
    -- run_id remains the root billing owner. producer_* binds the actual
    -- metered/finalized execution identity and its immutable fence.
    producer_run_id uuid,
    producer_attempt_id uuid,
    producer_lease_fencing_token bigint CHECK (
        producer_lease_fencing_token IS NULL OR producer_lease_fencing_token > 0
    ),
    step_id uuid,
    reservation_id uuid,
    entry_kind text NOT NULL CHECK (
        entry_kind IN (
            'RESERVE', 'SETTLE', 'RELEASE', 'RECONCILIATION', 'ADJUSTMENT', 'FREE'
        )
    ),
    -- The three deltas explain exactly how the transactional workspace balance
    -- projection moved. available + reserved decreases only at SETTLE.
    available_delta_credits bigint NOT NULL,
    reserved_delta_credits bigint NOT NULL,
    settled_delta_credits bigint NOT NULL,
    billing_intent_hash text NOT NULL CHECK (billing_intent_hash ~ '^[0-9a-f]{64}$'),
    charge_attribution_hash text NOT NULL CHECK (
        charge_attribution_hash ~ '^[0-9a-f]{64}$'
    ),
    charge_key text NOT NULL CHECK (char_length(charge_key) BETWEEN 1 AND 300),
    balance_version bigint NOT NULL CHECK (balance_version >= 0),
    metering_detail_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT credits_ledger_workspace_id_id_key UNIQUE (workspace_id, id),
    -- Agent child metering keeps this run_id as its billing owner and links the
    -- actual child Run/Step through the later agent_charge_attributions table.
    CONSTRAINT credits_ledger_workspace_id_id_run_id_key UNIQUE (workspace_id, id, run_id),
    CONSTRAINT credits_ledger_workspace_charge_key
        UNIQUE (workspace_id, charge_key),
    CONSTRAINT credits_ledger_run_fk
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT credits_ledger_producer_run_fk
        FOREIGN KEY (workspace_id, producer_run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT credits_ledger_producer_attempt_fkey
        FOREIGN KEY (
            workspace_id,
            producer_run_id,
            producer_attempt_id,
            producer_lease_fencing_token
        )
        REFERENCES run_attempts(workspace_id, run_id, id, lease_fencing_token)
        ON DELETE RESTRICT,
    CONSTRAINT credits_ledger_step_fk
        FOREIGN KEY (workspace_id, producer_run_id, step_id)
        REFERENCES run_steps(workspace_id, run_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT credits_ledger_reservation_fk
        FOREIGN KEY (workspace_id, run_id, reservation_id)
        REFERENCES credit_reservations(workspace_id, run_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT credits_ledger_step_requires_run CHECK (
        step_id IS NULL OR producer_run_id IS NOT NULL
    ),
    CONSTRAINT credits_ledger_reservation_requires_run CHECK (
        reservation_id IS NULL OR run_id IS NOT NULL
    ),
    CONSTRAINT credits_ledger_reservation_entry_requires_reservation CHECK (
        entry_kind NOT IN ('RESERVE', 'SETTLE', 'RELEASE')
        OR reservation_id IS NOT NULL
    ),
    CONSTRAINT credits_ledger_execution_attribution_shape CHECK (
        (
            entry_kind = 'RESERVE'
            AND producer_run_id = run_id
            AND producer_attempt_id IS NULL
            AND producer_lease_fencing_token IS NULL
        )
        OR (
            entry_kind IN ('SETTLE', 'RELEASE')
            AND producer_run_id IS NOT NULL
            AND producer_attempt_id IS NOT NULL
            AND producer_lease_fencing_token IS NOT NULL
        )
        OR (
            entry_kind = 'RECONCILIATION'
            AND producer_run_id = run_id
            AND producer_attempt_id IS NULL
            AND producer_lease_fencing_token IS NULL
            AND step_id IS NULL
        )
        OR entry_kind IN ('ADJUSTMENT', 'FREE')
    ),
    CONSTRAINT credits_ledger_delta_shape CHECK (
        (
            entry_kind = 'RESERVE'
            AND available_delta_credits < 0
            AND reserved_delta_credits = -available_delta_credits
            AND settled_delta_credits = 0
        )
        OR (
            entry_kind = 'SETTLE'
            AND available_delta_credits = 0
            AND reserved_delta_credits < 0
            AND settled_delta_credits = -reserved_delta_credits
        )
        OR (
            entry_kind = 'RELEASE'
            AND available_delta_credits > 0
            AND reserved_delta_credits = -available_delta_credits
            AND settled_delta_credits = 0
        )
        OR (
            entry_kind = 'RECONCILIATION'
            AND available_delta_credits >= 0
            AND reserved_delta_credits <= 0
            AND settled_delta_credits >= 0
            AND available_delta_credits + settled_delta_credits
                = -reserved_delta_credits
        )
        OR (
            entry_kind = 'ADJUSTMENT'
            AND reserved_delta_credits = 0
            AND settled_delta_credits = 0
            AND available_delta_credits <> 0
        )
        OR (
            entry_kind = 'FREE'
            AND available_delta_credits = 0
            AND reserved_delta_credits = 0
            AND settled_delta_credits = 0
        )
    )
);

COMMENT ON TABLE credits_ledger IS
    '不可变积分事实账本。workspaces.credits_balance / credits_reserved_balance 是同一事务写入的可用与已预留投影，不能由日志或分析系统反推。Agent child 计量时 run_id 始终是 billing owner；实际 child Run/Call/Step 由后续 agent_charge_attributions 的复合 FK 归因。';
COMMENT ON COLUMN credits_ledger.metering_detail_redacted IS
    '仅记录可审计的脱敏计量维度；不得记录供应商 API key、提示词 secret 或原始认证材料。';
COMMENT ON COLUMN credits_ledger.billing_intent_hash IS
    '固定字段 canonical billing intent 的 SHA-256；相同 charge_key 只有同 intent 才可重放，金额、step、expiry 或计量语义变化必须冲突。';
COMMENT ON COLUMN credits_ledger.charge_attribution_hash IS
    'RESERVE 时绑定 accepted Plan；SETTLE/RELEASE 时绑定 producer Run/Attempt/fence、Step/usage 或 finalizer/expiry attribution 的 canonical SHA-256。它不是调用方可替换的自由标签。';

CREATE FUNCTION app.prevent_credits_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'credits_ledger is append-only and cannot be updated or deleted by technical retention'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER credits_ledger_prevent_mutation
BEFORE UPDATE OR DELETE ON credits_ledger
FOR EACH ROW
EXECUTE FUNCTION app.prevent_credits_ledger_mutation();

-- A NEEDS_ATTENTION Run remains terminal forever. Manual/operator resolution is
-- an append-only billing correction with durable evidence; it advances only the
-- current billing projection. One route-level idempotency key maps to one intent,
-- and one Run has exactly one authoritative reconciliation outcome in this G1
-- join-only baseline.
CREATE TABLE run_billing_reconciliations (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    idempotency_key text NOT NULL CHECK (
        char_length(idempotency_key) BETWEEN 1 AND 128
    ),
    intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
    evidence_ref text NOT NULL CHECK (
        char_length(evidence_ref) BETWEEN 1 AND 1024
        AND position('?' IN evidence_ref) = 0
        AND position('#' IN evidence_ref) = 0
        AND evidence_ref !~ '[[:cntrl:]]'
    ),
    evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    ledger_id uuid NOT NULL,
    reservation_id uuid,
    settled_credits bigint NOT NULL CHECK (settled_credits >= 0),
    released_credits bigint NOT NULL CHECK (released_credits >= 0),
    resolved_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_billing_reconciliations_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT run_billing_reconciliations_workspace_idempotency_key
        UNIQUE (workspace_id, idempotency_key),
    CONSTRAINT run_billing_reconciliations_workspace_run_key
        UNIQUE (workspace_id, run_id),
    CONSTRAINT run_billing_reconciliations_run_fkey
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT run_billing_reconciliations_ledger_fkey
        FOREIGN KEY (workspace_id, ledger_id, run_id)
        REFERENCES credits_ledger(workspace_id, id, run_id)
        ON DELETE RESTRICT,
    CONSTRAINT run_billing_reconciliations_reservation_fkey
        FOREIGN KEY (workspace_id, run_id, reservation_id)
        REFERENCES credit_reservations(workspace_id, run_id, id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE run_billing_reconciliations IS
    'Immutable evidence-backed resolution of a terminal NEEDS_ATTENTION billing hold. It never rewrites Run status, termination reason, terminal result/error, or terminal event tombstone.';

CREATE OR REPLACE FUNCTION app.prevent_run_billing_reconciliation_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION 'billing reconciliation evidence is append-only'
        USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER run_billing_reconciliations_prevent_rewrite
BEFORE UPDATE OR DELETE ON run_billing_reconciliations
FOR EACH ROW
EXECUTE FUNCTION app.prevent_run_billing_reconciliation_rewrite();

ALTER FUNCTION app.prevent_run_billing_reconciliation_rewrite()
    OWNER TO ba_reconciliation_owner;
REVOKE ALL ON FUNCTION app.prevent_run_billing_reconciliation_rewrite() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.reconcile_needs_attention_billing(
    p_workspace_id uuid,
    p_run_id uuid,
    p_reconciliation_id uuid,
    p_ledger_id uuid,
    p_outbox_id uuid,
    p_idempotency_key text,
    p_evidence_ref text,
    p_evidence_sha256 text,
    p_settled_credits bigint,
    p_resolved_at timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
    billing_state text,
    billing_settled_at timestamptz,
    applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_intent_hash text;
    v_existing_run_id uuid;
    v_existing_intent_hash text;
    v_existing_resolved_at timestamptz;
    v_run_status text;
    v_run_billing_state text;
    v_available bigint;
    v_reserved_balance bigint;
    v_balance_version bigint;
    v_reservation_id uuid;
    v_reservation_status text;
    v_reserved_credits bigint;
    v_already_settled bigint;
    v_already_released bigint;
    v_remaining bigint := 0;
    v_release_credits bigint := 0;
    v_payload jsonb;
BEGIN
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id()
       OR p_run_id IS NULL OR p_reconciliation_id IS NULL
       OR p_ledger_id IS NULL OR p_outbox_id IS NULL
       OR p_idempotency_key IS NULL
       OR char_length(p_idempotency_key) NOT BETWEEN 1 AND 128
       OR p_evidence_ref IS NULL OR char_length(p_evidence_ref) NOT BETWEEN 1 AND 1024
       OR position('?' IN p_evidence_ref) <> 0
       OR position('#' IN p_evidence_ref) <> 0
       OR p_evidence_ref ~ '[[:cntrl:]]'
       OR p_evidence_sha256 IS NULL
       OR p_evidence_sha256 !~ '^[0-9a-f]{64}$'
       OR p_settled_credits IS NULL OR p_settled_credits < 0
       OR p_resolved_at IS NULL
       OR p_resolved_at > clock_timestamp() + interval '5 minutes' THEN
        RAISE EXCEPTION 'invalid or unauthorized billing reconciliation input'
            USING ERRCODE = '42501';
    END IF;

    v_intent_hash := encode(public.digest(convert_to(
        format(
            '%s%s%s%s%s%s%s',
            p_run_id, chr(31), p_evidence_ref, chr(31),
            p_evidence_sha256, chr(31), p_settled_credits
        ),
        'UTF8'
    ), 'sha256'), 'hex');

    PERFORM pg_advisory_xact_lock(hashtextextended(
        p_workspace_id::text || chr(31) || 'billing-reconciliation' || chr(31)
        || p_idempotency_key,
        0
    ));

    -- Preserve the global billing lock order: workspace -> Run -> reservation.
    SELECT credits_balance, credits_reserved_balance, credits_balance_version
      INTO v_available, v_reserved_balance, v_balance_version
      FROM public.workspaces
     WHERE id = p_workspace_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace not found for billing reconciliation'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT run_id, intent_hash, resolved_at
      INTO v_existing_run_id, v_existing_intent_hash, v_existing_resolved_at
      FROM public.run_billing_reconciliations
     WHERE workspace_id = p_workspace_id
       AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing_run_id IS DISTINCT FROM p_run_id
           OR v_existing_intent_hash IS DISTINCT FROM v_intent_hash THEN
            RAISE EXCEPTION 'billing reconciliation idempotency key was reused with different intent'
                USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT 'SETTLED'::text, v_existing_resolved_at, false;
        RETURN;
    END IF;

    SELECT run.status, run.billing_state
      INTO v_run_status, v_run_billing_state
      FROM public.runs AS run
     WHERE run.workspace_id = p_workspace_id
       AND run.id = p_run_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Run not found for billing reconciliation'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_run_status <> 'NEEDS_ATTENTION'
       OR v_run_billing_state <> 'NEEDS_ATTENTION' THEN
        RAISE EXCEPTION 'only a terminal NEEDS_ATTENTION billing hold may be reconciled'
            USING ERRCODE = '55000';
    END IF;

    SELECT id, status, reserved_credits, settled_credits, released_credits
      INTO v_reservation_id, v_reservation_status, v_reserved_credits,
           v_already_settled, v_already_released
      FROM public.credit_reservations
     WHERE workspace_id = p_workspace_id
       AND run_id = p_run_id
     FOR UPDATE;
    IF FOUND THEN
        v_remaining := v_reserved_credits - v_already_settled - v_already_released;
        IF v_remaining < 0
           OR (v_remaining > 0 AND v_reservation_status <> 'HELD')
           OR p_settled_credits > v_remaining THEN
            RAISE EXCEPTION 'reconciliation amount is incompatible with reservation state'
                USING ERRCODE = '23514';
        END IF;
    ELSIF p_settled_credits <> 0 THEN
        RAISE EXCEPTION 'cannot settle credits without a Run reservation'
            USING ERRCODE = '23514';
    END IF;
    v_release_credits := v_remaining - p_settled_credits;

    IF v_remaining > 0 THEN
        IF v_reserved_balance < v_remaining THEN
            RAISE EXCEPTION 'workspace reserved balance is below reconciliation remainder'
                USING ERRCODE = '23514';
        END IF;
        UPDATE public.workspaces
           SET credits_balance = credits_balance + v_release_credits,
               credits_reserved_balance = credits_reserved_balance - v_remaining,
               credits_balance_version = credits_balance_version + 1,
               updated_at = clock_timestamp()
         WHERE id = p_workspace_id
         RETURNING credits_balance_version INTO v_balance_version;

        UPDATE public.credit_reservations
           SET settled_credits = settled_credits + p_settled_credits,
               released_credits = released_credits + v_release_credits,
               balance_version = v_balance_version,
               status = CASE
                   WHEN settled_credits + p_settled_credits > 0 THEN 'SETTLED'
                   ELSE 'RELEASED'
               END,
               settled_at = CASE
                   WHEN settled_credits + p_settled_credits > 0
                       THEN COALESCE(settled_at, p_resolved_at)
                   ELSE NULL
               END,
               released_at = CASE
                   WHEN released_credits + v_release_credits > 0
                       THEN COALESCE(released_at, p_resolved_at)
                   ELSE released_at
               END,
               status_reason_code = 'MANUAL_RECONCILIATION',
               updated_at = clock_timestamp()
         WHERE workspace_id = p_workspace_id
           AND id = v_reservation_id;
    END IF;

    INSERT INTO public.credits_ledger (
        id, workspace_id, run_id, producer_run_id, reservation_id,
        entry_kind, available_delta_credits, reserved_delta_credits,
        settled_delta_credits, billing_intent_hash, charge_attribution_hash,
        charge_key, balance_version, metering_detail_redacted
    ) VALUES (
        p_ledger_id, p_workspace_id, p_run_id, p_run_id, v_reservation_id,
        'RECONCILIATION', v_release_credits, -v_remaining,
        p_settled_credits, v_intent_hash, p_evidence_sha256,
        'billing-reconciliation/' || p_run_id::text || '/'
            || encode(public.digest(convert_to(p_idempotency_key, 'UTF8'), 'sha256'), 'hex'),
        v_balance_version,
        jsonb_build_object(
            'evidence_sha256', p_evidence_sha256,
            'settled_credits', p_settled_credits,
            'released_credits', v_release_credits
        )
    );

    INSERT INTO public.run_billing_reconciliations (
        id, workspace_id, run_id, idempotency_key, intent_hash,
        evidence_ref, evidence_sha256, ledger_id, reservation_id,
        settled_credits, released_credits, resolved_at
    ) VALUES (
        p_reconciliation_id, p_workspace_id, p_run_id, p_idempotency_key,
        v_intent_hash, p_evidence_ref, p_evidence_sha256, p_ledger_id,
        v_reservation_id, p_settled_credits, v_release_credits, p_resolved_at
    );

    UPDATE public.runs
       SET billing_state = 'SETTLED',
           billing_settled_at = p_resolved_at,
           updated_at = clock_timestamp()
     WHERE workspace_id = p_workspace_id
       AND id = p_run_id;

    v_payload := jsonb_build_object(
        'run_id', p_run_id,
        'billing_state', 'SETTLED',
        'billing_settled_at', p_resolved_at,
        'reconciliation_id', p_reconciliation_id,
        'evidence_sha256', p_evidence_sha256
    );
    INSERT INTO public.outbox (
        id, workspace_id, run_id, message_type, dedupe_key,
        payload_object_ref, payload_sha256, payload_metadata_redacted
    ) VALUES (
        p_outbox_id, p_workspace_id, p_run_id, 'SSE_WAKE',
        'run-billing-reconciled/' || p_run_id::text,
        'db://run-billing-reconciliations/' || p_reconciliation_id::text,
        encode(public.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex'),
        v_payload
    );

    RETURN QUERY SELECT 'SETTLED'::text, p_resolved_at, true;
END;
$function$;

ALTER FUNCTION app.reconcile_needs_attention_billing(
    uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, timestamptz
) OWNER TO ba_reconciliation_owner;
REVOKE ALL ON FUNCTION app.reconcile_needs_attention_billing(
    uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, timestamptz
) FROM PUBLIC, ba_runtime, ba_control_executor, ba_admission_executor,
       ba_metering_executor, ba_finalizer_executor;
GRANT EXECUTE ON FUNCTION app.reconcile_needs_attention_billing(
    uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, timestamptz
) TO ba_reconciliation_executor;

-- Billing functions are the only writers of workspace balances, reservations
-- and ledger rows. They do not COMMIT: the caller must keep the function call,
-- Run acceptance/terminal state, durable event and outbox row in one outer SQL
-- transaction. The global order is workspace -> root billing-owner Run ->
-- remaining participating Runs in ascending UUID order -> reservation/allocation
-- -> ledger lookup, so reserve/settle/release and child allocation do not form
-- opposite lock cycles under one tenant.
CREATE OR REPLACE FUNCTION app.reserve_credits(
    p_workspace_id uuid,
    p_run_id uuid,
    p_accepted_plan_hash text,
    p_reservation_id uuid,
    p_ledger_id uuid,
    p_charge_key text,
    p_credits bigint,
    p_expires_at timestamptz
)
RETURNS TABLE (
    reservation_id uuid,
    balance_version bigint,
    applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
    v_available bigint;
    v_reserved_balance bigint;
    v_existing_reservation_id uuid;
    v_existing_reserved_credits bigint;
    v_existing_balance_version bigint;
    v_existing_billing_intent_hash text;
    v_new_balance_version bigint;
    v_run_kind text;
    v_billing_owner_run_id uuid;
    v_accepted_plan_hash text;
    v_run_status text;
    v_run_execution_status text;
    v_billing_intent_hash text;
BEGIN
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id() THEN
        RAISE EXCEPTION 'workspace context does not authorize reserve'
            USING ERRCODE = '42501';
    END IF;

    IF p_reservation_id IS NULL OR p_ledger_id IS NULL OR p_credits <= 0
       OR p_charge_key IS NULL OR char_length(p_charge_key) NOT BETWEEN 1 AND 300
       OR p_accepted_plan_hash IS NULL
       OR p_accepted_plan_hash !~ '^[0-9a-f]{64}$'
       OR p_expires_at IS NULL OR p_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'invalid credit reservation arguments'
            USING ERRCODE = '22023';
    END IF;

    v_billing_intent_hash := encode(
        public.digest(
            convert_to(
                jsonb_build_object(
                    'operation', 'RESERVE',
                    'workspace_id', p_workspace_id::text,
                    'run_id', p_run_id::text,
                    'accepted_plan_hash', p_accepted_plan_hash,
                    'reservation_id', p_reservation_id::text,
                    'credits', p_credits,
                    'expires_at', p_expires_at
                )::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    SELECT credits_balance, credits_reserved_balance
    INTO v_available, v_reserved_balance
    FROM public.workspaces
    WHERE id = p_workspace_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace not found in authenticated context'
            USING ERRCODE = 'P0002';
    END IF;

    -- A child Run is funded only by the later Agent allocation path. Lock the
    -- Run after the Workspace row so a caller cannot race a child/link creation
    -- and obtain a second Workspace reservation for the same execution tree.
    SELECT run_kind, billing_owner_run_id, accepted_plan_hash, status, execution_status
    INTO v_run_kind, v_billing_owner_run_id, v_accepted_plan_hash,
         v_run_status, v_run_execution_status
    FROM public.runs
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'run not found in authenticated workspace'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_run_kind <> 'top_level' OR v_billing_owner_run_id <> p_run_id THEN
        RAISE EXCEPTION 'only self-owned top-level runs may create a workspace credit reservation'
            USING ERRCODE = '23514';
    END IF;
    IF v_accepted_plan_hash IS DISTINCT FROM p_accepted_plan_hash THEN
        RAISE EXCEPTION 'reservation accepted Plan binding does not match the Run'
            USING ERRCODE = '42501';
    END IF;

    SELECT reservation.id, reservation.reserved_credits,
           reservation.balance_version
    INTO v_existing_reservation_id, v_existing_reserved_credits, v_existing_balance_version
    FROM public.credit_reservations AS reservation
    WHERE reservation.workspace_id = p_workspace_id
      AND reservation.run_id = p_run_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing_reservation_id <> p_reservation_id
           OR v_existing_reserved_credits <> p_credits THEN
            RAISE EXCEPTION 'run already has a different credit reservation'
                USING ERRCODE = '23505';
        END IF;
        SELECT ledger.billing_intent_hash
        INTO v_existing_billing_intent_hash
        FROM public.credits_ledger AS ledger
        WHERE ledger.workspace_id = p_workspace_id
          AND ledger.charge_key = p_charge_key
          AND ledger.entry_kind = 'RESERVE'
          AND ledger.reservation_id = p_reservation_id;
        IF NOT FOUND OR v_existing_billing_intent_hash <> v_billing_intent_hash THEN
            RAISE EXCEPTION 'reservation replay uses a different charge key or billing intent'
                USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT v_existing_reservation_id, v_existing_balance_version, false;
        RETURN;
    END IF;

    IF v_run_status <> 'QUEUED' OR v_run_execution_status <> 'ACCEPTED' THEN
        RAISE EXCEPTION 'new reservation is permitted only inside the Run acceptance transaction'
            USING ERRCODE = '55000';
    END IF;

    IF v_available < p_credits THEN
        RAISE EXCEPTION 'CREDITS_INSUFFICIENT'
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.workspaces AS w
    SET credits_balance = w.credits_balance - p_credits,
        credits_reserved_balance = w.credits_reserved_balance + p_credits,
        credits_balance_version = w.credits_balance_version + 1,
        updated_at = clock_timestamp()
    WHERE w.id = p_workspace_id
    RETURNING w.credits_balance_version INTO v_new_balance_version;

    INSERT INTO public.credit_reservations (
        id,
        workspace_id,
        run_id,
        reserved_credits,
        balance_version,
        expires_at
    ) VALUES (
        p_reservation_id,
        p_workspace_id,
        p_run_id,
        p_credits,
        v_new_balance_version,
        p_expires_at
    );

    INSERT INTO public.credits_ledger (
        id,
        workspace_id,
        run_id,
        producer_run_id,
        reservation_id,
        entry_kind,
        available_delta_credits,
        reserved_delta_credits,
        settled_delta_credits,
        billing_intent_hash,
        charge_attribution_hash,
        charge_key,
        balance_version
    ) VALUES (
        p_ledger_id,
        p_workspace_id,
        p_run_id,
        p_run_id,
        p_reservation_id,
        'RESERVE',
        -p_credits,
        p_credits,
        0,
        v_billing_intent_hash,
        p_accepted_plan_hash,
        p_charge_key,
        v_new_balance_version
    );

    RETURN QUERY SELECT p_reservation_id, v_new_balance_version, true;
END;
$$;

CREATE OR REPLACE FUNCTION app.settle_credits(
    p_workspace_id uuid,
    p_run_id uuid,
    p_attempt_id uuid,
    p_lease_token uuid,
    p_lease_fencing_token bigint,
    p_charge_attribution_hash text,
    p_reservation_id uuid,
    p_ledger_id uuid,
    p_charge_key text,
    p_credits bigint,
    p_step_id uuid DEFAULT NULL,
    p_metering_detail_redacted jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    reservation_id uuid,
    balance_version bigint,
    applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
    v_run_id uuid;
    v_reserved_credits bigint;
    v_settled_credits bigint;
    v_released_credits bigint;
    v_existing_kind text;
    v_existing_reservation_id uuid;
    v_existing_balance_version bigint;
    v_existing_billing_intent_hash text;
    v_billing_intent_hash text;
    v_new_balance_version bigint;
    v_remaining bigint;
    v_attempt_status text;
    v_stored_lease_token uuid;
    v_lease_expires_at timestamptz;
BEGIN
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id() THEN
        RAISE EXCEPTION 'workspace context does not authorize settlement'
            USING ERRCODE = '42501';
    END IF;
    IF p_reservation_id IS NULL OR p_ledger_id IS NULL OR p_credits <= 0
       OR p_run_id IS NULL OR p_attempt_id IS NULL OR p_lease_token IS NULL
       OR p_lease_fencing_token IS NULL OR p_lease_fencing_token <= 0
       OR p_charge_attribution_hash IS NULL
       OR p_charge_attribution_hash !~ '^[0-9a-f]{64}$'
       OR p_charge_key IS NULL OR char_length(p_charge_key) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'invalid credit settlement arguments'
            USING ERRCODE = '22023';
    END IF;

    v_billing_intent_hash := encode(
        public.digest(
            convert_to(
                jsonb_build_object(
                    'operation', 'SETTLE',
                    'workspace_id', p_workspace_id::text,
                    'run_id', p_run_id::text,
                    'attempt_id', p_attempt_id::text,
                    'lease_token', p_lease_token::text,
                    'lease_fencing_token', p_lease_fencing_token,
                    'charge_attribution_hash', p_charge_attribution_hash,
                    'reservation_id', p_reservation_id::text,
                    'credits', p_credits,
                    'step_id', p_step_id::text,
                    'metering', COALESCE(p_metering_detail_redacted, '{}'::jsonb)
                )::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    -- Lock the tenant balance first even though SETTLE changes only held funds;
    -- this makes balance_version a serial audit sequence for all billing moves.
    PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace not found in authenticated context'
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM 1
    FROM public.runs
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'metered Run not found in authenticated workspace'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT status, lease_token, lease_expires_at
    INTO v_attempt_status, v_stored_lease_token, v_lease_expires_at
    FROM public.run_attempts
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id
      AND id = p_attempt_id
      AND lease_fencing_token = p_lease_fencing_token
    FOR SHARE;
    IF NOT FOUND
       OR v_attempt_status NOT IN ('LEASED', 'EXECUTING')
       OR v_stored_lease_token IS DISTINCT FROM p_lease_token
       OR v_lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'settlement attempt lease is missing, expired or fenced'
            USING ERRCODE = '42501';
    END IF;

    IF p_step_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM public.run_steps AS step
        WHERE step.workspace_id = p_workspace_id
          AND step.run_id = p_run_id
          AND step.id = p_step_id
          AND step.last_attempt_id = p_attempt_id
    ) THEN
        RAISE EXCEPTION 'settlement Step is not attributed to the bound attempt'
            USING ERRCODE = '42501';
    END IF;

    SELECT run_id, reserved_credits, settled_credits, released_credits
    INTO v_run_id, v_reserved_credits, v_settled_credits, v_released_credits
    FROM public.credit_reservations
    WHERE workspace_id = p_workspace_id
      AND id = p_reservation_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'credit reservation not found in authenticated workspace'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION 'reservation does not belong to the bound billing-owner Run'
            USING ERRCODE = '42501';
    END IF;
    SELECT ledger.entry_kind, ledger.reservation_id, ledger.balance_version,
           ledger.billing_intent_hash
    INTO v_existing_kind, v_existing_reservation_id, v_existing_balance_version,
         v_existing_billing_intent_hash
    FROM public.credits_ledger AS ledger
    WHERE ledger.workspace_id = p_workspace_id
      AND ledger.charge_key = p_charge_key;
    IF FOUND THEN
        IF v_existing_kind <> 'SETTLE'
           OR v_existing_reservation_id <> p_reservation_id
           OR v_existing_billing_intent_hash <> v_billing_intent_hash THEN
            RAISE EXCEPTION 'charge key already belongs to a different billing intent'
                USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT p_reservation_id, v_existing_balance_version, false;
        RETURN;
    END IF;

    v_remaining := v_reserved_credits - v_settled_credits - v_released_credits;
    IF p_credits > v_remaining THEN
        RAISE EXCEPTION 'settlement exceeds remaining reservation'
            USING ERRCODE = '22003';
    END IF;

    UPDATE public.workspaces AS w
    SET credits_reserved_balance = w.credits_reserved_balance - p_credits,
        credits_balance_version = w.credits_balance_version + 1,
        updated_at = clock_timestamp()
    WHERE w.id = p_workspace_id
    RETURNING w.credits_balance_version INTO v_new_balance_version;

    UPDATE public.credit_reservations
    SET settled_credits = settled_credits + p_credits,
        balance_version = v_new_balance_version,
        status = CASE
            WHEN settled_credits + p_credits + released_credits = reserved_credits THEN 'SETTLED'
            ELSE 'HELD'
        END,
        settled_at = CASE
            WHEN settled_credits + p_credits + released_credits = reserved_credits
            THEN COALESCE(settled_at, clock_timestamp())
            ELSE settled_at
        END,
        updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace_id
      AND id = p_reservation_id;

    IF v_settled_credits + p_credits + v_released_credits = v_reserved_credits THEN
        UPDATE public.runs
        SET billing_state = 'SETTLED',
            billing_settled_at = COALESCE(billing_settled_at, clock_timestamp()),
            updated_at = clock_timestamp()
        WHERE workspace_id = p_workspace_id
          AND id = v_run_id
          -- This baseline has no allocation table. It may close only a direct
          -- top-level reservation with no child topology; the Agent migration's
          -- allocation-aware finalizer must close parent/child trees.
          AND NOT EXISTS (
              SELECT 1
              FROM public.run_parent_links AS link
              WHERE link.workspace_id = p_workspace_id
                AND link.billing_owner_run_id = v_run_id
          );
    END IF;

    INSERT INTO public.credits_ledger (
        id,
        workspace_id,
        run_id,
        producer_run_id,
        producer_attempt_id,
        producer_lease_fencing_token,
        step_id,
        reservation_id,
        entry_kind,
        available_delta_credits,
        reserved_delta_credits,
        settled_delta_credits,
        billing_intent_hash,
        charge_attribution_hash,
        charge_key,
        balance_version,
        metering_detail_redacted
    ) VALUES (
        p_ledger_id,
        p_workspace_id,
        v_run_id,
        p_run_id,
        p_attempt_id,
        p_lease_fencing_token,
        p_step_id,
        p_reservation_id,
        'SETTLE',
        0,
        -p_credits,
        p_credits,
        v_billing_intent_hash,
        p_charge_attribution_hash,
        p_charge_key,
        v_new_balance_version,
        COALESCE(p_metering_detail_redacted, '{}'::jsonb)
    );

    RETURN QUERY SELECT p_reservation_id, v_new_balance_version, true;
END;
$$;

CREATE OR REPLACE FUNCTION app.release_credits(
    p_workspace_id uuid,
    p_run_id uuid,
    p_attempt_id uuid,
    p_lease_token uuid,
    p_lease_fencing_token bigint,
    p_charge_attribution_hash text,
    p_reservation_id uuid,
    p_ledger_id uuid,
    p_charge_key text,
    p_credits bigint,
    p_mark_expired boolean DEFAULT false,
    p_reason_code text DEFAULT NULL
)
RETURNS TABLE (
    reservation_id uuid,
    balance_version bigint,
    applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
    v_run_id uuid;
    v_reserved_credits bigint;
    v_settled_credits bigint;
    v_released_credits bigint;
    v_expires_at timestamptz;
    v_existing_kind text;
    v_existing_reservation_id uuid;
    v_existing_balance_version bigint;
    v_existing_billing_intent_hash text;
    v_billing_intent_hash text;
    v_new_balance_version bigint;
    v_remaining bigint;
    v_terminal boolean;
    v_attempt_status text;
    v_stored_lease_token uuid;
    v_lease_expires_at timestamptz;
BEGIN
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id() THEN
        RAISE EXCEPTION 'workspace context does not authorize release'
            USING ERRCODE = '42501';
    END IF;
    IF p_reservation_id IS NULL OR p_ledger_id IS NULL OR p_credits <= 0
       OR p_run_id IS NULL OR p_attempt_id IS NULL OR p_lease_token IS NULL
       OR p_lease_fencing_token IS NULL OR p_lease_fencing_token <= 0
       OR p_charge_attribution_hash IS NULL
       OR p_charge_attribution_hash !~ '^[0-9a-f]{64}$'
       OR p_charge_key IS NULL OR char_length(p_charge_key) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'invalid credit release arguments'
            USING ERRCODE = '22023';
    END IF;

    v_billing_intent_hash := encode(
        public.digest(
            convert_to(
                jsonb_build_object(
                    'operation', 'RELEASE',
                    'workspace_id', p_workspace_id::text,
                    'run_id', p_run_id::text,
                    'attempt_id', p_attempt_id::text,
                    'lease_token', p_lease_token::text,
                    'lease_fencing_token', p_lease_fencing_token,
                    'charge_attribution_hash', p_charge_attribution_hash,
                    'reservation_id', p_reservation_id::text,
                    'credits', p_credits,
                    'mark_expired', COALESCE(p_mark_expired, false),
                    'reason_code', p_reason_code
                )::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace not found in authenticated context'
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM 1
    FROM public.runs
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'finalized Run not found in authenticated workspace'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT status, lease_token, lease_expires_at
    INTO v_attempt_status, v_stored_lease_token, v_lease_expires_at
    FROM public.run_attempts
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id
      AND id = p_attempt_id
      AND lease_fencing_token = p_lease_fencing_token
    FOR SHARE;
    IF NOT FOUND
       OR v_attempt_status NOT IN ('LEASED', 'EXECUTING')
       OR v_stored_lease_token IS DISTINCT FROM p_lease_token
       OR v_lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'release attempt lease is missing, expired or fenced'
            USING ERRCODE = '42501';
    END IF;

    SELECT run_id, reserved_credits, settled_credits, released_credits, expires_at
    INTO v_run_id, v_reserved_credits, v_settled_credits, v_released_credits,
         v_expires_at
    FROM public.credit_reservations
    WHERE workspace_id = p_workspace_id
      AND id = p_reservation_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'credit reservation not found in authenticated workspace'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION 'reservation does not belong to the bound billing-owner Run'
            USING ERRCODE = '42501';
    END IF;
    IF COALESCE(p_mark_expired, false)
       AND clock_timestamp() < v_expires_at THEN
        RAISE EXCEPTION 'reservation cannot be marked expired before expires_at'
            USING ERRCODE = '55000';
    END IF;

    SELECT ledger.entry_kind, ledger.reservation_id, ledger.balance_version,
           ledger.billing_intent_hash
    INTO v_existing_kind, v_existing_reservation_id, v_existing_balance_version,
         v_existing_billing_intent_hash
    FROM public.credits_ledger AS ledger
    WHERE ledger.workspace_id = p_workspace_id
      AND ledger.charge_key = p_charge_key;
    IF FOUND THEN
        IF v_existing_kind <> 'RELEASE'
           OR v_existing_reservation_id <> p_reservation_id
           OR v_existing_billing_intent_hash <> v_billing_intent_hash THEN
            RAISE EXCEPTION 'charge key already belongs to a different billing intent'
                USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT p_reservation_id, v_existing_balance_version, false;
        RETURN;
    END IF;

    v_remaining := v_reserved_credits - v_settled_credits - v_released_credits;
    IF p_credits > v_remaining THEN
        RAISE EXCEPTION 'release exceeds remaining reservation'
            USING ERRCODE = '22003';
    END IF;
    IF p_mark_expired AND (v_settled_credits <> 0 OR p_credits <> v_remaining) THEN
        RAISE EXCEPTION 'expired reservation must release all unconsumed credits'
            USING ERRCODE = '22023';
    END IF;
    v_terminal := p_credits = v_remaining;

    UPDATE public.workspaces AS w
    SET credits_balance = w.credits_balance + p_credits,
        credits_reserved_balance = w.credits_reserved_balance - p_credits,
        credits_balance_version = w.credits_balance_version + 1,
        updated_at = clock_timestamp()
    WHERE w.id = p_workspace_id
    RETURNING w.credits_balance_version INTO v_new_balance_version;

    UPDATE public.credit_reservations
    SET released_credits = released_credits + p_credits,
        balance_version = v_new_balance_version,
        status = CASE
            WHEN NOT v_terminal THEN 'HELD'
            WHEN p_mark_expired THEN 'EXPIRED'
            WHEN settled_credits > 0 THEN 'SETTLED'
            ELSE 'RELEASED'
        END,
        settled_at = CASE
            WHEN v_terminal AND settled_credits > 0 THEN COALESCE(settled_at, clock_timestamp())
            ELSE settled_at
        END,
        released_at = CASE
            WHEN v_terminal THEN clock_timestamp()
            ELSE released_at
        END,
        status_reason_code = COALESCE(p_reason_code, status_reason_code),
        updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace_id
      AND id = p_reservation_id;

    IF v_terminal THEN
        UPDATE public.runs
        SET billing_state = 'SETTLED',
            billing_settled_at = COALESCE(billing_settled_at, clock_timestamp()),
            updated_at = clock_timestamp()
        WHERE workspace_id = p_workspace_id
          AND id = v_run_id
          AND NOT EXISTS (
              SELECT 1
              FROM public.run_parent_links AS link
              WHERE link.workspace_id = p_workspace_id
                AND link.billing_owner_run_id = v_run_id
          );
    END IF;

    INSERT INTO public.credits_ledger (
        id,
        workspace_id,
        run_id,
        producer_run_id,
        producer_attempt_id,
        producer_lease_fencing_token,
        reservation_id,
        entry_kind,
        available_delta_credits,
        reserved_delta_credits,
        settled_delta_credits,
        billing_intent_hash,
        charge_attribution_hash,
        charge_key,
        balance_version,
        metering_detail_redacted
    ) VALUES (
        p_ledger_id,
        p_workspace_id,
        v_run_id,
        p_run_id,
        p_attempt_id,
        p_lease_fencing_token,
        p_reservation_id,
        'RELEASE',
        p_credits,
        -p_credits,
        0,
        v_billing_intent_hash,
        p_charge_attribution_hash,
        p_charge_key,
        v_new_balance_version,
        jsonb_strip_nulls(jsonb_build_object(
            'mark_expired', COALESCE(p_mark_expired, false),
            'reason_code', p_reason_code
        ))
    );

    RETURN QUERY SELECT p_reservation_id, v_new_balance_version, true;
END;
$$;

-- Trusted output-schema validation is intentionally unavailable in this
-- standalone baseline: accepting only "jsonb object" would silently weaken the
-- release contract. G0 installs a registry-backed implementation with the same
-- signature, validates the exact ref/hash pinned at acceptance, and then opens
-- the success fixture. Until that atomic migration, SUCCEEDED fails closed.
CREATE OR REPLACE FUNCTION app.assert_accepted_output_schema(
    p_schema_ref text,
    p_schema_hash text,
    p_public_result_redacted jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    IF p_schema_ref IS NULL
       OR p_schema_hash IS NULL
       OR p_schema_hash !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(p_public_result_redacted) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'accepted output schema identity and result object are required'
            USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'trusted accepted-output-schema validator is not installed'
        USING ERRCODE = '0A000';
END;
$function$;

ALTER FUNCTION app.assert_accepted_output_schema(text, text, jsonb)
    OWNER TO ba_finalizer_owner;
REVOKE ALL ON FUNCTION app.assert_accepted_output_schema(text, text, jsonb)
    FROM PUBLIC, ba_runtime, ba_admission_executor, ba_metering_executor,
         ba_finalizer_executor, ba_reconciliation_executor;

-- The one G0/G1 terminal writer. The finalizer executor may call
-- release_credits() immediately before this function in the SAME outer
-- transaction; ordinary runtime and metering executors cannot invoke it.
-- The function validates the exact current attempt/fence, closes every active
-- Step into shared StepStatusV1, appends the unique terminal event, freezes the
-- Run snapshot and enqueues its wakeup atomically. Gate-aware migrations must
-- terminalize/claim the Gate before calling this same primitive.
CREATE OR REPLACE FUNCTION app.finalize_run(
    p_workspace_id uuid,
    p_run_id uuid,
    p_attempt_id uuid,
    p_lease_token uuid,
    p_lease_fencing_token bigint,
    p_terminal_status text,
    p_termination_reason text,
    p_terminal_result_redacted jsonb,
    p_event_id uuid,
    p_outbox_id uuid,
    p_finished_at timestamptz DEFAULT clock_timestamp()
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_run_status text;
    v_run_termination_reason text;
    v_run_terminal_result jsonb;
    v_run_terminal_error jsonb;
    v_terminal_event_id uuid;
    v_terminal_event_sequence bigint;
    v_billing_state text;
    v_accepted_output_schema_ref text;
    v_accepted_output_schema_hash text;
    v_current_attempt_number integer;
    v_attempt_number integer;
    v_attempt_status text;
    v_stored_lease_token uuid;
    v_lease_expires_at timestamptz;
    v_execution_status text;
    v_step_terminal_status text;
    v_billing_pending boolean;
    v_public_error jsonb;
    v_sequence bigint;
    v_payload jsonb;
BEGIN
    IF p_workspace_id IS DISTINCT FROM app.current_workspace_id()
       OR p_run_id IS NULL
       OR p_attempt_id IS NULL
       OR p_lease_token IS NULL
       OR p_lease_fencing_token IS NULL
       OR p_lease_fencing_token <= 0
       OR p_event_id IS NULL
       OR p_outbox_id IS NULL
       OR p_finished_at IS NULL
       OR p_finished_at > clock_timestamp() + interval '5 minutes' THEN
        RAISE EXCEPTION 'invalid or unauthorized Run finalization arguments'
            USING ERRCODE = '42501';
    END IF;

    IF p_terminal_status NOT IN (
        'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION'
    ) THEN
        RAISE EXCEPTION 'finalizer accepts only shared terminal RunStatusV1 values'
            USING ERRCODE = '22023';
    END IF;

    -- This baseline has no durable HumanGate/GateSpec disposition relation.
    -- Accepting HUMAN_* here would let a caller choose FAILED versus CANCELLED
    -- without proving the immutable published on_reject/on_expire policy. A
    -- later gate migration must add that FK/evidence join and executable fixture
    -- before exposing those reasons through its controlled finalizer path.
    IF p_termination_reason IN ('HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED') THEN
        RAISE EXCEPTION 'Human Gate terminalization requires the gate-aware sealed migration'
            USING ERRCODE = '0A000';
    END IF;

    IF NOT (
        (p_terminal_status = 'SUCCEEDED' AND p_termination_reason = 'COMPLETED')
        OR (p_terminal_status = 'CANCELLED' AND p_termination_reason IN (
            'USER_CANCELLED', 'HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED'
        ))
        OR (p_terminal_status = 'TIMED_OUT' AND p_termination_reason = 'RUN_TIMED_OUT')
        OR (p_terminal_status = 'NEEDS_ATTENTION' AND p_termination_reason = 'SIDE_EFFECT_UNKNOWN')
        OR (p_terminal_status = 'FAILED' AND p_termination_reason IN (
            'MAX_ITERATIONS', 'MAX_MODEL_ATTEMPTS', 'MAX_TOOL_CALLS',
            'BUDGET_EXHAUSTED', 'AUTHORIZATION_REVALIDATION_FAILED',
            'RESOURCE_REVOKED', 'MODEL_FAILED', 'MODEL_OUTCOME_UNKNOWN',
            'CAPABILITY_FAILED', 'HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED',
            'INVALID_DECISION', 'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
            'INTERNAL_FAILURE'
        ))
    ) THEN
        RAISE EXCEPTION 'termination reason does not map to requested Run status'
            USING ERRCODE = '23514';
    END IF;

    IF p_terminal_status = 'SUCCEEDED' THEN
        IF jsonb_typeof(p_terminal_result_redacted) IS DISTINCT FROM 'object'
        THEN
            RAISE EXCEPTION 'successful finalization requires a public result object'
                USING ERRCODE = '23514';
        END IF;
        v_public_error := NULL;
    ELSE
        IF p_terminal_result_redacted IS NOT NULL THEN
            RAISE EXCEPTION 'non-success finalization forbids a public result'
                USING ERRCODE = '23514';
        END IF;
        v_public_error := jsonb_build_object(
            'code', p_termination_reason,
            'retryable', false,
            'category', 'EXECUTION'
        ) || CASE WHEN p_terminal_status = 'NEEDS_ATTENTION'
            THEN jsonb_build_object(
                'code', 'SIDE_EFFECT_UNKNOWN',
                'flow_category', 'SIDE_EFFECT_UNKNOWN',
                'requires_operator_action', true
            )
            ELSE '{}'::jsonb END;
    END IF;

    SELECT status, termination_reason, terminal_result_redacted,
           terminal_error_redacted, terminal_event_id, terminal_event_sequence,
           billing_state, current_attempt_number,
           accepted_output_schema_ref, accepted_output_schema_hash
    INTO v_run_status, v_run_termination_reason, v_run_terminal_result,
         v_run_terminal_error, v_terminal_event_id, v_terminal_event_sequence,
         v_billing_state, v_current_attempt_number,
         v_accepted_output_schema_ref, v_accepted_output_schema_hash
    FROM public.runs
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Run not found in authenticated workspace'
            USING ERRCODE = 'P0002';
    END IF;

    -- A committed terminal snapshot is replayed by its immutable event identity;
    -- the successful first call has already cleared the attempt lease fields.
    -- This uses the Run tombstone, not purgeable run_events, so replay remains
    -- canonical after the event retention horizon.
    IF v_run_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION') THEN
        IF v_run_status IS DISTINCT FROM p_terminal_status
           OR v_run_termination_reason IS DISTINCT FROM p_termination_reason
           OR v_run_terminal_result IS DISTINCT FROM p_terminal_result_redacted
           OR v_run_terminal_error IS DISTINCT FROM v_public_error
           OR v_terminal_event_id IS DISTINCT FROM p_event_id THEN
            RAISE EXCEPTION 'terminal Run already finalized with a different intent'
                USING ERRCODE = '23505';
        END IF;
        RETURN v_terminal_event_sequence;
    END IF;

    SELECT attempt_number, status, lease_token, lease_expires_at
    INTO v_attempt_number, v_attempt_status, v_stored_lease_token, v_lease_expires_at
    FROM public.run_attempts
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id
      AND id = p_attempt_id
      AND lease_fencing_token = p_lease_fencing_token
    FOR UPDATE;
    IF NOT FOUND
       OR v_attempt_number <> v_current_attempt_number
       OR v_attempt_status NOT IN ('LEASED', 'EXECUTING')
       OR v_stored_lease_token IS DISTINCT FROM p_lease_token
       OR v_lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'finalizer attempt lease is missing, expired, stale or fenced'
            USING ERRCODE = '42501';
    END IF;

    IF p_terminal_status = 'SUCCEEDED' THEN
        PERFORM app.assert_accepted_output_schema(
            v_accepted_output_schema_ref,
            v_accepted_output_schema_hash,
            p_terminal_result_redacted
        );
    END IF;

    IF p_terminal_status = 'SUCCEEDED' AND EXISTS (
        SELECT 1 FROM public.run_steps
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
          AND status = 'SUSPENDED'
    ) THEN
        RAISE EXCEPTION 'a Run with a suspended Step cannot finalize successfully'
            USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.run_parent_links AS link
        JOIN public.runs AS child
          ON child.workspace_id = link.workspace_id
         AND child.id = link.child_run_id
        WHERE link.workspace_id = p_workspace_id
          AND link.parent_run_id = p_run_id
          AND (
              child.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
              OR child.billing_state NOT IN ('SETTLED', 'NEEDS_ATTENTION')
          )
    ) THEN
        RAISE EXCEPTION 'G1 join parent cannot finalize before every child settles or enters operator hold'
            USING ERRCODE = '55000';
    END IF;

    IF p_terminal_status <> 'NEEDS_ATTENTION' AND EXISTS (
        SELECT 1
        FROM public.run_parent_links AS link
        JOIN public.runs AS child
          ON child.workspace_id = link.workspace_id
         AND child.id = link.child_run_id
        WHERE link.workspace_id = p_workspace_id
          AND link.parent_run_id = p_run_id
          AND (
              child.status = 'NEEDS_ATTENTION'
              OR child.billing_state = 'NEEDS_ATTENTION'
          )
    ) THEN
        RAISE EXCEPTION 'G1 join child operator hold must propagate to parent NEEDS_ATTENTION'
            USING ERRCODE = '23514';
    END IF;

    -- G1 exposes only join children. The immutable compatibility snapshot
    -- therefore remains false even when the separate current billing state
    -- needs operator attention. Future detach requires a versioned schema.
    v_billing_pending := false;
    IF p_terminal_status = 'NEEDS_ATTENTION' THEN
        UPDATE public.runs
        SET billing_state = 'NEEDS_ATTENTION',
            billing_settled_at = NULL
        WHERE workspace_id = p_workspace_id
          AND id = p_run_id;
    ELSE
        IF EXISTS (
            SELECT 1 FROM public.credit_reservations
            WHERE workspace_id = p_workspace_id
              AND run_id = p_run_id
              AND status = 'HELD'
        ) THEN
            RAISE EXCEPTION 'normal terminal Run still has an unsettled reservation'
                USING ERRCODE = '55000';
        END IF;
        UPDATE public.runs
        SET billing_state = 'SETTLED',
            billing_settled_at = COALESCE(billing_settled_at, p_finished_at)
        WHERE workspace_id = p_workspace_id
          AND id = p_run_id;
    END IF;

    UPDATE public.run_steps
    SET status = 'SKIPPED',
        finished_at = COALESCE(finished_at, p_finished_at),
        updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id
      AND status = 'QUEUED';

    v_step_terminal_status := CASE p_terminal_status
        WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
        WHEN 'FAILED' THEN 'FAILED'
        WHEN 'CANCELLED' THEN 'CANCELLED'
        WHEN 'TIMED_OUT' THEN 'CANCELLED'
        WHEN 'NEEDS_ATTENTION' THEN 'NEEDS_ATTENTION'
    END;
    UPDATE public.run_steps
    SET status = v_step_terminal_status,
        requires_manual_review = CASE
            WHEN v_step_terminal_status = 'NEEDS_ATTENTION' THEN true
            ELSE requires_manual_review
        END,
        finished_at = COALESCE(finished_at, p_finished_at),
        updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id
      AND status IN ('RUNNING', 'SUSPENDED', 'RESUMING');

    IF EXISTS (
        SELECT 1 FROM public.run_steps
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
          AND status IN ('QUEUED', 'RUNNING', 'SUSPENDED', 'RESUMING')
    ) THEN
        RAISE EXCEPTION 'finalizer left a nonterminal Step'
            USING ERRCODE = '55000';
    END IF;

    UPDATE public.run_attempts
    SET status = CASE p_terminal_status
            WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
            WHEN 'FAILED' THEN 'FAILED'
            WHEN 'CANCELLED' THEN 'CANCELLED'
            WHEN 'TIMED_OUT' THEN 'TIMED_OUT'
            WHEN 'NEEDS_ATTENTION' THEN 'UNKNOWN'
        END,
        failure_class = CASE
            WHEN p_terminal_status = 'NEEDS_ATTENTION' THEN 'UNKNOWN_EXTERNAL_EFFECT'
            WHEN p_terminal_status = 'CANCELLED' THEN 'CANCELLED'
            WHEN p_terminal_status = 'FAILED' THEN 'NON_RETRYABLE'
            ELSE failure_class
        END,
        failure_code = CASE
            WHEN p_terminal_status = 'NEEDS_ATTENTION' THEN 'SIDE_EFFECT_UNKNOWN'
            ELSE failure_code
        END,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        finished_at = COALESCE(finished_at, p_finished_at),
        updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id
      AND id = p_attempt_id
      AND lease_fencing_token = p_lease_fencing_token;

    -- RUN_FINISHED is the internal durable event. The REST/SSE projector maps
    -- NEEDS_ATTENTION to public FAILED + SIDE_EFFECT_UNKNOWN and must not emit
    -- this runtime status directly as the OpenAPI RunTerminalEvent status.
    v_payload := jsonb_build_object(
        'schema_version', 'run-terminal-internal/1',
        'runtime_status', p_terminal_status,
        'termination_reason', p_termination_reason,
        'public_data', jsonb_build_object(
            'status', CASE
                WHEN p_terminal_status = 'NEEDS_ATTENTION' THEN 'FAILED'
                ELSE p_terminal_status
            END,
            'billing_pending', v_billing_pending
        )
        || CASE WHEN p_terminal_result_redacted IS NOT NULL
            THEN jsonb_build_object('result', p_terminal_result_redacted)
            ELSE '{}'::jsonb END
        || CASE WHEN v_public_error IS NOT NULL
            THEN jsonb_build_object('error', v_public_error)
            ELSE '{}'::jsonb END,
        'finished_at', p_finished_at
    );
    INSERT INTO public.run_events (
        id, workspace_id, run_id, attempt_id, event_kind, sse_visible,
        payload_redacted
    ) VALUES (
        p_event_id, p_workspace_id, p_run_id, p_attempt_id, 'RUN_FINISHED', true,
        v_payload
    )
    RETURNING sequence INTO v_sequence;

    v_execution_status := CASE p_terminal_status
        WHEN 'TIMED_OUT' THEN 'EXPIRED'
        ELSE p_terminal_status
    END;
    UPDATE public.runs
    SET status = p_terminal_status,
        execution_status = v_execution_status,
        status_reason_code = p_termination_reason,
        termination_reason = p_termination_reason,
        terminal_result_redacted = p_terminal_result_redacted,
        terminal_error_redacted = v_public_error,
        finished_at = p_finished_at,
        terminal_billing_pending = v_billing_pending,
        terminal_billing_pending_at = p_finished_at,
        terminal_event_id = p_event_id,
        terminal_event_sequence = v_sequence,
        events_retention_until = GREATEST(
            COALESCE(events_retention_until, p_finished_at + interval '7 days'),
            p_finished_at + interval '7 days'
        ),
        recovery_retention_until = GREATEST(
            COALESCE(recovery_retention_until, p_finished_at + interval '30 days'),
            p_finished_at + interval '30 days'
        ),
        retention_until = GREATEST(
            retention_until,
            p_finished_at + interval '30 days'
        ),
        updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id;

    INSERT INTO public.outbox (
        id, workspace_id, run_id, message_type, dedupe_key,
        payload_object_ref, payload_sha256, payload_metadata_redacted
    ) VALUES (
        p_outbox_id,
        p_workspace_id,
        p_run_id,
        'SSE_WAKE',
        'run-terminal/' || p_run_id::text,
        'db://run-events/' || p_event_id::text,
        encode(public.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex'),
        jsonb_build_object('event_id', p_event_id, 'sequence', v_sequence::text)
    );

    RETURN v_sequence;
END;
$function$;

ALTER FUNCTION app.reserve_credits(uuid, uuid, text, uuid, uuid, text, bigint, timestamptz)
    OWNER TO ba_admission_owner;
ALTER FUNCTION app.settle_credits(uuid, uuid, uuid, uuid, bigint, text, uuid, uuid, text, bigint, uuid, jsonb)
    OWNER TO ba_metering_owner;
ALTER FUNCTION app.release_credits(uuid, uuid, uuid, uuid, bigint, text, uuid, uuid, text, bigint, boolean, text)
    OWNER TO ba_finalizer_owner;
ALTER FUNCTION app.finalize_run(uuid, uuid, uuid, uuid, bigint, text, text, jsonb, uuid, uuid, timestamptz)
    OWNER TO ba_finalizer_owner;
REVOKE ALL ON FUNCTION app.reserve_credits(uuid, uuid, text, uuid, uuid, text, bigint, timestamptz) FROM PUBLIC, ba_runtime;
REVOKE ALL ON FUNCTION app.settle_credits(uuid, uuid, uuid, uuid, bigint, text, uuid, uuid, text, bigint, uuid, jsonb) FROM PUBLIC, ba_runtime;
REVOKE ALL ON FUNCTION app.release_credits(uuid, uuid, uuid, uuid, bigint, text, uuid, uuid, text, bigint, boolean, text) FROM PUBLIC, ba_runtime;
REVOKE ALL ON FUNCTION app.finalize_run(uuid, uuid, uuid, uuid, bigint, text, text, jsonb, uuid, uuid, timestamptz) FROM PUBLIC, ba_runtime;
GRANT EXECUTE ON FUNCTION app.reserve_credits(uuid, uuid, text, uuid, uuid, text, bigint, timestamptz)
    TO ba_admission_executor;
GRANT EXECUTE ON FUNCTION app.settle_credits(uuid, uuid, uuid, uuid, bigint, text, uuid, uuid, text, bigint, uuid, jsonb)
    TO ba_metering_executor;
GRANT EXECUTE ON FUNCTION app.release_credits(uuid, uuid, uuid, uuid, bigint, text, uuid, uuid, text, bigint, boolean, text)
    TO ba_finalizer_executor;
GRANT EXECUTE ON FUNCTION app.finalize_run(uuid, uuid, uuid, uuid, bigint, text, text, jsonb, uuid, uuid, timestamptz)
    TO ba_finalizer_executor;

-- Terminal cleanup is intentionally a controlled purge, not an application
-- UPDATE/DELETE privilege. The run identity, terminal status, immutable terminal
-- billing_pending snapshot, current billing state, durable last_event_sequence,
-- reservation summary and financial ledger remain; only replay/checkpoint/outbox
-- material may be removed only after an independently produced, immutable,
-- verified and approved archive manifest already exists. The purge caller
-- supplies the manifest identity and exact archive ref/hash for comparison; it
-- cannot create or amend that evidence. Once this procedure removes every
-- event, SSE computes min_sequence as last_event_sequence + 1 and returns 410
-- for an older cursor. A deployment grants EXECUTE below only to the dedicated
-- retention scheduler role, never runtime or the archive evidence producer.
CREATE TABLE run_retention_manifests (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    archive_ref text NOT NULL CHECK (
        char_length(archive_ref) > 0
        AND position('?' IN archive_ref) = 0
        AND position('#' IN archive_ref) = 0
    ),
    archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
    verification_receipt_ref text NOT NULL CHECK (
        char_length(verification_receipt_ref) > 0
        AND position('?' IN verification_receipt_ref) = 0
        AND position('#' IN verification_receipt_ref) = 0
    ),
    verification_receipt_sha256 text NOT NULL
        CHECK (verification_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    approval_receipt_ref text NOT NULL CHECK (
        char_length(approval_receipt_ref) > 0
        AND position('?' IN approval_receipt_ref) = 0
        AND position('#' IN approval_receipt_ref) = 0
    ),
    approval_receipt_sha256 text NOT NULL
        CHECK (approval_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    verification_status text NOT NULL CHECK (verification_status = 'VERIFIED'),
    approval_status text NOT NULL CHECK (approval_status = 'APPROVED'),
    verified_at timestamptz NOT NULL,
    approved_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_retention_manifests_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT run_retention_manifests_workspace_id_id_run_key
        UNIQUE (workspace_id, id, run_id),
    CONSTRAINT run_retention_manifests_workspace_run_key UNIQUE (workspace_id, run_id),
    CONSTRAINT run_retention_manifests_approval_order CHECK (
        approved_at >= verified_at
    ),
    CONSTRAINT run_retention_manifests_run_fkey
        FOREIGN KEY (workspace_id, run_id)
        REFERENCES runs(workspace_id, id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE run_retention_manifests IS
    'Pre-existing immutable proof of an independently verified and approved archive handoff. The retention executor can only read and exactly match it; this table never authorizes financial ledger deletion.';

CREATE TABLE run_retention_purge_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    manifest_id uuid NOT NULL,
    material_kind text NOT NULL CHECK (material_kind IN ('EVENTS', 'RECOVERY')),
    purged_checkpoints bigint NOT NULL CHECK (purged_checkpoints >= 0),
    purged_events bigint NOT NULL CHECK (purged_events >= 0),
    purged_outbox bigint NOT NULL CHECK (purged_outbox >= 0),
    financial_ledger_purged boolean NOT NULL DEFAULT false
        CHECK (financial_ledger_purged = false),
    purged_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_retention_purge_receipts_workspace_id_id_key
        UNIQUE (workspace_id, id),
    CONSTRAINT run_retention_purge_receipts_workspace_run_kind_key
        UNIQUE (workspace_id, run_id, material_kind),
    CONSTRAINT run_retention_purge_receipts_manifest_fkey
        FOREIGN KEY (workspace_id, manifest_id, run_id)
        REFERENCES run_retention_manifests(workspace_id, id, run_id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE run_retention_purge_receipts IS
    'Append-only per-horizon receipt written by controlled EVENTS (>=7d) or RECOVERY (>=30d) purge after exact manifest matching. financial_ledger_purged is permanently false in G0/G1.';

CREATE OR REPLACE FUNCTION app.prevent_run_retention_evidence_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
    RAISE EXCEPTION 'Run retention manifest and purge receipt evidence is immutable'
        USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER run_retention_manifests_prevent_rewrite
BEFORE UPDATE OR DELETE ON run_retention_manifests
FOR EACH ROW
EXECUTE FUNCTION app.prevent_run_retention_evidence_rewrite();

CREATE TRIGGER run_retention_purge_receipts_prevent_rewrite
BEFORE UPDATE OR DELETE ON run_retention_purge_receipts
FOR EACH ROW
EXECUTE FUNCTION app.prevent_run_retention_evidence_rewrite();

REVOKE ALL ON FUNCTION app.prevent_run_retention_evidence_rewrite() FROM PUBLIC;

-- Only the isolated archive verification/approval adapter may create this
-- precondition. It must validate the external archive plus both immutable
-- receipts before calling; statuses are hard-coded here rather than accepted
-- from the retention scheduler. Neither retention role can execute this path.
CREATE OR REPLACE FUNCTION app.register_verified_run_archive_manifest(
    p_manifest_id uuid,
    p_workspace_id uuid,
    p_run_id uuid,
    p_archive_ref text,
    p_archive_sha256 text,
    p_verification_receipt_ref text,
    p_verification_receipt_sha256 text,
    p_approval_receipt_ref text,
    p_approval_receipt_sha256 text,
    p_verified_at timestamptz,
    p_approved_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_run_status text;
BEGIN
    IF p_manifest_id IS NULL
       OR p_workspace_id IS NULL
       OR p_run_id IS NULL
       OR p_archive_ref IS NULL
       OR char_length(p_archive_ref) = 0
       OR position('?' IN p_archive_ref) <> 0
       OR position('#' IN p_archive_ref) <> 0
       OR p_archive_sha256 IS NULL
       OR p_archive_sha256 !~ '^[0-9a-f]{64}$'
       OR p_verification_receipt_ref IS NULL
       OR char_length(p_verification_receipt_ref) = 0
       OR position('?' IN p_verification_receipt_ref) <> 0
       OR position('#' IN p_verification_receipt_ref) <> 0
       OR p_verification_receipt_sha256 IS NULL
       OR p_verification_receipt_sha256 !~ '^[0-9a-f]{64}$'
       OR p_approval_receipt_ref IS NULL
       OR char_length(p_approval_receipt_ref) = 0
       OR position('?' IN p_approval_receipt_ref) <> 0
       OR position('#' IN p_approval_receipt_ref) <> 0
       OR p_approval_receipt_sha256 IS NULL
       OR p_approval_receipt_sha256 !~ '^[0-9a-f]{64}$'
       OR p_verified_at IS NULL
       OR p_approved_at IS NULL
       OR p_approved_at < p_verified_at THEN
        RAISE EXCEPTION 'complete verified and approved archive evidence is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT status
      INTO v_run_status
      FROM public.runs
     WHERE workspace_id = p_workspace_id
       AND id = p_run_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'archive evidence target Run not found'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_run_status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION') THEN
        RAISE EXCEPTION 'archive evidence may be registered only for a terminal Run'
            USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.run_retention_manifests (
        id,
        workspace_id,
        run_id,
        archive_ref,
        archive_sha256,
        verification_receipt_ref,
        verification_receipt_sha256,
        approval_receipt_ref,
        approval_receipt_sha256,
        verification_status,
        approval_status,
        verified_at,
        approved_at
    ) VALUES (
        p_manifest_id,
        p_workspace_id,
        p_run_id,
        p_archive_ref,
        p_archive_sha256,
        p_verification_receipt_ref,
        p_verification_receipt_sha256,
        p_approval_receipt_ref,
        p_approval_receipt_sha256,
        'VERIFIED',
        'APPROVED',
        p_verified_at,
        p_approved_at
    );

    RETURN p_manifest_id;
END;
$function$;

ALTER FUNCTION app.register_verified_run_archive_manifest(
    uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz
) OWNER TO ba_archive_evidence_owner;
REVOKE ALL ON FUNCTION app.register_verified_run_archive_manifest(
    uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_verified_run_archive_manifest(
    uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz
) TO ba_archive_evidence_executor;

-- Event replay has an independent seven-day minimum. Checkpoints and durable
-- outbox recovery material remain untouched until the 30-day recovery horizon.
CREATE OR REPLACE FUNCTION app.purge_terminal_run_events(
    p_workspace_id uuid,
    p_run_id uuid,
    p_manifest_id uuid,
    p_archive_ref text,
    p_archive_sha256 text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
    v_status text;
    v_billing_state text;
    v_events_retention_until timestamptz;
    v_manifest_archive_ref text;
    v_manifest_archive_sha256 text;
    v_purged_events bigint;
BEGIN
    IF p_manifest_id IS NULL OR p_archive_ref IS NULL OR char_length(p_archive_ref) = 0
       OR p_archive_sha256 IS NULL OR p_archive_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'retention manifest identity and archive proof are required'
            USING ERRCODE = '22023';
    END IF;

    SELECT status, billing_state, events_retention_until
      INTO v_status, v_billing_state, v_events_retention_until
      FROM public.runs
     WHERE workspace_id = p_workspace_id
       AND id = p_run_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'run not found for event retention'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
       OR v_billing_state <> 'SETTLED'
       OR v_events_retention_until IS NULL
       OR v_events_retention_until > clock_timestamp() THEN
        RAISE EXCEPTION 'Run is not terminal, billing-settled, or past its event replay horizon'
            USING ERRCODE = '55000';
    END IF;
    IF v_status = 'NEEDS_ATTENTION' AND NOT EXISTS (
        SELECT 1 FROM public.run_billing_reconciliations
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
    ) THEN
        RAISE EXCEPTION 'operator-hold Run lacks immutable reconciliation evidence'
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.outbox
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
          AND delivery_status IN ('PENDING', 'LEASED')
    ) THEN
        RAISE EXCEPTION 'cannot purge events with pending outbox delivery'
            USING ERRCODE = '55000';
    END IF;

    SELECT archive_ref, archive_sha256
      INTO v_manifest_archive_ref, v_manifest_archive_sha256
      FROM public.run_retention_manifests
     WHERE workspace_id = p_workspace_id
       AND id = p_manifest_id
       AND run_id = p_run_id
       AND verification_status = 'VERIFIED'
       AND approval_status = 'APPROVED';
    IF NOT FOUND
       OR v_manifest_archive_ref IS DISTINCT FROM p_archive_ref
       OR v_manifest_archive_sha256 IS DISTINCT FROM p_archive_sha256 THEN
        RAISE EXCEPTION 'verified archive manifest does not exactly match event purge proof'
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.run_retention_purge_receipts
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
          AND material_kind = 'EVENTS'
    ) THEN
        RAISE EXCEPTION 'terminal Run events already have an immutable purge receipt'
            USING ERRCODE = '55000';
    END IF;

    DELETE FROM public.run_events
     WHERE workspace_id = p_workspace_id
       AND run_id = p_run_id;
    GET DIAGNOSTICS v_purged_events = ROW_COUNT;

    INSERT INTO public.run_retention_purge_receipts (
        workspace_id, run_id, manifest_id, material_kind,
        purged_checkpoints, purged_events, purged_outbox,
        financial_ledger_purged
    ) VALUES (
        p_workspace_id, p_run_id, p_manifest_id, 'EVENTS',
        0, v_purged_events, 0, false
    );
    RETURN v_purged_events;
END;
$function$;

ALTER FUNCTION app.purge_terminal_run_events(uuid, uuid, uuid, text, text)
    OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.purge_terminal_run_events(uuid, uuid, uuid, text, text)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_terminal_run_events(uuid, uuid, uuid, text, text)
    TO ba_retention_executor;

CREATE OR REPLACE FUNCTION app.purge_terminal_run_material(
    p_workspace_id uuid,
    p_run_id uuid,
    p_manifest_id uuid,
    p_archive_ref text,
    p_archive_sha256 text,
    p_purge_financial_ledger boolean DEFAULT false
)
RETURNS TABLE (
    purged_checkpoints bigint,
    purged_events bigint,
    purged_outbox bigint,
    purged_ledger_entries bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_temp 必须显式排在末位；函数内所有持久 relation 也必须带 public 前缀，
-- 以避免低权保留执行器通过临时表遮蔽跨租户绕过保留闸门。
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
    v_status text;
    v_billing_state text;
    v_recovery_retention_until timestamptz;
    v_retention_until timestamptz;
    v_manifest_archive_ref text;
    v_manifest_archive_sha256 text;
BEGIN
    IF p_manifest_id IS NULL OR p_archive_ref IS NULL OR char_length(p_archive_ref) = 0
       OR p_archive_sha256 IS NULL OR p_archive_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'retention manifest identity and archive proof are required'
            USING ERRCODE = '22023';
    END IF;
    IF p_purge_financial_ledger THEN
        RAISE EXCEPTION 'financial ledger purge is forbidden in G0/G1; it requires a separate finance retention policy and immutable external archive approval'
            USING ERRCODE = '42501';
    END IF;

    SELECT status, billing_state, recovery_retention_until, retention_until
    INTO v_status, v_billing_state, v_recovery_retention_until, v_retention_until
    FROM public.runs
    WHERE workspace_id = p_workspace_id
      AND id = p_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'run not found for retention'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
       OR v_billing_state <> 'SETTLED'
       OR v_recovery_retention_until IS NULL
       OR v_recovery_retention_until > clock_timestamp()
       OR v_retention_until > clock_timestamp() THEN
        RAISE EXCEPTION 'Run is not terminal, billing-settled, or past its recovery/policy retention horizon'
            USING ERRCODE = '55000';
    END IF;
    IF v_status = 'NEEDS_ATTENTION' AND NOT EXISTS (
        SELECT 1 FROM public.run_billing_reconciliations
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
    ) THEN
        RAISE EXCEPTION 'operator-hold Run lacks immutable reconciliation evidence'
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.credit_reservations
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
          AND status = 'HELD'
    ) THEN
        RAISE EXCEPTION 'cannot purge run with an unsettled reservation'
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.outbox
        WHERE workspace_id = p_workspace_id
          AND run_id = p_run_id
          AND delivery_status IN ('PENDING', 'LEASED')
    ) THEN
        RAISE EXCEPTION 'cannot purge run with pending outbox delivery'
            USING ERRCODE = '55000';
    END IF;

    SELECT archive_ref, archive_sha256
      INTO v_manifest_archive_ref, v_manifest_archive_sha256
      FROM public.run_retention_manifests
     WHERE workspace_id = p_workspace_id
       AND id = p_manifest_id
       AND run_id = p_run_id
       AND verification_status = 'VERIFIED'
       AND approval_status = 'APPROVED';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'pre-existing verified and approved archive manifest not found for Run'
            USING ERRCODE = '55000';
    END IF;
    IF v_manifest_archive_ref IS DISTINCT FROM p_archive_ref
       OR v_manifest_archive_sha256 IS DISTINCT FROM p_archive_sha256 THEN
        RAISE EXCEPTION 'archive ref/hash does not exactly match the approved manifest'
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM public.run_retention_purge_receipts
         WHERE workspace_id = p_workspace_id
           AND run_id = p_run_id
           AND material_kind = 'RECOVERY'
    ) THEN
        RAISE EXCEPTION 'terminal Run recovery material already has an immutable purge receipt'
            USING ERRCODE = '55000';
    END IF;

    DELETE FROM public.run_checkpoints
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id;
    GET DIAGNOSTICS purged_checkpoints = ROW_COUNT;

    DELETE FROM public.run_events
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id;
    GET DIAGNOSTICS purged_events = ROW_COUNT;

    DELETE FROM public.outbox
    WHERE workspace_id = p_workspace_id
      AND run_id = p_run_id
      AND delivery_status IN ('DELIVERED', 'DEAD');
    GET DIAGNOSTICS purged_outbox = ROW_COUNT;

    purged_ledger_entries := 0;

    INSERT INTO public.run_retention_purge_receipts (
        workspace_id,
        run_id,
        manifest_id,
        material_kind,
        purged_checkpoints,
        purged_events,
        purged_outbox,
        financial_ledger_purged
    ) VALUES (
        p_workspace_id,
        p_run_id,
        p_manifest_id,
        'RECOVERY',
        purged_checkpoints,
        purged_events,
        purged_outbox,
        false
    );

    RETURN NEXT;
END;
$$;

ALTER FUNCTION app.purge_terminal_run_material(uuid, uuid, uuid, text, text, boolean)
    OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.purge_terminal_run_material(uuid, uuid, uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_terminal_run_material(uuid, uuid, uuid, text, text, boolean)
    TO ba_retention_executor;

-- 运行和恢复查询索引。
CREATE INDEX published_resource_versions_workspace_kind_idx
    ON published_resource_versions (workspace_id, resource_kind, resource_id, version_ordinal DESC);

CREATE INDEX published_release_visibility_public_idx
    ON published_release_visibility (workspace_id, published_resource_version_id)
    WHERE visibility = 'public' AND revoked_at IS NULL;

CREATE INDEX api_credential_release_grants_lookup_idx
    ON api_credential_release_grants (workspace_id, credential_id, published_resource_version_id)
    WHERE grant_state = 'active' AND revoked_at IS NULL;

CREATE INDEX runs_dispatch_idx
    ON runs (workspace_id, execution_status, next_attempt_at, created_at)
    WHERE execution_status IN ('ACCEPTED', 'QUEUED', 'RETRY_WAIT', 'RECOVERING');

CREATE INDEX runs_retention_idx
    ON runs (workspace_id, retention_until)
    WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION');

CREATE INDEX run_parent_links_parent_walk_idx
    ON run_parent_links (workspace_id, child_run_id, parent_run_id);

CREATE UNIQUE INDEX runs_active_idempotency_key_idx
    ON runs (workspace_id, principal_id, route, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND idempotency_active;

CREATE UNIQUE INDEX run_mutation_idempotencies_active_scope_key_idx
    ON run_mutation_idempotencies (workspace_id, principal_id, route, idempotency_key)
    WHERE idempotency_active;

CREATE INDEX run_mutation_idempotencies_expiry_idx
    ON run_mutation_idempotencies (idempotency_expires_at)
    WHERE idempotency_active;

CREATE UNIQUE INDEX run_attempts_one_active_lease_per_run_idx
    ON run_attempts (workspace_id, run_id)
    WHERE status IN ('LEASED', 'EXECUTING');

CREATE INDEX run_attempts_reclaim_idx
    ON run_attempts (workspace_id, lease_expires_at)
    WHERE status IN ('LEASED', 'EXECUTING');

CREATE INDEX run_steps_run_status_idx
    ON run_steps (workspace_id, run_id, status, created_at);

CREATE INDEX run_events_replay_retention_idx
    ON run_events (workspace_id, run_id, created_at);

CREATE INDEX run_checkpoints_latest_idx
    ON run_checkpoints (workspace_id, run_id, checkpoint_number DESC);

CREATE INDEX outbox_due_idx
    ON outbox (workspace_id, next_attempt_at, created_at)
    WHERE delivery_status IN ('PENDING', 'LEASED');

CREATE INDEX credit_reservations_expiry_idx
    ON credit_reservations (workspace_id, status, expires_at)
    WHERE status = 'HELD';

CREATE INDEX credits_ledger_run_created_idx
    ON credits_ledger (workspace_id, run_id, created_at DESC);

CREATE INDEX credits_ledger_reservation_created_idx
    ON credits_ledger (workspace_id, reservation_id, created_at DESC)
    WHERE reservation_id IS NOT NULL;

CREATE INDEX run_retention_manifests_run_created_idx
    ON run_retention_manifests (workspace_id, run_id, created_at DESC);

CREATE INDEX run_retention_purge_receipts_run_purged_idx
    ON run_retention_purge_receipts (workspace_id, run_id, purged_at DESC);

-- 每张租户表都启用并强制 RLS。只有 001 的认证函数建立了经过验证的
-- app.tenant_context 时，app.current_workspace_id() 才会返回 tenant；调用者
-- 自行 SET 的 app.workspace_id 不参与 policy。
ALTER TABLE published_resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_resource_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY published_resource_versions_workspace_isolation ON published_resource_versions
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE published_release_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_release_visibility FORCE ROW LEVEL SECURITY;
CREATE POLICY published_release_visibility_workspace_isolation ON published_release_visibility
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE api_credential_release_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_credential_release_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY api_credential_release_grants_workspace_isolation ON api_credential_release_grants
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
CREATE POLICY runs_workspace_isolation ON runs
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY runs_retention_access ON runs
    FOR ALL TO ba_retention
    USING (true)
    WITH CHECK (true);
CREATE POLICY runs_archive_evidence_read ON runs
    FOR SELECT TO ba_archive_evidence_owner
    USING (true);

ALTER TABLE run_parent_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_parent_links FORCE ROW LEVEL SECURITY;
CREATE POLICY run_parent_links_billing_control ON run_parent_links
    FOR ALL TO ba_billing_owner
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY run_parent_links_phase_owner_read ON run_parent_links
    FOR SELECT TO ba_metering_owner, ba_finalizer_owner
    USING (workspace_id = app.current_workspace_id());

ALTER TABLE run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_attempts_workspace_isolation ON run_attempts
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY run_steps_workspace_isolation ON run_steps
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY run_events_runtime_read ON run_events
    FOR SELECT TO ba_runtime
    USING (workspace_id = app.current_workspace_id());
-- ba_runtime has no raw INSERT policy. Its progress events must go through
-- app.append_runtime_run_event(), whose allowlist excludes terminal, cancel,
-- credit and outbox authority events.
CREATE POLICY run_events_control_read ON run_events
    FOR SELECT TO ba_billing_owner
    USING (workspace_id = app.current_workspace_id());
CREATE POLICY run_events_control_append ON run_events
    FOR INSERT TO ba_billing_owner
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY run_events_finalizer_read ON run_events
    FOR SELECT TO ba_finalizer_owner
    USING (workspace_id = app.current_workspace_id());
CREATE POLICY run_events_finalizer_append ON run_events
    FOR INSERT TO ba_finalizer_owner
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY run_events_retention_delete ON run_events
    FOR DELETE TO ba_retention
    USING (true);

ALTER TABLE run_mutation_idempotencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_mutation_idempotencies FORCE ROW LEVEL SECURITY;
-- The API reaches this table only through request_run_cancellation(). A normal
-- runtime role has no raw SELECT path that could enumerate another principal's
-- idempotency keys; the SECURITY DEFINER owner remains constrained by tenant
-- context and the function's explicit readable-Run check.
CREATE POLICY run_mutation_idempotencies_billing_control ON run_mutation_idempotencies
    FOR ALL TO ba_billing_owner
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY run_mutation_idempotencies_retention_read ON run_mutation_idempotencies
    FOR SELECT TO ba_retention
    USING (true);
CREATE POLICY run_mutation_idempotencies_retention_extend ON run_mutation_idempotencies
    FOR UPDATE TO ba_retention
    USING (true)
    WITH CHECK (true);
CREATE POLICY run_mutation_idempotencies_retention_delete ON run_mutation_idempotencies
    FOR DELETE TO ba_retention
    USING (idempotency_expires_at <= clock_timestamp());

ALTER TABLE run_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY run_checkpoints_workspace_isolation ON run_checkpoints
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY run_checkpoints_retention_access ON run_checkpoints
    FOR ALL TO ba_retention
    USING (true)
    WITH CHECK (true);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_workspace_isolation ON outbox
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY outbox_retention_access ON outbox
    FOR ALL TO ba_retention
    USING (true)
    WITH CHECK (true);

ALTER TABLE credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_reservations_workspace_isolation ON credit_reservations
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY credit_reservations_retention_read ON credit_reservations
    FOR SELECT TO ba_retention
    USING (true);

ALTER TABLE credits_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY credits_ledger_runtime_read ON credits_ledger
    FOR SELECT TO ba_runtime
    USING (workspace_id = app.current_workspace_id());
CREATE POLICY credits_ledger_billing_read ON credits_ledger
    FOR SELECT TO ba_billing_owner
    USING (workspace_id = app.current_workspace_id());
CREATE POLICY credits_ledger_billing_append ON credits_ledger
    FOR INSERT TO ba_billing_owner
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY credits_ledger_phase_owner_read ON credits_ledger
    FOR SELECT TO ba_admission_owner, ba_metering_owner, ba_finalizer_owner,
                  ba_reconciliation_owner
    USING (workspace_id = app.current_workspace_id());
CREATE POLICY credits_ledger_phase_owner_append ON credits_ledger
    FOR INSERT TO ba_admission_owner, ba_metering_owner, ba_finalizer_owner,
                  ba_reconciliation_owner
    WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE run_billing_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_billing_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY run_billing_reconciliations_owner_access
    ON run_billing_reconciliations
    FOR ALL TO ba_reconciliation_owner
    USING (workspace_id = app.current_workspace_id())
    WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY run_billing_reconciliations_retention_read
    ON run_billing_reconciliations
    FOR SELECT TO ba_retention
    USING (true);
ALTER TABLE run_retention_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_retention_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY run_retention_manifests_retention_read ON run_retention_manifests
    FOR SELECT TO ba_retention
    USING (true);
CREATE POLICY run_retention_manifests_archive_append ON run_retention_manifests
    FOR INSERT TO ba_archive_evidence_owner
    WITH CHECK (true);

ALTER TABLE run_retention_purge_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_retention_purge_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_retention_purge_receipts_retention_read ON run_retention_purge_receipts
    FOR SELECT TO ba_retention
    USING (true);
CREATE POLICY run_retention_purge_receipts_retention_append ON run_retention_purge_receipts
    FOR INSERT TO ba_retention
    WITH CHECK (true);

-- Privileges reinforce the RLS shape. ba_runtime reads events and invokes the
-- narrow runtime append function, but has no raw INSERT/UPDATE/DELETE path.
-- Admission, metering and finalizer executors have function EXECUTE only. Their
-- mutually non-inheriting NOLOGIN owners receive just the table columns needed
-- by those SECURITY DEFINER functions; no owner is a deployable login.
REVOKE ALL ON TABLE run_events FROM PUBLIC;
REVOKE ALL ON TABLE run_mutation_idempotencies FROM PUBLIC;
REVOKE ALL ON TABLE run_parent_links FROM PUBLIC;
REVOKE ALL ON TABLE credits_ledger FROM PUBLIC;
REVOKE ALL ON TABLE run_billing_reconciliations FROM PUBLIC;
REVOKE ALL ON TABLE run_retention_manifests FROM PUBLIC;
REVOKE ALL ON TABLE run_retention_purge_receipts FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE run_events FROM ba_runtime;
GRANT SELECT ON TABLE run_events TO ba_runtime;
GRANT SELECT, INSERT ON TABLE run_events TO ba_billing_owner;
GRANT SELECT, INSERT ON TABLE run_events TO ba_finalizer_owner;
GRANT SELECT, DELETE ON TABLE run_events TO ba_retention;

REVOKE INSERT, UPDATE, DELETE ON TABLE run_mutation_idempotencies FROM ba_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE run_mutation_idempotencies TO ba_billing_owner;
GRANT SELECT, UPDATE (idempotency_expires_at, idempotency_active), DELETE
    ON TABLE run_mutation_idempotencies TO ba_retention;

REVOKE INSERT, UPDATE, DELETE ON TABLE run_parent_links
    FROM ba_runtime, ba_control_executor;
REVOKE INSERT ON TABLE run_parent_links FROM ba_billing_owner;
GRANT SELECT ON TABLE run_parent_links TO ba_billing_owner;
GRANT SELECT ON TABLE run_parent_links TO ba_metering_owner, ba_finalizer_owner;

REVOKE INSERT, UPDATE, DELETE ON TABLE credits_ledger FROM ba_runtime;
GRANT SELECT ON TABLE credits_ledger TO ba_runtime;
GRANT SELECT, INSERT ON TABLE credits_ledger TO ba_billing_owner;
GRANT SELECT, INSERT ON TABLE credits_ledger
    TO ba_admission_owner, ba_metering_owner, ba_finalizer_owner,
       ba_reconciliation_owner;
REVOKE INSERT, UPDATE, DELETE ON TABLE credits_ledger FROM ba_retention;

REVOKE INSERT, UPDATE, DELETE ON TABLE credit_reservations FROM ba_runtime;
GRANT SELECT ON TABLE credit_reservations TO ba_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE credit_reservations TO ba_billing_owner;
GRANT SELECT, INSERT ON TABLE credit_reservations TO ba_admission_owner;
GRANT SELECT ON TABLE credit_reservations TO ba_metering_owner, ba_finalizer_owner;
GRANT UPDATE (
    settled_credits, released_credits, balance_version, status, settled_at,
    released_at, status_reason_code, updated_at
) ON TABLE credit_reservations TO ba_metering_owner, ba_finalizer_owner;
GRANT SELECT, UPDATE (
    settled_credits, released_credits, balance_version, status, settled_at,
    released_at, status_reason_code, updated_at
) ON TABLE credit_reservations TO ba_reconciliation_owner;
GRANT SELECT, UPDATE (credits_balance, credits_reserved_balance, credits_balance_version, updated_at)
    ON TABLE workspaces TO ba_billing_owner;
GRANT SELECT, UPDATE (credits_balance, credits_reserved_balance, credits_balance_version, updated_at)
    ON TABLE workspaces TO ba_admission_owner, ba_metering_owner, ba_finalizer_owner;
GRANT SELECT, UPDATE (credits_balance, credits_reserved_balance, credits_balance_version, updated_at)
    ON TABLE workspaces TO ba_reconciliation_owner;
GRANT SELECT, UPDATE ON TABLE runs TO ba_billing_owner;
GRANT SELECT ON TABLE runs TO ba_admission_owner;
GRANT SELECT ON TABLE runs TO ba_metering_owner, ba_finalizer_owner;
GRANT SELECT, UPDATE (billing_state, billing_settled_at, updated_at)
    ON TABLE runs TO ba_reconciliation_owner;
GRANT UPDATE (billing_state, billing_settled_at, updated_at)
    ON TABLE runs TO ba_metering_owner;
GRANT UPDATE (
    status, execution_status, status_reason_code, termination_reason,
    finished_at, terminal_billing_pending, terminal_billing_pending_at,
    terminal_result_redacted, terminal_error_redacted,
    terminal_event_id, terminal_event_sequence,
    events_retention_until, recovery_retention_until, retention_until,
    billing_state, billing_settled_at, updated_at
) ON TABLE runs TO ba_finalizer_owner;
GRANT SELECT ON TABLE run_attempts, run_steps TO ba_metering_owner;
GRANT SELECT ON TABLE run_attempts, run_steps TO ba_finalizer_owner;
GRANT UPDATE (
    status, failure_class, failure_code, lease_owner, lease_token,
    lease_expires_at, finished_at, updated_at
) ON TABLE run_attempts TO ba_finalizer_owner;
GRANT UPDATE (status, requires_manual_review, finished_at, updated_at)
    ON TABLE run_steps TO ba_finalizer_owner;
GRANT INSERT ON TABLE outbox TO ba_finalizer_owner;
GRANT INSERT ON TABLE outbox TO ba_reconciliation_owner;
GRANT SELECT, INSERT ON TABLE run_billing_reconciliations
    TO ba_reconciliation_owner;
REVOKE UPDATE, DELETE ON TABLE run_billing_reconciliations
    FROM ba_reconciliation_owner;
GRANT SELECT ON TABLE run_billing_reconciliations TO ba_retention;
GRANT USAGE ON SCHEMA app TO
    ba_admission_owner, ba_metering_owner, ba_finalizer_owner,
    ba_reconciliation_owner,
    ba_admission_executor, ba_metering_executor, ba_finalizer_executor,
    ba_reconciliation_executor;

-- Defense in depth: phase executors never receive raw financial/terminal DML,
-- and ordinary runtime never receives any phase mutation function above.
REVOKE INSERT, UPDATE, DELETE ON TABLE
    workspaces, runs, run_attempts, run_steps, run_events, outbox,
    credit_reservations, credits_ledger, run_billing_reconciliations
    FROM ba_admission_executor, ba_metering_executor, ba_finalizer_executor,
         ba_reconciliation_executor;

-- Publish/credential-release authorization facts are mutated only through the
-- reviewed control-plane path. The epoch triggers above still defend against a
-- mistakenly privileged management role; ba_runtime never gets raw DML.
ALTER TABLE published_resource_versions OWNER TO ba_authorization_owner;
ALTER FUNCTION app.prevent_published_resource_version_mutation() OWNER TO ba_authorization_owner;
REVOKE ALL ON TABLE published_resource_versions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE published_resource_versions
    FROM ba_runtime, ba_billing_owner, ba_control_executor;
GRANT SELECT ON TABLE published_resource_versions
    TO ba_runtime, ba_billing_owner, ba_control_executor;
REVOKE INSERT, UPDATE, DELETE ON TABLE published_release_visibility FROM ba_runtime;
REVOKE INSERT, UPDATE, DELETE ON TABLE api_credential_release_grants FROM ba_runtime;
REVOKE ALL ON FUNCTION app.bump_published_release_visibility_epoch_before_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_published_release_visibility_epoch_after_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.bump_api_credential_release_grant_epoch_before_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_api_credential_release_grant_epoch_after_write() FROM PUBLIC;

GRANT SELECT, DELETE ON TABLE run_checkpoints TO ba_retention;
GRANT SELECT, DELETE ON TABLE outbox TO ba_retention;
GRANT SELECT, UPDATE (idempotency_expires_at, idempotency_active)
    ON TABLE runs TO ba_retention;
GRANT USAGE ON SCHEMA app TO
    ba_retention,
    ba_retention_executor,
    ba_archive_evidence_owner,
    ba_archive_evidence_executor;
GRANT SELECT (workspace_id, id, status)
    ON TABLE runs TO ba_archive_evidence_owner;
REVOKE INSERT, UPDATE, DELETE ON TABLE run_retention_manifests
    FROM ba_retention, ba_retention_executor, ba_runtime, ba_control_executor,
         ba_archive_evidence_executor;
GRANT SELECT ON TABLE run_retention_manifests TO ba_retention;
GRANT INSERT ON TABLE run_retention_manifests TO ba_archive_evidence_owner;
REVOKE UPDATE, DELETE ON TABLE run_retention_manifests
    FROM ba_archive_evidence_owner;
REVOKE ALL ON TABLE run_retention_purge_receipts
    FROM ba_retention_executor, ba_archive_evidence_owner,
         ba_archive_evidence_executor, ba_runtime, ba_control_executor;
GRANT SELECT, INSERT ON TABLE run_retention_purge_receipts TO ba_retention;
REVOKE ALL ON FUNCTION app.register_verified_run_archive_manifest(
    uuid, uuid, uuid, text, text, text, text, text, text, timestamptz, timestamptz
) FROM ba_retention, ba_retention_executor;
REVOKE ALL ON FUNCTION app.purge_terminal_run_material(
    uuid, uuid, uuid, text, text, boolean
) FROM ba_archive_evidence_owner, ba_archive_evidence_executor;
REVOKE ALL ON FUNCTION app.purge_terminal_run_events(
    uuid, uuid, uuid, text, text
) FROM ba_archive_evidence_owner, ba_archive_evidence_executor;

COMMIT;
