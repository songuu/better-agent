-- G0-04 fact tables only. Authentication projections, signed context, RLS,
-- triggers and grants are installed by 002_auth_context_rls.up.sql in the same
-- migration invocation. No browser session or G0-07 phase-role facts live here.

CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  plan text,
  credits_balance bigint NOT NULL DEFAULT 0 CHECK (credits_balance >= 0),
  credits_reserved_balance bigint NOT NULL DEFAULT 0
    CHECK (credits_reserved_balance >= 0),
  credits_balance_version bigint NOT NULL DEFAULT 0
    CHECK (credits_balance_version >= 0),
  authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  expire_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspaces_workspace_identity CHECK (id IS NOT NULL)
);

CREATE TABLE public.role_configs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(permissions) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT role_configs_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT role_configs_workspace_name_key UNIQUE (workspace_id, name)
);

CREATE TABLE public.workspace_members (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'developer', 'user', 'viewer')),
  role_config_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_role_config_fkey
    FOREIGN KEY (workspace_id, role_config_id)
    REFERENCES public.role_configs(workspace_id, id)
);

CREATE TABLE public.secret_refs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  provider text NOT NULL
    CHECK (provider IN ('env', 'vault', 'k8s_secret', 'offline_bundle')),
  opaque_locator text NOT NULL CHECK (length(btrim(opaque_locator)) > 0),
  version_hint text,
  purpose text NOT NULL CHECK (length(btrim(purpose)) > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotating', 'revoked', 'expired')),
  rotation_due_at timestamptz,
  metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata_redacted) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT secret_refs_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT secret_refs_workspace_provider_locator_key
    UNIQUE (workspace_id, provider, opaque_locator)
);

COMMENT ON TABLE public.secret_refs IS
  'Opaque references to deployment-managed secret material. No secret, token, signature or connection string is stored here.';

CREATE TABLE public.api_credentials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  key_id uuid NOT NULL UNIQUE,
  key_hint text NOT NULL CHECK (length(btrim(key_hint)) > 0),
  credential_kind text NOT NULL CHECK (credential_kind IN (
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
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
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

COMMENT ON COLUMN public.api_credentials.secret_verifier_hmac IS
  'Exactly 32 bytes and bearer-equivalent at the database boundary. Only the isolated auth projection/function owner may read it.';

CREATE TABLE public.api_credential_scopes (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  credential_id uuid NOT NULL,
  credential_kind text NOT NULL,
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, credential_id, scope),
  CONSTRAINT api_credential_scopes_credential_fkey
    FOREIGN KEY (workspace_id, credential_id, credential_kind)
    REFERENCES public.api_credentials(workspace_id, id, credential_kind),
  CONSTRAINT api_credential_scopes_closed_vocabulary CHECK (
    (
      credential_kind = 'publish'
      AND scope = 'browser-session:exchange'
    )
    OR (
      credential_kind = 'service_api'
      AND scope IN (
        'agent:conversation:write',
        'agent:conversation:read',
        'agent:run:create',
        'flow:run:create',
        'run:read',
        'run:cancel',
        'run:resume',
        'run:events:read'
      )
    )
  )
);

COMMENT ON TABLE public.api_credential_scopes IS
  'Closed G0/G1 public API scope vocabulary. publish can only exchange a browser session; service_api cannot obtain that scope.';

CREATE TABLE public.permission_callbacks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  endpoint_url text NOT NULL CHECK (endpoint_url ~ '^https://'),
  auth_scheme text NOT NULL CHECK (auth_scheme IN ('hmac', 'mtls', 'bearer', 'none')),
  credential_secret_ref_id uuid,
  timeout_ms integer NOT NULL DEFAULT 2000 CHECK (timeout_ms BETWEEN 100 AND 2000),
  failure_mode text NOT NULL DEFAULT 'deny' CHECK (failure_mode = 'deny'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'error')),
  authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT permission_callbacks_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT permission_callbacks_secret_ref_fkey
    FOREIGN KEY (workspace_id, credential_secret_ref_id)
    REFERENCES public.secret_refs(workspace_id, id),
  CONSTRAINT permission_callbacks_auth_secret_check CHECK (
    (auth_scheme = 'none' AND credential_secret_ref_id IS NULL)
    OR (auth_scheme <> 'none' AND credential_secret_ref_id IS NOT NULL)
  )
);

CREATE TABLE public.browser_subject_issuer_configs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  issuer text NOT NULL CHECK (length(btrim(issuer)) > 0),
  audience text NOT NULL CHECK (length(btrim(audience)) > 0),
  verification_key_ref_id uuid NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  allowed_origins text[] NOT NULL CHECK (cardinality(allowed_origins) > 0),
  max_assertion_ttl_seconds integer NOT NULL DEFAULT 300
    CHECK (max_assertion_ttl_seconds BETWEEN 1 AND 300),
  allowed_clock_skew_seconds integer NOT NULL DEFAULT 30
    CHECK (allowed_clock_skew_seconds BETWEEN 0 AND 30),
  not_before_at timestamptz,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'revoked')),
  authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT browser_subject_issuer_configs_workspace_id_id_key
    UNIQUE (workspace_id, id),
  CONSTRAINT browser_subject_issuer_configs_identity_key
    UNIQUE (workspace_id, issuer, audience, key_version),
  CONSTRAINT browser_subject_issuer_configs_secret_ref_fkey
    FOREIGN KEY (workspace_id, verification_key_ref_id)
    REFERENCES public.secret_refs(workspace_id, id),
  CONSTRAINT browser_subject_issuer_configs_window_check
    CHECK (expires_at IS NULL OR not_before_at IS NULL OR expires_at > not_before_at),
  CONSTRAINT browser_subject_issuer_configs_origins_check CHECK (
    array_position(allowed_origins, NULL) IS NULL
  )
);

COMMENT ON TABLE public.browser_subject_issuer_configs IS
  'Versioned verifier configuration. Cryptographic assertion verification occurs in the isolated verifier adapter; the DB consume function independently checks these closed claims and never accepts principal_id.';

CREATE TABLE public.end_user_principals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  issuer_config_id uuid NOT NULL,
  issuer text NOT NULL CHECK (length(btrim(issuer)) > 0),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  session_epoch bigint NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT end_user_principals_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT end_user_principals_issuer_subject_key
    UNIQUE (workspace_id, issuer, subject_hash),
  CONSTRAINT end_user_principals_issuer_fkey
    FOREIGN KEY (workspace_id, issuer_config_id)
    REFERENCES public.browser_subject_issuer_configs(workspace_id, id),
  CONSTRAINT end_user_principals_lifecycle_check CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE public.browser_subject_assertion_uses (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  issuer_config_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  assertion_nonce_hash bytea NOT NULL
    CHECK (octet_length(assertion_nonce_hash) = 32),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash) = 32),
  audience text NOT NULL,
  canonical_origin text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  assertion_issued_at timestamptz NOT NULL,
  assertion_expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT browser_subject_assertion_uses_workspace_id_id_key
    UNIQUE (workspace_id, id),
  CONSTRAINT browser_subject_assertion_uses_nonce_key
    UNIQUE (workspace_id, issuer_config_id, assertion_nonce_hash),
  CONSTRAINT browser_subject_assertion_uses_issuer_fkey
    FOREIGN KEY (workspace_id, issuer_config_id)
    REFERENCES public.browser_subject_issuer_configs(workspace_id, id),
  CONSTRAINT browser_subject_assertion_uses_principal_fkey
    FOREIGN KEY (workspace_id, principal_id)
    REFERENCES public.end_user_principals(workspace_id, id),
  CONSTRAINT browser_subject_assertion_uses_time_check
    CHECK (assertion_expires_at > assertion_issued_at)
);

CREATE TABLE public.authorization_cache_invalidations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  source_kind text NOT NULL CHECK (source_kind IN (
    'workspace',
    'credential',
    'permission_callback',
    'browser_subject_issuer',
    'end_user_principal'
  )),
  source_id uuid NOT NULL,
  source_subkey text NOT NULL DEFAULT '',
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  workspace_epoch bigint NOT NULL CHECK (workspace_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT authorization_cache_invalidations_source_epoch_key
    UNIQUE (workspace_id, source_kind, source_id, source_subkey, source_epoch)
);

CREATE INDEX workspace_members_user_workspace_idx
  ON public.workspace_members(user_id, workspace_id);
CREATE INDEX role_configs_workspace_idx
  ON public.role_configs(workspace_id, id);
CREATE INDEX secret_refs_workspace_status_idx
  ON public.secret_refs(workspace_id, status);
CREATE INDEX api_credentials_workspace_status_expiry_idx
  ON public.api_credentials(workspace_id, status, expires_at);
CREATE INDEX api_credentials_rotation_group_idx
  ON public.api_credentials(workspace_id, rotation_group)
  WHERE rotation_group IS NOT NULL;
CREATE INDEX api_credential_scopes_credential_idx
  ON public.api_credential_scopes(workspace_id, credential_id);
CREATE INDEX permission_callbacks_workspace_status_idx
  ON public.permission_callbacks(workspace_id, status);
CREATE INDEX browser_subject_issuer_configs_active_idx
  ON public.browser_subject_issuer_configs(workspace_id, issuer, audience, key_version)
  WHERE status = 'active';
CREATE INDEX end_user_principals_workspace_status_idx
  ON public.end_user_principals(workspace_id, status, id);
CREATE INDEX browser_subject_assertion_uses_consumed_idx
  ON public.browser_subject_assertion_uses(workspace_id, consumed_at);

-- PostgreSQL requires the new relation owner to have CREATE on the containing
-- schema during ALTER OWNER. The grant exists only inside this migration
-- transaction and is removed immediately after the ownership handoff.
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;

ALTER TABLE public.workspaces OWNER TO ba_authorization_owner;
ALTER TABLE public.role_configs OWNER TO ba_authorization_owner;
ALTER TABLE public.workspace_members OWNER TO ba_authorization_owner;
ALTER TABLE public.secret_refs OWNER TO ba_authorization_owner;
ALTER TABLE public.api_credentials OWNER TO ba_authorization_owner;
ALTER TABLE public.api_credential_scopes OWNER TO ba_authorization_owner;
ALTER TABLE public.permission_callbacks OWNER TO ba_authorization_owner;
ALTER TABLE public.browser_subject_issuer_configs OWNER TO ba_authorization_owner;
ALTER TABLE public.end_user_principals OWNER TO ba_authorization_owner;
ALTER TABLE public.browser_subject_assertion_uses OWNER TO ba_authorization_owner;
ALTER TABLE public.authorization_cache_invalidations OWNER TO ba_authorization_owner;

REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;

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
FROM PUBLIC;
