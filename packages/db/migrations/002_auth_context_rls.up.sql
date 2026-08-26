-- G0-04 authentication, authorization mutation and tenant-isolation boundary.
-- This migration deliberately excludes browser sessions/Deployment grants
-- (G0-05) and internal phase attestations/executor roles (G0-07).

CREATE SCHEMA app AUTHORIZATION ba_auth_owner;
CREATE SCHEMA auth AUTHORIZATION ba_auth_owner;
REVOKE ALL ON SCHEMA app, auth FROM PUBLIC;
-- ba_authorization_owner receives several reviewed functions in auth. CREATE
-- is needed only for ALTER FUNCTION OWNER and is revoked before commit.
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;

CREATE TABLE auth.credential_auth_index (
  key_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  credential_id uuid NOT NULL,
  credential_kind text NOT NULL CHECK (credential_kind IN (
    'service_api',
    'publish',
    'webhook',
    'mcp',
    'permission_callback'
  )),
  secret_verifier_hmac bytea NOT NULL
    CHECK (octet_length(secret_verifier_hmac) = 32),
  status text NOT NULL CHECK (status IN ('active', 'overlap', 'revoked', 'expired')),
  not_before_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  rotation_group uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT credential_auth_index_workspace_id_id_key
    UNIQUE (workspace_id, key_id),
  CONSTRAINT credential_auth_index_workspace_credential_key
    UNIQUE (workspace_id, credential_id),
  CONSTRAINT credential_auth_index_credential_fkey
    FOREIGN KEY (workspace_id, credential_id, credential_kind)
    REFERENCES public.api_credentials(workspace_id, id, credential_kind),
  CONSTRAINT credential_auth_index_lifecycle_shape CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (
      status = 'overlap'
      AND revoked_at IS NULL
      AND expires_at IS NOT NULL
      AND rotation_group IS NOT NULL
    )
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status = 'expired' AND revoked_at IS NULL AND expires_at IS NOT NULL)
  )
);

CREATE TABLE auth.control_session_attestations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  principal_id uuid NOT NULL,
  bound_session_user name NOT NULL,
  issuer text NOT NULL CHECK (length(btrim(issuer)) > 0),
  issuer_subject_hash bytea NOT NULL
    CHECK (octet_length(issuer_subject_hash) = 32),
  attestation_verifier_hmac bytea NOT NULL
    CHECK (octet_length(attestation_verifier_hmac) = 32),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT control_session_attestations_workspace_id_id_key
    UNIQUE (workspace_id, id),
  CONSTRAINT control_session_attestations_member_fkey
    FOREIGN KEY (workspace_id, principal_id)
    REFERENCES public.workspace_members(workspace_id, user_id),
  CONSTRAINT control_session_attestations_expiry_check CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + interval '15 minutes'
  ),
  CONSTRAINT control_session_attestations_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR revoked_at IS NOT NULL
  )
);

CREATE TABLE auth.authorization_audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  event_kind text NOT NULL CHECK (event_kind IN (
    'credential_authentication_succeeded',
    'credential_authentication_rejected',
    'credential_created',
    'credential_transitioned',
    'credential_scope_added',
    'secret_ref_created',
    'permission_callback_created',
    'permission_callback_transitioned',
    'issuer_config_created',
    'issuer_config_transitioned',
    'end_user_principal_created',
    'end_user_principal_revoked',
    'subject_assertion_consumed',
    'control_attestation_issued',
    'control_attestation_revoked',
    'control_context_established'
  )),
  actor_principal_id text,
  subject_kind text NOT NULL CHECK (subject_kind IN (
    'credential',
    'secret_ref',
    'permission_callback',
    'browser_subject_issuer',
    'end_user_principal',
    'subject_assertion',
    'control_attestation'
  )),
  subject_id uuid NOT NULL,
  reason text,
  detail_redacted jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail_redacted) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT authorization_audit_events_workspace_id_id_key
    UNIQUE (workspace_id, id)
);

ALTER TABLE auth.credential_auth_index OWNER TO ba_auth_owner;
ALTER TABLE auth.control_session_attestations OWNER TO ba_auth_owner;
ALTER TABLE auth.authorization_audit_events OWNER TO ba_auth_owner;

REVOKE ALL ON TABLE
  auth.credential_auth_index,
  auth.control_session_attestations,
  auth.authorization_audit_events
FROM PUBLIC;
REVOKE ALL ON TABLE
  auth.credential_auth_index,
  auth.control_session_attestations,
  auth.authorization_audit_events
FROM
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_authorization_owner;

ALTER TABLE auth.credential_auth_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.credential_auth_index FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_auth_index_owner_only
  ON auth.credential_auth_index
  FOR ALL TO ba_auth_owner
  USING (true)
  WITH CHECK (true);

ALTER TABLE auth.control_session_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.control_session_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY control_session_attestations_owner_only
  ON auth.control_session_attestations
  FOR ALL TO ba_auth_owner
  USING (true)
  WITH CHECK (true);

ALTER TABLE auth.authorization_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.authorization_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY authorization_audit_events_owner_only
  ON auth.authorization_audit_events
  FOR ALL TO ba_auth_owner
  USING (true)
  WITH CHECK (true);

CREATE INDEX control_session_attestations_workspace_principal_active_idx
  ON auth.control_session_attestations(workspace_id, principal_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX authorization_audit_events_workspace_time_idx
  ON auth.authorization_audit_events(workspace_id, occurred_at, id);

CREATE FUNCTION auth.constant_time_equal_32(
  p_left bytea,
  p_right bytea
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
DECLARE
  v_index integer;
  v_difference integer := 0;
BEGIN
  IF p_left IS NULL OR p_right IS NULL
     OR octet_length(p_left) <> 32
     OR octet_length(p_right) <> 32 THEN
    RETURN false;
  END IF;

  FOR v_index IN 0..31 LOOP
    v_difference := v_difference
      | (get_byte(p_left, v_index) # get_byte(p_right, v_index));
  END LOOP;
  RETURN v_difference = 0;
END;
$function$;


ALTER FUNCTION auth.constant_time_equal_32(bytea, bytea) OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.constant_time_equal_32(bytea, bytea) FROM PUBLIC;

CREATE FUNCTION auth.append_authorization_audit(
  p_workspace_id uuid,
  p_event_kind text,
  p_actor_principal_id text,
  p_subject_kind text,
  p_subject_id uuid,
  p_reason text,
  p_detail_redacted jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
DECLARE
  v_event_id uuid := public.gen_random_uuid();
  v_detail jsonb := COALESCE(p_detail_redacted, '{}'::jsonb);
BEGIN
  IF p_workspace_id IS NULL OR p_subject_id IS NULL
     OR jsonb_typeof(v_detail) <> 'object'
     OR v_detail ?| ARRAY[
       'secret', 'token', 'verifier', 'authorization', 'assertion',
       'signature', 'password', 'cookie'
     ] THEN
    RAISE EXCEPTION 'authorization audit input is invalid or contains a forbidden material key'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO auth.authorization_audit_events (
    id,
    workspace_id,
    event_kind,
    actor_principal_id,
    subject_kind,
    subject_id,
    reason,
    detail_redacted
  ) VALUES (
    v_event_id,
    p_workspace_id,
    p_event_kind,
    NULLIF(left(COALESCE(p_actor_principal_id, ''), 255), ''),
    p_subject_kind,
    p_subject_id,
    NULLIF(left(COALESCE(p_reason, ''), 512), ''),
    v_detail
  );

  RETURN v_event_id;
END;
$function$;

ALTER FUNCTION auth.append_authorization_audit(uuid, text, text, text, uuid, text, jsonb)
  OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.append_authorization_audit(uuid, text, text, text, uuid, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.append_authorization_audit(uuid, text, text, text, uuid, text, jsonb)
  TO ba_authorization_owner;

CREATE FUNCTION auth.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$function$;

ALTER FUNCTION auth.reject_append_only_mutation() OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.reject_append_only_mutation() FROM PUBLIC;

CREATE TRIGGER authorization_audit_events_append_only
BEFORE UPDATE OR DELETE ON auth.authorization_audit_events
FOR EACH ROW EXECUTE FUNCTION auth.reject_append_only_mutation();

CREATE FUNCTION auth.sync_credential_auth_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  INSERT INTO auth.credential_auth_index (
    key_id,
    workspace_id,
    credential_id,
    credential_kind,
    secret_verifier_hmac,
    status,
    not_before_at,
    expires_at,
    revoked_at,
    rotation_group,
    created_at,
    updated_at
  ) VALUES (
    NEW.key_id,
    NEW.workspace_id,
    NEW.id,
    NEW.credential_kind,
    NEW.secret_verifier_hmac,
    NEW.status,
    NEW.not_before_at,
    NEW.expires_at,
    NEW.revoked_at,
    NEW.rotation_group,
    NEW.created_at,
    clock_timestamp()
  )
  ON CONFLICT (key_id) DO UPDATE SET
    workspace_id = EXCLUDED.workspace_id,
    credential_id = EXCLUDED.credential_id,
    credential_kind = EXCLUDED.credential_kind,
    secret_verifier_hmac = EXCLUDED.secret_verifier_hmac,
    status = EXCLUDED.status,
    not_before_at = EXCLUDED.not_before_at,
    expires_at = EXCLUDED.expires_at,
    revoked_at = EXCLUDED.revoked_at,
    rotation_group = EXCLUDED.rotation_group,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION auth.sync_credential_auth_index() OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.sync_credential_auth_index() FROM PUBLIC;

CREATE TRIGGER api_credentials_sync_auth_index
AFTER INSERT OR UPDATE OF
  key_id,
  workspace_id,
  credential_kind,
  secret_verifier_hmac,
  status,
  not_before_at,
  expires_at,
  revoked_at,
  rotation_group
ON public.api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.sync_credential_auth_index();

CREATE FUNCTION auth.issue_control_session_attestation(
  p_attestation_id uuid,
  p_workspace_id uuid,
  p_principal_id uuid,
  p_bound_session_user name,
  p_issuer text,
  p_issuer_subject_hash bytea,
  p_attestation_verifier_hmac bytea,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
DECLARE
  v_member_role text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_catalog.pg_has_role(
       session_user,
       'ba_management_attestation_issuer',
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER') THEN
    RAISE EXCEPTION 'control attestation issuance requires an isolated management issuer login'
      USING ERRCODE = '42501';
  END IF;

  IF p_attestation_id IS NULL
     OR p_workspace_id IS NULL
     OR p_principal_id IS NULL
     OR p_bound_session_user IS NULL
     OR p_issuer IS NULL OR length(btrim(p_issuer)) = 0
     OR p_issuer_subject_hash IS NULL OR octet_length(p_issuer_subject_hash) <> 32
     OR p_attestation_verifier_hmac IS NULL
     OR octet_length(p_attestation_verifier_hmac) <> 32
     OR p_expires_at IS NULL
     OR p_expires_at <= v_now
     OR p_expires_at > v_now + interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid control-session attestation input'
      USING ERRCODE = '22023';
  END IF;

  SELECT member.role
    INTO v_member_role
    FROM public.workspace_members AS member
   WHERE member.workspace_id = p_workspace_id
     AND member.user_id = p_principal_id
     AND member.role IN ('admin', 'developer');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'principal is not an active control-plane member of workspace'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO auth.control_session_attestations (
    id,
    workspace_id,
    principal_id,
    bound_session_user,
    issuer,
    issuer_subject_hash,
    attestation_verifier_hmac,
    issued_at,
    expires_at
  ) VALUES (
    p_attestation_id,
    p_workspace_id,
    p_principal_id,
    p_bound_session_user,
    p_issuer,
    p_issuer_subject_hash,
    p_attestation_verifier_hmac,
    v_now,
    p_expires_at
  );

  PERFORM auth.append_authorization_audit(
    p_workspace_id,
    'control_attestation_issued',
    'management-issuer:' || session_user::text,
    'control_attestation',
    p_attestation_id,
    NULL,
    jsonb_build_object('bound_session_user', p_bound_session_user::text)
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'control-session attestation id already exists'
      USING ERRCODE = '23505';
END;
$function$;

CREATE FUNCTION auth.revoke_control_session_attestation(
  p_attestation_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(
       session_user,
       'ba_management_attestation_issuer',
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER') THEN
    RAISE EXCEPTION 'control attestation revocation requires an isolated management issuer login'
      USING ERRCODE = '42501';
  END IF;

  IF p_attestation_id IS NULL THEN
    RAISE EXCEPTION 'control-session attestation id is required'
      USING ERRCODE = '22023';
  END IF;

  UPDATE auth.control_session_attestations
     SET revoked_at = clock_timestamp(),
         revoked_reason = NULLIF(left(COALESCE(p_reason, ''), 512), '')
   WHERE id = p_attestation_id
     AND revoked_at IS NULL
   RETURNING workspace_id INTO v_workspace_id;

  IF NOT FOUND THEN
    SELECT att.workspace_id
      INTO v_workspace_id
      FROM auth.control_session_attestations AS att
     WHERE att.id = p_attestation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'control-session attestation not found'
        USING ERRCODE = 'P0002';
    END IF;
    RETURN;
  END IF;

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'control_attestation_revoked',
    'management-issuer:' || session_user::text,
    'control_attestation',
    p_attestation_id,
    p_reason,
    '{}'::jsonb
  );
END;
$function$;

ALTER FUNCTION auth.issue_control_session_attestation(
  uuid, uuid, uuid, name, text, bytea, bytea, timestamptz
) OWNER TO ba_auth_owner;
ALTER FUNCTION auth.revoke_control_session_attestation(uuid, text)
  OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.issue_control_session_attestation(
  uuid, uuid, uuid, name, text, bytea, bytea, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.revoke_control_session_attestation(uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.issue_control_session_attestation(
  uuid, uuid, uuid, name, text, bytea, bytea, timestamptz
) TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.revoke_control_session_attestation(uuid, text)
  TO ba_management_attestation_issuer;

CREATE FUNCTION auth.establish_control_workspace_context(
  p_attestation_id uuid,
  p_presented_verifier bytea
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_principal_id uuid;
  v_attestation_verifier_hmac bytea;
  v_bound_session_user name;
  v_expires_at timestamptz;
  v_revoked_at timestamptz;
  v_member_role text;
  v_txid bigint;
  v_context_signature text;
BEGIN
  PERFORM set_config('app.tenant_context', '', true);

  IF NOT pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
     OR pg_catalog.pg_has_role(
       session_user,
       'ba_management_attestation_issuer',
       'MEMBER'
     ) THEN
    RAISE EXCEPTION 'control context establishment requires an isolated control executor login'
      USING ERRCODE = '42501';
  END IF;

  IF p_attestation_id IS NULL
     OR p_presented_verifier IS NULL
     OR octet_length(p_presented_verifier) <> 32 THEN
    RETURN NULL;
  END IF;

  SELECT
    att.workspace_id,
    att.principal_id,
    att.attestation_verifier_hmac,
    att.bound_session_user,
    att.expires_at,
    att.revoked_at
  INTO
    v_workspace_id,
    v_principal_id,
    v_attestation_verifier_hmac,
    v_bound_session_user,
    v_expires_at,
    v_revoked_at
  FROM auth.control_session_attestations AS att
  WHERE att.id = p_attestation_id
  FOR SHARE OF att;

  IF NOT FOUND
     OR NOT auth.constant_time_equal_32(
       v_attestation_verifier_hmac,
       p_presented_verifier
     )
     OR v_bound_session_user IS DISTINCT FROM session_user::name
     OR v_revoked_at IS NOT NULL
     OR v_expires_at <= clock_timestamp() THEN
    RETURN NULL;
  END IF;

  SELECT member.role
    INTO v_member_role
    FROM public.workspace_members AS member
   WHERE member.workspace_id = v_workspace_id
     AND member.user_id = v_principal_id
     AND member.role IN ('admin', 'developer');

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_txid := txid_current();
  v_context_signature := encode(
    public.hmac(
      convert_to(
        format(
          'control:%s:%s:%s:%s:%s',
          v_workspace_id,
          p_attestation_id,
          v_principal_id,
          v_txid,
          session_user
        ),
        'UTF8'
      ),
      v_attestation_verifier_hmac,
      'sha256'
    ),
    'hex'
  );

  PERFORM set_config(
    'app.tenant_context',
    format(
      'control:%s:%s:%s:%s:%s',
      v_workspace_id,
      p_attestation_id,
      v_principal_id,
      v_txid,
      v_context_signature
    ),
    true
  );

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'control_context_established',
    'user:' || v_principal_id::text,
    'control_attestation',
    p_attestation_id,
    NULL,
    '{}'::jsonb
  );
  RETURN v_workspace_id;
END;
$function$;

ALTER FUNCTION auth.establish_control_workspace_context(uuid, bytea)
  OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.establish_control_workspace_context(uuid, bytea)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.establish_control_workspace_context(uuid, bytea)
  TO ba_control_executor;

CREATE FUNCTION auth.authenticate_api_credential(
  p_key_id uuid,
  p_presented_verifier bytea
)
RETURNS TABLE (
  workspace_id uuid,
  credential_id uuid,
  credential_kind text,
  credential_scopes text[],
  credential_authorization_epoch bigint,
  workspace_authorization_epoch bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_credential_id uuid;
  v_credential_kind text;
  v_secret_verifier_hmac bytea;
  v_status text;
  v_not_before_at timestamptz;
  v_expires_at timestamptz;
  v_revoked_at timestamptz;
  v_rotation_group uuid;
  v_txid bigint;
  v_context_signature text;
  v_credential_scopes text[];
  v_credential_authorization_epoch bigint;
  v_workspace_authorization_epoch bigint;
BEGIN
  PERFORM set_config('app.tenant_context', '', true);

  -- A verifier login has a separate, publish-only authenticator below. A login
  -- enrolled in both roles is rejected rather than inheriting this general API
  -- credential path.
  IF pg_catalog.pg_has_role(
    session_user,
    'ba_subject_assertion_verifier',
    'MEMBER'
  ) THEN
    RETURN;
  END IF;

  IF p_key_id IS NULL
     OR p_presented_verifier IS NULL
     OR octet_length(p_presented_verifier) <> 32 THEN
    RETURN;
  END IF;

  SELECT
    idx.workspace_id,
    idx.credential_id,
    idx.credential_kind,
    idx.secret_verifier_hmac,
    idx.status,
    idx.not_before_at,
    idx.expires_at,
    idx.revoked_at,
    idx.rotation_group
  INTO
    v_workspace_id,
    v_credential_id,
    v_credential_kind,
    v_secret_verifier_hmac,
    v_status,
    v_not_before_at,
    v_expires_at,
    v_revoked_at,
    v_rotation_group
  FROM auth.credential_auth_index AS idx
  WHERE idx.key_id = p_key_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT auth.constant_time_equal_32(v_secret_verifier_hmac, p_presented_verifier)
     OR v_status NOT IN ('active', 'overlap')
     OR (
       v_status = 'overlap'
       AND (v_expires_at IS NULL OR v_rotation_group IS NULL)
     )
     OR (v_not_before_at IS NOT NULL AND v_not_before_at > clock_timestamp())
     OR (v_expires_at IS NOT NULL AND v_expires_at <= clock_timestamp())
     OR v_revoked_at IS NOT NULL THEN
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'credential verifier, lifecycle or time window rejected',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  v_txid := txid_current();
  v_context_signature := encode(
    public.hmac(
      convert_to(
        format(
          'credential:%s:%s:%s:%s',
          v_workspace_id,
          v_credential_id,
          v_txid,
          session_user
        ),
        'UTF8'
      ),
      v_secret_verifier_hmac,
      'sha256'
    ),
    'hex'
  );

  PERFORM set_config(
    'app.tenant_context',
    format(
      'credential:%s:%s:%s:%s',
      v_workspace_id,
      v_credential_id,
      v_txid,
      v_context_signature
    ),
    true
  );

  -- The private auth index proves the presented verifier, but versioned
  -- authorization facts always come from the FORCE-RLS-protected source tables
  -- after the signed transaction-local context has been established. Locking
  -- the credential serializes scope-trigger epoch changes with this snapshot.
  SELECT credential.authorization_epoch
  INTO v_credential_authorization_epoch
  FROM public.api_credentials AS credential
  WHERE credential.workspace_id = v_workspace_id
    AND credential.id = v_credential_id
    AND credential.key_id = p_key_id
    AND credential.credential_kind = v_credential_kind
    AND credential.status IN ('active', 'overlap')
    AND (
      credential.status <> 'overlap'
      OR (credential.expires_at IS NOT NULL AND credential.rotation_group IS NOT NULL)
    )
    AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
    AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
    AND credential.revoked_at IS NULL
    AND credential.workspace_id = app.current_workspace_id()
  FOR NO KEY UPDATE OF credential;

  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_context', '', true);
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'authoritative credential state rejected',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  SELECT COALESCE(
    array_agg(scope_row.scope ORDER BY scope_row.scope),
    ARRAY[]::text[]
  )
  INTO v_credential_scopes
  FROM public.api_credential_scopes AS scope_row
  WHERE scope_row.workspace_id = v_workspace_id
    AND scope_row.credential_id = v_credential_id
    AND scope_row.credential_kind = v_credential_kind
    AND scope_row.workspace_id = app.current_workspace_id();

  SELECT workspace.authorization_epoch
  INTO v_workspace_authorization_epoch
  FROM public.workspaces AS workspace
  WHERE workspace.id = v_workspace_id
    AND workspace.id = app.current_workspace_id();

  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_context', '', true);
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'authoritative workspace state rejected',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  UPDATE public.api_credentials AS credential
     SET last_used_at = clock_timestamp()
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = v_credential_id
     AND credential.status IN ('active', 'overlap')
     AND (
       credential.status <> 'overlap'
       OR (credential.expires_at IS NOT NULL AND credential.rotation_group IS NOT NULL)
     )
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
     AND credential.revoked_at IS NULL
     AND credential.workspace_id = app.current_workspace_id()
  RETURNING credential.authorization_epoch
       INTO v_credential_authorization_epoch;

  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_context', '', true);
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'credential expired before authentication completed',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'credential_authentication_succeeded',
    'credential:' || v_credential_id::text,
    'credential',
    v_credential_id,
    NULL,
    jsonb_build_object('credential_kind', v_credential_kind)
  );

  RETURN QUERY SELECT
    v_workspace_id,
    v_credential_id,
    v_credential_kind,
    v_credential_scopes,
    v_credential_authorization_epoch,
    v_workspace_authorization_epoch;
END;
$function$;

CREATE FUNCTION auth.authenticate_publish_exchange_credential(
  p_key_id uuid,
  p_presented_verifier bytea
)
RETURNS TABLE (
  workspace_id uuid,
  credential_id uuid,
  credential_kind text,
  credential_scopes text[],
  credential_authorization_epoch bigint,
  workspace_authorization_epoch bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_credential_id uuid;
  v_credential_kind text;
  v_secret_verifier_hmac bytea;
  v_status text;
  v_not_before_at timestamptz;
  v_expires_at timestamptz;
  v_revoked_at timestamptz;
  v_rotation_group uuid;
  v_txid bigint;
  v_context_signature text;
  v_credential_scopes text[];
  v_credential_authorization_epoch bigint;
  v_workspace_authorization_epoch bigint;
BEGIN
  PERFORM set_config('app.tenant_context', '', true);

  IF NOT pg_catalog.pg_has_role(
       session_user,
       'ba_subject_assertion_verifier',
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER')
     OR p_key_id IS NULL
     OR p_presented_verifier IS NULL
     OR octet_length(p_presented_verifier) <> 32 THEN
    RETURN;
  END IF;

  SELECT
    idx.workspace_id,
    idx.credential_id,
    idx.credential_kind,
    idx.secret_verifier_hmac,
    idx.status,
    idx.not_before_at,
    idx.expires_at,
    idx.revoked_at,
    idx.rotation_group
  INTO
    v_workspace_id,
    v_credential_id,
    v_credential_kind,
    v_secret_verifier_hmac,
    v_status,
    v_not_before_at,
    v_expires_at,
    v_revoked_at,
    v_rotation_group
  FROM auth.credential_auth_index AS idx
  WHERE idx.key_id = p_key_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_credential_kind <> 'publish'
     OR NOT auth.constant_time_equal_32(
       v_secret_verifier_hmac,
       p_presented_verifier
     )
     OR v_status NOT IN ('active', 'overlap')
     OR (
       v_status = 'overlap'
       AND (v_expires_at IS NULL OR v_rotation_group IS NULL)
     )
     OR (v_not_before_at IS NOT NULL AND v_not_before_at > clock_timestamp())
     OR (v_expires_at IS NOT NULL AND v_expires_at <= clock_timestamp())
     OR v_revoked_at IS NOT NULL THEN
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'publish exchange credential rejected',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  v_txid := txid_current();
  v_context_signature := encode(
    public.hmac(
      convert_to(
        format(
          'credential:%s:%s:%s:%s',
          v_workspace_id,
          v_credential_id,
          v_txid,
          session_user
        ),
        'UTF8'
      ),
      v_secret_verifier_hmac,
      'sha256'
    ),
    'hex'
  );
  PERFORM set_config(
    'app.tenant_context',
    format(
      'credential:%s:%s:%s:%s',
      v_workspace_id,
      v_credential_id,
      v_txid,
      v_context_signature
    ),
    true
  );

  -- The publish-only path follows the same source-of-truth rule as the general
  -- authenticator. No verifier material is projected from the private index.
  SELECT credential.authorization_epoch
  INTO v_credential_authorization_epoch
  FROM public.api_credentials AS credential
  WHERE credential.workspace_id = v_workspace_id
    AND credential.id = v_credential_id
    AND credential.key_id = p_key_id
    AND credential.credential_kind = 'publish'
    AND credential.status IN ('active', 'overlap')
    AND (
      credential.status <> 'overlap'
      OR (credential.expires_at IS NOT NULL AND credential.rotation_group IS NOT NULL)
    )
    AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
    AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
    AND credential.revoked_at IS NULL
    AND credential.workspace_id = app.current_workspace_id()
  FOR NO KEY UPDATE OF credential;

  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_context', '', true);
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'authoritative publish credential state rejected',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  SELECT COALESCE(
    array_agg(scope_row.scope ORDER BY scope_row.scope),
    ARRAY[]::text[]
  )
  INTO v_credential_scopes
  FROM public.api_credential_scopes AS scope_row
  WHERE scope_row.workspace_id = v_workspace_id
    AND scope_row.credential_id = v_credential_id
    AND scope_row.credential_kind = 'publish'
    AND scope_row.workspace_id = app.current_workspace_id();

  IF NOT ('browser-session:exchange' = ANY (v_credential_scopes)) THEN
    PERFORM set_config('app.tenant_context', '', true);
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'publish credential lacks browser-session:exchange scope',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  SELECT workspace.authorization_epoch
  INTO v_workspace_authorization_epoch
  FROM public.workspaces AS workspace
  WHERE workspace.id = v_workspace_id
    AND workspace.id = app.current_workspace_id();

  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_context', '', true);
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'authoritative workspace state rejected',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;

  UPDATE public.api_credentials AS credential
     SET last_used_at = clock_timestamp()
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = v_credential_id
     AND credential.status IN ('active', 'overlap')
     AND (
       credential.status <> 'overlap'
       OR (credential.expires_at IS NOT NULL AND credential.rotation_group IS NOT NULL)
     )
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
     AND credential.revoked_at IS NULL
     AND credential.workspace_id = app.current_workspace_id()
  RETURNING credential.authorization_epoch
       INTO v_credential_authorization_epoch;

  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_context', '', true);
    PERFORM auth.append_authorization_audit(
      v_workspace_id,
      'credential_authentication_rejected',
      NULL,
      'credential',
      v_credential_id,
      'publish credential expired before authentication completed',
      jsonb_build_object('credential_kind', v_credential_kind)
    );
    RETURN;
  END IF;
  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'credential_authentication_succeeded',
    'credential:' || v_credential_id::text,
    'credential',
    v_credential_id,
    NULL,
    jsonb_build_object('credential_kind', v_credential_kind)
  );

  RETURN QUERY SELECT
    v_workspace_id,
    v_credential_id,
    v_credential_kind,
    v_credential_scopes,
    v_credential_authorization_epoch,
    v_workspace_authorization_epoch;
END;
$function$;

ALTER FUNCTION auth.authenticate_api_credential(uuid, bytea)
  OWNER TO ba_auth_owner;
ALTER FUNCTION auth.authenticate_publish_exchange_credential(uuid, bytea)
  OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.authenticate_api_credential(uuid, bytea)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.authenticate_publish_exchange_credential(uuid, bytea)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.authenticate_api_credential(uuid, bytea)
  FROM
    ba_control_executor,
    ba_management_attestation_issuer,
    ba_subject_assertion_verifier;
GRANT EXECUTE ON FUNCTION auth.authenticate_api_credential(uuid, bytea)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION auth.authenticate_publish_exchange_credential(uuid, bytea)
  TO ba_subject_assertion_verifier;

CREATE FUNCTION app.current_workspace_id()
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

CREATE FUNCTION app.current_authenticated_principal_id()
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

CREATE FUNCTION app.current_api_credential_id()
RETURNS uuid
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
    RETURN v_context_parts[3]::uuid;
  END IF;
  RETURN NULL;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;

ALTER FUNCTION app.current_workspace_id() OWNER TO ba_auth_owner;
ALTER FUNCTION app.current_authenticated_principal_id() OWNER TO ba_auth_owner;
ALTER FUNCTION app.current_api_credential_id() OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION app.current_workspace_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_authenticated_principal_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_api_credential_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_workspace_id() TO
  ba_runtime,
  ba_control_executor,
  ba_subject_assertion_verifier,
  ba_auth_owner,
  ba_authorization_owner;
GRANT EXECUTE ON FUNCTION app.current_authenticated_principal_id() TO
  ba_runtime,
  ba_control_executor,
  ba_subject_assertion_verifier,
  ba_auth_owner,
  ba_authorization_owner;
GRANT EXECUTE ON FUNCTION app.current_api_credential_id() TO
  ba_runtime,
  ba_subject_assertion_verifier,
  ba_auth_owner;

CREATE FUNCTION auth.record_authorization_epoch_change(
  p_workspace_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_source_subkey text,
  p_source_epoch bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_epoch bigint;
BEGIN
  IF p_workspace_id IS DISTINCT FROM app.current_workspace_id()
     OR p_source_id IS NULL
     OR p_source_epoch < 0 THEN
    RAISE EXCEPTION 'authorization epoch mutation is outside authenticated workspace'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.workspaces
     SET authorization_epoch = authorization_epoch + 1,
         updated_at = clock_timestamp()
   WHERE id = p_workspace_id
   RETURNING authorization_epoch INTO v_workspace_epoch;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace not found for authorization epoch mutation'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.authorization_cache_invalidations (
    id,
    workspace_id,
    source_kind,
    source_id,
    source_subkey,
    source_epoch,
    workspace_epoch
  ) VALUES (
    public.gen_random_uuid(),
    p_workspace_id,
    p_source_kind,
    p_source_id,
    COALESCE(p_source_subkey, ''),
    p_source_epoch,
    v_workspace_epoch
  )
  ON CONFLICT (
    workspace_id,
    source_kind,
    source_id,
    source_subkey,
    source_epoch
  ) DO NOTHING;

  -- Durable invalidation is the correctness path. A shared LISTEN channel would
  -- disclose tenant/source identifiers to every listener with database access,
  -- so G0-04 emits no cross-tenant NOTIFY payload.
  RETURN v_workspace_epoch;
END;
$function$;

ALTER FUNCTION auth.record_authorization_epoch_change(uuid, text, uuid, text, bigint)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION auth.record_authorization_epoch_change(uuid, text, uuid, text, bigint)
  FROM PUBLIC;

CREATE FUNCTION auth.reject_api_credential_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.credential_kind IS DISTINCT FROM OLD.credential_kind
     OR NEW.secret_verifier_hmac IS DISTINCT FROM OLD.secret_verifier_hmac
     OR NEW.verifier_algorithm IS DISTINCT FROM OLD.verifier_algorithm
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'credential identity/verifier is immutable; rotate by creating a new credential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.enforce_api_credential_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.status = 'overlap' THEN
    IF NEW.rotation_group IS NULL
       OR NEW.expires_at IS NULL
       OR NEW.expires_at <= v_now THEN
      RAISE EXCEPTION 'overlap requires rotation_group and a future expiry'
        USING ERRCODE = '23514';
    END IF;
    IF (TG_OP = 'INSERT' OR OLD.status <> 'overlap')
       AND NEW.expires_at > v_now + interval '24 hours' THEN
      RAISE EXCEPTION 'credential overlap cannot exceed 24 hours'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'expired'
     AND (NEW.expires_at IS NULL OR NEW.expires_at > v_now) THEN
    RAISE EXCEPTION 'expired credential requires a reached expires_at'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.rotation_group IS NOT NULL
       AND NEW.rotation_group IS DISTINCT FROM OLD.rotation_group THEN
      RAISE EXCEPTION 'credential rotation_group is immutable once assigned'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('revoked', 'expired')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'terminal credential cannot be reactivated'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('revoked', 'expired')
       AND (
         NEW.not_before_at IS DISTINCT FROM OLD.not_before_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.rotation_group IS DISTINCT FROM OLD.rotation_group
         OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       ) THEN
      RAISE EXCEPTION 'terminal credential lifecycle metadata is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'overlap'
       AND (
         NEW.status = 'active'
         OR NEW.rotation_group IS DISTINCT FROM OLD.rotation_group
         OR NEW.expires_at IS NULL
         OR NEW.expires_at > OLD.expires_at
       ) THEN
      RAISE EXCEPTION 'overlap cannot return active, change rotation group or extend expiry'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'revoked'
       AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'revocation timestamp is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.reject_api_credential_scope_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'credential scope rows are immutable; add or revoke through a controlled path'
    USING ERRCODE = '23514';
END;
$function$;

CREATE FUNCTION auth.reject_permission_callback_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'permission callback identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.enforce_browser_subject_issuer_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.issuer IS DISTINCT FROM OLD.issuer
       OR NEW.audience IS DISTINCT FROM OLD.audience
       OR NEW.verification_key_ref_id IS DISTINCT FROM OLD.verification_key_ref_id
       OR NEW.key_version IS DISTINCT FROM OLD.key_version
       OR NEW.allowed_origins IS DISTINCT FROM OLD.allowed_origins
       OR NEW.max_assertion_ttl_seconds IS DISTINCT FROM OLD.max_assertion_ttl_seconds
       OR NEW.allowed_clock_skew_seconds IS DISTINCT FROM OLD.allowed_clock_skew_seconds
       OR NEW.not_before_at IS DISTINCT FROM OLD.not_before_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'issuer config is immutable; rotate by creating a new key version'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('retired', 'revoked')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'terminal issuer config cannot be reactivated'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.enforce_end_user_principal_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.issuer_config_id IS DISTINCT FROM OLD.issuer_config_id
     OR NEW.issuer IS DISTINCT FROM OLD.issuer
     OR NEW.subject_hash IS DISTINCT FROM OLD.subject_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'end-user principal identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'revoked end-user principal cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'revoked'
     AND (
       NEW.session_epoch IS DISTINCT FROM OLD.session_epoch
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     ) THEN
    RAISE EXCEPTION 'terminal end-user principal security fields are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.session_epoch < OLD.session_epoch THEN
    RAISE EXCEPTION 'end-user principal session_epoch cannot decrease'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.reject_authorization_source_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'authorization source rows are transitioned, never deleted'
    USING ERRCODE = '42501';
END;
$function$;

CREATE FUNCTION auth.bump_api_credential_epoch_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.authorization_epoch := GREATEST(COALESCE(NEW.authorization_epoch, 0), 1);
  ELSIF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.not_before_at IS DISTINCT FROM OLD.not_before_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.rotation_group IS DISTINCT FROM OLD.rotation_group
     OR NEW.allowed_origins IS DISTINCT FROM OLD.allowed_origins THEN
    NEW.authorization_epoch := OLD.authorization_epoch + 1;
  ELSIF NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
    -- api_credential_scopes has no independent epoch. Its AFTER trigger performs
    -- one nested UPDATE whose only change is an exact +1. pg_trigger_depth is a
    -- backend fact, not a caller-writable GUC; executable roles cannot create
    -- triggers or update either table directly.
    IF pg_trigger_depth() <> 2
       OR NEW.authorization_epoch <> OLD.authorization_epoch + 1
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.key_id IS DISTINCT FROM OLD.key_id
       OR NEW.key_hint IS DISTINCT FROM OLD.key_hint
       OR NEW.credential_kind IS DISTINCT FROM OLD.credential_kind
       OR NEW.secret_verifier_hmac IS DISTINCT FROM OLD.secret_verifier_hmac
       OR NEW.verifier_algorithm IS DISTINCT FROM OLD.verifier_algorithm
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.not_before_at IS DISTINCT FROM OLD.not_before_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.rotation_group IS DISTINCT FROM OLD.rotation_group
       OR NEW.allowed_origins IS DISTINCT FROM OLD.allowed_origins
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at THEN
      RAISE EXCEPTION 'credential authorization_epoch is controlled internally'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.record_api_credential_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
    PERFORM auth.record_authorization_epoch_change(
      NEW.workspace_id,
      'credential',
      NEW.id,
      '',
      NEW.authorization_epoch
    );
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.bump_credential_epoch_from_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := COALESCE(NEW.workspace_id, OLD.workspace_id);
  v_credential_id uuid := COALESCE(NEW.credential_id, OLD.credential_id);
  v_epoch bigint;
BEGIN
  UPDATE public.api_credentials
     SET authorization_epoch = authorization_epoch + 1
   WHERE workspace_id = v_workspace_id
     AND id = v_credential_id
   RETURNING authorization_epoch INTO v_epoch;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope mutation references missing credential'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.bump_permission_callback_epoch_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.authorization_epoch := GREATEST(COALESCE(NEW.authorization_epoch, 0), 1);
  ELSIF NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url
     OR NEW.auth_scheme IS DISTINCT FROM OLD.auth_scheme
     OR NEW.credential_secret_ref_id IS DISTINCT FROM OLD.credential_secret_ref_id
     OR NEW.timeout_ms IS DISTINCT FROM OLD.timeout_ms
     OR NEW.failure_mode IS DISTINCT FROM OLD.failure_mode
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.authorization_epoch := OLD.authorization_epoch + 1;
  ELSIF NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
    RAISE EXCEPTION 'permission callback authorization_epoch is controlled internally'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.record_permission_callback_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
    PERFORM auth.record_authorization_epoch_change(
      NEW.workspace_id,
      'permission_callback',
      NEW.id,
      '',
      NEW.authorization_epoch
    );
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.bump_issuer_config_epoch_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.authorization_epoch := GREATEST(COALESCE(NEW.authorization_epoch, 0), 1);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.authorization_epoch := OLD.authorization_epoch + 1;
  ELSIF NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
    RAISE EXCEPTION 'issuer authorization_epoch is controlled internally'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION auth.record_issuer_config_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
    PERFORM auth.record_authorization_epoch_change(
      NEW.workspace_id,
      'browser_subject_issuer',
      NEW.id,
      '',
      NEW.authorization_epoch
    );
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.record_end_user_principal_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.session_epoch IS DISTINCT FROM OLD.session_epoch THEN
    PERFORM auth.record_authorization_epoch_change(
      NEW.workspace_id,
      'end_user_principal',
      NEW.id,
      '',
      NEW.session_epoch
    );
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.audit_api_credential_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app, pg_temp
AS $function$
DECLARE
  v_event_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event_kind := 'credential_created';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM auth.append_authorization_audit(
    NEW.workspace_id,
    v_event_kind,
    app.current_authenticated_principal_id(),
    'credential',
    NEW.id,
    NULL,
    jsonb_build_object(
      'credential_kind', NEW.credential_kind,
      'status', NEW.status,
      'authorization_epoch', NEW.authorization_epoch
    )
  );
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.audit_api_credential_scope_add()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app, pg_temp
AS $function$
BEGIN
  PERFORM auth.append_authorization_audit(
    NEW.workspace_id,
    'credential_scope_added',
    app.current_authenticated_principal_id(),
    'credential',
    NEW.credential_id,
    NULL,
    jsonb_build_object('scope', NEW.scope)
  );
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.audit_permission_callback_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NULL;
  END IF;
  PERFORM auth.append_authorization_audit(
    NEW.workspace_id,
    'permission_callback_created',
    app.current_authenticated_principal_id(),
    'permission_callback',
    NEW.id,
    NULL,
    jsonb_build_object(
      'auth_scheme', NEW.auth_scheme,
      'status', NEW.status,
      'authorization_epoch', NEW.authorization_epoch
    )
  );
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.audit_issuer_config_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NULL;
  END IF;
  PERFORM auth.append_authorization_audit(
    NEW.workspace_id,
    'issuer_config_created',
    app.current_authenticated_principal_id(),
    'browser_subject_issuer',
    NEW.id,
    NULL,
    jsonb_build_object(
      'issuer', NEW.issuer,
      'audience', NEW.audience,
      'key_version', NEW.key_version,
      'status', NEW.status,
      'authorization_epoch', NEW.authorization_epoch
    )
  );
  RETURN NULL;
END;
$function$;

CREATE FUNCTION auth.audit_end_user_principal_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM auth.append_authorization_audit(
      NEW.workspace_id,
      'end_user_principal_created',
      app.current_authenticated_principal_id(),
      'end_user_principal',
      NEW.id,
      NULL,
      jsonb_build_object('issuer_config_id', NEW.issuer_config_id)
    );
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION auth.reject_api_credential_identity_change()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.enforce_api_credential_lifecycle()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.reject_api_credential_scope_update()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.reject_permission_callback_identity_change()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.enforce_browser_subject_issuer_lifecycle()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.enforce_end_user_principal_lifecycle()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.reject_authorization_source_delete()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.bump_api_credential_epoch_before_write()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.record_api_credential_epoch_after_write()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.bump_credential_epoch_from_scope()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.bump_permission_callback_epoch_before_write()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.record_permission_callback_epoch_after_write()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.bump_issuer_config_epoch_before_write()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.record_issuer_config_epoch_after_write()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.record_end_user_principal_epoch_after_write()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.audit_api_credential_change()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.audit_api_credential_scope_add()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.audit_permission_callback_change()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.audit_issuer_config_change()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.audit_end_user_principal_change()
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION auth.reject_api_credential_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_api_credential_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_api_credential_scope_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_permission_callback_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_browser_subject_issuer_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_end_user_principal_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_authorization_source_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bump_api_credential_epoch_before_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_api_credential_epoch_after_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bump_credential_epoch_from_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bump_permission_callback_epoch_before_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_permission_callback_epoch_after_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bump_issuer_config_epoch_before_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_issuer_config_epoch_after_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_end_user_principal_epoch_after_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.audit_api_credential_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.audit_api_credential_scope_add() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.audit_permission_callback_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.audit_issuer_config_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.audit_end_user_principal_change() FROM PUBLIC;

CREATE TRIGGER api_credentials_01_reject_identity_change
BEFORE UPDATE ON public.api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.reject_api_credential_identity_change();
CREATE TRIGGER api_credentials_02_enforce_lifecycle
BEFORE INSERT OR UPDATE ON public.api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.enforce_api_credential_lifecycle();
CREATE TRIGGER api_credentials_03_bump_epoch
BEFORE INSERT OR UPDATE ON public.api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.bump_api_credential_epoch_before_write();
CREATE TRIGGER api_credentials_90_record_epoch
AFTER INSERT OR UPDATE ON public.api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.record_api_credential_epoch_after_write();
CREATE TRIGGER api_credentials_91_audit
AFTER INSERT OR UPDATE ON public.api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.audit_api_credential_change();
CREATE TRIGGER api_credentials_99_reject_delete
BEFORE DELETE ON public.api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.reject_authorization_source_delete();

CREATE TRIGGER api_credential_scopes_01_reject_update
BEFORE UPDATE ON public.api_credential_scopes
FOR EACH ROW EXECUTE FUNCTION auth.reject_api_credential_scope_update();
CREATE TRIGGER api_credential_scopes_90_bump_epoch
AFTER INSERT OR DELETE ON public.api_credential_scopes
FOR EACH ROW EXECUTE FUNCTION auth.bump_credential_epoch_from_scope();
CREATE TRIGGER api_credential_scopes_91_audit_insert
AFTER INSERT ON public.api_credential_scopes
FOR EACH ROW EXECUTE FUNCTION auth.audit_api_credential_scope_add();

CREATE TRIGGER permission_callbacks_01_reject_identity_change
BEFORE UPDATE ON public.permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.reject_permission_callback_identity_change();
CREATE TRIGGER permission_callbacks_02_bump_epoch
BEFORE INSERT OR UPDATE ON public.permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.bump_permission_callback_epoch_before_write();
CREATE TRIGGER permission_callbacks_90_record_epoch
AFTER INSERT OR UPDATE ON public.permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.record_permission_callback_epoch_after_write();
CREATE TRIGGER permission_callbacks_91_audit
AFTER INSERT OR UPDATE ON public.permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.audit_permission_callback_change();
CREATE TRIGGER permission_callbacks_99_reject_delete
BEFORE DELETE ON public.permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.reject_authorization_source_delete();

CREATE TRIGGER browser_subject_issuer_configs_01_enforce_lifecycle
BEFORE UPDATE ON public.browser_subject_issuer_configs
FOR EACH ROW EXECUTE FUNCTION auth.enforce_browser_subject_issuer_lifecycle();
CREATE TRIGGER browser_subject_issuer_configs_02_bump_epoch
BEFORE INSERT OR UPDATE ON public.browser_subject_issuer_configs
FOR EACH ROW EXECUTE FUNCTION auth.bump_issuer_config_epoch_before_write();
CREATE TRIGGER browser_subject_issuer_configs_90_record_epoch
AFTER INSERT OR UPDATE ON public.browser_subject_issuer_configs
FOR EACH ROW EXECUTE FUNCTION auth.record_issuer_config_epoch_after_write();
CREATE TRIGGER browser_subject_issuer_configs_91_audit
AFTER INSERT OR UPDATE ON public.browser_subject_issuer_configs
FOR EACH ROW EXECUTE FUNCTION auth.audit_issuer_config_change();
CREATE TRIGGER browser_subject_issuer_configs_99_reject_delete
BEFORE DELETE ON public.browser_subject_issuer_configs
FOR EACH ROW EXECUTE FUNCTION auth.reject_authorization_source_delete();

CREATE TRIGGER end_user_principals_01_enforce_lifecycle
BEFORE UPDATE ON public.end_user_principals
FOR EACH ROW EXECUTE FUNCTION auth.enforce_end_user_principal_lifecycle();
CREATE TRIGGER end_user_principals_90_record_epoch
AFTER INSERT OR UPDATE ON public.end_user_principals
FOR EACH ROW EXECUTE FUNCTION auth.record_end_user_principal_epoch_after_write();
CREATE TRIGGER end_user_principals_91_audit
AFTER INSERT OR UPDATE ON public.end_user_principals
FOR EACH ROW EXECUTE FUNCTION auth.audit_end_user_principal_change();
CREATE TRIGGER end_user_principals_99_reject_delete
BEFORE DELETE ON public.end_user_principals
FOR EACH ROW EXECUTE FUNCTION auth.reject_authorization_source_delete();

CREATE TRIGGER browser_subject_assertion_uses_append_only
BEFORE UPDATE OR DELETE ON public.browser_subject_assertion_uses
FOR EACH ROW EXECUTE FUNCTION auth.reject_append_only_mutation();
CREATE TRIGGER authorization_cache_invalidations_append_only
BEFORE UPDATE OR DELETE ON public.authorization_cache_invalidations
FOR EACH ROW EXECUTE FUNCTION auth.reject_append_only_mutation();

CREATE FUNCTION auth.is_canonical_https_origin(p_origin text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
DECLARE
  v_authority text;
  v_host text;
  v_port_text text;
  v_colon_count integer;
  v_close_bracket integer;
  v_remainder text;
  v_label text;
  v_inet inet;
  v_port integer;
BEGIN
  IF p_origin IS NULL
     OR length(p_origin) > 267
     OR p_origin <> lower(p_origin)
     OR left(p_origin, 8) <> 'https://'
     OR position(E'\\' IN p_origin) > 0 THEN
    RETURN false;
  END IF;

  v_authority := substring(p_origin FROM 9);
  IF v_authority = ''
     OR v_authority = 'null'
     OR v_authority = '*'
     OR v_authority ~ '[/?#@[:space:]]' COLLATE "C" THEN
    RETURN false;
  END IF;

  IF left(v_authority, 1) = '[' THEN
    v_close_bracket := position(']' IN v_authority);
    IF v_close_bracket <= 2 THEN
      RETURN false;
    END IF;
    v_host := substring(v_authority FROM 2 FOR v_close_bracket - 2);
    v_remainder := substring(v_authority FROM v_close_bracket + 1);
    IF v_remainder <> '' THEN
      IF left(v_remainder, 1) <> ':' OR length(v_remainder) = 1 THEN
        RETURN false;
      END IF;
      v_port_text := substring(v_remainder FROM 2);
    END IF;
    BEGIN
      v_inet := v_host::inet;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    IF family(v_inet) <> 6 OR host(v_inet) <> v_host THEN
      RETURN false;
    END IF;
  ELSE
    v_colon_count := length(v_authority) - length(replace(v_authority, ':', ''));
    IF v_colon_count > 1 THEN
      RETURN false;
    ELSIF v_colon_count = 1 THEN
      v_host := split_part(v_authority, ':', 1);
      v_port_text := split_part(v_authority, ':', 2);
    ELSE
      v_host := v_authority;
    END IF;

    IF v_host = '' OR right(v_host, 1) = '.' OR position('..' IN v_host) > 0 THEN
      RETURN false;
    END IF;
    IF v_host ~ '^[0-9.]+$' COLLATE "C" THEN
      IF v_host !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' COLLATE "C" THEN
        RETURN false;
      END IF;
      BEGIN
        v_inet := v_host::inet;
      EXCEPTION WHEN others THEN
        RETURN false;
      END;
      IF family(v_inet) <> 4 OR host(v_inet) <> v_host THEN
        RETURN false;
      END IF;
    ELSE
      IF length(v_host) > 253 THEN
        RETURN false;
      END IF;
      FOREACH v_label IN ARRAY string_to_array(v_host, '.') LOOP
        IF length(v_label) = 0
           OR length(v_label) > 63
           OR v_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' COLLATE "C" THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF v_port_text IS NOT NULL THEN
    IF v_port_text !~ '^[0-9]{1,5}$' COLLATE "C"
       OR (length(v_port_text) > 1 AND left(v_port_text, 1) = '0') THEN
      RETURN false;
    END IF;
    v_port := v_port_text::integer;
    IF v_port < 1 OR v_port > 65535 OR v_port = 443 THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION
  WHEN others THEN
    RETURN false;
END;
$function$;

ALTER FUNCTION auth.is_canonical_https_origin(text) OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.is_canonical_https_origin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.is_canonical_https_origin(text)
  TO ba_authorization_owner;

CREATE FUNCTION auth.require_control_workspace()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_actor text := app.current_authenticated_principal_id();
BEGIN
  IF v_workspace_id IS NULL
     OR v_actor IS NULL
     OR v_actor !~ '^user:[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'an active control-plane tenant context is required'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_workspace_id;
END;
$function$;

ALTER FUNCTION auth.require_control_workspace() OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION auth.require_control_workspace() FROM PUBLIC;

CREATE FUNCTION auth.create_secret_ref(
  p_secret_ref_id uuid,
  p_provider text,
  p_opaque_locator text,
  p_version_hint text,
  p_purpose text,
  p_rotation_due_at timestamptz,
  p_metadata_redacted jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_metadata jsonb := COALESCE(p_metadata_redacted, '{}'::jsonb);
BEGIN
  IF p_secret_ref_id IS NULL
     OR p_provider NOT IN ('env', 'vault', 'k8s_secret', 'offline_bundle')
     OR p_opaque_locator IS NULL OR length(btrim(p_opaque_locator)) = 0
     OR length(p_opaque_locator) > 1024
     OR p_purpose IS NULL OR length(btrim(p_purpose)) = 0
     OR jsonb_typeof(v_metadata) <> 'object'
     OR v_metadata ?| ARRAY[
       'secret', 'token', 'password', 'private_key', 'authorization', 'cookie'
     ] THEN
    RAISE EXCEPTION 'invalid or secret-bearing secret reference metadata'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.secret_refs (
    id,
    workspace_id,
    provider,
    opaque_locator,
    version_hint,
    purpose,
    rotation_due_at,
    metadata_redacted
  ) VALUES (
    p_secret_ref_id,
    v_workspace_id,
    p_provider,
    p_opaque_locator,
    p_version_hint,
    p_purpose,
    p_rotation_due_at,
    v_metadata
  );

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'secret_ref_created',
    app.current_authenticated_principal_id(),
    'secret_ref',
    p_secret_ref_id,
    NULL,
    jsonb_build_object('provider', p_provider, 'purpose', p_purpose)
  );
  RETURN p_secret_ref_id;
END;
$function$;

CREATE FUNCTION auth.create_api_credential(
  p_credential_id uuid,
  p_key_id uuid,
  p_key_hint text,
  p_credential_kind text,
  p_secret_verifier_hmac bytea,
  p_scopes text[],
  p_allowed_origins text[],
  p_not_before_at timestamptz,
  p_expires_at timestamptz,
  p_rotation_group uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_scopes text[] := COALESCE(p_scopes, '{}'::text[]);
  v_origins text[] := COALESCE(p_allowed_origins, '{}'::text[]);
  v_scope text;
  v_origin text;
BEGIN
  IF p_credential_id IS NULL
     OR p_key_id IS NULL
     OR p_key_hint IS NULL OR length(btrim(p_key_hint)) = 0
     OR p_secret_verifier_hmac IS NULL
     OR octet_length(p_secret_verifier_hmac) <> 32
     OR p_credential_kind NOT IN (
       'service_api', 'publish', 'webhook', 'mcp', 'permission_callback'
     )
     OR (p_not_before_at IS NOT NULL AND p_expires_at IS NOT NULL
       AND p_expires_at <= p_not_before_at)
     OR (p_expires_at IS NOT NULL AND p_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'invalid API credential creation input'
      USING ERRCODE = '22023';
  END IF;

  IF array_position(v_scopes, NULL) IS NOT NULL
     OR cardinality(v_scopes) <> (
       SELECT count(DISTINCT scope_value)
         FROM unnest(v_scopes) AS scope_rows(scope_value)
     ) THEN
    RAISE EXCEPTION 'credential scopes must be non-null and unique'
      USING ERRCODE = '22023';
  END IF;

  IF p_credential_kind = 'publish' THEN
    IF v_scopes IS DISTINCT FROM ARRAY['browser-session:exchange']::text[]
       OR cardinality(v_origins) = 0 THEN
      RAISE EXCEPTION 'publish credentials require only browser-session:exchange and at least one origin'
        USING ERRCODE = '23514';
    END IF;
  ELSIF p_credential_kind = 'service_api' THEN
    IF cardinality(v_scopes) = 0 OR cardinality(v_origins) <> 0 THEN
      RAISE EXCEPTION 'service_api requires closed API scopes and no browser origin binding'
        USING ERRCODE = '23514';
    END IF;
  ELSIF cardinality(v_scopes) <> 0 OR cardinality(v_origins) <> 0 THEN
    RAISE EXCEPTION 'non-public-entry credential kinds cannot carry public API scopes or origins'
      USING ERRCODE = '23514';
  END IF;

  FOREACH v_origin IN ARRAY v_origins LOOP
    IF NOT auth.is_canonical_https_origin(v_origin) THEN
      RAISE EXCEPTION 'allowed origin is not canonical HTTPS: %', v_origin
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF cardinality(v_origins) <> (
    SELECT count(DISTINCT origin_value)
      FROM unnest(v_origins) AS origin_rows(origin_value)
  ) THEN
    RAISE EXCEPTION 'allowed origins must be unique'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.api_credentials (
    id,
    workspace_id,
    key_id,
    key_hint,
    credential_kind,
    secret_verifier_hmac,
    status,
    not_before_at,
    expires_at,
    rotation_group,
    allowed_origins
  ) VALUES (
    p_credential_id,
    v_workspace_id,
    p_key_id,
    p_key_hint,
    p_credential_kind,
    p_secret_verifier_hmac,
    'active',
    p_not_before_at,
    p_expires_at,
    p_rotation_group,
    v_origins
  );

  FOREACH v_scope IN ARRAY v_scopes LOOP
    INSERT INTO public.api_credential_scopes (
      workspace_id,
      credential_id,
      credential_kind,
      scope
    ) VALUES (
      v_workspace_id,
      p_credential_id,
      p_credential_kind,
      v_scope
    );
  END LOOP;

  RETURN p_credential_id;
END;
$function$;

CREATE FUNCTION auth.add_api_credential_scope(
  p_credential_id uuid,
  p_scope text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_credential_kind text;
  v_epoch bigint;
BEGIN
  SELECT credential.credential_kind
    INTO v_credential_kind
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = p_credential_id
     AND credential.status = 'active'
   FOR UPDATE OF credential;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active credential not found in control workspace'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.api_credential_scopes (
    workspace_id,
    credential_id,
    credential_kind,
    scope
  ) VALUES (
    v_workspace_id,
    p_credential_id,
    v_credential_kind,
    p_scope
  );

  SELECT credential.authorization_epoch
    INTO v_epoch
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = p_credential_id;
  RETURN v_epoch;
END;
$function$;

CREATE FUNCTION auth.transition_api_credential(
  p_credential_id uuid,
  p_target_status text,
  p_overlap_expires_at timestamptz,
  p_rotation_group uuid,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_current public.api_credentials%ROWTYPE;
  v_epoch bigint;
BEGIN
  SELECT credential.*
    INTO v_current
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = p_credential_id
   FOR UPDATE OF credential;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential not found in control workspace'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_current.status IN ('revoked', 'expired') THEN
    IF p_target_status = v_current.status THEN
      RETURN v_current.authorization_epoch;
    END IF;
    RAISE EXCEPTION 'terminal credential cannot transition'
      USING ERRCODE = '23514';
  END IF;

  IF p_target_status = 'overlap' THEN
    IF v_current.status <> 'active'
       OR v_current.revoked_at IS NOT NULL
       OR (v_current.not_before_at IS NOT NULL
         AND v_current.not_before_at > clock_timestamp())
       OR (v_current.expires_at IS NOT NULL
         AND v_current.expires_at <= clock_timestamp())
       OR p_rotation_group IS NULL
       OR p_overlap_expires_at IS NULL
       OR p_overlap_expires_at <= clock_timestamp()
       OR p_overlap_expires_at > clock_timestamp() + interval '24 hours'
       OR (v_current.expires_at IS NOT NULL
         AND p_overlap_expires_at > v_current.expires_at) THEN
      RAISE EXCEPTION 'overlap requires an active source, rotation group and expiry within 24 hours'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.api_credentials AS replacement
       WHERE replacement.workspace_id = v_workspace_id
         AND replacement.id <> p_credential_id
         AND replacement.credential_kind = v_current.credential_kind
         AND replacement.rotation_group = p_rotation_group
         AND replacement.status = 'active'
         AND replacement.revoked_at IS NULL
         AND (replacement.not_before_at IS NULL
           OR replacement.not_before_at <= clock_timestamp())
         AND (replacement.expires_at IS NULL
           OR replacement.expires_at > p_overlap_expires_at)
    ) THEN
      RAISE EXCEPTION 'overlap requires a currently valid replacement that remains valid through the overlap window'
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.api_credentials
       SET status = 'overlap',
           rotation_group = p_rotation_group,
           expires_at = p_overlap_expires_at
     WHERE workspace_id = v_workspace_id
       AND id = p_credential_id
     RETURNING authorization_epoch INTO v_epoch;
  ELSIF p_target_status = 'revoked' THEN
    IF p_overlap_expires_at IS NOT NULL OR p_rotation_group IS NOT NULL THEN
      RAISE EXCEPTION 'revocation does not accept overlap fields'
        USING ERRCODE = '22023';
    END IF;
    UPDATE public.api_credentials
       SET status = 'revoked',
           revoked_at = clock_timestamp()
     WHERE workspace_id = v_workspace_id
       AND id = p_credential_id
     RETURNING authorization_epoch INTO v_epoch;
  ELSIF p_target_status = 'expired' THEN
    IF p_overlap_expires_at IS NOT NULL OR p_rotation_group IS NOT NULL
       OR v_current.expires_at IS NULL
       OR v_current.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'expired transition requires an already reached credential expiry'
        USING ERRCODE = '23514';
    END IF;
    UPDATE public.api_credentials
       SET status = 'expired'
     WHERE workspace_id = v_workspace_id
       AND id = p_credential_id
     RETURNING authorization_epoch INTO v_epoch;
  ELSE
    RAISE EXCEPTION 'target status must be overlap, revoked or expired'
      USING ERRCODE = '22023';
  END IF;

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'credential_transitioned',
    app.current_authenticated_principal_id(),
    'credential',
    p_credential_id,
    p_reason,
    jsonb_build_object('from_status', v_current.status, 'to_status', p_target_status)
  );
  RETURN v_epoch;
END;
$function$;

CREATE FUNCTION auth.create_browser_subject_issuer_config(
  p_issuer_config_id uuid,
  p_issuer text,
  p_audience text,
  p_verification_key_ref_id uuid,
  p_key_version integer,
  p_allowed_origins text[],
  p_max_assertion_ttl_seconds integer,
  p_allowed_clock_skew_seconds integer,
  p_not_before_at timestamptz,
  p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_origins text[] := COALESCE(p_allowed_origins, '{}'::text[]);
  v_origin text;
BEGIN
  IF p_issuer_config_id IS NULL
     OR p_issuer IS NULL OR length(btrim(p_issuer)) = 0
     OR p_audience IS NULL OR length(btrim(p_audience)) = 0
     OR p_verification_key_ref_id IS NULL
     OR p_key_version IS NULL OR p_key_version <= 0
     OR cardinality(v_origins) = 0
     OR p_max_assertion_ttl_seconds NOT BETWEEN 1 AND 300
     OR p_allowed_clock_skew_seconds NOT BETWEEN 0 AND 30
     OR (p_not_before_at IS NOT NULL AND p_expires_at IS NOT NULL
       AND p_expires_at <= p_not_before_at) THEN
    RAISE EXCEPTION 'invalid browser subject issuer configuration'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.secret_refs AS secret_ref
     WHERE secret_ref.workspace_id = v_workspace_id
       AND secret_ref.id = p_verification_key_ref_id
       AND secret_ref.status IN ('active', 'rotating')
  ) THEN
    RAISE EXCEPTION 'active verification key reference not found in control workspace'
      USING ERRCODE = '23503';
  END IF;

  IF array_position(v_origins, NULL) IS NOT NULL
     OR cardinality(v_origins) <> (
       SELECT count(DISTINCT origin_value)
         FROM unnest(v_origins) AS origin_rows(origin_value)
     ) THEN
    RAISE EXCEPTION 'issuer origins must be non-null and unique'
      USING ERRCODE = '22023';
  END IF;

  FOREACH v_origin IN ARRAY v_origins LOOP
    IF NOT auth.is_canonical_https_origin(v_origin) THEN
      RAISE EXCEPTION 'issuer origin is not canonical HTTPS: %', v_origin
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.browser_subject_issuer_configs (
    id,
    workspace_id,
    issuer,
    audience,
    verification_key_ref_id,
    key_version,
    allowed_origins,
    max_assertion_ttl_seconds,
    allowed_clock_skew_seconds,
    not_before_at,
    expires_at,
    status
  ) VALUES (
    p_issuer_config_id,
    v_workspace_id,
    p_issuer,
    p_audience,
    p_verification_key_ref_id,
    p_key_version,
    v_origins,
    p_max_assertion_ttl_seconds,
    p_allowed_clock_skew_seconds,
    p_not_before_at,
    p_expires_at,
    'active'
  );
  RETURN p_issuer_config_id;
END;
$function$;

CREATE FUNCTION auth.transition_browser_subject_issuer_config(
  p_issuer_config_id uuid,
  p_target_status text,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_current_status text;
  v_epoch bigint;
BEGIN
  SELECT issuer_config.status
    INTO v_current_status
    FROM public.browser_subject_issuer_configs AS issuer_config
   WHERE issuer_config.workspace_id = v_workspace_id
     AND issuer_config.id = p_issuer_config_id
   FOR UPDATE OF issuer_config;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'issuer config not found in control workspace'
      USING ERRCODE = 'P0002';
  END IF;
  IF p_target_status NOT IN ('retired', 'revoked') THEN
    RAISE EXCEPTION 'issuer config target status must be retired or revoked'
      USING ERRCODE = '22023';
  END IF;
  IF v_current_status IN ('retired', 'revoked') THEN
    IF v_current_status = p_target_status THEN
      SELECT authorization_epoch INTO v_epoch
        FROM public.browser_subject_issuer_configs
       WHERE workspace_id = v_workspace_id AND id = p_issuer_config_id;
      RETURN v_epoch;
    END IF;
    RAISE EXCEPTION 'terminal issuer config cannot transition'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.browser_subject_issuer_configs
     SET status = p_target_status,
         updated_at = clock_timestamp()
   WHERE workspace_id = v_workspace_id
     AND id = p_issuer_config_id
   RETURNING authorization_epoch INTO v_epoch;

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'issuer_config_transitioned',
    app.current_authenticated_principal_id(),
    'browser_subject_issuer',
    p_issuer_config_id,
    p_reason,
    jsonb_build_object('from_status', v_current_status, 'to_status', p_target_status)
  );
  RETURN v_epoch;
END;
$function$;

CREATE FUNCTION auth.create_permission_callback(
  p_callback_id uuid,
  p_endpoint_url text,
  p_auth_scheme text,
  p_credential_secret_ref_id uuid,
  p_timeout_ms integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
BEGIN
  IF p_callback_id IS NULL
     OR p_endpoint_url IS NULL
     OR p_endpoint_url !~ '^https://[^/?#@[:space:]]+(/[^?#]*)?$'
     OR p_auth_scheme NOT IN ('hmac', 'mtls', 'bearer', 'none')
     OR p_timeout_ms NOT BETWEEN 100 AND 2000
     OR (p_auth_scheme = 'none' AND p_credential_secret_ref_id IS NOT NULL)
     OR (p_auth_scheme <> 'none' AND p_credential_secret_ref_id IS NULL) THEN
    RAISE EXCEPTION 'invalid permission callback configuration'
      USING ERRCODE = '22023';
  END IF;

  IF p_credential_secret_ref_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.secret_refs AS secret_ref
        WHERE secret_ref.workspace_id = v_workspace_id
          AND secret_ref.id = p_credential_secret_ref_id
          AND secret_ref.status IN ('active', 'rotating')
     ) THEN
    RAISE EXCEPTION 'active callback secret reference not found in control workspace'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.permission_callbacks (
    id,
    workspace_id,
    endpoint_url,
    auth_scheme,
    credential_secret_ref_id,
    timeout_ms,
    failure_mode,
    status
  ) VALUES (
    p_callback_id,
    v_workspace_id,
    p_endpoint_url,
    p_auth_scheme,
    p_credential_secret_ref_id,
    p_timeout_ms,
    'deny',
    'active'
  );
  RETURN p_callback_id;
END;
$function$;

CREATE FUNCTION auth.transition_permission_callback(
  p_callback_id uuid,
  p_target_status text,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_current_status text;
  v_epoch bigint;
BEGIN
  SELECT callback.status
    INTO v_current_status
    FROM public.permission_callbacks AS callback
   WHERE callback.workspace_id = v_workspace_id
     AND callback.id = p_callback_id
   FOR UPDATE OF callback;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'permission callback not found in control workspace'
      USING ERRCODE = 'P0002';
  END IF;
  IF p_target_status NOT IN ('disabled', 'error') THEN
    RAISE EXCEPTION 'permission callback target status must be disabled or error'
      USING ERRCODE = '22023';
  END IF;
  IF v_current_status = p_target_status THEN
    SELECT authorization_epoch INTO v_epoch
      FROM public.permission_callbacks
     WHERE workspace_id = v_workspace_id AND id = p_callback_id;
    RETURN v_epoch;
  END IF;
  IF v_current_status = 'disabled' THEN
    RAISE EXCEPTION 'disabled permission callback cannot be reactivated or reclassified'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.permission_callbacks
     SET status = p_target_status,
         updated_at = clock_timestamp()
   WHERE workspace_id = v_workspace_id
     AND id = p_callback_id
   RETURNING authorization_epoch INTO v_epoch;

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'permission_callback_transitioned',
    app.current_authenticated_principal_id(),
    'permission_callback',
    p_callback_id,
    p_reason,
    jsonb_build_object('from_status', v_current_status, 'to_status', p_target_status)
  );
  RETURN v_epoch;
END;
$function$;

CREATE FUNCTION auth.revoke_end_user_principal(
  p_principal_id uuid,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_status text;
  v_epoch bigint;
BEGIN
  SELECT principal.status, principal.session_epoch
    INTO v_status, v_epoch
    FROM public.end_user_principals AS principal
   WHERE principal.workspace_id = v_workspace_id
     AND principal.id = p_principal_id
   FOR UPDATE OF principal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'end-user principal not found in control workspace'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'revoked' THEN
    RETURN v_epoch;
  END IF;

  UPDATE public.end_user_principals
     SET status = 'revoked',
         session_epoch = session_epoch + 1,
         revoked_at = clock_timestamp()
   WHERE workspace_id = v_workspace_id
     AND id = p_principal_id
   RETURNING session_epoch INTO v_epoch;

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'end_user_principal_revoked',
    app.current_authenticated_principal_id(),
    'end_user_principal',
    p_principal_id,
    p_reason,
    jsonb_build_object('session_epoch', v_epoch)
  );
  RETURN v_epoch;
END;
$function$;

CREATE FUNCTION auth.get_browser_subject_verifier_config(
  p_issuer_config_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  issuer_config_id uuid,
  issuer text,
  audience text,
  key_version integer,
  allowed_origins text[],
  max_assertion_ttl_seconds integer,
  allowed_clock_skew_seconds integer,
  config_not_before_at timestamptz,
  config_expires_at timestamptz,
  verification_key_provider text,
  verification_key_locator text,
  verification_key_version_hint text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_credential_id uuid := app.current_api_credential_id();
BEGIN
  IF v_workspace_id IS NULL
     OR v_credential_id IS NULL
     OR p_issuer_config_id IS NULL
     OR NOT pg_catalog.pg_has_role(
       session_user,
       'ba_subject_assertion_verifier',
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.api_credentials AS credential
      JOIN public.api_credential_scopes AS scope_row
        ON scope_row.workspace_id = credential.workspace_id
       AND scope_row.credential_id = credential.id
       AND scope_row.credential_kind = credential.credential_kind
     WHERE credential.workspace_id = v_workspace_id
       AND credential.id = v_credential_id
       AND credential.credential_kind = 'publish'
       AND credential.status IN ('active', 'overlap')
       AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
       AND credential.revoked_at IS NULL
       AND scope_row.scope = 'browser-session:exchange'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    issuer_config.workspace_id,
    issuer_config.id,
    issuer_config.issuer,
    issuer_config.audience,
    issuer_config.key_version,
    issuer_config.allowed_origins,
    issuer_config.max_assertion_ttl_seconds,
    issuer_config.allowed_clock_skew_seconds,
    issuer_config.not_before_at,
    issuer_config.expires_at,
    secret_ref.provider,
    secret_ref.opaque_locator,
    secret_ref.version_hint
  FROM public.browser_subject_issuer_configs AS issuer_config
  JOIN public.secret_refs AS secret_ref
    ON secret_ref.workspace_id = issuer_config.workspace_id
   AND secret_ref.id = issuer_config.verification_key_ref_id
  WHERE issuer_config.workspace_id = v_workspace_id
    AND issuer_config.id = p_issuer_config_id
    AND issuer_config.status = 'active'
    AND (issuer_config.not_before_at IS NULL
      OR issuer_config.not_before_at <= clock_timestamp())
    AND (issuer_config.expires_at IS NULL
      OR issuer_config.expires_at > clock_timestamp())
    AND secret_ref.status IN ('active', 'rotating');
END;
$function$;

-- The isolated adapter verifies the assertion signature against the referenced
-- secret-provider key before calling this function. The database independently
-- validates every closed claim and atomically consumes the nonce. principal_id
-- is intentionally absent from the signature and is derived from issuer+subject.
CREATE FUNCTION auth.consume_browser_subject_assertion(
  p_issuer_config_id uuid,
  p_issuer text,
  p_subject_hash bytea,
  p_audience text,
  p_canonical_origin text,
  p_key_version integer,
  p_assertion_nonce_hash bytea,
  p_assertion_issued_at timestamptz,
  p_assertion_expires_at timestamptz
)
RETURNS TABLE (
  workspace_id uuid,
  assertion_use_id uuid,
  principal_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_credential_id uuid := app.current_api_credential_id();
  v_credential_kind text;
  v_credential_origins text[];
  v_config public.browser_subject_issuer_configs%ROWTYPE;
  v_principal_id uuid;
  v_assertion_use_id uuid := public.gen_random_uuid();
  v_constraint_name text;
  v_now timestamptz := clock_timestamp();
  v_clock_skew interval;
  v_max_ttl interval;
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user,
    'ba_subject_assertion_verifier',
    'MEMBER'
  ) OR pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER') THEN
    RAISE EXCEPTION 'subject assertion consume requires the isolated verifier role'
      USING ERRCODE = '42501';
  END IF;

  IF v_workspace_id IS NULL
     OR v_credential_id IS NULL
     OR p_issuer_config_id IS NULL
     OR p_issuer IS NULL
     OR p_subject_hash IS NULL OR octet_length(p_subject_hash) <> 32
     OR p_audience IS NULL
     OR NOT auth.is_canonical_https_origin(p_canonical_origin)
     OR p_key_version IS NULL OR p_key_version <= 0
     OR p_assertion_nonce_hash IS NULL
     OR octet_length(p_assertion_nonce_hash) <> 32
     OR p_assertion_issued_at IS NULL
     OR p_assertion_expires_at IS NULL
     OR p_assertion_expires_at <= p_assertion_issued_at THEN
    RAISE EXCEPTION 'invalid subject assertion claim set'
      USING ERRCODE = '22023';
  END IF;

  SELECT credential.credential_kind, credential.allowed_origins
    INTO v_credential_kind, v_credential_origins
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = v_credential_id
     AND credential.status IN ('active', 'overlap')
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= v_now)
     AND (credential.expires_at IS NULL OR credential.expires_at > v_now)
     AND credential.revoked_at IS NULL
   FOR SHARE OF credential;

  IF NOT FOUND
     OR v_credential_kind <> 'publish'
     OR NOT p_canonical_origin = ANY (v_credential_origins)
     OR NOT EXISTS (
       SELECT 1
         FROM public.api_credential_scopes AS scope_row
        WHERE scope_row.workspace_id = v_workspace_id
          AND scope_row.credential_id = v_credential_id
          AND scope_row.credential_kind = 'publish'
          AND scope_row.scope = 'browser-session:exchange'
     ) THEN
    RAISE EXCEPTION 'current credential is not eligible for browser subject exchange'
      USING ERRCODE = '42501';
  END IF;

  SELECT issuer_config.*
    INTO v_config
    FROM public.browser_subject_issuer_configs AS issuer_config
   WHERE issuer_config.workspace_id = v_workspace_id
     AND issuer_config.id = p_issuer_config_id
   FOR SHARE OF issuer_config;

  IF NOT FOUND
     OR v_config.status <> 'active'
     OR v_config.issuer IS DISTINCT FROM p_issuer
     OR v_config.audience IS DISTINCT FROM p_audience
     OR v_config.key_version IS DISTINCT FROM p_key_version
     OR NOT p_canonical_origin = ANY (v_config.allowed_origins)
     OR (v_config.not_before_at IS NOT NULL
       AND v_config.not_before_at > v_now)
     OR (v_config.expires_at IS NOT NULL
       AND v_config.expires_at <= v_now)
     OR (v_config.not_before_at IS NOT NULL
       AND p_assertion_issued_at < v_config.not_before_at)
     OR (v_config.expires_at IS NOT NULL
       AND (
         p_assertion_issued_at >= v_config.expires_at
         OR p_assertion_expires_at > v_config.expires_at
       )) THEN
    RAISE EXCEPTION 'subject assertion issuer, audience, origin or key version rejected'
      USING ERRCODE = '42501';
  END IF;

  v_clock_skew := make_interval(secs => v_config.allowed_clock_skew_seconds);
  v_max_ttl := make_interval(secs => v_config.max_assertion_ttl_seconds);
  IF p_assertion_issued_at > v_now + v_clock_skew
     OR p_assertion_expires_at <= v_now
     OR p_assertion_expires_at > p_assertion_issued_at + v_max_ttl
     OR p_assertion_issued_at < v_now - v_max_ttl - v_clock_skew THEN
    RAISE EXCEPTION 'subject assertion time window rejected'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.end_user_principals (
    id,
    workspace_id,
    issuer_config_id,
    issuer,
    subject_hash,
    status,
    session_epoch,
    last_seen_at
  ) VALUES (
    public.gen_random_uuid(),
    v_workspace_id,
    p_issuer_config_id,
    p_issuer,
    p_subject_hash,
    'active',
    0,
    v_now
  )
  ON CONFLICT ON CONSTRAINT end_user_principals_issuer_subject_key
  DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
    WHERE public.end_user_principals.status = 'active'
  RETURNING id INTO v_principal_id;

  IF v_principal_id IS NULL THEN
    RAISE EXCEPTION 'subject maps to a revoked end-user principal'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.browser_subject_assertion_uses (
    id,
    workspace_id,
    issuer_config_id,
    principal_id,
    assertion_nonce_hash,
    subject_hash,
    audience,
    canonical_origin,
    key_version,
    assertion_issued_at,
    assertion_expires_at,
    consumed_at
  ) VALUES (
    v_assertion_use_id,
    v_workspace_id,
    p_issuer_config_id,
    v_principal_id,
    p_assertion_nonce_hash,
    p_subject_hash,
    p_audience,
    p_canonical_origin,
    p_key_version,
    p_assertion_issued_at,
    p_assertion_expires_at,
    v_now
  );

  PERFORM auth.append_authorization_audit(
    v_workspace_id,
    'subject_assertion_consumed',
    'credential:' || v_credential_id::text,
    'subject_assertion',
    v_assertion_use_id,
    NULL,
    jsonb_build_object(
      'issuer_config_id', p_issuer_config_id,
      'principal_id', 'end_user:' || v_principal_id::text,
      'audience', p_audience,
      'canonical_origin', p_canonical_origin,
      'key_version', p_key_version
    )
  );

  RETURN QUERY
  SELECT
    v_workspace_id,
    v_assertion_use_id,
    'end_user:' || v_principal_id::text;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'browser_subject_assertion_uses_nonce_key' THEN
      RAISE EXCEPTION 'subject assertion nonce was already consumed'
        USING ERRCODE = '23505', CONSTRAINT = v_constraint_name;
    END IF;
    RAISE;
END;
$function$;
ALTER FUNCTION auth.create_secret_ref(uuid, text, text, text, text, timestamptz, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.create_api_credential(
  uuid, uuid, text, text, bytea, text[], text[], timestamptz, timestamptz, uuid
) OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.add_api_credential_scope(uuid, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.transition_api_credential(uuid, text, timestamptz, uuid, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.create_browser_subject_issuer_config(
  uuid, text, text, uuid, integer, text[], integer, integer, timestamptz, timestamptz
) OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.transition_browser_subject_issuer_config(uuid, text, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.create_permission_callback(uuid, text, text, uuid, integer)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.transition_permission_callback(uuid, text, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.revoke_end_user_principal(uuid, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.get_browser_subject_verifier_config(uuid)
  OWNER TO ba_auth_owner;
ALTER FUNCTION auth.consume_browser_subject_assertion(
  uuid, text, bytea, text, text, integer, bytea, timestamptz, timestamptz
) OWNER TO ba_auth_owner;

REVOKE ALL ON FUNCTION auth.create_secret_ref(uuid, text, text, text, text, timestamptz, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.create_api_credential(
  uuid, uuid, text, text, bytea, text[], text[], timestamptz, timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.add_api_credential_scope(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.transition_api_credential(uuid, text, timestamptz, uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.create_browser_subject_issuer_config(
  uuid, text, text, uuid, integer, text[], integer, integer, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.transition_browser_subject_issuer_config(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.create_permission_callback(uuid, text, text, uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.transition_permission_callback(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.revoke_end_user_principal(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.get_browser_subject_verifier_config(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.consume_browser_subject_assertion(
  uuid, text, bytea, text, text, integer, bytea, timestamptz, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.create_secret_ref(
  uuid, text, text, text, text, timestamptz, jsonb
) TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.create_api_credential(
  uuid, uuid, text, text, bytea, text[], text[], timestamptz, timestamptz, uuid
) TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.add_api_credential_scope(uuid, text)
  TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.transition_api_credential(
  uuid, text, timestamptz, uuid, text
) TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.create_browser_subject_issuer_config(
  uuid, text, text, uuid, integer, text[], integer, integer, timestamptz, timestamptz
) TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.transition_browser_subject_issuer_config(uuid, text, text)
  TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.create_permission_callback(uuid, text, text, uuid, integer)
  TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.transition_permission_callback(uuid, text, text)
  TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.revoke_end_user_principal(uuid, text)
  TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.get_browser_subject_verifier_config(uuid)
  TO ba_subject_assertion_verifier;
GRANT EXECUTE ON FUNCTION auth.consume_browser_subject_assertion(
  uuid, text, bytea, text, text, integer, bytea, timestamptz, timestamptz
) TO ba_subject_assertion_verifier;

-- Every G0-04 tenant table has a direct workspace key (the workspace root uses
-- id itself), and both ENABLE and FORCE RLS. No application role owns a table.
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant_isolation ON public.workspaces
  FOR ALL
  USING (id = app.current_workspace_id())
  WITH CHECK (id = app.current_workspace_id());

ALTER TABLE public.role_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY role_configs_tenant_isolation ON public.role_configs
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_tenant_isolation ON public.workspace_members
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY workspace_members_control_context_owner_read
  ON public.workspace_members
  FOR SELECT TO ba_auth_owner
  USING (true);

ALTER TABLE public.secret_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.secret_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY secret_refs_tenant_isolation ON public.secret_refs
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY api_credentials_tenant_isolation ON public.api_credentials
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.api_credential_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_credential_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY api_credential_scopes_tenant_isolation
  ON public.api_credential_scopes
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.permission_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_callbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY permission_callbacks_tenant_isolation ON public.permission_callbacks
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.browser_subject_issuer_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.browser_subject_issuer_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_subject_issuer_configs_tenant_isolation
  ON public.browser_subject_issuer_configs
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.end_user_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.end_user_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY end_user_principals_tenant_isolation ON public.end_user_principals
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.browser_subject_assertion_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.browser_subject_assertion_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_subject_assertion_uses_tenant_isolation
  ON public.browser_subject_assertion_uses
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE public.authorization_cache_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorization_cache_invalidations FORCE ROW LEVEL SECURITY;
CREATE POLICY authorization_cache_invalidations_tenant_isolation
  ON public.authorization_cache_invalidations
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

REVOKE ALL ON TABLE
  public.workspaces,
  public.role_configs,
  public.workspace_members,
  public.secret_refs,
  public.api_credentials,
  public.api_credential_scopes,
  public.permission_callbacks,
  public.browser_subject_issuer_configs,
  public.end_user_principals,
  public.browser_subject_assertion_uses,
  public.authorization_cache_invalidations
FROM
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_auth_owner;

-- Auth-owner functions get only the columns/operations needed to authenticate,
-- revalidate signed context and atomically consume a verified subject assertion.
GRANT SELECT (id, authorization_epoch)
  ON TABLE public.workspaces TO ba_auth_owner;
GRANT SELECT (workspace_id, user_id, role)
  ON TABLE public.workspace_members TO ba_auth_owner;
GRANT SELECT (
  id, workspace_id, key_id, key_hint, credential_kind, status,
  not_before_at, expires_at, revoked_at, authorization_epoch,
  rotation_group, allowed_origins, created_at, last_used_at
), UPDATE (last_used_at)
  ON TABLE public.api_credentials TO ba_auth_owner;
GRANT SELECT ON TABLE public.api_credential_scopes TO ba_auth_owner;
GRANT SELECT, UPDATE (status)
  ON TABLE public.browser_subject_issuer_configs TO ba_auth_owner;
GRANT SELECT ON TABLE public.secret_refs TO ba_auth_owner;
GRANT SELECT, INSERT, UPDATE (last_seen_at)
  ON TABLE public.end_user_principals TO ba_auth_owner;
GRANT INSERT ON TABLE public.browser_subject_assertion_uses TO ba_auth_owner;

-- Runtime can read only non-secret authorization metadata after successful
-- authentication. In particular, SELECT * and verifier-column reads fail.
GRANT SELECT (id, name, plan, authorization_epoch, expire_at)
  ON TABLE public.workspaces TO ba_runtime, ba_control_executor;
GRANT SELECT (
  id, workspace_id, key_id, key_hint, credential_kind, status,
  not_before_at, expires_at, revoked_at, authorization_epoch,
  rotation_group, allowed_origins, created_at, last_used_at
) ON TABLE public.api_credentials TO ba_runtime, ba_control_executor;
GRANT SELECT ON TABLE public.api_credential_scopes
  TO ba_runtime, ba_control_executor;
GRANT SELECT (
  id, workspace_id, endpoint_url, auth_scheme, credential_secret_ref_id,
  timeout_ms, failure_mode, status, authorization_epoch, created_at, updated_at
) ON TABLE public.permission_callbacks TO ba_runtime, ba_control_executor;
GRANT SELECT (id, workspace_id, name, permissions, created_at, updated_at)
  ON TABLE public.role_configs TO ba_control_executor;
GRANT SELECT (workspace_id, user_id, role, role_config_id, created_at, updated_at)
  ON TABLE public.workspace_members TO ba_control_executor;
GRANT SELECT (
  id, workspace_id, provider, opaque_locator, version_hint, purpose,
  status, rotation_due_at, metadata_redacted, created_at, updated_at
) ON TABLE public.secret_refs TO ba_control_executor;
GRANT SELECT (
  id, workspace_id, issuer, audience, verification_key_ref_id, key_version,
  allowed_origins, max_assertion_ttl_seconds, allowed_clock_skew_seconds,
  not_before_at, expires_at, status, authorization_epoch, created_at, updated_at
) ON TABLE public.browser_subject_issuer_configs TO ba_control_executor;
GRANT SELECT (
  id, workspace_id, issuer_config_id, issuer, status, session_epoch,
  created_at, last_seen_at, revoked_at
) ON TABLE public.end_user_principals TO ba_control_executor;
GRANT SELECT ON TABLE public.authorization_cache_invalidations
  TO ba_runtime, ba_control_executor;

REVOKE SELECT (secret_verifier_hmac, verifier_algorithm)
  ON TABLE public.api_credentials
  FROM
    ba_runtime,
    ba_control_executor,
    ba_management_attestation_issuer,
    ba_subject_assertion_verifier;
REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.workspaces,
  public.role_configs,
  public.workspace_members,
  public.secret_refs,
  public.api_credentials,
  public.api_credential_scopes,
  public.permission_callbacks,
  public.browser_subject_issuer_configs,
  public.end_user_principals,
  public.browser_subject_assertion_uses,
  public.authorization_cache_invalidations
FROM
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier;

GRANT USAGE ON SCHEMA app, auth TO
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_authorization_owner;

COMMENT ON FUNCTION auth.consume_browser_subject_assertion(
  uuid, text, bytea, text, text, integer, bytea, timestamptz, timestamptz
) IS
  'Verifier-role-only, atomic assertion consumer. It accepts no principal_id and validates the authenticated publish credential, exchange-only scope, issuer, audience, canonical origin, time window, key version, subject hash and one-use nonce.';
COMMENT ON FUNCTION app.current_workspace_id() IS
  'Returns a signed transaction- and session_user-bound credential/control workspace, or NULL. Caller-written Workspace headers/GUCs are never authoritative.';
COMMENT ON TABLE auth.authorization_audit_events IS
  'Append-only, redacted authentication/authorization audit. Executable roles have no direct table access.';

REVOKE CREATE ON SCHEMA auth FROM ba_authorization_owner;

-- G0-05 owns browser session facts and typed Agent/Flow Deployment grants.
-- G0-07 owns internal service attestations and phase executor roles. Neither is
-- emulated by this migration, so later gates cannot pass against mock authority.
