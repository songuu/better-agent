-- Disposable-only rollback for a pristine, unused G0-07 installation.
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
  public.run_retention_purge_receipts,
  auth.internal_service_attestations,
  public.run_retry_effect_envelopes,
  public.run_side_effect_receipts,
  public.run_usage_attributions,
  public.run_termination_intents,
  public.run_recovery_tickets,
  public.run_recovery_ticket_dispositions,
  public.run_recovery_hold_intents,
  public.run_dispatch_retirement_receipts,
  public.run_billing_authority_receipts,
  public.finalizer_transaction_claims,
  public.phase_operation_audit
IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $g007_down_guard$
DECLARE
  v_bad_legacy_relations text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM better_agent_migrations.schema_migrations
    WHERE version > 5
  ) THEN
    RAISE EXCEPTION 'cannot remove G0-07 while later migrations remain applied'
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(
           format('%I.%I expected owner %I with ENABLE+FORCE RLS',
             expected.schema_name, expected.relation_name, expected.owner_name),
           ', ' ORDER BY expected.schema_name, expected.relation_name
         )
    INTO v_bad_legacy_relations
    FROM (
      VALUES
        ('public', 'run_attempts', 'ba_run_owner'),
        ('public', 'run_checkpoints', 'ba_run_owner'),
        ('public', 'outbox', 'ba_run_owner'),
        ('public', 'credits_ledger', 'ba_billing_owner')
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
    RAISE EXCEPTION 'G0-07 down FORCE-RLS owner prerequisite drift: %',
      v_bad_legacy_relations USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.internal_service_attestations)
     OR EXISTS (SELECT 1 FROM public.run_retry_effect_envelopes)
     OR EXISTS (SELECT 1 FROM public.run_side_effect_receipts)
     OR EXISTS (SELECT 1 FROM public.run_recovery_tickets)
     OR EXISTS (SELECT 1 FROM public.run_recovery_ticket_dispositions)
     OR EXISTS (SELECT 1 FROM public.run_recovery_hold_intents)
     OR EXISTS (SELECT 1 FROM public.run_usage_attributions)
     OR EXISTS (SELECT 1 FROM public.run_termination_intents)
     OR EXISTS (SELECT 1 FROM public.run_dispatch_retirement_receipts)
     OR EXISTS (SELECT 1 FROM public.run_billing_authority_receipts)
     OR EXISTS (SELECT 1 FROM public.phase_operation_audit)
     OR EXISTS (SELECT 1 FROM public.finalizer_transaction_claims) THEN
    RAISE EXCEPTION 'G0-07 security facts exist; rollback requires an unused installation'
      USING ERRCODE = '55000';
  END IF;
END;
$g007_down_guard$;

-- The protocol-v5 columns live on through-004 FORCE-RLS relations whose
-- policies require tenant context. Inspect them as their exact owners while
-- the complete down inventory remains locked, then restore FORCE before any
-- persistent rollback DDL. A rejection rolls the temporary catalog state back.
SET LOCAL ROLE ba_run_owner;
ALTER TABLE public.run_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_checkpoints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outbox NO FORCE ROW LEVEL SECURITY;

DO $g007_down_run_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.run_attempts
    WHERE runtime_protocol_version = 5
       OR lease_generation <> 0
       OR recovery_ticket_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.run_checkpoints
    WHERE runtime_protocol_version = 5
       OR producer_attempt_id IS NOT NULL
       OR producer_lease_token IS NOT NULL
       OR producer_lease_fencing_token IS NOT NULL
       OR producer_session_user IS NOT NULL
       OR producer_lease_expires_at IS NOT NULL
       OR authorized_at IS NOT NULL
       OR checkpoint_sequence IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.outbox
    WHERE delivery_protocol_version = 5
       OR delivery_generation <> 0
       OR recovery_ticket_id IS NOT NULL
       OR delivery_failure_evidence_sha256 IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'G0-07 security facts exist; rollback requires an unused installation'
      USING ERRCODE = '55000';
  END IF;
END;
$g007_down_run_guard$;

ALTER TABLE public.run_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE ROW LEVEL SECURITY;
RESET ROLE;

SET LOCAL ROLE ba_billing_owner;
ALTER TABLE public.credits_ledger NO FORCE ROW LEVEL SECURITY;

DO $g007_down_billing_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.credits_ledger
    WHERE entry_schema_version = 2
       OR authority_schema_version IS NOT NULL
       OR authority_kind IS NOT NULL
       OR authority_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'G0-07 security facts exist; rollback requires an unused installation'
      USING ERRCODE = '55000';
  END IF;
END;
$g007_down_billing_guard$;

ALTER TABLE public.credit_reservations
  DROP CONSTRAINT credit_reservations_balance_version_safe_check;
ALTER TABLE public.credits_ledger
  DROP CONSTRAINT credits_ledger_balance_version_safe_check;
ALTER TABLE public.credits_ledger FORCE ROW LEVEL SECURITY;
RESET ROLE;

SET LOCAL ROLE ba_authorization_owner;
ALTER TABLE public.workspaces
  DROP CONSTRAINT workspaces_credits_balance_version_safe_check;
RESET ROLE;

-- Restoring the reviewed 004 function owners has the same PostgreSQL schema
-- CREATE prerequisite as forward ownership transfer. Revoke it before commit.
GRANT USAGE, CREATE ON SCHEMA app TO
  ba_run_owner,
  ba_billing_owner;

REVOKE EXECUTE ON FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text)
FROM ba_admission_executor, ba_execution_executor, ba_metering_executor,
  ba_finalizer_executor, ba_reclaimer_executor, ba_reconciliation_executor,
  ba_archive_evidence_executor, ba_retention_executor;
REVOKE EXECUTE ON FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, name, text, text, bytea, bytea, timestamptz
) FROM ba_internal_service_attestation_issuer;
REVOKE EXECUTE ON FUNCTION auth.revoke_internal_service_attestation(uuid, text)
FROM ba_internal_service_attestation_issuer;
REVOKE USAGE ON SCHEMA auth FROM ba_internal_service_attestation_issuer;
REVOKE USAGE ON SCHEMA auth FROM
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE USAGE ON SCHEMA app, auth FROM
  ba_admission_executor,
  ba_execution_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reclaimer_executor,
  ba_reconciliation_executor,
  ba_archive_evidence_executor,
  ba_retention_executor;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP FUNCTION app.finalize_claimed_run(jsonb);
DROP FUNCTION app.finalize_attributed_run(jsonb);
DROP FUNCTION app.apply_g007_terminal_projection(jsonb);
DROP FUNCTION app.retire_run_dispatches_for_finalizer(jsonb);
DROP FUNCTION app.retire_run_attempts_for_finalizer(jsonb);
DROP FUNCTION app.record_recovery_hold_intent(jsonb);
DROP FUNCTION app.fence_expired_run_dispatch(jsonb);
DROP FUNCTION app.fence_expired_run_attempt(jsonb);
DROP FUNCTION app.fail_run_dispatch(jsonb);
DROP FUNCTION app.complete_run_dispatch(jsonb);
DROP FUNCTION app.renew_run_dispatch_lease(jsonb);
DROP FUNCTION app.claim_run_dispatch(jsonb);
DROP FUNCTION app.require_run_dispatch_lease(jsonb);
DROP FUNCTION app.record_leased_termination_intent(jsonb);
DROP FUNCTION app.record_usage_attribution(jsonb);
DROP FUNCTION app.record_execution_effect_receipt(jsonb);
DROP FUNCTION app.record_execution_effect_envelope(jsonb);
DROP FUNCTION app.record_execution_checkpoint(jsonb);
DROP FUNCTION app.record_step_finished(jsonb);
DROP FUNCTION app.record_step_started(jsonb);
DROP FUNCTION app.record_attempt_finished(jsonb);
DROP FUNCTION app.record_attempt_recovering(jsonb);
DROP FUNCTION app.record_attempt_retry_wait(jsonb);
DROP FUNCTION app.record_attempt_started(jsonb);
DROP FUNCTION app.record_execution_progress(jsonb, text);
DROP FUNCTION app.relinquish_run_attempt_lease(jsonb);
DROP FUNCTION app.renew_run_attempt_lease(jsonb);
DROP FUNCTION app.claim_run_attempt(jsonb);

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
DROP FUNCTION app.reconcile_needs_attention_billing(jsonb);
DROP FUNCTION app.lock_finalizer_workspace_billing_fence();
DROP FUNCTION app.settle_attributed_credits(jsonb);
DROP FUNCTION app.apply_claimed_release(jsonb);
DROP FUNCTION app.apply_attributed_release(jsonb);
DROP FUNCTION app.apply_attributed_settlement(jsonb);
DROP FUNCTION app.apply_credit_release_kernel(jsonb);
DROP FUNCTION app.apply_credit_settlement_kernel(jsonb);

RESET ROLE;
SET LOCAL ROLE ba_archive_evidence_owner;
DROP FUNCTION app.register_phase_run_archive_manifest(jsonb);

RESET ROLE;
SET LOCAL ROLE ba_retention;
DROP FUNCTION app.purge_phase_run_recovery_material(jsonb);
DROP FUNCTION app.purge_phase_run_events(jsonb);

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP FUNCTION app.lock_open_run_for_attributed_settlement(uuid, uuid);
DROP FUNCTION app.require_transaction_finalizer_claim(jsonb);
DROP FUNCTION app.require_committed_producer_attribution(jsonb);
DROP FUNCTION app.require_execution_owner_lease(jsonb);

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
DROP FUNCTION auth.require_internal_service_phase(text);
DROP FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text);
DROP FUNCTION auth.revoke_internal_service_attestation(uuid, text);
DROP FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, name, text, text, bytea, bytea, timestamptz
);

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP TRIGGER finalizer_transaction_claims_must_be_consumed
  ON public.finalizer_transaction_claims;
DROP TRIGGER run_recovery_ticket_dispositions_validate
  ON public.run_recovery_ticket_dispositions;
DROP TRIGGER run_recovery_tickets_validate
  ON public.run_recovery_tickets;
DROP TRIGGER run_recovery_hold_intents_validate
  ON public.run_recovery_hold_intents;
DROP TRIGGER run_recovery_hold_intents_controlled_change
  ON public.run_recovery_hold_intents;
DROP TRIGGER run_termination_intents_controlled_change
  ON public.run_termination_intents;
DROP TRIGGER run_usage_attributions_controlled_change
  ON public.run_usage_attributions;
DROP TRIGGER run_retry_effect_envelopes_immutable
  ON public.run_retry_effect_envelopes;
DROP TRIGGER run_side_effect_receipts_immutable
  ON public.run_side_effect_receipts;
DROP TRIGGER run_recovery_tickets_immutable
  ON public.run_recovery_tickets;
DROP TRIGGER run_recovery_ticket_dispositions_immutable
  ON public.run_recovery_ticket_dispositions;
DROP TRIGGER run_dispatch_retirement_receipts_immutable
  ON public.run_dispatch_retirement_receipts;
DROP TRIGGER phase_operation_audit_immutable
  ON public.phase_operation_audit;

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
DROP TRIGGER run_billing_authority_receipts_immutable
  ON public.run_billing_authority_receipts;

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
DROP TRIGGER internal_service_attestations_controlled_change
  ON auth.internal_service_attestations;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP FUNCTION app.require_consumed_finalizer_claim_at_commit();
DROP FUNCTION app.validate_g007_recovery_ticket();
DROP FUNCTION app.validate_recovery_ticket_disposition();
DROP FUNCTION app.g007_attempt_recovery_effect_decisions(uuid, uuid, uuid);
DROP FUNCTION app.g007_attempt_effect_closure_sha256(uuid, uuid, uuid);
DROP FUNCTION app.g007_contract_instant(timestamptz);
DROP FUNCTION app.g007_canonical_sha256(jsonb);
DROP FUNCTION app.g007_canonical_json(jsonb);
DROP FUNCTION app.enforce_g007_single_consumption();
DROP FUNCTION app.reject_g007_immutable_change();

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
DROP FUNCTION auth.enforce_internal_service_attestation_change();

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP POLICY finalizer_transaction_claims_owner_access
  ON public.finalizer_transaction_claims;
DROP POLICY phase_operation_audit_owner_access ON public.phase_operation_audit;
DROP POLICY run_dispatch_retirement_receipts_owner_access
  ON public.run_dispatch_retirement_receipts;
DROP POLICY run_recovery_hold_intents_owner_access
  ON public.run_recovery_hold_intents;
DROP POLICY run_recovery_ticket_dispositions_owner_access
  ON public.run_recovery_ticket_dispositions;
DROP POLICY run_recovery_tickets_owner_access ON public.run_recovery_tickets;
DROP POLICY run_termination_intents_owner_access ON public.run_termination_intents;
DROP POLICY run_usage_attributions_owner_access ON public.run_usage_attributions;
DROP POLICY run_side_effect_receipts_owner_access ON public.run_side_effect_receipts;
DROP POLICY run_retry_effect_envelopes_owner_access
  ON public.run_retry_effect_envelopes;

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
DROP POLICY run_billing_authority_receipts_billing_owner_access
  ON public.run_billing_authority_receipts;
DROP POLICY run_billing_authority_receipts_run_owner_access
  ON public.run_billing_authority_receipts;
DROP POLICY run_billing_authority_receipts_run_owner_insert
  ON public.run_billing_authority_receipts;
DROP POLICY credit_reservations_g007_run_owner_read
  ON public.credit_reservations;
REVOKE SELECT (
  workspace_id,
  id,
  run_id,
  billing_owner_run_id,
  status,
  reserved_credits,
  settled_credits,
  released_credits
) ON TABLE public.credit_reservations FROM ba_run_owner;

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
DROP POLICY internal_service_attestations_owner_access
  ON auth.internal_service_attestations;

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
ALTER TABLE public.credits_ledger
  DROP CONSTRAINT credits_ledger_authority_fkey;
ALTER TABLE public.run_billing_authority_receipts
  DROP CONSTRAINT run_billing_authority_receipts_ledger_fkey;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
ALTER TABLE public.run_attempts
  DROP CONSTRAINT run_attempts_recovery_ticket_fkey;
ALTER TABLE public.outbox
  DROP CONSTRAINT outbox_recovery_ticket_fkey;
DROP TABLE public.finalizer_transaction_claims;
DROP TABLE public.phase_operation_audit;
DROP TABLE public.run_dispatch_retirement_receipts;
DROP TABLE public.run_recovery_ticket_dispositions;
DROP TABLE public.run_recovery_hold_intents;
DROP TABLE public.run_recovery_tickets;
DROP TABLE public.run_termination_intents;
DROP TABLE public.run_usage_attributions;
DROP TABLE public.run_side_effect_receipts;
DROP TABLE public.run_retry_effect_envelopes;

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
REVOKE SELECT, INSERT ON TABLE public.run_billing_authority_receipts
FROM ba_run_owner;
DROP TABLE public.run_billing_authority_receipts;
ALTER TABLE public.credits_ledger
  DROP CONSTRAINT credits_ledger_authority_binding_key,
  DROP CONSTRAINT credits_ledger_authority_shape_check,
  DROP CONSTRAINT credits_ledger_metering_detail_json_check,
  DROP CONSTRAINT credits_ledger_entry_schema_check,
  DROP COLUMN authority_id,
  DROP COLUMN authority_kind,
  DROP COLUMN authority_schema_version,
  DROP COLUMN entry_schema_version,
  ADD CONSTRAINT credits_ledger_producer_shape_check CHECK (
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
  );

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
ALTER TABLE public.outbox
  DROP CONSTRAINT outbox_delivery_failure_evidence_check,
  DROP CONSTRAINT outbox_protocol_v5_generation_check,
  DROP CONSTRAINT outbox_delivery_protocol_check,
  DROP COLUMN delivery_failure_evidence_sha256,
  DROP COLUMN recovery_ticket_id,
  DROP COLUMN delivery_generation,
  DROP COLUMN delivery_protocol_version;
ALTER TABLE public.run_checkpoints
  DROP CONSTRAINT run_checkpoints_producer_attempt_fkey,
  DROP CONSTRAINT run_checkpoints_protocol_v5_shape_check,
  DROP CONSTRAINT run_checkpoints_sequence_key,
  DROP CONSTRAINT run_checkpoints_sequence_check,
  DROP CONSTRAINT run_checkpoints_runtime_protocol_check,
  DROP COLUMN runtime_protocol_version,
  DROP COLUMN lease_expires_at,
  DROP COLUMN lease_fencing_token,
  DROP COLUMN lease_token,
  DROP COLUMN lease_owner,
  DROP COLUMN checkpoint_sha256,
  DROP COLUMN checkpoint_ref,
  DROP COLUMN attempt_id,
  DROP COLUMN checkpoint_id,
  DROP COLUMN schema_version,
  DROP COLUMN checkpoint_sequence,
  DROP COLUMN authorized_at,
  DROP COLUMN producer_lease_expires_at,
  DROP COLUMN producer_session_user,
  DROP COLUMN producer_lease_fencing_token,
  DROP COLUMN producer_lease_token,
  DROP COLUMN producer_attempt_id;
ALTER TABLE public.run_attempts
  DROP CONSTRAINT run_attempts_protocol_v5_state_check,
  DROP CONSTRAINT run_attempts_protocol_v5_fence_check,
  DROP CONSTRAINT run_attempts_runtime_protocol_check,
  DROP COLUMN updated_at,
  DROP COLUMN recovery_ticket_id,
  DROP COLUMN lease_generation,
  DROP COLUMN runtime_protocol_version;

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
DROP TABLE auth.internal_service_attestations;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP FUNCTION app.g007_sha256(text, text);

-- Bootstrap roles are platform-owned and intentionally remain dormant.
RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
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

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
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
     OR length(btrim(p_charge_key)) NOT BETWEEN 1 AND 300
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
     OR length(btrim(p_charge_key)) NOT BETWEEN 1 AND 300
     OR length(btrim(p_reason_code)) = 0
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

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
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
DROP FUNCTION app.g007_json_numbers_are_finite(jsonb);

RESET ROLE;

REVOKE CREATE ON SCHEMA app FROM
  ba_run_owner,
  ba_billing_owner;
