-- G0-06 facts are durable security and financial history. Down is reviewed
-- only for a completely unused catalog and is filled in reverse dependency
-- order below; any later migration or durable fact fails closed.

DO $g006_later_migration_guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM better_agent_migrations.schema_migrations
     WHERE version > 4
  ) THEN
    RAISE EXCEPTION 'cannot remove G0-06 while later migrations remain applied'
      USING ERRCODE = '55000';
  END IF;
END;
$g006_later_migration_guard$;

SET LOCAL ROLE ba_run_owner;
DO $g006_run_fact_guard$
DECLARE
  v_table text;
  v_has_facts boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'conversations',
    'conversation_states',
    'conversation_messages',
    'run_idempotency_sentinels',
    'runs',
    'run_acceptance_receipts',
    'run_mutation_idempotency',
    'run_attempts',
    'run_steps',
    'run_events',
    'run_checkpoints',
    'human_gates',
    'outbox',
    'run_parent_links'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', v_table)
      INTO v_has_facts;
    IF v_has_facts THEN
      RAISE EXCEPTION 'cannot remove G0-06: public.% contains durable facts', v_table
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$g006_run_fact_guard$;

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
DO $g006_billing_fact_guard$
DECLARE
  v_table text;
  v_has_facts boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'credit_reservations',
    'credits_ledger',
    'run_budget_allocations',
    'run_billing_reconciliations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', v_table)
      INTO v_has_facts;
    IF v_has_facts THEN
      RAISE EXCEPTION 'cannot remove G0-06: public.% contains durable billing facts', v_table
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$g006_billing_fact_guard$;

RESET ROLE;
SET LOCAL ROLE ba_archive_evidence_owner;
DO $g006_archive_fact_guard$
DECLARE
  v_table text;
  v_has_facts boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'run_archive_manifests',
    'run_archive_verification_receipts',
    'run_archive_approval_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', v_table)
      INTO v_has_facts;
    IF v_has_facts THEN
      RAISE EXCEPTION 'cannot remove G0-06: public.% contains durable archive facts', v_table
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$g006_archive_fact_guard$;

RESET ROLE;
SET LOCAL ROLE ba_retention;
ALTER TABLE public.run_retention_purge_receipts NO FORCE ROW LEVEL SECURITY;
DO $g006_retention_fact_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.run_retention_purge_receipts) THEN
    RAISE EXCEPTION 'cannot remove G0-06: durable retention receipts exist'
      USING ERRCODE = '55000';
  END IF;
END;
$g006_retention_fact_guard$;

-- Remove all callers before the owner-only validators and relation types they
-- reference. No CASCADE is used: an unreviewed later dependency fails closed.
RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP FUNCTION app.request_run_cancellation(jsonb);
DROP FUNCTION app.read_original_run_events(uuid, jsonb);
DROP FUNCTION app.read_original_run(uuid, jsonb);
DROP FUNCTION app.lock_original_run_idempotency_namespace(jsonb);
DROP FUNCTION app.require_original_run_authorization(uuid, text, jsonb);
DROP FUNCTION app.finalize_run(jsonb);
DROP FUNCTION app.accept_prepared_flow_run(jsonb);
DROP FUNCTION app.accept_prepared_agent_chat_run(jsonb);
DROP FUNCTION app.create_prepared_conversation(jsonb);
DROP FUNCTION app.create_child_run(jsonb);
DROP FUNCTION app.mutate_human_gate(text, jsonb);

RESET ROLE;
SET LOCAL ROLE ba_retention;
DROP FUNCTION app.purge_run_recovery_material(jsonb);
DROP FUNCTION app.purge_run_events(jsonb);

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP FUNCTION app.lock_run_retention_summary(uuid, uuid);

RESET ROLE;
SET LOCAL ROLE ba_archive_evidence_owner;
DROP FUNCTION app.approve_run_archive(jsonb);
DROP FUNCTION app.verify_run_archive(jsonb);
DROP FUNCTION app.register_run_archive_manifest(jsonb);

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
DROP FUNCTION app.allocate_child_run_budget(jsonb);
DROP FUNCTION app.reconcile_run_billing(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text,
  bigint, bigint, text, text, timestamptz
);
DROP FUNCTION app.expire_credit_reservation(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz
);
DROP FUNCTION app.release_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, text, timestamptz
);
DROP FUNCTION app.settle_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, jsonb, timestamptz
);
DROP FUNCTION app.reserve_credits(
  uuid, uuid, uuid, uuid, bigint, text, text, text, text,
  timestamptz, timestamptz
);
DROP FUNCTION app.lock_billing_reservation_summary(uuid, uuid, uuid);
DROP FUNCTION app.lock_billing_workspace(uuid);

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
DROP FUNCTION auth.authorize_browser_original_run(
  uuid, uuid, uuid, uuid, text, bigint, bigint, bigint
);
DROP FUNCTION auth.authenticate_browser_session_identity(
  uuid, bytea, text, text, text
);
CREATE OR REPLACE FUNCTION auth.authenticate_browser_session_facts(
  p_browser_session_id uuid,
  p_presented_verifier_hmac bytea,
  p_actual_origin text,
  p_token_audience text,
  p_client_channel text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_private auth.browser_session_auth_index%ROWTYPE;
  v_facts jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER')
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
     OR p_browser_session_id IS NULL
     OR p_presented_verifier_hmac IS NULL
     OR octet_length(p_presented_verifier_hmac) <> 32
     OR NOT auth.is_canonical_https_origin(p_actual_origin)
     OR p_token_audience <> 'agent_browser_api'
     OR p_client_channel NOT IN ('WEB_SDK', 'DINGTALK_WEB') THEN
    RAISE EXCEPTION 'invalid browser session authentication request'
      USING ERRCODE = '42501';
  END IF;

  SELECT private_row.*
    INTO v_private
    FROM auth.browser_session_auth_index AS private_row
   WHERE private_row.browser_session_id = p_browser_session_id
   FOR SHARE OF private_row;
  IF NOT FOUND
     OR v_private.status <> 'ACTIVE'
     OR v_private.expires_at <= v_now
     OR NOT auth.constant_time_equal_32(
       v_private.verifier_hmac, p_presented_verifier_hmac
     ) THEN
    RAISE EXCEPTION 'browser session authentication rejected'
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 'agent-deployment-entry-admission-facts/1',
    'deployment_kind', 'agent',
    'entry_source_kind', 'browser_session',
    'workspace_id', session_row.workspace_id,
    'agent_deployment_id', deployment.id,
    'agent_deployment_revision_id', revision.id,
    'agent_deployment_revision_contract_hash', revision.revision_contract_hash,
    'agent_release', jsonb_build_object(
      'workspace_id', revision.workspace_id,
      'published_resource_kind', 'AGENT_RELEASE',
      'resource_id', revision.agent_id,
      'resource_version_id', revision.agent_release_id,
      'contract_hash', revision.agent_release_contract_hash,
      'binding_mode', 'pinned'
    ),
    'experience_release', jsonb_build_object(
      'workspace_id', revision.workspace_id,
      'published_resource_kind', 'EXPERIENCE_RELEASE',
      'resource_id', revision.experience_id,
      'resource_version_id', revision.experience_release_id,
      'contract_hash', revision.experience_contract_hash,
      'binding_mode', 'pinned'
    ),
    'environment', deployment.environment,
    'ingress_channel', 'browser',
    'admission_activation_epoch', pointer.activation_epoch,
    'observed_revoke_epoch', security.revoke_epoch,
    'workspace_authorization_epoch', workspace.authorization_epoch,
    'authenticated_principal', jsonb_build_object(
      'schema_version', 'caller-principal/1',
      'kind', 'end_user',
      'end_user_principal_id', principal.id
    ),
    'browser_session_id', session_row.id,
    'public_selector', deployment.public_selector,
    'client_channel', session_row.client_channel,
    'canonical_origin', session_row.canonical_origin,
    'token_audience', session_row.token_audience,
    'session_epoch', session_row.session_epoch,
    'observed_principal_session_epoch', principal.session_epoch,
    'policy_profile_contract_hash', revision.policy_profile_contract_hash,
    'entry_scope_policy_contract_hash', revision.entry_scope_policy_contract_hash,
    'credential_mapping_hash', revision.credential_mapping_hash,
    'dependency_manifest_hash', revision.dependency_manifest_hash
  )
    INTO v_facts
    FROM public.browser_sessions AS session_row
    JOIN public.end_user_principals AS principal
      ON principal.workspace_id = session_row.workspace_id
     AND principal.id = session_row.principal_id
    JOIN public.agent_deployments AS deployment
      ON deployment.workspace_id = session_row.workspace_id
     AND deployment.id = session_row.agent_deployment_id
    JOIN public.agent_deployment_security_states AS security
      ON security.workspace_id = deployment.workspace_id
     AND security.agent_deployment_id = deployment.id
    JOIN public.agent_deployment_active_pointers AS pointer
      ON pointer.workspace_id = deployment.workspace_id
     AND pointer.agent_deployment_id = deployment.id
    JOIN public.agent_deployment_revisions AS revision
      ON revision.workspace_id = pointer.workspace_id
     AND revision.id = pointer.active_revision_id
     AND revision.agent_deployment_id = deployment.id
    JOIN public.workspaces AS workspace
      ON workspace.id = session_row.workspace_id
   WHERE session_row.workspace_id = v_private.workspace_id
     AND session_row.id = v_private.browser_session_id
     AND session_row.status = 'ACTIVE'
     AND session_row.session_epoch = v_private.session_epoch
     AND session_row.expires_at = v_private.expires_at
     AND session_row.expires_at > v_now
     AND session_row.canonical_origin = p_actual_origin
     AND session_row.token_audience = p_token_audience
     AND session_row.client_channel = p_client_channel
     AND principal.status = 'active'
     AND principal.session_epoch = session_row.observed_principal_session_epoch
     AND security.status = 'ACTIVE'
     AND security.revoke_epoch = session_row.observed_deployment_revoke_epoch
     AND revision.ingress_channel = 'browser'
     AND p_actual_origin = ANY(revision.allowed_origins)
     AND p_client_channel = ANY(revision.browser_client_channels)
     AND revision.session_token_audience = p_token_audience
   FOR SHARE OF session_row, principal, deployment, security, pointer, revision, workspace;
  IF v_facts IS NULL THEN
    RAISE EXCEPTION 'browser session lifecycle or bound Deployment facts rejected'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_facts;
END;
$function$;

RESET ROLE;
SET LOCAL ROLE ba_authorization_owner;
DROP FUNCTION app.authorize_flow_original_run(uuid, uuid, uuid, text, timestamptz);
DROP FUNCTION app.authorize_agent_original_run(uuid, uuid, uuid, text, timestamptz);
DROP FUNCTION app.validate_flow_acceptance_target(uuid, uuid, uuid, uuid, uuid);
DROP FUNCTION app.validate_agent_acceptance_target(
  uuid, uuid, uuid, uuid, uuid, uuid, text
);

-- Restore every G0-05 object touched by 004 before dropping the new facts.
DROP POLICY agent_deployments_g006_authorization_owner_read
  ON public.agent_deployments;
DROP POLICY agent_deployment_security_g006_authorization_owner_read
  ON public.agent_deployment_security_states;
DROP POLICY agent_deployment_revisions_g006_authorization_owner_read
  ON public.agent_deployment_revisions;
DROP POLICY agent_deployment_pointers_g006_authorization_owner_read
  ON public.agent_deployment_active_pointers;
DROP POLICY agent_deployment_grants_g006_authorization_owner_read
  ON public.agent_deployment_entry_grants;
DROP POLICY flow_deployments_g006_authorization_owner_read
  ON public.flow_deployments;
DROP POLICY flow_deployment_security_g006_authorization_owner_read
  ON public.flow_deployment_security_states;
DROP POLICY flow_deployment_revisions_g006_authorization_owner_read
  ON public.flow_deployment_revisions;
DROP POLICY flow_deployment_pointers_g006_authorization_owner_read
  ON public.flow_deployment_active_pointers;
DROP POLICY flow_deployment_grants_g006_authorization_owner_read
  ON public.flow_deployment_entry_grants;

RESET ROLE;
SET LOCAL ROLE ba_authorization_owner;
DROP POLICY workspaces_g006_billing_owner_update ON public.workspaces;
DROP POLICY workspaces_g006_billing_owner_read ON public.workspaces;
REVOKE UPDATE (
  credits_balance,
  credits_reserved_balance,
  credits_balance_version
) ON TABLE public.workspaces FROM ba_billing_owner;
REVOKE SELECT (
  id,
  credits_balance,
  credits_reserved_balance,
  credits_balance_version
) ON TABLE public.workspaces FROM ba_billing_owner;

-- New relations in strict reverse dependency order.
RESET ROLE;
SET LOCAL ROLE ba_retention;
DROP TABLE public.run_retention_purge_receipts;

RESET ROLE;
SET LOCAL ROLE ba_archive_evidence_owner;
DROP TABLE public.run_archive_approval_receipts;
DROP TABLE public.run_archive_verification_receipts;
DROP TABLE public.run_archive_manifests;

RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
DROP TABLE public.run_billing_reconciliations;
DROP TABLE public.run_budget_allocations;
DROP TABLE public.credits_ledger;
DROP TABLE public.credit_reservations;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
DROP TABLE public.run_parent_links;
DROP TABLE public.outbox;
DROP TABLE public.human_gates;
DROP TABLE public.run_checkpoints;
DROP TABLE public.run_events;
DROP TABLE public.run_steps;
DROP TABLE public.run_attempts;
DROP TABLE public.run_mutation_idempotency;
DROP TABLE public.run_acceptance_receipts;
DROP TABLE public.runs;
DROP TABLE public.run_idempotency_sentinels;
DROP TABLE public.conversation_messages;
DROP TABLE public.conversation_states;
DROP TABLE public.conversations;

DROP FUNCTION app.validate_billing_producer(uuid, uuid, uuid, uuid, bigint, uuid);
DROP FUNCTION app.protect_run_change();
DROP FUNCTION app.protect_run_event_change();
DROP FUNCTION app.reject_g006_unavailable_path();
DROP FUNCTION app.reject_g006_immutable_change();

RESET ROLE;
SET LOCAL ROLE ba_authorization_owner;
ALTER TABLE public.agent_deployment_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_deployment_revisions DISABLE TRIGGER g005_immutable;
ALTER TABLE public.agent_deployment_revisions
  DROP CONSTRAINT agent_deployment_revisions_run_target_pin_key,
  DROP CONSTRAINT agent_deployment_revisions_conversation_contract_pin_key,
  DROP CONSTRAINT agent_deployment_revisions_conversation_contract_hash_check,
  DROP COLUMN conversation_contract_hash;
ALTER TABLE public.agent_deployment_revisions ENABLE TRIGGER g005_immutable;
ALTER TABLE public.agent_deployment_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.flow_deployment_revisions
  DROP CONSTRAINT flow_deployment_revisions_run_target_pin_key;

-- Restore the exact pre-004 signed context readers. In particular, 003 has no
-- browser tenant-context variant; its active-pointer browser admission remains
-- a separate function and is not reused for historical Run access.
RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
CREATE OR REPLACE FUNCTION app.current_workspace_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
DECLARE
  v_context text := current_setting('app.tenant_context', true);
  v_context_parts text[];
  v_workspace_id uuid;
  v_credential_id uuid;
  v_attestation_id uuid;
  v_principal_id uuid;
  v_txid bigint;
  v_signature text;
  v_expected_signature text;
BEGIN
  IF v_context IS NULL OR v_context = '' THEN
    RETURN NULL;
  END IF;

  v_context_parts := string_to_array(v_context, ':');

  IF array_length(v_context_parts, 1) = 6
     AND v_context_parts[1] = 'control' THEN
    v_workspace_id := v_context_parts[2]::uuid;
    v_attestation_id := v_context_parts[3]::uuid;
    v_principal_id := v_context_parts[4]::uuid;
    v_txid := v_context_parts[5]::bigint;
    v_signature := v_context_parts[6];

    IF v_txid <> txid_current() OR v_signature !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;

    SELECT encode(
      public.hmac(
        convert_to(
          format(
            'control:%s:%s:%s:%s:%s',
            att.workspace_id,
            att.id,
            att.principal_id,
            v_txid,
            session_user
          ),
          'UTF8'
        ),
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

    IF v_expected_signature IS NULL
       OR NOT auth.constant_time_equal_32(
         decode(v_signature, 'hex'),
         decode(v_expected_signature, 'hex')
       ) THEN
      RETURN NULL;
    END IF;

    RETURN v_workspace_id;
  END IF;

  IF array_length(v_context_parts, 1) = 5
     AND v_context_parts[1] = 'credential' THEN
    v_workspace_id := v_context_parts[2]::uuid;
    v_credential_id := v_context_parts[3]::uuid;
    v_txid := v_context_parts[4]::bigint;
    v_signature := v_context_parts[5];

    IF v_txid <> txid_current() OR v_signature !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;

    SELECT encode(
      public.hmac(
        convert_to(
          format(
            'credential:%s:%s:%s:%s',
            idx.workspace_id,
            idx.credential_id,
            v_txid,
            session_user
          ),
          'UTF8'
        ),
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

    IF v_expected_signature IS NULL
       OR NOT auth.constant_time_equal_32(
         decode(v_signature, 'hex'),
         decode(v_expected_signature, 'hex')
       ) THEN
      RETURN NULL;
    END IF;

    RETURN v_workspace_id;
  END IF;

  RETURN NULL;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION app.current_authenticated_principal_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
DECLARE
  v_context text := current_setting('app.tenant_context', true);
  v_context_parts text[];
  v_workspace_id uuid;
BEGIN
  v_workspace_id := app.current_workspace_id();
  IF v_workspace_id IS NULL OR v_context IS NULL OR v_context = '' THEN
    RETURN NULL;
  END IF;

  v_context_parts := string_to_array(v_context, ':');
  IF array_length(v_context_parts, 1) = 5
     AND v_context_parts[1] = 'credential'
     AND v_context_parts[2]::uuid = v_workspace_id THEN
    RETURN 'credential:' || v_context_parts[3]::uuid::text;
  END IF;

  IF array_length(v_context_parts, 1) = 6
     AND v_context_parts[1] = 'control'
     AND v_context_parts[2]::uuid = v_workspace_id THEN
    RETURN 'user:' || v_context_parts[4]::uuid::text;
  END IF;

  RETURN NULL;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION app.current_workspace_id() FROM
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE EXECUTE ON FUNCTION app.current_authenticated_principal_id(),
  app.current_api_credential_id() FROM ba_run_owner;

RESET ROLE;
REVOKE USAGE ON SCHEMA auth FROM ba_run_owner;
REVOKE USAGE ON SCHEMA app FROM
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
