-- G0-06 durable Run, Conversation, billing, outbox, HumanGate and retention
-- facts. This migration is an incremental consumer of the G0-05 typed
-- Deployment registry. It deliberately creates no G0-07 executor, lease,
-- fencing or attestation role and grants no application mutation path except
-- reviewed target-bound original-Run read/events/cancellation functions.

DO $g006_platform_prerequisites$
DECLARE
  v_missing_roles text;
  v_unsafe_roles text;
  v_session_is_unsafe boolean;
  v_admin_count integer;
BEGIN
  SELECT pg_catalog.string_agg(required.role_name, ', ' ORDER BY required.role_name)
    INTO v_missing_roles
    FROM (
      VALUES
        ('ba_migrator'),
        ('ba_runtime'),
        ('ba_control_executor'),
        ('ba_management_attestation_issuer'),
        ('ba_subject_assertion_verifier'),
        ('ba_auth_owner'),
        ('ba_authorization_owner'),
        ('ba_run_owner'),
        ('ba_billing_owner'),
        ('ba_archive_evidence_owner'),
        ('ba_retention')
    ) AS required(role_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = required.role_name
   );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'missing required G0-06 platform roles: %', v_missing_roles
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.string_agg(role_row.rolname, ', ' ORDER BY role_row.rolname)
    INTO v_unsafe_roles
    FROM pg_catalog.pg_roles AS role_row
   WHERE role_row.rolname = ANY (ARRAY[
     'ba_migrator',
     'ba_runtime',
     'ba_control_executor',
     'ba_management_attestation_issuer',
     'ba_subject_assertion_verifier'
   ])
     AND (
       role_row.rolcanlogin
       OR role_row.rolsuper
       OR role_row.rolcreatedb
       OR role_row.rolcreaterole
       OR role_row.rolreplication
       OR role_row.rolbypassrls
     );

  IF v_unsafe_roles IS NOT NULL THEN
    RAISE EXCEPTION 'platform migration roles must be NOLOGIN and unprivileged: %',
      v_unsafe_roles USING ERRCODE = '55000';
  END IF;

  SELECT (
    NOT role_row.rolcanlogin
    OR NOT role_row.rolinherit
    OR role_row.rolsuper
    OR role_row.rolcreatedb
    OR role_row.rolcreaterole
    OR role_row.rolreplication
    OR role_row.rolbypassrls
  )
    INTO v_session_is_unsafe
    FROM pg_catalog.pg_roles AS role_row
   WHERE role_row.rolname = session_user;

  IF COALESCE(v_session_is_unsafe, true) THEN
    RAISE EXCEPTION 'application migrations require an unprivileged LOGIN+INHERIT session_user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role
        ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
     WHERE granted_role.rolname = 'ba_migrator'
       AND member_role.rolname = session_user
       AND membership.inherit_option
  ) THEN
    RAISE EXCEPTION 'session_user must be a direct inheriting ba_migrator member'
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.string_agg(role_row.rolname, ', ' ORDER BY role_row.rolname)
    INTO v_unsafe_roles
    FROM pg_catalog.pg_roles AS role_row
   WHERE role_row.rolname = ANY (ARRAY[
     'ba_auth_owner',
     'ba_authorization_owner',
     'ba_run_owner',
     'ba_billing_owner',
     'ba_archive_evidence_owner',
     'ba_retention'
   ])
     AND (
       role_row.rolcanlogin
       OR role_row.rolinherit
       OR role_row.rolsuper
       OR role_row.rolcreatedb
       OR role_row.rolcreaterole
       OR role_row.rolreplication
       OR role_row.rolbypassrls
     );

  IF v_unsafe_roles IS NOT NULL THEN
    RAISE EXCEPTION 'G0-06 owners must be NOLOGIN/NOINHERIT and unprivileged: %',
      v_unsafe_roles USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
    INTO v_admin_count
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
   WHERE granted_role.rolname = ANY (ARRAY[
     'ba_auth_owner',
     'ba_authorization_owner',
     'ba_run_owner',
     'ba_billing_owner',
     'ba_archive_evidence_owner',
     'ba_retention'
   ])
     AND member_role.rolname = 'ba_migrator'
     AND membership.admin_option;

  IF v_admin_count <> 6 THEN
    RAISE EXCEPTION 'ba_migrator requires ADMIN OPTION on every G0-06 owner'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role
        ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
     WHERE granted_role.rolname = ANY (ARRAY[
       'ba_auth_owner',
       'ba_authorization_owner',
       'ba_run_owner',
       'ba_billing_owner',
       'ba_archive_evidence_owner',
       'ba_retention'
     ])
       AND member_role.rolname <> 'ba_migrator'
  ) THEN
    RAISE EXCEPTION 'G0-06 owners may only be granted directly to ba_migrator'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS login_role
     WHERE login_role.rolcanlogin
       AND NOT login_role.rolsuper
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_roles AS executable_role
          WHERE executable_role.rolname IN (
            'ba_runtime',
            'ba_control_executor',
            'ba_management_attestation_issuer',
            'ba_subject_assertion_verifier'
          )
            AND pg_catalog.pg_has_role(
              login_role.oid, executable_role.oid, 'MEMBER'
            )
       )
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_roles AS owner_role
           WHERE owner_role.rolname IN (
             'ba_auth_owner',
             'ba_authorization_owner',
             'ba_run_owner',
            'ba_billing_owner',
            'ba_archive_evidence_owner',
            'ba_retention'
          )
            AND pg_catalog.pg_has_role(login_role.oid, owner_role.oid, 'MEMBER')
       )
  ) THEN
    RAISE EXCEPTION 'non-super LOGIN cannot inherit executable and G0-06 owner capabilities'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS executable_role
      CROSS JOIN pg_catalog.pg_roles AS owner_role
     WHERE executable_role.rolname IN (
       'ba_runtime',
       'ba_control_executor',
       'ba_management_attestation_issuer',
       'ba_subject_assertion_verifier'
     )
       AND owner_role.rolname IN (
          'ba_auth_owner',
          'ba_authorization_owner',
          'ba_run_owner',
         'ba_billing_owner',
         'ba_archive_evidence_owner',
         'ba_retention'
       )
       AND (
         pg_catalog.pg_has_role(executable_role.oid, owner_role.oid, 'MEMBER')
         OR pg_catalog.pg_has_role(owner_role.oid, executable_role.oid, 'MEMBER')
       )
  ) THEN
    RAISE EXCEPTION 'G0-06 owners and executable roles must remain mutually isolated'
      USING ERRCODE = '42501';
  END IF;
END;
$g006_platform_prerequisites$;

-- A relation/function owner needs CREATE on the containing schema during
-- ownership transfer. These capabilities are revoked at the end of the
-- migration; only USAGE remains where an owner must call another owner.
GRANT USAGE, CREATE ON SCHEMA app TO
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention,
  ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention,
  ba_authorization_owner;
GRANT USAGE ON SCHEMA auth TO ba_run_owner;
GRANT EXECUTE ON FUNCTION app.current_workspace_id() TO
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
GRANT EXECUTE ON FUNCTION app.current_authenticated_principal_id(),
  app.current_api_credential_id() TO ba_run_owner;

-- The Conversation ABI hash was already part of the immutable G0-05
-- canonical Deployment document. Project it forward from that authority;
-- callers never register or rewrite this value.
SET LOCAL ROLE ba_authorization_owner;
ALTER TABLE public.agent_deployment_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_deployment_revisions DISABLE TRIGGER g005_immutable;
ALTER TABLE public.agent_deployment_revisions
  ADD COLUMN conversation_contract_hash text GENERATED ALWAYS AS (
    canonical_document::jsonb ->> 'conversation_contract_hash'
  ) STORED;
DO $g006_conversation_contract_projection$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_deployment_revisions
     WHERE conversation_contract_hash IS NULL
        OR conversation_contract_hash !~ '^sha256:[0-9a-f]{64}$'
        OR canonical_document::jsonb ->> 'conversation_contract_hash'
          IS DISTINCT FROM conversation_contract_hash
  ) THEN
    RAISE EXCEPTION 'G0-05 Agent Deployment revision lacks a valid canonical conversation hash'
      USING ERRCODE = '23514';
  END IF;
END;
$g006_conversation_contract_projection$;
ALTER TABLE public.agent_deployment_revisions
  ALTER COLUMN conversation_contract_hash SET NOT NULL,
  ADD CONSTRAINT agent_deployment_revisions_conversation_contract_hash_check
    CHECK (conversation_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT agent_deployment_revisions_conversation_contract_pin_key
    UNIQUE (
      workspace_id,
      agent_deployment_id,
      id,
      conversation_contract_hash
    ),
  ADD CONSTRAINT agent_deployment_revisions_run_target_pin_key
    UNIQUE (
      workspace_id,
      agent_deployment_id,
      id,
      agent_id,
      agent_release_id,
      experience_release_id,
      conversation_contract_hash
    );
ALTER TABLE public.agent_deployment_revisions ENABLE TRIGGER g005_immutable;
ALTER TABLE public.agent_deployment_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.flow_deployment_revisions
  ADD CONSTRAINT flow_deployment_revisions_run_target_pin_key
    UNIQUE (
      workspace_id,
      flow_deployment_id,
      id,
      flow_id,
      flow_version_id
    );
RESET ROLE;

CREATE TABLE public.conversations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('credential', 'end_user')),
  credential_id uuid,
  end_user_principal_id uuid,
  principal_id uuid GENERATED ALWAYS AS (
    COALESCE(credential_id, end_user_principal_id)
  ) STORED,
  agent_deployment_id uuid NOT NULL,
  created_deployment_revision_id uuid NOT NULL,
  conversation_contract_hash text NOT NULL
    CHECK (conversation_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  current_state_version bigint NOT NULL DEFAULT 0
    CHECK (current_state_version >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT conversations_run_target_key UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    id,
    principal_kind,
    principal_id,
    agent_deployment_id,
    conversation_contract_hash
  ),
  CONSTRAINT conversations_principal_shape_check CHECK (
    (
      principal_kind = 'credential'
      AND credential_id IS NOT NULL
      AND end_user_principal_id IS NULL
    ) OR (
      principal_kind = 'end_user'
      AND credential_id IS NULL
      AND end_user_principal_id IS NOT NULL
    )
  ),
  CONSTRAINT conversations_principal_id_check CHECK (principal_id IS NOT NULL),
  CONSTRAINT conversations_credential_fkey
    FOREIGN KEY (workspace_id, credential_id)
    REFERENCES public.api_credentials(workspace_id, id),
  CONSTRAINT conversations_end_user_fkey
    FOREIGN KEY (workspace_id, end_user_principal_id)
    REFERENCES public.end_user_principals(workspace_id, id),
  CONSTRAINT conversations_deployment_fkey
    FOREIGN KEY (workspace_id, agent_deployment_id)
    REFERENCES public.agent_deployments(workspace_id, id),
  CONSTRAINT conversations_created_revision_fkey FOREIGN KEY (
    workspace_id,
    agent_deployment_id,
    created_deployment_revision_id,
    conversation_contract_hash
  ) REFERENCES public.agent_deployment_revisions (
    workspace_id,
    agent_deployment_id,
    id,
    conversation_contract_hash
  )
);

CREATE TABLE public.conversation_states (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  state_version bigint NOT NULL CHECK (state_version >= 0),
  variables_redacted jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(variables_redacted) = 'object'),
  session_store_redacted jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(session_store_redacted) = 'object'),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT conversation_states_conversation_key UNIQUE (workspace_id, conversation_id),
  CONSTRAINT conversation_states_version_key
    UNIQUE (workspace_id, conversation_id, state_version),
  CONSTRAINT conversation_states_conversation_fkey
    FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES public.conversations(workspace_id, id)
);

CREATE TABLE public.conversation_messages (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  state_version bigint NOT NULL CHECK (state_version > 0),
  message_ordinal bigint NOT NULL CHECK (message_ordinal > 0),
  message_role text NOT NULL CHECK (message_role IN ('USER', 'ASSISTANT', 'SYSTEM')),
  content_redacted jsonb NOT NULL CHECK (jsonb_typeof(content_redacted) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT conversation_messages_ordinal_key
    UNIQUE (workspace_id, conversation_id, message_ordinal),
  CONSTRAINT conversation_messages_state_key
    UNIQUE (workspace_id, conversation_id, state_version, id),
  CONSTRAINT conversation_messages_conversation_fkey
    FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES public.conversations(workspace_id, id)
);

CREATE TABLE public.run_idempotency_sentinels (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('credential', 'end_user')),
  credential_id uuid,
  end_user_principal_id uuid,
  principal_id uuid GENERATED ALWAYS AS (
    COALESCE(credential_id, end_user_principal_id)
  ) STORED,
  fixed_route text NOT NULL CHECK (fixed_route IN (
    '/v1/oapi/agent/chat',
    '/v1/oapi/flow/run',
    '/v1/oapi/runs/{run_id}/cancel',
    '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'
  )),
  idempotency_key text NOT NULL
    CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_idempotency_sentinels_namespace_key UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    principal_kind,
    principal_id,
    fixed_route,
    idempotency_key
  ),
  CONSTRAINT run_idempotency_sentinels_exact_key UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    id,
    principal_kind,
    principal_id,
    fixed_route,
    idempotency_key,
    intent_hash
  ),
  CONSTRAINT run_idempotency_sentinels_principal_id_check
    CHECK (principal_id IS NOT NULL),
  CONSTRAINT run_idempotency_sentinels_principal_shape_check CHECK (
    (
      principal_kind = 'credential'
      AND credential_id IS NOT NULL
      AND end_user_principal_id IS NULL
    ) OR (
      principal_kind = 'end_user'
      AND credential_id IS NULL
      AND end_user_principal_id IS NOT NULL
    )
  ),
  CONSTRAINT run_idempotency_sentinels_credential_fkey
    FOREIGN KEY (workspace_id, credential_id)
    REFERENCES public.api_credentials(workspace_id, id),
  CONSTRAINT run_idempotency_sentinels_end_user_fkey
    FOREIGN KEY (workspace_id, end_user_principal_id)
    REFERENCES public.end_user_principals(workspace_id, id)
);

CREATE TABLE public.runs (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_kind text NOT NULL DEFAULT 'top_level' CHECK (run_kind = 'top_level'),
  billing_owner_run_id uuid NOT NULL,
  accepted_request_id uuid NOT NULL,
  accepted_principal_kind text NOT NULL
    CHECK (accepted_principal_kind IN ('credential', 'end_user')),
  accepted_credential_id uuid,
  accepted_end_user_principal_id uuid,
  accepted_principal_id uuid GENERATED ALWAYS AS (
    COALESCE(accepted_credential_id, accepted_end_user_principal_id)
  ) STORED,
  fixed_route text NOT NULL CHECK (fixed_route IN (
    '/v1/oapi/agent/chat',
    '/v1/oapi/flow/run'
  )),
  idempotency_sentinel_id uuid,
  idempotency_key text CHECK (
    idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128
  ),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  admission_snapshot_hash text NOT NULL
    CHECK (admission_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  accepted_plan_hash text NOT NULL CHECK (accepted_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  accepted_output_schema_ref text NOT NULL
    CHECK (length(btrim(accepted_output_schema_ref)) BETWEEN 1 AND 1024),
  accepted_output_schema_hash text NOT NULL
    CHECK (accepted_output_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_pins_hash text NOT NULL
    CHECK (dependency_pins_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_kind text NOT NULL CHECK (target_kind IN ('agent', 'flow')),
  agent_deployment_id uuid,
  agent_deployment_revision_id uuid,
  agent_id uuid,
  agent_release_id uuid,
  experience_release_id uuid,
  conversation_id uuid,
  conversation_contract_hash text,
  accepted_conversation_state_version bigint,
  user_message_id uuid,
  flow_deployment_id uuid,
  flow_deployment_revision_id uuid,
  flow_id uuid,
  flow_version_id uuid,
  status text NOT NULL CHECK (status IN (
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
  )),
  execution_status text NOT NULL CHECK (execution_status IN (
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
  )),
  billing_state text NOT NULL CHECK (billing_state IN (
    'PENDING', 'SETTLED', 'NEEDS_ATTENTION'
  )),
  billing_settled_at timestamptz,
  acceptance_receipt_http_status integer NOT NULL DEFAULT 202
    CHECK (acceptance_receipt_http_status = 202),
  acceptance_receipt_data_redacted jsonb NOT NULL
    CHECK (jsonb_typeof(acceptance_receipt_data_redacted) = 'object'),
  last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  termination_reason text,
  terminal_intent_hash text,
  terminal_result_redacted jsonb,
  terminal_error_redacted jsonb,
  terminal_billing_pending boolean,
  terminal_billing_pending_at timestamptz,
  terminal_event_id uuid,
  terminal_event_sequence bigint,
  finished_at timestamptz,
  events_retention_until timestamptz,
  recovery_retention_until timestamptz,
  retention_until timestamptz,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT runs_billing_owner_key
    UNIQUE (workspace_id, id, billing_owner_run_id),
  CONSTRAINT runs_replay_identity_key UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    id,
    accepted_principal_kind,
    accepted_principal_id,
    fixed_route,
    idempotency_key,
    intent_hash
  ),
  CONSTRAINT runs_acceptance_identity_key UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    id,
    accepted_principal_kind,
    accepted_principal_id,
    fixed_route,
    intent_hash
  ),
  CONSTRAINT runs_principal_id_check CHECK (accepted_principal_id IS NOT NULL),
  CONSTRAINT runs_terminal_identity_key UNIQUE (
    workspace_id,
    id,
    terminal_intent_hash,
    terminal_event_id,
    terminal_event_sequence
  ),
  CONSTRAINT runs_self_billing_owner_check CHECK (billing_owner_run_id = id),
  CONSTRAINT runs_principal_shape_check CHECK (
    (
      accepted_principal_kind = 'credential'
      AND accepted_credential_id IS NOT NULL
      AND accepted_end_user_principal_id IS NULL
    ) OR (
      accepted_principal_kind = 'end_user'
      AND accepted_credential_id IS NULL
      AND accepted_end_user_principal_id IS NOT NULL
    )
  ),
  CONSTRAINT runs_credential_fkey
    FOREIGN KEY (workspace_id, accepted_credential_id)
    REFERENCES public.api_credentials(workspace_id, id),
  CONSTRAINT runs_end_user_fkey
    FOREIGN KEY (workspace_id, accepted_end_user_principal_id)
    REFERENCES public.end_user_principals(workspace_id, id),
  CONSTRAINT runs_idempotency_shape_check CHECK (
    (idempotency_sentinel_id IS NULL AND idempotency_key IS NULL)
    OR (idempotency_sentinel_id IS NOT NULL AND idempotency_key IS NOT NULL)
  ),
  CONSTRAINT runs_idempotency_sentinel_fkey FOREIGN KEY (
    workspace_id,
    idempotency_sentinel_id,
    accepted_principal_kind,
    accepted_principal_id,
    fixed_route,
    idempotency_key,
    intent_hash
  ) REFERENCES public.run_idempotency_sentinels (
    workspace_id,
    id,
    principal_kind,
    principal_id,
    fixed_route,
    idempotency_key,
    intent_hash
  ),
  CONSTRAINT runs_identity_hash_separation_check
    CHECK (admission_snapshot_hash <> accepted_plan_hash),
  CONSTRAINT runs_target_shape_check CHECK (
    (
      target_kind = 'agent'
      AND fixed_route = '/v1/oapi/agent/chat'
      AND agent_deployment_id IS NOT NULL
      AND agent_deployment_revision_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND agent_release_id IS NOT NULL
      AND experience_release_id IS NOT NULL
      AND conversation_id IS NOT NULL
      AND conversation_contract_hash ~ '^sha256:[0-9a-f]{64}$'
      AND accepted_conversation_state_version > 0
      AND user_message_id IS NOT NULL
      AND flow_deployment_id IS NULL
      AND flow_deployment_revision_id IS NULL
      AND flow_id IS NULL
      AND flow_version_id IS NULL
    ) OR (
      target_kind = 'flow'
      AND fixed_route = '/v1/oapi/flow/run'
      AND accepted_principal_kind = 'credential'
      AND agent_deployment_id IS NULL
      AND agent_deployment_revision_id IS NULL
      AND agent_id IS NULL
      AND agent_release_id IS NULL
      AND experience_release_id IS NULL
      AND conversation_id IS NULL
      AND conversation_contract_hash IS NULL
      AND accepted_conversation_state_version IS NULL
      AND user_message_id IS NULL
      AND flow_deployment_id IS NOT NULL
      AND flow_deployment_revision_id IS NOT NULL
      AND flow_id IS NOT NULL
      AND flow_version_id IS NOT NULL
    )
  ),
  CONSTRAINT runs_agent_revision_fkey FOREIGN KEY (
    workspace_id,
    agent_deployment_id,
    agent_deployment_revision_id,
    agent_id,
    agent_release_id,
    experience_release_id,
    conversation_contract_hash
  ) REFERENCES public.agent_deployment_revisions (
    workspace_id,
    agent_deployment_id,
    id,
    agent_id,
    agent_release_id,
    experience_release_id,
    conversation_contract_hash
  ),
  CONSTRAINT runs_agent_release_fkey
    FOREIGN KEY (workspace_id, agent_id, agent_release_id)
    REFERENCES public.agent_releases(workspace_id, agent_id, id),
  CONSTRAINT runs_conversation_fkey FOREIGN KEY (
    workspace_id,
    conversation_id,
    accepted_principal_kind,
    accepted_principal_id,
    agent_deployment_id,
    conversation_contract_hash
  ) REFERENCES public.conversations (
    workspace_id,
    id,
    principal_kind,
    principal_id,
    agent_deployment_id,
    conversation_contract_hash
  ),
  CONSTRAINT runs_user_message_fkey FOREIGN KEY (
    workspace_id,
    conversation_id,
    accepted_conversation_state_version,
    user_message_id
  ) REFERENCES public.conversation_messages (
    workspace_id,
    conversation_id,
    state_version,
    id
  ),
  CONSTRAINT runs_flow_revision_fkey FOREIGN KEY (
    workspace_id,
    flow_deployment_id,
    flow_deployment_revision_id,
    flow_id,
    flow_version_id
  ) REFERENCES public.flow_deployment_revisions (
    workspace_id,
    flow_deployment_id,
    id,
    flow_id,
    flow_version_id
  ),
  CONSTRAINT runs_flow_version_fkey
    FOREIGN KEY (workspace_id, flow_id, flow_version_id)
    REFERENCES public.flow_versions(workspace_id, flow_id, id),
  CONSTRAINT runs_billing_projection_check CHECK (
    (billing_state = 'SETTLED' AND billing_settled_at IS NOT NULL)
    OR (billing_state <> 'SETTLED' AND billing_settled_at IS NULL)
  ),
  CONSTRAINT runs_terminal_shape_check CHECK (
    (
      status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
      AND termination_reason IS NULL
      AND terminal_intent_hash IS NULL
      AND terminal_result_redacted IS NULL
      AND terminal_error_redacted IS NULL
      AND terminal_billing_pending IS NULL
      AND terminal_billing_pending_at IS NULL
      AND terminal_event_id IS NULL
      AND terminal_event_sequence IS NULL
      AND finished_at IS NULL
    ) OR (
      status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
      AND termination_reason IS NOT NULL
      AND terminal_intent_hash ~ '^sha256:[0-9a-f]{64}$'
      AND (terminal_result_redacted IS NULL) <> (terminal_error_redacted IS NULL)
      AND terminal_billing_pending = false
      AND terminal_billing_pending_at IS NOT NULL
      AND terminal_event_id IS NOT NULL
      AND terminal_event_sequence IS NOT NULL
      AND finished_at IS NOT NULL
      AND events_retention_until >= finished_at + interval '7 days'
      AND recovery_retention_until >= finished_at + interval '30 days'
      AND recovery_retention_until >= events_retention_until
      AND retention_until >= recovery_retention_until
    )
  ),
  CONSTRAINT runs_terminal_status_reason_check CHECK (
    status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
    OR (status = 'SUCCEEDED' AND termination_reason = 'COMPLETED')
    OR (
      status = 'FAILED'
      AND termination_reason IN (
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
    )
    OR (
      status = 'CANCELLED'
      AND termination_reason IN (
        'USER_CANCELLED', 'HUMAN_REJECTED', 'HUMAN_GATE_EXPIRED'
      )
    )
    OR (status = 'TIMED_OUT' AND termination_reason = 'RUN_TIMED_OUT')
    OR (status = 'NEEDS_ATTENTION' AND termination_reason = 'SIDE_EFFECT_UNKNOWN')
  ),
  CONSTRAINT runs_terminal_payload_check CHECK (
    (
      status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
      AND terminal_result_redacted IS NULL
      AND terminal_error_redacted IS NULL
    ) OR (
      status = 'SUCCEEDED'
      AND jsonb_typeof(terminal_result_redacted) = 'object'
      AND terminal_error_redacted IS NULL
    ) OR (
      status IN ('FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
      AND terminal_result_redacted IS NULL
      AND (
        (
          status = 'NEEDS_ATTENTION'
          AND terminal_error_redacted = jsonb_build_object(
            'code', termination_reason,
            'retryable', false,
            'category', 'EXECUTION',
            'requires_operator_action', true
          )
        ) OR (
          status <> 'NEEDS_ATTENTION'
          AND terminal_error_redacted = jsonb_build_object(
            'code', termination_reason,
            'retryable', false,
            'category', 'EXECUTION'
          )
        )
      )
    )
  ),
  CONSTRAINT runs_terminal_billing_state_check CHECK (
    status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION')
    OR (
      status = 'NEEDS_ATTENTION'
      AND billing_state IN ('NEEDS_ATTENTION', 'SETTLED')
    )
    OR (
      status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      AND billing_state = 'SETTLED'
    )
  )
);

CREATE TABLE public.run_acceptance_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  sentinel_id uuid,
  run_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('credential', 'end_user')),
  credential_id uuid,
  end_user_principal_id uuid,
  principal_id uuid GENERATED ALWAYS AS (
    COALESCE(credential_id, end_user_principal_id)
  ) STORED,
  fixed_route text NOT NULL,
  idempotency_key text CHECK (
    idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128
  ),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  http_status integer NOT NULL CHECK (http_status = 202),
  data_redacted jsonb NOT NULL CHECK (jsonb_typeof(data_redacted) = 'object'),
  accepted_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_acceptance_receipts_run_key UNIQUE (workspace_id, run_id),
  CONSTRAINT run_acceptance_receipts_principal_id_check CHECK (
    principal_id IS NOT NULL
  ),
  CONSTRAINT run_acceptance_receipts_idempotency_shape_check CHECK (
    (sentinel_id IS NULL AND idempotency_key IS NULL)
    OR (sentinel_id IS NOT NULL AND idempotency_key IS NOT NULL)
  ),
  CONSTRAINT run_acceptance_receipts_sentinel_fkey FOREIGN KEY (
    workspace_id,
    sentinel_id,
    principal_kind,
    principal_id,
    fixed_route,
    idempotency_key,
    intent_hash
  ) REFERENCES public.run_idempotency_sentinels (
    workspace_id,
    id,
    principal_kind,
    principal_id,
    fixed_route,
    idempotency_key,
    intent_hash
  ),
  CONSTRAINT run_acceptance_receipts_run_fkey FOREIGN KEY (
    workspace_id,
    run_id,
    principal_kind,
    principal_id,
    fixed_route,
    intent_hash
  ) REFERENCES public.runs (
    workspace_id,
    id,
    accepted_principal_kind,
    accepted_principal_id,
    fixed_route,
    intent_hash
  )
);

CREATE UNIQUE INDEX run_acceptance_receipts_sentinel_key
  ON public.run_acceptance_receipts (workspace_id, sentinel_id)
  WHERE sentinel_id IS NOT NULL;

CREATE TABLE public.run_mutation_idempotency (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('credential', 'end_user')),
  credential_id uuid,
  end_user_principal_id uuid,
  principal_id uuid GENERATED ALWAYS AS (
    COALESCE(credential_id, end_user_principal_id)
  ) STORED,
  fixed_route text NOT NULL CHECK (fixed_route IN (
    '/v1/oapi/runs/{run_id}/cancel',
    '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'
  )),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  target_run_id uuid NOT NULL,
  target_gate_id uuid,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  http_status integer CHECK (http_status IN (200, 202)),
  receipt_data_redacted jsonb NOT NULL
    CHECK (jsonb_typeof(receipt_data_redacted) = 'object'),
  event_sequence bigint,
  completed_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_mutation_idempotency_namespace_key UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    principal_kind,
    principal_id,
    fixed_route,
    idempotency_key
  ),
  CONSTRAINT run_mutation_idempotency_principal_id_check
    CHECK (principal_id IS NOT NULL),
  CONSTRAINT run_mutation_idempotency_principal_shape_check CHECK (
    (
      principal_kind = 'credential'
      AND credential_id IS NOT NULL
      AND end_user_principal_id IS NULL
    ) OR (
      principal_kind = 'end_user'
      AND credential_id IS NULL
      AND end_user_principal_id IS NOT NULL
    )
  ),
  CONSTRAINT run_mutation_idempotency_run_fkey
    FOREIGN KEY (workspace_id, target_run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT run_mutation_idempotency_completion_check CHECK (
    (
      http_status IS NULL
      AND event_sequence IS NULL
      AND completed_at IS NULL
    ) OR (
      http_status = 200
      AND event_sequence IS NULL
      AND completed_at IS NOT NULL
    ) OR (
      http_status = 202
      AND event_sequence > 0
      AND completed_at IS NOT NULL
    )
  )
);

CREATE TABLE public.run_attempts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_number bigint NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN (
    'PENDING', 'RUNNING', 'RELINQUISHED', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  )),
  lease_owner text,
  lease_token uuid,
  lease_fencing_token bigint CHECK (lease_fencing_token > 0),
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_attempts_exact_key UNIQUE (workspace_id, run_id, id),
  CONSTRAINT run_attempts_number_key UNIQUE (workspace_id, run_id, attempt_number),
  CONSTRAINT run_attempts_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id)
);

CREATE TABLE public.run_steps (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid,
  step_key text NOT NULL CHECK (length(btrim(step_key)) > 0),
  status text NOT NULL CHECK (status IN (
    'PENDING', 'RUNNING', 'SUSPENDED', 'SUCCEEDED', 'FAILED',
    'CANCELLED', 'SKIPPED', 'NEEDS_ATTENTION'
  )),
  input_hash text CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  output_hash text CHECK (output_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_steps_exact_key UNIQUE (workspace_id, run_id, id),
  CONSTRAINT run_steps_attempt_exact_key
    UNIQUE NULLS NOT DISTINCT (workspace_id, run_id, attempt_id, id),
  CONSTRAINT run_steps_key UNIQUE (workspace_id, run_id, step_key),
  CONSTRAINT run_steps_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT run_steps_attempt_fkey
    FOREIGN KEY (workspace_id, run_id, attempt_id)
    REFERENCES public.run_attempts(workspace_id, run_id, id)
);

CREATE TABLE public.run_events (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
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
  )),
  dedupe_key text NOT NULL CHECK (length(btrim(dedupe_key)) > 0),
  payload_redacted jsonb NOT NULL CHECK (jsonb_typeof(payload_redacted) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_events_sequence_key UNIQUE (workspace_id, run_id, sequence),
  CONSTRAINT run_events_dedupe_key UNIQUE (workspace_id, run_id, event_type, dedupe_key),
  CONSTRAINT run_events_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id)
);

CREATE TABLE public.run_checkpoints (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_id uuid,
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_ref text NOT NULL CHECK (length(btrim(payload_ref)) > 0),
  payload_redacted jsonb NOT NULL CHECK (jsonb_typeof(payload_redacted) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_checkpoints_exact_key UNIQUE (workspace_id, run_id, id),
  CONSTRAINT run_checkpoints_hash_key UNIQUE (workspace_id, run_id, checkpoint_hash),
  CONSTRAINT run_checkpoints_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT run_checkpoints_step_fkey
    FOREIGN KEY (workspace_id, run_id, step_id)
    REFERENCES public.run_steps(workspace_id, run_id, id)
);

CREATE TABLE public.human_gates (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  gate_type text NOT NULL CHECK (gate_type IN ('INPUT', 'APPROVAL')),
  canonical_operation_hash text NOT NULL
    CHECK (canonical_operation_hash ~ '^sha256:[0-9a-f]{64}$'),
  resolved_plan_hash text NOT NULL
    CHECK (resolved_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  barrier_generation bigint NOT NULL CHECK (barrier_generation > 0),
  approver_policy_hash text NOT NULL
    CHECK (approver_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  public_schema jsonb NOT NULL CHECK (jsonb_typeof(public_schema) = 'object'),
  status text NOT NULL CHECK (status IN (
    'PENDING', 'CLAIMED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'
  )),
  expires_at timestamptz NOT NULL,
  claimed_by text,
  claim_ref text,
  claim_hash text CHECK (claim_hash ~ '^sha256:[0-9a-f]{64}$'),
  claimed_at timestamptz,
  decision_kind text CHECK (decision_kind IN ('APPROVE', 'REJECT')),
  decision_ref text,
  decision_hash text CHECK (decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT human_gates_run_identity_key UNIQUE (workspace_id, id, run_id),
  CONSTRAINT human_gates_operation_key
    UNIQUE (workspace_id, run_id, canonical_operation_hash),
  CONSTRAINT human_gates_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT human_gates_checkpoint_fkey
    FOREIGN KEY (workspace_id, run_id, checkpoint_id)
    REFERENCES public.run_checkpoints(workspace_id, run_id, id),
  CONSTRAINT human_gates_claim_pair_check CHECK (
    (claimed_by IS NULL AND claim_ref IS NULL AND claim_hash IS NULL AND claimed_at IS NULL)
    OR (
      claimed_by IS NOT NULL
      AND claim_ref IS NOT NULL
      AND claim_hash IS NOT NULL
      AND claimed_at IS NOT NULL
    )
  ),
  CONSTRAINT human_gates_decision_pair_check CHECK (
    (
      decision_kind IS NULL
      AND decision_ref IS NULL
      AND decision_hash IS NULL
      AND decided_by IS NULL
      AND decided_at IS NULL
    ) OR (
      decision_kind IS NOT NULL
      AND decision_ref IS NOT NULL
      AND decision_hash IS NOT NULL
      AND decided_by IS NOT NULL
      AND decided_at IS NOT NULL
    )
  ),
  CONSTRAINT human_gates_state_check CHECK (
    (
      status = 'PENDING'
      AND claimed_at IS NULL
      AND decided_at IS NULL
      AND resolved_at IS NULL
    ) OR (
      status = 'CLAIMED'
      AND claimed_at IS NOT NULL
      AND decided_at IS NULL
      AND resolved_at IS NULL
    ) OR (
      status IN ('APPROVED', 'REJECTED')
      AND claimed_at IS NOT NULL
      AND decided_at IS NOT NULL
      AND resolved_at IS NOT NULL
      AND (
        (status = 'APPROVED' AND decision_kind = 'APPROVE')
        OR (status = 'REJECTED' AND decision_kind = 'REJECT')
      )
    ) OR (
      status IN ('EXPIRED', 'CANCELLED', 'FAILED')
      AND decided_at IS NULL
      AND resolved_at IS NOT NULL
    )
  )
);

CREATE TABLE public.outbox (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  message_type text NOT NULL CHECK (message_type IN (
    'RUN_DISPATCH',
    'SSE_WAKE',
    'WEBHOOK_DELIVERY',
    'ANALYTICS_PROJECTION'
  )),
  dedupe_key text NOT NULL CHECK (length(btrim(dedupe_key)) > 0),
  payload_ref text NOT NULL CHECK (
    length(btrim(payload_ref)) BETWEEN 1 AND 2048
    AND position('?' IN payload_ref) = 0
    AND position('#' IN payload_ref) = 0
  ),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  producer_fencing_token bigint NOT NULL CHECK (producer_fencing_token > 0),
  payload_redacted jsonb NOT NULL CHECK (jsonb_typeof(payload_redacted) = 'object'),
  status text NOT NULL CHECK (status IN ('PENDING', 'LEASED', 'DELIVERED', 'DEAD')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token uuid,
  lease_fencing_token bigint CHECK (lease_fencing_token > 0),
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_redacted text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT outbox_dedupe_key UNIQUE (workspace_id, run_id, message_type, dedupe_key),
  CONSTRAINT outbox_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT outbox_state_check CHECK (
    (
      status = 'PENDING'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_fencing_token IS NULL
      AND lease_expires_at IS NULL
      AND delivered_at IS NULL
    ) OR (
      status = 'LEASED'
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_fencing_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND delivered_at IS NULL
    ) OR (
      status = 'DELIVERED'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_fencing_token IS NULL
      AND lease_expires_at IS NULL
      AND delivered_at IS NOT NULL
    ) OR (
      status = 'DEAD'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_fencing_token IS NULL
      AND lease_expires_at IS NULL
      AND delivered_at IS NULL
    )
  )
);

CREATE TABLE public.run_parent_links (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  completion_policy text NOT NULL CHECK (completion_policy = 'join'),
  cancel_propagation text NOT NULL CHECK (cancel_propagation = 'cascade'),
  result_projection text NOT NULL CHECK (result_projection = 'safe_summary'),
  parent_terminal_policy text NOT NULL CHECK (parent_terminal_policy = 'wait_for_settlement'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_parent_links_child_key UNIQUE (workspace_id, child_run_id),
  CONSTRAINT run_parent_links_not_self_check CHECK (child_run_id <> parent_run_id),
  CONSTRAINT run_parent_links_child_fkey
    FOREIGN KEY (workspace_id, child_run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT run_parent_links_parent_fkey
    FOREIGN KEY (workspace_id, parent_run_id)
    REFERENCES public.runs(workspace_id, id)
);

CREATE TABLE public.credit_reservations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  accepted_plan_hash text NOT NULL CHECK (accepted_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('HELD', 'SETTLED', 'RELEASED', 'EXPIRED')),
  reserved_credits bigint NOT NULL CHECK (reserved_credits >= 0),
  settled_credits bigint NOT NULL DEFAULT 0 CHECK (settled_credits >= 0),
  released_credits bigint NOT NULL DEFAULT 0 CHECK (released_credits >= 0),
  balance_version bigint NOT NULL CHECK (balance_version >= 0),
  expires_at timestamptz NOT NULL,
  status_reason_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  released_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT credit_reservations_run_key UNIQUE (workspace_id, run_id),
  CONSTRAINT credit_reservations_exact_key
    UNIQUE (workspace_id, id, run_id, billing_owner_run_id),
  CONSTRAINT credit_reservations_run_fkey FOREIGN KEY (
    workspace_id,
    run_id,
    billing_owner_run_id
  ) REFERENCES public.runs (
    workspace_id,
    id,
    billing_owner_run_id
  ),
  CONSTRAINT credit_reservations_top_level_check
    CHECK (billing_owner_run_id = run_id),
  CONSTRAINT credit_reservations_amount_check CHECK (
    settled_credits + released_credits <= reserved_credits
  ),
  CONSTRAINT credit_reservations_time_check CHECK (
    expires_at > created_at
    AND updated_at >= created_at
    AND (
      settled_at IS NULL
      OR settled_at BETWEEN created_at AND updated_at
    )
    AND (
      released_at IS NULL
      OR released_at BETWEEN created_at AND updated_at
    )
  ),
  CONSTRAINT credit_reservations_state_check CHECK (
    (
      status = 'HELD'
      AND settled_at IS NULL
      AND released_at IS NULL
      AND (
        reserved_credits = 0
        OR settled_credits + released_credits < reserved_credits
      )
    ) OR (
      status = 'SETTLED'
      AND settled_credits + released_credits = reserved_credits
      AND settled_at IS NOT NULL
      AND (released_credits = 0 OR released_at IS NOT NULL)
    ) OR (
      status IN ('RELEASED', 'EXPIRED')
      AND settled_credits = 0
      AND released_credits = reserved_credits
      AND settled_at IS NULL
      AND released_at IS NOT NULL
    )
  )
);

CREATE TABLE public.credits_ledger (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  producer_run_id uuid NOT NULL,
  producer_attempt_id uuid,
  producer_lease_fencing_token bigint,
  step_id uuid,
  reservation_id uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN (
    'RESERVE', 'SETTLE', 'RELEASE', 'EXPIRED', 'RECONCILIATION'
  )),
  available_delta_credits bigint NOT NULL,
  reserved_delta_credits bigint NOT NULL,
  settled_delta_credits bigint NOT NULL,
  billing_intent_hash text NOT NULL
    CHECK (billing_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  charge_attribution_hash text NOT NULL
    CHECK (charge_attribution_hash ~ '^sha256:[0-9a-f]{64}$'),
  charge_key text NOT NULL CHECK (length(btrim(charge_key)) BETWEEN 1 AND 300),
  balance_before bigint NOT NULL CHECK (balance_before >= 0),
  reserved_before bigint NOT NULL CHECK (reserved_before >= 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  reserved_after bigint NOT NULL CHECK (reserved_after >= 0),
  balance_version bigint NOT NULL CHECK (balance_version >= 0),
  metering_detail_redacted jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metering_detail_redacted) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT credits_ledger_exact_key
    UNIQUE (workspace_id, id, run_id, billing_owner_run_id),
  CONSTRAINT credits_ledger_charge_key UNIQUE (workspace_id, charge_key),
  CONSTRAINT credits_ledger_charge_intent_key
    UNIQUE (workspace_id, charge_key, billing_intent_hash),
  CONSTRAINT credits_ledger_run_fkey FOREIGN KEY (
    workspace_id,
    run_id,
    billing_owner_run_id
  ) REFERENCES public.runs (
    workspace_id,
    id,
    billing_owner_run_id
  ),
  CONSTRAINT credits_ledger_producer_run_fkey
    FOREIGN KEY (workspace_id, producer_run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT credits_ledger_reservation_fkey FOREIGN KEY (
    workspace_id,
    reservation_id,
    run_id,
    billing_owner_run_id
  ) REFERENCES public.credit_reservations (
    workspace_id,
    id,
    run_id,
    billing_owner_run_id
  ),
  CONSTRAINT credits_ledger_producer_attempt_fkey FOREIGN KEY (
    workspace_id,
    producer_run_id,
    producer_attempt_id
  ) REFERENCES public.run_attempts (
    workspace_id,
    run_id,
    id
  ),
  CONSTRAINT credits_ledger_producer_step_fkey FOREIGN KEY (
    workspace_id,
    producer_run_id,
    producer_attempt_id,
    step_id
  ) REFERENCES public.run_steps (
    workspace_id,
    run_id,
    attempt_id,
    id
  ),
  CONSTRAINT credits_ledger_producer_shape_check CHECK (
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
  ),
  CONSTRAINT credits_ledger_delta_check CHECK (
    (
      entry_kind = 'RESERVE'
      AND available_delta_credits <= 0
      AND reserved_delta_credits >= 0
      AND settled_delta_credits = 0
      AND available_delta_credits = -reserved_delta_credits
    ) OR (
      entry_kind = 'SETTLE'
      AND available_delta_credits = 0
      AND reserved_delta_credits <= 0
      AND settled_delta_credits >= 0
      AND settled_delta_credits = -reserved_delta_credits
    ) OR (
      entry_kind IN ('RELEASE', 'EXPIRED')
      AND available_delta_credits >= 0
      AND reserved_delta_credits <= 0
      AND settled_delta_credits = 0
      AND available_delta_credits = -reserved_delta_credits
    ) OR (
      entry_kind = 'RECONCILIATION'
      AND available_delta_credits >= 0
      AND reserved_delta_credits <= 0
      AND settled_delta_credits >= 0
      AND available_delta_credits + settled_delta_credits = -reserved_delta_credits
    )
  ),
  CONSTRAINT credits_ledger_balance_triangle_check CHECK (
    balance_after = balance_before + available_delta_credits
    AND reserved_after = reserved_before + reserved_delta_credits
  )
);

CREATE TABLE public.run_budget_allocations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  parent_reservation_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  allocated_credits bigint NOT NULL CHECK (allocated_credits >= 0),
  settled_credits bigint NOT NULL DEFAULT 0 CHECK (settled_credits >= 0),
  released_credits bigint NOT NULL DEFAULT 0 CHECK (released_credits >= 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SETTLED', 'RELEASED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_budget_allocations_child_key UNIQUE (workspace_id, child_run_id),
  CONSTRAINT run_budget_allocations_link_fkey
    FOREIGN KEY (workspace_id, child_run_id)
    REFERENCES public.run_parent_links(workspace_id, child_run_id),
  CONSTRAINT run_budget_allocations_reservation_fkey
    FOREIGN KEY (workspace_id, parent_reservation_id)
    REFERENCES public.credit_reservations(workspace_id, id),
  CONSTRAINT run_budget_allocations_amount_check CHECK (
    settled_credits + released_credits <= allocated_credits
  )
);

CREATE TABLE public.run_billing_reconciliations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  ledger_entry_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  billing_intent_hash text NOT NULL
    CHECK (billing_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  evidence_ref text NOT NULL CHECK (
    length(btrim(evidence_ref)) BETWEEN 1 AND 2048
    AND position('?' IN evidence_ref) = 0
    AND position('#' IN evidence_ref) = 0
  ),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  settled_credits bigint NOT NULL CHECK (settled_credits >= 0),
  released_credits bigint NOT NULL CHECK (released_credits >= 0),
  resolved_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_billing_reconciliations_run_key UNIQUE (workspace_id, run_id),
  CONSTRAINT run_billing_reconciliations_route_key
    UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT run_billing_reconciliations_owner_check
    CHECK (billing_owner_run_id = run_id),
  CONSTRAINT run_billing_reconciliations_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT run_billing_reconciliations_reservation_fkey FOREIGN KEY (
    workspace_id,
    reservation_id,
    run_id,
    billing_owner_run_id
  ) REFERENCES public.credit_reservations (
    workspace_id,
    id,
    run_id,
    billing_owner_run_id
  ),
  CONSTRAINT run_billing_reconciliations_ledger_fkey FOREIGN KEY (
    workspace_id,
    ledger_entry_id,
    run_id,
    billing_owner_run_id
  ) REFERENCES public.credits_ledger (
    workspace_id,
    id,
    run_id,
    billing_owner_run_id
  )
);

CREATE TABLE public.run_archive_manifests (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  terminal_intent_hash text NOT NULL
    CHECK (terminal_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  terminal_event_id uuid NOT NULL,
  terminal_event_sequence bigint NOT NULL CHECK (terminal_event_sequence > 0),
  archive_ref text NOT NULL CHECK (
    length(btrim(archive_ref)) BETWEEN 1 AND 2048
    AND position('?' IN archive_ref) = 0
    AND position('#' IN archive_ref) = 0
  ),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_archive_manifests_run_key
    UNIQUE (workspace_id, run_id),
  CONSTRAINT run_archive_manifests_exact_key UNIQUE (
    workspace_id,
    id,
    run_id,
    archive_ref,
    archive_sha256
  ),
  CONSTRAINT run_archive_manifests_run_fkey FOREIGN KEY (
    workspace_id,
    run_id,
    terminal_intent_hash,
    terminal_event_id,
    terminal_event_sequence
  ) REFERENCES public.runs (
    workspace_id,
    id,
    terminal_intent_hash,
    terminal_event_id,
    terminal_event_sequence
  )
);

CREATE TABLE public.run_archive_verification_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  run_id uuid NOT NULL,
  archive_ref text NOT NULL CHECK (length(btrim(archive_ref)) BETWEEN 1 AND 2048),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  receipt_ref text NOT NULL CHECK (
    length(btrim(receipt_ref)) BETWEEN 1 AND 2048
    AND position('?' IN receipt_ref) = 0
    AND position('#' IN receipt_ref) = 0
  ),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status = 'VERIFIED'),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_archive_verification_manifest_key UNIQUE (workspace_id, manifest_id),
  CONSTRAINT run_archive_verification_exact_key UNIQUE (
    workspace_id,
    id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256,
    receipt_sha256
  ),
  CONSTRAINT run_archive_verification_manifest_fkey FOREIGN KEY (
    workspace_id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256
  ) REFERENCES public.run_archive_manifests (
    workspace_id,
    id,
    run_id,
    archive_ref,
    archive_sha256
  ),
  CONSTRAINT run_archive_verification_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id)
);

CREATE TABLE public.run_archive_approval_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  verification_receipt_id uuid NOT NULL,
  verification_receipt_sha256 text NOT NULL
    CHECK (verification_receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  run_id uuid NOT NULL,
  archive_ref text NOT NULL CHECK (length(btrim(archive_ref)) BETWEEN 1 AND 2048),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  receipt_ref text NOT NULL CHECK (
    length(btrim(receipt_ref)) BETWEEN 1 AND 2048
    AND position('?' IN receipt_ref) = 0
    AND position('#' IN receipt_ref) = 0
  ),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status = 'APPROVED'),
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_archive_approval_manifest_key UNIQUE (workspace_id, manifest_id),
  CONSTRAINT run_archive_approval_exact_key UNIQUE (
    workspace_id,
    id,
    manifest_id,
    verification_receipt_id,
    run_id,
    archive_ref,
    archive_sha256,
    receipt_sha256
  ),
  CONSTRAINT run_archive_approval_manifest_fkey FOREIGN KEY (
    workspace_id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256
  ) REFERENCES public.run_archive_manifests (
    workspace_id,
    id,
    run_id,
    archive_ref,
    archive_sha256
  ),
  CONSTRAINT run_archive_approval_verification_fkey FOREIGN KEY (
    workspace_id,
    verification_receipt_id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256,
    verification_receipt_sha256
  ) REFERENCES public.run_archive_verification_receipts (
    workspace_id,
    id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256,
    receipt_sha256
  ),
  CONSTRAINT run_archive_approval_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id)
);

CREATE TABLE public.run_retention_purge_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  verification_receipt_id uuid NOT NULL,
  approval_receipt_id uuid NOT NULL,
  material_kind text NOT NULL CHECK (material_kind IN ('EVENTS', 'RECOVERY')),
  archive_ref text NOT NULL CHECK (length(btrim(archive_ref)) BETWEEN 1 AND 2048),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  verification_receipt_sha256 text NOT NULL
    CHECK (verification_receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  approval_receipt_sha256 text NOT NULL
    CHECK (approval_receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  purged_checkpoints bigint NOT NULL CHECK (purged_checkpoints >= 0),
  purged_events bigint NOT NULL CHECK (purged_events >= 0),
  purged_outbox bigint NOT NULL CHECK (purged_outbox >= 0),
  financial_ledger_purged boolean NOT NULL CHECK (financial_ledger_purged = false),
  purged_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT run_retention_purge_receipts_material_key
    UNIQUE (workspace_id, run_id, material_kind),
  CONSTRAINT run_retention_purge_receipts_run_fkey
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT run_retention_purge_receipts_manifest_fkey FOREIGN KEY (
    workspace_id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256
  ) REFERENCES public.run_archive_manifests (
    workspace_id,
    id,
    run_id,
    archive_ref,
    archive_sha256
  ),
  CONSTRAINT run_retention_purge_receipts_verification_fkey FOREIGN KEY (
    workspace_id,
    verification_receipt_id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256,
    verification_receipt_sha256
  ) REFERENCES public.run_archive_verification_receipts (
    workspace_id,
    id,
    manifest_id,
    run_id,
    archive_ref,
    archive_sha256,
    receipt_sha256
  ),
  CONSTRAINT run_retention_purge_receipts_approval_fkey FOREIGN KEY (
    workspace_id,
    approval_receipt_id,
    manifest_id,
    verification_receipt_id,
    run_id,
    archive_ref,
    archive_sha256,
    approval_receipt_sha256
  ) REFERENCES public.run_archive_approval_receipts (
    workspace_id,
    id,
    manifest_id,
    verification_receipt_id,
    run_id,
    archive_ref,
    archive_sha256,
    receipt_sha256
  ),
  CONSTRAINT run_retention_purge_receipts_shape_check CHECK (
    (
      material_kind = 'EVENTS'
      AND purged_checkpoints = 0
      AND purged_outbox = 0
    ) OR (
      material_kind = 'RECOVERY'
      AND purged_events = 0
    )
  )
);

-- Every durable fact is directly Workspace-scoped, FORCE RLS and owned by a
-- non-login role. Application roles receive no relation privileges below.
ALTER TABLE public.conversations OWNER TO ba_run_owner;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_owner_all ON public.conversations
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.conversation_states OWNER TO ba_run_owner;
ALTER TABLE public.conversation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_states FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_states_owner_all ON public.conversation_states
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.conversation_messages OWNER TO ba_run_owner;
ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_messages_owner_all ON public.conversation_messages
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_idempotency_sentinels OWNER TO ba_run_owner;
ALTER TABLE public.run_idempotency_sentinels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_idempotency_sentinels FORCE ROW LEVEL SECURITY;
CREATE POLICY run_idempotency_sentinels_owner_all ON public.run_idempotency_sentinels
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.runs OWNER TO ba_run_owner;
ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runs FORCE ROW LEVEL SECURITY;
CREATE POLICY runs_owner_all ON public.runs
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_acceptance_receipts OWNER TO ba_run_owner;
ALTER TABLE public.run_acceptance_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_acceptance_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_acceptance_receipts_owner_all ON public.run_acceptance_receipts
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_mutation_idempotency OWNER TO ba_run_owner;
ALTER TABLE public.run_mutation_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_mutation_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY run_mutation_idempotency_owner_all ON public.run_mutation_idempotency
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_attempts OWNER TO ba_run_owner;
ALTER TABLE public.run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_attempts_owner_all ON public.run_attempts
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_steps OWNER TO ba_run_owner;
ALTER TABLE public.run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY run_steps_owner_all ON public.run_steps
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_events OWNER TO ba_run_owner;
ALTER TABLE public.run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY run_events_owner_all ON public.run_events
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_checkpoints OWNER TO ba_run_owner;
ALTER TABLE public.run_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY run_checkpoints_owner_all ON public.run_checkpoints
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.human_gates OWNER TO ba_run_owner;
ALTER TABLE public.human_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_gates FORCE ROW LEVEL SECURITY;
CREATE POLICY human_gates_owner_all ON public.human_gates
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.outbox OWNER TO ba_run_owner;
ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_owner_all ON public.outbox
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_parent_links OWNER TO ba_run_owner;
ALTER TABLE public.run_parent_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_parent_links FORCE ROW LEVEL SECURITY;
CREATE POLICY run_parent_links_owner_all ON public.run_parent_links
  FOR ALL TO ba_run_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.credit_reservations OWNER TO ba_billing_owner;
ALTER TABLE public.credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_reservations_owner_all ON public.credit_reservations
  FOR ALL TO ba_billing_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.credits_ledger OWNER TO ba_billing_owner;
ALTER TABLE public.credits_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credits_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY credits_ledger_owner_all ON public.credits_ledger
  FOR ALL TO ba_billing_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_budget_allocations OWNER TO ba_billing_owner;
ALTER TABLE public.run_budget_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_budget_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY run_budget_allocations_owner_all ON public.run_budget_allocations
  FOR ALL TO ba_billing_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_billing_reconciliations OWNER TO ba_billing_owner;
ALTER TABLE public.run_billing_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_billing_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY run_billing_reconciliations_owner_all
  ON public.run_billing_reconciliations
  FOR ALL TO ba_billing_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_archive_manifests OWNER TO ba_archive_evidence_owner;
ALTER TABLE public.run_archive_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_archive_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY run_archive_manifests_owner_all ON public.run_archive_manifests
  FOR ALL TO ba_archive_evidence_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_archive_verification_receipts OWNER TO ba_archive_evidence_owner;
ALTER TABLE public.run_archive_verification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_archive_verification_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_archive_verification_receipts_owner_all
  ON public.run_archive_verification_receipts
  FOR ALL TO ba_archive_evidence_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_archive_approval_receipts OWNER TO ba_archive_evidence_owner;
ALTER TABLE public.run_archive_approval_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_archive_approval_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_archive_approval_receipts_owner_all
  ON public.run_archive_approval_receipts
  FOR ALL TO ba_archive_evidence_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.run_retention_purge_receipts OWNER TO ba_retention;
ALTER TABLE public.run_retention_purge_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_retention_purge_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_retention_purge_receipts_owner_all
  ON public.run_retention_purge_receipts
  FOR ALL TO ba_retention
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

-- Cross-owner access is column- and operation-scoped. RLS policy is required
-- in addition to column ACL because all participating tables FORCE RLS.
CREATE POLICY workspaces_g006_billing_owner_read ON public.workspaces
  FOR SELECT TO ba_billing_owner USING (id = app.current_workspace_id());
CREATE POLICY workspaces_g006_billing_owner_update ON public.workspaces
  FOR UPDATE TO ba_billing_owner
  USING (id = app.current_workspace_id())
  WITH CHECK (id = app.current_workspace_id());
GRANT SELECT (
  id,
  credits_balance,
  credits_reserved_balance,
  credits_balance_version
) ON TABLE public.workspaces TO ba_billing_owner;
GRANT UPDATE (
  credits_balance,
  credits_reserved_balance,
  credits_balance_version
) ON TABLE public.workspaces TO ba_billing_owner;

CREATE POLICY runs_g006_billing_owner_read ON public.runs
  FOR SELECT TO ba_billing_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY runs_g006_billing_owner_update ON public.runs
  FOR UPDATE TO ba_billing_owner
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
GRANT SELECT (
  id,
  workspace_id,
  billing_owner_run_id,
  accepted_plan_hash,
  billing_state,
  billing_settled_at,
  status,
  termination_reason
) ON TABLE public.runs TO ba_billing_owner;
GRANT UPDATE (
  billing_state,
  billing_settled_at
) ON TABLE public.runs TO ba_billing_owner;

CREATE POLICY runs_g006_archive_owner_read ON public.runs
  FOR SELECT TO ba_archive_evidence_owner
  USING (workspace_id = app.current_workspace_id());
GRANT SELECT (
  id,
  workspace_id,
  status,
  billing_state,
  terminal_intent_hash,
  terminal_event_id,
  terminal_event_sequence,
  finished_at,
  events_retention_until,
  recovery_retention_until,
  retention_until
) ON TABLE public.runs TO ba_archive_evidence_owner;

CREATE POLICY runs_g006_retention_read ON public.runs
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
GRANT SELECT (
  id,
  workspace_id,
  status,
  billing_state,
  finished_at,
  events_retention_until,
  recovery_retention_until,
  retention_until
) ON TABLE public.runs TO ba_retention;
CREATE POLICY credit_reservations_retention_read ON public.credit_reservations
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
GRANT SELECT (
  workspace_id,
  run_id,
  status
) ON TABLE public.credit_reservations TO ba_retention;
CREATE POLICY run_billing_reconciliations_retention_read
  ON public.run_billing_reconciliations
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
GRANT SELECT (
  workspace_id,
  run_id
) ON TABLE public.run_billing_reconciliations TO ba_retention;
CREATE POLICY run_archive_manifests_retention_read ON public.run_archive_manifests
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
CREATE POLICY run_archive_verification_retention_read
  ON public.run_archive_verification_receipts
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
CREATE POLICY run_archive_approval_retention_read
  ON public.run_archive_approval_receipts
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
GRANT SELECT (
  workspace_id,
  id,
  run_id,
  archive_ref,
  archive_sha256
) ON TABLE public.run_archive_manifests TO ba_retention;
GRANT SELECT (
  workspace_id,
  id,
  manifest_id,
  run_id,
  archive_ref,
  archive_sha256,
  receipt_sha256,
  status
) ON TABLE public.run_archive_verification_receipts TO ba_retention;
GRANT SELECT (
  workspace_id,
  id,
  manifest_id,
  verification_receipt_id,
  verification_receipt_sha256,
  run_id,
  archive_ref,
  archive_sha256,
  receipt_sha256,
  status
) ON TABLE public.run_archive_approval_receipts TO ba_retention;
CREATE POLICY run_events_retention_delete ON public.run_events
  FOR DELETE TO ba_retention USING (workspace_id = app.current_workspace_id());
CREATE POLICY run_events_retention_read ON public.run_events
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
CREATE POLICY run_checkpoints_retention_delete ON public.run_checkpoints
  FOR DELETE TO ba_retention USING (workspace_id = app.current_workspace_id());
CREATE POLICY run_checkpoints_retention_read ON public.run_checkpoints
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
CREATE POLICY outbox_retention_delete ON public.outbox
  FOR DELETE TO ba_retention USING (
    workspace_id = app.current_workspace_id()
    AND status = 'DELIVERED'
  );
CREATE POLICY outbox_retention_read ON public.outbox
  FOR SELECT TO ba_retention USING (workspace_id = app.current_workspace_id());
GRANT SELECT (
  workspace_id,
  run_id,
  status
) ON TABLE public.outbox TO ba_retention;
GRANT SELECT (
  workspace_id,
  run_id
) ON TABLE public.run_events TO ba_retention;
GRANT SELECT (
  workspace_id,
  run_id
) ON TABLE public.run_checkpoints TO ba_retention;
GRANT DELETE ON TABLE
  public.run_events,
  public.run_checkpoints,
  public.outbox
TO ba_retention;

-- G0-06 owner-only target validators need a pre-context view of exact G0-05
-- Deployment facts. This is never granted to an executable role and it does
-- not read active pointers for original-Run authorization.
CREATE POLICY agent_deployments_g006_authorization_owner_read
  ON public.agent_deployments FOR SELECT TO ba_authorization_owner
  USING (workspace_id = app.current_workspace_id());
CREATE POLICY agent_deployment_security_g006_authorization_owner_read
  ON public.agent_deployment_security_states
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY agent_deployment_revisions_g006_authorization_owner_read
  ON public.agent_deployment_revisions
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY agent_deployment_pointers_g006_authorization_owner_read
  ON public.agent_deployment_active_pointers
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY agent_deployment_grants_g006_authorization_owner_read
  ON public.agent_deployment_entry_grants
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY flow_deployments_g006_authorization_owner_read
  ON public.flow_deployments FOR SELECT TO ba_authorization_owner
  USING (workspace_id = app.current_workspace_id());
CREATE POLICY flow_deployment_security_g006_authorization_owner_read
  ON public.flow_deployment_security_states
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY flow_deployment_revisions_g006_authorization_owner_read
  ON public.flow_deployment_revisions
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY flow_deployment_pointers_g006_authorization_owner_read
  ON public.flow_deployment_active_pointers
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());
CREATE POLICY flow_deployment_grants_g006_authorization_owner_read
  ON public.flow_deployment_entry_grants
  FOR SELECT TO ba_authorization_owner USING (workspace_id = app.current_workspace_id());

CREATE FUNCTION app.validate_agent_acceptance_target(
  p_workspace_id uuid,
  p_deployment_id uuid,
  p_revision_id uuid,
  p_agent_id uuid,
  p_agent_release_id uuid,
  p_experience_release_id uuid,
  p_conversation_contract_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  PERFORM 1
    FROM public.agent_deployments AS deployment
    JOIN public.agent_deployment_security_states AS security_state
      ON security_state.workspace_id = deployment.workspace_id
     AND security_state.agent_deployment_id = deployment.id
    JOIN public.agent_deployment_active_pointers AS active_pointer
      ON active_pointer.workspace_id = deployment.workspace_id
     AND active_pointer.agent_deployment_id = deployment.id
    JOIN public.agent_deployment_revisions AS revision
      ON revision.workspace_id = active_pointer.workspace_id
     AND revision.agent_deployment_id = active_pointer.agent_deployment_id
     AND revision.id = active_pointer.active_revision_id
   WHERE deployment.workspace_id = p_workspace_id
     AND deployment.id = p_deployment_id
     AND deployment.ingress_channel IN ('browser', 'service_api')
     AND security_state.status = 'ACTIVE'
     AND revision.id = p_revision_id
     AND revision.agent_id = p_agent_id
     AND revision.agent_release_id = p_agent_release_id
     AND revision.experience_release_id = p_experience_release_id
     AND revision.conversation_contract_hash = p_conversation_contract_hash
   FOR SHARE OF deployment, security_state, active_pointer, revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent acceptance target is not the active exact pinned revision'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;
ALTER FUNCTION app.validate_agent_acceptance_target(
  uuid, uuid, uuid, uuid, uuid, uuid, text
) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.validate_agent_acceptance_target(
  uuid, uuid, uuid, uuid, uuid, uuid, text
) FROM PUBLIC;

CREATE FUNCTION app.validate_flow_acceptance_target(
  p_workspace_id uuid,
  p_deployment_id uuid,
  p_revision_id uuid,
  p_flow_id uuid,
  p_flow_version_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  PERFORM 1
    FROM public.flow_deployments AS deployment
    JOIN public.flow_deployment_security_states AS security_state
      ON security_state.workspace_id = deployment.workspace_id
     AND security_state.flow_deployment_id = deployment.id
    JOIN public.flow_deployment_active_pointers AS active_pointer
      ON active_pointer.workspace_id = deployment.workspace_id
     AND active_pointer.flow_deployment_id = deployment.id
    JOIN public.flow_deployment_revisions AS revision
      ON revision.workspace_id = active_pointer.workspace_id
     AND revision.flow_deployment_id = active_pointer.flow_deployment_id
     AND revision.id = active_pointer.active_revision_id
   WHERE deployment.workspace_id = p_workspace_id
     AND deployment.id = p_deployment_id
     AND deployment.ingress_channel = 'service_api'
     AND security_state.status = 'ACTIVE'
     AND revision.id = p_revision_id
     AND revision.flow_id = p_flow_id
     AND revision.flow_version_id = p_flow_version_id
   FOR SHARE OF deployment, security_state, active_pointer, revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow acceptance target is not the active exact pinned revision'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;
ALTER FUNCTION app.validate_flow_acceptance_target(uuid, uuid, uuid, uuid, uuid)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.validate_flow_acceptance_target(
  uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION app.authorize_agent_original_run(
  p_workspace_id uuid,
  p_credential_id uuid,
  p_deployment_id uuid,
  p_required_scope text,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authorized_at timestamptz := clock_timestamp();
BEGIN
  IF p_required_scope NOT IN ('run:read', 'run:events:read', 'run:cancel') THEN
    RAISE EXCEPTION 'unsupported original Agent Run scope'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.agent_deployments AS deployment
    JOIN public.agent_deployment_security_states AS security_state
      ON security_state.workspace_id = deployment.workspace_id
     AND security_state.agent_deployment_id = deployment.id
    JOIN public.agent_deployment_entry_grants AS grant_row
      ON grant_row.workspace_id = deployment.workspace_id
     AND grant_row.agent_deployment_id = deployment.id
    JOIN public.api_credentials AS credential
      ON credential.workspace_id = grant_row.workspace_id
     AND credential.id = grant_row.credential_id
     AND credential.credential_kind = grant_row.credential_kind
    JOIN public.api_credential_scopes AS literal_scope
      ON literal_scope.workspace_id = credential.workspace_id
     AND literal_scope.credential_id = credential.id
     AND literal_scope.credential_kind = credential.credential_kind
     AND literal_scope.scope = grant_row.scope
   WHERE deployment.workspace_id = p_workspace_id
     AND deployment.id = p_deployment_id
     AND deployment.ingress_channel = 'service_api'
     AND security_state.status = 'ACTIVE'
     AND grant_row.credential_id = p_credential_id
     AND grant_row.credential_kind = 'service_api'
     AND grant_row.ingress_channel = 'service_api'
     AND grant_row.scope = p_required_scope
     AND grant_row.status = 'ACTIVE'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= v_authorized_at)
     AND (credential.expires_at IS NULL OR credential.expires_at > v_authorized_at)
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= v_authorized_at)
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > v_authorized_at)
     AND literal_scope.scope = p_required_scope
   FOR SHARE OF deployment, security_state, grant_row, credential, literal_scope;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current Agent original-Run grant is unavailable'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;
ALTER FUNCTION app.authorize_agent_original_run(uuid, uuid, uuid, text, timestamptz)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.authorize_agent_original_run(
  uuid, uuid, uuid, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION app.authorize_flow_original_run(
  p_workspace_id uuid,
  p_credential_id uuid,
  p_deployment_id uuid,
  p_required_scope text,
  p_now timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authorized_at timestamptz := clock_timestamp();
BEGIN
  IF p_required_scope NOT IN ('run:read', 'run:events:read', 'run:cancel') THEN
    RAISE EXCEPTION 'unsupported original Flow Run scope'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.flow_deployments AS deployment
    JOIN public.flow_deployment_security_states AS security_state
      ON security_state.workspace_id = deployment.workspace_id
     AND security_state.flow_deployment_id = deployment.id
    JOIN public.flow_deployment_entry_grants AS grant_row
      ON grant_row.workspace_id = deployment.workspace_id
     AND grant_row.flow_deployment_id = deployment.id
    JOIN public.api_credentials AS credential
      ON credential.workspace_id = grant_row.workspace_id
     AND credential.id = grant_row.credential_id
     AND credential.credential_kind = grant_row.credential_kind
    JOIN public.api_credential_scopes AS literal_scope
      ON literal_scope.workspace_id = credential.workspace_id
     AND literal_scope.credential_id = credential.id
     AND literal_scope.credential_kind = credential.credential_kind
     AND literal_scope.scope = grant_row.scope
   WHERE deployment.workspace_id = p_workspace_id
     AND deployment.id = p_deployment_id
     AND deployment.ingress_channel = 'service_api'
     AND security_state.status = 'ACTIVE'
     AND grant_row.credential_id = p_credential_id
     AND grant_row.credential_kind = 'service_api'
     AND grant_row.ingress_channel = 'service_api'
     AND grant_row.scope = p_required_scope
     AND grant_row.status = 'ACTIVE'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= v_authorized_at)
     AND (credential.expires_at IS NULL OR credential.expires_at > v_authorized_at)
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= v_authorized_at)
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > v_authorized_at)
     AND literal_scope.scope = p_required_scope
   FOR SHARE OF deployment, security_state, grant_row, credential, literal_scope;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current Flow original-Run grant is unavailable'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;
ALTER FUNCTION app.authorize_flow_original_run(uuid, uuid, uuid, text, timestamptz)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.authorize_flow_original_run(
  uuid, uuid, uuid, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.validate_agent_acceptance_target(
  uuid, uuid, uuid, uuid, uuid, uuid, text
), app.validate_flow_acceptance_target(
  uuid, uuid, uuid, uuid, uuid
), app.authorize_agent_original_run(
  uuid, uuid, uuid, text, timestamptz
), app.authorize_flow_original_run(
  uuid, uuid, uuid, text, timestamptz
) TO ba_run_owner;

CREATE FUNCTION app.reject_g006_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'G0-06 immutable fact cannot be updated or deleted'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION app.reject_g006_immutable_change() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.reject_g006_immutable_change() FROM PUBLIC;

CREATE FUNCTION app.reject_g006_unavailable_path()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'G0-06 path is unavailable before G0-07/G1 closure'
    USING ERRCODE = '0A000';
END;
$function$;
ALTER FUNCTION app.reject_g006_unavailable_path() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.reject_g006_unavailable_path() FROM PUBLIC;

CREATE FUNCTION app.protect_run_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_comparison_excluded_columns text[] := ARRAY[
    -- PostgreSQL has not recomputed STORED generated columns in NEW when a
    -- BEFORE trigger runs. The two source principal columns remain compared.
    'accepted_principal_id',
    'status',
    'execution_status',
    'billing_state',
    'billing_settled_at',
    'last_event_sequence',
    'termination_reason',
    'terminal_intent_hash',
    'terminal_result_redacted',
    'terminal_error_redacted',
    'terminal_billing_pending',
    'terminal_billing_pending_at',
    'terminal_event_id',
    'terminal_event_sequence',
    'finished_at',
    'events_retention_until',
    'recovery_retention_until',
    'retention_until'
  ];
  v_old_billing_rank integer;
  v_new_billing_rank integer;
  v_changed_immutable_columns text;
  v_changed_billing_forbidden_columns text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Run facts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF current_user NOT IN ('ba_run_owner', 'ba_billing_owner') THEN
    RAISE EXCEPTION 'Run mutation must use a reviewed owner primitive'
      USING ERRCODE = '42501';
  END IF;
  SELECT string_agg(new_field.key, ',' ORDER BY new_field.key)
    INTO v_changed_immutable_columns
    FROM jsonb_each(to_jsonb(NEW)) AS new_field(key, value)
    JOIN jsonb_each(to_jsonb(OLD)) AS old_field(key, value)
      ON old_field.key = new_field.key
   WHERE new_field.key <> ALL (v_comparison_excluded_columns)
     AND new_field.value IS DISTINCT FROM old_field.value;
  IF v_changed_immutable_columns IS NOT NULL THEN
    RAISE EXCEPTION 'accepted Run identity and target pins are immutable'
      USING ERRCODE = '55000',
            DETAIL = 'changed columns: ' || v_changed_immutable_columns;
  END IF;
  IF current_user = 'ba_billing_owner' THEN
    SELECT string_agg(new_field.key, ',' ORDER BY new_field.key)
      INTO v_changed_billing_forbidden_columns
      FROM jsonb_each(to_jsonb(NEW)) AS new_field(key, value)
      JOIN jsonb_each(to_jsonb(OLD)) AS old_field(key, value)
        ON old_field.key = new_field.key
     WHERE new_field.key <> ALL (ARRAY[
       'accepted_principal_id', 'billing_state', 'billing_settled_at'
     ])
       AND new_field.value IS DISTINCT FROM old_field.value;
  END IF;
  IF v_changed_billing_forbidden_columns IS NOT NULL THEN
    RAISE EXCEPTION 'billing owner may only advance the Run billing projection'
      USING ERRCODE = '42501',
            DETAIL = 'changed columns: ' || v_changed_billing_forbidden_columns;
  END IF;
  IF NEW.last_event_sequence < OLD.last_event_sequence THEN
    RAISE EXCEPTION 'Run event sequence cannot move backwards'
      USING ERRCODE = '55000';
  END IF;
  IF (OLD.events_retention_until IS NOT NULL AND (
        NEW.events_retention_until IS NULL
        OR NEW.events_retention_until < OLD.events_retention_until
      ))
     OR (OLD.recovery_retention_until IS NOT NULL AND (
        NEW.recovery_retention_until IS NULL
        OR NEW.recovery_retention_until < OLD.recovery_retention_until
      ))
     OR (OLD.retention_until IS NOT NULL AND (
        NEW.retention_until IS NULL
        OR NEW.retention_until < OLD.retention_until
      )) THEN
    RAISE EXCEPTION 'Run retention horizons cannot shrink'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.events_retention_until IS NOT NULL AND (
       NEW.recovery_retention_until IS NULL
       OR NEW.retention_until IS NULL
       OR NEW.recovery_retention_until < NEW.events_retention_until
       OR NEW.retention_until < NEW.recovery_retention_until
     ) THEN
    RAISE EXCEPTION 'Run retention horizons must remain ordered'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.terminal_intent_hash IS NOT NULL AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.execution_status IS DISTINCT FROM OLD.execution_status
       OR NEW.termination_reason IS DISTINCT FROM OLD.termination_reason
       OR NEW.terminal_intent_hash IS DISTINCT FROM OLD.terminal_intent_hash
       OR NEW.terminal_result_redacted IS DISTINCT FROM OLD.terminal_result_redacted
       OR NEW.terminal_error_redacted IS DISTINCT FROM OLD.terminal_error_redacted
       OR NEW.terminal_billing_pending IS DISTINCT FROM OLD.terminal_billing_pending
       OR NEW.terminal_billing_pending_at IS DISTINCT FROM OLD.terminal_billing_pending_at
       OR NEW.terminal_event_id IS DISTINCT FROM OLD.terminal_event_id
       OR NEW.terminal_event_sequence IS DISTINCT FROM OLD.terminal_event_sequence
       OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
     ) THEN
    RAISE EXCEPTION 'Run terminal tombstone is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.terminal_intent_hash IS NOT NULL
     AND NEW.terminal_event_sequence IS DISTINCT FROM NEW.last_event_sequence THEN
    RAISE EXCEPTION 'Run terminal event must close the event sequence'
      USING ERRCODE = '23514';
  END IF;
  v_old_billing_rank := CASE OLD.billing_state
    WHEN 'PENDING' THEN 0 WHEN 'NEEDS_ATTENTION' THEN 1 WHEN 'SETTLED' THEN 2
  END;
  v_new_billing_rank := CASE NEW.billing_state
    WHEN 'PENDING' THEN 0 WHEN 'NEEDS_ATTENTION' THEN 1 WHEN 'SETTLED' THEN 2
  END;
  IF v_new_billing_rank < v_old_billing_rank
     OR (OLD.billing_settled_at IS NOT NULL
         AND NEW.billing_settled_at IS DISTINCT FROM OLD.billing_settled_at) THEN
    RAISE EXCEPTION 'Run billing projection cannot move backwards'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION app.protect_run_change() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.protect_run_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.protect_run_change() TO ba_billing_owner;

CREATE TRIGGER runs_monotonic_change
BEFORE UPDATE OR DELETE ON public.runs
FOR EACH ROW EXECUTE FUNCTION app.protect_run_change();

CREATE TRIGGER run_idempotency_sentinels_immutable
BEFORE UPDATE OR DELETE ON public.run_idempotency_sentinels
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE TRIGGER run_acceptance_receipts_immutable
BEFORE UPDATE OR DELETE ON public.run_acceptance_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE FUNCTION app.protect_run_event_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'ba_retention' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Run events are append-only outside reviewed retention'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION app.protect_run_event_change() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.protect_run_event_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.protect_run_event_change() TO ba_retention;
CREATE TRIGGER run_events_append_only
BEFORE UPDATE OR DELETE ON public.run_events
FOR EACH ROW EXECUTE FUNCTION app.protect_run_event_change();
CREATE TRIGGER credits_ledger_append_only
BEFORE UPDATE OR DELETE ON public.credits_ledger
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE TRIGGER run_billing_reconciliations_immutable
BEFORE UPDATE OR DELETE ON public.run_billing_reconciliations
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE TRIGGER run_archive_manifests_immutable
BEFORE UPDATE OR DELETE ON public.run_archive_manifests
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE TRIGGER run_archive_verification_receipts_immutable
BEFORE UPDATE OR DELETE ON public.run_archive_verification_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE TRIGGER run_archive_approval_receipts_immutable
BEFORE UPDATE OR DELETE ON public.run_archive_approval_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE TRIGGER run_retention_purge_receipts_immutable
BEFORE UPDATE OR DELETE ON public.run_retention_purge_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();
CREATE TRIGGER run_parent_links_unavailable
BEFORE INSERT ON public.run_parent_links
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_unavailable_path();
CREATE TRIGGER run_budget_allocations_unavailable
BEFORE INSERT ON public.run_budget_allocations
FOR EACH ROW EXECUTE FUNCTION app.reject_g006_unavailable_path();

CREATE FUNCTION app.validate_billing_producer(
  p_workspace_id uuid,
  p_billing_owner_run_id uuid,
  p_producer_run_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_step_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF p_workspace_id IS NULL
     OR p_billing_owner_run_id IS NULL
     OR p_producer_run_id IS NULL
     OR p_attempt_id IS NULL
     OR p_fencing_token IS NULL
     OR p_fencing_token <= 0 THEN
    RAISE EXCEPTION 'metered billing requires complete producer fencing facts'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.runs AS billing_run
    JOIN public.runs AS producer_run
      ON producer_run.workspace_id = billing_run.workspace_id
     AND producer_run.id = p_producer_run_id
     AND producer_run.billing_owner_run_id = billing_run.id
    JOIN public.run_attempts AS attempt
      ON attempt.workspace_id = producer_run.workspace_id
     AND attempt.run_id = producer_run.id
     AND attempt.id = p_attempt_id
    LEFT JOIN public.run_steps AS step_row
      ON step_row.workspace_id = producer_run.workspace_id
     AND step_row.run_id = producer_run.id
     AND step_row.attempt_id = attempt.id
     AND step_row.id = p_step_id
   WHERE billing_run.workspace_id = p_workspace_id
     AND billing_run.id = p_billing_owner_run_id
     AND billing_run.billing_owner_run_id = billing_run.id
     AND attempt.lease_fencing_token = p_fencing_token
     AND (p_step_id IS NULL OR step_row.id IS NOT NULL)
   FOR SHARE OF billing_run, producer_run, attempt;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing producer Run/Attempt/fence/Step facts do not match'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;
ALTER FUNCTION app.validate_billing_producer(uuid, uuid, uuid, uuid, bigint, uuid)
  OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.validate_billing_producer(
  uuid, uuid, uuid, uuid, bigint, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.validate_billing_producer(
  uuid, uuid, uuid, uuid, bigint, uuid
) TO ba_billing_owner;

CREATE FUNCTION app.lock_billing_workspace(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'billing Workspace lock requires a tenant'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1
   FROM public.workspaces AS workspace_row
   WHERE workspace_row.id = p_workspace_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for billing serialization'
      USING ERRCODE = '23503';
  END IF;
END;
$function$;
ALTER FUNCTION app.lock_billing_workspace(uuid) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.lock_billing_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_billing_workspace(uuid) TO ba_run_owner;

CREATE FUNCTION app.lock_billing_reservation_summary(
  p_workspace_id uuid,
  p_run_id uuid,
  p_reservation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_reservation public.credit_reservations%ROWTYPE;
BEGIN
  PERFORM app.lock_billing_workspace(p_workspace_id);
  SELECT reservation.*
    INTO v_reservation
    FROM public.credit_reservations AS reservation
   WHERE reservation.workspace_id = p_workspace_id
     AND reservation.id = p_reservation_id
     AND reservation.run_id = p_run_id
     AND reservation.billing_owner_run_id = p_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run reservation is unavailable for finalization'
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'reservation_id', v_reservation.id,
    'status', v_reservation.status,
    'reserved_credits', v_reservation.reserved_credits,
    'settled_credits', v_reservation.settled_credits,
    'released_credits', v_reservation.released_credits,
    'updated_at', v_reservation.updated_at
  );
END;
$function$;
ALTER FUNCTION app.lock_billing_reservation_summary(uuid, uuid, uuid)
  OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.lock_billing_reservation_summary(uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_billing_reservation_summary(uuid, uuid, uuid)
  TO ba_run_owner;

CREATE FUNCTION app.reserve_credits(
  p_workspace_id uuid,
  p_run_id uuid,
  p_reservation_id uuid,
  p_ledger_entry_id uuid,
  p_amount_credits bigint,
  p_accepted_plan_hash text,
  p_charge_key text,
  p_billing_intent_hash text,
  p_charge_attribution_hash text,
  p_expires_at timestamptz,
  p_created_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_existing public.credits_ledger%ROWTYPE;
  v_balance bigint;
  v_reserved bigint;
  v_version bigint;
  v_next_version bigint;
BEGIN
  IF p_workspace_id IS NULL
     OR p_run_id IS NULL
     OR p_reservation_id IS NULL
     OR p_ledger_entry_id IS NULL
     OR p_amount_credits IS NULL
     OR p_amount_credits < 0
     OR p_accepted_plan_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_billing_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_charge_attribution_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_charge_attribution_hash IS DISTINCT FROM p_accepted_plan_hash
     OR length(btrim(p_charge_key)) NOT BETWEEN 1 AND 300
     OR p_expires_at IS NULL
     OR p_created_at IS NULL
     OR p_expires_at <= p_created_at THEN
    RAISE EXCEPTION 'invalid reserve_credits intent'
      USING ERRCODE = '22023';
  END IF;

  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'RESERVE'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.charge_attribution_hash <> p_accepted_plan_hash
       OR v_existing.reserved_delta_credits <> p_amount_credits THEN
      RAISE EXCEPTION 'billing charge key was reused with a different reserve intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.reservation_id;
  END IF;

  SELECT workspace_row.credits_balance,
         workspace_row.credits_reserved_balance,
         workspace_row.credits_balance_version
    INTO v_balance, v_reserved, v_version
    FROM public.workspaces AS workspace_row
   WHERE workspace_row.id = p_workspace_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace is unavailable for credit reservation'
      USING ERRCODE = '23503';
  END IF;

  -- The Workspace row is the billing serialization fence. Re-read the
  -- charge key after taking it so concurrent identical calls replay instead
  -- of falling through to a unique-constraint race.
  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'RESERVE'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.charge_attribution_hash <> p_accepted_plan_hash
       OR v_existing.reserved_delta_credits <> p_amount_credits THEN
      RAISE EXCEPTION 'billing charge key was reused with a different reserve intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.reservation_id;
  END IF;
  IF v_balance < p_amount_credits THEN
    RAISE EXCEPTION 'insufficient Workspace credits'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.runs AS run_row
   WHERE run_row.workspace_id = p_workspace_id
     AND run_row.id = p_run_id
     AND run_row.billing_owner_run_id = run_row.id
     AND run_row.accepted_plan_hash = p_accepted_plan_hash
     AND run_row.billing_state = 'PENDING'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit reservation does not match an accepted top-level Run'
      USING ERRCODE = '23503';
  END IF;

  v_next_version := v_version + CASE WHEN p_amount_credits = 0 THEN 0 ELSE 1 END;
  UPDATE public.workspaces
     SET credits_balance = v_balance - p_amount_credits,
         credits_reserved_balance = v_reserved + p_amount_credits,
         credits_balance_version = v_next_version
   WHERE id = p_workspace_id;

  INSERT INTO public.credit_reservations (
    workspace_id,
    id,
    run_id,
    billing_owner_run_id,
    accepted_plan_hash,
    status,
    reserved_credits,
    settled_credits,
    released_credits,
    balance_version,
    expires_at,
    created_at,
    updated_at
  ) VALUES (
    p_workspace_id,
    p_reservation_id,
    p_run_id,
    p_run_id,
    p_accepted_plan_hash,
    'HELD',
    p_amount_credits,
    0,
    0,
    v_next_version,
    p_expires_at,
    p_created_at,
    p_created_at
  );

  INSERT INTO public.credits_ledger (
    workspace_id,
    id,
    run_id,
    billing_owner_run_id,
    producer_run_id,
    reservation_id,
    entry_kind,
    available_delta_credits,
    reserved_delta_credits,
    settled_delta_credits,
    billing_intent_hash,
    charge_attribution_hash,
    charge_key,
    balance_before,
    reserved_before,
    balance_after,
    reserved_after,
    balance_version,
    metering_detail_redacted,
    created_at
  ) VALUES (
    p_workspace_id,
    p_ledger_entry_id,
    p_run_id,
    p_run_id,
    p_run_id,
    p_reservation_id,
    'RESERVE',
    -p_amount_credits,
    p_amount_credits,
    0,
    p_billing_intent_hash,
    p_accepted_plan_hash,
    p_charge_key,
    v_balance,
    v_reserved,
    v_balance - p_amount_credits,
    v_reserved + p_amount_credits,
    v_next_version,
    '{}'::jsonb,
    p_created_at
  );

  RETURN p_reservation_id;
END;
$function$;
ALTER FUNCTION app.reserve_credits(
  uuid, uuid, uuid, uuid, bigint, text, text, text, text, timestamptz, timestamptz
) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.reserve_credits(
  uuid, uuid, uuid, uuid, bigint, text, text, text, text, timestamptz, timestamptz
) FROM PUBLIC;

CREATE FUNCTION app.settle_credits(
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

CREATE FUNCTION app.release_credits(
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

CREATE FUNCTION app.expire_credit_reservation(
  p_workspace_id uuid,
  p_run_id uuid,
  p_reservation_id uuid,
  p_ledger_entry_id uuid,
  p_charge_key text,
  p_billing_intent_hash text,
  p_charge_attribution_hash text,
  p_now timestamptz
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
  v_remaining bigint;
BEGIN
  IF p_billing_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_charge_attribution_hash !~ '^sha256:[0-9a-f]{64}$'
     OR length(btrim(p_charge_key)) NOT BETWEEN 1 AND 300
     OR p_now IS NULL THEN
    RAISE EXCEPTION 'invalid expire_credit_reservation intent'
      USING ERRCODE = '22023';
  END IF;

  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'EXPIRED'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id THEN
      RAISE EXCEPTION 'billing charge key was reused with a different expiry intent'
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
    RAISE EXCEPTION 'Workspace is unavailable for reservation expiry'
      USING ERRCODE = '23503';
  END IF;

  SELECT ledger.*
    INTO v_existing
    FROM public.credits_ledger AS ledger
   WHERE ledger.workspace_id = p_workspace_id
     AND ledger.charge_key = p_charge_key;
  IF FOUND THEN
    IF v_existing.entry_kind <> 'EXPIRED'
       OR v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id THEN
      RAISE EXCEPTION 'billing charge key was reused with a different expiry intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT reservation.*
    INTO v_reservation
    FROM public.credit_reservations AS reservation
   WHERE reservation.workspace_id = p_workspace_id
     AND reservation.id = p_reservation_id
     AND reservation.run_id = p_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation is not eligible for expiry'
      USING ERRCODE = '23514';
  END IF;
  IF p_now < v_reservation.updated_at THEN
    RAISE EXCEPTION 'reservation expiry timestamp predates the reservation update'
      USING ERRCODE = '23514';
  END IF;
  IF v_reservation.status <> 'HELD'
     OR v_reservation.settled_credits <> 0
     OR v_reservation.released_credits <> 0
     OR p_now < v_reservation.expires_at THEN
    RAISE EXCEPTION 'reservation is not eligible for expiry'
      USING ERRCODE = '23514';
  END IF;

  v_remaining := v_reservation.reserved_credits - v_reservation.released_credits;
  IF v_reserved < v_remaining THEN
    RAISE EXCEPTION 'Workspace reserved balance is inconsistent with reservation expiry'
      USING ERRCODE = '23514';
  END IF;
  v_next_version := v_version + CASE WHEN v_remaining = 0 THEN 0 ELSE 1 END;
  UPDATE public.workspaces
     SET credits_balance = v_balance + v_remaining,
         credits_reserved_balance = v_reserved - v_remaining,
         credits_balance_version = v_next_version
   WHERE id = p_workspace_id;
  UPDATE public.credit_reservations
     SET released_credits = reserved_credits,
         status = 'EXPIRED',
         released_at = p_now,
         status_reason_code = 'RESERVATION_EXPIRED',
         balance_version = v_next_version,
         updated_at = p_now
   WHERE workspace_id = p_workspace_id
     AND id = p_reservation_id;

  INSERT INTO public.credits_ledger (
    workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
    reservation_id, entry_kind,
    available_delta_credits, reserved_delta_credits, settled_delta_credits,
    billing_intent_hash, charge_attribution_hash, charge_key,
    balance_before, reserved_before, balance_after, reserved_after,
    balance_version, metering_detail_redacted, created_at
  ) VALUES (
    p_workspace_id, p_ledger_entry_id, p_run_id, p_run_id, p_run_id,
    p_reservation_id, 'EXPIRED',
    v_remaining, -v_remaining, 0,
    p_billing_intent_hash, p_charge_attribution_hash, p_charge_key,
    v_balance, v_reserved, v_balance + v_remaining, v_reserved - v_remaining,
    v_next_version, '{}'::jsonb, p_now
  );
  RETURN p_ledger_entry_id;
END;
$function$;
ALTER FUNCTION app.expire_credit_reservation(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz
) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.expire_credit_reservation(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz
) FROM PUBLIC;

CREATE FUNCTION app.reconcile_run_billing(
  p_workspace_id uuid,
  p_run_id uuid,
  p_reservation_id uuid,
  p_reconciliation_id uuid,
  p_ledger_entry_id uuid,
  p_idempotency_key text,
  p_billing_intent_hash text,
  p_charge_key text,
  p_charge_attribution_hash text,
  p_settle_credits bigint,
  p_release_credits bigint,
  p_evidence_ref text,
  p_evidence_sha256 text,
  p_resolved_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_existing public.run_billing_reconciliations%ROWTYPE;
  v_reservation public.credit_reservations%ROWTYPE;
  v_balance bigint;
  v_reserved bigint;
  v_version bigint;
  v_next_version bigint;
  v_total bigint;
  v_evidence_only boolean := false;
BEGIN
  IF p_settle_credits IS NULL OR p_settle_credits < 0
     OR p_release_credits IS NULL OR p_release_credits < 0
     OR p_billing_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_charge_attribution_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_evidence_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR p_charge_attribution_hash IS DISTINCT FROM p_evidence_sha256
     OR length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 128
     OR length(btrim(p_charge_key)) NOT BETWEEN 1 AND 300
     OR length(btrim(p_evidence_ref)) NOT BETWEEN 1 AND 2048
     OR position('?' IN p_evidence_ref) > 0
     OR position('#' IN p_evidence_ref) > 0
     OR p_resolved_at IS NULL THEN
    RAISE EXCEPTION 'invalid reconcile_run_billing intent'
      USING ERRCODE = '22023';
  END IF;

  SELECT reconciliation.*
    INTO v_existing
    FROM public.run_billing_reconciliations AS reconciliation
   WHERE reconciliation.workspace_id = p_workspace_id
     AND reconciliation.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.id <> p_reconciliation_id
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.ledger_entry_id <> p_ledger_entry_id
       OR v_existing.evidence_ref <> p_evidence_ref
       OR v_existing.evidence_sha256 <> p_evidence_sha256
       OR v_existing.settled_credits <> p_settle_credits
       OR v_existing.released_credits <> p_release_credits
       OR NOT EXISTS (
         SELECT 1
           FROM public.credits_ledger AS ledger
          WHERE ledger.workspace_id = p_workspace_id
            AND ledger.id = v_existing.ledger_entry_id
            AND ledger.charge_key = p_charge_key
            AND ledger.charge_attribution_hash = p_evidence_sha256
       ) THEN
      RAISE EXCEPTION 'reconciliation key was reused with a different intent'
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
    RAISE EXCEPTION 'Workspace is unavailable for billing reconciliation'
      USING ERRCODE = '23503';
  END IF;

  SELECT reconciliation.*
    INTO v_existing
    FROM public.run_billing_reconciliations AS reconciliation
   WHERE reconciliation.workspace_id = p_workspace_id
     AND reconciliation.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.billing_intent_hash <> p_billing_intent_hash
       OR v_existing.id <> p_reconciliation_id
       OR v_existing.run_id <> p_run_id
       OR v_existing.reservation_id <> p_reservation_id
       OR v_existing.ledger_entry_id <> p_ledger_entry_id
       OR v_existing.evidence_ref <> p_evidence_ref
       OR v_existing.evidence_sha256 <> p_evidence_sha256
       OR v_existing.settled_credits <> p_settle_credits
       OR v_existing.released_credits <> p_release_credits
       OR NOT EXISTS (
         SELECT 1
           FROM public.credits_ledger AS ledger
          WHERE ledger.workspace_id = p_workspace_id
            AND ledger.id = v_existing.ledger_entry_id
            AND ledger.charge_key = p_charge_key
            AND ledger.charge_attribution_hash = p_evidence_sha256
       ) THEN
      RAISE EXCEPTION 'reconciliation key was reused with a different intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  PERFORM 1
    FROM public.runs AS run_row
   WHERE run_row.workspace_id = p_workspace_id
     AND run_row.id = p_run_id
     AND run_row.status = 'NEEDS_ATTENTION'
     AND run_row.billing_state = 'NEEDS_ATTENTION'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only NEEDS_ATTENTION billing can be reconciled'
      USING ERRCODE = '23514';
  END IF;

  SELECT reservation.*
    INTO v_reservation
    FROM public.credit_reservations AS reservation
   WHERE reservation.workspace_id = p_workspace_id
     AND reservation.id = p_reservation_id
     AND reservation.run_id = p_run_id
   FOR UPDATE;
  v_total := p_settle_credits + p_release_credits;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation does not exactly close the reservation'
      USING ERRCODE = '23514';
  END IF;
  IF p_resolved_at < v_reservation.updated_at THEN
    RAISE EXCEPTION 'billing reconciliation timestamp predates the reservation update'
      USING ERRCODE = '23514';
  END IF;
  IF v_reservation.status IN ('SETTLED', 'RELEASED', 'EXPIRED')
     AND p_settle_credits = 0
     AND p_release_credits = 0 THEN
    v_evidence_only := true;
  ELSIF v_reservation.status <> 'HELD'
        OR v_total <> v_reservation.reserved_credits
          - v_reservation.settled_credits
          - v_reservation.released_credits
        OR v_reserved < v_total THEN
      RAISE EXCEPTION 'reconciliation does not exactly close the reservation'
        USING ERRCODE = '23514';
  END IF;

  v_next_version := v_version + CASE WHEN v_total = 0 THEN 0 ELSE 1 END;
  IF NOT v_evidence_only THEN
    UPDATE public.workspaces
       SET credits_balance = v_balance + p_release_credits,
           credits_reserved_balance = v_reserved - v_total,
           credits_balance_version = v_next_version
     WHERE id = p_workspace_id;
    UPDATE public.credit_reservations
       SET settled_credits = settled_credits + p_settle_credits,
           released_credits = released_credits + p_release_credits,
           status = CASE
             WHEN settled_credits + p_settle_credits > 0
               OR v_reservation.reserved_credits = 0
               THEN 'SETTLED'
             ELSE 'RELEASED'
           END,
           settled_at = CASE
             WHEN settled_credits + p_settle_credits > 0
               OR v_reservation.reserved_credits = 0
               THEN p_resolved_at
             ELSE NULL
           END,
           released_at = CASE
             WHEN released_credits + p_release_credits > 0
               THEN p_resolved_at
             ELSE NULL
           END,
           status_reason_code = 'RECONCILED',
           balance_version = v_next_version,
           updated_at = p_resolved_at
     WHERE workspace_id = p_workspace_id
       AND id = p_reservation_id;
  END IF;
  UPDATE public.runs
     SET billing_state = 'SETTLED',
         billing_settled_at = p_resolved_at
   WHERE workspace_id = p_workspace_id
     AND id = p_run_id;

  INSERT INTO public.credits_ledger (
    workspace_id, id, run_id, billing_owner_run_id, producer_run_id,
    reservation_id, entry_kind,
    available_delta_credits, reserved_delta_credits, settled_delta_credits,
    billing_intent_hash, charge_attribution_hash, charge_key,
    balance_before, reserved_before, balance_after, reserved_after,
    balance_version, metering_detail_redacted, created_at
  ) VALUES (
    p_workspace_id, p_ledger_entry_id, p_run_id, p_run_id, p_run_id,
    p_reservation_id,
    'RECONCILIATION', p_release_credits, -v_total, p_settle_credits,
    p_billing_intent_hash, p_evidence_sha256, p_charge_key,
    v_balance, v_reserved, v_balance + p_release_credits, v_reserved - v_total,
    v_next_version,
    jsonb_build_object('evidence_ref', p_evidence_ref, 'evidence_sha256', p_evidence_sha256),
    p_resolved_at
  );
  INSERT INTO public.run_billing_reconciliations (
    workspace_id, id, run_id, billing_owner_run_id, reservation_id, ledger_entry_id,
    idempotency_key, billing_intent_hash, evidence_ref, evidence_sha256,
    settled_credits, released_credits, resolved_at
  ) VALUES (
    p_workspace_id, p_reconciliation_id, p_run_id, p_run_id, p_reservation_id,
    p_ledger_entry_id, p_idempotency_key, p_billing_intent_hash,
    p_evidence_ref, p_evidence_sha256, p_settle_credits,
    p_release_credits, p_resolved_at
  );
  RETURN p_reconciliation_id;
END;
$function$;
ALTER FUNCTION app.reconcile_run_billing(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text,
  bigint, bigint, text, text, timestamptz
) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.reconcile_run_billing(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text,
  bigint, bigint, text, text, timestamptz
) FROM PUBLIC;

-- The Run owner may compose accepted and terminal facts with the billing
-- owner's narrow primitives, but never receives ledger/reservation DML.
GRANT EXECUTE ON FUNCTION app.reserve_credits(
  uuid, uuid, uuid, uuid, bigint, text, text, text, text, timestamptz, timestamptz
), app.settle_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, jsonb, timestamptz
), app.release_credits(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid, bigint,
  text, text, text, text, timestamptz
), app.expire_credit_reservation(
  uuid, uuid, uuid, uuid, text, text, text, timestamptz
) TO ba_run_owner;

CREATE FUNCTION app.create_prepared_conversation(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_conversation_id uuid := (p_fact ->> 'conversation_id')::uuid;
  v_state_id uuid := (p_fact ->> 'state_id')::uuid;
  v_principal_kind text := p_fact ->> 'principal_kind';
  v_credential_id uuid := (p_fact ->> 'credential_id')::uuid;
  v_end_user_id uuid := (p_fact ->> 'end_user_principal_id')::uuid;
  v_deployment_id uuid := (p_fact ->> 'agent_deployment_id')::uuid;
  v_revision_id uuid := (p_fact ->> 'created_deployment_revision_id')::uuid;
  v_agent_id uuid := (p_fact ->> 'agent_id')::uuid;
  v_agent_release_id uuid := (p_fact ->> 'agent_release_id')::uuid;
  v_experience_release_id uuid := (p_fact ->> 'experience_release_id')::uuid;
  v_contract_hash text := p_fact ->> 'conversation_contract_hash';
  v_state_hash text := p_fact ->> 'state_hash';
  v_created_at timestamptz := (p_fact ->> 'created_at')::timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_principal_kind NOT IN ('credential', 'end_user')
     OR v_contract_hash !~ '^sha256:[0-9a-f]{64}$'
     OR v_state_hash !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(COALESCE(p_fact -> 'variables_redacted', '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_fact -> 'session_store_redacted', '{}'::jsonb)) <> 'object'
     OR v_created_at IS NULL THEN
    RAISE EXCEPTION 'invalid prepared Conversation fact'
      USING ERRCODE = '22023';
  END IF;

  PERFORM app.validate_agent_acceptance_target(
    v_workspace_id,
    v_deployment_id,
    v_revision_id,
    v_agent_id,
    v_agent_release_id,
    v_experience_release_id,
    v_contract_hash
  );

  INSERT INTO public.conversations (
    workspace_id, id, principal_kind, credential_id, end_user_principal_id,
    agent_deployment_id, created_deployment_revision_id,
    conversation_contract_hash, current_state_version, status,
    created_at, updated_at
  ) VALUES (
    v_workspace_id, v_conversation_id, v_principal_kind,
    CASE WHEN v_principal_kind = 'credential' THEN v_credential_id END,
    CASE WHEN v_principal_kind = 'end_user' THEN v_end_user_id END,
    v_deployment_id, v_revision_id, v_contract_hash, 0, 'ACTIVE',
    v_created_at, v_created_at
  );
  INSERT INTO public.conversation_states (
    workspace_id, id, conversation_id, state_version,
    variables_redacted, session_store_redacted, state_hash, updated_at
  ) VALUES (
    v_workspace_id, v_state_id, v_conversation_id, 0,
    COALESCE(p_fact -> 'variables_redacted', '{}'::jsonb),
    COALESCE(p_fact -> 'session_store_redacted', '{}'::jsonb),
    v_state_hash, v_created_at
  );
  RETURN jsonb_build_object(
    'conversation_id', v_conversation_id,
    'conversation_contract_hash', v_contract_hash,
    'state_version', 0
  );
END;
$function$;
ALTER FUNCTION app.create_prepared_conversation(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.create_prepared_conversation(jsonb) FROM PUBLIC;

CREATE FUNCTION app.accept_prepared_agent_chat_run(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_principal_kind text := p_fact ->> 'principal_kind';
  v_credential_id uuid := (p_fact ->> 'credential_id')::uuid;
  v_end_user_id uuid := (p_fact ->> 'end_user_principal_id')::uuid;
  v_key text := nullif(p_fact ->> 'idempotency_key', '');
  v_sentinel_id uuid := (p_fact ->> 'sentinel_id')::uuid;
  v_receipt_id uuid := (p_fact ->> 'receipt_id')::uuid;
  v_intent_hash text := p_fact ->> 'intent_hash';
  v_conversation_id uuid := (p_fact ->> 'conversation_id')::uuid;
  v_expected_version bigint := (p_fact ->> 'expected_state_version')::bigint;
  v_next_version bigint := (p_fact ->> 'next_state_version')::bigint;
  v_message_id uuid := (p_fact ->> 'user_message_id')::uuid;
  v_deployment_id uuid := (p_fact ->> 'agent_deployment_id')::uuid;
  v_revision_id uuid := (p_fact ->> 'agent_deployment_revision_id')::uuid;
  v_agent_id uuid := (p_fact ->> 'agent_id')::uuid;
  v_agent_release_id uuid := (p_fact ->> 'agent_release_id')::uuid;
  v_experience_release_id uuid := (p_fact ->> 'experience_release_id')::uuid;
  v_contract_hash text := p_fact ->> 'conversation_contract_hash';
  v_created_at timestamptz := (p_fact ->> 'accepted_at')::timestamptz;
  v_inserted_sentinel uuid;
  v_saved_intent_hash text;
  v_saved_receipt jsonb;
  v_conversation public.conversations%ROWTYPE;
  v_state public.conversation_states%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_principal_kind NOT IN ('credential', 'end_user')
     OR v_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'admission_snapshot_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'accepted_plan_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR p_fact ->> 'admission_snapshot_hash' = p_fact ->> 'accepted_plan_hash'
     OR (p_fact ->> 'accepted_output_schema_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'dependency_pins_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'user_message_content_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'next_state_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR v_receipt_id IS NULL
     OR v_expected_version < 0
     OR v_next_version <> v_expected_version + 1
     OR v_created_at IS NULL
     OR jsonb_typeof(p_fact -> 'acceptance_receipt_data_redacted') <> 'object'
     OR jsonb_typeof(p_fact -> 'user_message_content_redacted') <> 'object' THEN
    RAISE EXCEPTION 'invalid prepared Agent Chat acceptance fact'
      USING ERRCODE = '22023';
  END IF;

  IF v_key IS NOT NULL THEN
    IF v_sentinel_id IS NULL THEN
      RAISE EXCEPTION 'keyed Agent acceptance requires sentinel and receipt ids'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.run_idempotency_sentinels (
      workspace_id, id, principal_kind, credential_id, end_user_principal_id,
      fixed_route, idempotency_key, intent_hash, created_at
    ) VALUES (
      v_workspace_id, v_sentinel_id, v_principal_kind,
      CASE WHEN v_principal_kind = 'credential' THEN v_credential_id END,
      CASE WHEN v_principal_kind = 'end_user' THEN v_end_user_id END,
      '/v1/oapi/agent/chat', v_key, v_intent_hash, v_created_at
    ) ON CONFLICT DO NOTHING RETURNING id INTO v_inserted_sentinel;

    SELECT sentinel.intent_hash
      INTO v_saved_intent_hash
      FROM public.run_idempotency_sentinels AS sentinel
     WHERE sentinel.workspace_id = v_workspace_id
       AND sentinel.principal_kind = v_principal_kind
       AND sentinel.credential_id IS NOT DISTINCT FROM
         CASE WHEN v_principal_kind = 'credential' THEN v_credential_id END
       AND sentinel.end_user_principal_id IS NOT DISTINCT FROM
         CASE WHEN v_principal_kind = 'end_user' THEN v_end_user_id END
       AND sentinel.fixed_route = '/v1/oapi/agent/chat'
       AND sentinel.idempotency_key = v_key
     FOR UPDATE;
    IF v_saved_intent_hash IS DISTINCT FROM v_intent_hash THEN
      RAISE EXCEPTION 'Idempotency-Key was reused with a different Agent intent'
        USING ERRCODE = '23505';
    END IF;
    IF v_inserted_sentinel IS NULL THEN
      SELECT receipt.data_redacted
        INTO v_saved_receipt
        FROM public.run_acceptance_receipts AS receipt
       WHERE receipt.workspace_id = v_workspace_id
         AND receipt.sentinel_id = (
           SELECT sentinel.id
             FROM public.run_idempotency_sentinels AS sentinel
            WHERE sentinel.workspace_id = v_workspace_id
              AND sentinel.principal_kind = v_principal_kind
              AND sentinel.credential_id IS NOT DISTINCT FROM
                CASE WHEN v_principal_kind = 'credential' THEN v_credential_id END
              AND sentinel.end_user_principal_id IS NOT DISTINCT FROM
                CASE WHEN v_principal_kind = 'end_user' THEN v_end_user_id END
              AND sentinel.fixed_route = '/v1/oapi/agent/chat'
              AND sentinel.idempotency_key = v_key
         );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'committed idempotency sentinel is missing its acceptance receipt'
          USING ERRCODE = '55000';
      END IF;
      RETURN v_saved_receipt;
    END IF;
  END IF;

  -- A miss is serialized after the sentinel and before any mutable target or
  -- Conversation locks. Hits above return without touching the Workspace.
  PERFORM app.lock_billing_workspace(v_workspace_id);

  PERFORM app.validate_agent_acceptance_target(
    v_workspace_id, v_deployment_id, v_revision_id, v_agent_id,
    v_agent_release_id, v_experience_release_id, v_contract_hash
  );

  SELECT conversation.*
    INTO v_conversation
    FROM public.conversations AS conversation
   WHERE conversation.workspace_id = v_workspace_id
     AND conversation.id = v_conversation_id
   FOR UPDATE;
  SELECT state_row.*
    INTO v_state
    FROM public.conversation_states AS state_row
   WHERE state_row.workspace_id = v_workspace_id
     AND state_row.conversation_id = v_conversation_id
   FOR UPDATE;
  IF v_conversation.id IS NULL
     OR v_state.id IS NULL
     OR v_conversation.status <> 'ACTIVE'
     OR v_conversation.principal_kind <> v_principal_kind
     OR v_conversation.credential_id IS DISTINCT FROM
       (CASE WHEN v_principal_kind = 'credential' THEN v_credential_id END)
     OR v_conversation.end_user_principal_id IS DISTINCT FROM
       (CASE WHEN v_principal_kind = 'end_user' THEN v_end_user_id END)
     OR v_conversation.agent_deployment_id <> v_deployment_id
     OR v_conversation.conversation_contract_hash <> v_contract_hash
     OR v_conversation.current_state_version <> v_expected_version
     OR v_state.state_version <> v_expected_version THEN
    RAISE EXCEPTION 'Conversation principal, target, contract or CAS version does not match'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.conversation_messages (
    workspace_id, id, conversation_id, state_version, message_ordinal,
    message_role, content_redacted, content_hash, created_at
  ) VALUES (
    v_workspace_id, v_message_id, v_conversation_id, v_next_version,
    v_next_version, 'USER', p_fact -> 'user_message_content_redacted',
    p_fact ->> 'user_message_content_hash', v_created_at
  );
  UPDATE public.conversations
     SET current_state_version = v_next_version,
         updated_at = v_created_at
   WHERE workspace_id = v_workspace_id
     AND id = v_conversation_id;
  UPDATE public.conversation_states
     SET state_version = v_next_version,
         variables_redacted = COALESCE(
           p_fact -> 'next_variables_redacted', variables_redacted
         ),
         session_store_redacted = COALESCE(
           p_fact -> 'next_session_store_redacted', session_store_redacted
         ),
         state_hash = p_fact ->> 'next_state_hash',
         updated_at = v_created_at
   WHERE workspace_id = v_workspace_id
     AND id = v_state.id;

  INSERT INTO public.runs (
    workspace_id, id, billing_owner_run_id, accepted_request_id,
    accepted_principal_kind, accepted_credential_id,
    accepted_end_user_principal_id, fixed_route, idempotency_sentinel_id,
    idempotency_key, intent_hash, admission_snapshot_hash, accepted_plan_hash,
    accepted_output_schema_ref, accepted_output_schema_hash,
    dependency_pins_hash, target_kind, agent_deployment_id,
    agent_deployment_revision_id, agent_id, agent_release_id,
    experience_release_id, conversation_id, conversation_contract_hash,
    accepted_conversation_state_version, user_message_id,
    status, execution_status, billing_state,
    acceptance_receipt_data_redacted, last_event_sequence, accepted_at
  ) VALUES (
    v_workspace_id, v_run_id, v_run_id,
    (p_fact ->> 'accepted_request_id')::uuid,
    v_principal_kind,
    CASE WHEN v_principal_kind = 'credential' THEN v_credential_id END,
    CASE WHEN v_principal_kind = 'end_user' THEN v_end_user_id END,
    '/v1/oapi/agent/chat', v_inserted_sentinel, v_key, v_intent_hash,
    p_fact ->> 'admission_snapshot_hash', p_fact ->> 'accepted_plan_hash',
    p_fact ->> 'accepted_output_schema_ref',
    p_fact ->> 'accepted_output_schema_hash', p_fact ->> 'dependency_pins_hash',
    'agent', v_deployment_id, v_revision_id, v_agent_id,
    v_agent_release_id, v_experience_release_id, v_conversation_id,
    v_contract_hash, v_next_version, v_message_id,
    'QUEUED', 'ACCEPTED', 'PENDING',
    p_fact -> 'acceptance_receipt_data_redacted', 1, v_created_at
  );
  INSERT INTO public.run_events (
    workspace_id, id, run_id, sequence, event_type, dedupe_key,
    payload_redacted, occurred_at
  ) VALUES (
    v_workspace_id, (p_fact ->> 'accepted_event_id')::uuid, v_run_id, 1,
    'RUN_ACCEPTED', 'accepted',
    jsonb_build_object('status', 'QUEUED'), v_created_at
  );
  INSERT INTO public.outbox (
    workspace_id, id, run_id, message_type, dedupe_key,
    payload_ref, payload_hash, producer_fencing_token,
    payload_redacted, status, available_at, created_at
  ) VALUES (
    v_workspace_id, (p_fact ->> 'dispatch_outbox_id')::uuid, v_run_id,
    'RUN_DISPATCH', 'initial-dispatch',
    'run:' || v_run_id::text || ':dispatch',
    p_fact ->> 'accepted_plan_hash', 1,
    jsonb_build_object('run_id', v_run_id), 'PENDING', v_created_at, v_created_at
  );
  PERFORM app.reserve_credits(
    v_workspace_id, v_run_id, (p_fact ->> 'reservation_id')::uuid,
    (p_fact ->> 'reserve_ledger_entry_id')::uuid,
    (p_fact ->> 'reserved_credits')::bigint,
    p_fact ->> 'accepted_plan_hash', p_fact ->> 'reserve_charge_key',
    p_fact ->> 'reserve_billing_intent_hash',
    p_fact ->> 'reserve_charge_attribution_hash',
    (p_fact ->> 'reservation_expires_at')::timestamptz, v_created_at
  );

  INSERT INTO public.run_acceptance_receipts (
    workspace_id, id, sentinel_id, run_id, principal_kind, credential_id,
    end_user_principal_id, fixed_route, idempotency_key, intent_hash,
    http_status, data_redacted, accepted_request_id, created_at
  ) VALUES (
    v_workspace_id, v_receipt_id, v_inserted_sentinel, v_run_id,
    v_principal_kind,
    CASE WHEN v_principal_kind = 'credential' THEN v_credential_id END,
    CASE WHEN v_principal_kind = 'end_user' THEN v_end_user_id END,
    '/v1/oapi/agent/chat', v_key, v_intent_hash, 202,
    p_fact -> 'acceptance_receipt_data_redacted',
    (p_fact ->> 'accepted_request_id')::uuid, v_created_at
  );
  RETURN p_fact -> 'acceptance_receipt_data_redacted';
END;
$function$;
ALTER FUNCTION app.accept_prepared_agent_chat_run(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.accept_prepared_agent_chat_run(jsonb) FROM PUBLIC;

CREATE FUNCTION app.accept_prepared_flow_run(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_credential_id uuid := (p_fact ->> 'credential_id')::uuid;
  v_key text := nullif(p_fact ->> 'idempotency_key', '');
  v_sentinel_id uuid := (p_fact ->> 'sentinel_id')::uuid;
  v_receipt_id uuid := (p_fact ->> 'receipt_id')::uuid;
  v_intent_hash text := p_fact ->> 'intent_hash';
  v_created_at timestamptz := (p_fact ->> 'accepted_at')::timestamptz;
  v_inserted_sentinel uuid;
  v_saved_intent_hash text;
  v_saved_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR v_credential_id IS NULL
     OR v_intent_hash !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'admission_snapshot_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'accepted_plan_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR p_fact ->> 'admission_snapshot_hash' = p_fact ->> 'accepted_plan_hash'
     OR (p_fact ->> 'accepted_output_schema_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'dependency_pins_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR v_receipt_id IS NULL
     OR v_created_at IS NULL
     OR jsonb_typeof(p_fact -> 'acceptance_receipt_data_redacted') <> 'object' THEN
    RAISE EXCEPTION 'invalid prepared Flow acceptance fact'
      USING ERRCODE = '22023';
  END IF;

  IF v_key IS NOT NULL THEN
    IF v_sentinel_id IS NULL THEN
      RAISE EXCEPTION 'keyed Flow acceptance requires sentinel and receipt ids'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.run_idempotency_sentinels (
      workspace_id, id, principal_kind, credential_id, fixed_route,
      idempotency_key, intent_hash, created_at
    ) VALUES (
      v_workspace_id, v_sentinel_id, 'credential', v_credential_id,
      '/v1/oapi/flow/run', v_key, v_intent_hash, v_created_at
    ) ON CONFLICT DO NOTHING RETURNING id INTO v_inserted_sentinel;
    SELECT sentinel.intent_hash
      INTO v_saved_intent_hash
      FROM public.run_idempotency_sentinels AS sentinel
     WHERE sentinel.workspace_id = v_workspace_id
       AND sentinel.principal_kind = 'credential'
       AND sentinel.credential_id = v_credential_id
       AND sentinel.end_user_principal_id IS NULL
       AND sentinel.fixed_route = '/v1/oapi/flow/run'
       AND sentinel.idempotency_key = v_key
     FOR UPDATE;
    IF v_saved_intent_hash IS DISTINCT FROM v_intent_hash THEN
      RAISE EXCEPTION 'Idempotency-Key was reused with a different Flow intent'
        USING ERRCODE = '23505';
    END IF;
    IF v_inserted_sentinel IS NULL THEN
      SELECT receipt.data_redacted
        INTO v_saved_receipt
        FROM public.run_acceptance_receipts AS receipt
       JOIN public.run_idempotency_sentinels AS sentinel
         ON sentinel.workspace_id = receipt.workspace_id
        AND sentinel.id = receipt.sentinel_id
       WHERE sentinel.workspace_id = v_workspace_id
         AND sentinel.principal_kind = 'credential'
         AND sentinel.credential_id = v_credential_id
         AND sentinel.end_user_principal_id IS NULL
         AND sentinel.fixed_route = '/v1/oapi/flow/run'
         AND sentinel.idempotency_key = v_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'committed Flow sentinel is missing its acceptance receipt'
          USING ERRCODE = '55000';
      END IF;
      RETURN v_saved_receipt;
    END IF;
  END IF;

  PERFORM app.lock_billing_workspace(v_workspace_id);

  PERFORM app.validate_flow_acceptance_target(
    v_workspace_id,
    (p_fact ->> 'flow_deployment_id')::uuid,
    (p_fact ->> 'flow_deployment_revision_id')::uuid,
    (p_fact ->> 'flow_id')::uuid,
    (p_fact ->> 'flow_version_id')::uuid
  );
  INSERT INTO public.runs (
    workspace_id, id, billing_owner_run_id, accepted_request_id,
    accepted_principal_kind, accepted_credential_id, fixed_route,
    idempotency_sentinel_id, idempotency_key, intent_hash,
    admission_snapshot_hash, accepted_plan_hash,
    accepted_output_schema_ref, accepted_output_schema_hash,
    dependency_pins_hash, target_kind, flow_deployment_id,
    flow_deployment_revision_id, flow_id, flow_version_id,
    status, execution_status, billing_state,
    acceptance_receipt_data_redacted, last_event_sequence, accepted_at
  ) VALUES (
    v_workspace_id, v_run_id, v_run_id,
    (p_fact ->> 'accepted_request_id')::uuid,
    'credential', v_credential_id, '/v1/oapi/flow/run',
    v_inserted_sentinel, v_key, v_intent_hash,
    p_fact ->> 'admission_snapshot_hash', p_fact ->> 'accepted_plan_hash',
    p_fact ->> 'accepted_output_schema_ref',
    p_fact ->> 'accepted_output_schema_hash', p_fact ->> 'dependency_pins_hash',
    'flow', (p_fact ->> 'flow_deployment_id')::uuid,
    (p_fact ->> 'flow_deployment_revision_id')::uuid,
    (p_fact ->> 'flow_id')::uuid, (p_fact ->> 'flow_version_id')::uuid,
    'QUEUED', 'ACCEPTED', 'PENDING',
    p_fact -> 'acceptance_receipt_data_redacted', 1, v_created_at
  );
  INSERT INTO public.run_events (
    workspace_id, id, run_id, sequence, event_type, dedupe_key,
    payload_redacted, occurred_at
  ) VALUES (
    v_workspace_id, (p_fact ->> 'accepted_event_id')::uuid, v_run_id, 1,
    'RUN_ACCEPTED', 'accepted', jsonb_build_object('status', 'QUEUED'), v_created_at
  );
  INSERT INTO public.outbox (
    workspace_id, id, run_id, message_type, dedupe_key,
    payload_ref, payload_hash, producer_fencing_token,
    payload_redacted, status, available_at, created_at
  ) VALUES (
    v_workspace_id, (p_fact ->> 'dispatch_outbox_id')::uuid, v_run_id,
    'RUN_DISPATCH', 'initial-dispatch',
    'run:' || v_run_id::text || ':dispatch',
    p_fact ->> 'accepted_plan_hash', 1,
    jsonb_build_object('run_id', v_run_id),
    'PENDING', v_created_at, v_created_at
  );
  PERFORM app.reserve_credits(
    v_workspace_id, v_run_id, (p_fact ->> 'reservation_id')::uuid,
    (p_fact ->> 'reserve_ledger_entry_id')::uuid,
    (p_fact ->> 'reserved_credits')::bigint,
    p_fact ->> 'accepted_plan_hash', p_fact ->> 'reserve_charge_key',
    p_fact ->> 'reserve_billing_intent_hash',
    p_fact ->> 'reserve_charge_attribution_hash',
    (p_fact ->> 'reservation_expires_at')::timestamptz, v_created_at
  );
  INSERT INTO public.run_acceptance_receipts (
    workspace_id, id, sentinel_id, run_id, principal_kind, credential_id,
    fixed_route, idempotency_key, intent_hash, http_status,
    data_redacted, accepted_request_id, created_at
  ) VALUES (
    v_workspace_id, v_receipt_id, v_inserted_sentinel, v_run_id,
    'credential', v_credential_id, '/v1/oapi/flow/run', v_key,
    v_intent_hash, 202, p_fact -> 'acceptance_receipt_data_redacted',
    (p_fact ->> 'accepted_request_id')::uuid, v_created_at
  );
  RETURN p_fact -> 'acceptance_receipt_data_redacted';
END;
$function$;
ALTER FUNCTION app.accept_prepared_flow_run(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.accept_prepared_flow_run(jsonb) FROM PUBLIC;

-- Owner-only terminal composition. G0-06 intentionally refuses the success
-- path until G0-07 can prove executor/attestation/lease fencing. Supported
-- failure terminals close billing and terminal facts in one outer transaction.
CREATE FUNCTION app.finalize_run(p_fact jsonb)
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

CREATE FUNCTION app.create_child_run(p_fact jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'child Run creation is unavailable before G0-07'
    USING ERRCODE = '0A000';
END;
$function$;
ALTER FUNCTION app.create_child_run(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.create_child_run(jsonb) FROM PUBLIC;

CREATE FUNCTION app.allocate_child_run_budget(p_fact jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'child Run budget allocation is unavailable before G0-07'
    USING ERRCODE = '0A000';
END;
$function$;
ALTER FUNCTION app.allocate_child_run_budget(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.allocate_child_run_budget(jsonb) FROM PUBLIC;

CREATE FUNCTION app.mutate_human_gate(p_operation text, p_fact jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF p_operation NOT IN ('submit', 'claim', 'approve', 'reject', 'expire', 'resume') THEN
    RAISE EXCEPTION 'unsupported Human Gate operation'
      USING ERRCODE = '22023';
  END IF;
  RAISE EXCEPTION 'Human Gate operations are unavailable before G0-07'
    USING ERRCODE = '0A000';
END;
$function$;
ALTER FUNCTION app.mutate_human_gate(text, jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.mutate_human_gate(text, jsonb) FROM PUBLIC;

-- Evidence registration is split from purge ownership. Each layer repeats and
-- foreign-keys the exact Run/archive/receipt hashes so the purge owner cannot
-- substitute a same-tenant evidence row.
CREATE FUNCTION app.register_run_archive_manifest(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_manifest_id uuid := (p_fact ->> 'manifest_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_run jsonb;
  v_existing public.run_archive_manifests%ROWTYPE;
  v_terminal_intent_hash text;
  v_terminal_event_id uuid;
  v_terminal_event_sequence bigint;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR (p_fact ->> 'archive_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR length(btrim(p_fact ->> 'archive_ref')) NOT BETWEEN 1 AND 2048
     OR position('?' IN (p_fact ->> 'archive_ref')) > 0
     OR position('#' IN (p_fact ->> 'archive_ref')) > 0
     OR (p_fact ->> 'created_at')::timestamptz IS NULL THEN
    RAISE EXCEPTION 'invalid Run archive manifest'
      USING ERRCODE = '22023';
  END IF;

  -- The Run owner mediates the authoritative parent-row lock. Archive writers
  -- receive no raw Run UPDATE capability, but identical first writes must
  -- serialize before the child fact is re-read.
  v_run := app.lock_run_retention_summary(v_workspace_id, v_run_id);

  SELECT manifest.*
    INTO v_existing
    FROM public.run_archive_manifests AS manifest
   WHERE manifest.workspace_id = v_workspace_id
     AND manifest.run_id = v_run_id;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM v_manifest_id
       OR v_existing.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
       OR v_existing.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256'
       OR v_existing.created_at
            IS DISTINCT FROM (p_fact ->> 'created_at')::timestamptz THEN
      RAISE EXCEPTION 'Run archive manifest already exists with different evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  v_terminal_intent_hash := v_run ->> 'terminal_intent_hash';
  v_terminal_event_id := (v_run ->> 'terminal_event_id')::uuid;
  v_terminal_event_sequence := (v_run ->> 'terminal_event_sequence')::bigint;
  IF v_terminal_intent_hash IS NULL
     OR v_terminal_event_id IS NULL
     OR v_terminal_event_sequence IS NULL THEN
    RAISE EXCEPTION 'only a terminal Run can register archive evidence'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.run_archive_manifests (
    workspace_id, id, run_id, terminal_intent_hash, terminal_event_id,
    terminal_event_sequence, archive_ref, archive_sha256, created_at
  ) VALUES (
    v_workspace_id, v_manifest_id, v_run_id, v_terminal_intent_hash,
    v_terminal_event_id, v_terminal_event_sequence,
    p_fact ->> 'archive_ref', p_fact ->> 'archive_sha256',
    (p_fact ->> 'created_at')::timestamptz
  );
  RETURN v_manifest_id;
END;
$function$;
ALTER FUNCTION app.register_run_archive_manifest(jsonb) OWNER TO ba_archive_evidence_owner;
REVOKE ALL ON FUNCTION app.register_run_archive_manifest(jsonb) FROM PUBLIC;

CREATE FUNCTION app.verify_run_archive(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_receipt_id uuid := (p_fact ->> 'verification_receipt_id')::uuid;
  v_manifest public.run_archive_manifests%ROWTYPE;
  v_existing public.run_archive_verification_receipts%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR (p_fact ->> 'archive_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'receipt_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR length(btrim(p_fact ->> 'receipt_ref')) NOT BETWEEN 1 AND 2048
     OR position('?' IN (p_fact ->> 'receipt_ref')) > 0
     OR position('#' IN (p_fact ->> 'receipt_ref')) > 0
     OR (p_fact ->> 'verified_at')::timestamptz IS NULL THEN
    RAISE EXCEPTION 'invalid Run archive verification receipt'
      USING ERRCODE = '22023';
  END IF;

  SELECT manifest.*
    INTO v_manifest
    FROM public.run_archive_manifests AS manifest
   WHERE manifest.workspace_id = v_workspace_id
     AND manifest.id = (p_fact ->> 'manifest_id')::uuid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'archive verification does not match the exact manifest'
      USING ERRCODE = '23503';
  END IF;

  SELECT receipt.*
    INTO v_existing
    FROM public.run_archive_verification_receipts AS receipt
   WHERE receipt.workspace_id = v_workspace_id
     AND receipt.manifest_id = v_manifest.id;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM v_receipt_id
       OR v_existing.run_id IS DISTINCT FROM (p_fact ->> 'run_id')::uuid
       OR v_existing.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
       OR v_existing.receipt_sha256 IS DISTINCT FROM p_fact ->> 'receipt_sha256'
       OR v_existing.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256'
       OR v_existing.receipt_ref IS DISTINCT FROM p_fact ->> 'receipt_ref'
       OR v_existing.status IS DISTINCT FROM 'VERIFIED'
       OR v_existing.verified_at
            IS DISTINCT FROM (p_fact ->> 'verified_at')::timestamptz THEN
      RAISE EXCEPTION 'archive verification already exists with different evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  IF v_manifest.run_id IS DISTINCT FROM (p_fact ->> 'run_id')::uuid
     OR v_manifest.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
     OR v_manifest.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256' THEN
    RAISE EXCEPTION 'archive verification does not match the exact manifest'
      USING ERRCODE = '23503';
  END IF;

  IF (p_fact ->> 'verified_at')::timestamptz < v_manifest.created_at THEN
    RAISE EXCEPTION 'archive verification cannot predate its manifest'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.run_archive_verification_receipts (
    workspace_id, id, manifest_id, run_id, archive_ref, archive_sha256,
    receipt_ref, receipt_sha256, status, verified_at
  ) VALUES (
    v_workspace_id, v_receipt_id, v_manifest.id, v_manifest.run_id,
    v_manifest.archive_ref, v_manifest.archive_sha256,
    p_fact ->> 'receipt_ref', p_fact ->> 'receipt_sha256', 'VERIFIED',
    (p_fact ->> 'verified_at')::timestamptz
  );
  RETURN v_receipt_id;
END;
$function$;
ALTER FUNCTION app.verify_run_archive(jsonb) OWNER TO ba_archive_evidence_owner;
REVOKE ALL ON FUNCTION app.verify_run_archive(jsonb) FROM PUBLIC;

CREATE FUNCTION app.approve_run_archive(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_receipt_id uuid := (p_fact ->> 'approval_receipt_id')::uuid;
  v_manifest public.run_archive_manifests%ROWTYPE;
  v_verification public.run_archive_verification_receipts%ROWTYPE;
  v_existing public.run_archive_approval_receipts%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR (p_fact ->> 'archive_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'verification_receipt_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'receipt_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR length(btrim(p_fact ->> 'receipt_ref')) NOT BETWEEN 1 AND 2048
     OR position('?' IN (p_fact ->> 'receipt_ref')) > 0
     OR position('#' IN (p_fact ->> 'receipt_ref')) > 0
     OR (p_fact ->> 'approved_at')::timestamptz IS NULL THEN
    RAISE EXCEPTION 'invalid Run archive approval receipt'
      USING ERRCODE = '22023';
  END IF;

  SELECT manifest.*
    INTO v_manifest
    FROM public.run_archive_manifests AS manifest
   WHERE manifest.workspace_id = v_workspace_id
     AND manifest.id = (p_fact ->> 'manifest_id')::uuid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'archive approval does not match the exact manifest'
      USING ERRCODE = '23503';
  END IF;

  SELECT receipt.*
    INTO v_existing
    FROM public.run_archive_approval_receipts AS receipt
   WHERE receipt.workspace_id = v_workspace_id
     AND receipt.manifest_id = v_manifest.id;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM v_receipt_id
       OR v_existing.verification_receipt_id
            IS DISTINCT FROM (p_fact ->> 'verification_receipt_id')::uuid
       OR v_existing.receipt_sha256 IS DISTINCT FROM p_fact ->> 'receipt_sha256'
       OR v_existing.verification_receipt_sha256
            IS DISTINCT FROM p_fact ->> 'verification_receipt_sha256'
       OR v_existing.run_id IS DISTINCT FROM (p_fact ->> 'run_id')::uuid
       OR v_existing.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
       OR v_existing.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256'
       OR v_existing.receipt_ref IS DISTINCT FROM p_fact ->> 'receipt_ref'
       OR v_existing.status IS DISTINCT FROM 'APPROVED'
       OR v_existing.approved_at
            IS DISTINCT FROM (p_fact ->> 'approved_at')::timestamptz THEN
      RAISE EXCEPTION 'archive approval already exists with different evidence'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  IF v_manifest.run_id IS DISTINCT FROM (p_fact ->> 'run_id')::uuid
     OR v_manifest.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
     OR v_manifest.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256' THEN
    RAISE EXCEPTION 'archive approval does not match the exact manifest'
      USING ERRCODE = '23503';
  END IF;

  SELECT receipt.*
    INTO v_verification
    FROM public.run_archive_verification_receipts AS receipt
   WHERE receipt.workspace_id = v_workspace_id
     AND receipt.id = (p_fact ->> 'verification_receipt_id')::uuid
   FOR UPDATE;
  IF NOT FOUND
     OR v_verification.manifest_id IS DISTINCT FROM v_manifest.id
     OR v_verification.run_id IS DISTINCT FROM v_manifest.run_id
     OR v_verification.archive_ref IS DISTINCT FROM v_manifest.archive_ref
     OR v_verification.archive_sha256 IS DISTINCT FROM v_manifest.archive_sha256
     OR v_verification.receipt_sha256
          IS DISTINCT FROM p_fact ->> 'verification_receipt_sha256'
     OR v_verification.status IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'archive approval does not match exact verified evidence'
      USING ERRCODE = '23503';
  END IF;

  IF (p_fact ->> 'approved_at')::timestamptz < v_verification.verified_at THEN
    RAISE EXCEPTION 'archive approval cannot predate its verification'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.run_archive_approval_receipts (
    workspace_id, id, manifest_id, verification_receipt_id,
    verification_receipt_sha256, run_id, archive_ref, archive_sha256,
    receipt_ref, receipt_sha256, status, approved_at
  ) VALUES (
    v_workspace_id, v_receipt_id, v_manifest.id, v_verification.id,
    v_verification.receipt_sha256, v_manifest.run_id, v_manifest.archive_ref,
    v_manifest.archive_sha256, p_fact ->> 'receipt_ref',
    p_fact ->> 'receipt_sha256', 'APPROVED',
    (p_fact ->> 'approved_at')::timestamptz
  );
  RETURN v_receipt_id;
END;
$function$;
ALTER FUNCTION app.approve_run_archive(jsonb) OWNER TO ba_archive_evidence_owner;
REVOKE ALL ON FUNCTION app.approve_run_archive(jsonb) FROM PUBLIC;

CREATE FUNCTION app.lock_run_retention_summary(
  p_workspace_id uuid,
  p_run_id uuid
)
RETURNS jsonb
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
    RAISE EXCEPTION 'invalid Run retention lock request'
      USING ERRCODE = '42501';
  END IF;
  SELECT run_row.*
    INTO v_run
    FROM public.runs AS run_row
   WHERE run_row.workspace_id = p_workspace_id
     AND run_row.id = p_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run is unavailable for retention'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'status', v_run.status,
    'billing_state', v_run.billing_state,
    'terminal_intent_hash', v_run.terminal_intent_hash,
    'terminal_event_id', v_run.terminal_event_id,
    'terminal_event_sequence', v_run.terminal_event_sequence,
    'finished_at', v_run.finished_at,
    'events_retention_until', v_run.events_retention_until,
    'recovery_retention_until', v_run.recovery_retention_until,
    'retention_until', v_run.retention_until
  );
END;
$function$;
ALTER FUNCTION app.lock_run_retention_summary(uuid, uuid) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.lock_run_retention_summary(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_run_retention_summary(uuid, uuid) TO
  ba_archive_evidence_owner,
  ba_retention;

CREATE FUNCTION app.purge_run_events(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_receipt_id uuid := (p_fact ->> 'purge_receipt_id')::uuid;
  v_now timestamptz;
  v_run jsonb;
  v_existing public.run_retention_purge_receipts%ROWTYPE;
  v_deleted bigint;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR (p_fact ->> 'archive_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'verification_receipt_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'approval_receipt_sha256') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid EVENTS purge intent'
      USING ERRCODE = '22023';
  END IF;

  SELECT receipt.*
    INTO v_existing
    FROM public.run_retention_purge_receipts AS receipt
   WHERE receipt.workspace_id = v_workspace_id
     AND receipt.run_id = v_run_id
     AND receipt.material_kind = 'EVENTS';
  IF v_existing.id IS NULL THEN
    v_run := app.lock_run_retention_summary(v_workspace_id, v_run_id);
    SELECT receipt.*
      INTO v_existing
      FROM public.run_retention_purge_receipts AS receipt
     WHERE receipt.workspace_id = v_workspace_id
       AND receipt.run_id = v_run_id
       AND receipt.material_kind = 'EVENTS';
  END IF;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.id IS DISTINCT FROM v_receipt_id
       OR v_existing.manifest_id IS DISTINCT FROM (p_fact ->> 'manifest_id')::uuid
       OR v_existing.verification_receipt_id
            IS DISTINCT FROM (p_fact ->> 'verification_receipt_id')::uuid
       OR v_existing.approval_receipt_id
            IS DISTINCT FROM (p_fact ->> 'approval_receipt_id')::uuid
       OR v_existing.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
       OR v_existing.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256'
       OR v_existing.verification_receipt_sha256
            IS DISTINCT FROM p_fact ->> 'verification_receipt_sha256'
       OR v_existing.approval_receipt_sha256
            IS DISTINCT FROM p_fact ->> 'approval_receipt_sha256' THEN
      RAISE EXCEPTION 'EVENTS purge intent conflicts with durable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  v_now := clock_timestamp();
  IF v_run ->> 'status' NOT IN (
       'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION'
     )
     OR v_run ->> 'billing_state' <> 'SETTLED'
     OR v_run ->> 'finished_at' IS NULL
     OR v_run ->> 'events_retention_until' IS NULL
     OR v_now < (v_run ->> 'events_retention_until')::timestamptz THEN
    RAISE EXCEPTION 'Run is not eligible for EVENTS retention'
      USING ERRCODE = '23514';
  END IF;
  IF v_run ->> 'status' = 'NEEDS_ATTENTION'
     AND NOT EXISTS (
       SELECT 1
         FROM public.run_billing_reconciliations AS reconciliation
        WHERE reconciliation.workspace_id = v_workspace_id
          AND reconciliation.run_id = v_run_id
     ) THEN
    RAISE EXCEPTION 'NEEDS_ATTENTION retention requires billing reconciliation'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1
    FROM public.run_archive_manifests AS manifest
    JOIN public.run_archive_verification_receipts AS verification
      ON verification.workspace_id = manifest.workspace_id
     AND verification.manifest_id = manifest.id
     AND verification.run_id = manifest.run_id
     AND verification.archive_ref = manifest.archive_ref
     AND verification.archive_sha256 = manifest.archive_sha256
     AND verification.status = 'VERIFIED'
    JOIN public.run_archive_approval_receipts AS approval
      ON approval.workspace_id = verification.workspace_id
     AND approval.manifest_id = manifest.id
     AND approval.verification_receipt_id = verification.id
     AND approval.verification_receipt_sha256 = verification.receipt_sha256
     AND approval.run_id = manifest.run_id
     AND approval.archive_ref = manifest.archive_ref
     AND approval.archive_sha256 = manifest.archive_sha256
     AND approval.status = 'APPROVED'
   WHERE manifest.workspace_id = v_workspace_id
     AND manifest.id = (p_fact ->> 'manifest_id')::uuid
     AND manifest.run_id = v_run_id
     AND manifest.archive_ref = p_fact ->> 'archive_ref'
     AND manifest.archive_sha256 = p_fact ->> 'archive_sha256'
     AND verification.id = (p_fact ->> 'verification_receipt_id')::uuid
     AND verification.receipt_sha256 = p_fact ->> 'verification_receipt_sha256'
     AND approval.id = (p_fact ->> 'approval_receipt_id')::uuid
     AND approval.receipt_sha256 = p_fact ->> 'approval_receipt_sha256';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENTS purge requires exact verified and approved evidence'
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.run_events
   WHERE workspace_id = v_workspace_id
     AND run_id = v_run_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.run_retention_purge_receipts (
    workspace_id, id, run_id, manifest_id, verification_receipt_id,
    approval_receipt_id, material_kind, archive_ref, archive_sha256,
    verification_receipt_sha256, approval_receipt_sha256,
    purged_checkpoints, purged_events, purged_outbox,
    financial_ledger_purged, purged_at
  ) VALUES (
    v_workspace_id, v_receipt_id, v_run_id,
    (p_fact ->> 'manifest_id')::uuid,
    (p_fact ->> 'verification_receipt_id')::uuid,
    (p_fact ->> 'approval_receipt_id')::uuid,
    'EVENTS', p_fact ->> 'archive_ref', p_fact ->> 'archive_sha256',
    p_fact ->> 'verification_receipt_sha256',
    p_fact ->> 'approval_receipt_sha256',
    0, v_deleted, 0, false, v_now
  );
  RETURN v_receipt_id;
END;
$function$;
ALTER FUNCTION app.purge_run_events(jsonb) OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.purge_run_events(jsonb) FROM PUBLIC;

CREATE FUNCTION app.purge_run_recovery_material(p_fact jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_fact ->> 'workspace_id')::uuid;
  v_run_id uuid := (p_fact ->> 'run_id')::uuid;
  v_receipt_id uuid := (p_fact ->> 'purge_receipt_id')::uuid;
  v_now timestamptz;
  v_run jsonb;
  v_existing public.run_retention_purge_receipts%ROWTYPE;
  v_checkpoints bigint;
  v_outbox bigint;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR (p_fact ->> 'archive_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'verification_receipt_sha256') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact ->> 'approval_receipt_sha256') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid RECOVERY purge intent'
      USING ERRCODE = '22023';
  END IF;

  SELECT receipt.*
    INTO v_existing
    FROM public.run_retention_purge_receipts AS receipt
   WHERE receipt.workspace_id = v_workspace_id
     AND receipt.run_id = v_run_id
     AND receipt.material_kind = 'RECOVERY';
  IF v_existing.id IS NULL THEN
    v_run := app.lock_run_retention_summary(v_workspace_id, v_run_id);
    SELECT receipt.*
      INTO v_existing
      FROM public.run_retention_purge_receipts AS receipt
     WHERE receipt.workspace_id = v_workspace_id
       AND receipt.run_id = v_run_id
       AND receipt.material_kind = 'RECOVERY';
  END IF;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.id IS DISTINCT FROM v_receipt_id
       OR v_existing.manifest_id IS DISTINCT FROM (p_fact ->> 'manifest_id')::uuid
       OR v_existing.verification_receipt_id
            IS DISTINCT FROM (p_fact ->> 'verification_receipt_id')::uuid
       OR v_existing.approval_receipt_id
            IS DISTINCT FROM (p_fact ->> 'approval_receipt_id')::uuid
       OR v_existing.archive_ref IS DISTINCT FROM p_fact ->> 'archive_ref'
       OR v_existing.archive_sha256 IS DISTINCT FROM p_fact ->> 'archive_sha256'
       OR v_existing.verification_receipt_sha256
            IS DISTINCT FROM p_fact ->> 'verification_receipt_sha256'
       OR v_existing.approval_receipt_sha256
            IS DISTINCT FROM p_fact ->> 'approval_receipt_sha256' THEN
      RAISE EXCEPTION 'RECOVERY purge intent conflicts with durable receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  v_now := clock_timestamp();
  IF v_run ->> 'status' NOT IN (
       'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION'
     )
     OR v_run ->> 'billing_state' <> 'SETTLED'
     OR v_run ->> 'finished_at' IS NULL
     OR v_run ->> 'recovery_retention_until' IS NULL
     OR v_run ->> 'retention_until' IS NULL
     OR v_now < (v_run ->> 'recovery_retention_until')::timestamptz
     OR v_now < (v_run ->> 'retention_until')::timestamptz THEN
    RAISE EXCEPTION 'Run is not eligible for RECOVERY retention'
      USING ERRCODE = '23514';
  END IF;
  IF v_run ->> 'status' = 'NEEDS_ATTENTION'
     AND NOT EXISTS (
       SELECT 1
         FROM public.run_billing_reconciliations AS reconciliation
        WHERE reconciliation.workspace_id = v_workspace_id
          AND reconciliation.run_id = v_run_id
     ) THEN
    RAISE EXCEPTION 'NEEDS_ATTENTION retention requires billing reconciliation'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.credit_reservations AS reservation
     WHERE reservation.workspace_id = v_workspace_id
       AND reservation.run_id = v_run_id
       AND reservation.status = 'HELD'
  ) THEN
    RAISE EXCEPTION 'HELD reservation blocks RECOVERY retention'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.outbox AS message
     WHERE message.workspace_id = v_workspace_id
       AND message.run_id = v_run_id
       AND message.status IN ('PENDING', 'LEASED')
  ) THEN
    RAISE EXCEPTION 'pending or leased Outbox blocks RECOVERY retention'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.run_archive_manifests AS manifest
    JOIN public.run_archive_verification_receipts AS verification
      ON verification.workspace_id = manifest.workspace_id
     AND verification.manifest_id = manifest.id
     AND verification.run_id = manifest.run_id
     AND verification.archive_ref = manifest.archive_ref
     AND verification.archive_sha256 = manifest.archive_sha256
     AND verification.status = 'VERIFIED'
    JOIN public.run_archive_approval_receipts AS approval
      ON approval.workspace_id = verification.workspace_id
     AND approval.manifest_id = manifest.id
     AND approval.verification_receipt_id = verification.id
     AND approval.verification_receipt_sha256 = verification.receipt_sha256
     AND approval.run_id = manifest.run_id
     AND approval.archive_ref = manifest.archive_ref
     AND approval.archive_sha256 = manifest.archive_sha256
     AND approval.status = 'APPROVED'
   WHERE manifest.workspace_id = v_workspace_id
     AND manifest.id = (p_fact ->> 'manifest_id')::uuid
     AND manifest.run_id = v_run_id
     AND manifest.archive_ref = p_fact ->> 'archive_ref'
     AND manifest.archive_sha256 = p_fact ->> 'archive_sha256'
     AND verification.id = (p_fact ->> 'verification_receipt_id')::uuid
     AND verification.receipt_sha256 = p_fact ->> 'verification_receipt_sha256'
     AND approval.id = (p_fact ->> 'approval_receipt_id')::uuid
     AND approval.receipt_sha256 = p_fact ->> 'approval_receipt_sha256';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECOVERY purge requires exact verified and approved evidence'
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.run_checkpoints
   WHERE workspace_id = v_workspace_id
     AND run_id = v_run_id;
  GET DIAGNOSTICS v_checkpoints = ROW_COUNT;
  DELETE FROM public.outbox
   WHERE workspace_id = v_workspace_id
     AND run_id = v_run_id
     AND status = 'DELIVERED';
  GET DIAGNOSTICS v_outbox = ROW_COUNT;

  INSERT INTO public.run_retention_purge_receipts (
    workspace_id, id, run_id, manifest_id, verification_receipt_id,
    approval_receipt_id, material_kind, archive_ref, archive_sha256,
    verification_receipt_sha256, approval_receipt_sha256,
    purged_checkpoints, purged_events, purged_outbox,
    financial_ledger_purged, purged_at
  ) VALUES (
    v_workspace_id, v_receipt_id, v_run_id,
    (p_fact ->> 'manifest_id')::uuid,
    (p_fact ->> 'verification_receipt_id')::uuid,
    (p_fact ->> 'approval_receipt_id')::uuid,
    'RECOVERY', p_fact ->> 'archive_ref', p_fact ->> 'archive_sha256',
    p_fact ->> 'verification_receipt_sha256',
    p_fact ->> 'approval_receipt_sha256',
    v_checkpoints, 0, v_outbox, false, v_now
  );
  RETURN v_receipt_id;
END;
$function$;
ALTER FUNCTION app.purge_run_recovery_material(jsonb) OWNER TO ba_retention;
REVOKE ALL ON FUNCTION app.purge_run_recovery_material(jsonb) FROM PUBLIC;

-- Extend the signed transaction-local tenant context with a pointer-free
-- browser-session shape. The verifier is never projected; the context MAC is
-- checked against the private auth index on every RLS evaluation.
SET LOCAL ROLE ba_auth_owner;
-- G0-05 revocation updates the public lifecycle before the private verifier
-- projection. Replace its legacy authentication entry point with the same
-- public-to-private lock order before adding the pointer-free G0-06 entry point.
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
  v_session public.browser_sessions%ROWTYPE;
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

  SELECT session_row.*
    INTO v_session
    FROM public.browser_sessions AS session_row
   WHERE session_row.id = p_browser_session_id
   FOR SHARE OF session_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'browser session authentication rejected'
      USING ERRCODE = '42501';
  END IF;

  SELECT private_row.*
    INTO v_private
    FROM auth.browser_session_auth_index AS private_row
   WHERE private_row.workspace_id = v_session.workspace_id
     AND private_row.browser_session_id = p_browser_session_id
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
   WHERE session_row.workspace_id = v_session.workspace_id
     AND session_row.id = v_session.id
     AND session_row.workspace_id = v_private.workspace_id
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

CREATE FUNCTION auth.authenticate_browser_session_identity(
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
  v_session public.browser_sessions%ROWTYPE;
  v_txid bigint;
  v_signature text;
BEGIN
  PERFORM set_config('app.tenant_context', '', true);
  IF NOT pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER')
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
     OR p_browser_session_id IS NULL
     OR p_presented_verifier_hmac IS NULL
     OR octet_length(p_presented_verifier_hmac) <> 32
     OR NOT auth.is_canonical_https_origin(p_actual_origin)
     OR p_token_audience <> 'agent_browser_api'
     OR p_client_channel NOT IN ('WEB_SDK', 'DINGTALK_WEB') THEN
    RAISE EXCEPTION 'invalid pointer-free browser identity request'
      USING ERRCODE = '42501';
  END IF;

  -- Revocation updates the public lifecycle before its private verifier
  -- projection. Authentication takes the same lock order to avoid a
  -- public/private deadlock while still validating both rows atomically.
  SELECT session_row.*
    INTO v_session
    FROM public.browser_sessions AS session_row
   WHERE session_row.id = p_browser_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'browser session identity lifecycle or stable Deployment rejected'
      USING ERRCODE = '42501';
  END IF;

  SELECT private_row.*
    INTO v_private
    FROM auth.browser_session_auth_index AS private_row
   WHERE private_row.workspace_id = v_session.workspace_id
     AND private_row.browser_session_id = p_browser_session_id
   FOR SHARE;
  IF NOT FOUND
     OR v_private.status <> 'ACTIVE'
     OR v_private.expires_at <= clock_timestamp()
     OR NOT auth.constant_time_equal_32(
       v_private.verifier_hmac, p_presented_verifier_hmac
     ) THEN
    RAISE EXCEPTION 'browser session verifier or private lifecycle rejected'
      USING ERRCODE = '42501';
  END IF;

  SELECT session_row.*
    INTO v_session
    FROM public.browser_sessions AS session_row
    JOIN public.end_user_principals AS principal
      ON principal.workspace_id = session_row.workspace_id
     AND principal.id = session_row.principal_id
    JOIN public.agent_deployments AS deployment
      ON deployment.workspace_id = session_row.workspace_id
     AND deployment.id = session_row.agent_deployment_id
    JOIN public.agent_deployment_security_states AS security_state
      ON security_state.workspace_id = deployment.workspace_id
     AND security_state.agent_deployment_id = deployment.id
   WHERE session_row.workspace_id = v_private.workspace_id
     AND session_row.id = v_private.browser_session_id
     AND session_row.status = 'ACTIVE'
     AND session_row.session_epoch = v_private.session_epoch
     AND session_row.expires_at = v_private.expires_at
     AND session_row.expires_at > clock_timestamp()
     AND session_row.canonical_origin = p_actual_origin
     AND session_row.token_audience = p_token_audience
     AND session_row.client_channel = p_client_channel
     AND principal.status = 'active'
     AND principal.session_epoch = session_row.observed_principal_session_epoch
     AND deployment.ingress_channel = 'browser'
     AND security_state.status = 'ACTIVE'
     AND security_state.revoke_epoch = session_row.observed_deployment_revoke_epoch
   FOR SHARE OF session_row, principal, deployment, security_state;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'browser session identity lifecycle or stable Deployment rejected'
      USING ERRCODE = '42501';
  END IF;

  v_txid := txid_current();
  v_signature := encode(
    public.hmac(
      convert_to(format(
        'browser:%s:%s:%s:%s:%s:%s',
        v_session.workspace_id,
        v_session.id,
        v_session.principal_id,
        v_session.agent_deployment_id,
        v_txid,
        session_user
      ), 'UTF8'),
      v_private.verifier_hmac,
      'sha256'
    ),
    'hex'
  );
  PERFORM set_config(
    'app.tenant_context',
    format(
      'browser:%s:%s:%s:%s:%s:%s',
      v_session.workspace_id,
      v_session.id,
      v_session.principal_id,
      v_session.agent_deployment_id,
      v_txid,
      v_signature
    ),
    true
  );
  IF app.current_workspace_id() IS DISTINCT FROM v_session.workspace_id THEN
    PERFORM set_config('app.tenant_context', '', true);
    RAISE EXCEPTION 'browser tenant context signature could not be established'
      USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'workspace_id', v_session.workspace_id,
    'browser_session_id', v_session.id,
    'end_user_principal_id', v_session.principal_id,
    'agent_deployment_id', v_session.agent_deployment_id,
    'session_epoch', v_session.session_epoch,
    'observed_principal_session_epoch', v_session.observed_principal_session_epoch,
    'observed_deployment_revoke_epoch', v_session.observed_deployment_revoke_epoch
  );
END;
$function$;

CREATE FUNCTION auth.authorize_browser_original_run(
  p_browser_session_id uuid,
  p_workspace_id uuid,
  p_end_user_principal_id uuid,
  p_agent_deployment_id uuid,
  p_required_scope text,
  p_session_epoch bigint,
  p_principal_epoch bigint,
  p_deployment_epoch bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authorized_at timestamptz := clock_timestamp();
  v_parts text[] := string_to_array(
    current_setting('app.tenant_context', true), ':'
  );
BEGIN
  IF p_required_scope NOT IN ('run:read', 'run:events:read', 'run:cancel')
     OR p_session_epoch IS NULL
     OR p_principal_epoch IS NULL
     OR p_deployment_epoch IS NULL
     OR app.current_workspace_id() IS DISTINCT FROM p_workspace_id
     OR array_length(v_parts, 1) <> 7
     OR v_parts[1] <> 'browser'
     OR v_parts[3]::uuid IS DISTINCT FROM p_browser_session_id THEN
    RAISE EXCEPTION 'invalid persisted-target browser authorization request'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.browser_sessions AS session_row
    JOIN public.end_user_principals AS principal
      ON principal.workspace_id = session_row.workspace_id
     AND principal.id = session_row.principal_id
    JOIN public.agent_deployments AS deployment
      ON deployment.workspace_id = session_row.workspace_id
     AND deployment.id = session_row.agent_deployment_id
    JOIN public.agent_deployment_security_states AS security_state
      ON security_state.workspace_id = deployment.workspace_id
     AND security_state.agent_deployment_id = deployment.id
   WHERE session_row.workspace_id = p_workspace_id
     AND session_row.id = p_browser_session_id
     AND session_row.principal_id = p_end_user_principal_id
     AND session_row.agent_deployment_id = p_agent_deployment_id
     AND session_row.status = 'ACTIVE'
     AND session_row.session_epoch = p_session_epoch
     AND session_row.expires_at > v_authorized_at
     AND principal.status = 'active'
     AND principal.session_epoch = p_principal_epoch
     AND principal.session_epoch = session_row.observed_principal_session_epoch
     AND deployment.ingress_channel = 'browser'
     AND security_state.status = 'ACTIVE'
     AND security_state.revoke_epoch = p_deployment_epoch
     AND security_state.revoke_epoch = session_row.observed_deployment_revoke_epoch
   FOR SHARE OF session_row, principal, deployment, security_state;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'browser session does not authorize persisted original Run target'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION auth.authenticate_browser_session_identity(
  uuid, bytea, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.authorize_browser_original_run(
  uuid, uuid, uuid, uuid, text, bigint, bigint, bigint
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.authenticate_browser_session_identity(
  uuid, bytea, text, text, text
), auth.authorize_browser_original_run(
  uuid, uuid, uuid, uuid, text, bigint, bigint, bigint
) TO ba_run_owner;
RESET ROLE;

CREATE FUNCTION app.lock_original_run_idempotency_namespace(p_namespace jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := (p_namespace ->> 'workspace_id')::uuid;
  v_principal jsonb := p_namespace -> 'authenticated_principal';
  v_principal_kind text := v_principal ->> 'kind';
  v_credential_id uuid := (v_principal ->> 'credential_id')::uuid;
  v_end_user_id uuid := (v_principal ->> 'end_user_principal_id')::uuid;
  v_fixed_route text := p_namespace ->> 'fixed_route';
  v_key text := p_namespace ->> 'idempotency_key';
  v_browser_identity jsonb := p_namespace -> 'browserIdentity';
  v_canonical_namespace jsonb := p_namespace - 'browserIdentity';
  v_intent_hash text;
  v_run_id uuid;
  v_http_status integer;
  v_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_namespace) <> 'object'
     OR (p_namespace - ARRAY[
       'schema_version',
       'workspace_id',
        'authenticated_principal',
        'fixed_route',
        'idempotency_key',
        'browserIdentity'
      ]) <> '{}'::jsonb
     OR p_namespace ->> 'schema_version' <> 'run-idempotency-namespace/1'
     OR v_fixed_route NOT IN ('/v1/oapi/agent/chat', '/v1/oapi/flow/run')
     OR length(v_key) NOT BETWEEN 1 AND 128
     OR v_workspace_id IS DISTINCT FROM app.current_workspace_id()
     OR v_principal_kind NOT IN ('credential', 'end_user')
      OR (v_principal_kind = 'credential' AND (
        v_credential_id IS NULL
        OR v_end_user_id IS NOT NULL
        OR v_credential_id IS DISTINCT FROM app.current_api_credential_id()
        OR p_namespace ? 'browserIdentity'
      ))
      OR (v_principal_kind = 'end_user' AND (
        v_credential_id IS NOT NULL
        OR v_end_user_id IS NULL
        OR jsonb_typeof(v_browser_identity) IS DISTINCT FROM 'object'
        OR app.current_authenticated_principal_id()
          IS DISTINCT FROM 'end_user:' || v_end_user_id::text
     ))
     OR (v_fixed_route = '/v1/oapi/flow/run'
         AND v_principal_kind <> 'credential') THEN
    RAISE EXCEPTION 'invalid original Run idempotency namespace'
      USING ERRCODE = '42501';
  END IF;

  SELECT sentinel.intent_hash, receipt.run_id, receipt.http_status,
         receipt.data_redacted
    INTO v_intent_hash, v_run_id, v_http_status, v_receipt
    FROM public.run_idempotency_sentinels AS sentinel
    JOIN public.run_acceptance_receipts AS receipt
      ON receipt.workspace_id = sentinel.workspace_id
     AND receipt.sentinel_id = sentinel.id
     AND receipt.principal_kind = sentinel.principal_kind
     AND receipt.principal_id = sentinel.principal_id
     AND receipt.fixed_route = sentinel.fixed_route
     AND receipt.idempotency_key = sentinel.idempotency_key
     AND receipt.intent_hash = sentinel.intent_hash
   WHERE sentinel.workspace_id = v_workspace_id
     AND sentinel.principal_kind = v_principal_kind
     AND sentinel.credential_id IS NOT DISTINCT FROM v_credential_id
     AND sentinel.end_user_principal_id IS NOT DISTINCT FROM v_end_user_id
     AND sentinel.fixed_route = v_fixed_route
     AND sentinel.idempotency_key = v_key
   FOR UPDATE OF sentinel, receipt;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- The namespace lock is not an authorization result. Before revealing an
  -- intent, target, or receipt, re-authorize the persisted Run target under
  -- the current literal scope/grant or the signed browser identity epochs.
  -- This keeps a revoked caller from bypassing the API's post-lookup gate by
  -- invoking this definer directly.
  PERFORM app.require_original_run_authorization(
    v_run_id,
    'run:read',
    CASE v_principal_kind
      WHEN 'credential' THEN jsonb_build_object(
        'auth_mode', 'service',
        'workspaceId', v_workspace_id
      )
      ELSE jsonb_build_object(
        'auth_mode', 'browser',
        'workspaceId', v_workspace_id,
        'browserIdentity', v_browser_identity
      )
    END
  );
  RETURN jsonb_build_object(
    'namespace', v_canonical_namespace,
    'intentHash', v_intent_hash,
    'runId', v_run_id,
    'receipt', jsonb_build_object(
      'http_status', v_http_status,
      'data', v_receipt
    )
  );
END;
$function$;
ALTER FUNCTION app.lock_original_run_idempotency_namespace(jsonb)
  OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.lock_original_run_idempotency_namespace(jsonb)
  FROM PUBLIC;

CREATE FUNCTION app.require_original_run_authorization(
  p_run_id uuid,
  p_required_scope text,
  p_auth jsonb
)
RETURNS public.runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_mode text := COALESCE(
    p_auth ->> 'auth_mode',
    CASE
      WHEN jsonb_typeof(p_auth -> 'browserIdentity') = 'object'
        OR jsonb_typeof(p_auth -> 'browser_identity') = 'object'
      THEN 'browser'
      ELSE 'service'
    END
  );
  v_now timestamptz := clock_timestamp();
  v_identity jsonb;
  v_workspace_id uuid;
  v_credential_id uuid;
  v_run public.runs%ROWTYPE;
  v_locked public.runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL
     OR p_required_scope NOT IN ('run:read', 'run:events:read', 'run:cancel')
     OR jsonb_typeof(p_auth) <> 'object'
     OR v_mode NOT IN ('service', 'browser') THEN
    RAISE EXCEPTION 'invalid original Run authorization request'
      USING ERRCODE = '22023';
  END IF;

  IF v_mode = 'browser' THEN
    v_identity := COALESCE(
      p_auth -> 'browserIdentity',
      p_auth -> 'browser_identity',
      p_auth
    );
    IF jsonb_typeof(v_identity) <> 'object' THEN
      RAISE EXCEPTION 'browser original Run authorization lacks identity facts'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  v_workspace_id := app.current_workspace_id();
  v_credential_id := app.current_api_credential_id();
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'original Run request has no authenticated tenant context'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_auth ->> 'workspaceId', p_auth ->> 'workspace_id') IS NOT NULL
     AND COALESCE(p_auth ->> 'workspaceId', p_auth ->> 'workspace_id')::uuid
       IS DISTINCT FROM v_workspace_id THEN
    RAISE EXCEPTION 'original Run tenant claim does not match signed context'
      USING ERRCODE = '42501';
  END IF;

  SELECT run_row.*
    INTO v_run
    FROM public.runs AS run_row
   WHERE run_row.workspace_id = v_workspace_id
     AND run_row.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original Run is unavailable'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_mode = 'service' THEN
    IF v_credential_id IS NULL
       OR v_run.accepted_principal_kind <> 'credential'
       OR v_run.accepted_credential_id IS DISTINCT FROM v_credential_id THEN
      RAISE EXCEPTION 'service credential does not own the original Run'
        USING ERRCODE = '42501';
    END IF;
    IF v_run.target_kind = 'agent' THEN
      PERFORM app.authorize_agent_original_run(
        v_workspace_id, v_credential_id, v_run.agent_deployment_id,
        p_required_scope, v_now
      );
    ELSE
      PERFORM app.authorize_flow_original_run(
        v_workspace_id, v_credential_id, v_run.flow_deployment_id,
        p_required_scope, v_now
      );
    END IF;
  ELSE
    IF v_run.target_kind <> 'agent'
       OR v_run.accepted_principal_kind <> 'end_user'
       OR v_run.accepted_end_user_principal_id IS DISTINCT FROM
          COALESCE(
            v_identity ->> 'endUserPrincipalId',
            v_identity ->> 'end_user_principal_id'
          )::uuid
       OR v_run.agent_deployment_id IS DISTINCT FROM
          COALESCE(
            v_identity ->> 'agentDeploymentId',
            v_identity ->> 'agent_deployment_id'
          )::uuid THEN
      RAISE EXCEPTION 'browser identity does not own persisted original Run target'
        USING ERRCODE = '42501';
    END IF;
    PERFORM auth.authorize_browser_original_run(
      COALESCE(
        v_identity ->> 'browserSessionId',
        v_identity ->> 'browser_session_id'
      )::uuid,
      v_workspace_id,
      v_run.accepted_end_user_principal_id,
      v_run.agent_deployment_id,
      p_required_scope,
      COALESCE(
        v_identity ->> 'sessionAuthorizationEpoch',
        v_identity ->> 'session_epoch'
      )::bigint,
      COALESCE(
        v_identity ->> 'principalAuthorizationEpoch',
        v_identity ->> 'observed_principal_session_epoch'
      )::bigint,
      COALESCE(
        v_identity ->> 'deploymentAuthorizationEpoch',
        v_identity ->> 'observed_deployment_revoke_epoch'
      )::bigint
    );
  END IF;

  SELECT run_row.*
    INTO v_locked
    FROM public.runs AS run_row
   WHERE run_row.workspace_id = v_workspace_id
     AND run_row.id = p_run_id
     AND run_row.target_kind = v_run.target_kind
     AND run_row.accepted_principal_kind = v_run.accepted_principal_kind
     AND run_row.accepted_credential_id IS NOT DISTINCT FROM v_run.accepted_credential_id
     AND run_row.accepted_end_user_principal_id
       IS NOT DISTINCT FROM v_run.accepted_end_user_principal_id
     AND run_row.agent_deployment_id IS NOT DISTINCT FROM v_run.agent_deployment_id
     AND run_row.flow_deployment_id IS NOT DISTINCT FROM v_run.flow_deployment_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original Run identity changed during authorization'
      USING ERRCODE = '40001';
  END IF;

  -- Final grant/security fence revalidation happens after the Run lock so a
  -- concurrently committed revoke cannot race a successful response/write.
  IF v_mode = 'service' AND v_locked.target_kind = 'agent' THEN
    PERFORM app.authorize_agent_original_run(
      v_workspace_id, v_credential_id, v_locked.agent_deployment_id,
      p_required_scope, v_now
    );
  ELSIF v_mode = 'service' THEN
    PERFORM app.authorize_flow_original_run(
      v_workspace_id, v_credential_id, v_locked.flow_deployment_id,
      p_required_scope, v_now
    );
  ELSE
    PERFORM auth.authorize_browser_original_run(
      COALESCE(
        v_identity ->> 'browserSessionId',
        v_identity ->> 'browser_session_id'
      )::uuid,
      v_workspace_id,
      v_locked.accepted_end_user_principal_id,
      v_locked.agent_deployment_id,
      p_required_scope,
      COALESCE(
        v_identity ->> 'sessionAuthorizationEpoch',
        v_identity ->> 'session_epoch'
      )::bigint,
      COALESCE(
        v_identity ->> 'principalAuthorizationEpoch',
        v_identity ->> 'observed_principal_session_epoch'
      )::bigint,
      COALESCE(
        v_identity ->> 'deploymentAuthorizationEpoch',
        v_identity ->> 'observed_deployment_revoke_epoch'
      )::bigint
    );
  END IF;
  RETURN v_locked;
END;
$function$;
ALTER FUNCTION app.require_original_run_authorization(uuid, text, jsonb)
  OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.require_original_run_authorization(uuid, text, jsonb)
  FROM PUBLIC;

CREATE FUNCTION app.read_original_run(p_run_id uuid, p_auth jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_run public.runs%ROWTYPE;
  v_identity jsonb;
  v_principal jsonb;
  v_result jsonb;
BEGIN
  v_run := app.require_original_run_authorization(p_run_id, 'run:read', p_auth);
  v_principal := CASE v_run.accepted_principal_kind
    WHEN 'credential' THEN jsonb_build_object(
      'schema_version', 'conversation-principal/1',
      'kind', 'credential',
      'credential_id', v_run.accepted_credential_id
    )
    ELSE jsonb_build_object(
      'schema_version', 'conversation-principal/1',
      'kind', 'end_user',
      'end_user_principal_id', v_run.accepted_end_user_principal_id
    )
  END;
  v_result := jsonb_build_object(
    'workspaceId', v_run.workspace_id,
    'runId', v_run.id,
    'acceptedPrincipal', v_principal,
    'targetKind', v_run.target_kind,
    'deploymentId', CASE v_run.target_kind
      WHEN 'agent' THEN v_run.agent_deployment_id
      ELSE v_run.flow_deployment_id
    END,
    'authorizedScope', 'run:read'
  );
  IF jsonb_typeof(p_auth -> 'browserIdentity') = 'object'
     OR jsonb_typeof(p_auth -> 'browser_identity') = 'object' THEN
    -- require_original_run_authorization has already compared these epochs
    -- with locked current rows under the signed transaction context.
    v_identity := COALESCE(
      p_auth -> 'browserIdentity',
      p_auth -> 'browser_identity'
    );
    v_result := v_result || jsonb_build_object(
      'browserSessionId', COALESCE(
        v_identity ->> 'browserSessionId',
        v_identity ->> 'browser_session_id'
      )::uuid,
      'sessionAuthorizationEpoch', COALESCE(
        v_identity ->> 'sessionAuthorizationEpoch',
        v_identity ->> 'session_epoch'
      )::bigint,
      'principalAuthorizationEpoch', COALESCE(
        v_identity ->> 'principalAuthorizationEpoch',
        v_identity ->> 'observed_principal_session_epoch'
      )::bigint,
      'deploymentAuthorizationEpoch', COALESCE(
        v_identity ->> 'deploymentAuthorizationEpoch',
        v_identity ->> 'observed_deployment_revoke_epoch'
      )::bigint
    );
  END IF;
  RETURN v_result;
EXCEPTION
  WHEN insufficient_privilege OR no_data_found OR invalid_parameter_value
    OR data_exception THEN
    -- Historical target visibility is deliberately indistinguishable from a
    -- missing Run at the executable-role boundary.
    RETURN NULL;
END;
$function$;
ALTER FUNCTION app.read_original_run(uuid, jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.read_original_run(uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION app.read_original_run_events(p_run_id uuid, p_auth jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_run public.runs%ROWTYPE;
  v_events jsonb;
BEGIN
  v_run := app.require_original_run_authorization(
    p_run_id, 'run:events:read', p_auth
  );
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', event_row.id,
        'sequence', event_row.sequence,
        'event_type', event_row.event_type,
        'payload_redacted', event_row.payload_redacted,
        'occurred_at', event_row.occurred_at
      ) ORDER BY event_row.sequence
    ),
    '[]'::jsonb
  )
    INTO v_events
    FROM public.run_events AS event_row
   WHERE event_row.workspace_id = v_run.workspace_id
     AND event_row.run_id = v_run.id;
  RETURN v_events;
EXCEPTION
  WHEN insufficient_privilege OR no_data_found OR invalid_parameter_value
    OR data_exception THEN
    RETURN NULL;
END;
$function$;
ALTER FUNCTION app.read_original_run_events(uuid, jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.read_original_run_events(uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION app.request_run_cancellation(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_run_id uuid := (p_fact ->> 'runId')::uuid;
  v_requested_at timestamptz := clock_timestamp();
  v_key text := nullif(p_fact ->> 'idempotencyKey', '');
  v_mode text := CASE
    WHEN jsonb_typeof(p_fact -> 'browserIdentity') = 'object'
      THEN 'browser'
    ELSE 'service'
  END;
  v_identity jsonb;
  v_claimed_principal jsonb := p_fact -> 'authenticatedPrincipal';
  v_workspace_id uuid;
  v_principal_kind text;
  v_credential_id uuid;
  v_end_user_id uuid;
  v_mutation public.run_mutation_idempotency%ROWTYPE;
  v_inserted_mutation_id uuid;
  v_intent_hash text;
  v_run public.runs%ROWTYPE;
  v_sequence bigint;
  v_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR (p_fact - ARRAY[
       'workspaceId',
       'authenticatedPrincipal',
       'browserIdentity',
       'idempotencyKey',
       'runId',
       'requiredScope'
     ]) <> '{}'::jsonb
     OR p_fact ->> 'requiredScope' <> 'run:cancel'
     OR v_run_id IS NULL
     OR (v_key IS NOT NULL AND length(v_key) NOT BETWEEN 1 AND 128)
     OR jsonb_typeof(v_claimed_principal) <> 'object' THEN
    RAISE EXCEPTION 'invalid Run cancellation intent'
      USING ERRCODE = '22023';
  END IF;

  IF v_mode = 'browser' THEN
    v_identity := p_fact -> 'browserIdentity';
    v_principal_kind := 'end_user';
    v_end_user_id := (v_identity ->> 'endUserPrincipalId')::uuid;
  ELSE
    v_principal_kind := 'credential';
    v_credential_id := app.current_api_credential_id();
  END IF;
  v_workspace_id := app.current_workspace_id();
  IF v_workspace_id IS NULL
     OR (p_fact ->> 'workspaceId')::uuid IS DISTINCT FROM v_workspace_id
     OR (v_principal_kind = 'credential' AND v_credential_id IS NULL) THEN
    RAISE EXCEPTION 'cancellation has no authenticated principal context'
      USING ERRCODE = '42501';
  END IF;
  IF (v_principal_kind = 'credential' AND (
       v_claimed_principal ->> 'kind' <> 'credential'
       OR (v_claimed_principal ->> 'credential_id')::uuid
         IS DISTINCT FROM v_credential_id
     )) OR (v_principal_kind = 'end_user' AND (
       v_claimed_principal ->> 'kind' <> 'end_user'
       OR (v_claimed_principal ->> 'end_user_principal_id')::uuid
         IS DISTINCT FROM v_end_user_id
       OR app.current_authenticated_principal_id()
         IS DISTINCT FROM 'end_user:' || v_end_user_id::text
     )) THEN
    RAISE EXCEPTION 'cancellation principal does not match signed context'
      USING ERRCODE = '42501';
  END IF;

  -- A committed key hit is resolved before touching the caller-supplied Run.
  -- Authorize the stored target first, then compare, so cross-target key reuse
  -- cannot disclose whether another tenant/principal owns that target.
  IF v_key IS NOT NULL THEN
    SELECT mutation.*
      INTO v_mutation
      FROM public.run_mutation_idempotency AS mutation
     WHERE mutation.workspace_id = v_workspace_id
       AND mutation.principal_kind = v_principal_kind
       AND mutation.credential_id IS NOT DISTINCT FROM v_credential_id
       AND mutation.end_user_principal_id IS NOT DISTINCT FROM v_end_user_id
       AND mutation.fixed_route = '/v1/oapi/runs/{run_id}/cancel'
       AND mutation.idempotency_key = v_key
     FOR UPDATE;
    IF FOUND THEN
      v_run := app.require_original_run_authorization(
        v_mutation.target_run_id, 'run:cancel', p_fact
      );
      IF v_mutation.target_run_id IS DISTINCT FROM v_run_id THEN
        RAISE EXCEPTION 'Idempotency-Key was reused for another Run target'
          USING ERRCODE = '23505';
      END IF;
      v_intent_hash := 'sha256:' || encode(
        digest(
          convert_to(
            format('run-cancel/1|%s|CANCEL', v_mutation.target_run_id),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      );
      IF v_mutation.intent_hash IS DISTINCT FROM v_intent_hash
         OR v_mutation.http_status IS NULL
         OR v_mutation.completed_at IS NULL THEN
        RAISE EXCEPTION 'committed cancellation key has an incomplete receipt'
          USING ERRCODE = '55000';
      END IF;
      RETURN jsonb_build_object(
        'outcome', 'REPLAY',
        'receipt', v_mutation.receipt_data_redacted
      );
    END IF;
  END IF;

  v_run := app.require_original_run_authorization(
    v_run_id, 'run:cancel', p_fact
  );
  v_intent_hash := 'sha256:' || encode(
    digest(
      convert_to(format('run-cancel/1|%s|CANCEL', v_run.id), 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  IF v_run.status IN (
    'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_ATTENTION'
  ) THEN
    v_receipt := jsonb_build_object(
      'http_status', 200,
      'data', jsonb_build_object(
        'run_id', v_run.id,
        'accepted_request_id', v_run.accepted_request_id,
        'status', CASE
          WHEN v_run.status = 'NEEDS_ATTENTION' THEN 'FAILED'
          ELSE v_run.status
        END,
        'last_sequence', COALESCE(
          v_run.terminal_event_sequence,
          v_run.last_event_sequence
        )::text,
        'billing_pending', false,
        'billing_state', v_run.billing_state
      )
    );
    IF v_run.status = 'SUCCEEDED' THEN
      v_receipt := jsonb_set(
        v_receipt,
        '{data}',
        (v_receipt -> 'data') || jsonb_build_object(
          'result', v_run.terminal_result_redacted,
          'billing_settled_at', v_run.billing_settled_at
        )
      );
    ELSIF v_run.billing_state = 'SETTLED' THEN
      v_receipt := jsonb_set(
        v_receipt,
        '{data}',
        (v_receipt -> 'data') || jsonb_build_object(
          'error', v_run.terminal_error_redacted,
          'billing_settled_at', v_run.billing_settled_at
        )
      );
    ELSE
      v_receipt := jsonb_set(
        v_receipt,
        '{data}',
        (v_receipt -> 'data') || jsonb_build_object(
          'error', v_run.terminal_error_redacted
        )
      );
    END IF;
  ELSIF v_run.status = 'CANCEL_REQUESTED' THEN
    v_receipt := jsonb_build_object(
      'http_status', 202,
      'data', jsonb_build_object(
        'run_id', v_run.id,
        'accepted_request_id', v_run.accepted_request_id,
        'status', v_run.status,
        'operation_url', '/v1/oapi/runs/' || v_run.id::text,
        'events_url', '/v1/oapi/runs/' || v_run.id::text || '/events'
      )
    );
  END IF;

  IF v_key IS NOT NULL THEN
    INSERT INTO public.run_mutation_idempotency (
      workspace_id, id, principal_kind, credential_id, end_user_principal_id,
      fixed_route, idempotency_key, target_run_id, intent_hash,
      http_status, receipt_data_redacted, event_sequence, completed_at,
      active, expires_at, created_at
    ) VALUES (
      v_workspace_id,
      gen_random_uuid(),
      v_principal_kind,
      v_credential_id,
      v_end_user_id,
      '/v1/oapi/runs/{run_id}/cancel',
      v_key,
      v_run.id,
      v_intent_hash,
      CASE WHEN v_receipt IS NULL THEN NULL
           ELSE (v_receipt ->> 'http_status')::integer END,
      COALESCE(v_receipt, '{}'::jsonb),
      CASE WHEN v_receipt ->> 'http_status' = '202'
           THEN v_run.last_event_sequence ELSE NULL END,
      CASE WHEN v_receipt IS NULL THEN NULL ELSE v_requested_at END,
      true,
      v_requested_at + interval '24 hours',
      v_requested_at
    ) ON CONFLICT DO NOTHING
      RETURNING id INTO v_inserted_mutation_id;

    IF v_inserted_mutation_id IS NULL THEN
      SELECT mutation.*
        INTO v_mutation
        FROM public.run_mutation_idempotency AS mutation
       WHERE mutation.workspace_id = v_workspace_id
         AND mutation.principal_kind = v_principal_kind
         AND mutation.credential_id IS NOT DISTINCT FROM v_credential_id
         AND mutation.end_user_principal_id IS NOT DISTINCT FROM v_end_user_id
         AND mutation.fixed_route = '/v1/oapi/runs/{run_id}/cancel'
         AND (
           mutation.idempotency_key = v_key
           OR (
             mutation.target_run_id = v_run.id
             AND mutation.intent_hash = v_intent_hash
           )
         )
       ORDER BY (mutation.idempotency_key = v_key) DESC
       LIMIT 1
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'cancellation idempotency conflict has no durable row'
          USING ERRCODE = '55000';
      END IF;
      v_run := app.require_original_run_authorization(
        v_mutation.target_run_id, 'run:cancel', p_fact
      );
      IF v_mutation.target_run_id IS DISTINCT FROM v_run_id THEN
        RAISE EXCEPTION 'Idempotency-Key was reused for another Run target'
          USING ERRCODE = '23505';
      END IF;
      IF v_mutation.intent_hash IS DISTINCT FROM v_intent_hash
         OR v_mutation.http_status IS NULL
         OR v_mutation.completed_at IS NULL THEN
        RAISE EXCEPTION 'concurrent cancellation receipt is incomplete'
          USING ERRCODE = '55000';
      END IF;
      RETURN jsonb_build_object(
        'outcome', 'REPLAY',
        'receipt', v_mutation.receipt_data_redacted
      );
    END IF;
  END IF;

  IF v_receipt IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'ACCEPTED', 'receipt', v_receipt);
  END IF;

  v_sequence := v_run.last_event_sequence + 1;

  INSERT INTO public.run_events (
    workspace_id, id, run_id, sequence, event_type, dedupe_key,
    payload_redacted, occurred_at
  ) VALUES (
    v_workspace_id,
    gen_random_uuid(),
    v_run_id,
    v_sequence,
    'RUN_CANCEL_REQUESTED',
    'cancel:' || v_intent_hash,
    jsonb_build_object('status', 'CANCEL_REQUESTED'),
    v_requested_at
  );
  INSERT INTO public.outbox (
    workspace_id, id, run_id, message_type, dedupe_key,
    payload_ref, payload_hash, producer_fencing_token,
    payload_redacted, status, available_at, created_at
  ) VALUES (
    v_workspace_id,
    gen_random_uuid(),
    v_run_id,
    'SSE_WAKE',
    'cancel:' || v_intent_hash,
    'run:' || v_run_id::text || ':cancel',
    v_intent_hash,
    1,
    jsonb_build_object('run_id', v_run_id),
    'PENDING',
    v_requested_at,
    v_requested_at
  );
  UPDATE public.runs
     SET status = 'CANCEL_REQUESTED',
         execution_status = 'CANCELLING',
         last_event_sequence = v_sequence
   WHERE workspace_id = v_workspace_id
     AND id = v_run_id;
  v_receipt := jsonb_build_object(
    'http_status', 202,
    'data', jsonb_build_object(
      'run_id', v_run_id,
      'accepted_request_id', v_run.accepted_request_id,
      'status', 'CANCEL_REQUESTED',
      'operation_url', '/v1/oapi/runs/' || v_run_id::text,
      'events_url', '/v1/oapi/runs/' || v_run_id::text || '/events'
    )
  );
  IF v_key IS NOT NULL THEN
    UPDATE public.run_mutation_idempotency
       SET http_status = 202,
           receipt_data_redacted = v_receipt,
           event_sequence = v_sequence,
           completed_at = v_requested_at
     WHERE workspace_id = v_workspace_id
       AND id = v_inserted_mutation_id;
  END IF;
  RETURN jsonb_build_object('outcome', 'ACCEPTED', 'receipt', v_receipt);
END;
$function$;
ALTER FUNCTION app.request_run_cancellation(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.request_run_cancellation(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.authenticate_browser_session_identity(
  uuid, bytea, text, text, text
), app.lock_original_run_idempotency_namespace(jsonb),
  app.read_original_run(uuid, jsonb),
  app.read_original_run_events(uuid, jsonb),
  app.request_run_cancellation(jsonb) TO ba_runtime;

-- Ownership transfer is complete. Keep only schema USAGE needed by owned
-- functions; no owner retains object-creation capability after apply.
REVOKE CREATE ON SCHEMA app FROM
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention,
  ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention,
  ba_authorization_owner;
