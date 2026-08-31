-- G0-07 installs the protocol-v5 execution authority plane. The migration is
-- intentionally fail-closed: only fully settled, non-recoverable G0-06 history
-- may cross the boundary, and every in-flight writer makes the NOWAIT gate fail.
LOCK TABLE
  public.workspaces,
  public.conversations,
  public.conversation_states,
  public.conversation_messages,
  public.run_idempotency_sentinels,
  public.runs,
  public.run_acceptance_receipts,
  public.run_mutation_idempotency,
  public.run_attempts,
  public.run_steps,
  public.run_events,
  public.run_checkpoints,
  public.human_gates,
  public.outbox,
  public.run_parent_links,
  public.credit_reservations,
  public.credits_ledger,
  public.run_budget_allocations,
  public.run_billing_reconciliations,
  public.run_archive_manifests,
  public.run_archive_verification_receipts,
  public.run_archive_approval_receipts,
  public.run_retention_purge_receipts
IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $g007_platform_prerequisites$
DECLARE
  v_missing_roles text;
  v_bad_roles text;
  v_bad_legacy_relations text;
BEGIN
  SELECT string_agg(required_role, ', ' ORDER BY required_role)
    INTO v_missing_roles
    FROM unnest(ARRAY[
      'ba_migrator',
      'ba_auth_owner',
      'ba_authorization_owner',
      'ba_run_owner',
      'ba_billing_owner',
      'ba_archive_evidence_owner',
      'ba_retention',
      'ba_runtime',
      'ba_control_executor',
      'ba_management_attestation_issuer',
      'ba_subject_assertion_verifier',
      'ba_internal_service_attestation_issuer',
      'ba_admission_executor',
      'ba_execution_executor',
      'ba_metering_executor',
      'ba_finalizer_executor',
      'ba_reclaimer_executor',
      'ba_reconciliation_executor',
      'ba_archive_evidence_executor',
      'ba_retention_executor'
    ]::text[]) AS required(required_role)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = required.required_role
   );
  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'missing G0-07 platform roles: %', v_missing_roles
      USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(role_row.rolname, ', ' ORDER BY role_row.rolname)
    INTO v_bad_roles
    FROM pg_catalog.pg_roles AS role_row
   WHERE role_row.rolname = ANY (ARRAY[
     'ba_internal_service_attestation_issuer',
     'ba_admission_executor',
     'ba_execution_executor',
     'ba_metering_executor',
     'ba_finalizer_executor',
     'ba_reclaimer_executor',
     'ba_reconciliation_executor',
     'ba_archive_evidence_executor',
     'ba_retention_executor'
   ]::name[])
     AND (
       role_row.rolcanlogin
       OR role_row.rolinherit
       OR role_row.rolsuper
       OR role_row.rolcreatedb
       OR role_row.rolcreaterole
       OR role_row.rolreplication
       OR role_row.rolbypassrls
     );
  IF v_bad_roles IS NOT NULL THEN
    RAISE EXCEPTION 'invalid G0-07 isolated role attributes: %', v_bad_roles
      USING ERRCODE = '42501';
  END IF;

  IF current_user IS DISTINCT FROM session_user
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS session_role
       WHERE session_role.rolname = session_user
         AND session_role.rolcanlogin
         AND session_role.rolinherit
         AND NOT session_role.rolsuper
         AND NOT session_role.rolcreatedb
         AND NOT session_role.rolcreaterole
         AND NOT session_role.rolreplication
         AND NOT session_role.rolbypassrls
     ) THEN
    RAISE EXCEPTION 'application migrations require an unprivileged LOGIN+INHERIT session_user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
     WHERE granted_role.rolname = 'ba_migrator'
       AND member_role.rolname = session_user
       AND membership.inherit_option
  ) THEN
    RAISE EXCEPTION 'session_user must be a direct inheriting ba_migrator member'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = ANY (ARRAY[
      'ba_internal_service_attestation_issuer',
      'ba_admission_executor',
      'ba_execution_executor',
      'ba_metering_executor',
      'ba_finalizer_executor',
      'ba_reclaimer_executor',
      'ba_reconciliation_executor',
      'ba_archive_evidence_executor',
      'ba_retention_executor'
    ]::name[])
       OR (
         granted_role.rolname = ANY (ARRAY[
           'ba_internal_service_attestation_issuer',
           'ba_admission_executor',
           'ba_execution_executor',
           'ba_metering_executor',
           'ba_finalizer_executor',
           'ba_reclaimer_executor',
           'ba_reconciliation_executor',
           'ba_archive_evidence_executor',
           'ba_retention_executor'
         ]::name[])
         AND NOT member_role.rolcanlogin
       )
  ) THEN
    RAISE EXCEPTION 'G0-07 phase roles must not inherit legacy or peer capabilities'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS login_role
    WHERE login_role.rolcanlogin
      AND NOT login_role.rolsuper
      AND (
        SELECT count(*)
        FROM pg_catalog.pg_roles AS phase_role
        WHERE phase_role.rolname = ANY (ARRAY[
          'ba_internal_service_attestation_issuer',
          'ba_admission_executor',
          'ba_execution_executor',
          'ba_metering_executor',
          'ba_finalizer_executor',
          'ba_reclaimer_executor',
          'ba_reconciliation_executor',
          'ba_archive_evidence_executor',
          'ba_retention_executor'
        ]::name[])
          AND pg_catalog.pg_has_role(login_role.oid, phase_role.oid, 'MEMBER')
      ) > 1
  ) THEN
    RAISE EXCEPTION 'LOGIN roles may inherit at most one G0-07 phase capability'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS login_role
    WHERE login_role.rolcanlogin
      AND NOT login_role.rolsuper
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS phase_role
        WHERE phase_role.rolname = ANY (ARRAY[
          'ba_internal_service_attestation_issuer',
          'ba_admission_executor',
          'ba_execution_executor',
          'ba_metering_executor',
          'ba_finalizer_executor',
          'ba_reclaimer_executor',
          'ba_reconciliation_executor',
          'ba_archive_evidence_executor',
          'ba_retention_executor'
        ]::name[])
          AND pg_catalog.pg_has_role(login_role.oid, phase_role.oid, 'MEMBER')
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS forbidden_role
        WHERE forbidden_role.rolname = ANY (ARRAY[
          'ba_migrator',
          'ba_runtime',
          'ba_control_executor',
          'ba_management_attestation_issuer',
          'ba_subject_assertion_verifier',
          'ba_auth_owner',
          'ba_authorization_owner',
          'ba_run_owner',
          'ba_billing_owner',
          'ba_archive_evidence_owner',
          'ba_retention'
        ]::name[])
          AND pg_catalog.pg_has_role(login_role.oid, forbidden_role.oid, 'MEMBER')
      )
  ) THEN
    RAISE EXCEPTION 'G0-07 phase LOGIN overlaps a legacy executable or owner capability'
      USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(
           format('%I.%I expected owner %I with ENABLE+FORCE RLS',
             expected.schema_name, expected.relation_name, expected.owner_name),
           ', ' ORDER BY expected.schema_name, expected.relation_name
         )
    INTO v_bad_legacy_relations
    FROM (
      VALUES
        ('public', 'runs', 'ba_run_owner'),
        ('public', 'run_attempts', 'ba_run_owner'),
        ('public', 'outbox', 'ba_run_owner'),
        ('public', 'credit_reservations', 'ba_billing_owner'),
        ('public', 'run_budget_allocations', 'ba_billing_owner'),
        ('public', 'credits_ledger', 'ba_billing_owner'),
        ('public', 'run_billing_reconciliations', 'ba_billing_owner')
    ) AS expected(schema_name, relation_name, owner_name)
    LEFT JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.nspname = expected.schema_name
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.relation_name
     AND relation.relkind = 'r'
    LEFT JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = relation.relowner
   WHERE relation.oid IS NULL
      OR owner_role.rolname::text IS DISTINCT FROM expected.owner_name
      OR NOT relation.relrowsecurity
      OR NOT relation.relforcerowsecurity;
  IF v_bad_legacy_relations IS NOT NULL THEN
    RAISE EXCEPTION 'through-004 FORCE-RLS owner prerequisite drift: %',
      v_bad_legacy_relations USING ERRCODE = '55000';
  END IF;
END;
$g007_platform_prerequisites$;

-- The through-004 facts are FORCE RLS and their policies require a signed
-- tenant context. A migration cannot fabricate that authority. With the full
-- inventory already locked, assume each exact NOLOGIN owner and temporarily
-- remove only FORCE (RLS remains enabled) so the owner can inspect every row.
-- These catalog changes are restored before persistent 005 DDL/data work and
-- roll back with the migration if any fail-closed guard rejects the upgrade.
SET LOCAL ROLE ba_run_owner;
ALTER TABLE public.runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outbox NO FORCE ROW LEVEL SECURITY;

DO $g007_legacy_run_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.runs AS run_row
     WHERE run_row.status NOT IN (
       'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION'
     )
        OR run_row.billing_state <> 'SETTLED'
  ) OR EXISTS (
    SELECT 1 FROM public.run_attempts AS attempt
     WHERE attempt.status IN ('PENDING', 'RUNNING')
        OR attempt.lease_owner IS NOT NULL
        OR attempt.lease_token IS NOT NULL
        OR attempt.lease_expires_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.outbox AS message WHERE message.status <> 'DELIVERED'
  ) THEN
    RAISE EXCEPTION '005 requires quiescent terminal, settled and delivered G0-06 history'
      USING ERRCODE = '55000';
  END IF;
END;
$g007_legacy_run_guard$;

ALTER TABLE public.runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE ROW LEVEL SECURITY;
RESET ROLE;

SET LOCAL ROLE ba_billing_owner;
ALTER TABLE public.credit_reservations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_budget_allocations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.credits_ledger NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_billing_reconciliations NO FORCE ROW LEVEL SECURITY;

DO $g007_legacy_guard$
DECLARE
  v_safe_max constant bigint := 9007199254740991;
  v_ledger record;
  v_intent jsonb;
  v_canonical_intent text;
  v_expected_intent_hash text;
  v_expires_at text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.credit_reservations AS reservation
     WHERE reservation.status = 'HELD'
        OR reservation.settled_credits + reservation.released_credits
             <> reservation.reserved_credits
  ) OR EXISTS (
    SELECT 1 FROM public.run_budget_allocations AS allocation
     WHERE allocation.status = 'ACTIVE'
        OR allocation.settled_credits + allocation.released_credits
             <> allocation.allocated_credits
  ) THEN
    RAISE EXCEPTION '005 requires quiescent terminal, settled and delivered G0-06 history'
      USING ERRCODE = '55000';
  END IF;

  -- 004 accepted caller-computed hashes. Before protocol-v5 schema expansion,
  -- ownership transfer or data backfill, reconstruct every closed V1 intent
  -- and prove that the persisted ledger is the exact CreditLedgerEntryV1
  -- projection of that intent. This intentionally
  -- fails closed when a timestamptz cannot be losslessly represented by the
  -- database-owned UTC millisecond profile used for legacy reconstruction.
  FOR v_ledger IN
    SELECT
      ledger.*,
      reservation.accepted_plan_hash AS reservation_accepted_plan_hash,
      reservation.expires_at AS reservation_expires_at,
      reconciliation.id AS reconciliation_id,
      reconciliation.billing_intent_hash AS reconciliation_billing_intent_hash,
      reconciliation.evidence_ref AS reconciliation_evidence_ref,
      reconciliation.evidence_sha256 AS reconciliation_evidence_sha256,
      reconciliation.settled_credits AS reconciliation_settled_credits,
      reconciliation.released_credits AS reconciliation_released_credits
    FROM public.credits_ledger AS ledger
    LEFT JOIN public.credit_reservations AS reservation
      ON reservation.workspace_id = ledger.workspace_id
     AND reservation.id = ledger.reservation_id
     AND reservation.run_id = ledger.run_id
     AND reservation.billing_owner_run_id = ledger.billing_owner_run_id
    LEFT JOIN public.run_billing_reconciliations AS reconciliation
      ON reconciliation.workspace_id = ledger.workspace_id
     AND reconciliation.ledger_entry_id = ledger.id
     AND reconciliation.run_id = ledger.run_id
     AND reconciliation.billing_owner_run_id = ledger.billing_owner_run_id
    ORDER BY ledger.workspace_id, ledger.id
  LOOP
    IF v_ledger.reservation_accepted_plan_hash IS NULL
       OR v_ledger.reservation_accepted_plan_hash !~ '^sha256:[0-9a-f]{64}$'
       OR v_ledger.billing_owner_run_id IS DISTINCT FROM v_ledger.run_id
       OR v_ledger.billing_intent_hash !~ '^sha256:[0-9a-f]{64}$'
       OR v_ledger.charge_attribution_hash !~ '^sha256:[0-9a-f]{64}$'
       OR length(v_ledger.charge_key) NOT BETWEEN 1 AND 300
       OR v_ledger.balance_version NOT BETWEEN 0 AND v_safe_max
       OR jsonb_typeof(v_ledger.metering_detail_redacted) <> 'object'
       OR NOT pg_catalog.isfinite(v_ledger.created_at)
       OR extract(year FROM v_ledger.created_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
       OR (v_ledger.step_id IS NOT NULL AND v_ledger.producer_attempt_id IS NULL)
       OR v_ledger.balance_after::numeric IS DISTINCT FROM
            v_ledger.balance_before::numeric + v_ledger.available_delta_credits::numeric
       OR v_ledger.reserved_after::numeric IS DISTINCT FROM
            v_ledger.reserved_before::numeric + v_ledger.reserved_delta_credits::numeric
       OR NOT (
         (
           v_ledger.entry_kind = 'RESERVE'
           AND v_ledger.producer_run_id = v_ledger.run_id
           AND v_ledger.producer_attempt_id IS NULL
           AND v_ledger.producer_lease_fencing_token IS NULL
           AND v_ledger.step_id IS NULL
           AND v_ledger.available_delta_credits <= 0
           AND v_ledger.reserved_delta_credits >= 0
           AND v_ledger.settled_delta_credits = 0
           AND v_ledger.available_delta_credits = -v_ledger.reserved_delta_credits
         ) OR (
           v_ledger.entry_kind = 'SETTLE'
           AND v_ledger.producer_attempt_id IS NOT NULL
           AND v_ledger.producer_lease_fencing_token BETWEEN 1 AND v_safe_max
           AND v_ledger.available_delta_credits = 0
           AND v_ledger.reserved_delta_credits = -v_ledger.settled_delta_credits
           AND v_ledger.settled_delta_credits >= 0
         ) OR (
           v_ledger.entry_kind IN ('RELEASE', 'EXPIRED')
           AND (
             (
               v_ledger.entry_kind = 'RELEASE'
               AND v_ledger.producer_attempt_id IS NOT NULL
               AND v_ledger.producer_lease_fencing_token BETWEEN 1 AND v_safe_max
             ) OR (
               v_ledger.entry_kind = 'EXPIRED'
               AND v_ledger.producer_run_id = v_ledger.run_id
               AND v_ledger.producer_attempt_id IS NULL
               AND v_ledger.producer_lease_fencing_token IS NULL
               AND v_ledger.step_id IS NULL
             )
           )
           AND v_ledger.available_delta_credits >= 0
           AND v_ledger.settled_delta_credits = 0
           AND v_ledger.reserved_delta_credits = -v_ledger.available_delta_credits
         ) OR (
           v_ledger.entry_kind = 'RECONCILIATION'
           AND v_ledger.producer_run_id = v_ledger.run_id
           AND v_ledger.producer_attempt_id IS NULL
           AND v_ledger.producer_lease_fencing_token IS NULL
           AND v_ledger.step_id IS NULL
           AND v_ledger.available_delta_credits >= 0
           AND v_ledger.settled_delta_credits >= 0
           AND v_ledger.reserved_delta_credits <= 0
           AND v_ledger.available_delta_credits::numeric
                 + v_ledger.settled_delta_credits::numeric
               = -v_ledger.reserved_delta_credits::numeric
         )
       ) THEN
      RAISE EXCEPTION
        'through-004 ledger does not satisfy CreditLedgerEntryV1: workspace %, ledger %',
        v_ledger.workspace_id, v_ledger.id
        USING ERRCODE = '55000';
    END IF;

    v_intent := jsonb_build_object(
      'schema_version', 'billing-intent/1',
      'intent_kind', v_ledger.entry_kind,
      'workspace_id', v_ledger.workspace_id::text,
      'billing_owner_run_id', v_ledger.billing_owner_run_id::text,
      'reservation_id', v_ledger.reservation_id::text,
      'charge_key', v_ledger.charge_key
    );
    CASE v_ledger.entry_kind
      WHEN 'RESERVE' THEN
        IF v_ledger.charge_attribution_hash IS DISTINCT FROM
             v_ledger.reservation_accepted_plan_hash
           OR NOT pg_catalog.isfinite(v_ledger.reservation_expires_at)
           OR date_trunc('milliseconds', v_ledger.reservation_expires_at)
                IS DISTINCT FROM v_ledger.reservation_expires_at THEN
          RAISE EXCEPTION
            'through-004 ledger does not satisfy CreditLedgerEntryV1: workspace %, ledger %',
            v_ledger.workspace_id, v_ledger.id
            USING ERRCODE = '55000';
        END IF;
        v_expires_at := to_char(
          v_ledger.reservation_expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        );
        v_intent := v_intent || jsonb_build_object(
          'amount_credits', v_ledger.reserved_delta_credits::text,
          'accepted_plan_hash', v_ledger.reservation_accepted_plan_hash,
          'expires_at', v_expires_at
        );
      WHEN 'SETTLE' THEN
        v_intent := v_intent || jsonb_build_object(
          'producer_run_id', v_ledger.producer_run_id::text,
          'producer_attempt_id', v_ledger.producer_attempt_id::text,
          'producer_lease_fencing_token', v_ledger.producer_lease_fencing_token,
          'amount_credits', v_ledger.settled_delta_credits::text,
          'charge_attribution_hash', v_ledger.charge_attribution_hash
        ) || CASE WHEN v_ledger.step_id IS NULL THEN '{}'::jsonb ELSE
          jsonb_build_object('step_id', v_ledger.step_id::text) END;
      WHEN 'RELEASE' THEN
        v_intent := v_intent || jsonb_build_object(
          'producer_run_id', v_ledger.producer_run_id::text,
          'producer_attempt_id', v_ledger.producer_attempt_id::text,
          'producer_lease_fencing_token', v_ledger.producer_lease_fencing_token,
          'amount_credits', v_ledger.available_delta_credits::text,
          'charge_attribution_hash', v_ledger.charge_attribution_hash
        ) || CASE WHEN v_ledger.step_id IS NULL THEN '{}'::jsonb ELSE
          jsonb_build_object('step_id', v_ledger.step_id::text) END;
      WHEN 'EXPIRED' THEN
        IF NOT pg_catalog.isfinite(v_ledger.reservation_expires_at)
           OR date_trunc('milliseconds', v_ledger.reservation_expires_at)
                IS DISTINCT FROM v_ledger.reservation_expires_at THEN
          RAISE EXCEPTION
            'through-004 ledger does not satisfy CreditLedgerEntryV1: workspace %, ledger %',
            v_ledger.workspace_id, v_ledger.id
            USING ERRCODE = '55000';
        END IF;
        v_expires_at := to_char(
          v_ledger.reservation_expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        );
        v_intent := v_intent || jsonb_build_object(
          'remaining_credits', v_ledger.available_delta_credits::text,
          'expires_at', v_expires_at,
          'charge_attribution_hash', v_ledger.charge_attribution_hash
        );
      WHEN 'RECONCILIATION' THEN
        IF v_ledger.reconciliation_id IS NULL
           OR v_ledger.reconciliation_billing_intent_hash IS DISTINCT FROM
                v_ledger.billing_intent_hash
           OR v_ledger.reconciliation_settled_credits IS DISTINCT FROM
                v_ledger.settled_delta_credits
           OR v_ledger.reconciliation_released_credits IS DISTINCT FROM
                v_ledger.available_delta_credits
           OR v_ledger.reconciliation_evidence_sha256 IS DISTINCT FROM
                v_ledger.charge_attribution_hash
           OR length(v_ledger.reconciliation_evidence_ref) NOT BETWEEN 1 AND 2048
           OR position('?' IN v_ledger.reconciliation_evidence_ref) <> 0
           OR position('#' IN v_ledger.reconciliation_evidence_ref) <> 0 THEN
          RAISE EXCEPTION
            'through-004 ledger does not satisfy CreditLedgerEntryV1: workspace %, ledger %',
            v_ledger.workspace_id, v_ledger.id
            USING ERRCODE = '55000';
        END IF;
        v_intent := v_intent || jsonb_build_object(
          'reconciliation_id', v_ledger.reconciliation_id::text,
          'release_credits', v_ledger.reconciliation_released_credits::text,
          'settle_credits', v_ledger.reconciliation_settled_credits::text,
          'evidence_ref', v_ledger.reconciliation_evidence_ref,
          'evidence_sha256', v_ledger.reconciliation_evidence_sha256
        );
      ELSE
        RAISE EXCEPTION
          'through-004 ledger does not satisfy CreditLedgerEntryV1: workspace %, ledger %',
          v_ledger.workspace_id, v_ledger.id
          USING ERRCODE = '55000';
    END CASE;

    SELECT '{' || string_agg(
      to_json(intent_field.key)::text || ':' || CASE jsonb_typeof(intent_field.value)
        WHEN 'string' THEN to_json(intent_field.value #>> '{}')::text
        WHEN 'number' THEN intent_field.value::text
        ELSE NULL
      END,
      ',' ORDER BY intent_field.key COLLATE "C"
    ) || '}'
    INTO v_canonical_intent
    FROM jsonb_each(v_intent) AS intent_field;
    IF v_canonical_intent IS NULL
       OR EXISTS (
         SELECT 1 FROM jsonb_each(v_intent) AS intent_field
         WHERE jsonb_typeof(intent_field.value) NOT IN ('string', 'number')
       ) THEN
      RAISE EXCEPTION
        'through-004 BillingIntentV1 canonical projection failed: workspace %, ledger %',
        v_ledger.workspace_id, v_ledger.id
        USING ERRCODE = '55000';
    END IF;
    v_expected_intent_hash := 'sha256:' || encode(
      public.digest(convert_to(v_canonical_intent, 'UTF8'), 'sha256'),
      'hex'
    );
    IF v_expected_intent_hash IS DISTINCT FROM v_ledger.billing_intent_hash THEN
      RAISE EXCEPTION
        'through-004 ledger BillingIntentV1 hash mismatch: workspace %, ledger %',
        v_ledger.workspace_id, v_ledger.id
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$g007_legacy_guard$;

-- Billing contract versions are JavaScript-safe integers even though credit
-- amounts and balance snapshots remain full PostgreSQL bigint strings. Keep a
-- table-level backstop so inherited and future writers cannot bypass a facade
-- guard and persist an unreadable version.
ALTER TABLE public.credit_reservations
  ADD CONSTRAINT credit_reservations_balance_version_safe_check
    CHECK (balance_version BETWEEN 0 AND 9007199254740991);
ALTER TABLE public.credits_ledger
  ADD CONSTRAINT credits_ledger_balance_version_safe_check
    CHECK (balance_version BETWEEN 0 AND 9007199254740991);

ALTER TABLE public.credit_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_budget_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.credits_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_billing_reconciliations FORCE ROW LEVEL SECURITY;
RESET ROLE;

SET LOCAL ROLE ba_authorization_owner;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_credits_balance_version_safe_check
    CHECK (credits_balance_version BETWEEN 0 AND 9007199254740991);
RESET ROLE;

-- PostgreSQL requires a replacement owner to have CREATE on the containing
-- schema during ALTER OWNER. Keep this capability inside the migration
-- transaction only; the matching REVOKE statements close it after transfer.
GRANT USAGE, CREATE ON SCHEMA app TO
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
GRANT CREATE ON SCHEMA public TO
  ba_run_owner,
  ba_billing_owner;
GRANT USAGE ON SCHEMA auth TO ba_internal_service_attestation_issuer;
-- 004 already grants auth USAGE to ba_run_owner. The other SECURITY DEFINER
-- owners need only name resolution for the 005 phase-proof capability.
GRANT USAGE ON SCHEMA auth TO
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
GRANT USAGE ON SCHEMA app, auth TO
  ba_admission_executor,
  ba_execution_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reclaimer_executor,
  ba_reconciliation_executor,
  ba_archive_evidence_executor,
  ba_retention_executor;

-- PostgreSQL jsonb numbers are arbitrary-precision numeric values, while the
-- public TypeScript JSON contract accepts only values that JSON.parse maps to
-- a finite JavaScript Number. Preserve JavaScript underflow-to-zero semantics
-- while rejecting overflow that would become +/-Infinity.
CREATE FUNCTION app.g007_json_numbers_are_finite(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_child jsonb;
  v_numeric numeric;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'number' THEN
      v_numeric := (p_value #>> '{}')::numeric;
      BEGIN
        PERFORM v_numeric::double precision;
        RETURN true;
      EXCEPTION
        WHEN numeric_value_out_of_range THEN
          RETURN abs(v_numeric) < 1;
      END;
    WHEN 'array' THEN
      FOR v_child IN SELECT value FROM jsonb_array_elements(p_value) AS item(value)
      LOOP
        IF NOT app.g007_json_numbers_are_finite(v_child) THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    WHEN 'object' THEN
      FOR v_child IN SELECT value FROM jsonb_each(p_value) AS item(key, value)
      LOOP
        IF NOT app.g007_json_numbers_are_finite(v_child) THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    WHEN 'string', 'boolean', 'null' THEN
      RETURN true;
    ELSE
      RETURN false;
  END CASE;
END;
$function$;
ALTER FUNCTION app.g007_json_numbers_are_finite(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.g007_json_numbers_are_finite(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.g007_json_numbers_are_finite(jsonb) TO ba_billing_owner;

CREATE TABLE auth.internal_service_attestations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  subject_session_user name NOT NULL,
  phase text NOT NULL CHECK (phase IN (
    'admission',
    'execution',
    'metering',
    'finalizer',
    'reclaimer',
    'reconciliation',
    'archive_evidence',
    'retention'
  )),
  audience text NOT NULL CHECK (audience = 'better-agent/internal-service/1'),
  binding_sha256 bytea NOT NULL CHECK (octet_length(binding_sha256) = 32),
  verifier_hmac bytea NOT NULL CHECK (octet_length(verifier_hmac) = 32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  CONSTRAINT internal_service_attestations_time_check CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + interval '15 minutes'
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
  ),
  CONSTRAINT internal_service_attestations_revocation_check CHECK ((
    (revoked_at IS NULL AND revocation_reason IS NULL)
    OR (
      revoked_at IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND length(btrim(revocation_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
    )
  ) IS TRUE)
);
ALTER TABLE auth.internal_service_attestations OWNER TO ba_auth_owner;
REVOKE ALL ON TABLE auth.internal_service_attestations FROM PUBLIC;

ALTER TABLE public.run_attempts
  ADD COLUMN runtime_protocol_version integer NOT NULL DEFAULT 4,
  ADD COLUMN lease_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN recovery_ticket_id uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT run_attempts_runtime_protocol_check
    CHECK (runtime_protocol_version IN (4, 5)),
  ADD CONSTRAINT run_attempts_protocol_v5_fence_check CHECK (
    runtime_protocol_version <> 5
    OR lease_generation BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT run_attempts_protocol_v5_state_check CHECK ((
    runtime_protocol_version <> 5
    OR (
      (
        status = 'PENDING'
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_fencing_token IS NULL
        AND lease_expires_at IS NULL
        AND (
          (
            lease_generation = 0
            AND recovery_ticket_id IS NULL
            AND started_at IS NULL
          ) OR (
            lease_generation BETWEEN 1 AND 9007199254740991
            AND recovery_ticket_id IS NOT NULL
          )
        )
      ) OR (
        status = 'RUNNING'
        AND lease_owner IS NOT NULL
        AND lease_token IS NOT NULL
        AND lease_fencing_token IS NOT NULL
        AND lease_fencing_token = lease_generation
        AND lease_expires_at IS NOT NULL
        AND recovery_ticket_id IS NULL
      ) OR (
        status IN ('RELINQUISHED', 'SUCCEEDED', 'FAILED', 'CANCELLED')
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_fencing_token IS NULL
        AND lease_expires_at IS NULL
        AND recovery_ticket_id IS NULL
      )
    )
  ) IS TRUE);

ALTER TABLE public.run_checkpoints
  ADD COLUMN producer_attempt_id uuid,
  ADD COLUMN producer_lease_token uuid,
  ADD COLUMN producer_lease_fencing_token bigint,
  ADD COLUMN producer_session_user name,
  ADD COLUMN producer_lease_expires_at timestamptz,
  ADD COLUMN authorized_at timestamptz,
  ADD COLUMN checkpoint_sequence bigint,
  ADD COLUMN schema_version text GENERATED ALWAYS AS (
    'run-execution-checkpoint/1'::text
  ) STORED,
  ADD COLUMN checkpoint_id uuid GENERATED ALWAYS AS (id) STORED,
  ADD COLUMN attempt_id uuid GENERATED ALWAYS AS (producer_attempt_id) STORED,
  ADD COLUMN checkpoint_ref text GENERATED ALWAYS AS (payload_ref) STORED,
  ADD COLUMN checkpoint_sha256 text GENERATED ALWAYS AS (checkpoint_hash) STORED,
  ADD COLUMN lease_owner name GENERATED ALWAYS AS (producer_session_user) STORED,
  ADD COLUMN lease_token uuid GENERATED ALWAYS AS (producer_lease_token) STORED,
  ADD COLUMN lease_fencing_token bigint GENERATED ALWAYS AS (
    producer_lease_fencing_token
  ) STORED,
  ADD COLUMN lease_expires_at timestamptz GENERATED ALWAYS AS (
    producer_lease_expires_at
  ) STORED,
  ADD COLUMN runtime_protocol_version integer NOT NULL DEFAULT 4,
  ADD CONSTRAINT run_checkpoints_runtime_protocol_check
    CHECK (runtime_protocol_version IN (4, 5)),
  ADD CONSTRAINT run_checkpoints_sequence_check CHECK (
    checkpoint_sequence IS NULL
    OR checkpoint_sequence BETWEEN 1 AND 9007199254740991
  ),
  ADD CONSTRAINT run_checkpoints_sequence_key
    UNIQUE (workspace_id, run_id, checkpoint_sequence),
  ADD CONSTRAINT run_checkpoints_protocol_v5_shape_check CHECK ((
    runtime_protocol_version <> 5
    OR (
      producer_attempt_id IS NOT NULL
      AND producer_lease_token IS NOT NULL
      AND producer_lease_fencing_token IS NOT NULL
      AND producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
      AND producer_session_user IS NOT NULL
      AND producer_lease_expires_at IS NOT NULL
      AND authorized_at IS NOT NULL
      AND authorized_at < producer_lease_expires_at
      AND checkpoint_sequence IS NOT NULL
      AND checkpoint_sequence BETWEEN 1 AND 9007199254740991
      AND length(payload_ref) BETWEEN 1 AND 2048
      AND length(btrim(payload_ref, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 2048
      AND position('?' IN payload_ref) = 0
      AND position('#' IN payload_ref) = 0
    )
  ) IS TRUE),
  ADD CONSTRAINT run_checkpoints_producer_attempt_fkey FOREIGN KEY (
    workspace_id, run_id, producer_attempt_id
  ) REFERENCES public.run_attempts(workspace_id, run_id, id);

ALTER TABLE public.outbox
  ADD COLUMN delivery_protocol_version integer NOT NULL DEFAULT 4,
  ADD COLUMN delivery_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN recovery_ticket_id uuid,
  ADD COLUMN delivery_failure_evidence_sha256 text,
  ADD CONSTRAINT outbox_delivery_protocol_check
    CHECK (delivery_protocol_version IN (4, 5)),
  ADD CONSTRAINT outbox_protocol_v5_generation_check CHECK (
    delivery_protocol_version <> 5
    OR delivery_generation BETWEEN 0 AND 9007199254740991
  ),
  ADD CONSTRAINT outbox_delivery_failure_evidence_check CHECK (
    delivery_failure_evidence_sha256 IS NULL
    OR (
      delivery_protocol_version = 5
      AND status = 'DEAD'
      AND delivery_failure_evidence_sha256 ~ '^sha256:[0-9a-f]{64}$'
    )
  );

CREATE TABLE public.run_retry_effect_envelopes (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  accepted_plan_hash text NOT NULL CHECK (accepted_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  operation_intent_sha256 text NOT NULL
    CHECK (operation_intent_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  effect_payload_sha256 text NOT NULL
    CHECK (effect_payload_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  effect_class text NOT NULL CHECK (effect_class IN ('safe', 'requires_key', 'unsafe')),
  operation_key text,
  envelope_sha256 text NOT NULL CHECK (envelope_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL
    CHECK (producer_lease_fencing_token BETWEEN 1 AND 9007199254740991),
  producer_lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_retry_effect_envelopes_attempt_key
    UNIQUE (workspace_id, run_id, attempt_id, id),
  CONSTRAINT run_retry_effect_envelopes_receipt_key
    UNIQUE (workspace_id, run_id, attempt_id, step_id, id),
  CONSTRAINT run_retry_effect_envelopes_request_key
    UNIQUE (
      workspace_id, run_id, attempt_id, step_id, operation_intent_sha256
    ),
  -- Keyless safe/unsafe effects are independent facts. Default NULL-distinct
  -- uniqueness still deduplicates every non-null requires_key operation key.
  CONSTRAINT run_retry_effect_envelopes_operation_key
    UNIQUE (workspace_id, run_id, operation_key),
  CONSTRAINT run_retry_effect_envelopes_key_shape CHECK (
    (
      effect_class = 'requires_key'
      AND operation_key IS NOT NULL
      AND length(btrim(operation_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
      AND length(operation_key) BETWEEN 1 AND 300
    )
    OR (effect_class <> 'requires_key' AND operation_key IS NULL)
  ),
  CONSTRAINT run_retry_effect_envelopes_lease_window_check
    CHECK (created_at < producer_lease_expires_at),
  CONSTRAINT run_retry_effect_envelopes_attempt_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id
  ) REFERENCES public.run_attempts(workspace_id, run_id, id),
  CONSTRAINT run_retry_effect_envelopes_step_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id, step_id
  ) REFERENCES public.run_steps(workspace_id, run_id, attempt_id, id)
);

CREATE TABLE public.run_side_effect_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  envelope_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('CONFIRMED', 'UNKNOWN')),
  result_ref text,
  result_sha256 text CHECK (result_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  unknown_reason_code text,
  result_payload_sha256 text NOT NULL
    CHECK (result_payload_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL
    CHECK (producer_lease_fencing_token BETWEEN 1 AND 9007199254740991),
  producer_lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_side_effect_receipts_envelope_key UNIQUE (workspace_id, envelope_id),
  CONSTRAINT run_side_effect_receipts_shape_check CHECK (
    (
      disposition = 'CONFIRMED'
      AND result_ref IS NOT NULL
      AND length(btrim(result_ref, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0
      AND result_sha256 IS NOT NULL
      AND length(result_ref) <= 2048
      AND position('?' IN result_ref) = 0
      AND position('#' IN result_ref) = 0
      AND unknown_reason_code IS NULL
    )
    OR (
      disposition = 'UNKNOWN'
      AND result_ref IS NULL
      AND result_sha256 IS NULL
      AND unknown_reason_code IS NOT NULL
      AND length(btrim(unknown_reason_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 200
      AND length(unknown_reason_code) BETWEEN 1 AND 200
    )
  ),
  CONSTRAINT run_side_effect_receipts_lease_window_check
    CHECK (created_at < producer_lease_expires_at),
  CONSTRAINT run_side_effect_receipts_envelope_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id, step_id, envelope_id
  ) REFERENCES public.run_retry_effect_envelopes(
    workspace_id, run_id, attempt_id, step_id, id
  )
);

CREATE TABLE public.run_usage_attributions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  schema_version text GENERATED ALWAYS AS ('run-usage-attribution/1'::text) STORED,
  usage_attribution_id uuid GENERATED ALWAYS AS (id) STORED,
  run_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL
    CHECK (producer_lease_fencing_token BETWEEN 1 AND 9007199254740991),
  producer_lease_expires_at timestamptz NOT NULL,
  lease_owner name GENERATED ALWAYS AS (producer_session_user) STORED,
  lease_token uuid GENERATED ALWAYS AS (producer_lease_token) STORED,
  lease_fencing_token bigint GENERATED ALWAYS AS (producer_lease_fencing_token) STORED,
  lease_expires_at timestamptz GENERATED ALWAYS AS (producer_lease_expires_at) STORED,
  producer_operation_key text NOT NULL
    CHECK (
      length(producer_operation_key) BETWEEN 1 AND 300
      AND length(btrim(producer_operation_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
    ),
  producer_request_sha256 text NOT NULL
    CHECK (producer_request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  metering_unit text NOT NULL CHECK (
    length(metering_unit) BETWEEN 1 AND 200
    AND length(btrim(metering_unit, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 200
  ),
  quantity bigint NOT NULL CHECK (quantity >= 0),
  amount bigint NOT NULL CHECK (amount >= 0),
  metering_quantity bigint GENERATED ALWAYS AS (quantity) STORED,
  amount_credits bigint GENERATED ALWAYS AS (amount) STORED,
  settlement_operation_key text NOT NULL
    CHECK (
      length(settlement_operation_key) BETWEEN 1 AND 300
      AND length(btrim(settlement_operation_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
    ),
  operation_intent_sha256 text NOT NULL
    CHECK (operation_intent_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  execution_effect_payload_sha256 text NOT NULL
    CHECK (execution_effect_payload_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  consumption_generation bigint NOT NULL DEFAULT 1
    CHECK (consumption_generation BETWEEN 1 AND 9007199254740991),
  detail_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_authority_hash text NOT NULL
    CHECK (source_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_usage_attributions_source_key
    UNIQUE (workspace_id, id, source_authority_hash),
  CONSTRAINT run_usage_attributions_producer_request_key
    UNIQUE (workspace_id, run_id, producer_operation_key),
  CONSTRAINT run_usage_attributions_lease_window_check
    CHECK (authorized_at < producer_lease_expires_at),
  CONSTRAINT run_usage_attributions_detail_json_check CHECK (
    jsonb_typeof(detail_redacted) = 'object'
    AND app.g007_json_numbers_are_finite(detail_redacted)
  ),
  CONSTRAINT run_usage_attributions_reservation_fkey FOREIGN KEY (
    workspace_id, reservation_id, run_id, billing_owner_run_id
  ) REFERENCES public.credit_reservations(
    workspace_id, id, run_id, billing_owner_run_id
  ),
  CONSTRAINT run_usage_attributions_step_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id, step_id
  ) REFERENCES public.run_steps(workspace_id, run_id, attempt_id, id)
);

CREATE TABLE public.run_termination_intents (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  schema_version text GENERATED ALWAYS AS ('run-termination-intent/1'::text) STORED,
  termination_intent_id uuid GENERATED ALWAYS AS (id) STORED,
  run_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL
    CHECK (producer_lease_fencing_token BETWEEN 1 AND 9007199254740991),
  producer_lease_expires_at timestamptz NOT NULL,
  terminal_kind text NOT NULL CHECK (terminal_kind IN ('FAILED', 'CANCELLED')),
  lease_owner name GENERATED ALWAYS AS (producer_session_user) STORED,
  lease_token uuid GENERATED ALWAYS AS (producer_lease_token) STORED,
  lease_fencing_token bigint GENERATED ALWAYS AS (producer_lease_fencing_token) STORED,
  lease_expires_at timestamptz GENERATED ALWAYS AS (producer_lease_expires_at) STORED,
  terminal_status text GENERATED ALWAYS AS (terminal_kind) STORED,
  producer_operation_key text NOT NULL
    CHECK (
      length(producer_operation_key) BETWEEN 1 AND 300
      AND length(btrim(producer_operation_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
    ),
  producer_request_sha256 text NOT NULL
    CHECK (producer_request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  termination_reason text NOT NULL,
  terminal_intent_hash text NOT NULL CHECK (terminal_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  effect_disposition text NOT NULL CHECK (effect_disposition = 'CLOSED'),
  effect_closure_sha256 text NOT NULL CHECK (effect_closure_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  billing_close_intent_redacted jsonb NOT NULL
    CHECK (jsonb_typeof(billing_close_intent_redacted) = 'object'),
  usage_attribution_ids uuid[] NOT NULL,
  intended_settle_credits bigint NOT NULL CHECK (intended_settle_credits >= 0),
  settlement_operation_key text NOT NULL
    CHECK (
      length(settlement_operation_key) BETWEEN 1 AND 300
      AND length(btrim(settlement_operation_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
    ),
  intended_release_credits bigint NOT NULL CHECK (intended_release_credits >= 0),
  release_operation_key text NOT NULL
    CHECK (
      length(release_operation_key) BETWEEN 1 AND 300
      AND length(btrim(release_operation_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
    ),
  release_reason_code text NOT NULL
    CHECK (
      length(release_reason_code) BETWEEN 1 AND 200
      AND length(btrim(release_reason_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 200
    ),
  operation_intent_sha256 text NOT NULL
    CHECK (operation_intent_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  consumption_generation bigint NOT NULL DEFAULT 1
    CHECK (consumption_generation BETWEEN 1 AND 9007199254740991),
  source_authority_hash text NOT NULL
    CHECK (source_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_termination_intents_run_key UNIQUE (workspace_id, run_id),
  CONSTRAINT run_termination_intents_source_key
    UNIQUE (workspace_id, id, source_authority_hash),
  CONSTRAINT run_termination_intents_lease_window_check
    CHECK (authorized_at < producer_lease_expires_at),
  CONSTRAINT run_termination_intents_reservation_fkey FOREIGN KEY (
    workspace_id, reservation_id, run_id, billing_owner_run_id
  ) REFERENCES public.credit_reservations(
    workspace_id, id, run_id, billing_owner_run_id
  ),
  CONSTRAINT run_termination_intents_attempt_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id
  ) REFERENCES public.run_attempts(workspace_id, run_id, id),
  CONSTRAINT run_termination_intents_step_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id, step_id
  ) REFERENCES public.run_steps(workspace_id, run_id, attempt_id, id)
);

CREATE TABLE public.run_recovery_tickets (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('ATTEMPT', 'RUN_DISPATCH')),
  resource_id uuid NOT NULL,
  old_generation bigint NOT NULL CHECK (old_generation BETWEEN 1 AND 9007199254740990),
  fenced_generation bigint NOT NULL CHECK (
    fenced_generation BETWEEN 2 AND 9007199254740991
    AND fenced_generation = old_generation + 1
  ),
  checkpoint_id uuid,
  checkpoint_sha256 text CHECK (checkpoint_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  effect_decisions jsonb NOT NULL CHECK (
    jsonb_typeof(effect_decisions) = 'array'
    AND jsonb_array_length(effect_decisions) > 0
  ),
  effect_decisions_sha256 text NOT NULL
    CHECK (effect_decisions_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  ticket_sha256 text NOT NULL CHECK (ticket_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_recovery_tickets_resource_key
    UNIQUE (workspace_id, resource_kind, resource_id, fenced_generation),
  CONSTRAINT run_recovery_tickets_source_key
    UNIQUE (workspace_id, id, resource_kind, resource_id, fenced_generation, ticket_sha256),
  CONSTRAINT run_recovery_tickets_checkpoint_pair_check CHECK (
    (checkpoint_id IS NULL AND checkpoint_sha256 IS NULL)
    OR (checkpoint_id IS NOT NULL AND checkpoint_sha256 IS NOT NULL)
  ),
  CONSTRAINT run_recovery_tickets_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id)
);

CREATE TABLE public.run_recovery_ticket_dispositions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  recovery_ticket_id uuid NOT NULL,
  recovery_ticket_sha256 text NOT NULL
    CHECK (recovery_ticket_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  run_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('ATTEMPT', 'RUN_DISPATCH')),
  resource_id uuid NOT NULL,
  ticket_fencing_token bigint NOT NULL
    CHECK (ticket_fencing_token BETWEEN 1 AND 9007199254740991),
  disposition_kind text NOT NULL
    CHECK (disposition_kind IN ('CLAIMED', 'TERMINAL_RETIRED')),
  claim_fencing_token bigint
    CHECK (claim_fencing_token BETWEEN 1 AND 9007199254740991),
  claim_session_user name,
  claim_lease_owner name,
  claim_lease_token uuid,
  claim_lease_expires_at timestamptz,
  terminal_source_kind text CHECK (terminal_source_kind IN (
    'TERMINATION_ATTRIBUTION', 'DURABLE_CANCEL', 'RECOVERY_HOLD'
  )),
  terminal_source_id uuid,
  terminal_source_sha256 text
    CHECK (terminal_source_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  terminal_intent_sha256 text
    CHECK (terminal_intent_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  terminal_resource_status text
    CHECK (terminal_resource_status IN ('CANCELLED', 'FAILED', 'RELINQUISHED', 'DEAD')),
  disposed_at timestamptz NOT NULL,
  -- Read-only aliases preserve the pre-freeze inspection surface while every
  -- authoritative write uses the strict contract field names above.
  disposition text GENERATED ALWAYS AS (disposition_kind) STORED,
  resulting_generation bigint GENERATED ALWAYS AS (
    COALESCE(claim_fencing_token, ticket_fencing_token)
  ) STORED,
  claiming_session_user name GENERATED ALWAYS AS (claim_session_user) STORED,
  claiming_lease_token uuid GENERATED ALWAYS AS (claim_lease_token) STORED,
  terminal_intent_hash text GENERATED ALWAYS AS (terminal_intent_sha256) STORED,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_recovery_ticket_dispositions_ticket_key
    UNIQUE (workspace_id, recovery_ticket_id),
  CONSTRAINT run_recovery_ticket_dispositions_shape_check CHECK (
    (
      disposition_kind = 'CLAIMED'
      AND claim_fencing_token IS NOT NULL
      AND claim_session_user IS NOT NULL
      AND claim_lease_owner IS NOT NULL
      AND claim_session_user = claim_lease_owner
      AND claim_lease_token IS NOT NULL
      AND claim_lease_expires_at IS NOT NULL
      AND disposed_at < claim_lease_expires_at
      AND terminal_source_kind IS NULL
      AND terminal_source_id IS NULL
      AND terminal_source_sha256 IS NULL
      AND terminal_intent_sha256 IS NULL
      AND terminal_resource_status IS NULL
    ) OR (
      disposition_kind = 'TERMINAL_RETIRED'
      AND claim_fencing_token IS NULL
      AND claim_session_user IS NULL
      AND claim_lease_owner IS NULL
      AND claim_lease_token IS NULL
      AND claim_lease_expires_at IS NULL
      AND terminal_source_kind IS NOT NULL
      AND terminal_source_id IS NOT NULL
      AND terminal_source_sha256 IS NOT NULL
      AND terminal_intent_sha256 IS NOT NULL
      AND terminal_resource_status IS NOT NULL
    )
  ),
  CONSTRAINT run_recovery_ticket_dispositions_terminal_mapping_check CHECK (
    disposition_kind = 'CLAIMED'
    OR (
      resource_kind = 'RUN_DISPATCH'
      AND terminal_resource_status = 'DEAD'
    )
    OR (
      resource_kind = 'ATTEMPT'
      AND (
        (
          terminal_source_kind = 'RECOVERY_HOLD'
          AND terminal_resource_status = 'RELINQUISHED'
        )
        OR (
          terminal_source_kind = 'DURABLE_CANCEL'
          AND terminal_resource_status = 'CANCELLED'
        )
        OR (
          terminal_source_kind = 'TERMINATION_ATTRIBUTION'
          AND terminal_resource_status IN ('CANCELLED', 'FAILED')
        )
      )
    )
  ),
  CONSTRAINT run_recovery_ticket_dispositions_ticket_fkey FOREIGN KEY (
    workspace_id, recovery_ticket_id
  ) REFERENCES public.run_recovery_tickets(workspace_id, id)
);

ALTER TABLE public.run_attempts
  ADD CONSTRAINT run_attempts_recovery_ticket_fkey FOREIGN KEY (
    workspace_id, recovery_ticket_id
  ) REFERENCES public.run_recovery_tickets(workspace_id, id);

ALTER TABLE public.outbox
  ADD CONSTRAINT outbox_recovery_ticket_fkey FOREIGN KEY (
    workspace_id, recovery_ticket_id
  ) REFERENCES public.run_recovery_tickets(workspace_id, id);

CREATE TABLE public.run_recovery_hold_intents (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('ATTEMPT', 'RUN_DISPATCH')),
  resource_id uuid NOT NULL,
  old_generation bigint NOT NULL
    CHECK (old_generation BETWEEN 1 AND 9007199254740990),
  fenced_generation bigint NOT NULL CHECK (
    fenced_generation BETWEEN 2 AND 9007199254740991
    AND fenced_generation = old_generation + 1
  ),
  hold_reason text NOT NULL CHECK (hold_reason IN (
    'MISSING_ENVELOPE', 'UNSAFE_EFFECT', 'SIDE_EFFECT_UNKNOWN',
    'EFFECT_CLOSURE_OPEN', 'EFFECT_CLOSURE_UNKNOWN'
  )),
  retry_effect_envelope_id uuid,
  retry_effect_envelope_sha256 text
    CHECK (retry_effect_envelope_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  effect_receipt_id uuid,
  effect_receipt_sha256 text
    CHECK (effect_receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  effect_closure_disposition text CHECK (effect_closure_disposition IN ('OPEN', 'UNKNOWN')),
  effect_closure_sha256 text CHECK (effect_closure_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  hold_evidence_sha256 text NOT NULL
    CHECK (hold_evidence_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint_id uuid,
  checkpoint_sha256 text CHECK (checkpoint_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_recovery_hold_intents_run_key UNIQUE (workspace_id, run_id, id),
  CONSTRAINT run_recovery_hold_intents_attempt_fkey FOREIGN KEY (
    workspace_id, run_id, resource_id
  ) REFERENCES public.run_attempts(workspace_id, run_id, id),
  CONSTRAINT run_recovery_hold_intents_resource_check CHECK (
    resource_kind = 'ATTEMPT'
  ),
  CONSTRAINT run_recovery_hold_intents_checkpoint_pair_check CHECK (
    (checkpoint_id IS NULL AND checkpoint_sha256 IS NULL)
    OR (checkpoint_id IS NOT NULL AND checkpoint_sha256 IS NOT NULL)
  ),
  CONSTRAINT run_recovery_hold_intents_evidence_shape_check CHECK ((
    (
      hold_reason = 'MISSING_ENVELOPE'
      AND retry_effect_envelope_id IS NULL
      AND retry_effect_envelope_sha256 IS NULL
      AND effect_receipt_id IS NULL
      AND effect_receipt_sha256 IS NULL
      AND effect_closure_disposition IS NULL
      AND effect_closure_sha256 IS NULL
    ) OR (
      hold_reason = 'UNSAFE_EFFECT'
      AND retry_effect_envelope_id IS NOT NULL
      AND retry_effect_envelope_sha256 IS NOT NULL
      AND effect_receipt_id IS NULL
      AND effect_receipt_sha256 IS NULL
      AND effect_closure_disposition IS NULL
      AND effect_closure_sha256 IS NULL
    ) OR (
      hold_reason = 'SIDE_EFFECT_UNKNOWN'
      AND retry_effect_envelope_id IS NOT NULL
      AND retry_effect_envelope_sha256 IS NOT NULL
      AND effect_receipt_id IS NOT NULL
      AND effect_receipt_sha256 IS NOT NULL
      AND effect_closure_disposition IS NULL
      AND effect_closure_sha256 IS NULL
    ) OR (
      hold_reason IN ('EFFECT_CLOSURE_OPEN', 'EFFECT_CLOSURE_UNKNOWN')
      AND retry_effect_envelope_id IS NULL
      AND retry_effect_envelope_sha256 IS NULL
      AND effect_receipt_id IS NULL
      AND effect_receipt_sha256 IS NULL
      AND effect_closure_disposition IS NOT NULL
      AND effect_closure_disposition = CASE hold_reason
        WHEN 'EFFECT_CLOSURE_OPEN' THEN 'OPEN'
        ELSE 'UNKNOWN' END
      AND effect_closure_sha256 IS NOT NULL
    )
  ) IS TRUE)
);

CREATE TABLE public.run_dispatch_retirement_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  old_status text NOT NULL CHECK (old_status IN ('PENDING', 'LEASED')),
  old_lease_owner name,
  old_lease_token uuid,
  old_lease_fencing_token bigint,
  old_lease_expires_at timestamptz,
  old_delivery_generation bigint NOT NULL
    CHECK (old_delivery_generation BETWEEN 0 AND 9007199254740991),
  new_delivery_generation bigint NOT NULL
    CHECK (new_delivery_generation BETWEEN 0 AND 9007199254740991),
  retired_status text NOT NULL CHECK (retired_status = 'DEAD'),
  last_error_code text NOT NULL CHECK (last_error_code = 'RUN_TERMINATED_BEFORE_DISPATCH'),
  terminal_source_kind text NOT NULL CHECK (terminal_source_kind IN (
    'TERMINATION_ATTRIBUTION', 'DURABLE_CANCEL', 'RECOVERY_HOLD'
  )),
  terminal_source_id uuid NOT NULL,
  terminal_source_sha256 text NOT NULL
    CHECK (terminal_source_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  terminal_intent_sha256 text NOT NULL
    CHECK (terminal_intent_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  retired_at timestamptz NOT NULL,
  terminal_intent_hash text GENERATED ALWAYS AS (terminal_intent_sha256) STORED,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_dispatch_retirement_receipts_outbox_key UNIQUE (workspace_id, outbox_id),
  CONSTRAINT run_dispatch_retirement_receipts_outbox_fkey FOREIGN KEY (
    workspace_id, outbox_id
  ) REFERENCES public.outbox(workspace_id, id),
  CONSTRAINT run_dispatch_retirement_receipts_run_fkey FOREIGN KEY (
    workspace_id, run_id
  ) REFERENCES public.runs(workspace_id, id),
  CONSTRAINT run_dispatch_retirement_receipts_generation_check CHECK (
    (old_status = 'PENDING' AND new_delivery_generation = old_delivery_generation)
    OR (old_status = 'LEASED' AND new_delivery_generation = old_delivery_generation + 1)
  ),
  CONSTRAINT run_dispatch_retirement_receipts_lease_shape_check CHECK ((
    (
      old_status = 'PENDING'
      AND old_lease_owner IS NULL
      AND old_lease_token IS NULL
      AND old_lease_fencing_token IS NULL
      AND old_lease_expires_at IS NULL
    ) OR (
      old_status = 'LEASED'
      AND old_lease_owner IS NOT NULL
      AND old_lease_token IS NOT NULL
      AND old_lease_fencing_token IS NOT NULL
      AND old_lease_fencing_token BETWEEN 1 AND 9007199254740991
      AND old_lease_fencing_token = old_delivery_generation
      AND old_lease_expires_at IS NOT NULL
    )
  ) IS TRUE)
);

CREATE TABLE public.run_billing_authority_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  authority_schema_version integer NOT NULL CHECK (authority_schema_version = 1),
  authority_kind text NOT NULL CHECK (authority_kind IN (
    'EXECUTION_USAGE', 'EXECUTION_TERMINATION', 'DURABLE_CANCEL'
  )),
  source_id uuid NOT NULL,
  source_authority_hash text NOT NULL
    CHECK (source_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_consumption_generation bigint NOT NULL
    CHECK (source_consumption_generation BETWEEN 1 AND 9007199254740991),
  operation text NOT NULL CHECK (operation IN ('SETTLE', 'RELEASE')),
  amount bigint NOT NULL CHECK (amount >= 0),
  producer_run_id uuid NOT NULL,
  producer_attempt_id uuid,
  producer_lease_fencing_token bigint,
  step_id uuid,
  ledger_entry_id uuid NOT NULL,
  charge_key text NOT NULL CHECK (
    length(charge_key) BETWEEN 1 AND 300
    AND length(btrim(charge_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
  ),
  billing_intent_hash text NOT NULL CHECK (billing_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  charge_attribution_hash text NOT NULL
    CHECK (charge_attribution_hash ~ '^sha256:[0-9a-f]{64}$'),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_billing_authority_receipts_source_key
    UNIQUE (workspace_id, authority_kind, source_id),
  CONSTRAINT run_billing_authority_receipts_ledger_key
    UNIQUE (workspace_id, ledger_entry_id),
  CONSTRAINT run_billing_authority_receipts_binding_key
    UNIQUE (workspace_id, id, authority_kind, ledger_entry_id),
  CONSTRAINT run_billing_authority_receipts_attribution_hash_check
    CHECK (charge_attribution_hash = source_authority_hash),
  CONSTRAINT run_billing_authority_receipts_shape_check CHECK ((
    (
      authority_kind = 'EXECUTION_USAGE'
      AND operation = 'SETTLE'
      AND producer_attempt_id IS NOT NULL
      AND producer_lease_fencing_token IS NOT NULL
      AND producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
      AND step_id IS NOT NULL
    ) OR (
      authority_kind = 'EXECUTION_TERMINATION'
      AND operation = 'RELEASE'
      AND producer_attempt_id IS NOT NULL
      AND producer_lease_fencing_token IS NOT NULL
      AND producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
      AND step_id IS NOT NULL
    ) OR (
      authority_kind = 'DURABLE_CANCEL'
      AND operation = 'RELEASE'
      AND producer_run_id = run_id
      AND producer_attempt_id IS NULL
      AND producer_lease_fencing_token IS NULL
      AND step_id IS NULL
    )
  ) IS TRUE),
  CONSTRAINT run_billing_authority_receipts_reservation_fkey FOREIGN KEY (
    workspace_id, reservation_id, run_id, billing_owner_run_id
  ) REFERENCES public.credit_reservations(
    workspace_id, id, run_id, billing_owner_run_id
  )
);
ALTER TABLE public.run_billing_authority_receipts OWNER TO ba_billing_owner;

ALTER TABLE public.credits_ledger
  ADD COLUMN entry_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN authority_schema_version integer,
  ADD COLUMN authority_kind text,
  ADD COLUMN authority_id uuid,
  DROP CONSTRAINT credits_ledger_producer_shape_check,
  ADD CONSTRAINT credits_ledger_entry_schema_check
    CHECK (entry_schema_version IN (1, 2)),
  ADD CONSTRAINT credits_ledger_metering_detail_json_check CHECK (
    jsonb_typeof(metering_detail_redacted) = 'object'
    AND app.g007_json_numbers_are_finite(metering_detail_redacted)
  ),
  ADD CONSTRAINT credits_ledger_authority_shape_check CHECK ((
    (
      entry_schema_version = 1
      AND authority_schema_version IS NULL
      AND authority_kind IS NULL
      AND authority_id IS NULL
      AND (
        (
          entry_kind IN ('RESERVE', 'EXPIRED', 'RECONCILIATION')
          AND producer_attempt_id IS NULL
          AND producer_lease_fencing_token IS NULL
          AND step_id IS NULL
        ) OR (
          entry_kind IN ('SETTLE', 'RELEASE')
          AND producer_attempt_id IS NOT NULL
          AND producer_lease_fencing_token IS NOT NULL
        )
      )
    ) OR (
      entry_schema_version = 2
      AND authority_schema_version IS NOT NULL
      AND authority_schema_version = 1
      AND authority_kind IS NOT NULL
      AND authority_kind = 'EXECUTION_USAGE'
      AND authority_id IS NOT NULL
      AND entry_kind = 'SETTLE'
      AND producer_attempt_id IS NOT NULL
      AND producer_lease_fencing_token IS NOT NULL
      AND producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
      AND step_id IS NOT NULL
    ) OR (
      entry_schema_version = 2
      AND authority_schema_version IS NOT NULL
      AND authority_schema_version = 1
      AND authority_kind IS NOT NULL
      AND authority_kind = 'EXECUTION_TERMINATION'
      AND authority_id IS NOT NULL
      AND entry_kind = 'RELEASE'
      AND producer_attempt_id IS NOT NULL
      AND producer_lease_fencing_token IS NOT NULL
      AND producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
      AND step_id IS NOT NULL
    ) OR (
      entry_schema_version = 2
      AND authority_schema_version IS NOT NULL
      AND authority_schema_version = 1
      AND authority_kind IS NOT NULL
      AND authority_id IS NOT NULL
      AND authority_kind = 'DURABLE_CANCEL'
      AND entry_kind = 'RELEASE'
      AND producer_run_id = run_id
      AND producer_attempt_id IS NULL
      AND producer_lease_fencing_token IS NULL
      AND step_id IS NULL
    )
  ) IS TRUE),
  ADD CONSTRAINT credits_ledger_authority_binding_key
    UNIQUE (workspace_id, id, authority_id, authority_kind),
  ADD CONSTRAINT credits_ledger_authority_fkey FOREIGN KEY (
    workspace_id, authority_id, authority_kind, id
  ) REFERENCES public.run_billing_authority_receipts(
    workspace_id, id, authority_kind, ledger_entry_id
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.run_billing_authority_receipts
  ADD CONSTRAINT run_billing_authority_receipts_ledger_fkey FOREIGN KEY (
    workspace_id, ledger_entry_id, id, authority_kind
  ) REFERENCES public.credits_ledger(
    workspace_id, id, authority_id, authority_kind
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.finalizer_transaction_claims (
  transaction_id bigint NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN (
    'EXECUTION_TERMINATION', 'DURABLE_CANCEL', 'RECOVERY_HOLD'
  )),
  source_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  source_fact jsonb NOT NULL CHECK (jsonb_typeof(source_fact) = 'object'),
  terminal_intent_hash text NOT NULL CHECK (terminal_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  effect_closure_sha256 text NOT NULL CHECK (effect_closure_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('SETTLE', 'RELEASE')),
  amount bigint NOT NULL CHECK (amount >= 0),
  consumed_at timestamptz,
  PRIMARY KEY (transaction_id, workspace_id, id),
  CONSTRAINT finalizer_transaction_claims_source_key
    UNIQUE (transaction_id, workspace_id, source_kind, source_id),
  CONSTRAINT finalizer_transaction_claims_transaction_check
    CHECK (transaction_id > 0)
);

CREATE TABLE public.phase_operation_audit (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN (
    'admission', 'execution', 'metering', 'finalizer', 'reclaimer',
    'reconciliation', 'archive_evidence', 'retention'
  )),
  operation text NOT NULL CHECK (length(btrim(operation, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 100),
  resource_kind text NOT NULL CHECK (length(btrim(resource_kind, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 100),
  resource_id uuid NOT NULL,
  operation_sha256 text NOT NULL CHECK (operation_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  actor_session_user name NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT phase_operation_audit_operation_key
    UNIQUE (workspace_id, phase, operation, resource_kind, resource_id, operation_sha256)
);

DO $g007_public_fact_ownership$
DECLARE
  v_table name;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'run_retry_effect_envelopes',
    'run_side_effect_receipts',
    'run_usage_attributions',
    'run_termination_intents',
    'run_recovery_tickets',
    'run_recovery_ticket_dispositions',
    'run_recovery_hold_intents',
    'run_dispatch_retirement_receipts',
    'finalizer_transaction_claims',
    'phase_operation_audit'
  ]::name[] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO ba_run_owner', v_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_table);
  END LOOP;
  ALTER TABLE public.run_billing_authority_receipts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.run_billing_authority_receipts FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.run_billing_authority_receipts FROM PUBLIC;
END;
$g007_public_fact_ownership$;

CREATE POLICY internal_service_attestations_owner_access
ON auth.internal_service_attestations
FOR ALL TO ba_auth_owner
USING (true)
WITH CHECK (true);
ALTER TABLE auth.internal_service_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.internal_service_attestations FORCE ROW LEVEL SECURITY;

DO $g007_runtime_fact_policies$
DECLARE
  v_table name;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'run_retry_effect_envelopes',
    'run_side_effect_receipts',
    'run_usage_attributions',
    'run_termination_intents',
    'run_recovery_tickets',
    'run_recovery_ticket_dispositions',
    'run_recovery_hold_intents',
    'run_dispatch_retirement_receipts',
    'finalizer_transaction_claims',
    'phase_operation_audit'
  ]::name[] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO ba_run_owner USING (true) WITH CHECK (true)',
      v_table || '_owner_access',
      v_table
    );
  END LOOP;
END;
$g007_runtime_fact_policies$;

CREATE POLICY run_billing_authority_receipts_billing_owner_access
ON public.run_billing_authority_receipts
FOR ALL TO ba_billing_owner
USING (true)
WITH CHECK (true);
CREATE POLICY run_billing_authority_receipts_run_owner_access
ON public.run_billing_authority_receipts
FOR SELECT TO ba_run_owner
USING (true);
CREATE POLICY run_billing_authority_receipts_run_owner_insert
ON public.run_billing_authority_receipts
FOR INSERT TO ba_run_owner
WITH CHECK (true);
GRANT SELECT, INSERT ON TABLE public.run_billing_authority_receipts TO ba_run_owner;

CREATE POLICY credit_reservations_g007_run_owner_read
ON public.credit_reservations
FOR SELECT TO ba_run_owner
USING (workspace_id = app.current_workspace_id());
GRANT SELECT (
  workspace_id,
  id,
  run_id,
  billing_owner_run_id,
  status,
  reserved_credits,
  settled_credits,
  released_credits
) ON TABLE public.credit_reservations TO ba_run_owner;

CREATE FUNCTION app.reject_g007_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'G0-07 immutable authority fact cannot be updated or deleted'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION app.reject_g007_immutable_change() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.reject_g007_immutable_change() FROM PUBLIC;

CREATE FUNCTION auth.enforce_internal_service_attestation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL
     OR NEW.revocation_reason IS NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revocation_reason'])
          IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['revoked_at', 'revocation_reason']) THEN
    RAISE EXCEPTION 'internal service attestation is immutable except for first revocation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION auth.enforce_internal_service_attestation_change() OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.enforce_internal_service_attestation_change() FROM PUBLIC;
CREATE TRIGGER internal_service_attestations_controlled_change
BEFORE UPDATE OR DELETE ON auth.internal_service_attestations
FOR EACH ROW EXECUTE FUNCTION auth.enforce_internal_service_attestation_change();

CREATE FUNCTION app.enforce_g007_single_consumption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.consumed_at IS NOT NULL
     OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'G0-07 authority source permits only one consumption transition'
      USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'run_recovery_hold_intents' THEN
    IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') THEN
      RAISE EXCEPTION 'G0-07 HOLD source permits only its consumption timestamp transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.consumption_generation IS DISTINCT FROM OLD.consumption_generation + 1
        OR (
          to_jsonb(NEW) - ARRAY['consumed_at', 'consumption_generation']
        ) IS DISTINCT FROM (
          to_jsonb(OLD) - ARRAY['consumed_at', 'consumption_generation']
        ) THEN
    RAISE EXCEPTION 'G0-07 authority source consumption generation lost monotonicity'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION app.enforce_g007_single_consumption() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.enforce_g007_single_consumption() FROM PUBLIC;

-- Stored generated columns are NULL in NEW during a BEFORE trigger. Validate
-- after PostgreSQL materializes them so an exact consumption CAS can compare
-- the complete immutable source row without weakening the generation check.
CREATE TRIGGER run_usage_attributions_controlled_change
AFTER UPDATE OR DELETE ON public.run_usage_attributions
FOR EACH ROW EXECUTE FUNCTION app.enforce_g007_single_consumption();
CREATE TRIGGER run_termination_intents_controlled_change
AFTER UPDATE OR DELETE ON public.run_termination_intents
FOR EACH ROW EXECUTE FUNCTION app.enforce_g007_single_consumption();
CREATE TRIGGER run_recovery_hold_intents_controlled_change
BEFORE UPDATE OR DELETE ON public.run_recovery_hold_intents
FOR EACH ROW EXECUTE FUNCTION app.enforce_g007_single_consumption();
DO $g007_immutable_triggers$
DECLARE
  v_table name;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'run_retry_effect_envelopes',
    'run_side_effect_receipts',
    'run_recovery_tickets',
    'run_recovery_ticket_dispositions',
    'run_dispatch_retirement_receipts',
    'run_billing_authority_receipts',
    'phase_operation_audit'
  ]::name[] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.reject_g007_immutable_change()',
      v_table || '_immutable',
      v_table
    );
  END LOOP;
END;
$g007_immutable_triggers$;

CREATE FUNCTION app.validate_recovery_ticket_disposition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_ticket public.run_recovery_tickets%ROWTYPE;
BEGIN
  SELECT ticket.*
  INTO v_ticket
  FROM public.run_recovery_tickets AS ticket
  WHERE ticket.workspace_id = NEW.workspace_id
    AND ticket.id = NEW.recovery_ticket_id
  FOR KEY SHARE;
  IF NOT FOUND
     OR v_ticket.run_id IS DISTINCT FROM NEW.run_id
     OR v_ticket.resource_kind IS DISTINCT FROM NEW.resource_kind
     OR v_ticket.resource_id IS DISTINCT FROM NEW.resource_id
     OR NEW.recovery_ticket_sha256 IS DISTINCT FROM v_ticket.ticket_sha256
     OR NEW.ticket_fencing_token IS DISTINCT FROM v_ticket.fenced_generation
     OR (
       NEW.disposition_kind = 'CLAIMED'
       AND (
         NEW.claim_fencing_token IS DISTINCT FROM v_ticket.fenced_generation + 1
         OR NEW.claim_session_user IS DISTINCT FROM NEW.claim_lease_owner
         OR NEW.disposed_at >= NEW.claim_lease_expires_at
       )
     )
     OR (
       NEW.disposition_kind = 'TERMINAL_RETIRED'
       AND NEW.ticket_fencing_token IS DISTINCT FROM v_ticket.fenced_generation
     ) THEN
    RAISE EXCEPTION 'recovery ticket disposition does not bind the immutable ticket generation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION app.validate_recovery_ticket_disposition() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.validate_recovery_ticket_disposition() FROM PUBLIC;
CREATE TRIGGER run_recovery_ticket_dispositions_validate
BEFORE INSERT ON public.run_recovery_ticket_dispositions
FOR EACH ROW EXECUTE FUNCTION app.validate_recovery_ticket_disposition();

CREATE FUNCTION app.require_consumed_finalizer_claim_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.finalizer_transaction_claims AS claim
    WHERE claim.transaction_id = NEW.transaction_id
      AND claim.workspace_id = NEW.workspace_id
      AND claim.id = NEW.id
      AND claim.consumed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'transaction-scoped finalizer claim must be consumed before commit'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$function$;
ALTER FUNCTION app.require_consumed_finalizer_claim_at_commit() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.require_consumed_finalizer_claim_at_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER finalizer_transaction_claims_must_be_consumed
AFTER INSERT OR UPDATE OF consumed_at ON public.finalizer_transaction_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.require_consumed_finalizer_claim_at_commit();

CREATE FUNCTION auth.issue_internal_service_attestation(
  p_attestation_id uuid,
  p_workspace_id uuid,
  p_subject_session_user name,
  p_phase text,
  p_audience text,
  p_binding_sha256 bytea,
  p_verifier_hmac bytea,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_phase_role name;
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user,
    'ba_internal_service_attestation_issuer',
    'MEMBER'
  ) THEN
    RAISE EXCEPTION 'internal service attestation issuance requires the issuer role'
      USING ERRCODE = '42501';
  END IF;
  v_phase_role := CASE p_phase
    WHEN 'admission' THEN 'ba_admission_executor'::name
    WHEN 'execution' THEN 'ba_execution_executor'::name
    WHEN 'metering' THEN 'ba_metering_executor'::name
    WHEN 'finalizer' THEN 'ba_finalizer_executor'::name
    WHEN 'reclaimer' THEN 'ba_reclaimer_executor'::name
    WHEN 'reconciliation' THEN 'ba_reconciliation_executor'::name
    WHEN 'archive_evidence' THEN 'ba_archive_evidence_executor'::name
    WHEN 'retention' THEN 'ba_retention_executor'::name
    ELSE NULL
  END;
  IF v_phase_role IS NULL
     OR p_audience IS DISTINCT FROM 'better-agent/internal-service/1'
     OR octet_length(p_binding_sha256) <> 32
     OR octet_length(p_verifier_hmac) <> 32
     OR p_expires_at <= v_now
     OR p_expires_at > v_now + interval '15 minutes'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS subject_role
       WHERE subject_role.rolname = p_subject_session_user
         AND subject_role.rolcanlogin
         AND pg_catalog.pg_has_role(subject_role.oid, v_phase_role, 'MEMBER')
     ) THEN
    RAISE EXCEPTION 'invalid internal service attestation binding'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO auth.internal_service_attestations (
    id, workspace_id, subject_session_user, phase, audience,
    binding_sha256, verifier_hmac, issued_at, expires_at
  ) VALUES (
    p_attestation_id, p_workspace_id, p_subject_session_user, p_phase, p_audience,
    p_binding_sha256, p_verifier_hmac, v_now, p_expires_at
  );
END;
$function$;
ALTER FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, name, text, text, bytea, bytea, timestamptz
) OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, name, text, text, bytea, bytea, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, name, text, text, bytea, bytea, timestamptz
) TO ba_internal_service_attestation_issuer;

CREATE FUNCTION auth.revoke_internal_service_attestation(
  p_attestation_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user,
    'ba_internal_service_attestation_issuer',
    'MEMBER'
  ) OR length(btrim(p_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid internal service attestation revocation'
      USING ERRCODE = '42501';
  END IF;
  UPDATE auth.internal_service_attestations
  SET revoked_at = clock_timestamp(),
      revocation_reason = p_reason
  WHERE id = p_attestation_id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'internal service attestation is missing or already revoked'
      USING ERRCODE = 'P0002';
  END IF;
END;
$function$;
ALTER FUNCTION auth.revoke_internal_service_attestation(uuid, text) OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.revoke_internal_service_attestation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.revoke_internal_service_attestation(uuid, text)
TO ba_internal_service_attestation_issuer;

CREATE FUNCTION auth.establish_internal_service_workspace_context(
  p_attestation_id uuid,
  p_raw_secret bytea,
  p_phase text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_attestation auth.internal_service_attestations%ROWTYPE;
  v_expected_role name;
  v_presented_verifier bytea;
  v_signature text;
  v_txid bigint := txid_current();
BEGIN
  v_expected_role := CASE p_phase
    WHEN 'admission' THEN 'ba_admission_executor'::name
    WHEN 'execution' THEN 'ba_execution_executor'::name
    WHEN 'metering' THEN 'ba_metering_executor'::name
    WHEN 'finalizer' THEN 'ba_finalizer_executor'::name
    WHEN 'reclaimer' THEN 'ba_reclaimer_executor'::name
    WHEN 'reconciliation' THEN 'ba_reconciliation_executor'::name
    WHEN 'archive_evidence' THEN 'ba_archive_evidence_executor'::name
    WHEN 'retention' THEN 'ba_retention_executor'::name
    ELSE NULL
  END;
  IF v_expected_role IS NULL
     OR NOT pg_catalog.pg_has_role(session_user, v_expected_role, 'MEMBER') THEN
    RAISE EXCEPTION 'session_user is not enrolled for the requested internal phase'
      USING ERRCODE = '42501';
  END IF;
  SELECT attestation.*
  INTO v_attestation
  FROM auth.internal_service_attestations AS attestation
  WHERE attestation.id = p_attestation_id
    AND attestation.subject_session_user = session_user::name
    AND attestation.phase = p_phase
    AND attestation.audience = 'better-agent/internal-service/1'
    AND attestation.revoked_at IS NULL
    AND attestation.expires_at > clock_timestamp()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'internal service attestation is unavailable for this binding'
      USING ERRCODE = '42501';
  END IF;
  v_presented_verifier := public.hmac(
    p_raw_secret,
    convert_to('better-agent/internal-service-attestation-verifier/1', 'UTF8')
      || decode('00', 'hex'),
    'sha256'
  );
  IF NOT auth.constant_time_equal_32(v_presented_verifier, v_attestation.verifier_hmac) THEN
    RAISE EXCEPTION 'internal service attestation verification failed'
      USING ERRCODE = '42501';
  END IF;
  v_signature := encode(
    public.hmac(
      convert_to(format(
        'internal:%s:%s:%s:%s:%s',
        v_attestation.workspace_id,
        v_attestation.id,
        v_attestation.phase,
        v_txid,
        session_user
      ), 'UTF8'),
      v_attestation.verifier_hmac,
      'sha256'
    ),
    'hex'
  );
  PERFORM set_config(
    'app.tenant_context',
    format(
      'internal:%s:%s:%s:%s:%s:%s',
      v_attestation.workspace_id,
      v_attestation.id,
      v_attestation.phase,
      v_txid,
      session_user,
      v_signature
    ),
    true
  );
  RETURN v_attestation.workspace_id;
END;
$function$;
ALTER FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text) OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text)
TO ba_admission_executor,
   ba_execution_executor,
   ba_metering_executor,
   ba_finalizer_executor,
   ba_reclaimer_executor,
   ba_reconciliation_executor,
   ba_archive_evidence_executor,
   ba_retention_executor;

CREATE OR REPLACE FUNCTION app.current_workspace_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_context text := current_setting('app.tenant_context', true);
  v_parts text[];
  v_workspace_id uuid;
  v_credential_id uuid;
  v_attestation_id uuid;
  v_principal_id uuid;
  v_session_id uuid;
  v_deployment_id uuid;
  v_phase text;
  v_txid bigint;
  v_signature text;
  v_expected_signature text;
BEGIN
  IF v_context IS NULL OR v_context = '' THEN
    RETURN NULL;
  END IF;
  v_parts := string_to_array(v_context, ':');

  IF array_length(v_parts, 1) = 6 AND v_parts[1] = 'control' THEN
    v_workspace_id := v_parts[2]::uuid;
    v_attestation_id := v_parts[3]::uuid;
    v_principal_id := v_parts[4]::uuid;
    v_txid := v_parts[5]::bigint;
    v_signature := v_parts[6];
    IF v_txid <> txid_current() OR v_signature !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;
    SELECT encode(
      public.hmac(
        convert_to(format(
          'control:%s:%s:%s:%s:%s',
          att.workspace_id, att.id, att.principal_id, v_txid, session_user
        ), 'UTF8'),
        att.attestation_verifier_hmac,
        'sha256'
      ),
      'hex'
    )
      INTO v_expected_signature
      FROM auth.control_session_attestations AS att
     WHERE att.id = v_attestation_id
       AND att.workspace_id = v_workspace_id
       AND att.principal_id = v_principal_id
       AND att.bound_session_user = session_user::name
       AND att.revoked_at IS NULL
       AND att.expires_at > clock_timestamp()
       AND EXISTS (
         SELECT 1
           FROM public.workspace_members AS member
          WHERE member.workspace_id = att.workspace_id
            AND member.user_id = att.principal_id
            AND member.role IN ('admin', 'developer')
       );
  ELSIF array_length(v_parts, 1) = 5 AND v_parts[1] = 'credential' THEN
    v_workspace_id := v_parts[2]::uuid;
    v_credential_id := v_parts[3]::uuid;
    v_txid := v_parts[4]::bigint;
    v_signature := v_parts[5];
    IF v_txid <> txid_current() OR v_signature !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;
    SELECT encode(
      public.hmac(
        convert_to(format(
          'credential:%s:%s:%s:%s',
          idx.workspace_id, idx.credential_id, v_txid, session_user
        ), 'UTF8'),
        idx.secret_verifier_hmac,
        'sha256'
      ),
      'hex'
    )
      INTO v_expected_signature
      FROM auth.credential_auth_index AS idx
     WHERE idx.workspace_id = v_workspace_id
       AND idx.credential_id = v_credential_id
       AND idx.status IN ('active', 'overlap')
       AND (
         idx.status <> 'overlap'
         OR (idx.expires_at IS NOT NULL AND idx.rotation_group IS NOT NULL)
       )
       AND (idx.not_before_at IS NULL OR idx.not_before_at <= clock_timestamp())
       AND (idx.expires_at IS NULL OR idx.expires_at > clock_timestamp())
       AND idx.revoked_at IS NULL;
  ELSIF array_length(v_parts, 1) = 7 AND v_parts[1] = 'browser' THEN
    v_workspace_id := v_parts[2]::uuid;
    v_session_id := v_parts[3]::uuid;
    v_principal_id := v_parts[4]::uuid;
    v_deployment_id := v_parts[5]::uuid;
    v_txid := v_parts[6]::bigint;
    v_signature := v_parts[7];
    IF v_txid <> txid_current() OR v_signature !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;
    SELECT encode(
      public.hmac(
        convert_to(format(
          'browser:%s:%s:%s:%s:%s:%s',
          session_row.workspace_id,
          session_row.id,
          session_row.principal_id,
          session_row.agent_deployment_id,
          v_txid,
          session_user
        ), 'UTF8'),
        private_row.verifier_hmac,
        'sha256'
      ),
      'hex'
    )
      INTO v_expected_signature
      FROM auth.browser_session_auth_index AS private_row
      JOIN public.browser_sessions AS session_row
        ON session_row.workspace_id = private_row.workspace_id
       AND session_row.id = private_row.browser_session_id
      JOIN public.end_user_principals AS principal
        ON principal.workspace_id = session_row.workspace_id
       AND principal.id = session_row.principal_id
      JOIN public.agent_deployment_security_states AS security_state
        ON security_state.workspace_id = session_row.workspace_id
       AND security_state.agent_deployment_id = session_row.agent_deployment_id
     WHERE private_row.workspace_id = v_workspace_id
       AND private_row.browser_session_id = v_session_id
       AND private_row.status = 'ACTIVE'
       AND private_row.session_epoch = session_row.session_epoch
       AND private_row.expires_at = session_row.expires_at
       AND private_row.expires_at > clock_timestamp()
       AND session_row.principal_id = v_principal_id
       AND session_row.agent_deployment_id = v_deployment_id
       AND session_row.status = 'ACTIVE'
       AND principal.status = 'active'
       AND principal.session_epoch = session_row.observed_principal_session_epoch
       AND security_state.status = 'ACTIVE'
       AND security_state.revoke_epoch = session_row.observed_deployment_revoke_epoch;
  ELSIF array_length(v_parts, 1) = 7 AND v_parts[1] = 'internal' THEN
    v_workspace_id := v_parts[2]::uuid;
    v_attestation_id := v_parts[3]::uuid;
    v_phase := v_parts[4];
    v_txid := v_parts[5]::bigint;
    v_signature := v_parts[7];
    IF v_txid <> txid_current()
       OR v_parts[6] IS DISTINCT FROM session_user
       OR v_signature !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;
    SELECT encode(
      public.hmac(
        convert_to(format(
          'internal:%s:%s:%s:%s:%s',
          attestation.workspace_id,
          attestation.id,
          attestation.phase,
          v_txid,
          session_user
        ), 'UTF8'),
        attestation.verifier_hmac,
        'sha256'
      ),
      'hex'
    )
    INTO v_expected_signature
    FROM auth.internal_service_attestations AS attestation
    WHERE attestation.id = v_attestation_id
      AND attestation.workspace_id = v_workspace_id
      AND attestation.subject_session_user = session_user::name
      AND attestation.phase = v_phase
      AND attestation.revoked_at IS NULL
      AND attestation.expires_at > clock_timestamp();
  ELSE
    RETURN NULL;
  END IF;

  IF v_expected_signature IS NULL
     OR NOT auth.constant_time_equal_32(
       decode(v_signature, 'hex'), decode(v_expected_signature, 'hex')
     ) THEN
    RETURN NULL;
  END IF;
  RETURN v_workspace_id;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;
ALTER FUNCTION app.current_workspace_id() OWNER TO ba_auth_owner;

CREATE OR REPLACE FUNCTION app.current_authenticated_principal_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_context text := current_setting('app.tenant_context', true);
  v_parts text[];
  v_workspace_id uuid := app.current_workspace_id();
BEGIN
  IF v_workspace_id IS NULL OR v_context IS NULL OR v_context = '' THEN
    RETURN NULL;
  END IF;
  v_parts := string_to_array(v_context, ':');
  IF array_length(v_parts, 1) = 5
     AND v_parts[1] = 'credential'
     AND v_parts[2]::uuid = v_workspace_id THEN
    RETURN 'credential:' || v_parts[3]::uuid::text;
  END IF;
  IF array_length(v_parts, 1) = 6
     AND v_parts[1] = 'control'
     AND v_parts[2]::uuid = v_workspace_id THEN
    RETURN 'user:' || v_parts[4]::uuid::text;
  END IF;
  IF array_length(v_parts, 1) = 7
     AND v_parts[1] = 'browser'
     AND v_parts[2]::uuid = v_workspace_id THEN
    RETURN 'end_user:' || v_parts[4]::uuid::text;
  END IF;
  RETURN NULL;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;
ALTER FUNCTION app.current_authenticated_principal_id() OWNER TO ba_auth_owner;

CREATE FUNCTION auth.require_internal_service_phase(p_phase text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_context text := current_setting('app.tenant_context', true);
  v_parts text[] := string_to_array(v_context, ':');
  v_expected_role name;
BEGIN
  v_expected_role := CASE p_phase
    WHEN 'admission' THEN 'ba_admission_executor'::name
    WHEN 'execution' THEN 'ba_execution_executor'::name
    WHEN 'metering' THEN 'ba_metering_executor'::name
    WHEN 'finalizer' THEN 'ba_finalizer_executor'::name
    WHEN 'reclaimer' THEN 'ba_reclaimer_executor'::name
    WHEN 'reconciliation' THEN 'ba_reconciliation_executor'::name
    WHEN 'archive_evidence' THEN 'ba_archive_evidence_executor'::name
    WHEN 'retention' THEN 'ba_retention_executor'::name
    ELSE NULL
  END;
  IF v_workspace_id IS NULL
     OR array_length(v_parts, 1) <> 7
     OR v_parts[1] <> 'internal'
     OR v_parts[4] IS DISTINCT FROM p_phase
     OR v_parts[6] IS DISTINCT FROM session_user
     OR v_expected_role IS NULL
     OR NOT pg_catalog.pg_has_role(session_user, v_expected_role, 'MEMBER') THEN
    RAISE EXCEPTION 'internal service phase proof is missing or mismatched'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_workspace_id;
END;
$function$;
ALTER FUNCTION auth.require_internal_service_phase(text) OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.require_internal_service_phase(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.require_internal_service_phase(text)
TO ba_run_owner, ba_billing_owner, ba_archive_evidence_owner, ba_retention;

CREATE FUNCTION app.g007_sha256(p_domain text, p_payload text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
  SELECT 'sha256:' || encode(
    public.digest(
      convert_to(p_domain, 'UTF8') || decode('00', 'hex') || convert_to(p_payload, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$function$;
ALTER FUNCTION app.g007_sha256(text, text) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.g007_sha256(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.g007_sha256(text, text) TO ba_billing_owner;

CREATE FUNCTION app.g007_canonical_json(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_type text := jsonb_typeof(p_value);
  v_result text;
BEGIN
  IF v_type = 'object' THEN
    SELECT '{' || COALESCE(string_agg(
      to_json(object_entry.key)::text || ':' || app.g007_canonical_json(object_entry.value),
      ',' ORDER BY object_entry.key COLLATE "C"
    ), '') || '}'
    INTO v_result
    FROM jsonb_each(p_value) AS object_entry;
    RETURN v_result;
  ELSIF v_type = 'array' THEN
    SELECT '[' || COALESCE(string_agg(
      app.g007_canonical_json(array_entry.value),
      ',' ORDER BY array_entry.ordinality
    ), '') || ']'
    INTO v_result
    FROM jsonb_array_elements(p_value) WITH ORDINALITY AS array_entry(value, ordinality);
    RETURN v_result;
  ELSIF v_type = 'string' THEN
    RETURN to_json(p_value #>> '{}')::text;
  ELSIF v_type IN ('number', 'boolean', 'null') THEN
    RETURN p_value::text;
  END IF;
  RAISE EXCEPTION 'unsupported canonical JSON value'
    USING ERRCODE = '22023';
END;
$function$;
ALTER FUNCTION app.g007_canonical_json(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.g007_canonical_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.g007_canonical_json(jsonb) TO ba_billing_owner;

CREATE FUNCTION app.g007_canonical_sha256(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
  SELECT 'sha256:' || encode(
    public.digest(convert_to(app.g007_canonical_json(p_value), 'UTF8'), 'sha256'),
    'hex'
  )
$function$;
ALTER FUNCTION app.g007_canonical_sha256(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.g007_canonical_sha256(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.g007_canonical_sha256(jsonb) TO ba_billing_owner;

CREATE FUNCTION app.g007_contract_instant(p_value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
  SELECT to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$function$;
ALTER FUNCTION app.g007_contract_instant(timestamptz) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.g007_contract_instant(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.g007_contract_instant(timestamptz) TO ba_billing_owner;

DO $g007_cross_language_hash_vectors$
DECLARE
  v_workspace text := '018f47f2-c541-7cc6-9292-4a2c35303201';
  v_billing_run text := '018f47f2-c541-7cc6-9292-4a2c35303202';
  v_metered_run text := '018f47f2-c541-7cc6-9292-4a2c35303203';
  v_reservation text := '018f47f2-c541-7cc6-9292-4a2c35303204';
  v_attempt text := '018f47f2-c541-7cc6-9292-4a2c35303205';
  v_step text := '018f47f2-c541-7cc6-9292-4a2c35303206';
  v_token text := '018f47f2-c541-7cc6-9292-4a2c35303207';
  v_usage text := '018f47f2-c541-7cc6-9292-4a2c35303208';
  v_termination text := '018f47f2-c541-7cc6-9292-4a2c35303209';
  v_cancel text := '018f47f2-c541-7cc6-9292-4a2c3530320a';
  v_hash_a text := 'sha256:' || repeat('a', 64);
  v_hash_b text := 'sha256:' || repeat('b', 64);
  v_usage_hash text := 'sha256:367977effd85124e39490e5d18b586c251e44e4d29d34a6c6a27169072c62dd2';
  v_termination_hash text := 'sha256:b92e3d1381c68ee6cbe7921494e72edc4a609fb67841cf1c6c6b7d7d2ba1c375';
  v_cancel_hash text := 'sha256:0d71b017793fdaf4e92db810b99dd5a2c10dd7dbf739915d9edf56324d36ba2d';
  v_usage_source jsonb;
  v_termination_source jsonb;
  v_cancel_source jsonb;
  v_usage_intent jsonb;
  v_termination_intent jsonb;
  v_cancel_intent jsonb;
BEGIN
  v_usage_source := jsonb_build_object(
    'schema_version', 'run-usage-attribution/1',
    'workspace_id', v_workspace, 'billing_owner_run_id', v_billing_run,
    'run_id', v_metered_run, 'reservation_id', v_reservation,
    'usage_attribution_id', v_usage, 'attempt_id', v_attempt, 'step_id', v_step,
    'lease_owner', 'ba_execution_worker_a', 'lease_token', v_token,
    'lease_fencing_token', '7', 'producer_session_user', 'ba_execution_worker_a',
    'producer_operation_key', 'usage:test-vector',
    'metering_unit', 'tokens', 'metering_quantity', '12', 'amount_credits', '3',
    'settlement_operation_key', 'settle:usage:12',
    'operation_intent_sha256', v_hash_a,
    'lease_expires_at', '2026-08-28T01:00:30.000Z',
    'authorized_at', '2026-08-28T01:00:00.000Z',
    'execution_effect_payload_sha256', v_hash_b,
    'consumption_generation', '1'
  );
  v_termination_source := jsonb_build_object(
    'schema_version', 'run-termination-intent/1',
    'workspace_id', v_workspace, 'billing_owner_run_id', v_billing_run,
    'run_id', v_metered_run, 'reservation_id', v_reservation,
    'termination_intent_id', v_termination, 'attempt_id', v_attempt, 'step_id', v_step,
    'lease_owner', 'ba_execution_worker_a', 'lease_token', v_token,
    'lease_fencing_token', '7', 'producer_session_user', 'ba_execution_worker_a',
    'producer_operation_key', 'termination:test-vector',
    'terminal_status', 'CANCELLED', 'termination_reason', 'USER_CANCELLED',
    'effect_disposition', 'CLOSED', 'effect_closure_sha256', v_hash_a,
    'usage_attribution_ids', jsonb_build_array(v_usage),
    'intended_settle_credits', '3',
    'settlement_operation_key', 'settle:terminal:usage-set',
    'intended_release_credits', '2',
    'release_operation_key', 'release:terminal:remainder',
    'release_reason_code', 'USER_CANCELLED',
    'operation_intent_sha256', v_hash_b,
    'lease_expires_at', '2026-08-28T01:00:30.000Z',
    'authorized_at', '2026-08-28T01:00:00.000Z',
    'consumption_generation', '1'
  );
  v_cancel_source := jsonb_build_object(
    'schema_version', 'run-cancellation-release-authority/1',
    'workspace_id', v_workspace, 'run_id', v_billing_run,
    'billing_owner_run_id', v_billing_run, 'reservation_id', v_reservation,
    'cancel_event_id', v_cancel, 'cancel_event_sequence', '4',
    'cancel_intent_sha256', v_hash_a, 'terminal_intent_sha256', v_hash_b,
    'effect_closure_sha256', v_hash_a, 'remaining_credits', '2',
    'release_operation_key', 'release:cancel:4',
    'release_reason_code', 'USER_CANCELLED',
    'authorized_at', '2026-08-28T01:00:00.000Z'
  );

  IF app.g007_sha256(
       'better-agent/execution-usage-source/1',
       app.g007_canonical_json(v_usage_source - ARRAY['lease_owner', 'consumption_generation'])
     ) <> v_usage_hash
     OR app.g007_sha256(
       'better-agent/execution-termination-source/1',
       app.g007_canonical_json(
         v_termination_source - ARRAY['lease_owner', 'consumption_generation']
       )
     ) <> v_termination_hash
     OR app.g007_sha256(
       'better-agent/run-cancellation-release-source/1',
       app.g007_canonical_json(v_cancel_source)
     ) <> v_cancel_hash THEN
    RAISE EXCEPTION 'G0-07 PostgreSQL source hashing diverges from frozen TypeScript vectors'
      USING ERRCODE = '55000';
  END IF;

  v_usage_intent := jsonb_build_object(
    'schema_version', 'billing-intent/2', 'workspace_id', v_workspace,
    'billing_owner_run_id', v_billing_run, 'reservation_id', v_reservation,
    'amount_credits', '3',
    'charge_key', 'billing-v2/usage_attribution/' || v_usage || '/' || substr(v_usage_hash, 8),
    'charge_attribution_hash', v_usage_hash, 'intent_kind', 'SETTLE',
    'authority', jsonb_build_object(
      'schema_version', 'billing-authority-reference/1',
      'authority_kind', 'USAGE_ATTRIBUTION',
      'source_schema_version', 'run-usage-attribution/1',
      'source_id', v_usage, 'source_authority_hash', v_usage_hash,
      'producer_run_id', v_metered_run, 'producer_attempt_id', v_attempt,
      'producer_lease_fencing_token', '7', 'step_id', v_step
    )
  );
  v_termination_intent := jsonb_build_object(
    'schema_version', 'billing-intent/2', 'workspace_id', v_workspace,
    'billing_owner_run_id', v_billing_run, 'reservation_id', v_reservation,
    'amount_credits', '2',
    'charge_key', 'billing-v2/termination_attribution/' || v_termination || '/' || substr(v_termination_hash, 8),
    'charge_attribution_hash', v_termination_hash, 'intent_kind', 'RELEASE',
    'authority', jsonb_build_object(
      'schema_version', 'billing-authority-reference/1',
      'authority_kind', 'TERMINATION_ATTRIBUTION',
      'source_schema_version', 'run-termination-intent/1',
      'source_id', v_termination, 'source_authority_hash', v_termination_hash,
      'producer_run_id', v_metered_run, 'producer_attempt_id', v_attempt,
      'producer_lease_fencing_token', '7', 'step_id', v_step
    )
  );
  v_cancel_intent := jsonb_build_object(
    'schema_version', 'billing-intent/2', 'workspace_id', v_workspace,
    'billing_owner_run_id', v_billing_run, 'reservation_id', v_reservation,
    'amount_credits', '2',
    'charge_key', 'billing-v2/cancellation_release/' || v_cancel || '/' || substr(v_cancel_hash, 8),
    'charge_attribution_hash', v_cancel_hash, 'intent_kind', 'RELEASE',
    'authority', jsonb_build_object(
      'schema_version', 'billing-authority-reference/1',
      'authority_kind', 'CANCELLATION_RELEASE',
      'source_schema_version', 'run-cancellation-release-authority/1',
      'source_id', v_cancel, 'source_authority_hash', v_cancel_hash
    )
  );
  IF app.g007_canonical_sha256(v_usage_intent)
       <> 'sha256:e632bb5a5893c1779563bd0ee268c225aa038fd28d8a1349d638a75251e8adf8'
     OR app.g007_canonical_sha256(v_termination_intent)
       <> 'sha256:26a38e9d30c50ca8739117e3a3df6a977f9772228beca3ce82aeaaaeb724504e'
     OR app.g007_canonical_sha256(v_cancel_intent)
       <> 'sha256:721b9de33a2eee3688cfe00a62ac3a183672e3296dd1c4777e6607241650d4e3' THEN
    RAISE EXCEPTION 'G0-07 PostgreSQL billing intent hashing diverges from frozen TypeScript vectors'
      USING ERRCODE = '55000';
  END IF;
END;
$g007_cross_language_hash_vectors$;

CREATE FUNCTION app.g007_attempt_effect_closure_sha256(
  p_workspace_id uuid,
  p_run_id uuid,
  p_attempt_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
  SELECT app.g007_sha256(
    'better-agent/run-effect-closure/1',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'envelope_sha256', envelope.envelope_sha256,
        'receipt_sha256', receipt.receipt_sha256,
        'disposition', receipt.disposition
      ) ORDER BY envelope.id)::text
      FROM public.run_retry_effect_envelopes AS envelope
      LEFT JOIN public.run_side_effect_receipts AS receipt
        ON receipt.workspace_id = envelope.workspace_id
       AND receipt.envelope_id = envelope.id
      WHERE envelope.workspace_id = p_workspace_id
        AND envelope.run_id = p_run_id
        AND envelope.attempt_id = p_attempt_id
    ), '[]')
  )
$function$;
ALTER FUNCTION app.g007_attempt_effect_closure_sha256(uuid, uuid, uuid)
OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.g007_attempt_effect_closure_sha256(uuid, uuid, uuid)
FROM PUBLIC;

CREATE FUNCTION app.g007_attempt_recovery_effect_decisions(
  p_workspace_id uuid,
  p_run_id uuid,
  p_attempt_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
  SELECT jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'retry_effect_envelope_id', envelope.id,
      'retry_effect_envelope_sha256', envelope.envelope_sha256,
      'effect_class', upper(envelope.effect_class),
      'recovery_decision', CASE
        WHEN receipt.disposition = 'UNKNOWN' THEN NULL
        WHEN receipt.disposition = 'CONFIRMED' THEN 'RESUME_FROM_RECEIPT'
        WHEN envelope.effect_class = 'safe' THEN 'REPLAY_SAFE'
        WHEN envelope.effect_class = 'requires_key' THEN 'REPLAY_WITH_KEY'
        ELSE NULL
      END,
      'operation_key', envelope.operation_key,
      'effect_receipt_id', CASE
        WHEN receipt.disposition = 'CONFIRMED' THEN receipt.id
        ELSE NULL
      END,
      'effect_receipt_sha256', CASE
        WHEN receipt.disposition = 'CONFIRMED' THEN receipt.receipt_sha256
        ELSE NULL
      END
    ))
    ORDER BY envelope.id
  )
  FROM public.run_retry_effect_envelopes AS envelope
  LEFT JOIN public.run_side_effect_receipts AS receipt
    ON receipt.workspace_id = envelope.workspace_id
   AND receipt.envelope_id = envelope.id
  WHERE envelope.workspace_id = p_workspace_id
    AND envelope.run_id = p_run_id
    AND envelope.attempt_id = p_attempt_id
$function$;
ALTER FUNCTION app.g007_attempt_recovery_effect_decisions(uuid, uuid, uuid)
OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.g007_attempt_recovery_effect_decisions(uuid, uuid, uuid)
FROM PUBLIC;

CREATE FUNCTION app.validate_g007_recovery_ticket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_decision jsonb;
  v_current_id text;
  v_previous_id text;
  v_expected_decisions jsonb;
  v_expected_digest text;
BEGIN
  IF NEW.checkpoint_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.run_checkpoints AS checkpoint
    WHERE checkpoint.workspace_id = NEW.workspace_id
      AND checkpoint.run_id = NEW.run_id
      AND checkpoint.id = NEW.checkpoint_id
      AND checkpoint.checkpoint_hash = NEW.checkpoint_sha256
      AND (
        NEW.resource_kind <> 'ATTEMPT'
        OR checkpoint.producer_attempt_id = NEW.resource_id
      )
  ) THEN
    RAISE EXCEPTION 'recovery checkpoint binding is unavailable'
      USING ERRCODE = '23514';
  END IF;
  -- HOLD rows share the checkpoint boundary but do not carry ticket decisions.
  IF TG_TABLE_NAME = 'run_recovery_hold_intents' THEN
    RETURN NEW;
  END IF;

  FOR v_decision IN
    SELECT value
    FROM jsonb_array_elements(NEW.effect_decisions)
  LOOP
    IF jsonb_typeof(v_decision) <> 'object'
       OR (v_decision - ARRAY[
         'retry_effect_envelope_id', 'retry_effect_envelope_sha256',
         'effect_class', 'recovery_decision', 'operation_key',
         'effect_receipt_id', 'effect_receipt_sha256'
       ]) <> '{}'::jsonb
       OR NOT v_decision ? 'retry_effect_envelope_id'
       OR NOT v_decision ? 'retry_effect_envelope_sha256'
       OR NOT v_decision ? 'effect_class'
       OR NOT v_decision ? 'recovery_decision'
       OR (v_decision ->> 'retry_effect_envelope_sha256')
         !~ '^sha256:[0-9a-f]{64}$'
       OR (v_decision ->> 'effect_class') NOT IN ('SAFE', 'REQUIRES_KEY')
       OR ((v_decision ? 'effect_receipt_id') <> (v_decision ? 'effect_receipt_sha256'))
       OR (
         v_decision ? 'effect_receipt_sha256'
         AND (v_decision ->> 'effect_receipt_sha256') !~ '^sha256:[0-9a-f]{64}$'
       )
       OR NOT (
         (
           v_decision ->> 'effect_class' = 'SAFE'
           AND v_decision ->> 'recovery_decision' = 'REPLAY_SAFE'
           AND NOT v_decision ? 'operation_key'
           AND NOT v_decision ? 'effect_receipt_id'
         ) OR (
           v_decision ->> 'effect_class' = 'REQUIRES_KEY'
           AND v_decision ->> 'recovery_decision' = 'REPLAY_WITH_KEY'
           AND length(btrim(v_decision ->> 'operation_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
           AND NOT v_decision ? 'effect_receipt_id'
         ) OR (
           v_decision ->> 'recovery_decision' = 'RESUME_FROM_RECEIPT'
           AND v_decision ? 'effect_receipt_id'
           AND (
             (
               v_decision ->> 'effect_class' = 'SAFE'
               AND NOT v_decision ? 'operation_key'
             ) OR (
               v_decision ->> 'effect_class' = 'REQUIRES_KEY'
               AND length(btrim(v_decision ->> 'operation_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) BETWEEN 1 AND 300
             )
           )
         )
       ) THEN
      RAISE EXCEPTION 'recovery ticket contains an invalid effect decision'
        USING ERRCODE = '23514';
    END IF;
    PERFORM (v_decision ->> 'retry_effect_envelope_id')::uuid;
    IF v_decision ? 'effect_receipt_id' THEN
      PERFORM (v_decision ->> 'effect_receipt_id')::uuid;
    END IF;
    v_current_id := v_decision ->> 'retry_effect_envelope_id';
    IF v_previous_id IS NOT NULL AND v_current_id <= v_previous_id THEN
      RAISE EXCEPTION 'recovery ticket effect decisions must be unique and sorted'
        USING ERRCODE = '23514';
    END IF;
    v_previous_id := v_current_id;
  END LOOP;

  v_expected_digest := app.g007_sha256(
    'better-agent/run-recovery-effect-decision-set/1',
    jsonb_build_object(
      'schema_version', 'run-recovery-effect-decision-set/1',
      'effect_decisions', NEW.effect_decisions
    )::text
  );
  IF NEW.effect_decisions_sha256 IS DISTINCT FROM v_expected_digest THEN
    RAISE EXCEPTION 'recovery ticket effect decision digest is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.resource_kind = 'ATTEMPT' THEN
    v_expected_decisions := app.g007_attempt_recovery_effect_decisions(
      NEW.workspace_id, NEW.run_id, NEW.resource_id
    );
    IF NEW.effect_decisions IS DISTINCT FROM v_expected_decisions THEN
      RAISE EXCEPTION 'Attempt recovery ticket decisions do not match locked effects'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT jsonb_build_array(jsonb_build_object(
      'retry_effect_envelope_id', message.id,
      'retry_effect_envelope_sha256', message.payload_hash,
      'effect_class', 'SAFE',
      'recovery_decision', 'REPLAY_SAFE'
    ))
    INTO v_expected_decisions
    FROM public.outbox AS message
    WHERE message.workspace_id = NEW.workspace_id
      AND message.run_id = NEW.run_id
      AND message.id = NEW.resource_id
      AND message.message_type = 'RUN_DISPATCH';
    IF NEW.effect_decisions IS DISTINCT FROM v_expected_decisions THEN
      RAISE EXCEPTION 'RUN_DISPATCH recovery ticket does not bind its payload'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION app.validate_g007_recovery_ticket() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.validate_g007_recovery_ticket() FROM PUBLIC;
CREATE TRIGGER run_recovery_tickets_validate
BEFORE INSERT ON public.run_recovery_tickets
FOR EACH ROW EXECUTE FUNCTION app.validate_g007_recovery_ticket();
CREATE TRIGGER run_recovery_hold_intents_validate
BEFORE INSERT ON public.run_recovery_hold_intents
FOR EACH ROW EXECUTE FUNCTION app.validate_g007_recovery_ticket();

CREATE FUNCTION app.require_execution_owner_lease(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('execution');
  v_run public.runs%ROWTYPE;
  v_attempt public.run_attempts%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR p_fact ? 'workspace_id'
     OR jsonb_typeof(p_fact -> 'run_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'attempt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_fencing_token') IS DISTINCT FROM 'string'
     OR (
       p_fact ? 'step_id'
       AND jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
     )
     OR COALESCE(p_fact ->> 'run_id', '')
          !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id', '')
          !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token', '')
          !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
     OR (
       p_fact ? 'step_id'
       AND COALESCE(p_fact ->> 'step_id', '')
            !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
     )
     OR COALESCE(p_fact ->> 'lease_fencing_token', '') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'execution lease authority shape is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF length(p_fact ->> 'lease_fencing_token') > 16 THEN
    RAISE EXCEPTION 'execution lease authority shape is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (p_fact ->> 'lease_fencing_token')::numeric > 9007199254740991 THEN
    RAISE EXCEPTION 'execution lease authority shape is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT run_row.*
  INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
     OR v_run.terminal_intent_hash IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM public.run_termination_intents AS source
       WHERE source.workspace_id = v_workspace_id
         AND source.run_id = v_run.id
     ) THEN
    RAISE EXCEPTION 'Run is not executable under this phase proof'
      USING ERRCODE = '55000';
  END IF;
  SELECT attempt.*
  INTO v_attempt
  FROM public.run_attempts AS attempt
  WHERE attempt.workspace_id = v_workspace_id
    AND attempt.run_id = v_run.id
    AND attempt.id = (p_fact ->> 'attempt_id')::uuid
  FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND
     OR v_attempt.runtime_protocol_version <> 5
     OR v_attempt.status <> 'RUNNING'
     OR v_attempt.lease_owner IS DISTINCT FROM session_user
     OR v_attempt.lease_token IS DISTINCT FROM (p_fact ->> 'lease_token')::uuid
     OR v_attempt.lease_fencing_token IS DISTINCT FROM
          (p_fact ->> 'lease_fencing_token')::bigint
     OR v_attempt.lease_generation IS DISTINCT FROM v_attempt.lease_fencing_token
     OR v_attempt.lease_expires_at <= v_now THEN
    RAISE EXCEPTION 'execution lease is missing, stale, expired or owned by another session_user'
      USING ERRCODE = '42501';
  END IF;
  IF p_fact ->> 'step_id' IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.run_steps AS step
       WHERE step.workspace_id = v_workspace_id
         AND step.run_id = v_run.id
         AND step.attempt_id = v_attempt.id
         AND step.id = (p_fact ->> 'step_id')::uuid
     ) THEN
    RAISE EXCEPTION 'execution lease does not bind the requested Step'
      USING ERRCODE = '23503';
  END IF;
  RETURN jsonb_build_object(
    'workspace_id', v_workspace_id,
    'run_id', v_run.id,
    'attempt_id', v_attempt.id,
    'lease_owner', v_attempt.lease_owner,
    'lease_token', v_attempt.lease_token,
    'lease_fencing_token', v_attempt.lease_fencing_token::text,
    'lease_expires_at', v_attempt.lease_expires_at,
    'validated_at', v_now
  );
END;
$function$;
ALTER FUNCTION app.require_execution_owner_lease(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.require_execution_owner_lease(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_execution_owner_lease(jsonb) TO ba_run_owner;

CREATE FUNCTION app.require_committed_producer_attribution(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_kind text := p_fact ->> 'authority_kind';
  v_source_id uuid := (p_fact ->> 'source_id')::uuid;
  v_source_hash text := p_fact ->> 'source_authority_hash';
  v_consume boolean := COALESCE((p_fact ->> 'consume')::boolean, false);
  v_usage public.run_usage_attributions%ROWTYPE;
  v_termination public.run_termination_intents%ROWTYPE;
  v_result jsonb;
  v_preimage jsonb;
  v_rows integer;
BEGIN
  IF v_workspace_id IS NULL
     OR jsonb_typeof(p_fact) <> 'object'
     OR v_kind NOT IN ('EXECUTION_USAGE', 'EXECUTION_TERMINATION')
     OR v_source_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'committed producer attribution request is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF v_kind = 'EXECUTION_USAGE' THEN
    SELECT source.*
    INTO v_usage
    FROM public.run_usage_attributions AS source
    WHERE source.workspace_id = v_workspace_id
      AND source.id = v_source_id
      AND source.source_authority_hash = v_source_hash
      AND source.consumed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'committed usage attribution is missing, mismatched or consumed'
        USING ERRCODE = '42501';
    END IF;
    v_result := jsonb_build_object(
      'schema_version', 'run-usage-attribution/1',
      'usage_attribution_id', v_usage.id,
      'workspace_id', v_usage.workspace_id,
      'billing_owner_run_id', v_usage.billing_owner_run_id,
      'run_id', v_usage.run_id,
      'reservation_id', v_usage.reservation_id,
      'attempt_id', v_usage.attempt_id,
      'step_id', v_usage.step_id,
      'producer_session_user', v_usage.producer_session_user,
      'lease_owner', v_usage.producer_session_user,
      'lease_token', v_usage.producer_lease_token,
      'lease_fencing_token', v_usage.producer_lease_fencing_token::text,
      'lease_expires_at', app.g007_contract_instant(v_usage.producer_lease_expires_at),
      'authorized_at', app.g007_contract_instant(v_usage.authorized_at),
      'producer_operation_key', v_usage.producer_operation_key,
      'metering_unit', v_usage.metering_unit,
      'metering_quantity', v_usage.quantity::text,
      'amount_credits', v_usage.amount::text,
      'settlement_operation_key', v_usage.settlement_operation_key,
      'operation_intent_sha256', v_usage.operation_intent_sha256,
      'execution_effect_payload_sha256', v_usage.execution_effect_payload_sha256,
      'consumption_generation', v_usage.consumption_generation::text
    );
    v_preimage := v_result - ARRAY['lease_owner', 'consumption_generation'];
    IF app.g007_sha256(
         'better-agent/execution-usage-source/1', app.g007_canonical_json(v_preimage)
       ) IS DISTINCT FROM v_usage.source_authority_hash THEN
      RAISE EXCEPTION 'committed usage attribution canonical hash is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF v_consume THEN
      UPDATE public.run_usage_attributions
      SET consumed_at = clock_timestamp(),
          consumption_generation = consumption_generation + 1
      WHERE workspace_id = v_workspace_id
        AND id = v_source_id
        AND consumed_at IS NULL
        AND consumption_generation = v_usage.consumption_generation;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'usage attribution consumption generation lost its CAS race'
          USING ERRCODE = '40001';
      END IF;
    END IF;
    v_result := v_result || jsonb_build_object(
      'id', v_usage.id,
      'source_authority_hash', v_usage.source_authority_hash,
      'source_consumption_generation', v_usage.consumption_generation::text,
      'detail_redacted', v_usage.detail_redacted
    );
  ELSE
    SELECT source.*
    INTO v_termination
    FROM public.run_termination_intents AS source
    WHERE source.workspace_id = v_workspace_id
      AND source.id = v_source_id
      AND source.source_authority_hash = v_source_hash
      AND source.effect_disposition = 'CLOSED'
      AND source.consumed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'committed termination attribution is missing, mismatched or consumed'
        USING ERRCODE = '42501';
    END IF;
    v_result := jsonb_build_object(
      'schema_version', 'run-termination-intent/1',
      'termination_intent_id', v_termination.id,
      'workspace_id', v_termination.workspace_id,
      'billing_owner_run_id', v_termination.billing_owner_run_id,
      'run_id', v_termination.run_id,
      'reservation_id', v_termination.reservation_id,
      'attempt_id', v_termination.attempt_id,
      'step_id', v_termination.step_id,
      'producer_session_user', v_termination.producer_session_user,
      'lease_owner', v_termination.producer_session_user,
      'lease_token', v_termination.producer_lease_token,
      'lease_fencing_token', v_termination.producer_lease_fencing_token::text,
      'lease_expires_at', app.g007_contract_instant(v_termination.producer_lease_expires_at),
      'authorized_at', app.g007_contract_instant(v_termination.authorized_at),
      'producer_operation_key', v_termination.producer_operation_key,
      'terminal_status', v_termination.terminal_kind,
      'termination_reason', v_termination.termination_reason,
      'effect_disposition', v_termination.effect_disposition,
      'effect_closure_sha256', v_termination.effect_closure_sha256,
      'usage_attribution_ids', to_jsonb(v_termination.usage_attribution_ids),
      'intended_settle_credits', v_termination.intended_settle_credits::text,
      'settlement_operation_key', v_termination.settlement_operation_key,
      'intended_release_credits', v_termination.intended_release_credits::text,
      'release_operation_key', v_termination.release_operation_key,
      'release_reason_code', v_termination.release_reason_code,
      'operation_intent_sha256', v_termination.operation_intent_sha256,
      'consumption_generation', v_termination.consumption_generation::text
    );
    v_preimage := v_result - ARRAY['lease_owner', 'consumption_generation'];
    IF app.g007_sha256(
         'better-agent/execution-termination-source/1',
         app.g007_canonical_json(v_preimage)
       ) IS DISTINCT FROM v_termination.source_authority_hash THEN
      RAISE EXCEPTION 'committed termination attribution canonical hash is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF v_consume THEN
      UPDATE public.run_termination_intents
      SET consumed_at = clock_timestamp(),
          consumption_generation = consumption_generation + 1
      WHERE workspace_id = v_workspace_id
        AND id = v_source_id
        AND consumed_at IS NULL
        AND consumption_generation = v_termination.consumption_generation;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'termination attribution consumption generation lost its CAS race'
          USING ERRCODE = '40001';
      END IF;
    END IF;
    v_result := v_result || jsonb_build_object(
      'id', v_termination.id,
      'terminal_kind', v_termination.terminal_kind,
      'terminal_intent_hash', v_termination.terminal_intent_hash,
      'source_authority_hash', v_termination.source_authority_hash,
      'source_consumption_generation', v_termination.consumption_generation::text,
      'billing_close_intent_redacted', v_termination.billing_close_intent_redacted
    );
  END IF;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION app.require_committed_producer_attribution(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.require_committed_producer_attribution(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_committed_producer_attribution(jsonb)
TO ba_run_owner, ba_billing_owner;

CREATE FUNCTION app.require_transaction_finalizer_claim(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('finalizer');
  v_claim public.finalizer_transaction_claims%ROWTYPE;
BEGIN
  SELECT claim.*
  INTO v_claim
  FROM public.finalizer_transaction_claims AS claim
  WHERE claim.transaction_id = txid_current()
    AND claim.workspace_id = v_workspace_id
    AND claim.id = (p_fact ->> 'claim_id')::uuid
    AND claim.source_kind = p_fact ->> 'source_kind'
    AND claim.source_id = (p_fact ->> 'source_id')::uuid
    AND claim.source_sha256 = p_fact ->> 'source_sha256'
    AND claim.terminal_intent_hash = p_fact ->> 'terminal_intent_hash'
    AND claim.operation = p_fact ->> 'operation'
    AND claim.amount = (p_fact ->> 'amount')::bigint
    AND claim.consumed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction-scoped finalizer claim is unavailable or mismatched'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.finalizer_transaction_claims
  WHERE transaction_id = v_claim.transaction_id
    AND workspace_id = v_claim.workspace_id
    AND id = v_claim.id;
  RETURN to_jsonb(v_claim);
END;
$function$;
ALTER FUNCTION app.require_transaction_finalizer_claim(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.require_transaction_finalizer_claim(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_transaction_finalizer_claim(jsonb) TO ba_billing_owner;

CREATE FUNCTION app.claim_run_attempt(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('execution');
  v_run public.runs%ROWTYPE;
  v_attempt public.run_attempts%ROWTYPE;
  v_ticket public.run_recovery_tickets%ROWTYPE;
  v_now timestamptz;
  v_duration integer := (p_fact ->> 'duration_seconds')::integer;
  v_generation bigint;
  v_token uuid := gen_random_uuid();
  v_expiry timestamptz;
  v_disposition_id uuid;
  v_disposition jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR v_duration NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid Attempt claim request'
      USING ERRCODE = '22023';
  END IF;
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
     OR v_run.terminal_intent_hash IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM public.run_termination_intents AS source
       WHERE source.workspace_id = v_workspace_id
         AND source.run_id = v_run.id
     ) THEN
    RAISE EXCEPTION 'Run cannot admit a new execution lease'
      USING ERRCODE = '55000';
  END IF;
  SELECT attempt.* INTO v_attempt
  FROM public.run_attempts AS attempt
  WHERE attempt.workspace_id = v_workspace_id
    AND attempt.run_id = v_run.id
    AND attempt.id = (p_fact ->> 'attempt_id')::uuid
  FOR UPDATE;
  v_now := clock_timestamp();
  v_expiry := v_now + make_interval(secs => v_duration);
  IF NOT FOUND OR v_attempt.status <> 'PENDING'
     OR v_attempt.lease_owner IS NOT NULL
     OR v_attempt.lease_token IS NOT NULL
     OR v_attempt.lease_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'Attempt is not claimable'
      USING ERRCODE = '55000';
  END IF;
  IF v_attempt.recovery_ticket_id IS NULL THEN
    IF p_fact ->> 'recovery_ticket_id' IS NOT NULL THEN
      RAISE EXCEPTION 'initial Attempt claim cannot present a recovery ticket'
        USING ERRCODE = '42501';
    END IF;
    v_generation := v_attempt.lease_generation + 1;
  ELSE
    SELECT ticket.* INTO v_ticket
    FROM public.run_recovery_tickets AS ticket
    WHERE ticket.workspace_id = v_workspace_id
      AND ticket.id = v_attempt.recovery_ticket_id
      AND ticket.id = (p_fact ->> 'recovery_ticket_id')::uuid
      AND ticket.run_id = v_run.id
      AND ticket.resource_kind = 'ATTEMPT'
      AND ticket.resource_id = v_attempt.id
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM public.run_recovery_ticket_dispositions AS disposition
      WHERE disposition.workspace_id = v_workspace_id
        AND disposition.recovery_ticket_id = v_ticket.id
    ) THEN
      RAISE EXCEPTION 'Attempt recovery ticket is missing or already consumed'
        USING ERRCODE = '42501';
    END IF;
    v_generation := v_ticket.fenced_generation + 1;
    IF v_generation > 9007199254740991 THEN
      RAISE EXCEPTION 'Attempt lease fencing token exceeds the protocol-v5 limit'
        USING ERRCODE = '22003';
    END IF;
    v_disposition_id := gen_random_uuid();
    INSERT INTO public.run_recovery_ticket_dispositions (
      workspace_id, id, recovery_ticket_id, recovery_ticket_sha256,
      run_id, resource_kind, resource_id, ticket_fencing_token,
      disposition_kind, claim_fencing_token, claim_session_user,
      claim_lease_owner, claim_lease_token, claim_lease_expires_at, disposed_at
    ) VALUES (
      v_workspace_id, v_disposition_id, v_ticket.id, v_ticket.ticket_sha256,
      v_run.id, 'ATTEMPT', v_attempt.id, v_ticket.fenced_generation,
      'CLAIMED', v_generation, session_user, session_user, v_token, v_expiry, v_now
    );
    v_disposition := jsonb_build_object(
      'schema_version', 'run-recovery-ticket-disposition/1',
      'disposition_id', v_disposition_id,
      'recovery_ticket_id', v_ticket.id,
      'recovery_ticket_sha256', v_ticket.ticket_sha256,
      'workspace_id', v_workspace_id,
      'run_id', v_run.id,
      'resource_kind', 'ATTEMPT',
      'resource_id', v_attempt.id,
      'ticket_fencing_token', v_ticket.fenced_generation::text,
      'disposition_kind', 'CLAIMED',
      'claim_fencing_token', v_generation::text,
      'claim_session_user', session_user,
      'claim_lease_owner', session_user,
      'claim_lease_token', v_token,
      'claim_lease_expires_at', v_expiry,
      'disposed_at', v_now
    );
  END IF;
  IF v_generation NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'Attempt lease fencing token exceeds the protocol-v5 limit'
      USING ERRCODE = '22003';
  END IF;
  UPDATE public.run_attempts
  SET status = 'RUNNING',
      recovery_ticket_id = NULL,
      runtime_protocol_version = 5,
      lease_generation = v_generation,
      lease_owner = session_user,
      lease_token = v_token,
      lease_fencing_token = v_generation,
      lease_expires_at = v_expiry,
      started_at = COALESCE(started_at, v_now),
      updated_at = v_now
  WHERE workspace_id = v_workspace_id AND id = v_attempt.id;
  INSERT INTO public.phase_operation_audit (
    workspace_id, id, phase, operation, resource_kind, resource_id,
    operation_sha256, actor_session_user, occurred_at
  ) VALUES (
    v_workspace_id, gen_random_uuid(), 'execution', 'CLAIM_ATTEMPT', 'ATTEMPT', v_attempt.id,
    app.g007_sha256('better-agent/phase-operation/1',
      format('%s:%s:%s', v_run.id, v_attempt.id, v_generation)),
    session_user, v_now
  );
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'workspace_id', v_workspace_id,
    'run_id', v_run.id,
    'attempt_id', v_attempt.id,
    'lease_owner', session_user,
    'lease_token', v_token,
    'lease_fencing_token', v_generation::text,
    'lease_expires_at', v_expiry,
    'recovery_ticket_disposition', v_disposition
  ));
END;
$function$;
ALTER FUNCTION app.claim_run_attempt(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.claim_run_attempt(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_run_attempt(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.renew_run_attempt_lease(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_duration integer := (p_fact ->> 'duration_seconds')::integer;
  v_now timestamptz;
  v_expiry timestamptz;
BEGIN
  IF v_duration NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Attempt lease duration must be between 1 and 300 seconds'
      USING ERRCODE = '22023';
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_now := clock_timestamp();
  v_expiry := v_now + make_interval(secs => v_duration);
  IF v_expiry <= (v_authority ->> 'lease_expires_at')::timestamptz THEN
    RAISE EXCEPTION 'Attempt lease renewal must strictly extend expiry'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.run_attempts
  SET lease_expires_at = v_expiry,
      updated_at = v_now
  WHERE workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND id = (v_authority ->> 'attempt_id')::uuid;
  RETURN v_authority || jsonb_build_object('lease_expires_at', v_expiry);
END;
$function$;
ALTER FUNCTION app.renew_run_attempt_lease(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.renew_run_attempt_lease(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.renew_run_attempt_lease(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.relinquish_run_attempt_lease(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb := app.require_execution_owner_lease(p_fact);
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND envelope.run_id = (v_authority ->> 'run_id')::uuid
      AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
  ) OR EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    LEFT JOIN public.run_side_effect_receipts AS receipt
      ON receipt.workspace_id = envelope.workspace_id
     AND receipt.envelope_id = envelope.id
    WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND envelope.run_id = (v_authority ->> 'run_id')::uuid
      AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
      AND (
        envelope.effect_class = 'unsafe'
        OR (envelope.effect_class = 'requires_key' AND envelope.operation_key IS NULL)
        OR receipt.disposition IS DISTINCT FROM 'CONFIRMED'
      )
  ) THEN
    RAISE EXCEPTION 'Attempt effect closure is not safely relinquishable'
      USING ERRCODE = '55000';
  END IF;
  UPDATE public.run_attempts
  SET status = 'RELINQUISHED',
      lease_owner = NULL,
      lease_token = NULL,
      lease_fencing_token = NULL,
      lease_expires_at = NULL,
      finished_at = v_now,
      updated_at = v_now
  WHERE workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND id = (v_authority ->> 'attempt_id')::uuid;
  RETURN jsonb_build_object(
    'run_id', v_authority ->> 'run_id',
    'attempt_id', v_authority ->> 'attempt_id',
    'status', 'RELINQUISHED',
    'lease_generation', v_authority ->> 'lease_fencing_token'
  );
END;
$function$;
ALTER FUNCTION app.relinquish_run_attempt_lease(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.relinquish_run_attempt_lease(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.relinquish_run_attempt_lease(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_execution_progress(
  p_fact jsonb,
  p_event_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_workspace_id uuid;
  v_run_id uuid;
  v_attempt_id uuid;
  v_sequence bigint;
  v_now timestamptz := clock_timestamp();
  v_step_id uuid;
  v_attempt_status text;
BEGIN
  IF p_event_type NOT IN (
    'RUN_STARTED', 'RUN_RETRY_WAIT', 'RUN_RECOVERING',
    'ATTEMPT_FINISHED', 'STEP_STARTED', 'STEP_FINISHED'
  ) THEN
    RAISE EXCEPTION 'execution progress event type is not in the fixed allowlist'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR p_fact ? 'workspace_id'
     OR (
       p_event_type IN ('RUN_STARTED', 'RUN_RETRY_WAIT', 'RUN_RECOVERING')
       AND (p_fact - ARRAY[
         'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token'
       ]) <> '{}'::jsonb
     )
     OR (
       p_event_type = 'ATTEMPT_FINISHED'
       AND (p_fact - ARRAY[
         'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
         'attempt_status'
       ]) <> '{}'::jsonb
     )
     OR (
       p_event_type = 'STEP_STARTED'
       AND (p_fact - ARRAY[
         'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
         'step_id', 'step_key', 'input_hash'
       ]) <> '{}'::jsonb
     )
     OR (
       p_event_type = 'STEP_FINISHED'
       AND (p_fact - ARRAY[
         'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
         'step_id', 'step_status', 'output_hash'
       ]) <> '{}'::jsonb
     )
     OR (
       p_event_type = 'ATTEMPT_FINISHED'
       AND jsonb_typeof(p_fact -> 'attempt_status') IS DISTINCT FROM 'string'
     )
     OR (
       p_event_type = 'STEP_STARTED'
       AND (
         jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
         OR jsonb_typeof(p_fact -> 'step_key') IS DISTINCT FROM 'string'
         OR jsonb_typeof(p_fact -> 'input_hash') IS DISTINCT FROM 'string'
         OR COALESCE(p_fact ->> 'step_id', '')
              !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR COALESCE(length(btrim(p_fact ->> 'step_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0) = 0
         OR COALESCE(p_fact ->> 'input_hash', '') !~ '^sha256:[0-9a-f]{64}$'
       )
     )
     OR (
       p_event_type = 'STEP_FINISHED'
       AND (
         jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
         OR jsonb_typeof(p_fact -> 'step_status') IS DISTINCT FROM 'string'
         OR (
           p_fact ? 'output_hash'
           AND (
             jsonb_typeof(p_fact -> 'output_hash') IS DISTINCT FROM 'string'
             OR COALESCE(p_fact ->> 'output_hash', '') !~ '^sha256:[0-9a-f]{64}$'
           )
         )
       )
     ) THEN
    RAISE EXCEPTION 'execution progress fact shape is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_authority := app.require_execution_owner_lease(
    CASE WHEN p_event_type = 'STEP_STARTED' THEN p_fact - 'step_id' ELSE p_fact END
  );
  v_workspace_id := (v_authority ->> 'workspace_id')::uuid;
  v_run_id := (v_authority ->> 'run_id')::uuid;
  v_attempt_id := (v_authority ->> 'attempt_id')::uuid;
  SELECT last_event_sequence + 1
  INTO v_sequence
  FROM public.runs
  WHERE workspace_id = v_workspace_id AND id = v_run_id
  FOR UPDATE;

  IF p_event_type = 'RUN_STARTED' THEN
    UPDATE public.runs
    SET status = 'RUNNING', execution_status = 'RUNNING', last_event_sequence = v_sequence
    WHERE workspace_id = v_workspace_id AND id = v_run_id;
  ELSIF p_event_type = 'RUN_RETRY_WAIT' THEN
    UPDATE public.runs
    SET execution_status = 'RETRY_WAIT', last_event_sequence = v_sequence
    WHERE workspace_id = v_workspace_id AND id = v_run_id;
  ELSIF p_event_type = 'RUN_RECOVERING' THEN
    UPDATE public.runs
    SET execution_status = 'RECOVERING', last_event_sequence = v_sequence
    WHERE workspace_id = v_workspace_id AND id = v_run_id;
  ELSIF p_event_type = 'ATTEMPT_FINISHED' THEN
    v_attempt_status := p_fact ->> 'attempt_status';
    IF v_attempt_status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'Attempt finish status is invalid'
        USING ERRCODE = '22023';
    END IF;
    -- Attempt completion is the last lease-bearing writer. Lock the complete
    -- effect set in Envelope -> Receipt order before clearing that authority.
    PERFORM 1
    FROM public.run_retry_effect_envelopes AS envelope
    WHERE envelope.workspace_id = v_workspace_id
      AND envelope.run_id = v_run_id
      AND envelope.attempt_id = v_attempt_id
    ORDER BY envelope.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Attempt completion requires a CLOSED effect envelope set'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
    FROM public.run_side_effect_receipts AS receipt
    JOIN public.run_retry_effect_envelopes AS envelope
      ON envelope.workspace_id = receipt.workspace_id
     AND envelope.id = receipt.envelope_id
    WHERE envelope.workspace_id = v_workspace_id
      AND envelope.run_id = v_run_id
      AND envelope.attempt_id = v_attempt_id
    ORDER BY envelope.id
    FOR UPDATE OF receipt;
    IF EXISTS (
      SELECT 1
      FROM public.run_retry_effect_envelopes AS envelope
      LEFT JOIN public.run_side_effect_receipts AS receipt
        ON receipt.workspace_id = envelope.workspace_id
       AND receipt.envelope_id = envelope.id
      WHERE envelope.workspace_id = v_workspace_id
        AND envelope.run_id = v_run_id
        AND envelope.attempt_id = v_attempt_id
        AND (
          envelope.effect_class = 'unsafe'
          OR (
            envelope.effect_class = 'requires_key'
            AND envelope.operation_key IS NULL
          )
          OR receipt.disposition IS DISTINCT FROM 'CONFIRMED'
        )
    ) THEN
      RAISE EXCEPTION 'Attempt completion requires every effect to be safely CONFIRMED'
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.run_attempts
    SET status = v_attempt_status,
        lease_owner = NULL,
        lease_token = NULL,
        lease_fencing_token = NULL,
        lease_expires_at = NULL,
        finished_at = v_now,
        updated_at = v_now
    WHERE workspace_id = v_workspace_id AND id = v_attempt_id;
    UPDATE public.runs
    SET last_event_sequence = v_sequence
    WHERE workspace_id = v_workspace_id AND id = v_run_id;
  ELSIF p_event_type = 'STEP_STARTED' THEN
    v_step_id := (p_fact ->> 'step_id')::uuid;
    INSERT INTO public.run_steps (
      workspace_id, id, run_id, attempt_id, step_key, status,
      input_hash, created_at, updated_at
    ) VALUES (
      v_workspace_id, v_step_id, v_run_id, v_attempt_id,
      p_fact ->> 'step_key', 'RUNNING', p_fact ->> 'input_hash', v_now, v_now
    );
    UPDATE public.runs
    SET last_event_sequence = v_sequence
    WHERE workspace_id = v_workspace_id AND id = v_run_id;
  ELSE
    v_step_id := (p_fact ->> 'step_id')::uuid;
    IF p_fact ->> 'step_status' NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED') THEN
      RAISE EXCEPTION 'Step finish status is invalid'
        USING ERRCODE = '22023';
    END IF;
    UPDATE public.run_steps
    SET status = p_fact ->> 'step_status',
        output_hash = p_fact ->> 'output_hash',
        updated_at = v_now
    WHERE workspace_id = v_workspace_id
      AND run_id = v_run_id
      AND attempt_id = v_attempt_id
      AND id = v_step_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Step is unavailable for leased completion'
        USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.runs
    SET last_event_sequence = v_sequence
    WHERE workspace_id = v_workspace_id AND id = v_run_id;
  END IF;

  INSERT INTO public.run_events (
    workspace_id, id, run_id, sequence, event_type, dedupe_key,
    payload_redacted, occurred_at
  ) VALUES (
    v_workspace_id, gen_random_uuid(), v_run_id, v_sequence, p_event_type,
    format('v5:%s:%s:%s', v_attempt_id, p_event_type, COALESCE(v_step_id::text, '-')),
    jsonb_build_object(
      'attempt_id', v_attempt_id,
      'step_id', v_step_id,
      'lease_fencing_token', v_authority ->> 'lease_fencing_token'
    ),
    v_now
  );
  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'attempt_id', v_attempt_id,
    'step_id', v_step_id,
    'event_type', p_event_type,
    'event_sequence', v_sequence
  );
END;
$function$;
ALTER FUNCTION app.record_execution_progress(jsonb, text) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_execution_progress(jsonb, text) FROM PUBLIC;

CREATE FUNCTION app.record_attempt_started(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RETURN app.record_execution_progress(p_fact, 'RUN_STARTED');
END;
$function$;
ALTER FUNCTION app.record_attempt_started(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_attempt_started(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_attempt_started(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_attempt_retry_wait(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RETURN app.record_execution_progress(p_fact, 'RUN_RETRY_WAIT');
END;
$function$;
ALTER FUNCTION app.record_attempt_retry_wait(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_attempt_retry_wait(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_attempt_retry_wait(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_attempt_recovering(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RETURN app.record_execution_progress(p_fact, 'RUN_RECOVERING');
END;
$function$;
ALTER FUNCTION app.record_attempt_recovering(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_attempt_recovering(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_attempt_recovering(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_attempt_finished(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RETURN app.record_execution_progress(p_fact, 'ATTEMPT_FINISHED');
END;
$function$;
ALTER FUNCTION app.record_attempt_finished(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_attempt_finished(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_attempt_finished(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_step_started(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RETURN app.record_execution_progress(p_fact, 'STEP_STARTED');
END;
$function$;
ALTER FUNCTION app.record_step_started(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_step_started(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_step_started(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_step_finished(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RETURN app.record_execution_progress(p_fact, 'STEP_FINISHED');
END;
$function$;
ALTER FUNCTION app.record_step_finished(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_step_finished(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_step_finished(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_execution_checkpoint(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_checkpoint_id uuid := gen_random_uuid();
  v_checkpoint_sequence bigint;
  v_authorized_at timestamptz;
  v_contract jsonb;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact - ARRAY[
       'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
       'step_id', 'checkpoint_ref', 'checkpoint_sha256', 'payload_redacted'
     ]) <> '{}'::jsonb
     OR jsonb_typeof(p_fact -> 'run_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'attempt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_fencing_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'checkpoint_ref') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'checkpoint_sha256') IS DISTINCT FROM 'string'
     OR (
       p_fact ? 'step_id'
       AND jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
     )
     OR COALESCE(p_fact ->> 'run_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token', '') !~ '^[1-9][0-9]*$'
     OR (
       p_fact ? 'step_id'
       AND COALESCE(p_fact ->> 'step_id', '')
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     )
     OR COALESCE(length(p_fact ->> 'checkpoint_ref'), 0) NOT BETWEEN 1 AND 2048
     OR COALESCE(length(btrim(p_fact ->> 'checkpoint_ref', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0)
          NOT BETWEEN 1 AND 2048
     OR position('?' IN COALESCE(p_fact ->> 'checkpoint_ref', '')) <> 0
     OR position('#' IN COALESCE(p_fact ->> 'checkpoint_ref', '')) <> 0
     OR COALESCE(p_fact ->> 'checkpoint_sha256', '')
          !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(COALESCE(p_fact -> 'payload_redacted', '{}'::jsonb))
          IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'execution checkpoint fact shape is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_authorized_at := (v_authority ->> 'validated_at')::timestamptz;
  SELECT COALESCE(max(checkpoint.checkpoint_sequence), 0) + 1
  INTO v_checkpoint_sequence
  FROM public.run_checkpoints AS checkpoint
  WHERE checkpoint.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND checkpoint.run_id = (v_authority ->> 'run_id')::uuid
    AND checkpoint.runtime_protocol_version = 5;
  IF v_checkpoint_sequence > 9007199254740991 THEN
    RAISE EXCEPTION 'execution checkpoint sequence is exhausted'
      USING ERRCODE = '22003';
  END IF;
  INSERT INTO public.run_checkpoints (
    workspace_id, id, run_id, step_id, checkpoint_hash, payload_ref,
    payload_redacted, created_at, producer_attempt_id, producer_lease_token,
    producer_lease_fencing_token, producer_session_user,
    producer_lease_expires_at, authorized_at, checkpoint_sequence,
    runtime_protocol_version
  ) VALUES (
    (v_authority ->> 'workspace_id')::uuid,
    v_checkpoint_id,
    (v_authority ->> 'run_id')::uuid,
    (p_fact ->> 'step_id')::uuid,
    p_fact ->> 'checkpoint_sha256',
    p_fact ->> 'checkpoint_ref',
    COALESCE(p_fact -> 'payload_redacted', '{}'::jsonb),
    v_authorized_at,
    (v_authority ->> 'attempt_id')::uuid,
    (v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    v_authority ->> 'lease_owner',
    (v_authority ->> 'lease_expires_at')::timestamptz,
    v_authorized_at,
    v_checkpoint_sequence,
    5
  );
  v_contract := jsonb_strip_nulls(jsonb_build_object(
    'schema_version', 'run-execution-checkpoint/1',
    'checkpoint_id', v_checkpoint_id,
    'workspace_id', v_authority ->> 'workspace_id',
    'run_id', v_authority ->> 'run_id',
    'attempt_id', v_authority ->> 'attempt_id',
    'step_id', p_fact ->> 'step_id',
    'checkpoint_sequence', v_checkpoint_sequence::text,
    'checkpoint_ref', p_fact ->> 'checkpoint_ref',
    'checkpoint_sha256', p_fact ->> 'checkpoint_sha256',
    'producer_session_user', v_authority ->> 'lease_owner',
    'lease_owner', v_authority ->> 'lease_owner',
    'lease_token', v_authority ->> 'lease_token',
    'lease_fencing_token', v_authority ->> 'lease_fencing_token',
    'lease_expires_at', app.g007_contract_instant(
      (v_authority ->> 'lease_expires_at')::timestamptz
    ),
    'authorized_at', app.g007_contract_instant(v_authorized_at)
  ));
  RETURN v_contract;
END;
$function$;
ALTER FUNCTION app.record_execution_checkpoint(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_execution_checkpoint(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_execution_checkpoint(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_execution_effect_envelope(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_authority jsonb;
  v_envelope public.run_retry_effect_envelopes%ROWTYPE;
  v_envelope_id uuid := gen_random_uuid();
  v_now timestamptz;
  v_accepted_plan_hash text;
  v_effect_class text := p_fact ->> 'effect_class';
  v_recovery_decision text;
  v_contract jsonb;
  v_envelope_hash text;
  v_lookup_pass integer;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact - ARRAY[
       'run_id', 'attempt_id', 'step_id', 'lease_token',
       'lease_fencing_token', 'operation_intent_sha256',
       'effect_payload_sha256', 'effect_class', 'operation_key'
     ]) <> '{}'::jsonb
     OR p_fact ->> 'run_id' IS NULL
     OR p_fact ->> 'attempt_id' IS NULL
     OR p_fact ->> 'step_id' IS NULL
     OR p_fact ->> 'lease_token' IS NULL
     OR jsonb_typeof(p_fact -> 'run_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'attempt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_fencing_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'operation_intent_sha256') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'effect_payload_sha256') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'effect_class') IS DISTINCT FROM 'string'
     OR (
       p_fact ? 'operation_key'
       AND jsonb_typeof(p_fact -> 'operation_key') IS DISTINCT FROM 'string'
     )
     OR COALESCE(p_fact ->> 'lease_fencing_token', '') !~ '^[1-9][0-9]*$'
     OR (p_fact ->> 'lease_fencing_token')::numeric > 9007199254740991
     OR COALESCE(p_fact ->> 'operation_intent_sha256', '')
          !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_fact ->> 'effect_payload_sha256', '')
          !~ '^sha256:[0-9a-f]{64}$'
     OR v_effect_class IS NULL
     OR v_effect_class NOT IN ('SAFE', 'REQUIRES_KEY', 'UNSAFE')
     OR (
       v_effect_class = 'REQUIRES_KEY'
       AND COALESCE(length(btrim(p_fact ->> 'operation_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0)
             NOT BETWEEN 1 AND 300
     )
     OR (
       v_effect_class = 'REQUIRES_KEY'
       AND COALESCE(length(p_fact ->> 'operation_key'), 0) NOT BETWEEN 1 AND 300
     )
     OR (v_effect_class <> 'REQUIRES_KEY' AND p_fact ? 'operation_key') THEN
    RAISE EXCEPTION 'execution effect envelope is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_workspace_id := auth.require_internal_service_phase('execution');
  v_recovery_decision := CASE v_effect_class
    WHEN 'SAFE' THEN 'REPLAY_SAFE'
    WHEN 'REQUIRES_KEY' THEN 'REPLAY_WITH_KEY'
    WHEN 'UNSAFE' THEN 'HOLD'
  END;

  -- Pass one accepts a response-loss retry after the original lease expired.
  -- Pass two closes the concurrent-miss window after the current lease is locked.
  FOR v_lookup_pass IN 1..2 LOOP
    IF v_lookup_pass = 1 THEN
      SELECT envelope.*
      INTO v_envelope
      FROM public.run_retry_effect_envelopes AS envelope
      WHERE envelope.workspace_id = v_workspace_id
        AND envelope.run_id = (p_fact ->> 'run_id')::uuid
        AND envelope.attempt_id = (p_fact ->> 'attempt_id')::uuid
        AND envelope.step_id = (p_fact ->> 'step_id')::uuid
        AND envelope.operation_intent_sha256 = p_fact ->> 'operation_intent_sha256';
    ELSE
      SELECT envelope.*
      INTO v_envelope
      FROM public.run_retry_effect_envelopes AS envelope
      WHERE envelope.workspace_id = v_workspace_id
        AND envelope.run_id = (p_fact ->> 'run_id')::uuid
        AND envelope.attempt_id = (p_fact ->> 'attempt_id')::uuid
        AND envelope.step_id = (p_fact ->> 'step_id')::uuid
        AND envelope.operation_intent_sha256 = p_fact ->> 'operation_intent_sha256'
      FOR UPDATE;
    END IF;
    IF FOUND THEN
      v_contract := jsonb_strip_nulls(jsonb_build_object(
        'schema_version', 'run-retry-effect-envelope/1',
        'envelope_id', v_envelope.id,
        'workspace_id', v_envelope.workspace_id,
        'run_id', v_envelope.run_id,
        'attempt_id', v_envelope.attempt_id,
        'step_id', v_envelope.step_id,
        'accepted_plan_hash', v_envelope.accepted_plan_hash,
        'operation_intent_sha256', v_envelope.operation_intent_sha256,
        'effect_payload_sha256', v_envelope.effect_payload_sha256,
        'effect_class', upper(v_envelope.effect_class),
        'recovery_decision', CASE v_envelope.effect_class
          WHEN 'safe' THEN 'REPLAY_SAFE'
          WHEN 'requires_key' THEN 'REPLAY_WITH_KEY'
          WHEN 'unsafe' THEN 'HOLD'
        END,
        'operation_key', v_envelope.operation_key,
        'created_at', app.g007_contract_instant(v_envelope.created_at)
      ));
      v_envelope_hash := app.g007_sha256(
        'better-agent/run-retry-effect-envelope/1',
        app.g007_canonical_json(v_contract)
      );
      IF v_envelope.effect_payload_sha256 IS DISTINCT FROM
           p_fact ->> 'effect_payload_sha256'
         OR v_envelope.effect_class IS DISTINCT FROM lower(v_effect_class)
         OR v_envelope.operation_key IS DISTINCT FROM p_fact ->> 'operation_key'
         OR v_envelope.producer_session_user IS DISTINCT FROM session_user
         OR v_envelope.producer_lease_token IS DISTINCT FROM
              (p_fact ->> 'lease_token')::uuid
         OR v_envelope.producer_lease_fencing_token IS DISTINCT FROM
              (p_fact ->> 'lease_fencing_token')::bigint
         OR v_envelope.envelope_sha256 IS DISTINCT FROM v_envelope_hash THEN
        RAISE EXCEPTION 'execution effect envelope identity is already committed differently'
          USING ERRCODE = '23505';
      END IF;
      RETURN v_contract || jsonb_build_object(
        'envelope_sha256', v_envelope_hash,
        'replayed', true
      );
    END IF;

    IF v_lookup_pass = 1 THEN
      v_authority := app.require_execution_owner_lease(p_fact);
      v_now := clock_timestamp();
      IF v_now >= (v_authority ->> 'lease_expires_at')::timestamptz THEN
        RAISE EXCEPTION 'execution effect envelope cannot outlive its producer lease'
          USING ERRCODE = '42501';
      END IF;
      SELECT run_row.accepted_plan_hash
      INTO v_accepted_plan_hash
      FROM public.runs AS run_row
      WHERE run_row.workspace_id = v_workspace_id
        AND run_row.id = (p_fact ->> 'run_id')::uuid;
      IF NOT FOUND OR v_accepted_plan_hash IS NULL THEN
        RAISE EXCEPTION 'execution effect envelope requires an accepted Plan'
          USING ERRCODE = '23503';
      END IF;
    END IF;
  END LOOP;

  v_contract := jsonb_strip_nulls(jsonb_build_object(
    'schema_version', 'run-retry-effect-envelope/1',
    'envelope_id', v_envelope_id,
    'workspace_id', v_workspace_id,
    'run_id', (v_authority ->> 'run_id')::uuid,
    'attempt_id', (v_authority ->> 'attempt_id')::uuid,
    'step_id', (p_fact ->> 'step_id')::uuid,
    'accepted_plan_hash', v_accepted_plan_hash,
    'operation_intent_sha256', p_fact ->> 'operation_intent_sha256',
    'effect_payload_sha256', p_fact ->> 'effect_payload_sha256',
    'effect_class', v_effect_class,
    'recovery_decision', v_recovery_decision,
    'operation_key', p_fact ->> 'operation_key',
    'created_at', app.g007_contract_instant(v_now)
  ));
  v_envelope_hash := app.g007_sha256(
    'better-agent/run-retry-effect-envelope/1',
    app.g007_canonical_json(v_contract)
  );
  INSERT INTO public.run_retry_effect_envelopes (
    workspace_id, id, run_id, attempt_id, step_id, accepted_plan_hash,
    operation_intent_sha256, effect_payload_sha256, effect_class,
    operation_key, envelope_sha256, producer_session_user,
    producer_lease_token, producer_lease_fencing_token,
    producer_lease_expires_at, created_at
  ) VALUES (
    v_workspace_id, v_envelope_id, (p_fact ->> 'run_id')::uuid,
    (p_fact ->> 'attempt_id')::uuid, (p_fact ->> 'step_id')::uuid,
    v_accepted_plan_hash, p_fact ->> 'operation_intent_sha256',
    p_fact ->> 'effect_payload_sha256', lower(v_effect_class),
    p_fact ->> 'operation_key', v_envelope_hash, session_user,
    (p_fact ->> 'lease_token')::uuid,
    (p_fact ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz, v_now
  );
  RETURN v_contract || jsonb_build_object(
    'envelope_sha256', v_envelope_hash,
    'replayed', false
  );
END;
$function$;
ALTER FUNCTION app.record_execution_effect_envelope(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_execution_effect_envelope(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_execution_effect_envelope(jsonb)
TO ba_execution_executor;

CREATE FUNCTION app.record_execution_effect_receipt(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_authority jsonb;
  v_envelope public.run_retry_effect_envelopes%ROWTYPE;
  v_existing_receipt public.run_side_effect_receipts%ROWTYPE;
  v_ticket public.run_recovery_tickets%ROWTYPE;
  v_decision jsonb;
  v_receipt_id uuid := gen_random_uuid();
  v_now timestamptz;
  v_outcome text := p_fact ->> 'outcome';
  v_envelope_contract jsonb;
  v_contract jsonb;
  v_envelope_hash text;
  v_receipt_hash text;
  v_is_initial_close boolean;
  v_lookup_pass integer;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact - ARRAY[
       'run_id', 'attempt_id', 'step_id', 'lease_token',
       'lease_fencing_token', 'retry_effect_envelope_id',
       'retry_effect_envelope_sha256', 'outcome', 'result_payload_sha256',
       'external_receipt_ref', 'external_receipt_sha256',
       'unknown_reason_code'
     ]) <> '{}'::jsonb
     OR p_fact ->> 'run_id' IS NULL
     OR p_fact ->> 'attempt_id' IS NULL
     OR p_fact ->> 'step_id' IS NULL
     OR p_fact ->> 'lease_token' IS NULL
     OR jsonb_typeof(p_fact -> 'run_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'attempt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_fencing_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'retry_effect_envelope_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'retry_effect_envelope_sha256') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'outcome') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'result_payload_sha256') IS DISTINCT FROM 'string'
     OR (
       p_fact ? 'external_receipt_ref'
       AND jsonb_typeof(p_fact -> 'external_receipt_ref') IS DISTINCT FROM 'string'
     )
     OR (
       p_fact ? 'external_receipt_sha256'
       AND jsonb_typeof(p_fact -> 'external_receipt_sha256') IS DISTINCT FROM 'string'
     )
     OR (
       p_fact ? 'unknown_reason_code'
       AND jsonb_typeof(p_fact -> 'unknown_reason_code') IS DISTINCT FROM 'string'
     )
     OR COALESCE(p_fact ->> 'lease_fencing_token', '') !~ '^[1-9][0-9]*$'
     OR (p_fact ->> 'lease_fencing_token')::numeric > 9007199254740991
     OR p_fact ->> 'retry_effect_envelope_id' IS NULL
     OR COALESCE(p_fact ->> 'retry_effect_envelope_sha256', '')
          !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_fact ->> 'result_payload_sha256', '')
          !~ '^sha256:[0-9a-f]{64}$'
     OR v_outcome IS NULL
     OR v_outcome NOT IN ('CONFIRMED', 'UNKNOWN')
     OR (
       v_outcome = 'CONFIRMED'
       AND (
         COALESCE(length(btrim(p_fact ->> 'external_receipt_ref', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0)
           NOT BETWEEN 1 AND 2048
         OR position('?' IN COALESCE(p_fact ->> 'external_receipt_ref', '')) <> 0
         OR position('#' IN COALESCE(p_fact ->> 'external_receipt_ref', '')) <> 0
         OR COALESCE(p_fact ->> 'external_receipt_sha256', '')
              !~ '^sha256:[0-9a-f]{64}$'
         OR p_fact ? 'unknown_reason_code'
       )
     )
     OR (
       v_outcome = 'UNKNOWN'
       AND (
         p_fact ? 'external_receipt_ref'
         OR p_fact ? 'external_receipt_sha256'
         OR COALESCE(length(btrim(p_fact ->> 'unknown_reason_code', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0)
              NOT BETWEEN 1 AND 200
         OR COALESCE(length(p_fact ->> 'unknown_reason_code'), 0)
              NOT BETWEEN 1 AND 200
       )
     ) THEN
    RAISE EXCEPTION 'execution effect receipt is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_workspace_id := auth.require_internal_service_phase('execution');
  -- Pass one is an immutable plain read so a committed response-loss replay
  -- survives expiry. A miss then acquires the global Run -> Attempt lock order;
  -- pass two locks Envelope -> Receipt and closes the concurrent-insert window.
  FOR v_lookup_pass IN 1..2 LOOP
    IF v_lookup_pass = 1 THEN
      SELECT envelope.*
      INTO v_envelope
      FROM public.run_retry_effect_envelopes AS envelope
      WHERE envelope.workspace_id = v_workspace_id
        AND envelope.run_id = (p_fact ->> 'run_id')::uuid
        AND envelope.attempt_id = (p_fact ->> 'attempt_id')::uuid
        AND envelope.step_id = (p_fact ->> 'step_id')::uuid
        AND envelope.id = (p_fact ->> 'retry_effect_envelope_id')::uuid
        AND envelope.envelope_sha256 = p_fact ->> 'retry_effect_envelope_sha256';
    ELSE
      SELECT envelope.*
      INTO v_envelope
      FROM public.run_retry_effect_envelopes AS envelope
      WHERE envelope.workspace_id = v_workspace_id
        AND envelope.run_id = (p_fact ->> 'run_id')::uuid
        AND envelope.attempt_id = (p_fact ->> 'attempt_id')::uuid
        AND envelope.step_id = (p_fact ->> 'step_id')::uuid
        AND envelope.id = (p_fact ->> 'retry_effect_envelope_id')::uuid
        AND envelope.envelope_sha256 = p_fact ->> 'retry_effect_envelope_sha256'
      FOR UPDATE;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'execution effect envelope is missing or mismatched'
        USING ERRCODE = '42501';
    END IF;

    v_envelope_contract := jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 'run-retry-effect-envelope/1',
      'envelope_id', v_envelope.id,
      'workspace_id', v_envelope.workspace_id,
      'run_id', v_envelope.run_id,
      'attempt_id', v_envelope.attempt_id,
      'step_id', v_envelope.step_id,
      'accepted_plan_hash', v_envelope.accepted_plan_hash,
      'operation_intent_sha256', v_envelope.operation_intent_sha256,
      'effect_payload_sha256', v_envelope.effect_payload_sha256,
      'effect_class', upper(v_envelope.effect_class),
      'recovery_decision', CASE v_envelope.effect_class
        WHEN 'safe' THEN 'REPLAY_SAFE'
        WHEN 'requires_key' THEN 'REPLAY_WITH_KEY'
        WHEN 'unsafe' THEN 'HOLD'
      END,
      'operation_key', v_envelope.operation_key,
      'created_at', app.g007_contract_instant(v_envelope.created_at)
    ));
    v_envelope_hash := app.g007_sha256(
      'better-agent/run-retry-effect-envelope/1',
      app.g007_canonical_json(v_envelope_contract)
    );
    IF v_envelope.envelope_sha256 IS DISTINCT FROM v_envelope_hash THEN
      RAISE EXCEPTION 'execution effect envelope hash no longer matches its durable fields'
        USING ERRCODE = '42501';
    END IF;

    IF v_lookup_pass = 1 THEN
      SELECT receipt.*
      INTO v_existing_receipt
      FROM public.run_side_effect_receipts AS receipt
      WHERE receipt.workspace_id = v_workspace_id
        AND receipt.envelope_id = v_envelope.id;
    ELSE
      SELECT receipt.*
      INTO v_existing_receipt
      FROM public.run_side_effect_receipts AS receipt
      WHERE receipt.workspace_id = v_workspace_id
        AND receipt.envelope_id = v_envelope.id
      FOR UPDATE;
    END IF;
    IF FOUND THEN
      v_contract := jsonb_strip_nulls(jsonb_build_object(
        'schema_version', 'run-side-effect-receipt/1',
        'effect_receipt_id', v_existing_receipt.id,
        'workspace_id', v_existing_receipt.workspace_id,
        'run_id', v_existing_receipt.run_id,
        'attempt_id', v_existing_receipt.attempt_id,
        'step_id', v_existing_receipt.step_id,
        'retry_effect_envelope_id', v_existing_receipt.envelope_id,
        'retry_effect_envelope_sha256', v_envelope.envelope_sha256,
        'effect_class', upper(v_envelope.effect_class),
        'operation_key', v_envelope.operation_key,
        'outcome', v_existing_receipt.disposition,
        'external_receipt_ref', v_existing_receipt.result_ref,
        'external_receipt_sha256', v_existing_receipt.result_sha256,
        'unknown_reason_code', v_existing_receipt.unknown_reason_code,
        'result_payload_sha256', v_existing_receipt.result_payload_sha256,
        'producer_session_user', v_existing_receipt.producer_session_user,
        'lease_owner', v_existing_receipt.producer_session_user,
        'lease_token', v_existing_receipt.producer_lease_token,
        'lease_fencing_token', v_existing_receipt.producer_lease_fencing_token::text,
        'lease_expires_at', app.g007_contract_instant(
          v_existing_receipt.producer_lease_expires_at
        ),
        'authorized_at', app.g007_contract_instant(v_existing_receipt.created_at)
      ));
      v_receipt_hash := app.g007_sha256(
        'better-agent/run-side-effect-receipt/1',
        app.g007_canonical_json(v_contract)
      );
      IF v_existing_receipt.disposition IS DISTINCT FROM v_outcome
         OR v_existing_receipt.result_ref IS DISTINCT FROM
              p_fact ->> 'external_receipt_ref'
         OR v_existing_receipt.result_sha256 IS DISTINCT FROM
              p_fact ->> 'external_receipt_sha256'
         OR v_existing_receipt.unknown_reason_code IS DISTINCT FROM
              p_fact ->> 'unknown_reason_code'
         OR v_existing_receipt.result_payload_sha256 IS DISTINCT FROM
              p_fact ->> 'result_payload_sha256'
         OR v_existing_receipt.producer_session_user IS DISTINCT FROM session_user
         OR v_existing_receipt.producer_lease_token IS DISTINCT FROM
              (p_fact ->> 'lease_token')::uuid
         OR v_existing_receipt.producer_lease_fencing_token IS DISTINCT FROM
              (p_fact ->> 'lease_fencing_token')::bigint
         OR v_existing_receipt.receipt_sha256 IS DISTINCT FROM v_receipt_hash THEN
        RAISE EXCEPTION 'execution effect receipt is already committed differently'
          USING ERRCODE = '23505';
      END IF;
      RETURN v_contract || jsonb_build_object(
        'receipt_sha256', v_receipt_hash,
        'replayed', true
      );
    END IF;

    IF v_lookup_pass = 1 THEN
      v_authority := app.require_execution_owner_lease(p_fact);
      v_now := clock_timestamp();
      IF v_now >= (v_authority ->> 'lease_expires_at')::timestamptz THEN
        RAISE EXCEPTION 'execution effect receipt cannot outlive its producer lease'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;

  v_is_initial_close :=
    v_envelope.producer_session_user = session_user
    AND v_envelope.producer_lease_token =
          (v_authority ->> 'lease_token')::uuid
    AND v_envelope.producer_lease_fencing_token =
          (v_authority ->> 'lease_fencing_token')::bigint;

  IF NOT v_is_initial_close THEN
    SELECT ticket.*
    INTO v_ticket
    FROM public.run_recovery_tickets AS ticket
    JOIN public.run_recovery_ticket_dispositions AS disposition
      ON disposition.workspace_id = ticket.workspace_id
     AND disposition.recovery_ticket_id = ticket.id
     AND disposition.recovery_ticket_sha256 = ticket.ticket_sha256
     AND disposition.ticket_fencing_token = ticket.fenced_generation
     AND disposition.disposition_kind = 'CLAIMED'
     AND disposition.claim_fencing_token =
          (v_authority ->> 'lease_fencing_token')::bigint
     AND disposition.claim_session_user = session_user
     AND disposition.claim_lease_owner = session_user
     AND disposition.claim_lease_token = (v_authority ->> 'lease_token')::uuid
     AND disposition.claim_lease_expires_at <=
          (v_authority ->> 'lease_expires_at')::timestamptz
    WHERE ticket.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND ticket.run_id = (v_authority ->> 'run_id')::uuid
      AND ticket.resource_kind = 'ATTEMPT'
      AND ticket.resource_id = (v_authority ->> 'attempt_id')::uuid
      AND ticket.fenced_generation + 1 =
          (v_authority ->> 'lease_fencing_token')::bigint
    FOR UPDATE OF ticket, disposition;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'recovery effect replay requires the current claimed ticket authority'
        USING ERRCODE = '42501';
    END IF;

    SELECT decision.value
    INTO v_decision
    FROM jsonb_array_elements(v_ticket.effect_decisions) AS decision(value)
    WHERE decision.value ->> 'retry_effect_envelope_id' = v_envelope.id::text
      AND decision.value ->> 'retry_effect_envelope_sha256' =
          v_envelope.envelope_sha256
      AND lower(decision.value ->> 'effect_class') = v_envelope.effect_class
      AND (
        (
          v_envelope.effect_class = 'safe'
          AND decision.value ->> 'recovery_decision' = 'REPLAY_SAFE'
          AND NOT decision.value ? 'operation_key'
        )
        OR (
          v_envelope.effect_class = 'requires_key'
          AND decision.value ->> 'recovery_decision' = 'REPLAY_WITH_KEY'
          AND decision.value ->> 'operation_key' = v_envelope.operation_key
        )
      )
      AND NOT decision.value ? 'effect_receipt_id'
      AND NOT decision.value ? 'effect_receipt_sha256';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'recovery effect replay is absent from the claimed ticket decision set'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_contract := jsonb_strip_nulls(jsonb_build_object(
    'schema_version', 'run-side-effect-receipt/1',
    'effect_receipt_id', v_receipt_id,
    'workspace_id', v_workspace_id,
    'run_id', v_envelope.run_id,
    'attempt_id', v_envelope.attempt_id,
    'step_id', v_envelope.step_id,
    'retry_effect_envelope_id', v_envelope.id,
    'retry_effect_envelope_sha256', v_envelope.envelope_sha256,
    'effect_class', upper(v_envelope.effect_class),
    'operation_key', v_envelope.operation_key,
    'outcome', v_outcome,
    'external_receipt_ref', p_fact ->> 'external_receipt_ref',
    'external_receipt_sha256', p_fact ->> 'external_receipt_sha256',
    'unknown_reason_code', p_fact ->> 'unknown_reason_code',
    'result_payload_sha256', p_fact ->> 'result_payload_sha256',
    'producer_session_user', session_user,
    'lease_owner', session_user,
    'lease_token', v_authority ->> 'lease_token',
    'lease_fencing_token', v_authority ->> 'lease_fencing_token',
    'lease_expires_at', app.g007_contract_instant(
      (v_authority ->> 'lease_expires_at')::timestamptz
    ),
    'authorized_at', app.g007_contract_instant(v_now)
  ));
  v_receipt_hash := app.g007_sha256(
    'better-agent/run-side-effect-receipt/1',
    app.g007_canonical_json(v_contract)
  );
  INSERT INTO public.run_side_effect_receipts (
    workspace_id, id, run_id, attempt_id, step_id, envelope_id,
    disposition, result_ref, result_sha256, unknown_reason_code,
    result_payload_sha256, receipt_sha256, producer_session_user,
    producer_lease_token, producer_lease_fencing_token,
    producer_lease_expires_at, created_at
  ) VALUES (
    v_workspace_id, v_receipt_id, (p_fact ->> 'run_id')::uuid,
    (p_fact ->> 'attempt_id')::uuid, (p_fact ->> 'step_id')::uuid,
    v_envelope.id, v_outcome,
    CASE WHEN v_outcome = 'CONFIRMED' THEN p_fact ->> 'external_receipt_ref' END,
    CASE WHEN v_outcome = 'CONFIRMED' THEN p_fact ->> 'external_receipt_sha256' END,
    CASE WHEN v_outcome = 'UNKNOWN' THEN p_fact ->> 'unknown_reason_code' END,
    p_fact ->> 'result_payload_sha256', v_receipt_hash, session_user,
    (v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz, v_now
  );
  RETURN v_contract || jsonb_build_object(
    'receipt_sha256', v_receipt_hash,
    'replayed', false
  );
END;
$function$;
ALTER FUNCTION app.record_execution_effect_receipt(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_execution_effect_receipt(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_execution_effect_receipt(jsonb)
TO ba_execution_executor;

CREATE FUNCTION app.record_usage_attribution(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_authority jsonb;
  v_existing public.run_usage_attributions%ROWTYPE;
  v_source_id uuid := gen_random_uuid();
  v_now timestamptz;
  v_source_hash text;
  v_settlement_key text;
  v_operation_intent_hash text;
  v_effect_payload_hash text;
  v_source_contract jsonb;
  v_request_contract jsonb;
  v_request_hash text;
  v_lookup_pass integer;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact - ARRAY[
       'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
       'reservation_id', 'step_id', 'metering_unit', 'quantity', 'amount',
       'detail_redacted', 'producer_operation_key'
     ]) <> '{}'::jsonb
     OR jsonb_typeof(p_fact -> 'run_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'attempt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_fencing_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'reservation_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'producer_operation_key') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'metering_unit') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'quantity') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'amount') IS DISTINCT FROM 'string'
     OR COALESCE(p_fact ->> 'run_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'reservation_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'step_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token', '') !~ '^[1-9][0-9]*$'
     OR COALESCE(length(p_fact ->> 'producer_operation_key'), 0)
          NOT BETWEEN 1 AND 300
     OR COALESCE(length(btrim(p_fact ->> 'producer_operation_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0)
          NOT BETWEEN 1 AND 300
     OR COALESCE(length(p_fact ->> 'metering_unit'), 0) NOT BETWEEN 1 AND 200
     OR COALESCE(length(btrim(p_fact ->> 'metering_unit', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0)
          NOT BETWEEN 1 AND 200
     OR COALESCE(p_fact ->> 'quantity', '') !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(p_fact ->> 'amount', '') !~ '^(0|[1-9][0-9]*)$'
     OR jsonb_typeof(COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb))
          IS DISTINCT FROM 'object'
     OR NOT app.g007_json_numbers_are_finite(
          COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb)
        ) THEN
    RAISE EXCEPTION 'usage attribution values are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF length(p_fact ->> 'lease_fencing_token') > 16
     OR length(p_fact ->> 'quantity') > 19
     OR length(p_fact ->> 'amount') > 19 THEN
    RAISE EXCEPTION 'usage attribution values are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (p_fact ->> 'lease_fencing_token')::numeric > 9007199254740991
     OR (p_fact ->> 'quantity')::numeric > 9223372036854775807
     OR (p_fact ->> 'amount')::numeric > 9223372036854775807 THEN
    RAISE EXCEPTION 'usage attribution values are invalid'
      USING ERRCODE = '22023';
  END IF;
  v_workspace_id := auth.require_internal_service_phase('execution');
  v_request_contract := jsonb_build_object(
    'run_id', p_fact ->> 'run_id',
    'attempt_id', p_fact ->> 'attempt_id',
    'lease_token', p_fact ->> 'lease_token',
    'lease_fencing_token', p_fact ->> 'lease_fencing_token',
    'reservation_id', p_fact ->> 'reservation_id',
    'step_id', p_fact ->> 'step_id',
    'producer_operation_key', p_fact ->> 'producer_operation_key',
    'metering_unit', p_fact ->> 'metering_unit',
    'quantity', p_fact ->> 'quantity',
    'amount', p_fact ->> 'amount',
    'detail_redacted', COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb)
  );
  v_request_hash := app.g007_sha256(
    'better-agent/execution-usage-producer-request/1',
    app.g007_canonical_json(v_request_contract)
  );
  -- An immutable first read recovers a committed response after lease expiry
  -- or terminalization. The miss path then acquires Run -> Attempt and repeats
  -- the read under lock to serialize concurrent use of the caller key.
  FOR v_lookup_pass IN 1..2 LOOP
    IF v_lookup_pass = 1 THEN
      SELECT source.* INTO v_existing
      FROM public.run_usage_attributions AS source
      WHERE source.workspace_id = v_workspace_id
        AND source.run_id = (p_fact ->> 'run_id')::uuid
        AND source.producer_operation_key = p_fact ->> 'producer_operation_key';
    ELSE
      SELECT source.* INTO v_existing
      FROM public.run_usage_attributions AS source
      WHERE source.workspace_id = v_workspace_id
        AND source.run_id = (p_fact ->> 'run_id')::uuid
        AND source.producer_operation_key = p_fact ->> 'producer_operation_key'
      FOR UPDATE;
    END IF;
    IF FOUND THEN
      IF v_existing.producer_session_user IS DISTINCT FROM session_user THEN
        RAISE EXCEPTION 'committed usage producer replay belongs to another session_user'
          USING ERRCODE = '42501';
      END IF;
      IF v_existing.producer_request_sha256 IS DISTINCT FROM v_request_hash THEN
        RAISE EXCEPTION 'usage producer operation key conflicts with another request'
          USING ERRCODE = '23505';
      END IF;
      v_source_contract := jsonb_build_object(
        'schema_version', 'run-usage-attribution/1',
        'usage_attribution_id', v_existing.id,
        'workspace_id', v_existing.workspace_id,
        'billing_owner_run_id', v_existing.billing_owner_run_id,
        'run_id', v_existing.run_id,
        'reservation_id', v_existing.reservation_id,
        'attempt_id', v_existing.attempt_id,
        'step_id', v_existing.step_id,
        'producer_session_user', v_existing.producer_session_user,
        'lease_owner', v_existing.producer_session_user,
        'lease_token', v_existing.producer_lease_token,
        'lease_fencing_token', v_existing.producer_lease_fencing_token::text,
        'lease_expires_at', app.g007_contract_instant(
          v_existing.producer_lease_expires_at
        ),
        'authorized_at', app.g007_contract_instant(v_existing.authorized_at),
        'producer_operation_key', v_existing.producer_operation_key,
        'metering_unit', v_existing.metering_unit,
        'metering_quantity', v_existing.quantity::text,
        'amount_credits', v_existing.amount::text,
        'settlement_operation_key', v_existing.settlement_operation_key,
        'operation_intent_sha256', v_existing.operation_intent_sha256,
        'execution_effect_payload_sha256', v_existing.execution_effect_payload_sha256,
        'consumption_generation', '1'
      );
      IF app.g007_sha256(
           'better-agent/execution-usage-source/1',
           app.g007_canonical_json(
             v_source_contract - ARRAY['lease_owner', 'consumption_generation']
           )
         ) IS DISTINCT FROM v_existing.source_authority_hash THEN
        RAISE EXCEPTION 'committed usage producer replay hash is invalid'
          USING ERRCODE = '55000';
      END IF;
      RETURN jsonb_build_object(
        'schema_version', 'run-usage-attribution-record-result/1',
        'source', v_source_contract,
        'source_authority_hash', v_existing.source_authority_hash,
        'detail_redacted', v_existing.detail_redacted,
        'replayed', true
      );
    END IF;
    IF v_lookup_pass = 1 THEN
      -- Serialize the key under Run before pass two. This lets an exact usage
      -- response survive a concurrent terminal seal that commits while the
      -- caller is waiting, without allowing a new write after that seal.
      PERFORM 1
      FROM public.runs AS run_row
      WHERE run_row.workspace_id = v_workspace_id
        AND run_row.id = (p_fact ->> 'run_id')::uuid
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'usage producer Run is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
    ELSE
      v_authority := app.require_execution_owner_lease(p_fact);
    END IF;
  END LOOP;
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  PERFORM 1
  FROM public.run_retry_effect_envelopes AS envelope
  WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND envelope.run_id = (v_authority ->> 'run_id')::uuid
    AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
    AND envelope.step_id = (p_fact ->> 'step_id')::uuid
  ORDER BY envelope.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'usage attribution requires locked CONFIRMED execution effect evidence'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
  FROM public.run_side_effect_receipts AS receipt
  JOIN public.run_retry_effect_envelopes AS envelope
    ON envelope.workspace_id = receipt.workspace_id
   AND envelope.id = receipt.envelope_id
  WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND envelope.run_id = (v_authority ->> 'run_id')::uuid
    AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
    AND envelope.step_id = (p_fact ->> 'step_id')::uuid
  ORDER BY envelope.id
  FOR UPDATE OF receipt;
  IF EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    LEFT JOIN public.run_side_effect_receipts AS receipt
      ON receipt.workspace_id = envelope.workspace_id
     AND receipt.envelope_id = envelope.id
    WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND envelope.run_id = (v_authority ->> 'run_id')::uuid
      AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
      AND envelope.step_id = (p_fact ->> 'step_id')::uuid
      AND receipt.disposition IS DISTINCT FROM 'CONFIRMED'
  ) THEN
    RAISE EXCEPTION 'usage attribution requires the complete Step effect set to be CONFIRMED'
      USING ERRCODE = '55000';
  END IF;
  SELECT app.g007_sha256(
    'better-agent/execution-effect-payload/1',
    app.g007_canonical_json(COALESCE(jsonb_agg(jsonb_build_object(
      'retry_effect_envelope_id', envelope.id,
      'retry_effect_envelope_sha256', envelope.envelope_sha256,
      'effect_receipt_id', receipt.id,
      'effect_receipt_sha256', receipt.receipt_sha256,
      'result_payload_sha256', receipt.result_payload_sha256
    ) ORDER BY envelope.id), '[]'::jsonb))
  )
  INTO v_effect_payload_hash
  FROM public.run_retry_effect_envelopes AS envelope
  JOIN public.run_side_effect_receipts AS receipt
    ON receipt.workspace_id = envelope.workspace_id
   AND receipt.envelope_id = envelope.id
   AND receipt.disposition = 'CONFIRMED'
  WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND envelope.run_id = (v_authority ->> 'run_id')::uuid
    AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
    AND envelope.step_id = (p_fact ->> 'step_id')::uuid;
  v_settlement_key := 'settle:usage:' || v_source_id::text;
  v_operation_intent_hash := app.g007_sha256(
    'better-agent/run-usage-operation-intent/1',
    app.g007_canonical_json(jsonb_build_object(
      'reservation_id', p_fact ->> 'reservation_id',
      'metering_unit', p_fact ->> 'metering_unit',
      'metering_quantity', p_fact ->> 'quantity',
      'amount_credits', p_fact ->> 'amount',
      'settlement_operation_key', v_settlement_key,
      'execution_effect_payload_sha256', v_effect_payload_hash
    ))
  );
  v_source_contract := jsonb_build_object(
    'schema_version', 'run-usage-attribution/1',
    'usage_attribution_id', v_source_id,
    'workspace_id', v_authority ->> 'workspace_id',
    'billing_owner_run_id', v_authority ->> 'run_id',
    'run_id', v_authority ->> 'run_id',
    'reservation_id', p_fact ->> 'reservation_id',
    'attempt_id', v_authority ->> 'attempt_id',
    'step_id', p_fact ->> 'step_id',
    'producer_session_user', v_authority ->> 'lease_owner',
    'lease_owner', v_authority ->> 'lease_owner',
    'lease_token', v_authority ->> 'lease_token',
    'lease_fencing_token', v_authority ->> 'lease_fencing_token',
    'lease_expires_at', app.g007_contract_instant(
      (v_authority ->> 'lease_expires_at')::timestamptz
    ),
    'authorized_at', app.g007_contract_instant(v_now),
    'producer_operation_key', p_fact ->> 'producer_operation_key',
    'metering_unit', p_fact ->> 'metering_unit',
    'metering_quantity', p_fact ->> 'quantity',
    'amount_credits', p_fact ->> 'amount',
    'settlement_operation_key', v_settlement_key,
    'operation_intent_sha256', v_operation_intent_hash,
    'execution_effect_payload_sha256', v_effect_payload_hash,
    'consumption_generation', '1'
  );
  v_source_hash := app.g007_sha256(
    'better-agent/execution-usage-source/1',
    app.g007_canonical_json(
      v_source_contract - ARRAY['lease_owner', 'consumption_generation']
    )
  );
  INSERT INTO public.run_usage_attributions (
    workspace_id, id, run_id, billing_owner_run_id, reservation_id,
    attempt_id, step_id, producer_session_user, producer_lease_token,
    producer_lease_fencing_token, producer_lease_expires_at,
    producer_operation_key, producer_request_sha256,
    metering_unit, quantity, amount, settlement_operation_key,
    operation_intent_sha256, execution_effect_payload_sha256,
    consumption_generation, detail_redacted,
    source_authority_hash, authorized_at
  ) VALUES (
    (v_authority ->> 'workspace_id')::uuid, v_source_id,
    (v_authority ->> 'run_id')::uuid, (v_authority ->> 'run_id')::uuid,
    (p_fact ->> 'reservation_id')::uuid, (v_authority ->> 'attempt_id')::uuid,
    (p_fact ->> 'step_id')::uuid, v_authority ->> 'lease_owner',
    (v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,
    p_fact ->> 'producer_operation_key', v_request_hash,
    p_fact ->> 'metering_unit', (p_fact ->> 'quantity')::bigint,
    (p_fact ->> 'amount')::bigint, v_settlement_key,
    v_operation_intent_hash, v_effect_payload_hash, 1,
    COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb), v_source_hash, v_now
  );
  RETURN jsonb_build_object(
    'schema_version', 'run-usage-attribution-record-result/1',
    'source', v_source_contract,
    'source_authority_hash', v_source_hash,
    'detail_redacted', COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb),
    'replayed', false
  );
END;
$function$;
ALTER FUNCTION app.record_usage_attribution(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_usage_attribution(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_usage_attribution(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_leased_termination_intent(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_authority jsonb;
  v_existing public.run_termination_intents%ROWTYPE;
  v_source_id uuid := gen_random_uuid();
  v_now timestamptz;
  v_closure_hash text;
  v_source_hash text;
  v_terminal_intent_hash text;
  v_usage_ids uuid[] := ARRAY[]::uuid[];
  v_intended_settle bigint := 0;
  v_intended_release bigint;
  v_settlement_key text;
  v_release_key text;
  v_operation_intent_hash text;
  v_close_intent jsonb;
  v_source_contract jsonb;
  v_request_contract jsonb;
  v_request_hash text;
  v_reservation record;
  v_lookup_pass integer;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact - ARRAY[
       'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
       'reservation_id', 'step_id', 'terminal_kind', 'termination_reason',
       'billing_close_intent_redacted', 'producer_operation_key'
     ]) <> '{}'::jsonb
     OR jsonb_typeof(p_fact -> 'run_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'attempt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'lease_fencing_token') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'reservation_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'step_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'terminal_kind') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'termination_reason') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_fact -> 'producer_operation_key') IS DISTINCT FROM 'string'
     OR jsonb_typeof(
       COALESCE(p_fact -> 'billing_close_intent_redacted', '{}'::jsonb)
     ) IS DISTINCT FROM 'object'
     OR COALESCE(p_fact ->> 'run_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'reservation_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'step_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token', '') !~ '^[1-9][0-9]*$'
     OR COALESCE(length(p_fact ->> 'producer_operation_key'), 0)
          NOT BETWEEN 1 AND 300
     OR COALESCE(length(btrim(p_fact ->> 'producer_operation_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')), 0)
          NOT BETWEEN 1 AND 300
     OR p_fact ->> 'terminal_kind' NOT IN ('FAILED', 'CANCELLED')
     OR (
       p_fact ->> 'terminal_kind' = 'CANCELLED'
       AND p_fact ->> 'termination_reason' <> 'USER_CANCELLED'
     )
     OR (
       p_fact ->> 'terminal_kind' = 'FAILED'
       AND p_fact ->> 'termination_reason' NOT IN (
         'MAX_ITERATIONS', 'MAX_MODEL_ATTEMPTS', 'MAX_TOOL_CALLS',
         'BUDGET_EXHAUSTED', 'AUTHORIZATION_REVALIDATION_FAILED',
         'RESOURCE_REVOKED', 'MODEL_FAILED', 'MODEL_OUTCOME_UNKNOWN',
         'CAPABILITY_FAILED', 'INVALID_DECISION',
         'STRATEGY_IMPLEMENTATION_UNAVAILABLE', 'INTERNAL_FAILURE'
       )
     ) THEN
    RAISE EXCEPTION 'leased termination kind/reason lacks durable protocol-v5 authority'
      USING ERRCODE = '22023';
  END IF;
  IF length(p_fact ->> 'lease_fencing_token') > 16 THEN
    RAISE EXCEPTION 'leased termination fencing token is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (p_fact ->> 'lease_fencing_token')::numeric > 9007199254740991 THEN
    RAISE EXCEPTION 'leased termination fencing token is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_workspace_id := auth.require_internal_service_phase('execution');
  v_request_contract := jsonb_build_object(
    'run_id', p_fact ->> 'run_id',
    'attempt_id', p_fact ->> 'attempt_id',
    'lease_token', p_fact ->> 'lease_token',
    'lease_fencing_token', p_fact ->> 'lease_fencing_token',
    'reservation_id', p_fact ->> 'reservation_id',
    'step_id', p_fact ->> 'step_id',
    'producer_operation_key', p_fact ->> 'producer_operation_key',
    'terminal_kind', p_fact ->> 'terminal_kind',
    'termination_reason', p_fact ->> 'termination_reason',
    'billing_close_intent_redacted', COALESCE(
      p_fact -> 'billing_close_intent_redacted', '{}'::jsonb
    )
  );
  v_request_hash := app.g007_sha256(
    'better-agent/execution-termination-producer-request/1',
    app.g007_canonical_json(v_request_contract)
  );
  -- A Run has exactly one terminal producer intent. Read that immutable fact
  -- before lease validation, then recheck under Run -> Attempt on a miss.
  FOR v_lookup_pass IN 1..2 LOOP
    IF v_lookup_pass = 1 THEN
      SELECT source.* INTO v_existing
      FROM public.run_termination_intents AS source
      WHERE source.workspace_id = v_workspace_id
        AND source.run_id = (p_fact ->> 'run_id')::uuid;
    ELSE
      SELECT source.* INTO v_existing
      FROM public.run_termination_intents AS source
      WHERE source.workspace_id = v_workspace_id
        AND source.run_id = (p_fact ->> 'run_id')::uuid
      FOR UPDATE;
    END IF;
    IF FOUND THEN
      IF v_existing.producer_session_user IS DISTINCT FROM session_user THEN
        RAISE EXCEPTION 'committed termination producer replay belongs to another session_user'
          USING ERRCODE = '42501';
      END IF;
      IF v_existing.producer_operation_key
           IS DISTINCT FROM p_fact ->> 'producer_operation_key'
         OR v_existing.producer_request_sha256 IS DISTINCT FROM v_request_hash THEN
        RAISE EXCEPTION 'termination producer operation conflicts with the committed Run intent'
          USING ERRCODE = '23505';
      END IF;
      v_source_contract := jsonb_build_object(
        'schema_version', 'run-termination-intent/1',
        'termination_intent_id', v_existing.id,
        'workspace_id', v_existing.workspace_id,
        'billing_owner_run_id', v_existing.billing_owner_run_id,
        'run_id', v_existing.run_id,
        'reservation_id', v_existing.reservation_id,
        'attempt_id', v_existing.attempt_id,
        'step_id', v_existing.step_id,
        'producer_session_user', v_existing.producer_session_user,
        'lease_owner', v_existing.producer_session_user,
        'lease_token', v_existing.producer_lease_token,
        'lease_fencing_token', v_existing.producer_lease_fencing_token::text,
        'lease_expires_at', app.g007_contract_instant(
          v_existing.producer_lease_expires_at
        ),
        'authorized_at', app.g007_contract_instant(v_existing.authorized_at),
        'producer_operation_key', v_existing.producer_operation_key,
        'terminal_status', v_existing.terminal_kind,
        'termination_reason', v_existing.termination_reason,
        'effect_disposition', v_existing.effect_disposition,
        'effect_closure_sha256', v_existing.effect_closure_sha256,
        'usage_attribution_ids', to_jsonb(v_existing.usage_attribution_ids),
        'intended_settle_credits', v_existing.intended_settle_credits::text,
        'settlement_operation_key', v_existing.settlement_operation_key,
        'intended_release_credits', v_existing.intended_release_credits::text,
        'release_operation_key', v_existing.release_operation_key,
        'release_reason_code', v_existing.release_reason_code,
        'operation_intent_sha256', v_existing.operation_intent_sha256,
        'consumption_generation', '1'
      );
      IF app.g007_sha256(
           'better-agent/execution-termination-source/1',
           app.g007_canonical_json(
             v_source_contract - ARRAY['lease_owner', 'consumption_generation']
           )
         ) IS DISTINCT FROM v_existing.source_authority_hash THEN
        RAISE EXCEPTION 'committed termination producer replay hash is invalid'
          USING ERRCODE = '55000';
      END IF;
      RETURN jsonb_build_object(
        'schema_version', 'run-termination-intent-record-result/1',
        'intent', v_source_contract,
        'terminal_intent_hash', v_existing.terminal_intent_hash,
        'source_authority_hash', v_existing.source_authority_hash,
        'billing_close_intent_redacted', v_existing.billing_close_intent_redacted,
        'replayed', true
      );
    END IF;
    IF v_lookup_pass = 1 THEN
      -- The competing writer may commit a terminal source while this call
      -- waits. Lock Run first, then let pass two replay that immutable source
      -- before active-lease validation observes the newly sealed Run.
      PERFORM 1
      FROM public.runs AS run_row
      WHERE run_row.workspace_id = v_workspace_id
        AND run_row.id = (p_fact ->> 'run_id')::uuid
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'termination producer Run is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
    ELSE
      v_authority := app.require_execution_owner_lease(p_fact - 'step_id');
    END IF;
  END LOOP;
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  PERFORM 1
  FROM public.run_retry_effect_envelopes AS envelope
  WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND envelope.run_id = (v_authority ->> 'run_id')::uuid
    AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
  ORDER BY envelope.id
  FOR UPDATE;
  PERFORM 1
  FROM public.run_side_effect_receipts AS receipt
  WHERE receipt.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND receipt.run_id = (v_authority ->> 'run_id')::uuid
    AND receipt.attempt_id = (v_authority ->> 'attempt_id')::uuid
  ORDER BY receipt.id
  FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND envelope.run_id = (v_authority ->> 'run_id')::uuid
      AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
  ) OR EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    LEFT JOIN public.run_side_effect_receipts AS receipt
      ON receipt.workspace_id = envelope.workspace_id
     AND receipt.envelope_id = envelope.id
    WHERE envelope.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND envelope.run_id = (v_authority ->> 'run_id')::uuid
      AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
      AND (
        envelope.effect_class = 'unsafe'
        OR receipt.disposition IS DISTINCT FROM 'CONFIRMED'
      )
  ) THEN
    RAISE EXCEPTION 'termination attribution requires a CLOSED effect envelope set'
      USING ERRCODE = '55000';
  END IF;
  v_closure_hash := app.g007_attempt_effect_closure_sha256(
    (v_authority ->> 'workspace_id')::uuid,
    (v_authority ->> 'run_id')::uuid,
    (v_authority ->> 'attempt_id')::uuid
  );
  PERFORM 1
  FROM public.run_usage_attributions AS source
  WHERE source.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND source.run_id = (v_authority ->> 'run_id')::uuid
    AND source.reservation_id = (p_fact ->> 'reservation_id')::uuid
  ORDER BY source.id
  FOR UPDATE;
  -- This snapshot authors an intent only. Finalization revalidates it while
  -- holding the Workspace billing fence, so the run owner needs no raw UPDATE.
  SELECT
    reservation.id,
    reservation.status,
    reservation.reserved_credits,
    reservation.settled_credits,
    reservation.released_credits
  INTO v_reservation
  FROM public.credit_reservations AS reservation
  WHERE reservation.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND reservation.id = (p_fact ->> 'reservation_id')::uuid
    AND reservation.run_id = (v_authority ->> 'run_id')::uuid
    AND reservation.billing_owner_run_id = (v_authority ->> 'run_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'termination attribution reservation is unavailable'
      USING ERRCODE = '55000';
  END IF;
  IF v_reservation.status = 'HELD' THEN
    SELECT
      COALESCE(array_agg(source.id ORDER BY source.id), ARRAY[]::uuid[]),
      COALESCE(sum(source.amount), 0)
    INTO v_usage_ids, v_intended_settle
    FROM public.run_usage_attributions AS source
    WHERE source.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND source.run_id = (v_authority ->> 'run_id')::uuid
      AND source.reservation_id = (p_fact ->> 'reservation_id')::uuid
      AND source.consumed_at IS NULL;
    v_intended_release := v_reservation.reserved_credits
      - v_reservation.settled_credits - v_reservation.released_credits
      - v_intended_settle;
    IF v_intended_release < 0 THEN
      RAISE EXCEPTION 'termination attribution usage exceeds the durable reservation remainder'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_reservation.status IN ('SETTLED', 'RELEASED', 'EXPIRED') THEN
    v_intended_release := v_reservation.reserved_credits
      - v_reservation.settled_credits - v_reservation.released_credits;
    IF v_intended_release <> 0
       OR EXISTS (
         SELECT 1
         FROM public.run_usage_attributions AS source
         LEFT JOIN public.run_billing_authority_receipts AS receipt
           ON receipt.workspace_id = source.workspace_id
          AND receipt.authority_kind = 'EXECUTION_USAGE'
          AND receipt.source_id = source.id
         WHERE source.workspace_id = (v_authority ->> 'workspace_id')::uuid
           AND source.run_id = (v_authority ->> 'run_id')::uuid
           AND source.reservation_id = (p_fact ->> 'reservation_id')::uuid
           AND (
             source.consumed_at IS NULL
             OR receipt.id IS NULL
             OR receipt.source_authority_hash IS DISTINCT FROM source.source_authority_hash
             OR receipt.operation <> 'SETTLE'
             OR receipt.amount <> source.amount
             OR receipt.run_id <> source.run_id
             OR receipt.reservation_id <> source.reservation_id
             OR receipt.source_consumption_generation
                  IS DISTINCT FROM source.consumption_generation - 1
           )
       ) THEN
      RAISE EXCEPTION 'closed reservation usage lacks an exact durable settlement receipt'
        USING ERRCODE = '55000';
    END IF;
    SELECT
      COALESCE(array_agg(source.id ORDER BY source.id), ARRAY[]::uuid[]),
      COALESCE(sum(source.amount), 0)
    INTO v_usage_ids, v_intended_settle
    FROM public.run_usage_attributions AS source
    WHERE source.workspace_id = (v_authority ->> 'workspace_id')::uuid
      AND source.run_id = (v_authority ->> 'run_id')::uuid
      AND source.reservation_id = (p_fact ->> 'reservation_id')::uuid;
    v_intended_release := 0;
  ELSE
    RAISE EXCEPTION 'termination attribution reservation state is unsupported'
      USING ERRCODE = '55000';
  END IF;
  v_settlement_key := 'settle:terminal:' || v_source_id::text || ':usage-set';
  v_release_key := 'release:terminal:' || v_source_id::text || ':remainder';
  v_close_intent := jsonb_build_object(
    'schema_version', 'run-termination-financial-close/1',
    'reservation_id', v_reservation.id,
    'usage_attribution_ids', to_jsonb(v_usage_ids),
    'intended_settle_credits', v_intended_settle::text,
    'settlement_operation_key', v_settlement_key,
    'intended_release_credits', v_intended_release::text,
    'release_operation_key', v_release_key,
    'release_reason_code', p_fact ->> 'termination_reason',
    'effect_closure_sha256', v_closure_hash
  );
  v_operation_intent_hash := app.g007_sha256(
    'better-agent/run-termination-operation-intent/1',
    app.g007_canonical_json(v_close_intent)
  );
  v_terminal_intent_hash := app.g007_sha256(
    'better-agent/run-termination-intent/1',
    app.g007_canonical_json(jsonb_build_object(
      'run_id', v_authority ->> 'run_id',
      'attempt_id', v_authority ->> 'attempt_id',
      'step_id', p_fact ->> 'step_id',
      'terminal_kind', p_fact ->> 'terminal_kind',
      'termination_reason', p_fact ->> 'termination_reason',
      'effect_closure_sha256', v_closure_hash,
      'operation_intent_sha256', v_operation_intent_hash
    ))
  );
  v_source_contract := jsonb_build_object(
    'schema_version', 'run-termination-intent/1',
    'termination_intent_id', v_source_id,
    'workspace_id', v_authority ->> 'workspace_id',
    'billing_owner_run_id', v_authority ->> 'run_id',
    'run_id', v_authority ->> 'run_id',
    'reservation_id', v_reservation.id,
    'attempt_id', v_authority ->> 'attempt_id',
    'step_id', p_fact ->> 'step_id',
    'producer_session_user', v_authority ->> 'lease_owner',
    'lease_owner', v_authority ->> 'lease_owner',
    'lease_token', v_authority ->> 'lease_token',
    'lease_fencing_token', v_authority ->> 'lease_fencing_token',
    'lease_expires_at', app.g007_contract_instant(
      (v_authority ->> 'lease_expires_at')::timestamptz
    ),
    'authorized_at', app.g007_contract_instant(v_now),
    'producer_operation_key', p_fact ->> 'producer_operation_key',
    'terminal_status', p_fact ->> 'terminal_kind',
    'termination_reason', p_fact ->> 'termination_reason',
    'effect_disposition', 'CLOSED',
    'effect_closure_sha256', v_closure_hash,
    'usage_attribution_ids', to_jsonb(v_usage_ids),
    'intended_settle_credits', v_intended_settle::text,
    'settlement_operation_key', v_settlement_key,
    'intended_release_credits', v_intended_release::text,
    'release_operation_key', v_release_key,
    'release_reason_code', p_fact ->> 'termination_reason',
    'operation_intent_sha256', v_operation_intent_hash,
    'consumption_generation', '1'
  );
  v_source_hash := app.g007_sha256(
    'better-agent/execution-termination-source/1',
    app.g007_canonical_json(
      v_source_contract - ARRAY['lease_owner', 'consumption_generation']
    )
  );
  INSERT INTO public.run_termination_intents (
    workspace_id, id, run_id, billing_owner_run_id, reservation_id,
    attempt_id, step_id, producer_session_user, producer_lease_token,
    producer_lease_fencing_token, producer_lease_expires_at, terminal_kind,
    producer_operation_key, producer_request_sha256,
    termination_reason, terminal_intent_hash, effect_disposition,
    effect_closure_sha256, billing_close_intent_redacted,
    usage_attribution_ids, intended_settle_credits, settlement_operation_key,
    intended_release_credits, release_operation_key, release_reason_code,
    operation_intent_sha256, consumption_generation,
    source_authority_hash, authorized_at
  ) VALUES (
    (v_authority ->> 'workspace_id')::uuid, v_source_id,
    (v_authority ->> 'run_id')::uuid, (v_authority ->> 'run_id')::uuid,
    (p_fact ->> 'reservation_id')::uuid, (v_authority ->> 'attempt_id')::uuid,
    (p_fact ->> 'step_id')::uuid, v_authority ->> 'lease_owner',
    (v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,
    p_fact ->> 'terminal_kind', p_fact ->> 'producer_operation_key', v_request_hash,
    p_fact ->> 'termination_reason',
    v_terminal_intent_hash, 'CLOSED', v_closure_hash,
    v_close_intent, v_usage_ids, v_intended_settle, v_settlement_key,
    v_intended_release, v_release_key, p_fact ->> 'termination_reason',
    v_operation_intent_hash, 1,
    v_source_hash, v_now
  );
  RETURN jsonb_build_object(
    'schema_version', 'run-termination-intent-record-result/1',
    'intent', v_source_contract,
    'terminal_intent_hash', v_terminal_intent_hash,
    'source_authority_hash', v_source_hash,
    'billing_close_intent_redacted', v_close_intent,
    'replayed', false
  );
END;
$function$;
ALTER FUNCTION app.record_leased_termination_intent(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_leased_termination_intent(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_leased_termination_intent(jsonb)
TO ba_execution_executor;

CREATE FUNCTION app.require_run_dispatch_lease(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('execution');
  v_run public.runs%ROWTYPE;
  v_message public.outbox%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact ->> 'run_id') IS NULL
     OR (p_fact ->> 'outbox_id') IS NULL
     OR (p_fact ->> 'lease_token') IS NULL
     OR (p_fact ->> 'lease_fencing_token') !~ '^[1-9][0-9]{0,15}$' THEN
    RAISE EXCEPTION 'invalid RUN_DISPATCH lease authority'
      USING ERRCODE = '22023';
  END IF;

  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
     OR v_run.terminal_intent_hash IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM public.run_termination_intents AS source
       WHERE source.workspace_id = v_workspace_id
         AND source.run_id = v_run.id
     ) THEN
    RAISE EXCEPTION 'Run is unavailable for RUN_DISPATCH mutation'
      USING ERRCODE = '55000';
  END IF;

  SELECT message.* INTO v_message
  FROM public.outbox AS message
  WHERE message.workspace_id = v_workspace_id
    AND message.id = (p_fact ->> 'outbox_id')::uuid
    AND message.run_id = v_run.id
  FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND
     OR v_message.message_type <> 'RUN_DISPATCH'
     OR v_message.delivery_protocol_version <> 5
     OR v_message.status <> 'LEASED'
     OR v_message.lease_owner IS DISTINCT FROM session_user
     OR v_message.lease_token IS DISTINCT FROM (p_fact ->> 'lease_token')::uuid
     OR v_message.lease_fencing_token IS DISTINCT FROM
       (p_fact ->> 'lease_fencing_token')::bigint
     OR v_message.delivery_generation IS DISTINCT FROM
       (p_fact ->> 'lease_fencing_token')::bigint
     OR v_message.lease_expires_at <= v_now THEN
    RAISE EXCEPTION 'RUN_DISPATCH lease is missing, stale, expired or owned by another session'
      USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'workspace_id', v_workspace_id,
    'run_id', v_run.id,
    'outbox_id', v_message.id,
    'lease_owner', v_message.lease_owner,
    'lease_token', v_message.lease_token,
    'lease_fencing_token', v_message.lease_fencing_token::text,
    'lease_expires_at', v_message.lease_expires_at,
    'delivery_generation', v_message.delivery_generation::text
  );
END;
$function$;
ALTER FUNCTION app.require_run_dispatch_lease(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.require_run_dispatch_lease(jsonb) FROM PUBLIC;

CREATE FUNCTION app.claim_run_dispatch(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('execution');
  v_run public.runs%ROWTYPE;
  v_message public.outbox%ROWTYPE;
  v_ticket public.run_recovery_tickets%ROWTYPE;
  v_duration integer := (p_fact ->> 'duration_seconds')::integer;
  v_now timestamptz;
  v_generation bigint;
  v_token uuid := gen_random_uuid();
  v_expiry timestamptz;
  v_disposition_id uuid;
  v_disposition jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR v_duration NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid RUN_DISPATCH claim request'
      USING ERRCODE = '22023';
  END IF;
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
     OR v_run.terminal_intent_hash IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM public.run_termination_intents AS source
       WHERE source.workspace_id = v_workspace_id
         AND source.run_id = v_run.id
     ) THEN
    RAISE EXCEPTION 'Run cannot admit a RUN_DISPATCH lease'
      USING ERRCODE = '55000';
  END IF;

  SELECT message.* INTO v_message
  FROM public.outbox AS message
  WHERE message.workspace_id = v_workspace_id
    AND message.id = (p_fact ->> 'outbox_id')::uuid
    AND message.run_id = v_run.id
  FOR UPDATE;
  v_now := clock_timestamp();
  v_expiry := v_now + make_interval(secs => v_duration);
  IF NOT FOUND
     OR v_message.message_type <> 'RUN_DISPATCH'
     OR v_message.status <> 'PENDING'
     OR v_message.available_at > v_now
     OR v_message.lease_owner IS NOT NULL
     OR v_message.lease_token IS NOT NULL
     OR v_message.lease_fencing_token IS NOT NULL
     OR v_message.lease_expires_at IS NOT NULL
     OR v_message.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'RUN_DISPATCH message is not claimable'
      USING ERRCODE = '55000';
  END IF;

  IF v_message.recovery_ticket_id IS NULL THEN
    IF p_fact ->> 'recovery_ticket_id' IS NOT NULL THEN
      RAISE EXCEPTION 'initial RUN_DISPATCH claim cannot present a recovery ticket'
        USING ERRCODE = '42501';
    END IF;
    v_generation := v_message.delivery_generation + 1;
  ELSE
    SELECT ticket.* INTO v_ticket
    FROM public.run_recovery_tickets AS ticket
    WHERE ticket.workspace_id = v_workspace_id
      AND ticket.id = v_message.recovery_ticket_id
      AND ticket.id = (p_fact ->> 'recovery_ticket_id')::uuid
      AND ticket.run_id = v_run.id
      AND ticket.resource_kind = 'RUN_DISPATCH'
      AND ticket.resource_id = v_message.id
      AND ticket.fenced_generation = v_message.delivery_generation
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1
      FROM public.run_recovery_ticket_dispositions AS disposition
      WHERE disposition.workspace_id = v_workspace_id
        AND disposition.recovery_ticket_id = v_ticket.id
    ) THEN
      RAISE EXCEPTION 'RUN_DISPATCH recovery ticket is missing or already consumed'
        USING ERRCODE = '42501';
    END IF;
    v_generation := v_ticket.fenced_generation + 1;
    v_disposition_id := gen_random_uuid();
    INSERT INTO public.run_recovery_ticket_dispositions (
      workspace_id, id, recovery_ticket_id, recovery_ticket_sha256,
      run_id, resource_kind, resource_id, ticket_fencing_token,
      disposition_kind, claim_fencing_token, claim_session_user,
      claim_lease_owner, claim_lease_token, claim_lease_expires_at, disposed_at
    ) VALUES (
      v_workspace_id, v_disposition_id, v_ticket.id, v_ticket.ticket_sha256,
      v_run.id, 'RUN_DISPATCH', v_message.id, v_ticket.fenced_generation,
      'CLAIMED', v_generation, session_user, session_user, v_token, v_expiry, v_now
    );
    v_disposition := jsonb_build_object(
      'schema_version', 'run-recovery-ticket-disposition/1',
      'disposition_id', v_disposition_id,
      'recovery_ticket_id', v_ticket.id,
      'recovery_ticket_sha256', v_ticket.ticket_sha256,
      'workspace_id', v_workspace_id,
      'run_id', v_run.id,
      'resource_kind', 'RUN_DISPATCH',
      'resource_id', v_message.id,
      'ticket_fencing_token', v_ticket.fenced_generation::text,
      'disposition_kind', 'CLAIMED',
      'claim_fencing_token', v_generation::text,
      'claim_session_user', session_user,
      'claim_lease_owner', session_user,
      'claim_lease_token', v_token,
      'claim_lease_expires_at', v_expiry,
      'disposed_at', v_now
    );
  END IF;
  IF v_generation NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION 'RUN_DISPATCH fencing token exceeds the protocol-v5 limit'
      USING ERRCODE = '22003';
  END IF;

  UPDATE public.outbox
  SET status = 'LEASED',
      delivery_protocol_version = 5,
      delivery_generation = v_generation,
      recovery_ticket_id = NULL,
      lease_owner = session_user,
      lease_token = v_token,
      lease_fencing_token = v_generation,
      lease_expires_at = v_expiry,
      attempt_count = attempt_count + 1,
      last_error_redacted = NULL
  WHERE workspace_id = v_workspace_id AND id = v_message.id;

  INSERT INTO public.phase_operation_audit (
    workspace_id, id, phase, operation, resource_kind, resource_id,
    operation_sha256, actor_session_user, occurred_at
  ) VALUES (
    v_workspace_id, gen_random_uuid(), 'execution', 'CLAIM_RUN_DISPATCH',
    'RUN_DISPATCH', v_message.id,
    app.g007_sha256('better-agent/phase-operation/1',
      format('%s:%s:%s', v_run.id, v_message.id, v_generation)),
    session_user, v_now
  );
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'workspace_id', v_workspace_id,
    'run_id', v_run.id,
    'outbox_id', v_message.id,
    'lease_owner', session_user,
    'lease_token', v_token,
    'lease_fencing_token', v_generation::text,
    'delivery_generation', v_generation::text,
    'lease_expires_at', v_expiry,
    'recovery_ticket_disposition', v_disposition
  ));
END;
$function$;
ALTER FUNCTION app.claim_run_dispatch(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.claim_run_dispatch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_run_dispatch(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.renew_run_dispatch_lease(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_duration integer := (p_fact ->> 'duration_seconds')::integer;
  v_expiry timestamptz;
BEGIN
  IF v_duration NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'RUN_DISPATCH lease duration must be between 1 and 300 seconds'
      USING ERRCODE = '22023';
  END IF;
  v_authority := app.require_run_dispatch_lease(p_fact);
  v_expiry := clock_timestamp() + make_interval(secs => v_duration);
  IF v_expiry <= (v_authority ->> 'lease_expires_at')::timestamptz THEN
    RAISE EXCEPTION 'RUN_DISPATCH lease renewal must strictly extend expiry'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.outbox
  SET lease_expires_at = v_expiry
  WHERE workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND id = (v_authority ->> 'outbox_id')::uuid;
  RETURN v_authority || jsonb_build_object('lease_expires_at', v_expiry);
END;
$function$;
ALTER FUNCTION app.renew_run_dispatch_lease(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.renew_run_dispatch_lease(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.renew_run_dispatch_lease(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.complete_run_dispatch(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb := app.require_run_dispatch_lease(p_fact);
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE public.outbox
  SET status = 'DELIVERED',
      lease_owner = NULL,
      lease_token = NULL,
      lease_fencing_token = NULL,
      lease_expires_at = NULL,
      delivered_at = v_now,
      last_error_redacted = NULL
  WHERE workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND id = (v_authority ->> 'outbox_id')::uuid;
  RETURN jsonb_build_object(
    'run_id', v_authority ->> 'run_id',
    'outbox_id', v_authority ->> 'outbox_id',
    'status', 'DELIVERED',
    'delivery_generation', v_authority ->> 'delivery_generation',
    'delivered_at', v_now
  );
END;
$function$;
ALTER FUNCTION app.complete_run_dispatch(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.complete_run_dispatch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_run_dispatch(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.fail_run_dispatch(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb := app.require_run_dispatch_lease(p_fact);
  v_disposition text := p_fact ->> 'disposition';
  v_error_code text := p_fact ->> 'error_code';
  v_failure_evidence text := p_fact ->> 'delivery_failure_evidence_sha256';
  v_now timestamptz := clock_timestamp();
  v_status text;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR (p_fact - ARRAY[
       'run_id', 'outbox_id', 'lease_token', 'lease_fencing_token',
       'disposition', 'error_code', 'delivery_failure_evidence_sha256'
     ]) <> '{}'::jsonb
     OR v_disposition NOT IN ('RETRY', 'DEAD')
     OR length(btrim(v_error_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 200
     OR (
       v_disposition = 'DEAD'
       AND (p_fact ->> 'delivery_failure_evidence_sha256')
         !~ '^sha256:[0-9a-f]{64}$'
     )
     OR (
       v_disposition = 'RETRY'
       AND (p_fact ->> 'delivery_failure_evidence_sha256') IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'RUN_DISPATCH failure requires an exact disposition and immutable DEAD evidence'
      USING ERRCODE = '22023';
  END IF;
  v_status := CASE WHEN v_disposition = 'RETRY' THEN 'PENDING' ELSE 'DEAD' END;
  UPDATE public.outbox
  SET status = v_status,
      available_at = CASE WHEN v_disposition = 'RETRY' THEN v_now ELSE available_at END,
      lease_owner = NULL,
      lease_token = NULL,
      lease_fencing_token = NULL,
      lease_expires_at = NULL,
      delivered_at = NULL,
      last_error_redacted = v_error_code,
      delivery_failure_evidence_sha256 = v_failure_evidence
  WHERE workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND id = (v_authority ->> 'outbox_id')::uuid;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'run_id', v_authority ->> 'run_id',
    'outbox_id', v_authority ->> 'outbox_id',
    'status', v_status,
    'delivery_generation', v_authority ->> 'delivery_generation',
    'last_error_code', v_error_code,
    'delivery_failure_evidence_sha256', v_failure_evidence,
    'failed_at', v_now
  ));
END;
$function$;
ALTER FUNCTION app.fail_run_dispatch(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.fail_run_dispatch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fail_run_dispatch(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.fence_expired_run_attempt(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('reclaimer');
  v_run public.runs%ROWTYPE;
  v_attempt public.run_attempts%ROWTYPE;
  v_termination public.run_termination_intents%ROWTYPE;
  v_now timestamptz;
  v_fenced_generation bigint;
  v_ticket_id uuid;
  v_hold_id uuid;
  v_reason text;
  v_closure_disposition text := p_fact #>> '{effect_closure,disposition}';
  v_closure_hash text;
  v_effect_decisions jsonb;
  v_effect_decisions_hash text;
  v_checkpoint_id uuid;
  v_checkpoint_hash text;
  v_hold_envelope_id uuid;
  v_hold_envelope_hash text;
  v_hold_receipt_id uuid;
  v_hold_receipt_hash text;
  v_ticket_hash text;
  v_hold_hash text;
  v_ticket_contract jsonb;
  v_hold_contract jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact - ARRAY[
       'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
       'effect_closure'
     ]) <> '{}'::jsonb
     OR NOT (p_fact ?& ARRAY[
       'run_id', 'attempt_id', 'lease_token', 'lease_fencing_token',
       'effect_closure'
     ])
     OR (p_fact ->> 'lease_token') IS NULL
     OR (p_fact ->> 'lease_fencing_token') !~ '^[1-9][0-9]{0,15}$'
     OR jsonb_typeof(p_fact -> 'effect_closure') <> 'object'
     OR ((p_fact -> 'effect_closure') - ARRAY[
       'disposition', 'effect_closure_sha256'
     ]) <> '{}'::jsonb
     OR NOT ((p_fact -> 'effect_closure') ?& ARRAY[
       'disposition', 'effect_closure_sha256'
     ])
     OR v_closure_disposition NOT IN ('CLOSED', 'OPEN', 'UNKNOWN')
     OR (p_fact #>> '{effect_closure,effect_closure_sha256}')
       !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid expired Attempt fence request'
      USING ERRCODE = '22023';
  END IF;
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
     OR v_run.terminal_intent_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Run is unavailable for Attempt recovery fencing'
      USING ERRCODE = '55000';
  END IF;
  SELECT attempt.* INTO v_attempt
  FROM public.run_attempts AS attempt
  WHERE attempt.workspace_id = v_workspace_id
    AND attempt.run_id = v_run.id
    AND attempt.id = (p_fact ->> 'attempt_id')::uuid
  FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND
     OR v_attempt.runtime_protocol_version <> 5
     OR v_attempt.status <> 'RUNNING'
     OR v_attempt.lease_token IS DISTINCT FROM (p_fact ->> 'lease_token')::uuid
     OR v_attempt.lease_fencing_token IS DISTINCT FROM
       (p_fact ->> 'lease_fencing_token')::bigint
     OR v_attempt.lease_generation IS DISTINCT FROM
       (p_fact ->> 'lease_fencing_token')::bigint
     OR v_attempt.lease_expires_at > v_now THEN
    RAISE EXCEPTION 'Attempt lease is missing, stale or not expired'
      USING ERRCODE = '42501';
  END IF;
  IF v_attempt.lease_generation >= 9007199254740991 THEN
    RAISE EXCEPTION 'Attempt recovery fence exceeds the protocol-v5 limit'
      USING ERRCODE = '22003';
  END IF;
  v_fenced_generation := v_attempt.lease_generation + 1;

  v_closure_hash := app.g007_attempt_effect_closure_sha256(
    v_workspace_id, v_run.id, v_attempt.id
  );
  IF v_closure_hash IS DISTINCT FROM
       p_fact #>> '{effect_closure,effect_closure_sha256}' THEN
    RAISE EXCEPTION 'Attempt effect closure does not match locked durable facts'
      USING ERRCODE = '42501';
  END IF;

  SELECT checkpoint.id, checkpoint.checkpoint_hash
  INTO v_checkpoint_id, v_checkpoint_hash
  FROM public.run_checkpoints AS checkpoint
  WHERE checkpoint.workspace_id = v_workspace_id
    AND checkpoint.run_id = v_run.id
    AND checkpoint.producer_attempt_id = v_attempt.id
    AND checkpoint.runtime_protocol_version = 5
  ORDER BY checkpoint.checkpoint_sequence DESC, checkpoint.id DESC
  LIMIT 1;

  IF NOT EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    WHERE envelope.workspace_id = v_workspace_id
      AND envelope.run_id = v_run.id
      AND envelope.attempt_id = v_attempt.id
  ) THEN
    v_reason := 'MISSING_ENVELOPE';
  ELSE
    SELECT
      CASE
        WHEN envelope.effect_class = 'unsafe' THEN 'UNSAFE_EFFECT'
        ELSE 'SIDE_EFFECT_UNKNOWN'
      END,
      envelope.id,
      envelope.envelope_sha256,
      CASE WHEN receipt.disposition = 'UNKNOWN' THEN receipt.id END,
      CASE WHEN receipt.disposition = 'UNKNOWN' THEN receipt.receipt_sha256 END
    INTO
      v_reason,
      v_hold_envelope_id,
      v_hold_envelope_hash,
      v_hold_receipt_id,
      v_hold_receipt_hash
    FROM public.run_retry_effect_envelopes AS envelope
    LEFT JOIN public.run_side_effect_receipts AS receipt
      ON receipt.workspace_id = envelope.workspace_id
     AND receipt.envelope_id = envelope.id
    WHERE envelope.workspace_id = v_workspace_id
      AND envelope.run_id = v_run.id
      AND envelope.attempt_id = v_attempt.id
      AND (envelope.effect_class = 'unsafe' OR receipt.disposition = 'UNKNOWN')
    ORDER BY envelope.id
    LIMIT 1;
  END IF;
  IF v_reason IS NULL AND v_closure_disposition = 'OPEN' THEN
    v_reason := 'EFFECT_CLOSURE_OPEN';
  ELSIF v_reason IS NULL AND v_closure_disposition = 'UNKNOWN' THEN
    v_reason := 'EFFECT_CLOSURE_UNKNOWN';
  END IF;

  IF v_reason IS NOT NULL THEN
    v_hold_id := gen_random_uuid();
    v_hold_contract := jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 'run-recovery-hold-intent/1',
      'recovery_hold_intent_id', v_hold_id,
      'workspace_id', v_workspace_id,
      'run_id', v_run.id,
      'resource_kind', 'ATTEMPT',
      'resource_id', v_attempt.id,
      'old_fencing_token', v_attempt.lease_generation::text,
      'new_fencing_token', v_fenced_generation::text,
      'created_generation', v_fenced_generation::text,
      'hold_reason', v_reason,
      'retry_effect_envelope_id', v_hold_envelope_id,
      'retry_effect_envelope_sha256', v_hold_envelope_hash,
      'effect_receipt_id', v_hold_receipt_id,
      'effect_receipt_sha256', v_hold_receipt_hash,
      'effect_closure_disposition', CASE
        WHEN v_reason = 'EFFECT_CLOSURE_OPEN' THEN 'OPEN'
        WHEN v_reason = 'EFFECT_CLOSURE_UNKNOWN' THEN 'UNKNOWN'
        ELSE NULL
      END,
      'effect_closure_sha256', CASE
        WHEN v_reason IN ('EFFECT_CLOSURE_OPEN', 'EFFECT_CLOSURE_UNKNOWN')
          THEN v_closure_hash
        ELSE NULL
      END,
      'checkpoint_id', v_checkpoint_id,
      'checkpoint_sha256', v_checkpoint_hash,
      'created_at', v_now
    ));
    v_hold_hash := app.g007_sha256(
      'better-agent/run-recovery-hold-evidence/1',
      v_hold_contract::text
    );
    v_hold_contract := v_hold_contract || jsonb_build_object(
      'hold_evidence_sha256', v_hold_hash
    );
    UPDATE public.run_attempts
    SET status = 'RELINQUISHED', lease_generation = v_fenced_generation,
        lease_owner = NULL, lease_token = NULL,
        lease_fencing_token = NULL, lease_expires_at = NULL,
        recovery_ticket_id = NULL, finished_at = v_now,
        updated_at = v_now
    WHERE workspace_id = v_workspace_id AND id = v_attempt.id;
    INSERT INTO public.run_recovery_hold_intents (
      workspace_id, id, run_id, resource_kind, resource_id,
      old_generation, fenced_generation, hold_reason,
      retry_effect_envelope_id, retry_effect_envelope_sha256,
      effect_receipt_id, effect_receipt_sha256,
      effect_closure_disposition, effect_closure_sha256,
      hold_evidence_sha256, checkpoint_id, checkpoint_sha256, created_at
    ) VALUES (
      v_workspace_id, v_hold_id, v_run.id, 'ATTEMPT', v_attempt.id,
      v_attempt.lease_generation, v_fenced_generation, v_reason,
      v_hold_envelope_id, v_hold_envelope_hash,
      v_hold_receipt_id, v_hold_receipt_hash,
      CASE
        WHEN v_reason = 'EFFECT_CLOSURE_OPEN' THEN 'OPEN'
        WHEN v_reason = 'EFFECT_CLOSURE_UNKNOWN' THEN 'UNKNOWN'
        ELSE NULL
      END,
      CASE
        WHEN v_reason IN ('EFFECT_CLOSURE_OPEN', 'EFFECT_CLOSURE_UNKNOWN')
          THEN v_closure_hash
        ELSE NULL
      END,
      v_hold_hash, v_checkpoint_id, v_checkpoint_hash, v_now
    );
    RETURN jsonb_build_object(
      'disposition', 'HOLD',
      'hold_intent', v_hold_contract
    );
  END IF;

  SELECT intent.* INTO v_termination
  FROM public.run_termination_intents AS intent
  WHERE intent.workspace_id = v_workspace_id
    AND intent.run_id = v_run.id
    AND intent.attempt_id = v_attempt.id
    AND intent.consumed_at IS NULL
  FOR UPDATE;
  IF FOUND THEN
    IF v_closure_disposition <> 'CLOSED'
       OR v_termination.effect_closure_sha256 IS DISTINCT FROM v_closure_hash THEN
      RAISE EXCEPTION 'termination intent does not bind the recomputed CLOSED effect closure'
        USING ERRCODE = '42501';
    END IF;
    UPDATE public.run_attempts
    SET status = 'RELINQUISHED', lease_generation = v_fenced_generation,
        lease_owner = NULL, lease_token = NULL,
        lease_fencing_token = NULL, lease_expires_at = NULL,
        recovery_ticket_id = NULL, finished_at = v_now,
        updated_at = v_now
    WHERE workspace_id = v_workspace_id AND id = v_attempt.id;
    RETURN jsonb_build_object(
      'run_id', v_run.id, 'attempt_id', v_attempt.id,
      'disposition', 'TERMINATION_INTENT_PRESERVED',
      'fenced_generation', v_fenced_generation::text,
      'effect_closure_sha256', v_closure_hash
    );
  END IF;

  IF v_closure_disposition <> 'CLOSED' THEN
    RAISE EXCEPTION 'non-CLOSED effect closure cannot create a recovery ticket'
      USING ERRCODE = '55000';
  END IF;
  v_effect_decisions := app.g007_attempt_recovery_effect_decisions(
    v_workspace_id, v_run.id, v_attempt.id
  );
  IF v_effect_decisions IS NULL OR jsonb_array_length(v_effect_decisions) = 0 THEN
    RAISE EXCEPTION 'Attempt recovery ticket requires durable effect decisions'
      USING ERRCODE = '55000';
  END IF;
  v_effect_decisions_hash := app.g007_sha256(
    'better-agent/run-recovery-effect-decision-set/1',
    jsonb_build_object(
      'schema_version', 'run-recovery-effect-decision-set/1',
      'effect_decisions', v_effect_decisions
    )::text
  );
  v_ticket_id := gen_random_uuid();
  v_ticket_contract := jsonb_strip_nulls(jsonb_build_object(
    'schema_version', 'run-recovery-ticket/1',
    'recovery_ticket_id', v_ticket_id,
    'workspace_id', v_workspace_id,
    'run_id', v_run.id,
    'resource_kind', 'ATTEMPT',
    'resource_id', v_attempt.id,
    'old_fencing_token', v_attempt.lease_generation::text,
    'new_fencing_token', v_fenced_generation::text,
    'created_generation', v_fenced_generation::text,
    'checkpoint_id', v_checkpoint_id,
    'checkpoint_sha256', v_checkpoint_hash,
    'effect_decisions', v_effect_decisions,
    'effect_decisions_sha256', v_effect_decisions_hash,
    'created_at', v_now
  ));
  v_ticket_hash := app.g007_sha256(
    'better-agent/run-recovery-ticket/1',
    v_ticket_contract::text
  );
  INSERT INTO public.run_recovery_tickets (
    workspace_id, id, run_id, resource_kind, resource_id, old_generation,
    fenced_generation, checkpoint_id, checkpoint_sha256,
    effect_decisions, effect_decisions_sha256, ticket_sha256, created_at
  ) VALUES (
    v_workspace_id, v_ticket_id, v_run.id, 'ATTEMPT', v_attempt.id,
    v_attempt.lease_generation, v_fenced_generation,
    v_checkpoint_id, v_checkpoint_hash,
    v_effect_decisions, v_effect_decisions_hash, v_ticket_hash, v_now
  );
  UPDATE public.run_attempts
  SET status = 'PENDING', lease_generation = v_fenced_generation,
      lease_owner = NULL, lease_token = NULL,
      lease_fencing_token = NULL, lease_expires_at = NULL,
      recovery_ticket_id = v_ticket_id, finished_at = NULL,
      updated_at = v_now
  WHERE workspace_id = v_workspace_id AND id = v_attempt.id;
  RETURN jsonb_build_object(
    'disposition', 'RECOVERY_PENDING',
    'recovery_ticket', v_ticket_contract,
    'recovery_ticket_sha256', v_ticket_hash
  );
END;
$function$;
ALTER FUNCTION app.fence_expired_run_attempt(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.fence_expired_run_attempt(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fence_expired_run_attempt(jsonb) TO ba_reclaimer_executor;

CREATE FUNCTION app.record_recovery_hold_intent(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := app.fence_expired_run_attempt(p_fact);
  IF v_result ->> 'disposition' <> 'HOLD' THEN
    RAISE EXCEPTION 'expired Attempt is replayable and cannot produce a recovery HOLD'
      USING ERRCODE = '55000';
  END IF;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION app.record_recovery_hold_intent(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_recovery_hold_intent(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_recovery_hold_intent(jsonb) TO ba_reclaimer_executor;

CREATE FUNCTION app.fence_expired_run_dispatch(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('reclaimer');
  v_run public.runs%ROWTYPE;
  v_message public.outbox%ROWTYPE;
  v_now timestamptz;
  v_fenced_generation bigint;
  v_ticket_id uuid := gen_random_uuid();
  v_ticket_hash text;
  v_effect_decisions jsonb;
  v_effect_decisions_hash text;
  v_ticket_contract jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact ->> 'lease_token') IS NULL
     OR (p_fact ->> 'lease_fencing_token') !~ '^[1-9][0-9]{0,15}$' THEN
    RAISE EXCEPTION 'invalid expired RUN_DISPATCH fence request'
      USING ERRCODE = '22023';
  END IF;
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
     OR v_run.terminal_intent_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Run is unavailable for RUN_DISPATCH recovery fencing'
      USING ERRCODE = '55000';
  END IF;
  SELECT message.* INTO v_message
  FROM public.outbox AS message
  WHERE message.workspace_id = v_workspace_id
    AND message.id = (p_fact ->> 'outbox_id')::uuid
    AND message.run_id = v_run.id
  FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND
     OR v_message.message_type <> 'RUN_DISPATCH'
     OR v_message.delivery_protocol_version <> 5
     OR v_message.status <> 'LEASED'
     OR v_message.lease_token IS DISTINCT FROM (p_fact ->> 'lease_token')::uuid
     OR v_message.lease_fencing_token IS DISTINCT FROM
       (p_fact ->> 'lease_fencing_token')::bigint
     OR v_message.delivery_generation IS DISTINCT FROM
       (p_fact ->> 'lease_fencing_token')::bigint
     OR v_message.lease_expires_at > v_now THEN
    RAISE EXCEPTION 'RUN_DISPATCH lease is missing, stale or not expired'
      USING ERRCODE = '42501';
  END IF;
  IF v_message.delivery_generation >= 9007199254740991 THEN
    RAISE EXCEPTION 'RUN_DISPATCH recovery fence exceeds the protocol-v5 limit'
      USING ERRCODE = '22003';
  END IF;
  v_fenced_generation := v_message.delivery_generation + 1;
  v_effect_decisions := jsonb_build_array(jsonb_build_object(
    'retry_effect_envelope_id', v_message.id,
    'retry_effect_envelope_sha256', v_message.payload_hash,
    'effect_class', 'SAFE',
    'recovery_decision', 'REPLAY_SAFE'
  ));
  v_effect_decisions_hash := app.g007_sha256(
    'better-agent/run-recovery-effect-decision-set/1',
    jsonb_build_object(
      'schema_version', 'run-recovery-effect-decision-set/1',
      'effect_decisions', v_effect_decisions
    )::text
  );
  v_ticket_contract := jsonb_build_object(
    'schema_version', 'run-recovery-ticket/1',
    'recovery_ticket_id', v_ticket_id,
    'workspace_id', v_workspace_id,
    'run_id', v_run.id,
    'resource_kind', 'RUN_DISPATCH',
    'resource_id', v_message.id,
    'old_fencing_token', v_message.delivery_generation::text,
    'new_fencing_token', v_fenced_generation::text,
    'created_generation', v_fenced_generation::text,
    'effect_decisions', v_effect_decisions,
    'effect_decisions_sha256', v_effect_decisions_hash,
    'created_at', v_now
  );
  v_ticket_hash := app.g007_sha256(
    'better-agent/run-recovery-ticket/1',
    v_ticket_contract::text
  );
  INSERT INTO public.run_recovery_tickets (
    workspace_id, id, run_id, resource_kind, resource_id, old_generation,
    fenced_generation, checkpoint_id, checkpoint_sha256,
    effect_decisions, effect_decisions_sha256, ticket_sha256, created_at
  ) VALUES (
    v_workspace_id, v_ticket_id, v_run.id, 'RUN_DISPATCH', v_message.id,
    v_message.delivery_generation, v_fenced_generation, NULL, NULL,
    v_effect_decisions, v_effect_decisions_hash, v_ticket_hash, v_now
  );
  UPDATE public.outbox
  SET status = 'PENDING', delivery_generation = v_fenced_generation,
      recovery_ticket_id = v_ticket_id,
      lease_owner = NULL, lease_token = NULL,
      lease_fencing_token = NULL, lease_expires_at = NULL,
      available_at = v_now,
      last_error_redacted = 'RUN_DISPATCH_LEASE_EXPIRED'
  WHERE workspace_id = v_workspace_id AND id = v_message.id;
  RETURN jsonb_build_object(
    'disposition', 'RECOVERY_PENDING',
    'recovery_ticket', v_ticket_contract,
    'recovery_ticket_sha256', v_ticket_hash
  );
END;
$function$;
ALTER FUNCTION app.fence_expired_run_dispatch(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.fence_expired_run_dispatch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fence_expired_run_dispatch(jsonb) TO ba_reclaimer_executor;

CREATE FUNCTION app.retire_run_attempts_for_finalizer(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_source_kind text := p_fact ->> 'source_kind';
  v_source_id uuid := (p_fact ->> 'source_id')::uuid;
  v_source_sha256 text := p_fact ->> 'source_sha256';
  v_terminal_sha256 text := p_fact ->> 'terminal_intent_sha256';
  v_target_status text := p_fact ->> 'attempt_status';
  v_attempt public.run_attempts%ROWTYPE;
  v_ticket public.run_recovery_tickets%ROWTYPE;
  v_existing public.run_recovery_ticket_dispositions%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_retired bigint := 0;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_source_kind NOT IN ('TERMINATION_ATTRIBUTION', 'DURABLE_CANCEL', 'RECOVERY_HOLD')
     OR v_source_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR v_terminal_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR NOT (
       (v_source_kind = 'RECOVERY_HOLD' AND v_target_status = 'RELINQUISHED')
       OR (v_source_kind = 'DURABLE_CANCEL' AND v_target_status = 'CANCELLED')
       OR (
         v_source_kind = 'TERMINATION_ATTRIBUTION'
         AND v_target_status IN ('CANCELLED', 'FAILED')
       )
     ) THEN
    RAISE EXCEPTION 'invalid terminal Attempt retirement request'
      USING ERRCODE = '22023';
  END IF;
  FOR v_attempt IN
    SELECT attempt.*
    FROM public.run_attempts AS attempt
    WHERE attempt.workspace_id = v_workspace_id
      AND attempt.run_id = v_run_id
    ORDER BY attempt.id
    FOR UPDATE
  LOOP
    IF v_attempt.recovery_ticket_id IS NOT NULL THEN
      SELECT ticket.* INTO v_ticket
      FROM public.run_recovery_tickets AS ticket
      WHERE ticket.workspace_id = v_workspace_id
        AND ticket.id = v_attempt.recovery_ticket_id
      FOR UPDATE;
      IF FOUND THEN
        SELECT disposition.* INTO v_existing
        FROM public.run_recovery_ticket_dispositions AS disposition
        WHERE disposition.workspace_id = v_workspace_id
          AND disposition.recovery_ticket_id = v_ticket.id
        FOR UPDATE;
        IF FOUND AND v_existing.disposition_kind = 'TERMINAL_RETIRED' THEN
          IF v_existing.recovery_ticket_sha256 IS DISTINCT FROM v_ticket.ticket_sha256
             OR v_existing.ticket_fencing_token IS DISTINCT FROM v_ticket.fenced_generation
             OR v_existing.terminal_source_kind IS DISTINCT FROM v_source_kind
             OR v_existing.terminal_source_id IS DISTINCT FROM v_source_id
             OR v_existing.terminal_source_sha256 IS DISTINCT FROM v_source_sha256
             OR v_existing.terminal_intent_sha256 IS DISTINCT FROM v_terminal_sha256
             OR v_existing.terminal_resource_status IS DISTINCT FROM v_target_status
             OR v_attempt.status IS DISTINCT FROM v_target_status
             OR v_attempt.finished_at IS DISTINCT FROM v_existing.disposed_at
             OR v_attempt.updated_at IS DISTINCT FROM v_existing.disposed_at THEN
            RAISE EXCEPTION 'Attempt recovery ticket has a conflicting terminal disposition'
              USING ERRCODE = '23505';
          END IF;
        ELSIF NOT FOUND THEN
          INSERT INTO public.run_recovery_ticket_dispositions (
            workspace_id, id, recovery_ticket_id, recovery_ticket_sha256,
            run_id, resource_kind, resource_id, ticket_fencing_token,
            disposition_kind, terminal_source_kind, terminal_source_id,
            terminal_source_sha256, terminal_intent_sha256,
            terminal_resource_status, disposed_at
          ) VALUES (
            v_workspace_id, gen_random_uuid(), v_ticket.id, v_ticket.ticket_sha256,
            v_run_id, 'ATTEMPT', v_attempt.id, v_ticket.fenced_generation,
            'TERMINAL_RETIRED', v_source_kind, v_source_id,
            v_source_sha256, v_terminal_sha256, v_target_status, v_now
          );
        END IF;
      END IF;
    END IF;
    IF v_attempt.status IN ('PENDING', 'RUNNING') THEN
      UPDATE public.run_attempts
      SET status = v_target_status,
          lease_owner = NULL, lease_token = NULL,
          lease_fencing_token = NULL, lease_expires_at = NULL,
          recovery_ticket_id = NULL,
          finished_at = v_now,
          updated_at = v_now
      WHERE workspace_id = v_workspace_id AND id = v_attempt.id;
      v_retired := v_retired + 1;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM public.run_attempts AS attempt
    WHERE attempt.workspace_id = v_workspace_id
      AND attempt.run_id = v_run_id
      AND (attempt.status IN ('PENDING', 'RUNNING')
        OR attempt.lease_owner IS NOT NULL
        OR attempt.lease_token IS NOT NULL
        OR attempt.lease_expires_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'terminal Attempt retirement left executable authority'
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('run_id', v_run_id, 'retired_attempts', v_retired);
END;
$function$;
ALTER FUNCTION app.retire_run_attempts_for_finalizer(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.retire_run_attempts_for_finalizer(jsonb) FROM PUBLIC;

CREATE FUNCTION app.retire_run_dispatches_for_finalizer(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_source_kind text := p_fact ->> 'source_kind';
  v_source_id uuid := (p_fact ->> 'source_id')::uuid;
  v_source_sha256 text := p_fact ->> 'source_sha256';
  v_terminal_sha256 text := p_fact ->> 'terminal_intent_sha256';
  v_message public.outbox%ROWTYPE;
  v_ticket public.run_recovery_tickets%ROWTYPE;
  v_existing_disposition public.run_recovery_ticket_dispositions%ROWTYPE;
  v_existing_receipt public.run_dispatch_retirement_receipts%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_new_generation bigint;
  v_receipt_id uuid;
  v_receipt_hash text;
  v_receipt_contract jsonb;
  v_retired bigint := 0;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_source_kind NOT IN ('TERMINATION_ATTRIBUTION', 'DURABLE_CANCEL', 'RECOVERY_HOLD')
     OR v_source_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR v_terminal_sha256 !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid terminal RUN_DISPATCH retirement request'
      USING ERRCODE = '22023';
  END IF;
  FOR v_message IN
    SELECT message.*
    FROM public.outbox AS message
    WHERE message.workspace_id = v_workspace_id
      AND message.run_id = v_run_id
      AND message.message_type = 'RUN_DISPATCH'
    ORDER BY message.id
    FOR UPDATE
  LOOP
    IF v_message.status = 'DELIVERED' THEN
      CONTINUE;
    END IF;
    IF v_message.status = 'DEAD' THEN
      IF v_message.delivery_failure_evidence_sha256 IS NOT NULL THEN
        IF v_message.delivery_failure_evidence_sha256 !~ '^sha256:[0-9a-f]{64}$'
           OR length(btrim(v_message.last_error_redacted, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) = 0 THEN
          RAISE EXCEPTION 'DEAD RUN_DISPATCH has invalid delivery-failure evidence'
            USING ERRCODE = '55000';
        END IF;
        CONTINUE;
      END IF;
      SELECT receipt.* INTO v_existing_receipt
      FROM public.run_dispatch_retirement_receipts AS receipt
      WHERE receipt.workspace_id = v_workspace_id
        AND receipt.outbox_id = v_message.id;
      IF NOT FOUND
         OR v_existing_receipt.terminal_source_kind IS DISTINCT FROM v_source_kind
         OR v_existing_receipt.terminal_source_id IS DISTINCT FROM v_source_id
         OR v_existing_receipt.terminal_source_sha256 IS DISTINCT FROM v_source_sha256
         OR v_existing_receipt.terminal_intent_sha256 IS DISTINCT FROM v_terminal_sha256
         OR v_existing_receipt.new_delivery_generation IS DISTINCT FROM
           v_message.delivery_generation THEN
        RAISE EXCEPTION 'DEAD RUN_DISPATCH lacks durable failure or retirement evidence'
          USING ERRCODE = '55000';
      END IF;
      CONTINUE;
    END IF;
    IF v_message.status NOT IN ('PENDING', 'LEASED') THEN
      RAISE EXCEPTION 'RUN_DISPATCH status is not terminal-retirable'
        USING ERRCODE = '55000';
    END IF;
    v_new_generation := v_message.delivery_generation
      + CASE WHEN v_message.status = 'LEASED' THEN 1 ELSE 0 END;
    IF v_new_generation > 9007199254740991 THEN
      RAISE EXCEPTION 'terminal RUN_DISPATCH fence exceeds protocol-v5 limit'
        USING ERRCODE = '22003';
    END IF;

    IF v_message.recovery_ticket_id IS NOT NULL THEN
      SELECT ticket.* INTO v_ticket
      FROM public.run_recovery_tickets AS ticket
      WHERE ticket.workspace_id = v_workspace_id
        AND ticket.id = v_message.recovery_ticket_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RUN_DISPATCH recovery ticket is missing during terminal retirement'
          USING ERRCODE = '23503';
      END IF;
      SELECT disposition.* INTO v_existing_disposition
      FROM public.run_recovery_ticket_dispositions AS disposition
      WHERE disposition.workspace_id = v_workspace_id
        AND disposition.recovery_ticket_id = v_ticket.id
      FOR UPDATE;
      IF FOUND THEN
        IF v_existing_disposition.disposition_kind <> 'TERMINAL_RETIRED'
           OR v_existing_disposition.recovery_ticket_sha256 IS DISTINCT FROM
             v_ticket.ticket_sha256
           OR v_existing_disposition.ticket_fencing_token IS DISTINCT FROM
             v_ticket.fenced_generation
           OR v_existing_disposition.terminal_source_kind IS DISTINCT FROM v_source_kind
           OR v_existing_disposition.terminal_source_id IS DISTINCT FROM v_source_id
           OR v_existing_disposition.terminal_source_sha256 IS DISTINCT FROM v_source_sha256
           OR v_existing_disposition.terminal_intent_sha256 IS DISTINCT FROM v_terminal_sha256
           OR v_existing_disposition.terminal_resource_status <> 'DEAD' THEN
          RAISE EXCEPTION 'RUN_DISPATCH recovery ticket has a conflicting disposition'
            USING ERRCODE = '23505';
        END IF;
      ELSE
        INSERT INTO public.run_recovery_ticket_dispositions (
          workspace_id, id, recovery_ticket_id, recovery_ticket_sha256,
          run_id, resource_kind, resource_id, ticket_fencing_token,
          disposition_kind, terminal_source_kind, terminal_source_id,
          terminal_source_sha256, terminal_intent_sha256,
          terminal_resource_status, disposed_at
        ) VALUES (
          v_workspace_id, gen_random_uuid(), v_ticket.id, v_ticket.ticket_sha256,
          v_run_id, 'RUN_DISPATCH', v_message.id, v_ticket.fenced_generation,
          'TERMINAL_RETIRED', v_source_kind, v_source_id,
          v_source_sha256, v_terminal_sha256, 'DEAD', v_now
        );
      END IF;
    END IF;
    v_receipt_id := gen_random_uuid();
    v_receipt_contract := jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 'run-dispatch-retirement-receipt/1',
      'retirement_receipt_id', v_receipt_id,
      'workspace_id', v_workspace_id,
      'run_id', v_run_id,
      'outbox_id', v_message.id,
      'old_status', v_message.status,
      'old_lease_owner', CASE WHEN v_message.status = 'LEASED' THEN v_message.lease_owner END,
      'old_lease_token', CASE WHEN v_message.status = 'LEASED' THEN v_message.lease_token END,
      'old_lease_fencing_token', CASE
        WHEN v_message.status = 'LEASED' THEN v_message.lease_fencing_token::text END,
      'old_lease_expires_at', CASE
        WHEN v_message.status = 'LEASED' THEN v_message.lease_expires_at END,
      'old_delivery_generation', v_message.delivery_generation::text,
      'new_delivery_generation', v_new_generation::text,
      'retired_status', 'DEAD',
      'last_error_code', 'RUN_TERMINATED_BEFORE_DISPATCH',
      'terminal_source_kind', v_source_kind,
      'terminal_source_id', v_source_id,
      'terminal_source_sha256', v_source_sha256,
      'terminal_intent_sha256', v_terminal_sha256,
      'retired_at', v_now
    ));
    v_receipt_hash := app.g007_sha256(
      'better-agent/run-dispatch-retirement-receipt/1',
      v_receipt_contract::text
    );
    UPDATE public.outbox
    SET status = 'DEAD', delivery_protocol_version = 5,
        delivery_generation = v_new_generation,
        lease_owner = NULL, lease_token = NULL,
        lease_fencing_token = NULL, lease_expires_at = NULL,
        delivered_at = NULL,
        last_error_redacted = 'RUN_TERMINATED_BEFORE_DISPATCH',
        delivery_failure_evidence_sha256 = NULL
    WHERE workspace_id = v_workspace_id AND id = v_message.id;
    INSERT INTO public.run_dispatch_retirement_receipts (
      workspace_id, id, run_id, outbox_id, old_status,
      old_lease_owner, old_lease_token, old_lease_fencing_token,
      old_lease_expires_at,
      old_delivery_generation, new_delivery_generation,
      retired_status, last_error_code,
      terminal_source_kind, terminal_source_id, terminal_source_sha256,
      terminal_intent_sha256,
      receipt_sha256, retired_at
    ) VALUES (
      v_workspace_id, v_receipt_id, v_run_id, v_message.id, v_message.status,
      CASE WHEN v_message.status = 'LEASED' THEN v_message.lease_owner END,
      CASE WHEN v_message.status = 'LEASED' THEN v_message.lease_token END,
      CASE WHEN v_message.status = 'LEASED' THEN v_message.lease_fencing_token END,
      CASE WHEN v_message.status = 'LEASED' THEN v_message.lease_expires_at END,
      v_message.delivery_generation, v_new_generation,
      'DEAD', 'RUN_TERMINATED_BEFORE_DISPATCH', v_source_kind,
      v_source_id, v_source_sha256, v_terminal_sha256, v_receipt_hash, v_now
    );
    v_retired := v_retired + 1;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.outbox AS message
    WHERE message.workspace_id = v_workspace_id
      AND message.run_id = v_run_id
      AND message.message_type = 'RUN_DISPATCH'
      AND message.status IN ('PENDING', 'LEASED')
  ) THEN
    RAISE EXCEPTION 'terminal RUN_DISPATCH retirement is incomplete'
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('run_id', v_run_id, 'retired_dispatches', v_retired);
END;
$function$;
ALTER FUNCTION app.retire_run_dispatches_for_finalizer(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.retire_run_dispatches_for_finalizer(jsonb) FROM PUBLIC;

CREATE FUNCTION app.apply_credit_settlement_kernel(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_reservation_id uuid := (p_fact ->> 'reservation_id')::uuid;
  v_authority_id uuid := (p_fact ->> 'authority_id')::uuid;
  v_ledger_id uuid := (p_fact ->> 'ledger_entry_id')::uuid;
  v_amount bigint := (p_fact ->> 'amount')::bigint;
  v_existing public.run_billing_authority_receipts%ROWTYPE;
  v_reservation public.credit_reservations%ROWTYPE;
  v_balance bigint;
  v_reserved bigint;
  v_version bigint;
  v_next_version bigint;
  v_receipt_hash text;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ->> 'authority_kind' <> 'EXECUTION_USAGE'
     OR p_fact ->> 'operation' <> 'SETTLE'
     OR v_amount < 0
     OR (p_fact ->> 'source_authority_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'source_consumption_generation') !~ '^[1-9][0-9]{0,15}$'
     OR (p_fact ->> 'charge_attribution_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'billing_intent_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR length(p_fact ->> 'charge_key') NOT BETWEEN 1 AND 300
     OR length(btrim(p_fact ->> 'charge_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 300
     OR jsonb_typeof(COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb)) <> 'object'
     OR NOT app.g007_json_numbers_are_finite(
          COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb)
        )
     OR (p_fact ->> 'authorized_at')::timestamptz IS NULL THEN
    RAISE EXCEPTION 'invalid attributed settlement kernel input'
      USING ERRCODE = '22023';
  END IF;

  SELECT receipt.* INTO v_existing
  FROM public.run_billing_authority_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.authority_kind = 'EXECUTION_USAGE'
    AND receipt.source_id = (p_fact ->> 'source_id')::uuid;
  IF FOUND THEN
    IF v_existing.source_authority_hash IS DISTINCT FROM p_fact ->> 'source_authority_hash'
       OR v_existing.source_consumption_generation IS DISTINCT FROM
            (p_fact ->> 'source_consumption_generation')::bigint
       OR v_existing.operation <> 'SETTLE'
       OR v_existing.amount <> v_amount
       OR v_existing.run_id <> v_run_id
       OR v_existing.reservation_id <> v_reservation_id
       OR v_existing.billing_intent_hash <> p_fact ->> 'billing_intent_hash'
       OR v_existing.charge_attribution_hash <> p_fact ->> 'charge_attribution_hash' THEN
      RAISE EXCEPTION 'usage authority was reused with a different financial intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.ledger_entry_id;
  END IF;

  SELECT workspace_row.credits_balance,
         workspace_row.credits_reserved_balance,
         workspace_row.credits_balance_version
  INTO v_balance, v_reserved, v_version
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = v_workspace_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for attributed settlement'
      USING ERRCODE = '23503';
  END IF;
  SELECT receipt.* INTO v_existing
  FROM public.run_billing_authority_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.authority_kind = 'EXECUTION_USAGE'
    AND receipt.source_id = (p_fact ->> 'source_id')::uuid;
  IF FOUND THEN
    IF v_existing.source_authority_hash IS DISTINCT FROM p_fact ->> 'source_authority_hash'
       OR v_existing.source_consumption_generation IS DISTINCT FROM
            (p_fact ->> 'source_consumption_generation')::bigint
       OR v_existing.operation <> 'SETTLE'
       OR v_existing.amount <> v_amount
       OR v_existing.run_id <> v_run_id
       OR v_existing.reservation_id <> v_reservation_id
       OR v_existing.billing_intent_hash <> p_fact ->> 'billing_intent_hash'
       OR v_existing.charge_attribution_hash <> p_fact ->> 'charge_attribution_hash' THEN
      RAISE EXCEPTION 'usage authority was reused with a different financial intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.ledger_entry_id;
  END IF;
  IF v_amount <> 0 AND v_version >= 9007199254740991 THEN
    RAISE EXCEPTION 'Workspace credit balance version cannot advance safely'
      USING ERRCODE = '22003';
  END IF;
  SELECT reservation.* INTO v_reservation
  FROM public.credit_reservations AS reservation
  WHERE reservation.workspace_id = v_workspace_id
    AND reservation.id = v_reservation_id
    AND reservation.run_id = v_run_id
    AND reservation.billing_owner_run_id = v_run_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_reservation.status <> 'HELD'
     OR v_reservation.reserved_credits - v_reservation.settled_credits
       - v_reservation.released_credits < v_amount
     OR v_reserved < v_amount
     OR (p_fact ->> 'authorized_at')::timestamptz < v_reservation.updated_at THEN
    RAISE EXCEPTION 'reservation cannot settle attributed credits'
      USING ERRCODE = '23514';
  END IF;
  v_next_version := v_version + CASE WHEN v_amount = 0 THEN 0 ELSE 1 END;
  UPDATE public.workspaces
  SET credits_reserved_balance = v_reserved - v_amount,
      credits_balance_version = v_next_version
  WHERE id = v_workspace_id;
  UPDATE public.credit_reservations
  SET settled_credits = settled_credits + v_amount,
      status = CASE
        WHEN settled_credits + released_credits + v_amount = reserved_credits
          THEN 'SETTLED' ELSE 'HELD' END,
      settled_at = CASE
        WHEN settled_credits + released_credits + v_amount = reserved_credits
          THEN (p_fact ->> 'authorized_at')::timestamptz ELSE NULL END,
      released_at = CASE
        WHEN settled_credits + released_credits + v_amount = reserved_credits
             AND released_credits > 0
          THEN (p_fact ->> 'authorized_at')::timestamptz ELSE released_at END,
      balance_version = v_next_version,
      updated_at = (p_fact ->> 'authorized_at')::timestamptz
  WHERE workspace_id = v_workspace_id AND id = v_reservation_id;

  v_receipt_hash := app.g007_sha256(
    'better-agent/run-billing-authority-receipt/1',
    jsonb_build_object(
      'authority_id', v_authority_id,
      'authority_kind', 'EXECUTION_USAGE',
      'source_id', p_fact ->> 'source_id',
      'source_authority_hash', p_fact ->> 'source_authority_hash',
      'operation', 'SETTLE', 'amount', v_amount,
      'ledger_entry_id', v_ledger_id,
      'billing_intent_hash', p_fact ->> 'billing_intent_hash',
      'charge_attribution_hash', p_fact ->> 'charge_attribution_hash'
    )::text
  );
  INSERT INTO public.run_billing_authority_receipts (
    workspace_id, id, run_id, billing_owner_run_id, reservation_id,
    authority_schema_version, authority_kind, source_id,
    source_authority_hash, source_consumption_generation,
    operation, amount, producer_run_id,
    producer_attempt_id, producer_lease_fencing_token, step_id,
    ledger_entry_id, charge_key, billing_intent_hash,
    charge_attribution_hash, receipt_sha256, authorized_at
  ) VALUES (
    v_workspace_id, v_authority_id, v_run_id, v_run_id, v_reservation_id,
    1, 'EXECUTION_USAGE', (p_fact ->> 'source_id')::uuid,
    p_fact ->> 'source_authority_hash',
    (p_fact ->> 'source_consumption_generation')::bigint, 'SETTLE', v_amount,
    (p_fact ->> 'producer_run_id')::uuid,
    (p_fact ->> 'producer_attempt_id')::uuid,
    (p_fact ->> 'producer_lease_fencing_token')::bigint,
    (p_fact ->> 'step_id')::uuid, v_ledger_id,
    p_fact ->> 'charge_key', p_fact ->> 'billing_intent_hash',
    p_fact ->> 'charge_attribution_hash', v_receipt_hash,
    (p_fact ->> 'authorized_at')::timestamptz
  );
  INSERT INTO public.credits_ledger (
    workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
    producer_attempt_id, producer_lease_fencing_token, step_id,
    reservation_id, entry_kind, available_delta_credits,
    reserved_delta_credits, settled_delta_credits, billing_intent_hash,
    charge_attribution_hash, charge_key, balance_before, reserved_before,
    balance_after, reserved_after, balance_version, metering_detail_redacted,
    created_at, entry_schema_version, authority_schema_version,
    authority_kind, authority_id
  ) VALUES (
    v_workspace_id, v_ledger_id, v_run_id, v_run_id,
    (p_fact ->> 'producer_run_id')::uuid,
    (p_fact ->> 'producer_attempt_id')::uuid,
    (p_fact ->> 'producer_lease_fencing_token')::bigint,
    (p_fact ->> 'step_id')::uuid, v_reservation_id, 'SETTLE',
    0, -v_amount, v_amount, p_fact ->> 'billing_intent_hash',
    p_fact ->> 'charge_attribution_hash', p_fact ->> 'charge_key',
    v_balance, v_reserved, v_balance, v_reserved - v_amount,
    v_next_version, COALESCE(p_fact -> 'detail_redacted', '{}'::jsonb),
    (p_fact ->> 'authorized_at')::timestamptz,
    2, 1, 'EXECUTION_USAGE', v_authority_id
  );
  RETURN v_ledger_id;
END;
$function$;
ALTER FUNCTION app.apply_credit_settlement_kernel(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.apply_credit_settlement_kernel(jsonb) FROM PUBLIC;

CREATE FUNCTION app.apply_credit_release_kernel(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_reservation_id uuid := (p_fact ->> 'reservation_id')::uuid;
  v_authority_id uuid := (p_fact ->> 'authority_id')::uuid;
  v_ledger_id uuid := (p_fact ->> 'ledger_entry_id')::uuid;
  v_authority_kind text := p_fact ->> 'authority_kind';
  v_amount bigint := (p_fact ->> 'amount')::bigint;
  v_existing public.run_billing_authority_receipts%ROWTYPE;
  v_reservation public.credit_reservations%ROWTYPE;
  v_balance bigint;
  v_reserved bigint;
  v_version bigint;
  v_next_version bigint;
  v_terminal boolean;
  v_receipt_hash text;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_authority_kind NOT IN ('EXECUTION_TERMINATION', 'DURABLE_CANCEL')
     OR p_fact ->> 'operation' <> 'RELEASE'
     OR v_amount < 0
     OR (p_fact ->> 'source_authority_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'source_consumption_generation') !~ '^[1-9][0-9]{0,15}$'
     OR (p_fact ->> 'charge_attribution_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'billing_intent_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR length(p_fact ->> 'charge_key') NOT BETWEEN 1 AND 300
     OR length(btrim(p_fact ->> 'charge_key', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 300
     OR length(p_fact ->> 'reason_code') NOT BETWEEN 1 AND 200
     OR length(btrim(p_fact ->> 'reason_code', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) = 0
     OR (p_fact ->> 'authorized_at')::timestamptz IS NULL THEN
    RAISE EXCEPTION 'invalid attributed release kernel input'
      USING ERRCODE = '22023';
  END IF;
  SELECT receipt.* INTO v_existing
  FROM public.run_billing_authority_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.authority_kind = v_authority_kind
    AND receipt.source_id = (p_fact ->> 'source_id')::uuid;
  IF FOUND THEN
    IF v_existing.source_authority_hash IS DISTINCT FROM p_fact ->> 'source_authority_hash'
       OR v_existing.source_consumption_generation IS DISTINCT FROM
            (p_fact ->> 'source_consumption_generation')::bigint
       OR v_existing.operation <> 'RELEASE'
       OR v_existing.amount <> v_amount
       OR v_existing.run_id <> v_run_id
       OR v_existing.reservation_id <> v_reservation_id
       OR v_existing.billing_intent_hash <> p_fact ->> 'billing_intent_hash'
       OR v_existing.charge_attribution_hash <> p_fact ->> 'charge_attribution_hash' THEN
      RAISE EXCEPTION 'release authority was reused with a different financial intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.ledger_entry_id;
  END IF;
  SELECT workspace_row.credits_balance,
         workspace_row.credits_reserved_balance,
         workspace_row.credits_balance_version
  INTO v_balance, v_reserved, v_version
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = v_workspace_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for attributed release'
      USING ERRCODE = '23503';
  END IF;
  SELECT receipt.* INTO v_existing
  FROM public.run_billing_authority_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.authority_kind = v_authority_kind
    AND receipt.source_id = (p_fact ->> 'source_id')::uuid;
  IF FOUND THEN
    IF v_existing.source_authority_hash IS DISTINCT FROM p_fact ->> 'source_authority_hash'
       OR v_existing.source_consumption_generation IS DISTINCT FROM
            (p_fact ->> 'source_consumption_generation')::bigint
       OR v_existing.operation <> 'RELEASE'
       OR v_existing.amount <> v_amount
       OR v_existing.run_id <> v_run_id
       OR v_existing.reservation_id <> v_reservation_id
       OR v_existing.billing_intent_hash <> p_fact ->> 'billing_intent_hash'
       OR v_existing.charge_attribution_hash <> p_fact ->> 'charge_attribution_hash' THEN
      RAISE EXCEPTION 'release authority was reused with a different financial intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.ledger_entry_id;
  END IF;
  IF v_amount <> 0 AND v_version >= 9007199254740991 THEN
    RAISE EXCEPTION 'Workspace credit balance version cannot advance safely'
      USING ERRCODE = '22003';
  END IF;
  SELECT reservation.* INTO v_reservation
  FROM public.credit_reservations AS reservation
  WHERE reservation.workspace_id = v_workspace_id
    AND reservation.id = v_reservation_id
    AND reservation.run_id = v_run_id
    AND reservation.billing_owner_run_id = v_run_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_reservation.status <> 'HELD'
     OR v_reservation.reserved_credits - v_reservation.settled_credits
       - v_reservation.released_credits <> v_amount
     OR v_reserved < v_amount
     OR (p_fact ->> 'authorized_at')::timestamptz < v_reservation.updated_at THEN
    RAISE EXCEPTION 'reservation cannot release the exact attributed remainder'
      USING ERRCODE = '23514';
  END IF;
  v_terminal := v_reservation.settled_credits
    + v_reservation.released_credits + v_amount = v_reservation.reserved_credits;
  v_next_version := v_version + CASE WHEN v_amount = 0 THEN 0 ELSE 1 END;
  UPDATE public.workspaces
  SET credits_balance = v_balance + v_amount,
      credits_reserved_balance = v_reserved - v_amount,
      credits_balance_version = v_next_version
  WHERE id = v_workspace_id;
  UPDATE public.credit_reservations
  SET released_credits = released_credits + v_amount,
      status = CASE
        WHEN v_terminal AND settled_credits > 0 THEN 'SETTLED'
        WHEN v_terminal THEN 'RELEASED' ELSE 'HELD' END,
      settled_at = CASE
        WHEN v_terminal AND settled_credits > 0
          THEN (p_fact ->> 'authorized_at')::timestamptz ELSE NULL END,
      released_at = CASE
        WHEN v_terminal THEN (p_fact ->> 'authorized_at')::timestamptz
        ELSE NULL END,
      status_reason_code = p_fact ->> 'reason_code',
      balance_version = v_next_version,
      updated_at = (p_fact ->> 'authorized_at')::timestamptz
  WHERE workspace_id = v_workspace_id AND id = v_reservation_id;
  v_receipt_hash := app.g007_sha256(
    'better-agent/run-billing-authority-receipt/1',
    jsonb_build_object(
      'authority_id', v_authority_id, 'authority_kind', v_authority_kind,
      'source_id', p_fact ->> 'source_id',
      'source_authority_hash', p_fact ->> 'source_authority_hash',
      'operation', 'RELEASE', 'amount', v_amount,
      'ledger_entry_id', v_ledger_id,
      'billing_intent_hash', p_fact ->> 'billing_intent_hash',
      'charge_attribution_hash', p_fact ->> 'charge_attribution_hash'
    )::text
  );
  INSERT INTO public.run_billing_authority_receipts (
    workspace_id, id, run_id, billing_owner_run_id, reservation_id,
    authority_schema_version, authority_kind, source_id,
    source_authority_hash, source_consumption_generation,
    operation, amount, producer_run_id,
    producer_attempt_id, producer_lease_fencing_token, step_id,
    ledger_entry_id, charge_key, billing_intent_hash,
    charge_attribution_hash, receipt_sha256, authorized_at
  ) VALUES (
    v_workspace_id, v_authority_id, v_run_id, v_run_id, v_reservation_id,
    1, v_authority_kind, (p_fact ->> 'source_id')::uuid,
    p_fact ->> 'source_authority_hash',
    (p_fact ->> 'source_consumption_generation')::bigint, 'RELEASE', v_amount,
    (p_fact ->> 'producer_run_id')::uuid,
    (p_fact ->> 'producer_attempt_id')::uuid,
    (p_fact ->> 'producer_lease_fencing_token')::bigint,
    (p_fact ->> 'step_id')::uuid, v_ledger_id,
    p_fact ->> 'charge_key', p_fact ->> 'billing_intent_hash',
    p_fact ->> 'charge_attribution_hash', v_receipt_hash,
    (p_fact ->> 'authorized_at')::timestamptz
  );
  INSERT INTO public.credits_ledger (
    workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
    producer_attempt_id, producer_lease_fencing_token, step_id,
    reservation_id, entry_kind, available_delta_credits,
    reserved_delta_credits, settled_delta_credits, billing_intent_hash,
    charge_attribution_hash, charge_key, balance_before, reserved_before,
    balance_after, reserved_after, balance_version, metering_detail_redacted,
    created_at, entry_schema_version, authority_schema_version,
    authority_kind, authority_id
  ) VALUES (
    v_workspace_id, v_ledger_id, v_run_id, v_run_id,
    (p_fact ->> 'producer_run_id')::uuid,
    (p_fact ->> 'producer_attempt_id')::uuid,
    (p_fact ->> 'producer_lease_fencing_token')::bigint,
    (p_fact ->> 'step_id')::uuid, v_reservation_id, 'RELEASE',
    v_amount, -v_amount, 0, p_fact ->> 'billing_intent_hash',
    p_fact ->> 'charge_attribution_hash', p_fact ->> 'charge_key',
    v_balance, v_reserved, v_balance + v_amount, v_reserved - v_amount,
    v_next_version, jsonb_build_object('reason_code', p_fact ->> 'reason_code'),
    (p_fact ->> 'authorized_at')::timestamptz,
    2, 1, v_authority_kind, v_authority_id
  );
  RETURN v_ledger_id;
END;
$function$;
ALTER FUNCTION app.apply_credit_release_kernel(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.apply_credit_release_kernel(jsonb) FROM PUBLIC;

CREATE FUNCTION app.lock_open_run_for_attributed_settlement(
  p_workspace_id uuid,
  p_run_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_run public.runs%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL
     OR p_run_id IS NULL
     OR p_workspace_id IS DISTINCT FROM app.current_workspace_id() THEN
    RAISE EXCEPTION 'attributed settlement Run lock requires the current Workspace'
      USING ERRCODE = '42501';
  END IF;

  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = p_workspace_id
    AND run_row.id = p_run_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
     OR v_run.billing_state = 'NEEDS_ATTENTION'
     OR v_run.terminal_intent_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Run cannot accept a new attributed settlement'
      USING ERRCODE = '55000';
  END IF;
END;
$function$;
ALTER FUNCTION app.lock_open_run_for_attributed_settlement(uuid, uuid) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.lock_open_run_for_attributed_settlement(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_open_run_for_attributed_settlement(uuid, uuid) TO ba_billing_owner;

CREATE FUNCTION app.apply_attributed_settlement(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_source jsonb;
  v_authority_id uuid := gen_random_uuid();
  v_ledger_id uuid := gen_random_uuid();
  v_charge_key text;
  v_charge_hash text;
  v_intent_hash text;
  v_billing_intent jsonb;
BEGIN
  v_source := app.require_committed_producer_attribution(
    p_fact || jsonb_build_object('authority_kind', 'EXECUTION_USAGE', 'consume', true)
  );
  IF v_source ->> 'run_id' IS DISTINCT FROM p_fact ->> 'run_id'
     OR (
       p_fact ? 'reservation_id'
       AND v_source ->> 'reservation_id' IS DISTINCT FROM p_fact ->> 'reservation_id'
     ) THEN
    RAISE EXCEPTION 'usage attribution does not bind the requested Run and reservation'
      USING ERRCODE = '42501';
  END IF;
  v_charge_hash := v_source ->> 'source_authority_hash';
  v_charge_key := 'billing-v2/usage_attribution/'
    || (v_source ->> 'usage_attribution_id') || '/' || substr(v_charge_hash, 8);
  v_billing_intent := jsonb_build_object(
    'schema_version', 'billing-intent/2',
    'workspace_id', v_source ->> 'workspace_id',
    'billing_owner_run_id', v_source ->> 'billing_owner_run_id',
    'reservation_id', v_source ->> 'reservation_id',
    'amount_credits', v_source ->> 'amount_credits',
    'charge_key', v_charge_key,
    'charge_attribution_hash', v_charge_hash,
    'intent_kind', 'SETTLE',
    'authority', jsonb_build_object(
      'schema_version', 'billing-authority-reference/1',
      'authority_kind', 'USAGE_ATTRIBUTION',
      'source_schema_version', 'run-usage-attribution/1',
      'source_id', v_source ->> 'usage_attribution_id',
      'source_authority_hash', v_charge_hash,
      'producer_run_id', v_source ->> 'run_id',
      'producer_attempt_id', v_source ->> 'attempt_id',
      'producer_lease_fencing_token', v_source ->> 'lease_fencing_token',
      'step_id', v_source ->> 'step_id'
    )
  );
  v_intent_hash := app.g007_canonical_sha256(v_billing_intent);
  RETURN app.apply_credit_settlement_kernel(jsonb_build_object(
    'workspace_id', v_source ->> 'workspace_id',
    'run_id', v_source ->> 'run_id',
    'reservation_id', v_source ->> 'reservation_id',
    'authority_id', v_authority_id, 'ledger_entry_id', v_ledger_id,
    'authority_kind', 'EXECUTION_USAGE', 'operation', 'SETTLE',
    'source_id', v_source ->> 'usage_attribution_id',
    'source_authority_hash', v_source ->> 'source_authority_hash',
    'source_consumption_generation', v_source ->> 'source_consumption_generation',
    'amount', v_source ->> 'amount_credits',
    'producer_run_id', v_source ->> 'run_id',
    'producer_attempt_id', v_source ->> 'attempt_id',
    'producer_lease_fencing_token', v_source ->> 'lease_fencing_token',
    'step_id', v_source ->> 'step_id', 'charge_key', v_charge_key,
    'charge_attribution_hash', v_charge_hash,
    'billing_intent_hash', v_intent_hash,
    'detail_redacted', v_source -> 'detail_redacted',
    'authorized_at', clock_timestamp()
  ));
END;
$function$;
ALTER FUNCTION app.apply_attributed_settlement(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.apply_attributed_settlement(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_attributed_settlement(jsonb) TO ba_run_owner;

CREATE FUNCTION app.apply_attributed_release(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_claim jsonb := app.require_transaction_finalizer_claim(p_fact);
  v_source jsonb;
  v_authority_id uuid := gen_random_uuid();
  v_ledger_id uuid := gen_random_uuid();
  v_amount bigint := (p_fact ->> 'amount')::bigint;
  v_charge_key text;
  v_charge_hash text;
  v_intent_hash text;
  v_billing_intent jsonb;
BEGIN
  IF v_claim ->> 'source_kind' <> 'EXECUTION_TERMINATION'
     OR v_claim ->> 'operation' <> 'RELEASE'
     OR v_claim ->> 'run_id' IS DISTINCT FROM p_fact ->> 'run_id'
     OR v_claim ->> 'reservation_id' IS DISTINCT FROM p_fact ->> 'reservation_id'
     OR (v_claim ->> 'amount')::bigint IS DISTINCT FROM v_amount
     OR v_amount < 0 THEN
    RAISE EXCEPTION 'termination claim does not bind the requested release'
      USING ERRCODE = '42501';
  END IF;
  v_source := v_claim -> 'source_fact';
  IF v_source ->> 'schema_version' <> 'run-termination-intent/1'
     OR v_source ->> 'termination_intent_id' IS DISTINCT FROM v_claim ->> 'source_id'
     OR v_source ->> 'intended_release_credits' IS DISTINCT FROM v_amount::text
     OR v_source ->> 'source_authority_hash' IS DISTINCT FROM v_claim ->> 'source_sha256' THEN
    RAISE EXCEPTION 'termination claim source projection is incomplete or mismatched'
      USING ERRCODE = '42501';
  END IF;
  v_charge_hash := v_claim ->> 'source_sha256';
  v_charge_key := 'billing-v2/termination_attribution/'
    || (v_source ->> 'termination_intent_id') || '/' || substr(v_charge_hash, 8);
  v_billing_intent := jsonb_build_object(
    'schema_version', 'billing-intent/2',
    'workspace_id', v_source ->> 'workspace_id',
    'billing_owner_run_id', v_source ->> 'billing_owner_run_id',
    'reservation_id', v_source ->> 'reservation_id',
    'amount_credits', v_source ->> 'intended_release_credits',
    'charge_key', v_charge_key,
    'charge_attribution_hash', v_charge_hash,
    'intent_kind', 'RELEASE',
    'authority', jsonb_build_object(
      'schema_version', 'billing-authority-reference/1',
      'authority_kind', 'TERMINATION_ATTRIBUTION',
      'source_schema_version', 'run-termination-intent/1',
      'source_id', v_source ->> 'termination_intent_id',
      'source_authority_hash', v_charge_hash,
      'producer_run_id', v_source ->> 'run_id',
      'producer_attempt_id', v_source ->> 'attempt_id',
      'producer_lease_fencing_token', v_source ->> 'lease_fencing_token',
      'step_id', v_source ->> 'step_id'
    )
  );
  v_intent_hash := app.g007_canonical_sha256(v_billing_intent);
  RETURN app.apply_credit_release_kernel(jsonb_build_object(
    'workspace_id', v_claim ->> 'workspace_id',
    'run_id', v_claim ->> 'run_id',
    'reservation_id', v_claim ->> 'reservation_id',
    'authority_id', v_authority_id, 'ledger_entry_id', v_ledger_id,
    'authority_kind', 'EXECUTION_TERMINATION', 'operation', 'RELEASE',
    'source_id', v_claim ->> 'source_id',
    'source_authority_hash', v_claim ->> 'source_sha256',
    'source_consumption_generation', v_source ->> 'source_consumption_generation',
    'amount', v_amount, 'producer_run_id', v_source ->> 'run_id',
    'producer_attempt_id', v_source ->> 'attempt_id',
    'producer_lease_fencing_token', v_source ->> 'lease_fencing_token',
    'step_id', v_source ->> 'step_id', 'charge_key', v_charge_key,
    'charge_attribution_hash', v_charge_hash,
    'billing_intent_hash', v_intent_hash,
    'reason_code', v_source ->> 'release_reason_code',
    'authorized_at', clock_timestamp()
  ));
END;
$function$;
ALTER FUNCTION app.apply_attributed_release(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.apply_attributed_release(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_attributed_release(jsonb) TO ba_run_owner;

CREATE FUNCTION app.apply_claimed_release(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_claim jsonb := app.require_transaction_finalizer_claim(p_fact);
  v_source jsonb;
  v_authority_id uuid := gen_random_uuid();
  v_ledger_id uuid := gen_random_uuid();
  v_charge_key text;
  v_charge_hash text;
  v_intent_hash text;
  v_billing_intent jsonb;
BEGIN
  IF v_claim ->> 'source_kind' <> 'DURABLE_CANCEL'
     OR v_claim ->> 'operation' <> 'RELEASE' THEN
    RAISE EXCEPTION 'only a durable-cancel claim can enter claimed release'
      USING ERRCODE = '42501';
  END IF;
  v_source := v_claim -> 'source_fact';
  IF v_source ->> 'schema_version' <> 'run-cancellation-release-authority/1'
     OR v_source ->> 'cancel_event_id' IS DISTINCT FROM v_claim ->> 'source_id'
     OR v_source ->> 'remaining_credits' IS DISTINCT FROM v_claim ->> 'amount'
     OR v_source ->> 'source_authority_hash' IS DISTINCT FROM v_claim ->> 'source_sha256' THEN
    RAISE EXCEPTION 'durable-cancel claim source projection is incomplete or mismatched'
      USING ERRCODE = '42501';
  END IF;
  v_charge_hash := v_claim ->> 'source_sha256';
  v_charge_key := 'billing-v2/cancellation_release/'
    || (v_source ->> 'cancel_event_id') || '/' || substr(v_charge_hash, 8);
  v_billing_intent := jsonb_build_object(
    'schema_version', 'billing-intent/2',
    'workspace_id', v_source ->> 'workspace_id',
    'billing_owner_run_id', v_source ->> 'billing_owner_run_id',
    'reservation_id', v_source ->> 'reservation_id',
    'amount_credits', v_source ->> 'remaining_credits',
    'charge_key', v_charge_key,
    'charge_attribution_hash', v_charge_hash,
    'intent_kind', 'RELEASE',
    'authority', jsonb_build_object(
      'schema_version', 'billing-authority-reference/1',
      'authority_kind', 'CANCELLATION_RELEASE',
      'source_schema_version', 'run-cancellation-release-authority/1',
      'source_id', v_source ->> 'cancel_event_id',
      'source_authority_hash', v_charge_hash
    )
  );
  v_intent_hash := app.g007_canonical_sha256(v_billing_intent);
  RETURN app.apply_credit_release_kernel(jsonb_build_object(
    'workspace_id', v_claim ->> 'workspace_id',
    'run_id', v_claim ->> 'run_id',
    'reservation_id', v_claim ->> 'reservation_id',
    'authority_id', v_authority_id, 'ledger_entry_id', v_ledger_id,
    'authority_kind', 'DURABLE_CANCEL', 'operation', 'RELEASE',
    'source_id', v_claim ->> 'source_id',
    'source_authority_hash', v_claim ->> 'source_sha256',
    'source_consumption_generation', v_source ->> 'cancel_event_sequence',
    'amount', v_claim ->> 'amount',
    'producer_run_id', v_claim ->> 'run_id',
    'charge_key', v_charge_key, 'charge_attribution_hash', v_charge_hash,
    'billing_intent_hash', v_intent_hash,
    'reason_code', 'DURABLE_CANCEL', 'authorized_at', clock_timestamp()
  ));
END;
$function$;
ALTER FUNCTION app.apply_claimed_release(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.apply_claimed_release(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_claimed_release(jsonb) TO ba_run_owner;

CREATE FUNCTION app.settle_attributed_credits(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('metering');
  v_existing public.run_billing_authority_receipts%ROWTYPE;
  v_ledger_id uuid;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact ->> 'source_authority_hash') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid attributed settlement request'
      USING ERRCODE = '22023';
  END IF;
  SELECT receipt.* INTO v_existing
  FROM public.run_billing_authority_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.authority_kind = 'EXECUTION_USAGE'
    AND receipt.source_id = (p_fact ->> 'source_id')::uuid;
  IF FOUND THEN
    IF v_existing.source_authority_hash IS DISTINCT FROM p_fact ->> 'source_authority_hash'
       OR v_existing.run_id IS DISTINCT FROM (p_fact ->> 'run_id')::uuid
       OR v_existing.operation <> 'SETTLE' THEN
      RAISE EXCEPTION 'usage settlement replay does not match committed authority'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'authority_receipt_id', v_existing.id,
      'ledger_entry_id', v_existing.ledger_entry_id,
      'billing_intent_hash', v_existing.billing_intent_hash,
      'charge_attribution_hash', v_existing.charge_attribution_hash,
      'charge_key', v_existing.charge_key,
      'amount', v_existing.amount::text,
      'replayed', true
    );
  END IF;
  PERFORM 1 FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = v_workspace_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for attributed settlement'
      USING ERRCODE = '23503';
  END IF;
  -- A concurrent identical settlement can commit while this transaction waits
  -- for the Workspace fence. Recheck under that fence before consuming source.
  SELECT receipt.* INTO v_existing
  FROM public.run_billing_authority_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.authority_kind = 'EXECUTION_USAGE'
    AND receipt.source_id = (p_fact ->> 'source_id')::uuid;
  IF FOUND THEN
    IF v_existing.source_authority_hash IS DISTINCT FROM p_fact ->> 'source_authority_hash'
       OR v_existing.run_id IS DISTINCT FROM (p_fact ->> 'run_id')::uuid
       OR v_existing.operation <> 'SETTLE' THEN
      RAISE EXCEPTION 'usage settlement replay does not match committed authority'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'authority_receipt_id', v_existing.id,
      'ledger_entry_id', v_existing.ledger_entry_id,
      'billing_intent_hash', v_existing.billing_intent_hash,
      'charge_attribution_hash', v_existing.charge_attribution_hash,
      'charge_key', v_existing.charge_key,
      'amount', v_existing.amount::text,
      'replayed', true
    );
  END IF;
  PERFORM app.lock_open_run_for_attributed_settlement(
    v_workspace_id,
    (p_fact ->> 'run_id')::uuid
  );
  v_ledger_id := app.apply_attributed_settlement(p_fact);
  SELECT receipt.* INTO STRICT v_existing
  FROM public.run_billing_authority_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.ledger_entry_id = v_ledger_id;
  RETURN jsonb_build_object(
    'authority_receipt_id', v_existing.id,
    'ledger_entry_id', v_existing.ledger_entry_id,
    'billing_intent_hash', v_existing.billing_intent_hash,
    'charge_attribution_hash', v_existing.charge_attribution_hash,
    'charge_key', v_existing.charge_key,
    'amount', v_existing.amount::text,
    'replayed', false
  );
END;
$function$;
ALTER FUNCTION app.settle_attributed_credits(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.settle_attributed_credits(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.settle_attributed_credits(jsonb) TO ba_metering_executor;
CREATE OR REPLACE FUNCTION app.settle_credits(
  p_workspace_id uuid,
  p_run_id uuid,
  p_reservation_id uuid,
  p_ledger_entry_id uuid,
  p_producer_run_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_step_id uuid,
  p_amount_credits bigint,
  p_charge_key text,
  p_billing_intent_hash text,
  p_charge_attribution_hash text,
  p_metering_detail_redacted jsonb,
  p_created_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_existing public.credits_ledger%ROWTYPE;
  v_reservation public.credit_reservations%ROWTYPE;
  v_balance bigint;
  v_reserved bigint;
  v_version bigint;
  v_next_version bigint;
BEGIN
  IF p_amount_credits IS NULL
     OR p_amount_credits < 0
     OR p_billing_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_charge_attribution_hash !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(p_metering_detail_redacted) <> 'object'
     OR app.g007_json_numbers_are_finite(p_metering_detail_redacted) IS NOT TRUE
     OR length(p_charge_key) NOT BETWEEN 1 AND 300
     OR length(btrim(p_charge_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 300
     OR p_created_at IS NULL THEN
    RAISE EXCEPTION 'invalid settle_credits intent'
      USING ERRCODE = '22023';
  END IF;

  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'SETTLE'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.settled_delta_credits <> p_amount_credits THEN
      RAISE EXCEPTION 'billing charge key was reused with a different settle intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT workspace_row.credits_balance,
         workspace_row.credits_reserved_balance,
         workspace_row.credits_balance_version
    INTO v_balance, v_reserved, v_version
    FROM public.workspaces AS workspace_row
   WHERE workspace_row.id = p_workspace_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for credit settlement'
      USING ERRCODE = '23503';
  END IF;

  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'SETTLE'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.settled_delta_credits <> p_amount_credits THEN
      RAISE EXCEPTION 'billing charge key was reused with a different settle intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;
  IF p_amount_credits <> 0 AND v_version >= 9007199254740991 THEN
    RAISE EXCEPTION 'Workspace credit balance version cannot advance safely'
      USING ERRCODE = '22003';
  END IF;
  IF v_reserved < p_amount_credits THEN
    RAISE EXCEPTION 'Workspace reserved balance cannot settle requested credits'
      USING ERRCODE = '23514';
  END IF;

  PERFORM app.validate_billing_producer(
    p_workspace_id,
    p_run_id,
    p_producer_run_id,
    p_attempt_id,
    p_fencing_token,
    p_step_id
  );

  SELECT reservation.*
    INTO v_reservation
    FROM public.credit_reservations AS reservation
   WHERE reservation.workspace_id = p_workspace_id
     AND reservation.id = p_reservation_id
     AND reservation.run_id = p_run_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_reservation.status <> 'HELD'
     OR v_reservation.reserved_credits
       - v_reservation.settled_credits
       - v_reservation.released_credits < p_amount_credits THEN
    RAISE EXCEPTION 'reservation cannot settle requested credits'
      USING ERRCODE = '23514';
  END IF;
  IF p_created_at < v_reservation.updated_at THEN
    RAISE EXCEPTION 'credit settlement timestamp predates the reservation update'
      USING ERRCODE = '23514';
  END IF;

  v_next_version := v_version + CASE WHEN p_amount_credits = 0 THEN 0 ELSE 1 END;
  UPDATE public.workspaces
     SET credits_reserved_balance = v_reserved - p_amount_credits,
         credits_balance_version = v_next_version
   WHERE id = p_workspace_id;

  UPDATE public.credit_reservations
     SET settled_credits = settled_credits + p_amount_credits,
         status = CASE
           WHEN settled_credits + released_credits + p_amount_credits = reserved_credits
             THEN 'SETTLED'
           ELSE 'HELD'
         END,
         settled_at = CASE
           WHEN settled_credits + released_credits + p_amount_credits = reserved_credits
             THEN p_created_at
           ELSE NULL
         END,
         released_at = CASE
           WHEN settled_credits + released_credits + p_amount_credits = reserved_credits
                AND released_credits > 0
             THEN p_created_at
           ELSE released_at
         END,
         balance_version = v_next_version,
         updated_at = p_created_at
   WHERE workspace_id = p_workspace_id
     AND id = p_reservation_id;

  INSERT INTO public.credits_ledger (
    workspace_id, id, run_id, billing_owner_run_id, producer_run_id, producer_attempt_id,
    producer_lease_fencing_token, step_id, reservation_id, entry_kind,
    available_delta_credits, reserved_delta_credits, settled_delta_credits,
    billing_intent_hash, charge_attribution_hash, charge_key,
    balance_before, reserved_before, balance_after, reserved_after,
    balance_version, metering_detail_redacted, created_at
  ) VALUES (
    p_workspace_id, p_ledger_entry_id, p_run_id, p_run_id,
    p_producer_run_id, p_attempt_id,
    p_fencing_token, p_step_id, p_reservation_id, 'SETTLE',
    0, -p_amount_credits, p_amount_credits,
    p_billing_intent_hash, p_charge_attribution_hash, p_charge_key,
    v_balance, v_reserved, v_balance, v_reserved - p_amount_credits,
    v_next_version, p_metering_detail_redacted, p_created_at
  );
  RETURN p_ledger_entry_id;
END;
$function$;
ALTER FUNCTION app.settle_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, jsonb, timestamptz
) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.settle_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, jsonb, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.release_credits(
  p_workspace_id uuid,
  p_run_id uuid,
  p_reservation_id uuid,
  p_ledger_entry_id uuid,
  p_producer_run_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_step_id uuid,
  p_amount_credits bigint,
  p_charge_key text,
  p_billing_intent_hash text,
  p_charge_attribution_hash text,
  p_reason_code text,
  p_created_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_existing public.credits_ledger%ROWTYPE;
  v_reservation public.credit_reservations%ROWTYPE;
  v_balance bigint;
  v_reserved bigint;
  v_version bigint;
  v_next_version bigint;
  v_terminal boolean;
BEGIN
  IF p_amount_credits IS NULL
     OR p_amount_credits < 0
     OR p_billing_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_charge_attribution_hash !~ '^sha256:[0-9a-f]{64}$'
     OR length(p_charge_key) NOT BETWEEN 1 AND 300
     OR length(btrim(p_charge_key, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) NOT BETWEEN 1 AND 300
     OR length(p_reason_code) NOT BETWEEN 1 AND 200
     OR length(btrim(p_reason_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) = 0
     OR p_created_at IS NULL THEN
    RAISE EXCEPTION 'invalid release_credits intent'
      USING ERRCODE = '22023';
  END IF;

  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'RELEASE'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.available_delta_credits <> p_amount_credits THEN
      RAISE EXCEPTION 'billing charge key was reused with a different release intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT workspace_row.credits_balance,
         workspace_row.credits_reserved_balance,
         workspace_row.credits_balance_version
    INTO v_balance, v_reserved, v_version
    FROM public.workspaces AS workspace_row
   WHERE workspace_row.id = p_workspace_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for credit release'
      USING ERRCODE = '23503';
  END IF;

  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'RELEASE'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.available_delta_credits <> p_amount_credits THEN
      RAISE EXCEPTION 'billing charge key was reused with a different release intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;
  IF p_amount_credits <> 0 AND v_version >= 9007199254740991 THEN
    RAISE EXCEPTION 'Workspace credit balance version cannot advance safely'
      USING ERRCODE = '22003';
  END IF;
  IF v_reserved < p_amount_credits THEN
    RAISE EXCEPTION 'Workspace reserved balance cannot release requested credits'
      USING ERRCODE = '23514';
  END IF;

  PERFORM app.validate_billing_producer(
    p_workspace_id,
    p_run_id,
    p_producer_run_id,
    p_attempt_id,
    p_fencing_token,
    p_step_id
  );

  SELECT reservation.*
    INTO v_reservation
    FROM public.credit_reservations AS reservation
   WHERE reservation.workspace_id = p_workspace_id
     AND reservation.id = p_reservation_id
     AND reservation.run_id = p_run_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_reservation.status <> 'HELD'
     OR v_reservation.reserved_credits
       - v_reservation.settled_credits
       - v_reservation.released_credits < p_amount_credits THEN
    RAISE EXCEPTION 'reservation cannot release requested credits'
      USING ERRCODE = '23514';
  END IF;
  IF p_created_at < v_reservation.updated_at THEN
    RAISE EXCEPTION 'credit release timestamp predates the reservation update'
      USING ERRCODE = '23514';
  END IF;

  v_terminal := v_reservation.settled_credits
    + v_reservation.released_credits
    + p_amount_credits = v_reservation.reserved_credits;
  v_next_version := v_version + CASE WHEN p_amount_credits = 0 THEN 0 ELSE 1 END;
  UPDATE public.workspaces
     SET credits_balance = v_balance + p_amount_credits,
         credits_reserved_balance = v_reserved - p_amount_credits,
         credits_balance_version = v_next_version
   WHERE id = p_workspace_id;
  UPDATE public.credit_reservations
     SET released_credits = released_credits + p_amount_credits,
         status = CASE
           WHEN v_terminal AND settled_credits > 0 THEN 'SETTLED'
           WHEN v_terminal THEN 'RELEASED'
           ELSE 'HELD'
         END,
         settled_at = CASE
           WHEN v_terminal AND settled_credits > 0 THEN p_created_at
           ELSE NULL
         END,
         released_at = CASE
           WHEN v_terminal THEN p_created_at
           ELSE NULL
         END,
         status_reason_code = p_reason_code,
         balance_version = v_next_version,
         updated_at = p_created_at
   WHERE workspace_id = p_workspace_id
     AND id = p_reservation_id;

  INSERT INTO public.credits_ledger (
    workspace_id, id, run_id, billing_owner_run_id, producer_run_id, producer_attempt_id,
    producer_lease_fencing_token, step_id, reservation_id, entry_kind,
    available_delta_credits, reserved_delta_credits, settled_delta_credits,
    billing_intent_hash, charge_attribution_hash, charge_key,
    balance_before, reserved_before, balance_after, reserved_after,
    balance_version, metering_detail_redacted, created_at
  ) VALUES (
    p_workspace_id, p_ledger_entry_id, p_run_id, p_run_id,
    p_producer_run_id, p_attempt_id,
    p_fencing_token, p_step_id, p_reservation_id, 'RELEASE',
    p_amount_credits, -p_amount_credits, 0,
    p_billing_intent_hash, p_charge_attribution_hash, p_charge_key,
    v_balance, v_reserved, v_balance + p_amount_credits, v_reserved - p_amount_credits,
    v_next_version, jsonb_build_object('reason_code', p_reason_code), p_created_at
  );
  RETURN p_ledger_entry_id;
END;
$function$;
ALTER FUNCTION app.release_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, text, timestamptz
) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.release_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, text, timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.finalize_run(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_terminal_kind text := p_fact ->> 'terminal_kind';
  v_termination_reason text := p_fact ->> 'termination_reason';
  v_terminal_intent_hash text := p_fact ->> 'terminal_intent_hash';
  v_finished_at timestamptz := (p_fact ->> 'finished_at')::timestamptz;
  v_settle_credits bigint := COALESCE((p_fact ->> 'settled_credits')::bigint, 0);
  v_release_credits bigint := COALESCE((p_fact ->> 'released_credits')::bigint, 0);
  v_run public.runs%ROWTYPE;
  v_reservation jsonb;
  v_sequence bigint;
  v_status text;
  v_execution_status text;
  v_step_status text;
  v_billing_state text;
  v_terminal_error_redacted jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_terminal_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR v_finished_at IS NULL
     OR v_settle_credits < 0
     OR v_release_credits < 0
     OR (p_fact ->> 'events_retention_until')::timestamptz
          < v_finished_at + interval '7 days'
     OR (p_fact ->> 'recovery_retention_until')::timestamptz
          < v_finished_at + interval '30 days'
     OR (p_fact ->> 'recovery_retention_until')::timestamptz
          < (p_fact ->> 'events_retention_until')::timestamptz
     OR (p_fact ->> 'retention_until')::timestamptz
          < (p_fact ->> 'recovery_retention_until')::timestamptz THEN
    RAISE EXCEPTION 'invalid finalize_run terminal fact'
      USING ERRCODE = '22023';
  END IF;

  IF v_terminal_kind = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'SUCCEEDED finalization is unavailable before G0-07'
      USING ERRCODE = '0A000';
  END IF;
  IF v_terminal_kind NOT IN (
    'FAILED', 'CANCELLED', 'TIMED_OUT', 'SIDE_EFFECT_UNKNOWN'
  ) THEN
    RAISE EXCEPTION 'unsupported finalize_run terminal kind'
      USING ERRCODE = '22023';
  END IF;
  IF v_termination_reason IN ('HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED') THEN
    RAISE EXCEPTION 'Human Gate terminal finalization is unavailable before GateSpec publication'
      USING ERRCODE = '0A000';
  END IF;
  IF v_termination_reason IS NULL OR (
       v_terminal_kind = 'FAILED'
       AND v_termination_reason NOT IN (
         'MAX_ITERATIONS',
         'MAX_MODEL_ATTEMPTS',
         'MAX_TOOL_CALLS',
         'BUDGET_EXHAUSTED',
         'AUTHORIZATION_REVALIDATION_FAILED',
         'RESOURCE_REVOKED',
         'MODEL_FAILED',
         'MODEL_OUTCOME_UNKNOWN',
         'CAPABILITY_FAILED',
         'HUMAN_REJECTED',
         'HUMAN_GATE_EXPIRED',
         'INVALID_DECISION',
         'STRATEGY_IMPLEMENTATION_UNAVAILABLE',
         'INTERNAL_FAILURE'
       )
     ) OR (
       v_terminal_kind = 'CANCELLED'
       AND v_termination_reason NOT IN (
         'USER_CANCELLED', 'HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED'
       )
     ) OR (
       v_terminal_kind = 'TIMED_OUT'
       AND v_termination_reason IS DISTINCT FROM 'RUN_TIMED_OUT'
     ) OR (
       v_terminal_kind = 'SIDE_EFFECT_UNKNOWN'
       AND v_termination_reason IS DISTINCT FROM 'SIDE_EFFECT_UNKNOWN'
     ) THEN
    RAISE EXCEPTION 'termination reason does not map to terminal kind'
      USING ERRCODE = '22023';
  END IF;

  v_terminal_error_redacted := jsonb_build_object(
    'code', v_termination_reason,
    'retryable', false,
    'category', 'EXECUTION'
  );
  IF v_terminal_kind = 'SIDE_EFFECT_UNKNOWN' THEN
    v_terminal_error_redacted := v_terminal_error_redacted || jsonb_build_object(
      'requires_operator_action', true
    );
  END IF;

  PERFORM app.lock_billing_workspace(v_workspace_id);
  SELECT run_row.*
    INTO v_run
    FROM public.runs AS run_row
   WHERE run_row.workspace_id = v_workspace_id
     AND run_row.id = v_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run is unavailable for finalization'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_run.terminal_intent_hash IS NOT NULL THEN
    IF v_run.terminal_intent_hash IS DISTINCT FROM v_terminal_intent_hash THEN
      RAISE EXCEPTION 'Run terminal intent conflicts with its durable tombstone'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'run_id', v_run.id,
      'status', v_run.status,
      'billing_state', v_run.billing_state,
      'terminal_event_id', v_run.terminal_event_id,
      'terminal_event_sequence', v_run.terminal_event_sequence,
      'finished_at', v_run.finished_at
    );
  END IF;

  IF v_run.status IN (
    'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION'
  ) THEN
    RAISE EXCEPTION 'Run has an invalid terminal state without a tombstone'
      USING ERRCODE = '55000';
  END IF;

  v_reservation := app.lock_billing_reservation_summary(
    v_workspace_id,
    v_run_id,
    (p_fact ->> 'reservation_id')::uuid
  );
  IF v_finished_at < (v_reservation ->> 'updated_at')::timestamptz THEN
    RAISE EXCEPTION 'Run finalization timestamp predates the reservation update'
      USING ERRCODE = '23514';
  END IF;

  IF v_terminal_kind = 'SIDE_EFFECT_UNKNOWN' THEN
    IF v_settle_credits <> 0 OR v_release_credits <> 0 THEN
      RAISE EXCEPTION 'SIDE_EFFECT_UNKNOWN cannot move credits'
        USING ERRCODE = '23514';
    END IF;
    v_status := 'NEEDS_ATTENTION';
    v_execution_status := 'NEEDS_ATTENTION';
    v_step_status := 'NEEDS_ATTENTION';
    v_billing_state := 'NEEDS_ATTENTION';
  ELSE
    IF v_settle_credits + v_release_credits
         <> (v_reservation ->> 'reserved_credits')::bigint
          - (v_reservation ->> 'settled_credits')::bigint
          - (v_reservation ->> 'released_credits')::bigint THEN
      RAISE EXCEPTION 'finalizer must exactly close the held reservation'
        USING ERRCODE = '23514';
    END IF;

    IF v_settle_credits > 0
       OR (
         (v_reservation ->> 'reserved_credits')::bigint = 0
         AND v_release_credits = 0
       ) THEN
      PERFORM app.settle_credits(
        v_workspace_id,
        v_run_id,
        (v_reservation ->> 'reservation_id')::uuid,
        (p_fact ->> 'settle_ledger_entry_id')::uuid,
        (p_fact ->> 'producer_run_id')::uuid,
        (p_fact ->> 'attempt_id')::uuid,
        (p_fact ->> 'lease_fencing_token')::bigint,
        (p_fact ->> 'step_id')::uuid,
        v_settle_credits,
        p_fact ->> 'settle_charge_key',
        p_fact ->> 'settle_billing_intent_hash',
        p_fact ->> 'settle_charge_attribution_hash',
        COALESCE(p_fact -> 'metering_detail_redacted', '{}'::jsonb),
        v_finished_at
      );
    END IF;
    IF v_release_credits > 0 THEN
      PERFORM app.release_credits(
        v_workspace_id,
        v_run_id,
        (v_reservation ->> 'reservation_id')::uuid,
        (p_fact ->> 'release_ledger_entry_id')::uuid,
        (p_fact ->> 'producer_run_id')::uuid,
        (p_fact ->> 'attempt_id')::uuid,
        (p_fact ->> 'lease_fencing_token')::bigint,
        (p_fact ->> 'step_id')::uuid,
        v_release_credits,
        p_fact ->> 'release_charge_key',
        p_fact ->> 'release_billing_intent_hash',
        p_fact ->> 'release_charge_attribution_hash',
        COALESCE(NULLIF(p_fact ->> 'release_reason_code', ''), 'TERMINAL_RELEASE'),
        v_finished_at
      );
    END IF;

    v_status := v_terminal_kind;
    v_execution_status := CASE v_terminal_kind
      WHEN 'TIMED_OUT' THEN 'EXPIRED'
      ELSE v_terminal_kind
    END;
    v_step_status := CASE v_terminal_kind
      WHEN 'CANCELLED' THEN 'CANCELLED'
      ELSE 'FAILED'
    END;
    v_billing_state := 'SETTLED';
  END IF;

  v_sequence := v_run.last_event_sequence + 1;
  INSERT INTO public.run_steps (
    workspace_id, id, run_id, attempt_id, step_key, status,
    input_hash, output_hash, created_at, updated_at
  ) VALUES (
    v_workspace_id,
    (p_fact ->> 'terminal_step_id')::uuid,
    v_run_id,
    (p_fact ->> 'attempt_id')::uuid,
    'terminal',
    v_step_status,
    v_run.accepted_plan_hash,
    v_terminal_intent_hash,
    v_finished_at,
    v_finished_at
  );
  INSERT INTO public.run_events (
    workspace_id, id, run_id, sequence, event_type, dedupe_key,
    payload_redacted, occurred_at
  ) VALUES (
    v_workspace_id,
    (p_fact ->> 'terminal_event_id')::uuid,
    v_run_id,
    v_sequence,
    'RUN_FINISHED',
    'terminal:' || v_terminal_intent_hash,
    jsonb_build_object('status', v_status, 'billing_state', v_billing_state),
    v_finished_at
  );
  INSERT INTO public.outbox (
    workspace_id, id, run_id, message_type, dedupe_key,
    payload_ref, payload_hash, producer_fencing_token,
    payload_redacted, status, available_at, created_at
  ) VALUES (
    v_workspace_id,
    (p_fact ->> 'terminal_outbox_id')::uuid,
    v_run_id,
    'SSE_WAKE',
    'terminal:' || v_terminal_intent_hash,
    'run:' || v_run_id::text || ':terminal',
    v_terminal_intent_hash,
    (p_fact ->> 'lease_fencing_token')::bigint,
    jsonb_build_object('run_id', v_run_id, 'status', v_status),
    'PENDING',
    v_finished_at,
    v_finished_at
  );

  UPDATE public.runs
     SET status = v_status,
         execution_status = v_execution_status,
         billing_state = v_billing_state,
         billing_settled_at = CASE
           WHEN v_billing_state = 'SETTLED' THEN v_finished_at
           ELSE NULL
         END,
         last_event_sequence = v_sequence,
         termination_reason = v_termination_reason,
         terminal_intent_hash = v_terminal_intent_hash,
         terminal_result_redacted = NULL,
         terminal_error_redacted = v_terminal_error_redacted,
         terminal_billing_pending = false,
         terminal_billing_pending_at = v_finished_at,
         terminal_event_id = (p_fact ->> 'terminal_event_id')::uuid,
         terminal_event_sequence = v_sequence,
         finished_at = v_finished_at,
         events_retention_until = (p_fact ->> 'events_retention_until')::timestamptz,
         recovery_retention_until = (p_fact ->> 'recovery_retention_until')::timestamptz,
         retention_until = (p_fact ->> 'retention_until')::timestamptz
   WHERE workspace_id = v_workspace_id
     AND id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'status', v_status,
    'billing_state', v_billing_state,
    'terminal_event_id', (p_fact ->> 'terminal_event_id')::uuid,
    'terminal_event_sequence', v_sequence,
    'finished_at', v_finished_at
  );
END;
$function$;
ALTER FUNCTION app.finalize_run(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.finalize_run(jsonb) FROM PUBLIC;

CREATE FUNCTION app.apply_g007_terminal_projection(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_status text := p_fact ->> 'status';
  v_billing_state text := p_fact ->> 'billing_state';
  v_terminal_hash text := p_fact ->> 'terminal_intent_hash';
  v_source_kind text := p_fact ->> 'source_kind';
  v_source_id uuid := (p_fact ->> 'source_id')::uuid;
  v_source_sha256 text := p_fact ->> 'source_sha256';
  v_finished_at timestamptz := clock_timestamp();
  v_run public.runs%ROWTYPE;
  v_sequence bigint;
  v_event_id uuid := gen_random_uuid();
  v_step_id uuid := gen_random_uuid();
  v_outbox_id uuid := gen_random_uuid();
  v_execution_status text;
  v_step_status text;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_status NOT IN ('FAILED', 'CANCELLED', 'NEEDS_ATTENTION')
     OR v_billing_state NOT IN ('SETTLED', 'NEEDS_ATTENTION')
     OR v_terminal_hash !~ '^sha256:[0-9a-f]{64}$'
     OR v_source_kind NOT IN ('TERMINATION_ATTRIBUTION', 'DURABLE_CANCEL', 'RECOVERY_HOLD')
     OR v_source_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR NOT (
       (
         v_source_kind = 'TERMINATION_ATTRIBUTION'
         AND v_status IN ('FAILED', 'CANCELLED')
         AND p_fact ->> 'attempt_status' = v_status
       )
       OR (
         v_source_kind = 'DURABLE_CANCEL'
         AND v_status = 'CANCELLED'
         AND p_fact ->> 'attempt_status' = 'CANCELLED'
       )
       OR (
         v_source_kind = 'RECOVERY_HOLD'
         AND v_status = 'NEEDS_ATTENTION'
         AND p_fact ->> 'attempt_status' = 'RELINQUISHED'
       )
     )
     OR length(btrim(p_fact ->> 'termination_reason', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) = 0 THEN
    RAISE EXCEPTION 'invalid protocol-v5 terminal projection'
      USING ERRCODE = '22023';
  END IF;
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = v_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run is unavailable for protocol-v5 finalization'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_run.terminal_intent_hash IS NOT NULL THEN
    IF v_run.terminal_intent_hash IS DISTINCT FROM v_terminal_hash THEN
      RAISE EXCEPTION 'Run terminal intent conflicts with its durable tombstone'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'run_id', v_run.id, 'status', v_run.status,
      'billing_state', v_run.billing_state,
      'terminal_event_id', v_run.terminal_event_id,
      'terminal_event_sequence', v_run.terminal_event_sequence,
      'finished_at', v_run.finished_at, 'replayed', true
    );
  END IF;

  PERFORM app.retire_run_attempts_for_finalizer(jsonb_build_object(
    'workspace_id', v_workspace_id, 'run_id', v_run_id,
    'source_kind', v_source_kind, 'source_id', v_source_id,
    'source_sha256', v_source_sha256,
    'terminal_intent_sha256', v_terminal_hash,
    'attempt_status', p_fact ->> 'attempt_status'
  ));
  PERFORM app.retire_run_dispatches_for_finalizer(jsonb_build_object(
    'workspace_id', v_workspace_id, 'run_id', v_run_id,
    'source_kind', v_source_kind,
    'source_id', v_source_id,
    'source_sha256', v_source_sha256,
    'terminal_intent_sha256', v_terminal_hash
  ));
  v_sequence := v_run.last_event_sequence + 1;
  v_execution_status := v_status;
  v_step_status := CASE
    WHEN v_status = 'CANCELLED' THEN 'CANCELLED'
    WHEN v_status = 'NEEDS_ATTENTION' THEN 'NEEDS_ATTENTION'
    ELSE 'FAILED'
  END;
  UPDATE public.run_steps
  SET status = v_step_status,
      updated_at = v_finished_at
  WHERE workspace_id = v_workspace_id
    AND run_id = v_run_id
    AND status IN ('PENDING', 'RUNNING', 'SUSPENDED');
  INSERT INTO public.run_steps (
    workspace_id, id, run_id, attempt_id, step_key, status,
    input_hash, output_hash, created_at, updated_at
  ) VALUES (
    v_workspace_id, v_step_id, v_run_id,
    NULLIF(p_fact ->> 'attempt_id', '')::uuid,
    'terminal', v_step_status, v_run.accepted_plan_hash,
    v_terminal_hash, v_finished_at, v_finished_at
  );
  INSERT INTO public.run_events (
    workspace_id, id, run_id, sequence, event_type, dedupe_key,
    payload_redacted, occurred_at
  ) VALUES (
    v_workspace_id, v_event_id, v_run_id, v_sequence, 'RUN_FINISHED',
    'terminal:' || v_terminal_hash,
    jsonb_build_object('status', v_status, 'billing_state', v_billing_state),
    v_finished_at
  );
  INSERT INTO public.outbox (
    workspace_id, id, run_id, message_type, dedupe_key, payload_ref,
    payload_hash, producer_fencing_token, payload_redacted, status,
    available_at, created_at
  ) VALUES (
    v_workspace_id, v_outbox_id, v_run_id, 'SSE_WAKE',
    'terminal:' || v_terminal_hash,
    'run:' || v_run_id::text || ':terminal', v_terminal_hash, 1,
    jsonb_build_object('run_id', v_run_id, 'status', v_status),
    'PENDING', v_finished_at, v_finished_at
  );
  UPDATE public.runs
  SET status = v_status,
      execution_status = v_execution_status,
      billing_state = v_billing_state,
      billing_settled_at = CASE
        WHEN v_billing_state = 'SETTLED' THEN v_finished_at ELSE NULL END,
      last_event_sequence = v_sequence,
      termination_reason = p_fact ->> 'termination_reason',
      terminal_intent_hash = v_terminal_hash,
      terminal_result_redacted = NULL,
      terminal_error_redacted = CASE
        WHEN v_status = 'NEEDS_ATTENTION' THEN jsonb_build_object(
          'code', p_fact ->> 'termination_reason',
          'retryable', false,
          'category', 'EXECUTION',
          'requires_operator_action', true
        )
        ELSE jsonb_build_object(
          'code', p_fact ->> 'termination_reason',
          'retryable', false,
          'category', 'EXECUTION'
        )
      END,
      terminal_billing_pending = false,
      terminal_billing_pending_at = v_finished_at,
      terminal_event_id = v_event_id,
      terminal_event_sequence = v_sequence,
      finished_at = v_finished_at,
      events_retention_until = v_finished_at + interval '7 days',
      recovery_retention_until = v_finished_at + interval '30 days',
      retention_until = v_finished_at + interval '90 days'
  WHERE workspace_id = v_workspace_id AND id = v_run_id;
  RETURN jsonb_build_object(
    'run_id', v_run_id, 'status', v_status,
    'billing_state', v_billing_state,
    'terminal_intent_hash', v_terminal_hash,
    'terminal_event_id', v_event_id,
    'terminal_event_sequence', v_sequence,
    'terminal_step_id', v_step_id,
    'terminal_outbox_id', v_outbox_id,
    'finished_at', v_finished_at, 'replayed', false
  );
END;
$function$;
ALTER FUNCTION app.apply_g007_terminal_projection(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.apply_g007_terminal_projection(jsonb) FROM PUBLIC;

CREATE FUNCTION app.lock_finalizer_workspace_billing_fence()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('finalizer');
BEGIN
  PERFORM 1
  FROM public.workspaces AS workspace_row
  WHERE workspace_row.id = v_workspace_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for finalization'
      USING ERRCODE = '23503';
  END IF;
END;
$function$;
ALTER FUNCTION app.lock_finalizer_workspace_billing_fence() OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.lock_finalizer_workspace_billing_fence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_finalizer_workspace_billing_fence() TO ba_run_owner;

CREATE FUNCTION app.finalize_attributed_run(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('finalizer');
  v_run public.runs%ROWTYPE;
  v_source jsonb;
  v_usage public.run_usage_attributions%ROWTYPE;
  v_existing_usage_receipt public.run_billing_authority_receipts%ROWTYPE;
  v_reservation record;
  v_amount bigint;
  v_usage_id uuid;
  v_usage_ids uuid[] := ARRAY[]::uuid[];
  v_usage_ledger_id uuid;
  v_settled_total bigint := 0;
  v_current_closure text;
  v_claim_id uuid := gen_random_uuid();
  v_ledger_id uuid;
  v_result jsonb;
  v_status text;
  v_attempt_status text;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact ->> 'source_authority_hash') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid attributed finalization request'
      USING ERRCODE = '22023';
  END IF;
  PERFORM app.lock_finalizer_workspace_billing_fence();
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run is unavailable for attributed finalization'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_run.terminal_intent_hash IS NOT NULL THEN
    SELECT to_jsonb(source) INTO v_source
    FROM public.run_termination_intents AS source
    WHERE source.workspace_id = v_workspace_id
      AND source.id = (p_fact ->> 'source_id')::uuid
      AND source.run_id = v_run.id
      AND source.source_authority_hash = p_fact ->> 'source_authority_hash';
    IF NOT FOUND OR v_run.terminal_intent_hash IS DISTINCT FROM v_source ->> 'terminal_intent_hash' THEN
      RAISE EXCEPTION 'attributed finalization replay conflicts with terminal tombstone'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'run_id', v_run.id, 'status', v_run.status,
      'billing_state', v_run.billing_state,
      'terminal_event_id', v_run.terminal_event_id,
      'terminal_event_sequence', v_run.terminal_event_sequence,
      'finished_at', v_run.finished_at, 'replayed', true
    );
  END IF;
  PERFORM 1
  FROM public.run_attempts AS attempt
  WHERE attempt.workspace_id = v_workspace_id AND attempt.run_id = v_run.id
  ORDER BY attempt.id
  FOR UPDATE;
  PERFORM 1
  FROM public.run_retry_effect_envelopes AS envelope
  LEFT JOIN public.run_side_effect_receipts AS receipt
    ON receipt.workspace_id = envelope.workspace_id
   AND receipt.envelope_id = envelope.id
  WHERE envelope.workspace_id = v_workspace_id
    AND envelope.run_id = v_run.id
  ORDER BY envelope.id
  FOR UPDATE OF envelope;
  PERFORM 1
  FROM public.run_side_effect_receipts AS receipt
  WHERE receipt.workspace_id = v_workspace_id
    AND receipt.run_id = v_run.id
  ORDER BY receipt.id
  FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM public.run_attempts AS attempt
    WHERE attempt.workspace_id = v_workspace_id
      AND attempt.run_id = v_run.id
      AND attempt.started_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.run_retry_effect_envelopes AS envelope
        WHERE envelope.workspace_id = attempt.workspace_id
          AND envelope.run_id = attempt.run_id
          AND envelope.attempt_id = attempt.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    LEFT JOIN public.run_side_effect_receipts AS receipt
      ON receipt.workspace_id = envelope.workspace_id
     AND receipt.envelope_id = envelope.id
    WHERE envelope.workspace_id = v_workspace_id
      AND envelope.run_id = v_run.id
      AND (
        envelope.effect_class = 'unsafe'
        OR receipt.disposition IS DISTINCT FROM 'CONFIRMED'
      )
  ) THEN
    RAISE EXCEPTION 'attributed finalization is HOLD-first for missing, unsafe or UNKNOWN effects'
      USING ERRCODE = '55000';
  END IF;
  v_source := app.require_committed_producer_attribution(jsonb_build_object(
    'authority_kind', 'EXECUTION_TERMINATION',
    'source_id', p_fact ->> 'source_id',
    'source_authority_hash', p_fact ->> 'source_authority_hash',
    'consume', false
  ));
  IF v_source ->> 'run_id' IS DISTINCT FROM v_run.id::text
     OR v_source ->> 'effect_disposition' <> 'CLOSED' THEN
    RAISE EXCEPTION 'termination attribution cannot authorize this terminal Run'
      USING ERRCODE = '42501';
  END IF;
  v_current_closure := app.g007_attempt_effect_closure_sha256(
    v_workspace_id, v_run.id, (v_source ->> 'attempt_id')::uuid
  );
  IF v_current_closure IS DISTINCT FROM v_source ->> 'effect_closure_sha256' THEN
    RAISE EXCEPTION 'termination attribution effect closure changed before finalization'
      USING ERRCODE = '55000';
  END IF;
  v_usage_ids := ARRAY(
    SELECT usage_id::uuid
    FROM jsonb_array_elements_text(v_source -> 'usage_attribution_ids')
      WITH ORDINALITY AS usage(usage_id, ordinal)
    ORDER BY usage.ordinal
  );
  IF v_usage_ids IS DISTINCT FROM COALESCE(
       (SELECT array_agg(usage_id ORDER BY usage_id) FROM unnest(v_usage_ids) AS usage_id),
       ARRAY[]::uuid[]
     ) THEN
    RAISE EXCEPTION 'termination attribution usage identities are not lexically sorted'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_usage_id IN ARRAY v_usage_ids LOOP
    SELECT source.*
    INTO v_usage
    FROM public.run_usage_attributions AS source
    WHERE source.workspace_id = v_workspace_id
      AND source.id = v_usage_id
      AND source.run_id = v_run.id
      AND source.reservation_id = (v_source ->> 'reservation_id')::uuid
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'termination attribution declares a missing usage authority source'
        USING ERRCODE = '42501';
    END IF;
    v_settled_total := v_settled_total + v_usage.amount;
    IF v_usage.consumed_at IS NULL THEN
      v_usage_ledger_id := app.apply_attributed_settlement(jsonb_build_object(
        'run_id', v_run.id,
        'reservation_id', v_usage.reservation_id,
        'source_id', v_usage.id,
        'source_authority_hash', v_usage.source_authority_hash
      ));
    ELSE
      SELECT receipt.*
      INTO v_existing_usage_receipt
      FROM public.run_billing_authority_receipts AS receipt
      WHERE receipt.workspace_id = v_workspace_id
        AND receipt.authority_kind = 'EXECUTION_USAGE'
        AND receipt.source_id = v_usage.id;
      IF NOT FOUND
         OR v_existing_usage_receipt.source_authority_hash
              IS DISTINCT FROM v_usage.source_authority_hash
         OR v_existing_usage_receipt.operation <> 'SETTLE'
         OR v_existing_usage_receipt.amount <> v_usage.amount
         OR v_existing_usage_receipt.run_id <> v_run.id
         OR v_existing_usage_receipt.reservation_id <> v_usage.reservation_id
         OR v_existing_usage_receipt.source_consumption_generation
              IS DISTINCT FROM v_usage.consumption_generation - 1 THEN
        RAISE EXCEPTION 'consumed usage authority lacks its exact settlement receipt'
          USING ERRCODE = '55000';
      END IF;
      v_usage_ledger_id := v_existing_usage_receipt.ledger_entry_id;
    END IF;
  END LOOP;
  IF v_settled_total IS DISTINCT FROM (v_source ->> 'intended_settle_credits')::bigint THEN
    RAISE EXCEPTION 'termination attribution intended_settle_credits mismatches declared usage'
      USING ERRCODE = '55000';
  END IF;
  -- The Workspace row lock above is the global billing fence. Reservation
  -- mutation remains inside billing-owner helpers; this cross-owner read is
  -- deliberately column-scoped and does not require raw UPDATE privilege.
  SELECT
    reservation.id,
    reservation.status,
    reservation.reserved_credits,
    reservation.settled_credits,
    reservation.released_credits
  INTO v_reservation
  FROM public.credit_reservations AS reservation
  WHERE reservation.workspace_id = v_workspace_id
    AND reservation.id = (v_source ->> 'reservation_id')::uuid
    AND reservation.run_id = v_run.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'termination attribution reservation is unavailable'
      USING ERRCODE = '23503';
  END IF;
  v_amount := v_reservation.reserved_credits
    - v_reservation.settled_credits - v_reservation.released_credits;
  IF v_amount IS DISTINCT FROM (v_source ->> 'intended_release_credits')::bigint
     OR (v_source ->> 'intended_settle_credits')::bigint
        + (v_source ->> 'intended_release_credits')::bigint
        + v_reservation.settled_credits + v_reservation.released_credits
        - v_settled_total IS DISTINCT FROM v_reservation.reserved_credits THEN
    RAISE EXCEPTION 'termination attribution financial close no longer matches reserved_credits'
      USING ERRCODE = '55000';
  END IF;
  v_source := app.require_committed_producer_attribution(jsonb_build_object(
    'authority_kind', 'EXECUTION_TERMINATION',
    'source_id', p_fact ->> 'source_id',
    'source_authority_hash', p_fact ->> 'source_authority_hash',
    'consume', true
  ));
  IF v_reservation.status = 'HELD' THEN
    INSERT INTO public.finalizer_transaction_claims (
      transaction_id, workspace_id, id, run_id, reservation_id,
      source_kind, source_id, source_sha256, source_fact, terminal_intent_hash,
      effect_closure_sha256, operation, amount
    ) VALUES (
      txid_current(), v_workspace_id, v_claim_id, v_run.id, v_reservation.id,
      'EXECUTION_TERMINATION', (v_source ->> 'id')::uuid,
      v_source ->> 'source_authority_hash', v_source,
      v_source ->> 'terminal_intent_hash',
      v_source ->> 'effect_closure_sha256', 'RELEASE', v_amount
    );
    v_ledger_id := app.apply_attributed_release(jsonb_build_object(
      'claim_id', v_claim_id, 'source_kind', 'EXECUTION_TERMINATION',
      'source_id', v_source ->> 'id',
      'source_sha256', v_source ->> 'source_authority_hash',
      'terminal_intent_hash', v_source ->> 'terminal_intent_hash',
      'operation', 'RELEASE', 'amount', v_amount,
      'run_id', v_run.id, 'reservation_id', v_reservation.id
    ));
  ELSIF v_amount <> 0
        OR v_reservation.status NOT IN ('SETTLED', 'RELEASED', 'EXPIRED') THEN
    RAISE EXCEPTION 'terminal reservation contains an unclosed remainder'
      USING ERRCODE = '55000';
  END IF;
  v_status := CASE v_source ->> 'terminal_status'
    WHEN 'FAILED' THEN 'FAILED'
    WHEN 'CANCELLED' THEN 'CANCELLED'
    ELSE NULL
  END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'termination attribution uses an unsupported terminal kind'
      USING ERRCODE = '22023';
  END IF;
  v_attempt_status := CASE WHEN v_status = 'CANCELLED' THEN 'CANCELLED' ELSE 'FAILED' END;
  v_result := app.apply_g007_terminal_projection(jsonb_build_object(
    'workspace_id', v_workspace_id, 'run_id', v_run.id,
    'status', v_status, 'billing_state', 'SETTLED',
    'termination_reason', v_source ->> 'termination_reason',
    'terminal_intent_hash', v_source ->> 'terminal_intent_hash',
    'attempt_id', v_source ->> 'attempt_id',
    'attempt_status', v_attempt_status,
    'source_kind', 'TERMINATION_ATTRIBUTION',
    'source_id', v_source ->> 'termination_intent_id',
    'source_sha256', v_source ->> 'source_authority_hash'
  ));
  RETURN v_result || jsonb_build_object(
    'ledger_entry_id', v_ledger_id,
    'usage_ledger_entry_id', v_usage_ledger_id,
    'termination_intent_id', v_source ->> 'termination_intent_id'
  );
END;
$function$;
ALTER FUNCTION app.finalize_attributed_run(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.finalize_attributed_run(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finalize_attributed_run(jsonb) TO ba_finalizer_executor;

CREATE FUNCTION app.finalize_claimed_run(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('finalizer');
  v_run public.runs%ROWTYPE;
  v_reservation record;
  v_cancel_event public.run_events%ROWTYPE;
  v_hold public.run_recovery_hold_intents%ROWTYPE;
  v_source_kind text;
  v_source_id uuid;
  v_source_hash text;
  v_source jsonb;
  v_cancel_intent_hash text;
  v_effect_closure text;
  v_terminal_hash text;
  v_amount bigint;
  v_claim_id uuid := gen_random_uuid();
  v_ledger_id uuid;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact - ARRAY['run_id', 'hold_intent_id', 'cancel_event_id']) <> '{}'::jsonb
     OR (p_fact ->> 'run_id') IS NULL
     OR ((p_fact ->> 'hold_intent_id') IS NULL)
       = ((p_fact ->> 'cancel_event_id') IS NULL) THEN
    RAISE EXCEPTION 'invalid claimed finalization request'
      USING ERRCODE = '22023';
  END IF;
  PERFORM app.lock_finalizer_workspace_billing_fence();
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = v_workspace_id
    AND run_row.id = (p_fact ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run is unavailable for claimed finalization'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_run.terminal_intent_hash IS NOT NULL THEN
    IF p_fact ->> 'hold_intent_id' IS NOT NULL THEN
      SELECT hold_row.* INTO v_hold
      FROM public.run_recovery_hold_intents AS hold_row
      WHERE hold_row.workspace_id = v_workspace_id
        AND hold_row.id = (p_fact ->> 'hold_intent_id')::uuid
        AND hold_row.run_id = v_run.id
        AND hold_row.resource_kind = 'ATTEMPT';
      IF FOUND THEN
        v_terminal_hash := app.g007_sha256(
          'better-agent/run-terminal-intent/2',
          app.g007_canonical_json(jsonb_build_object(
            'source_kind', 'RECOVERY_HOLD', 'source_id', v_hold.id,
            'source_sha256', v_hold.hold_evidence_sha256,
            'terminal_kind', 'NEEDS_ATTENTION',
            'termination_reason', 'SIDE_EFFECT_UNKNOWN'
          ))
        );
      END IF;
      IF NOT FOUND
         OR v_run.terminal_intent_hash IS DISTINCT FROM v_terminal_hash
         OR v_run.status <> 'NEEDS_ATTENTION' THEN
        RAISE EXCEPTION 'claimed HOLD replay conflicts with terminal tombstone'
          USING ERRCODE = '23505';
      END IF;
    ELSIF p_fact ->> 'cancel_event_id' IS NOT NULL THEN
      SELECT event_row.* INTO v_cancel_event
      FROM public.run_events AS event_row
      WHERE event_row.workspace_id = v_workspace_id
        AND event_row.id = (p_fact ->> 'cancel_event_id')::uuid
        AND event_row.run_id = v_run.id
        AND event_row.event_type = 'RUN_CANCEL_REQUESTED';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'claimed cancel replay lacks its durable event'
          USING ERRCODE = '23505';
      END IF;
      v_terminal_hash := app.g007_sha256(
        'better-agent/run-terminal-intent/2',
        app.g007_canonical_json(jsonb_build_object(
          'source_kind', 'DURABLE_CANCEL', 'source_id', v_cancel_event.id,
          'terminal_kind', 'CANCELLED',
          'termination_reason', 'USER_CANCELLED'
        ))
      );
      IF v_run.terminal_intent_hash IS DISTINCT FROM v_terminal_hash
         OR v_run.status <> 'CANCELLED' THEN
        RAISE EXCEPTION 'claimed cancel replay conflicts with terminal tombstone'
          USING ERRCODE = '23505';
      END IF;
    ELSE
      RAISE EXCEPTION 'claimed finalization replay requires its exact durable source'
        USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
      'run_id', v_run.id, 'status', v_run.status,
      'billing_state', v_run.billing_state,
      'terminal_event_id', v_run.terminal_event_id,
      'terminal_event_sequence', v_run.terminal_event_sequence,
      'finished_at', v_run.finished_at, 'replayed', true
    );
  END IF;
  IF p_fact ->> 'hold_intent_id' IS NOT NULL THEN
    SELECT hold_row.* INTO v_hold
    FROM public.run_recovery_hold_intents AS hold_row
    WHERE hold_row.workspace_id = v_workspace_id
      AND hold_row.id = (p_fact ->> 'hold_intent_id')::uuid
      AND hold_row.run_id = v_run.id
      AND hold_row.resource_kind = 'ATTEMPT'
      AND hold_row.consumed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'recovery HOLD is unavailable or consumed'
        USING ERRCODE = '42501';
    END IF;
    v_terminal_hash := app.g007_sha256(
      'better-agent/run-terminal-intent/2',
      app.g007_canonical_json(jsonb_build_object(
        'source_kind', 'RECOVERY_HOLD', 'source_id', v_hold.id,
        'source_sha256', v_hold.hold_evidence_sha256,
        'terminal_kind', 'NEEDS_ATTENTION',
        'termination_reason', 'SIDE_EFFECT_UNKNOWN'
      ))
    );
    UPDATE public.run_recovery_hold_intents
    SET consumed_at = clock_timestamp()
    WHERE workspace_id = v_workspace_id AND id = v_hold.id;
    v_result := app.apply_g007_terminal_projection(jsonb_build_object(
      'workspace_id', v_workspace_id, 'run_id', v_run.id,
      'status', 'NEEDS_ATTENTION', 'billing_state', 'NEEDS_ATTENTION',
      'termination_reason', 'SIDE_EFFECT_UNKNOWN',
      'terminal_intent_hash', v_terminal_hash,
      'attempt_id', v_hold.resource_id,
      'attempt_status', 'RELINQUISHED',
      'source_kind', 'RECOVERY_HOLD', 'source_id', v_hold.id,
      'source_sha256', v_hold.hold_evidence_sha256
    ));
    RETURN v_result || jsonb_build_object('hold_intent_id', v_hold.id);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.run_attempts AS attempt
    WHERE attempt.workspace_id = v_workspace_id
      AND attempt.run_id = v_run.id
      AND NOT (
        attempt.status = 'PENDING'
        AND attempt.finished_at IS NULL
        AND attempt.lease_owner IS NULL
        AND attempt.lease_token IS NULL
        AND attempt.lease_fencing_token IS NULL
        AND attempt.lease_expires_at IS NULL
        AND (
          (
            attempt.started_at IS NULL
            AND attempt.recovery_ticket_id IS NULL
          )
          OR (
            attempt.recovery_ticket_id IS NOT NULL
            AND attempt.runtime_protocol_version = 5
            AND EXISTS (
              SELECT 1
              FROM public.run_recovery_tickets AS ticket
              WHERE ticket.workspace_id = attempt.workspace_id
                AND ticket.id = attempt.recovery_ticket_id
                AND ticket.run_id = attempt.run_id
                AND ticket.resource_kind = 'ATTEMPT'
                AND ticket.resource_id = attempt.id
                AND ticket.fenced_generation = attempt.lease_generation
                AND ticket.effect_decisions =
                  app.g007_attempt_recovery_effect_decisions(
                    attempt.workspace_id, attempt.run_id, attempt.id
                  )
                AND ticket.effect_decisions_sha256 = app.g007_sha256(
                  'better-agent/run-recovery-effect-decision-set/1',
                  jsonb_build_object(
                    'schema_version', 'run-recovery-effect-decision-set/1',
                    'effect_decisions',
                      app.g007_attempt_recovery_effect_decisions(
                        attempt.workspace_id, attempt.run_id, attempt.id
                      )
                  )::text
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.run_recovery_ticket_dispositions AS disposition
                  WHERE disposition.workspace_id = ticket.workspace_id
                    AND disposition.recovery_ticket_id = ticket.id
                )
            )
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.run_retry_effect_envelopes AS envelope
    LEFT JOIN public.run_side_effect_receipts AS receipt
      ON receipt.workspace_id = envelope.workspace_id
     AND receipt.envelope_id = envelope.id
    WHERE envelope.workspace_id = v_workspace_id
      AND envelope.run_id = v_run.id
      AND (
        envelope.effect_class = 'unsafe'
        OR receipt.disposition = 'UNKNOWN'
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.run_usage_attributions AS attribution
    WHERE attribution.workspace_id = v_workspace_id
      AND attribution.run_id = v_run.id
      AND attribution.consumed_at IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.run_termination_intents AS intent
    WHERE intent.workspace_id = v_workspace_id
      AND intent.run_id = v_run.id
      AND intent.consumed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'durable cancel requires never-started or CLOSED recovery Attempts and no unconsumed producer authority'
      USING ERRCODE = '55000';
  END IF;
  SELECT event_row.* INTO v_cancel_event
  FROM public.run_events AS event_row
  WHERE event_row.workspace_id = v_workspace_id
    AND event_row.id = (p_fact ->> 'cancel_event_id')::uuid
    AND event_row.run_id = v_run.id
    AND event_row.event_type = 'RUN_CANCEL_REQUESTED'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable cancel event is unavailable'
      USING ERRCODE = '42501';
  END IF;
  v_source_kind := 'DURABLE_CANCEL';
  v_source_id := v_cancel_event.id;
  v_terminal_hash := app.g007_sha256(
    'better-agent/run-terminal-intent/2',
    app.g007_canonical_json(jsonb_build_object(
      'source_kind', v_source_kind, 'source_id', v_source_id,
      'terminal_kind', 'CANCELLED',
      'termination_reason', 'USER_CANCELLED'
    ))
  );
  -- The Workspace row lock above serializes billing. Keep the run owner on a
  -- read-only reservation projection and let billing-owner helpers lock rows.
  SELECT
    reservation.id,
    reservation.status,
    reservation.reserved_credits,
    reservation.settled_credits,
    reservation.released_credits
  INTO v_reservation
  FROM public.credit_reservations AS reservation
  WHERE reservation.workspace_id = v_workspace_id
    AND reservation.run_id = v_run.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable cancel reservation is unavailable'
      USING ERRCODE = '23503';
  END IF;
  v_amount := v_reservation.reserved_credits
    - v_reservation.settled_credits - v_reservation.released_credits;
  v_effect_closure := app.g007_sha256(
    'better-agent/run-effect-closure/1',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'attempt_id', attempt.id,
        'effect_closure_sha256', app.g007_attempt_effect_closure_sha256(
          attempt.workspace_id, attempt.run_id, attempt.id
        )
      ) ORDER BY attempt.id)::text
      FROM public.run_attempts AS attempt
      WHERE attempt.workspace_id = v_workspace_id
        AND attempt.run_id = v_run.id
    ), '[]')
  );
  v_cancel_intent_hash := app.g007_sha256(
    'better-agent/run-cancel-intent/1',
    app.g007_canonical_json(jsonb_build_object(
      'workspace_id', v_workspace_id,
      'run_id', v_run.id,
      'cancel_event_id', v_cancel_event.id,
      'cancel_event_sequence', v_cancel_event.sequence::text,
      'payload_redacted', v_cancel_event.payload_redacted
    ))
  );
  v_source := jsonb_build_object(
    'schema_version', 'run-cancellation-release-authority/1',
    'workspace_id', v_workspace_id,
    'run_id', v_run.id,
    'billing_owner_run_id', v_run.id,
    'reservation_id', v_reservation.id,
    'cancel_event_id', v_cancel_event.id,
    'cancel_event_sequence', v_cancel_event.sequence::text,
    'cancel_intent_sha256', v_cancel_intent_hash,
    'terminal_intent_sha256', v_terminal_hash,
    'effect_closure_sha256', v_effect_closure,
    'remaining_credits', v_amount::text,
    'release_operation_key', 'release:cancel:' || v_cancel_event.sequence::text,
    'release_reason_code', 'USER_CANCELLED',
    'authorized_at', app.g007_contract_instant(v_cancel_event.occurred_at)
  );
  v_source_hash := app.g007_sha256(
    'better-agent/run-cancellation-release-source/1',
    app.g007_canonical_json(v_source)
  );
  v_source := v_source || jsonb_build_object('source_authority_hash', v_source_hash);
  IF v_reservation.status = 'HELD' THEN
    INSERT INTO public.finalizer_transaction_claims (
      transaction_id, workspace_id, id, run_id, reservation_id,
      source_kind, source_id, source_sha256, source_fact, terminal_intent_hash,
      effect_closure_sha256, operation, amount
    ) VALUES (
      txid_current(), v_workspace_id, v_claim_id, v_run.id, v_reservation.id,
      v_source_kind, v_source_id, v_source_hash, v_source, v_terminal_hash,
      v_effect_closure,
      'RELEASE', v_amount
    );
    v_ledger_id := app.apply_claimed_release(jsonb_build_object(
      'claim_id', v_claim_id, 'source_kind', v_source_kind,
      'source_id', v_source_id, 'source_sha256', v_source_hash,
      'terminal_intent_hash', v_terminal_hash,
      'operation', 'RELEASE', 'amount', v_amount
    ));
  ELSIF v_amount <> 0 THEN
    RAISE EXCEPTION 'terminal durable-cancel reservation has an unclosed remainder'
      USING ERRCODE = '55000';
  END IF;
  v_result := app.apply_g007_terminal_projection(jsonb_build_object(
    'workspace_id', v_workspace_id, 'run_id', v_run.id,
    'status', 'CANCELLED', 'billing_state', 'SETTLED',
    'termination_reason', 'USER_CANCELLED',
    'terminal_intent_hash', v_terminal_hash,
    'attempt_status', 'CANCELLED',
    'source_kind', v_source_kind, 'source_id', v_source_id,
    'source_sha256', v_source_hash
  ));
  RETURN v_result || jsonb_build_object(
    'ledger_entry_id', v_ledger_id, 'cancel_event_id', v_source_id
  );
END;
$function$;
ALTER FUNCTION app.finalize_claimed_run(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.finalize_claimed_run(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finalize_claimed_run(jsonb) TO ba_finalizer_executor;

CREATE FUNCTION app.reconcile_needs_attention_billing(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('reconciliation');
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact ->> 'evidence_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'charge_attribution_hash') IS DISTINCT FROM
       p_fact ->> 'evidence_sha256' THEN
    RAISE EXCEPTION 'invalid NEEDS_ATTENTION reconciliation evidence'
      USING ERRCODE = '22023';
  END IF;
  RETURN app.reconcile_run_billing(
    v_workspace_id,
    (p_fact ->> 'run_id')::uuid,
    (p_fact ->> 'reservation_id')::uuid,
    (p_fact ->> 'reconciliation_id')::uuid,
    (p_fact ->> 'ledger_entry_id')::uuid,
    p_fact ->> 'idempotency_key',
    p_fact ->> 'billing_intent_hash',
    p_fact ->> 'charge_key',
    p_fact ->> 'charge_attribution_hash',
    (p_fact ->> 'settled_credits')::bigint,
    (p_fact ->> 'released_credits')::bigint,
    p_fact ->> 'evidence_ref',
    p_fact ->> 'evidence_sha256',
    clock_timestamp()
  );
END;
$function$;
ALTER FUNCTION app.reconcile_needs_attention_billing(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.reconcile_needs_attention_billing(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconcile_needs_attention_billing(jsonb) TO ba_reconciliation_executor;

CREATE FUNCTION app.register_phase_run_archive_manifest(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('archive_evidence');
  v_existing public.run_archive_manifests%ROWTYPE;
  v_manifest_id uuid;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR p_fact ? 'workspace_id'
     OR (p_fact ->> 'archive_sha256') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid phase archive manifest request'
      USING ERRCODE = '22023';
  END IF;
  SELECT manifest.* INTO v_existing
  FROM public.run_archive_manifests AS manifest
  WHERE manifest.workspace_id = v_workspace_id
    AND manifest.run_id = (p_fact ->> 'run_id')::uuid;
  IF FOUND THEN
    IF v_existing.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
       OR v_existing.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256' THEN
      RAISE EXCEPTION 'phase archive manifest conflicts with durable evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;
  v_manifest_id := gen_random_uuid();
  RETURN app.register_run_archive_manifest(
    p_fact || jsonb_build_object(
      'workspace_id', v_workspace_id,
      'manifest_id', v_manifest_id,
      'created_at', clock_timestamp()
    )
  );
END;
$function$;
ALTER FUNCTION app.register_phase_run_archive_manifest(jsonb) OWNER TO ba_archive_evidence_owner;
REVOKE ALL ON FUNCTION app.register_phase_run_archive_manifest(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_phase_run_archive_manifest(jsonb) TO ba_archive_evidence_executor;

CREATE FUNCTION app.purge_phase_run_events(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('retention');
BEGIN
  IF jsonb_typeof(p_fact) <> 'object' OR p_fact ? 'workspace_id' THEN
    RAISE EXCEPTION 'invalid phase EVENTS purge request'
      USING ERRCODE = '22023';
  END IF;
  RETURN app.purge_run_events(p_fact || jsonb_build_object(
    'workspace_id', v_workspace_id
  ));
END;
$function$;
ALTER FUNCTION app.purge_phase_run_events(jsonb) OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.purge_phase_run_events(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_phase_run_events(jsonb) TO ba_retention_executor;

CREATE FUNCTION app.purge_phase_run_recovery_material(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('retention');
BEGIN
  IF jsonb_typeof(p_fact) <> 'object' OR p_fact ? 'workspace_id' THEN
    RAISE EXCEPTION 'invalid phase RECOVERY purge request'
      USING ERRCODE = '22023';
  END IF;
  RETURN app.purge_run_recovery_material(p_fact || jsonb_build_object(
    'workspace_id', v_workspace_id
  ));
END;
$function$;
ALTER FUNCTION app.purge_phase_run_recovery_material(jsonb) OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.purge_phase_run_recovery_material(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_phase_run_recovery_material(jsonb) TO ba_retention_executor;

-- Ownership transfer is complete. Runtime owners retain no object-creation
-- capability from this migration.
REVOKE CREATE ON SCHEMA app FROM
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE CREATE ON SCHEMA public FROM
  ba_run_owner,
  ba_billing_owner;
