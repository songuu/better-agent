-- DESIGN FREEZE DRAFT — NOT EXECUTED.
-- PostgreSQL 16 schema proposal. Review and split into the repository migration
-- framework before applying to any environment.
--
-- Security invariants:
--   1. Every tenant-owned row has a direct, non-null workspace_id.
--   2. A verified runtime credential or a trusted management-session
--      attestation establishes a transaction-local signed tenant context; RLS
--      never trusts a caller-supplied workspace header or GUC alone.
--   3. Runtime roles must not have BYPASSRLS and must not use a table-owner role.
--   4. This file stores credential verifiers or secret references only, never a
--      raw API key, bearer token, webhook secret, or callback secret.
--   5. Browser end-user exchange/session tables are a required G0-04 follow-up;
--      until that migration extends the signed context and principal helper,
--      this draft does not authorize public browser Chat by accepting SDK user.id.
--
-- ROLE PRECONDITIONS (provisioned by the DBA/deployment control plane, not by
-- an application migration):
--   * ba_runtime: NOLOGIN group granted to API/worker login roles. It is
--     NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS.
--   * ba_auth_owner: NOLOGIN owner of auth SECURITY DEFINER functions and the
--     auth projection. It has no login path and is not granted to ba_runtime.
--   * ba_admission_owner / ba_metering_owner / ba_finalizer_owner,
--     ba_billing_owner / ba_retention / ba_authorization_owner: mutually
--     non-inheriting NOLOGIN function-owner roles introduced by later design
--     migrations. None is a runtime login role. ba_authorization_owner owns
--     only the narrowly scoped epoch/mutation functions below.
--   * ba_admission_executor / ba_metering_executor / ba_finalizer_executor:
--     mutually non-inheriting, NOBYPASSRLS service roles. Each receives only
--     its phase-specific function EXECUTE grants; none inherits ba_runtime or
--     any NOLOGIN owner role.
--   * ba_reconciliation_owner / ba_reconciliation_executor: isolated NOLOGIN
--     owner and non-inheriting executor for evidence-backed billing correction;
--     neither inherits runtime/finalizer privileges.
--   * ba_control_executor: dedicated management API role. It receives EXECUTE
--     on approved mutation/context-establishment functions, never broad table
--     UPDATE/DELETE grants. It is not a runtime API credential role.
--   * ba_management_attestation_issuer: the isolated management identity
--     gateway role. Only its reviewed adapter may turn an already verified
--     IdP/local management session into a short-lived DB attestation; it has
--     EXECUTE on the two attestation lifecycle functions and no table DML.
--   * ba_internal_service_attestation_issuer: isolated control-plane issuer for
--     short-lived, phase-bound internal service attestations. It is not any API
--     credential/runtime role and has no tenant-table DML.
--   * ba_retention_executor: dedicated scheduler role with EXECUTE only on the
--     retention procedure; it has no direct table DML privileges.
--   * ba_archive_evidence_owner: NOLOGIN owner of the narrow archive-evidence
--     registration function. ba_archive_evidence_executor is the isolated,
--     trusted archive verifier/approval adapter and receives EXECUTE only; it
--     is never granted retention purge functions or direct table DML.
--   * Migration/table-owner roles must not be used by the application.
--   * The DBA revokes CREATE on schema public from PUBLIC before relying on any
--     SECURITY DEFINER function below, and pgcrypto is installed by a reviewed
--     extension migration so public.hmac(bytea, bytea, text) is available.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- app.current_workspace_id() is defined after the restricted auth projection.
-- It returns NULL unless auth.authenticate_api_credential() (external runtime),
-- auth.establish_control_workspace_context() (trusted management control plane),
-- or auth.establish_internal_service_workspace_context() (one isolated internal
-- phase) established a valid signed context in this transaction. A client-set
-- app.workspace_id is ignored.

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  plan text,
  credits_balance bigint NOT NULL DEFAULT 0 CHECK (credits_balance >= 0),
  credits_reserved_balance bigint NOT NULL DEFAULT 0
    CHECK (credits_reserved_balance >= 0),
  credits_balance_version bigint NOT NULL DEFAULT 0
    CHECK (credits_balance_version >= 0),
  authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  expire_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE workspaces IS
  'Tenant root. id is the workspace_id used by all tenant-owned tables.';
COMMENT ON COLUMN workspaces.credits_balance IS
  'Currently spendable credits. Reserve moves value from this field to credits_reserved_balance.';
COMMENT ON COLUMN workspaces.credits_reserved_balance IS
  'Credits held by active run reservations; only 004 billing procedures may change it.';
COMMENT ON COLUMN workspaces.credits_balance_version IS
  'Monotonic optimistic/audit version incremented by every reserve, settle, release or adjustment.';
COMMENT ON COLUMN workspaces.authorization_epoch IS
  'Authoritative workspace-level authorization epoch. Authorization-relevant changes increment it atomically.';

CREATE TABLE role_configs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_configs_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT role_configs_workspace_name_key UNIQUE (workspace_id, name)
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL,
  role text NOT NULL
    CHECK (role IN ('admin', 'developer', 'user', 'viewer')),
  role_config_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_role_config_fkey
    FOREIGN KEY (workspace_id, role_config_id)
    REFERENCES role_configs(workspace_id, id)
);

CREATE TABLE secret_refs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider text NOT NULL
    CHECK (provider IN ('env', 'vault', 'k8s_secret', 'offline_bundle')),
  locator text NOT NULL,
  version_hint text,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotating', 'revoked', 'expired')),
  rotation_due_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT secret_refs_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT secret_refs_workspace_provider_locator_key
    UNIQUE (workspace_id, provider, locator)
);

COMMENT ON TABLE secret_refs IS
  'Reference to deployment-managed secret material. locator is a provider reference, never secret content.';

CREATE TABLE api_credentials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  key_id uuid NOT NULL UNIQUE,
  key_hint text NOT NULL,
  credential_kind text NOT NULL
    CHECK (credential_kind IN (
      'service_api',
      'publish',
      'webhook',
      'mcp',
      'permission_callback'
    )),
  secret_verifier_hmac bytea NOT NULL,
  verifier_algorithm text NOT NULL DEFAULT 'hmac-sha-256'
    CHECK (verifier_algorithm = 'hmac-sha-256'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'overlap', 'revoked', 'expired')),
  not_before_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  rotation_group uuid,
  allowed_origins text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT api_credentials_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT api_credentials_workspace_id_id_kind_key
    UNIQUE (workspace_id, id, credential_kind),
  CONSTRAINT api_credentials_hmac_length_check
    CHECK (octet_length(secret_verifier_hmac) = 32),
  CONSTRAINT api_credentials_lifecycle_shape CHECK (
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

COMMENT ON COLUMN api_credentials.secret_verifier_hmac IS
  'Bearer-equivalent at the database trust boundary: HMAC-SHA-256 verifier of a high-entropy raw secret using a deployment-held pepper. Only the private auth projection/function owner may read it; runtime/control/application roles receive safe-column grants that exclude this column.';
COMMENT ON COLUMN api_credentials.authorization_epoch IS
  'Authoritative credential/grant epoch. Rotation, revocation and scope/grant changes increment it atomically.';

-- Authentication happens before an RLS tenant context exists. The auth
-- projection is deliberately minimal and cannot be queried by ba_runtime.
-- It contains only what is necessary to verify a credential and establish a
-- context: public key selector, tenant/credential identity, state/time window,
-- kind, and a one-way verifier. It contains no raw secret, scope grant,
-- resource grant, secret reference, profile, or user data.
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ba_auth_owner;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO
  ba_runtime,
  ba_admission_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reconciliation_executor;

-- PostgreSQL's ordinary bytea/text equality operators are not a verifier
-- comparison contract. This fixed-length primitive always visits all 32 bytes
-- and accumulates their XOR before deciding. It is private to ba_auth_owner;
-- callers receive only the higher-level authentication functions below.
CREATE OR REPLACE FUNCTION auth.constant_time_equal_32(
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

COMMENT ON FUNCTION auth.constant_time_equal_32(bytea, bytea) IS
  'Private fixed-length verifier/signature comparison. Migration verification must inspect the deployed definition and run equal/first-byte/last-byte timing distributions; ordinary bytea/text equality is not an accepted substitute.';

CREATE TABLE auth.credential_auth_index (
  key_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL,
  credential_kind text NOT NULL
    CHECK (credential_kind IN (
      'service_api',
      'publish',
      'webhook',
      'mcp',
      'permission_callback'
    )),
  secret_verifier_hmac bytea NOT NULL
    CHECK (octet_length(secret_verifier_hmac) = 32),
  status text NOT NULL
    CHECK (status IN ('active', 'overlap', 'revoked', 'expired')),
  not_before_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  rotation_group uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_auth_index_workspace_credential_key
    UNIQUE (workspace_id, credential_id),
  CONSTRAINT credential_auth_index_credential_fkey
    FOREIGN KEY (workspace_id, credential_id)
    REFERENCES api_credentials(workspace_id, id)
    ON DELETE CASCADE,
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

ALTER TABLE auth.credential_auth_index OWNER TO ba_auth_owner;
REVOKE ALL ON TABLE auth.credential_auth_index FROM PUBLIC;
REVOKE ALL ON TABLE auth.credential_auth_index FROM
  ba_runtime,
  ba_admission_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reconciliation_executor,
  ba_admission_owner,
  ba_metering_owner,
  ba_finalizer_owner,
  ba_reconciliation_owner;

-- FORCE RLS also applies to the auth owner. The only permissive policy is for
-- the NOLOGIN function owner; ba_runtime gets function EXECUTE, never SELECT.
ALTER TABLE auth.credential_auth_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.credential_auth_index FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_auth_index_owner_only ON auth.credential_auth_index
  FOR ALL TO ba_auth_owner
  USING (true)
  WITH CHECK (true);

-- Control-plane authentication is intentionally separate from API credentials.
-- A trusted management identity gateway writes one short-lived attestation only
-- after it has authenticated the human/service management session. The stored
-- verifier is a one-way, server-side derived value; neither an IdP token nor a
-- browser/session cookie is persisted here. ba_control_executor can establish
-- a context from an active attestation but cannot create, inspect, extend or
-- revoke one by raw table DML.
CREATE TABLE auth.control_session_attestations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  principal_id uuid NOT NULL,
  bound_session_user name NOT NULL,
  issuer text NOT NULL CHECK (length(issuer) > 0),
  issuer_subject_hash bytea NOT NULL
    CHECK (octet_length(issuer_subject_hash) = 32),
  attestation_verifier_hmac bytea NOT NULL
    CHECK (octet_length(attestation_verifier_hmac) = 32),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT control_session_attestations_expiry_check
    CHECK (expires_at > issued_at),
  CONSTRAINT control_session_attestations_revocation_check
    CHECK (
      (revoked_at IS NULL AND revoked_reason IS NULL)
      OR revoked_at IS NOT NULL
    )
);

ALTER TABLE auth.control_session_attestations OWNER TO ba_auth_owner;
REVOKE ALL ON TABLE auth.control_session_attestations FROM PUBLIC;
REVOKE ALL ON TABLE auth.control_session_attestations
  FROM ba_runtime, ba_control_executor, ba_management_attestation_issuer;

ALTER TABLE auth.control_session_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.control_session_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY control_session_attestations_owner_only
  ON auth.control_session_attestations
  FOR ALL TO ba_auth_owner
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE auth.control_session_attestations IS
  'Pre-RLS management-session attestations. Only the trusted issuer lifecycle functions write rows; control executors receive no table DML.';
COMMENT ON COLUMN auth.control_session_attestations.attestation_verifier_hmac IS
  'Server-side derived verifier for an already authenticated management session; raw IdP/session material is never stored or returned.';

-- Internal execution phases do not authenticate with customer-facing API,
-- publish, webhook, MCP or permission-callback credentials. The deployment
-- control plane issues a short-lived attestation bound to one workspace, one
-- database session_user and exactly one phase. It is not an API principal and
-- therefore cannot call principal-scoped Run endpoints.
CREATE TABLE auth.internal_service_attestations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  service_phase text NOT NULL CHECK (
    service_phase IN ('admission', 'metering', 'finalizer', 'reconciliation')
  ),
  bound_session_user name NOT NULL,
  issuer text NOT NULL CHECK (length(issuer) > 0),
  attestation_verifier_hmac bytea NOT NULL
    CHECK (octet_length(attestation_verifier_hmac) = 32),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT internal_service_attestations_expiry_check CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + interval '15 minutes'
  ),
  CONSTRAINT internal_service_attestations_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR revoked_at IS NOT NULL
  )
);

ALTER TABLE auth.internal_service_attestations OWNER TO ba_auth_owner;
REVOKE ALL ON TABLE auth.internal_service_attestations FROM PUBLIC;
REVOKE ALL ON TABLE auth.internal_service_attestations FROM
  ba_runtime,
  ba_control_executor,
  ba_admission_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reconciliation_executor,
  ba_internal_service_attestation_issuer;
ALTER TABLE auth.internal_service_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.internal_service_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY internal_service_attestations_owner_only
  ON auth.internal_service_attestations
  FOR ALL TO ba_auth_owner
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE auth.internal_service_attestations IS
  'Pre-RLS, short-lived and phase-bound internal service proof. It is never derived from or interchangeable with an external api_credentials row.';

CREATE OR REPLACE FUNCTION auth.sync_credential_auth_index()
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
    now()
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
ON api_credentials
FOR EACH ROW
EXECUTE FUNCTION auth.sync_credential_auth_index();

-- The management identity gateway calls this only after validating an IdP/SAML
-- or local management session. The input verifier and subject hash are
-- server-side derived values, not browser-supplied claims. The issuer role is
-- intentionally outside the runtime and control-executor roles.
CREATE OR REPLACE FUNCTION auth.issue_control_session_attestation(
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
BEGIN
  IF p_attestation_id IS NULL
     OR p_workspace_id IS NULL
     OR p_principal_id IS NULL
     OR p_bound_session_user IS NULL
     OR p_issuer IS NULL OR length(p_issuer) = 0
     OR p_issuer_subject_hash IS NULL OR octet_length(p_issuer_subject_hash) <> 32
     OR p_attestation_verifier_hmac IS NULL OR octet_length(p_attestation_verifier_hmac) <> 32
     OR p_expires_at IS NULL OR p_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'invalid control-session attestation input'
      USING ERRCODE = '22023';
  END IF;

  -- Do not mint an attestation for a principal that lacks a present control
  -- role. FOR SHARE keeps a concurrent membership-role downgrade/delete from
  -- racing the issuance transaction.
  SELECT member.role
    INTO v_member_role
    FROM public.workspace_members AS member
   WHERE member.workspace_id = p_workspace_id
     AND member.user_id = p_principal_id
     AND member.role IN ('admin', 'developer')
   FOR SHARE OF member;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'principal is not an active control-plane member of workspace'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO auth.control_session_attestations (
    id, workspace_id, principal_id, bound_session_user, issuer,
    issuer_subject_hash, attestation_verifier_hmac, expires_at
  ) VALUES (
    p_attestation_id, p_workspace_id, p_principal_id, p_bound_session_user,
    p_issuer, p_issuer_subject_hash, p_attestation_verifier_hmac, p_expires_at
  );
EXCEPTION
  WHEN unique_violation THEN
    -- An attestation identifier is single-use. Reusing it must never mutate an
    -- earlier principal/workspace binding or extend its lifetime.
    RAISE EXCEPTION 'control-session attestation id already exists'
      USING ERRCODE = '23505';
END;
$function$;

CREATE OR REPLACE FUNCTION auth.revoke_control_session_attestation(
  p_attestation_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF p_attestation_id IS NULL THEN
    RAISE EXCEPTION 'control-session attestation id is required'
      USING ERRCODE = '22023';
  END IF;

  UPDATE auth.control_session_attestations
     SET revoked_at = clock_timestamp(),
         revoked_reason = NULLIF(left(COALESCE(p_reason, ''), 512), '')
   WHERE id = p_attestation_id
     AND revoked_at IS NULL;

  IF NOT FOUND THEN
    -- Revocation is idempotent for a known attestation, but a fabricated id is
    -- still an error for the trusted issuer to investigate.
    PERFORM 1
      FROM auth.control_session_attestations
     WHERE id = p_attestation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'control-session attestation not found'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;
END;
$function$;

-- This is the only control-plane pre-RLS context establisher. It deliberately
-- accepts no workspace id: the workspace, management principal and DB
-- session-user binding all come from the active trusted attestation. The
-- presented verifier is supplied by the authenticated management gateway over
-- its server-to-database channel, never copied from a client Workspace GUC.
CREATE OR REPLACE FUNCTION auth.establish_control_workspace_context(
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
  v_verifier_matches boolean;
  v_member_role text;
  v_txid bigint;
  v_context_signature text;
BEGIN
  -- Never inherit a runtime or previous control proof inside this transaction.
  PERFORM set_config('app.tenant_context', '', true);

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

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Keep verifier comparison out of a WHERE equality predicate. The verifier
  -- is bearer-equivalent even though it is server-derived.
  v_verifier_matches := auth.constant_time_equal_32(
    v_attestation_verifier_hmac,
    p_presented_verifier
  );
  IF NOT v_verifier_matches
     OR v_bound_session_user IS DISTINCT FROM session_user::name
     OR v_revoked_at IS NOT NULL
     OR v_expires_at <= clock_timestamp() THEN
    RETURN NULL;
  END IF;

  -- Membership is checked again at use time, not merely when the IdP session
  -- was authenticated. This row lock serializes an in-flight control action
  -- with membership revocation or a role downgrade.
  SELECT member.role
    INTO v_member_role
    FROM public.workspace_members AS member
   WHERE member.workspace_id = v_workspace_id
     AND member.user_id = v_principal_id
     AND member.role IN ('admin', 'developer')
   FOR SHARE OF member;
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

  RETURN v_workspace_id;
END;
$function$;

CREATE OR REPLACE FUNCTION auth.issue_internal_service_attestation(
  p_attestation_id uuid,
  p_workspace_id uuid,
  p_service_phase text,
  p_bound_session_user name,
  p_issuer text,
  p_attestation_verifier_hmac bytea,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
DECLARE
  v_required_role name;
BEGIN
  v_required_role := CASE p_service_phase
    WHEN 'admission' THEN 'ba_admission_executor'::name
    WHEN 'metering' THEN 'ba_metering_executor'::name
    WHEN 'finalizer' THEN 'ba_finalizer_executor'::name
    WHEN 'reconciliation' THEN 'ba_reconciliation_executor'::name
    ELSE NULL
  END;
  IF p_attestation_id IS NULL
     OR p_workspace_id IS NULL
     OR v_required_role IS NULL
     OR p_bound_session_user IS NULL
     OR p_issuer IS NULL OR length(p_issuer) = 0
     OR p_attestation_verifier_hmac IS NULL
     OR octet_length(p_attestation_verifier_hmac) <> 32
     OR p_expires_at IS NULL
     OR p_expires_at <= clock_timestamp()
     OR p_expires_at > clock_timestamp() + interval '15 minutes'
     OR NOT pg_catalog.pg_has_role(p_bound_session_user, v_required_role, 'MEMBER') THEN
    RAISE EXCEPTION 'invalid or phase-role-mismatched internal service attestation'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO auth.internal_service_attestations (
    id, workspace_id, service_phase, bound_session_user, issuer,
    attestation_verifier_hmac, expires_at
  ) VALUES (
    p_attestation_id, p_workspace_id, p_service_phase, p_bound_session_user,
    p_issuer, p_attestation_verifier_hmac, p_expires_at
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'internal service attestation id already exists'
      USING ERRCODE = '23505';
END;
$function$;

CREATE OR REPLACE FUNCTION auth.revoke_internal_service_attestation(
  p_attestation_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  UPDATE auth.internal_service_attestations
     SET revoked_at = clock_timestamp(),
         revoked_reason = NULLIF(left(COALESCE(p_reason, ''), 512), '')
   WHERE id = p_attestation_id
     AND revoked_at IS NULL;
  IF NOT FOUND THEN
    PERFORM 1 FROM auth.internal_service_attestations WHERE id = p_attestation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'internal service attestation not found'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION auth.establish_internal_service_workspace_context(
  p_attestation_id uuid,
  p_presented_verifier bytea,
  p_expected_phase text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_service_phase text;
  v_bound_session_user name;
  v_verifier bytea;
  v_expires_at timestamptz;
  v_revoked_at timestamptz;
  v_required_role name;
  v_txid bigint;
  v_signature text;
BEGIN
  PERFORM set_config('app.tenant_context', '', true);
  IF p_attestation_id IS NULL
     OR p_presented_verifier IS NULL
     OR octet_length(p_presented_verifier) <> 32 THEN
    RETURN NULL;
  END IF;

  SELECT att.workspace_id, att.service_phase, att.bound_session_user,
         att.attestation_verifier_hmac, att.expires_at, att.revoked_at
    INTO v_workspace_id, v_service_phase, v_bound_session_user,
         v_verifier, v_expires_at, v_revoked_at
    FROM auth.internal_service_attestations AS att
   WHERE att.id = p_attestation_id
   FOR SHARE OF att;
  IF NOT FOUND
     OR v_service_phase IS DISTINCT FROM p_expected_phase
     OR v_bound_session_user IS DISTINCT FROM session_user::name
     OR v_revoked_at IS NOT NULL
     OR v_expires_at <= clock_timestamp()
     OR NOT auth.constant_time_equal_32(v_verifier, p_presented_verifier) THEN
    RETURN NULL;
  END IF;

  v_required_role := CASE v_service_phase
    WHEN 'admission' THEN 'ba_admission_executor'::name
    WHEN 'metering' THEN 'ba_metering_executor'::name
    WHEN 'finalizer' THEN 'ba_finalizer_executor'::name
    WHEN 'reconciliation' THEN 'ba_reconciliation_executor'::name
    ELSE NULL
  END;
  IF v_required_role IS NULL
     OR NOT pg_catalog.pg_has_role(session_user, v_required_role, 'MEMBER') THEN
    RETURN NULL;
  END IF;

  v_txid := txid_current();
  v_signature := encode(
    public.hmac(
      convert_to(
        format(
          'service:%s:%s:%s:%s:%s',
          v_workspace_id, p_attestation_id, v_service_phase, v_txid, session_user
        ),
        'UTF8'
      ),
      v_verifier,
      'sha256'
    ),
    'hex'
  );
  PERFORM set_config(
    'app.tenant_context',
    format(
      'service:%s:%s:%s:%s:%s',
      v_workspace_id, p_attestation_id, v_service_phase, v_txid, v_signature
    ),
    true
  );
  RETURN v_workspace_id;
END;
$function$;

ALTER FUNCTION auth.issue_control_session_attestation(
  uuid, uuid, uuid, name, text, bytea, bytea, timestamptz
) OWNER TO ba_auth_owner;
ALTER FUNCTION auth.revoke_control_session_attestation(uuid, text)
  OWNER TO ba_auth_owner;
ALTER FUNCTION auth.establish_control_workspace_context(uuid, bytea)
  OWNER TO ba_auth_owner;
ALTER FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, text, name, text, bytea, timestamptz
) OWNER TO ba_auth_owner;
ALTER FUNCTION auth.revoke_internal_service_attestation(uuid, text)
  OWNER TO ba_auth_owner;
ALTER FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text)
  OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.issue_control_session_attestation(
  uuid, uuid, uuid, name, text, bytea, bytea, timestamptz
) FROM PUBLIC, ba_runtime, ba_control_executor;
REVOKE ALL ON FUNCTION auth.revoke_control_session_attestation(uuid, text)
  FROM PUBLIC, ba_runtime, ba_control_executor;
REVOKE ALL ON FUNCTION auth.establish_control_workspace_context(uuid, bytea)
  FROM PUBLIC, ba_runtime, ba_management_attestation_issuer;
REVOKE ALL ON FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, text, name, text, bytea, timestamptz
) FROM PUBLIC, ba_runtime, ba_control_executor,
       ba_admission_executor, ba_metering_executor, ba_finalizer_executor,
       ba_reconciliation_executor;
REVOKE ALL ON FUNCTION auth.revoke_internal_service_attestation(uuid, text)
  FROM PUBLIC, ba_runtime, ba_control_executor,
       ba_admission_executor, ba_metering_executor, ba_finalizer_executor,
       ba_reconciliation_executor;
REVOKE ALL ON FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text)
  FROM PUBLIC, ba_runtime, ba_control_executor, ba_management_attestation_issuer,
       ba_internal_service_attestation_issuer;
GRANT USAGE ON SCHEMA auth TO
  ba_management_attestation_issuer,
  ba_internal_service_attestation_issuer,
  ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.issue_control_session_attestation(
  uuid, uuid, uuid, name, text, bytea, bytea, timestamptz
) TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.revoke_control_session_attestation(uuid, text)
  TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.establish_control_workspace_context(uuid, bytea)
  TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, text, name, text, bytea, timestamptz
) TO ba_internal_service_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.revoke_internal_service_attestation(uuid, text)
  TO ba_internal_service_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text)
  TO ba_admission_executor, ba_metering_executor, ba_finalizer_executor,
     ba_reconciliation_executor;

-- The client/gateway computes p_presented_verifier from the raw credential with
-- the deployment-held pepper before this call. The raw value is neither passed
-- to PostgreSQL nor returned from this function. p_presented_verifier is itself
-- bearer-equivalent: the driver MUST use a binary bind parameter and MUST mark
-- it never-log. Production admission fails closed unless PostgreSQL
-- log_parameter_max_length=0 and log_parameter_max_length_on_error=0, and the
-- pooler/APM/error recorder has an equivalent parameter-redaction rule. Invalid
-- key id, verifier, status and time-window all return the same empty result.
CREATE OR REPLACE FUNCTION auth.authenticate_api_credential(
  p_key_id uuid,
  p_presented_verifier bytea
)
RETURNS TABLE (
  workspace_id uuid,
  credential_id uuid,
  credential_kind text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
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
  v_verifier_matches boolean;
  v_txid bigint;
  v_context_signature text;
BEGIN
  -- Never inherit a previous auth attempt's context inside the same transaction.
  PERFORM set_config('app.tenant_context', '', true);

  IF p_key_id IS NULL OR octet_length(p_presented_verifier) <> 32 THEN
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

  v_verifier_matches := auth.constant_time_equal_32(
    v_secret_verifier_hmac,
    p_presented_verifier
  );
  IF NOT v_verifier_matches
     OR v_status NOT IN ('active', 'overlap')
     OR (v_status = 'overlap' AND (v_expires_at IS NULL OR v_rotation_group IS NULL))
     OR (v_not_before_at IS NOT NULL AND v_not_before_at > clock_timestamp())
     OR (v_expires_at IS NOT NULL AND v_expires_at <= clock_timestamp())
     OR v_revoked_at IS NOT NULL THEN
    RETURN;
  END IF;

  -- A caller can set arbitrary custom GUCs, so the RLS helper validates this
  -- proof against the selected credential, session user and current transaction.
  v_txid := txid_current();
  v_context_signature := encode(
    public.hmac(
      convert_to(
        format('%s:%s:%s:%s', v_workspace_id, v_credential_id, v_txid, session_user),
        'UTF8'
      ),
      v_secret_verifier_hmac,
      'sha256'
    ),
    'hex'
  );
  PERFORM set_config(
    'app.tenant_context',
    format('%s:%s:%s:%s', v_workspace_id, v_credential_id, v_txid, v_context_signature),
    true
  );

  RETURN QUERY
  SELECT v_workspace_id, v_credential_id, v_credential_kind;
END;
$function$;

ALTER FUNCTION auth.authenticate_api_credential(uuid, bytea) OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION auth.authenticate_api_credential(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.authenticate_api_credential(uuid, bytea)
  FROM ba_control_executor,
       ba_admission_executor,
       ba_metering_executor,
       ba_finalizer_executor,
       ba_reconciliation_executor;
GRANT EXECUTE ON FUNCTION auth.authenticate_api_credential(uuid, bytea) TO
  ba_runtime;

-- This helper is used only by RLS policies and application functions. It
-- accepts exactly three signed shapes: the four-part external runtime credential
-- context, the six-part `control` attestation context, and the six-part
-- phase-bound `service` attestation context. It returns NULL (therefore
-- deny-by-default) on absent, malformed, expired, revoked, wrong-phase,
-- cross-session, cross-principal or cross-transaction context. It ignores the
-- legacy app.workspace_id setting entirely.
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
  v_service_phase text;
  v_required_role name;
  v_txid bigint;
  v_signature text;
  v_expected_signature text;
BEGIN
  IF v_context IS NULL OR v_context = '' THEN
    RETURN NULL;
  END IF;

  v_context_parts := string_to_array(v_context, ':');

  IF array_length(v_context_parts, 1) = 6
     AND v_context_parts[1] = 'service' THEN
    v_workspace_id := v_context_parts[2]::uuid;
    v_attestation_id := v_context_parts[3]::uuid;
    v_service_phase := v_context_parts[4];
    v_txid := v_context_parts[5]::bigint;
    v_signature := v_context_parts[6];
    v_required_role := CASE v_service_phase
      WHEN 'admission' THEN 'ba_admission_executor'::name
      WHEN 'metering' THEN 'ba_metering_executor'::name
      WHEN 'finalizer' THEN 'ba_finalizer_executor'::name
      WHEN 'reconciliation' THEN 'ba_reconciliation_executor'::name
      ELSE NULL
    END;

    IF v_required_role IS NULL
       OR NOT pg_catalog.pg_has_role(session_user, v_required_role, 'MEMBER')
       OR v_txid <> txid_current()
       OR v_signature !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;

    SELECT encode(
      public.hmac(
        convert_to(
          format(
            'service:%s:%s:%s:%s:%s',
            att.workspace_id,
            att.id,
            att.service_phase,
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
    FROM auth.internal_service_attestations AS att
    WHERE att.id = v_attestation_id
      AND att.workspace_id = v_workspace_id
      AND att.service_phase = v_service_phase
      AND att.bound_session_user = session_user::name
      AND att.revoked_at IS NULL
      AND att.expires_at > clock_timestamp();

    IF v_expected_signature IS NULL
       OR NOT auth.constant_time_equal_32(
         decode(v_signature, 'hex'),
         decode(v_expected_signature, 'hex')
       ) THEN
      RETURN NULL;
    END IF;

    RETURN v_workspace_id;
  END IF;

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

    -- Revalidate both the trusted attestation and the *current* membership on
    -- every RLS evaluation. Establishment holds row locks for its transaction;
    -- this recheck also makes an already-revoked/expired context fail before a
    -- later statement in a reused transaction can access tenant data.
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

  IF array_length(v_context_parts, 1) <> 4 THEN
    RETURN NULL;
  END IF;

  v_workspace_id := v_context_parts[1]::uuid;
  v_credential_id := v_context_parts[2]::uuid;
  v_txid := v_context_parts[3]::bigint;
  v_signature := v_context_parts[4];

  IF v_txid <> txid_current() OR v_signature !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT encode(
    public.hmac(
      convert_to(
        format('%s:%s:%s:%s', idx.workspace_id, idx.credential_id, v_txid, session_user),
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
    AND (idx.status <> 'overlap' OR (idx.expires_at IS NOT NULL AND idx.rotation_group IS NOT NULL))
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
EXCEPTION
  WHEN others THEN
    -- A malformed or revoked context must look like no tenant, not an RLS error.
    RETURN NULL;
END;
$function$;

-- Exposes a stable principal only after current_workspace_id() has fully
-- revalidated the signed, transaction-local context. Runtime credentials are
-- principals in their own right; no request field may substitute another user
-- or credential identity. Control attestations retain their verified user form
-- for future management-only authorization paths.
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
  IF array_length(v_context_parts, 1) = 4
     AND v_context_parts[1]::uuid = v_workspace_id THEN
    RETURN 'credential:' || v_context_parts[2]::uuid::text;
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

ALTER FUNCTION app.current_workspace_id() OWNER TO ba_auth_owner;
ALTER FUNCTION app.current_authenticated_principal_id() OWNER TO ba_auth_owner;
REVOKE ALL ON FUNCTION app.current_workspace_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_authenticated_principal_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_workspace_id()
  TO ba_runtime, ba_control_executor, ba_auth_owner, ba_billing_owner,
     ba_admission_owner, ba_metering_owner, ba_finalizer_owner,
     ba_admission_executor, ba_metering_executor, ba_finalizer_executor,
     ba_reconciliation_owner, ba_reconciliation_executor,
     ba_retention, ba_authorization_owner;
GRANT EXECUTE ON FUNCTION app.current_authenticated_principal_id()
  TO ba_runtime, ba_control_executor, ba_auth_owner, ba_billing_owner,
     ba_admission_owner, ba_metering_owner, ba_finalizer_owner,
     ba_admission_executor, ba_metering_executor, ba_finalizer_executor,
     ba_reconciliation_owner, ba_reconciliation_executor,
     ba_retention, ba_authorization_owner;
GRANT USAGE ON SCHEMA app TO
  ba_control_executor,
  ba_admission_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reconciliation_executor;

COMMENT ON FUNCTION auth.authenticate_api_credential(uuid, bytea) IS
  'Pre-RLS external API credential lookup granted only to ba_runtime. Internal admission/metering/finalizer/reconciliation phases must use a phase-bound internal service attestation, never a customer-facing credential. Returns only authenticated tenant, credential id and kind, then establishes a transaction-local signed context. The presented verifier is a binary-bound never-log parameter and is compared only by auth.constant_time_equal_32.';
COMMENT ON FUNCTION auth.establish_control_workspace_context(uuid, bytea) IS
  'Control-plane-only pre-RLS context establisher. Derives workspace/principal from an active trusted attestation and rechecks current admin/developer membership; it accepts no workspace argument.';
COMMENT ON FUNCTION auth.issue_control_session_attestation(
  uuid, uuid, uuid, name, text, bytea, bytea, timestamptz
) IS
  'Trusted management-identity gateway lifecycle function. It records a short-lived, session-user-bound attestation after external management authentication; it never stores raw session material.';
COMMENT ON FUNCTION auth.revoke_control_session_attestation(uuid, text) IS
  'Trusted management-identity gateway lifecycle function. Revocation is durable and takes effect on the next context validation.';
COMMENT ON FUNCTION auth.issue_internal_service_attestation(
  uuid, uuid, text, name, text, bytea, timestamptz
) IS
  'Trusted deployment-control-plane lifecycle function. Mints a non-renewable, at-most-15-minute attestation bound to one workspace, one session_user and one internal phase role; it is never derived from an API credential.';
COMMENT ON FUNCTION auth.revoke_internal_service_attestation(uuid, text) IS
  'Trusted deployment-control-plane lifecycle function. Revocation is durable and takes effect on the next signed-context validation.';
COMMENT ON FUNCTION auth.establish_internal_service_workspace_context(uuid, bytea, text) IS
  'Internal phase-only pre-RLS context establisher. Requires an active attestation whose phase and bound session_user match the isolated executor role; external API credentials cannot use this path.';
COMMENT ON FUNCTION app.current_workspace_id() IS
  'Returns an external runtime credential-, trusted management attestation-, or phase-bound internal service attestation-backed transaction-local tenant context, or NULL. Custom GUCs without a verified proof are denied.';
COMMENT ON FUNCTION app.current_authenticated_principal_id() IS
  'Returns a principal only from a verified signed context. This baseline supports credential and control attestations; the G0-04 browser-session migration extends it with a verified end-user context and never trusts request user.id.';

CREATE TABLE api_credential_scopes (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  credential_id uuid NOT NULL,
  scope text NOT NULL CHECK (length(scope) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, credential_id, scope),
  CONSTRAINT api_credential_scopes_credential_fkey
    FOREIGN KEY (workspace_id, credential_id)
    REFERENCES api_credentials(workspace_id, id)
);

-- Deliberately no resource_visibility(resource_type, resource_id, release_id)
-- or api_credential_resource_grants table here. A polymorphic identifier cannot
-- prove that a target/release belongs to this workspace. The later release
-- migration must create published_release_visibility and
-- api_credential_release_grants only after published_resource_versions exists,
-- with (workspace_id, published_resource_version_id) composite foreign keys.
-- Knowledge, database operation, custom-plugin tool, Skill and A2A permissions
-- are separate typed release/grant tables, never generic resource IDs.

CREATE TABLE permission_callbacks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  endpoint_url text NOT NULL,
  auth_scheme text NOT NULL
    CHECK (auth_scheme IN ('hmac', 'mtls', 'bearer', 'none')),
  credential_secret_ref_id uuid,
  timeout_ms integer NOT NULL DEFAULT 3000
    CHECK (timeout_ms BETWEEN 100 AND 30000),
  -- G0/G1 secure baseline rejects fail-open in this migration. Any future
  -- compatibility behavior requires a separate sealed envelope migration,
  -- authorization epoch source, audit contract and executable acceptance gate.
  failure_mode text NOT NULL DEFAULT 'deny'
    CHECK (failure_mode = 'deny'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'error')),
  authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permission_callbacks_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT permission_callbacks_secret_ref_fkey
    FOREIGN KEY (workspace_id, credential_secret_ref_id)
    REFERENCES secret_refs(workspace_id, id),
  CONSTRAINT permission_callbacks_auth_secret_check
    CHECK (
      (auth_scheme = 'none' AND credential_secret_ref_id IS NULL)
      OR (auth_scheme <> 'none' AND credential_secret_ref_id IS NOT NULL)
    )
);

COMMENT ON TABLE permission_callbacks IS
  'Enterprise authorization SPI configuration. endpoint_url must not contain a secret; callback authentication uses secret_refs.';
COMMENT ON COLUMN permission_callbacks.failure_mode IS
  'G0/G1 permits deny only. Future compatibility behavior requires a separate sealed envelope schema, migration and acceptance gate; it cannot be enabled by updating this row alone.';
COMMENT ON COLUMN permission_callbacks.authorization_epoch IS
  'Authoritative callback configuration/status epoch; related policy cache entries are invalidated atomically when it changes.';

-- Durable invalidation facts make a missed process-local cache notification
-- harmless: an executor always compares authoritative database epochs before
-- an unstarted call. source_id is the immutable row ID; composite grants in
-- later migrations use source_subkey for their second key component.
CREATE TABLE authorization_cache_invalidations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN (
    'workspace', 'credential', 'permission_callback', 'authorization_policy',
    'service_principal', 'agent_release',
    'published_release_visibility', 'internal_system_release_grant',
    'knowledge_release', 'knowledge_release_grant',
    'database_operation_release', 'database_operation_release_grant',
    'plugin_tool_release', 'plugin_tool_release_grant',
    'skill_pack_release', 'skill_pack_release_grant',
    'a2a_release', 'a2a_release_grant',
    'typed_release', 'typed_release_grant'
  )),
  source_id uuid NOT NULL,
  source_subkey text NOT NULL DEFAULT '',
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  workspace_epoch bigint NOT NULL CHECK (workspace_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authorization_cache_invalidations_unique_source_epoch
    UNIQUE (workspace_id, source_kind, source_id, source_subkey, source_epoch)
);

-- The only common path for an authorization-relevant mutation. Source-specific
-- mutation functions/triggers first increment their own immutable source epoch,
-- then call this function in the SAME RLS transaction. The durable row feeds
-- cache consumers; pg_notify is only a latency optimization, never correctness.
CREATE OR REPLACE FUNCTION auth.record_authorization_epoch_change(
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
     OR p_source_id IS NULL OR p_source_epoch < 0 THEN
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
    id, workspace_id, source_kind, source_id, source_subkey,
    source_epoch, workspace_epoch
  ) VALUES (
    gen_random_uuid(), p_workspace_id, p_source_kind, p_source_id,
    COALESCE(p_source_subkey, ''), p_source_epoch, v_workspace_epoch
  ) ON CONFLICT (workspace_id, source_kind, source_id, source_subkey, source_epoch)
    DO NOTHING;

  PERFORM pg_notify(
    'ba_authorization_epoch',
    json_build_object(
      'workspace_id', p_workspace_id,
      'source_kind', p_source_kind,
      'source_id', p_source_id,
      'source_epoch', p_source_epoch,
      'workspace_epoch', v_workspace_epoch
    )::text
  );
  RETURN v_workspace_epoch;
END;
$function$;

-- Defense in depth for credential material: direct API/Worker DML is revoked
-- below, while these triggers ensure even an approved management mutation cannot
-- alter auth-relevant fields without advancing the source and workspace epochs.
-- Source identity itself is immutable: rotation/reclassification creates a new
-- credential and revokes the old row rather than reusing a key/source epoch for
-- a different subject. This also protects the pre-RLS auth index from a silent
-- tenant or credential-kind reassignment.
CREATE OR REPLACE FUNCTION auth.reject_api_credential_identity_change()
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
     OR NEW.verifier_algorithm IS DISTINCT FROM OLD.verifier_algorithm THEN
    RAISE EXCEPTION 'credential identity/verifier fields are immutable; rotate by creating a new credential and overlapping/revoking the old one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- Credential lifecycle is a one-way security state machine. The 24-hour value
-- is the G0/G1 hard maximum overlap envelope; the reviewed rotation function may
-- choose a shorter duration but neither it nor a later mutation may extend it.
CREATE OR REPLACE FUNCTION auth.enforce_api_credential_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF NEW.status = 'overlap' THEN
    IF NEW.rotation_group IS NULL
       OR NEW.expires_at IS NULL
       OR NEW.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'overlap credential requires a rotation group and a server-bounded expiry of at most 24 hours'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.expires_at > clock_timestamp() + interval '24 hours' THEN
        RAISE EXCEPTION 'overlap credential requires a rotation group and a server-bounded expiry of at most 24 hours'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status <> 'overlap'
          AND NEW.expires_at > clock_timestamp() + interval '24 hours' THEN
      RAISE EXCEPTION 'overlap credential requires a rotation group and a server-bounded expiry of at most 24 hours'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.rotation_group IS NOT NULL
       AND NEW.rotation_group IS DISTINCT FROM OLD.rotation_group THEN
      RAISE EXCEPTION 'credential rotation group is immutable once assigned'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
      RAISE EXCEPTION 'revoked credential cannot be reactivated'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'expired' AND NEW.status <> 'expired' THEN
      RAISE EXCEPTION 'expired credential cannot be reactivated'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('revoked', 'expired')
       AND (
         NEW.not_before_at IS DISTINCT FROM OLD.not_before_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR NEW.rotation_group IS DISTINCT FROM OLD.rotation_group
       ) THEN
      RAISE EXCEPTION 'terminal credential lifecycle metadata is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'overlap' THEN
      IF NEW.status = 'active'
         OR NEW.rotation_group IS DISTINCT FROM OLD.rotation_group
         OR NEW.expires_at IS NULL
         OR NEW.expires_at > OLD.expires_at THEN
        RAISE EXCEPTION 'overlap credential cannot return active, change rotation group or extend expiry'
          USING ERRCODE = '23514';
      END IF;
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

-- A scope row has no independent epoch: replace it by DELETE + INSERT so the
-- existing after-write trigger advances the old/new credential source(s).
CREATE OR REPLACE FUNCTION auth.reject_api_credential_scope_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'credential scope rows are immutable; delete and insert through the controlled mutation path'
    USING ERRCODE = '23514';
END;
$function$;

CREATE OR REPLACE FUNCTION auth.reject_permission_callback_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'permission callback identity fields are immutable; disable and create a new callback'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION auth.bump_api_credential_epoch_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
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
  ELSIF NEW.authorization_epoch < OLD.authorization_epoch THEN
    RAISE EXCEPTION 'authorization_epoch is monotonic and cannot decrease'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION auth.record_api_credential_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.not_before_at IS DISTINCT FROM OLD.not_before_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.rotation_group IS DISTINCT FROM OLD.rotation_group
     OR NEW.allowed_origins IS DISTINCT FROM OLD.allowed_origins THEN
    PERFORM auth.record_authorization_epoch_change(
      NEW.workspace_id, 'credential', NEW.id, '', NEW.authorization_epoch
    );
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION auth.bump_credential_epoch_from_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := COALESCE(NEW.workspace_id, OLD.workspace_id);
  v_credential_id uuid := COALESCE(NEW.credential_id, OLD.credential_id);
  v_epoch bigint;
BEGIN
  UPDATE public.api_credentials
     SET authorization_epoch = authorization_epoch + 1
   WHERE workspace_id = v_workspace_id AND id = v_credential_id
   RETURNING authorization_epoch INTO v_epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope mutation references missing credential' USING ERRCODE = '23503';
  END IF;
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'credential', v_credential_id, '', v_epoch
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION auth.bump_permission_callback_epoch_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
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
    RAISE EXCEPTION 'authorization_epoch is maintained only by controlled mutation paths'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION auth.reject_authorization_source_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'authorization source rows are revoked/disabled, not deleted'
    USING ERRCODE = '42501';
END;
$function$;

CREATE OR REPLACE FUNCTION auth.record_permission_callback_epoch_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
    PERFORM auth.record_authorization_epoch_change(
      NEW.workspace_id, 'permission_callback', NEW.id, '', NEW.authorization_epoch
    );
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER api_credentials_reject_identity_change
BEFORE UPDATE OF id, workspace_id, key_id, credential_kind, secret_verifier_hmac, verifier_algorithm ON api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.reject_api_credential_identity_change();
CREATE TRIGGER api_credentials_enforce_lifecycle
BEFORE INSERT OR UPDATE OF status, expires_at, revoked_at, rotation_group ON api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.enforce_api_credential_lifecycle();
CREATE TRIGGER api_credential_scopes_reject_update
BEFORE UPDATE ON api_credential_scopes
FOR EACH ROW EXECUTE FUNCTION auth.reject_api_credential_scope_update();
CREATE TRIGGER permission_callbacks_reject_identity_change
BEFORE UPDATE OF id, workspace_id ON permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.reject_permission_callback_identity_change();
CREATE TRIGGER api_credentials_authorization_epoch_before_write
BEFORE INSERT OR UPDATE ON api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.bump_api_credential_epoch_before_write();
CREATE TRIGGER api_credentials_authorization_epoch_after_write
AFTER INSERT OR UPDATE ON api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.record_api_credential_epoch_after_write();
CREATE TRIGGER api_credential_scopes_authorization_epoch_after_write
AFTER INSERT OR UPDATE OR DELETE ON api_credential_scopes
FOR EACH ROW EXECUTE FUNCTION auth.bump_credential_epoch_from_scope();
CREATE TRIGGER api_credentials_reject_authorization_source_delete
BEFORE DELETE ON api_credentials
FOR EACH ROW EXECUTE FUNCTION auth.reject_authorization_source_delete();
CREATE TRIGGER permission_callbacks_authorization_epoch_before_write
BEFORE INSERT OR UPDATE ON permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.bump_permission_callback_epoch_before_write();
CREATE TRIGGER permission_callbacks_authorization_epoch_after_write
AFTER INSERT OR UPDATE ON permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.record_permission_callback_epoch_after_write();
CREATE TRIGGER permission_callbacks_reject_authorization_source_delete
BEFORE DELETE ON permission_callbacks
FOR EACH ROW EXECUTE FUNCTION auth.reject_authorization_source_delete();

ALTER FUNCTION auth.record_authorization_epoch_change(uuid, text, uuid, text, bigint)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.reject_api_credential_identity_change() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.enforce_api_credential_lifecycle() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.reject_api_credential_scope_update() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.reject_permission_callback_identity_change() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.bump_api_credential_epoch_before_write() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.record_api_credential_epoch_after_write() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.bump_credential_epoch_from_scope() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.bump_permission_callback_epoch_before_write() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.record_permission_callback_epoch_after_write() OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.reject_authorization_source_delete() OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION auth.record_authorization_epoch_change(uuid, text, uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_api_credential_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_api_credential_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_api_credential_scope_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_permission_callback_identity_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bump_api_credential_epoch_before_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_api_credential_epoch_after_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bump_credential_epoch_from_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bump_permission_callback_epoch_before_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_permission_callback_epoch_after_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_authorization_source_delete() FROM PUBLIC;

CREATE INDEX workspace_members_user_workspace_idx
  ON workspace_members(user_id, workspace_id);
CREATE INDEX control_session_attestations_workspace_principal_active_idx
  ON auth.control_session_attestations(workspace_id, principal_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX role_configs_workspace_idx
  ON role_configs(workspace_id, id);
CREATE INDEX secret_refs_workspace_status_idx
  ON secret_refs(workspace_id, status);
CREATE INDEX api_credentials_workspace_status_expiry_idx
  ON api_credentials(workspace_id, status, expires_at);
CREATE INDEX api_credentials_rotation_group_idx
  ON api_credentials(workspace_id, rotation_group)
  WHERE rotation_group IS NOT NULL;
CREATE INDEX api_credential_scopes_credential_idx
  ON api_credential_scopes(workspace_id, credential_id);
CREATE INDEX permission_callbacks_workspace_status_idx
  ON permission_callbacks(workspace_id, status);

-- RLS is intentionally explicit. Application code must first call the restricted
-- auth function; app.current_workspace_id() validates its transaction-local
-- proof rather than trusting a caller-written workspace setting.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant_isolation ON workspaces
  FOR ALL
  USING (id = app.current_workspace_id())
  WITH CHECK (id = app.current_workspace_id());

ALTER TABLE role_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY role_configs_tenant_isolation ON role_configs
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_tenant_isolation ON workspace_members
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());
-- The NOLOGIN auth function owner gets this narrowly scoped pre-context read
-- path so it can validate an attested management principal before a tenant
-- context exists. No executable runtime/control role receives SELECT or table
-- DML from this policy; all ordinary access still goes through tenant RLS.
CREATE POLICY workspace_members_control_context_owner_read ON workspace_members
  FOR SELECT TO ba_auth_owner
  USING (true);

ALTER TABLE secret_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY secret_refs_tenant_isolation ON secret_refs
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY api_credentials_tenant_isolation ON api_credentials
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE api_credential_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_credential_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY api_credential_scopes_tenant_isolation ON api_credential_scopes
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE permission_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_callbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY permission_callbacks_tenant_isolation ON permission_callbacks
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

ALTER TABLE authorization_cache_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorization_cache_invalidations FORCE ROW LEVEL SECURITY;
CREATE POLICY authorization_cache_invalidations_tenant_isolation
  ON authorization_cache_invalidations
  FOR ALL
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

-- API/worker code authenticates and reads authorization facts but cannot mutate
-- them directly. secret_verifier_hmac is bearer-equivalent at the database
-- boundary: RLS is not sufficient protection because a same-tenant SELECT would
-- disclose material accepted by authenticate_api_credential(). Revoke table-wide
-- SELECT first, then grant an explicit safe projection that excludes the verifier
-- and verifier algorithm. The private auth.credential_auth_index remains readable
-- only by ba_auth_owner through the reviewed authentication function.
-- Management endpoints use narrowly scoped SECURITY DEFINER
-- functions owned by ba_authorization_owner; later policy/service-principal and
-- typed-release migrations must use the same record_authorization_epoch_change
-- transaction, never bypass it with raw table DML.
REVOKE ALL ON TABLE api_credentials FROM PUBLIC;
REVOKE SELECT ON TABLE api_credentials FROM
  ba_runtime,
  ba_control_executor,
  ba_admission_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reconciliation_executor,
  ba_admission_owner,
  ba_metering_owner,
  ba_finalizer_owner,
  ba_reconciliation_owner,
  ba_billing_owner,
  ba_retention,
  ba_authorization_owner,
  ba_auth_owner;
GRANT SELECT (
  id,
  workspace_id,
  key_id,
  key_hint,
  credential_kind,
  status,
  not_before_at,
  expires_at,
  revoked_at,
  authorization_epoch,
  rotation_group,
  allowed_origins,
  created_at,
  last_used_at
) ON TABLE api_credentials TO ba_runtime, ba_control_executor;
REVOKE INSERT, UPDATE, DELETE ON TABLE api_credentials FROM ba_runtime;
REVOKE INSERT, UPDATE, DELETE ON TABLE api_credential_scopes FROM ba_runtime;
REVOKE INSERT, UPDATE, DELETE ON TABLE permission_callbacks FROM ba_runtime;
REVOKE INSERT, UPDATE, DELETE ON TABLE
  workspaces,
  role_configs,
  workspace_members,
  secret_refs,
  api_credentials,
  api_credential_scopes,
  permission_callbacks,
  authorization_cache_invalidations
  FROM ba_control_executor;
REVOKE ALL ON TABLE authorization_cache_invalidations FROM PUBLIC;
REVOKE ALL ON TABLE authorization_cache_invalidations FROM ba_runtime;
-- The pre-context attestation functions read and FOR SHARE-lock exactly these
-- membership columns. PostgreSQL requires a column-level UPDATE ACL for that
-- lock mode. There is deliberately no ba_auth_owner UPDATE RLS policy, and
-- ba_auth_owner is NOLOGIN, so this is not a direct membership-mutation path.
GRANT SELECT (workspace_id, user_id, role), UPDATE (role)
  ON TABLE workspace_members TO ba_auth_owner;
GRANT USAGE ON SCHEMA app, auth TO ba_authorization_owner;
GRANT SELECT, UPDATE (authorization_epoch, updated_at) ON TABLE workspaces
  TO ba_authorization_owner;
GRANT SELECT (workspace_id, id, authorization_epoch), UPDATE (authorization_epoch)
  ON TABLE api_credentials
  TO ba_authorization_owner;
GRANT INSERT ON TABLE authorization_cache_invalidations TO ba_authorization_owner;

COMMIT;

-- REQUIRED FOR EVERY LATER TENANT MIGRATION
--
-- 1. Add workspace_id uuid NOT NULL REFERENCES workspaces(id) directly to the
--    table; do not infer tenancy only by joining a parent.
-- 2. Add UNIQUE (workspace_id, id) when another tenant table can reference it.
-- 3. Use FOREIGN KEY (workspace_id, parent_id)
--      REFERENCES parent_table(workspace_id, id)
--    for every tenant-owned parent relationship. Do not use parent_id-only
--    foreign keys for tenant relationships.
-- 4. Apply the same RLS shape:
--      ALTER TABLE <tenant_table> ENABLE ROW LEVEL SECURITY;
--      ALTER TABLE <tenant_table> FORCE ROW LEVEL SECURITY;
--      CREATE POLICY <tenant_table>_tenant_isolation ON <tenant_table>
--        FOR ALL
--        USING (workspace_id = app.current_workspace_id())
--        WITH CHECK (workspace_id = app.current_workspace_id());
-- 5. For polymorphic resource references, use typed association tables or a
--    validating constraint trigger; an application-only check is insufficient.
-- 6. Include workspace_id in lookup, uniqueness, idempotency, queue, cache,
--    object-store, search-index, and audit boundaries.
