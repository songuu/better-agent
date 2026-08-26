-- G0-05 immutable Release, stable Deployment, typed entry-grant and browser
-- session facts. G0-06 remains responsible for Run/profile persistence.
-- Every mutation below is exposed through a kind-specific SECURITY DEFINER
-- function; executable roles receive no direct table DML.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;
-- PostgreSQL requires the new table owner to have CREATE on the containing
-- schema during ownership transfer. This temporary privilege is revoked below.
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
GRANT EXECUTE ON FUNCTION app.current_api_credential_id()
  TO ba_authorization_owner;

ALTER TABLE public.authorization_cache_invalidations
  DROP CONSTRAINT authorization_cache_invalidations_source_kind_check;
ALTER TABLE public.authorization_cache_invalidations
  ADD CONSTRAINT authorization_cache_invalidations_source_kind_check
  CHECK (source_kind IN (
    'workspace',
    'credential',
    'permission_callback',
    'browser_subject_issuer',
    'end_user_principal',
    'agent_deployment',
    'flow_deployment',
    'agent_deployment_entry_grant',
    'flow_deployment_entry_grant',
    'browser_session'
  ));

CREATE FUNCTION app.reject_immutable_release_fact_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'published and revision facts are immutable'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION app.reject_immutable_release_fact_change()
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.reject_immutable_release_fact_change() FROM PUBLIC;

CREATE TABLE public.published_resource_versions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  published_resource_kind text NOT NULL CHECK (published_resource_kind IN (
    'AGENT_STRATEGY_RELEASE',
    'AGENT_RELEASE',
    'FLOW_VERSION',
    'EXPERIENCE_RELEASE',
    'DEPLOYMENT_REVISION'
  )),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  contract_hash text NOT NULL
    CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_schema_version text NOT NULL CHECK (length(btrim(source_schema_version)) > 0),
  source_subkind text,
  canonical_document text NOT NULL
    CHECK (jsonb_typeof(canonical_document::jsonb) = 'object'),
  published_by text NOT NULL CHECK (length(btrim(published_by)) > 0),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    workspace_id,
    published_resource_kind,
    resource_id,
    resource_version_id
  ),
  CONSTRAINT published_resource_versions_identity_hash_key UNIQUE (
    workspace_id,
    published_resource_kind,
    resource_id,
    resource_version_id,
    contract_hash
  ),
  CONSTRAINT published_resource_versions_deployment_subkind_check CHECK (
    (
      published_resource_kind = 'DEPLOYMENT_REVISION'
      AND source_subkind IN ('agent', 'flow')
    ) OR (
      published_resource_kind <> 'DEPLOYMENT_REVISION'
      AND source_subkind IS NULL
    )
  ),
  CONSTRAINT published_resource_versions_kind_schema_check CHECK (
    (published_resource_kind = 'AGENT_STRATEGY_RELEASE'
      AND source_schema_version = 'agent-strategy-release/1')
    OR (published_resource_kind = 'AGENT_RELEASE'
      AND source_schema_version = 'agent-release/1')
    OR (published_resource_kind = 'FLOW_VERSION'
      AND source_schema_version = 'flow-ir/1')
    OR (published_resource_kind = 'EXPERIENCE_RELEASE'
      AND source_schema_version = 'experience-release/1')
    OR (published_resource_kind = 'DEPLOYMENT_REVISION'
      AND source_schema_version IN ('agent-deployment/1', 'flow-deployment/1'))
  )
);

CREATE TABLE public.published_resource_dependencies (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  owner_kind text NOT NULL,
  owner_resource_id uuid NOT NULL,
  owner_resource_version_id uuid NOT NULL,
  dependency_kind text NOT NULL,
  dependency_resource_id uuid NOT NULL,
  dependency_resource_version_id uuid NOT NULL,
  dependency_contract_hash text NOT NULL
    CHECK (dependency_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  binding_mode text NOT NULL CHECK (binding_mode = 'pinned'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (
    workspace_id,
    owner_kind,
    owner_resource_id,
    owner_resource_version_id,
    dependency_kind,
    dependency_resource_id,
    dependency_resource_version_id
  ),
  CONSTRAINT published_resource_dependencies_owner_fkey FOREIGN KEY (
    workspace_id,
    owner_kind,
    owner_resource_id,
    owner_resource_version_id
  ) REFERENCES public.published_resource_versions (
    workspace_id,
    published_resource_kind,
    resource_id,
    resource_version_id
  ),
  CONSTRAINT published_resource_dependencies_pin_fkey FOREIGN KEY (
    workspace_id,
    dependency_kind,
    dependency_resource_id,
    dependency_resource_version_id,
    dependency_contract_hash
  ) REFERENCES public.published_resource_versions (
    workspace_id,
    published_resource_kind,
    resource_id,
    resource_version_id,
    contract_hash
  ),
  CONSTRAINT published_resource_dependencies_owner_ordinal_key UNIQUE (
    workspace_id,
    owner_kind,
    owner_resource_id,
    owner_resource_version_id,
    ordinal
  )
);

CREATE TABLE public.publishable_resource_roots (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  published_resource_kind text NOT NULL CHECK (published_resource_kind IN (
    'AGENT_STRATEGY_RELEASE',
    'AGENT_RELEASE',
    'FLOW_VERSION',
    'EXPERIENCE_RELEASE',
    'DEPLOYMENT_REVISION'
  )),
  resource_id uuid NOT NULL,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, published_resource_kind, resource_id)
);

CREATE TABLE public.publishable_resource_draft_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  published_resource_kind text NOT NULL CHECK (published_resource_kind IN (
    'AGENT_STRATEGY_RELEASE', 'AGENT_RELEASE', 'FLOW_VERSION', 'EXPERIENCE_RELEASE'
  )),
  resource_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  editor_document jsonb NOT NULL CHECK (jsonb_typeof(editor_document) = 'object'),
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT publishable_resource_draft_revisions_workspace_id_id_key
    UNIQUE (workspace_id, id),
  CONSTRAINT publishable_resource_draft_revisions_root_revision_key
    UNIQUE (workspace_id, published_resource_kind, resource_id, revision),
  CONSTRAINT publishable_resource_draft_revisions_root_fkey FOREIGN KEY (
    workspace_id, published_resource_kind, resource_id
  ) REFERENCES public.publishable_resource_roots (
    workspace_id, published_resource_kind, resource_id
  )
);

CREATE TABLE public.agent_strategy_releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  strategy_id uuid NOT NULL,
  source_draft_revision_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_document text NOT NULL CHECK (
    jsonb_typeof(canonical_document::jsonb) = 'object'
    AND canonical_document::jsonb ->> 'schema_version' = 'agent-strategy-release/1'
  ),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_strategy_releases_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_strategy_releases_workspace_strategy_id_key
    UNIQUE (workspace_id, strategy_id, id),
  CONSTRAINT agent_strategy_releases_source_draft_fkey
    FOREIGN KEY (workspace_id, source_draft_revision_id)
    REFERENCES public.publishable_resource_draft_revisions(workspace_id, id),
  CONSTRAINT agent_strategy_releases_identity_document_check CHECK (
    canonical_document::jsonb ->> 'strategy_id' = strategy_id::text
    AND canonical_document::jsonb ->> 'strategy_release_id' = id::text
    AND canonical_document::jsonb ->> 'source_draft_revision_id'
      = source_draft_revision_id::text
    AND canonical_document::jsonb ->> 'contract_hash' = contract_hash
  )
);

CREATE TABLE public.agent_releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_id uuid NOT NULL,
  source_draft_revision_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_document text NOT NULL CHECK (
    jsonb_typeof(canonical_document::jsonb) = 'object'
    AND canonical_document::jsonb ->> 'schema_version' = 'agent-release/1'
  ),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_releases_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_releases_workspace_agent_id_key UNIQUE (workspace_id, agent_id, id),
  CONSTRAINT agent_releases_source_draft_fkey
    FOREIGN KEY (workspace_id, source_draft_revision_id)
    REFERENCES public.publishable_resource_draft_revisions(workspace_id, id),
  CONSTRAINT agent_releases_identity_document_check CHECK (
    canonical_document::jsonb ->> 'agent_id' = agent_id::text
    AND canonical_document::jsonb ->> 'agent_release_id' = id::text
    AND canonical_document::jsonb ->> 'source_draft_revision_id'
      = source_draft_revision_id::text
  )
);

CREATE TABLE public.flow_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  flow_id uuid NOT NULL,
  source_draft_revision_id uuid,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_document text NOT NULL CHECK (
    jsonb_typeof(canonical_document::jsonb) = 'object'
    AND canonical_document::jsonb ->> 'schema_version' = 'flow-ir/1'
  ),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_versions_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT flow_versions_workspace_flow_id_key UNIQUE (workspace_id, flow_id, id),
  CONSTRAINT flow_versions_source_draft_fkey
    FOREIGN KEY (workspace_id, source_draft_revision_id)
    REFERENCES public.publishable_resource_draft_revisions(workspace_id, id),
  CONSTRAINT flow_versions_identity_document_check CHECK (
    canonical_document::jsonb ->> 'flow_id' = flow_id::text
    AND canonical_document::jsonb ->> 'flow_version_id' = id::text
  )
);

CREATE TABLE public.experience_releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  experience_id uuid NOT NULL,
  compatible_agent_id uuid NOT NULL,
  source_draft_revision_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_document text NOT NULL CHECK (
    jsonb_typeof(canonical_document::jsonb) = 'object'
    AND canonical_document::jsonb ->> 'schema_version' = 'experience-release/1'
  ),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT experience_releases_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT experience_releases_workspace_experience_id_key
    UNIQUE (workspace_id, experience_id, id),
  CONSTRAINT experience_releases_source_draft_fkey
    FOREIGN KEY (workspace_id, source_draft_revision_id)
    REFERENCES public.publishable_resource_draft_revisions(workspace_id, id),
  CONSTRAINT experience_releases_identity_document_check CHECK (
    canonical_document::jsonb ->> 'experience_id' = experience_id::text
    AND canonical_document::jsonb ->> 'experience_release_id' = id::text
    AND canonical_document::jsonb ->> 'compatible_agent_id' = compatible_agent_id::text
    AND canonical_document::jsonb ->> 'source_draft_revision_id'
      = source_draft_revision_id::text
    AND canonical_document::jsonb ->> 'content_hash' = content_hash
  )
);

CREATE TABLE public.published_resource_credential_requirements (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('AGENT_RELEASE', 'FLOW_VERSION')),
  owner_resource_id uuid NOT NULL,
  owner_resource_version_id uuid NOT NULL,
  owner_contract_hash text NOT NULL CHECK (owner_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  requirement_id text NOT NULL CHECK (length(btrim(requirement_id)) > 0),
  provider_id text NOT NULL CHECK (length(btrim(provider_id)) > 0),
  audience text NOT NULL CHECK (length(btrim(audience)) > 0),
  required_scopes text[] NOT NULL CHECK (cardinality(required_scopes) > 0),
  allowed_principal_modes text[] NOT NULL CHECK (
    cardinality(allowed_principal_modes) > 0
    AND allowed_principal_modes <@ ARRAY[
      'caller_delegated', 'service_principal', 'team_shared'
    ]::text[]
  ),
  PRIMARY KEY (
    workspace_id, owner_kind, owner_resource_id, owner_resource_version_id, requirement_id
  ),
  CONSTRAINT published_resource_credential_requirements_owner_fkey FOREIGN KEY (
    workspace_id, owner_kind, owner_resource_id, owner_resource_version_id, owner_contract_hash
  ) REFERENCES public.published_resource_versions (
    workspace_id, published_resource_kind, resource_id, resource_version_id, contract_hash
  )
);

CREATE TABLE public.agent_release_public_capability_handles (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_id uuid NOT NULL,
  agent_release_id uuid NOT NULL,
  public_handle text NOT NULL CHECK (length(btrim(public_handle)) > 0),
  binding_id text NOT NULL CHECK (length(btrim(binding_id)) > 0),
  operation_contract_hash text NOT NULL
    CHECK (operation_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_schema_hash text NOT NULL CHECK (input_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  enabled boolean NOT NULL,
  PRIMARY KEY (workspace_id, agent_release_id, public_handle),
  CONSTRAINT agent_release_public_capability_handles_release_fkey
    FOREIGN KEY (workspace_id, agent_id, agent_release_id)
    REFERENCES public.agent_releases(workspace_id, agent_id, id)
);

CREATE TABLE public.experience_release_quick_entries (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  experience_id uuid NOT NULL,
  experience_release_id uuid NOT NULL,
  quick_entry_id text NOT NULL CHECK (length(btrim(quick_entry_id)) > 0),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  public_handle text NOT NULL CHECK (length(btrim(public_handle)) > 0),
  operation_contract_hash text NOT NULL
    CHECK (operation_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_schema_hash text NOT NULL CHECK (input_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  default_inputs jsonb NOT NULL CHECK (jsonb_typeof(default_inputs) = 'object'),
  PRIMARY KEY (workspace_id, experience_release_id, quick_entry_id),
  CONSTRAINT experience_release_quick_entries_handle_key
    UNIQUE (workspace_id, experience_release_id, public_handle),
  CONSTRAINT experience_release_quick_entries_release_fkey
    FOREIGN KEY (workspace_id, experience_id, experience_release_id)
    REFERENCES public.experience_releases(workspace_id, experience_id, id)
);

CREATE TABLE public.deployment_policy_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  policy_id uuid NOT NULL,
  policy_kind text NOT NULL CHECK (policy_kind IN (
    'deployment_profile',
    'entry_grant',
    'entry_scope',
    'oauth_delegation',
    'service_principal',
    'team_credential'
  )),
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_document text NOT NULL CHECK (jsonb_typeof(canonical_document::jsonb) = 'object'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT deployment_policy_versions_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT deployment_policy_versions_identity_hash_key
    UNIQUE (workspace_id, policy_id, id, contract_hash),
  CONSTRAINT deployment_policy_versions_pin_key
    UNIQUE (workspace_id, policy_kind, policy_id, id, contract_hash)
);

CREATE TABLE public.agent_deployments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_id uuid NOT NULL,
  public_selector text NOT NULL CHECK (
    length(btrim(public_selector)) > 0 AND length(public_selector) <= 255
  ),
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  ingress_channel text NOT NULL CHECK (ingress_channel IN ('browser', 'service_api', 'internal_preview')),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_deployments_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_deployments_stable_axes_key
    UNIQUE (workspace_id, id, agent_id, environment, ingress_channel),
  CONSTRAINT agent_deployments_workspace_selector_key UNIQUE (workspace_id, public_selector)
);

CREATE TABLE public.agent_deployment_security_states (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_deployment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  revoke_epoch bigint NOT NULL DEFAULT 0 CHECK (revoke_epoch >= 0),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_deployment_id),
  CONSTRAINT agent_deployment_security_states_deployment_fkey
    FOREIGN KEY (workspace_id, agent_deployment_id)
    REFERENCES public.agent_deployments(workspace_id, id)
);

CREATE TABLE public.agent_deployment_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_deployment_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  ingress_channel text NOT NULL CHECK (ingress_channel IN ('browser', 'service_api', 'internal_preview')),
  agent_release_id uuid NOT NULL,
  agent_release_contract_hash text NOT NULL
    CHECK (agent_release_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  experience_id uuid NOT NULL,
  experience_release_id uuid NOT NULL,
  experience_contract_hash text NOT NULL
    CHECK (experience_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  policy_profile_id uuid NOT NULL,
  policy_profile_version_id uuid NOT NULL,
  policy_profile_contract_hash text NOT NULL
    CHECK (policy_profile_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  entry_grant_policy_id uuid NOT NULL,
  entry_grant_policy_version_id uuid NOT NULL,
  entry_grant_policy_contract_hash text NOT NULL
    CHECK (entry_grant_policy_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  entry_scope_policy_id uuid NOT NULL,
  entry_scope_policy_version_id uuid NOT NULL,
  entry_scope_policy_contract_hash text NOT NULL
    CHECK (entry_scope_policy_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  credential_mapping_hash text NOT NULL
    CHECK (credential_mapping_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  change_set_hash text NOT NULL CHECK (change_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  revision_contract_hash text NOT NULL
    CHECK (revision_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  allowed_origins text[] NOT NULL DEFAULT '{}'::text[],
  browser_client_channels text[] NOT NULL DEFAULT '{}'::text[],
  session_token_audience text,
  canonical_document text NOT NULL CHECK (
    jsonb_typeof(canonical_document::jsonb) = 'object'
    AND canonical_document::jsonb ->> 'schema_version' = 'agent-deployment/1'
  ),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_deployment_revisions_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_deployment_revisions_deployment_id_key
    UNIQUE (workspace_id, agent_deployment_id, id),
  CONSTRAINT agent_deployment_revisions_stable_axes_fkey FOREIGN KEY (
    workspace_id, agent_deployment_id, agent_id, environment, ingress_channel
  ) REFERENCES public.agent_deployments (
    workspace_id, id, agent_id, environment, ingress_channel
  ),
  CONSTRAINT agent_deployment_revisions_agent_release_fkey
    FOREIGN KEY (workspace_id, agent_id, agent_release_id)
    REFERENCES public.agent_releases(workspace_id, agent_id, id),
  CONSTRAINT agent_deployment_revisions_experience_release_fkey
    FOREIGN KEY (workspace_id, experience_id, experience_release_id)
    REFERENCES public.experience_releases(workspace_id, experience_id, id),
  CONSTRAINT agent_deployment_revisions_policy_profile_fkey FOREIGN KEY (
    workspace_id, policy_profile_id, policy_profile_version_id, policy_profile_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT agent_deployment_revisions_entry_grant_policy_fkey FOREIGN KEY (
    workspace_id, entry_grant_policy_id, entry_grant_policy_version_id,
    entry_grant_policy_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT agent_deployment_revisions_entry_scope_policy_fkey FOREIGN KEY (
    workspace_id, entry_scope_policy_id, entry_scope_policy_version_id,
    entry_scope_policy_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT agent_deployment_revisions_browser_shape_check CHECK (
    (
      ingress_channel = 'browser'
      AND cardinality(allowed_origins) > 0
      AND cardinality(browser_client_channels) > 0
      AND browser_client_channels <@ ARRAY['WEB_SDK', 'DINGTALK_WEB']::text[]
      AND session_token_audience = 'agent_browser_api'
    ) OR (
      ingress_channel <> 'browser'
      AND cardinality(allowed_origins) = 0
      AND cardinality(browser_client_channels) = 0
      AND session_token_audience IS NULL
    )
  ),
  CONSTRAINT agent_deployment_revisions_identity_document_check CHECK (
    canonical_document::jsonb ->> 'workspace_id' = workspace_id::text
    AND canonical_document::jsonb ->> 'agent_deployment_id' = agent_deployment_id::text
    AND canonical_document::jsonb ->> 'agent_deployment_revision_id' = id::text
    AND canonical_document::jsonb ->> 'agent_id' = agent_id::text
    AND canonical_document::jsonb ->> 'revision_contract_hash' = revision_contract_hash
  )
);

CREATE TABLE public.agent_deployment_credential_mappings (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_deployment_revision_id uuid NOT NULL,
  requirement_id text NOT NULL CHECK (length(btrim(requirement_id)) > 0),
  provider_id text NOT NULL CHECK (length(btrim(provider_id)) > 0),
  audience text NOT NULL CHECK (length(btrim(audience)) > 0),
  allowed_scopes text[] NOT NULL CHECK (cardinality(allowed_scopes) > 0),
  principal_mode text NOT NULL CHECK (principal_mode IN ('caller_delegated', 'service_principal', 'team_shared')),
  credential_source_kind text NOT NULL CHECK (credential_source_kind IN (
    'oauth_delegation_policy', 'service_principal_policy', 'team_credential_policy'
  )),
  principal_source text,
  service_principal_id uuid,
  team_credential_policy_id uuid,
  credential_policy_id uuid NOT NULL,
  credential_policy_version_id uuid NOT NULL,
  credential_policy_contract_hash text NOT NULL
    CHECK (credential_policy_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  mapping_hash text NOT NULL CHECK (mapping_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (workspace_id, agent_deployment_revision_id, requirement_id),
  CONSTRAINT agent_deployment_credential_mappings_revision_fkey
    FOREIGN KEY (workspace_id, agent_deployment_revision_id)
    REFERENCES public.agent_deployment_revisions(workspace_id, id),
  CONSTRAINT agent_deployment_credential_mappings_policy_fkey FOREIGN KEY (
    workspace_id, credential_policy_id, credential_policy_version_id,
    credential_policy_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT agent_deployment_credential_mappings_mode_check CHECK (
    (
      principal_mode = 'caller_delegated'
      AND credential_source_kind = 'oauth_delegation_policy'
      AND principal_source = 'authenticated_end_user'
      AND service_principal_id IS NULL
      AND team_credential_policy_id IS NULL
    ) OR (
      principal_mode = 'service_principal'
      AND credential_source_kind = 'service_principal_policy'
      AND principal_source IS NULL
      AND service_principal_id IS NOT NULL
      AND team_credential_policy_id IS NULL
    ) OR (
      principal_mode = 'team_shared'
      AND credential_source_kind = 'team_credential_policy'
      AND principal_source IS NULL
      AND service_principal_id IS NULL
      AND team_credential_policy_id IS NOT NULL
    )
  )
);

CREATE TABLE public.agent_deployment_active_pointers (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_deployment_id uuid NOT NULL,
  active_revision_id uuid NOT NULL,
  activation_epoch bigint NOT NULL CHECK (activation_epoch > 0),
  activated_by text NOT NULL CHECK (length(btrim(activated_by)) > 0),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_deployment_id),
  CONSTRAINT agent_deployment_active_pointers_deployment_fkey
    FOREIGN KEY (workspace_id, agent_deployment_id)
    REFERENCES public.agent_deployments(workspace_id, id),
  CONSTRAINT agent_deployment_active_pointers_revision_fkey
    FOREIGN KEY (workspace_id, agent_deployment_id, active_revision_id)
    REFERENCES public.agent_deployment_revisions(workspace_id, agent_deployment_id, id)
);

CREATE TABLE public.agent_deployment_entry_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  credential_id uuid NOT NULL,
  agent_deployment_id uuid NOT NULL,
  credential_kind text NOT NULL CHECK (credential_kind IN ('publish', 'service_api')),
  principal_mode text NOT NULL CHECK (principal_mode IN (
    'issuer_asserted_end_user', 'credential_service_principal'
  )),
  entry_audience text NOT NULL CHECK (entry_audience IN (
    'browser_session_exchange', 'agent_runtime_api'
  )),
  ingress_channel text NOT NULL CHECK (ingress_channel IN ('browser', 'service_api')),
  scope text NOT NULL CHECK (scope IN (
    'browser-session:exchange',
    'agent:conversation:write',
    'agent:conversation:read',
    'agent:run:create',
    'run:read',
    'run:cancel',
    'run:resume',
    'run:events:read'
  )),
  target_cardinality text NOT NULL CHECK (target_cardinality = 'exactly_one_agent_deployment'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  authorization_epoch bigint NOT NULL DEFAULT 0 CHECK (authorization_epoch >= 0),
  not_before_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_deployment_entry_grants_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT agent_deployment_entry_grants_credential_fkey
    FOREIGN KEY (workspace_id, credential_id, credential_kind)
    REFERENCES public.api_credentials(workspace_id, id, credential_kind),
  CONSTRAINT agent_deployment_entry_grants_deployment_fkey
    FOREIGN KEY (workspace_id, agent_deployment_id)
    REFERENCES public.agent_deployments(workspace_id, id),
  CONSTRAINT agent_deployment_entry_grants_tuple_check CHECK (
    (
      credential_kind = 'publish'
      AND principal_mode = 'issuer_asserted_end_user'
      AND entry_audience = 'browser_session_exchange'
      AND ingress_channel = 'browser'
      AND scope = 'browser-session:exchange'
    ) OR (
      credential_kind = 'service_api'
      AND principal_mode = 'credential_service_principal'
      AND entry_audience = 'agent_runtime_api'
      AND ingress_channel = 'service_api'
      AND scope <> 'browser-session:exchange'
    )
  ),
  CONSTRAINT agent_deployment_entry_grants_lifecycle_check CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT agent_deployment_entry_grants_window_check CHECK (
    expires_at IS NULL OR not_before_at IS NULL OR expires_at > not_before_at
  )
);

CREATE UNIQUE INDEX agent_deployment_entry_grants_active_target_key
  ON public.agent_deployment_entry_grants(workspace_id, credential_id, scope)
  WHERE status = 'ACTIVE';

CREATE TABLE public.flow_deployments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  flow_id uuid NOT NULL,
  public_selector text NOT NULL CHECK (
    length(btrim(public_selector)) > 0 AND length(public_selector) <= 255
  ),
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  ingress_channel text NOT NULL CHECK (ingress_channel IN ('service_api', 'internal_preview')),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_deployments_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT flow_deployments_stable_axes_key
    UNIQUE (workspace_id, id, flow_id, environment, ingress_channel),
  CONSTRAINT flow_deployments_workspace_selector_key UNIQUE (workspace_id, public_selector)
);

CREATE TABLE public.flow_deployment_security_states (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  flow_deployment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  revoke_epoch bigint NOT NULL DEFAULT 0 CHECK (revoke_epoch >= 0),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, flow_deployment_id),
  CONSTRAINT flow_deployment_security_states_deployment_fkey
    FOREIGN KEY (workspace_id, flow_deployment_id)
    REFERENCES public.flow_deployments(workspace_id, id)
);

CREATE TABLE public.flow_deployment_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  flow_deployment_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  ingress_channel text NOT NULL CHECK (ingress_channel IN ('service_api', 'internal_preview')),
  flow_version_id uuid NOT NULL,
  flow_version_contract_hash text NOT NULL
    CHECK (flow_version_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  policy_profile_id uuid NOT NULL,
  policy_profile_version_id uuid NOT NULL,
  policy_profile_contract_hash text NOT NULL
    CHECK (policy_profile_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  entry_grant_policy_id uuid NOT NULL,
  entry_grant_policy_version_id uuid NOT NULL,
  entry_grant_policy_contract_hash text NOT NULL
    CHECK (entry_grant_policy_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  entry_scope_policy_id uuid NOT NULL,
  entry_scope_policy_version_id uuid NOT NULL,
  entry_scope_policy_contract_hash text NOT NULL
    CHECK (entry_scope_policy_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  credential_mapping_hash text NOT NULL
    CHECK (credential_mapping_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  change_set_hash text NOT NULL CHECK (change_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  revision_contract_hash text NOT NULL
    CHECK (revision_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_document text NOT NULL CHECK (
    jsonb_typeof(canonical_document::jsonb) = 'object'
    AND canonical_document::jsonb ->> 'schema_version' = 'flow-deployment/1'
  ),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_deployment_revisions_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT flow_deployment_revisions_deployment_id_key
    UNIQUE (workspace_id, flow_deployment_id, id),
  CONSTRAINT flow_deployment_revisions_stable_axes_fkey FOREIGN KEY (
    workspace_id, flow_deployment_id, flow_id, environment, ingress_channel
  ) REFERENCES public.flow_deployments (
    workspace_id, id, flow_id, environment, ingress_channel
  ),
  CONSTRAINT flow_deployment_revisions_flow_version_fkey
    FOREIGN KEY (workspace_id, flow_id, flow_version_id)
    REFERENCES public.flow_versions(workspace_id, flow_id, id),
  CONSTRAINT flow_deployment_revisions_policy_profile_fkey FOREIGN KEY (
    workspace_id, policy_profile_id, policy_profile_version_id, policy_profile_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT flow_deployment_revisions_entry_grant_policy_fkey FOREIGN KEY (
    workspace_id, entry_grant_policy_id, entry_grant_policy_version_id,
    entry_grant_policy_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT flow_deployment_revisions_entry_scope_policy_fkey FOREIGN KEY (
    workspace_id, entry_scope_policy_id, entry_scope_policy_version_id,
    entry_scope_policy_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT flow_deployment_revisions_identity_document_check CHECK (
    canonical_document::jsonb ->> 'workspace_id' = workspace_id::text
    AND canonical_document::jsonb ->> 'flow_deployment_id' = flow_deployment_id::text
    AND canonical_document::jsonb ->> 'flow_deployment_revision_id' = id::text
    AND canonical_document::jsonb ->> 'flow_id' = flow_id::text
    AND canonical_document::jsonb ->> 'revision_contract_hash' = revision_contract_hash
  )
);

CREATE TABLE public.flow_deployment_credential_mappings (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  flow_deployment_revision_id uuid NOT NULL,
  requirement_id text NOT NULL CHECK (length(btrim(requirement_id)) > 0),
  provider_id text NOT NULL CHECK (length(btrim(provider_id)) > 0),
  audience text NOT NULL CHECK (length(btrim(audience)) > 0),
  allowed_scopes text[] NOT NULL CHECK (cardinality(allowed_scopes) > 0),
  principal_mode text NOT NULL CHECK (principal_mode IN ('caller_delegated', 'service_principal', 'team_shared')),
  credential_source_kind text NOT NULL CHECK (credential_source_kind IN (
    'oauth_delegation_policy', 'service_principal_policy', 'team_credential_policy'
  )),
  principal_source text,
  service_principal_id uuid,
  team_credential_policy_id uuid,
  credential_policy_id uuid NOT NULL,
  credential_policy_version_id uuid NOT NULL,
  credential_policy_contract_hash text NOT NULL
    CHECK (credential_policy_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  mapping_hash text NOT NULL CHECK (mapping_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (workspace_id, flow_deployment_revision_id, requirement_id),
  CONSTRAINT flow_deployment_credential_mappings_revision_fkey
    FOREIGN KEY (workspace_id, flow_deployment_revision_id)
    REFERENCES public.flow_deployment_revisions(workspace_id, id),
  CONSTRAINT flow_deployment_credential_mappings_policy_fkey FOREIGN KEY (
    workspace_id, credential_policy_id, credential_policy_version_id,
    credential_policy_contract_hash
  ) REFERENCES public.deployment_policy_versions (
    workspace_id, policy_id, id, contract_hash
  ),
  CONSTRAINT flow_deployment_credential_mappings_mode_check CHECK (
    (
      principal_mode = 'caller_delegated'
      AND credential_source_kind = 'oauth_delegation_policy'
      AND principal_source = 'authenticated_end_user'
      AND service_principal_id IS NULL
      AND team_credential_policy_id IS NULL
    ) OR (
      principal_mode = 'service_principal'
      AND credential_source_kind = 'service_principal_policy'
      AND principal_source IS NULL
      AND service_principal_id IS NOT NULL
      AND team_credential_policy_id IS NULL
    ) OR (
      principal_mode = 'team_shared'
      AND credential_source_kind = 'team_credential_policy'
      AND principal_source IS NULL
      AND service_principal_id IS NULL
      AND team_credential_policy_id IS NOT NULL
    )
  )
);

CREATE TABLE public.flow_deployment_active_pointers (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  flow_deployment_id uuid NOT NULL,
  active_revision_id uuid NOT NULL,
  activation_epoch bigint NOT NULL CHECK (activation_epoch > 0),
  activated_by text NOT NULL CHECK (length(btrim(activated_by)) > 0),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, flow_deployment_id),
  CONSTRAINT flow_deployment_active_pointers_deployment_fkey
    FOREIGN KEY (workspace_id, flow_deployment_id)
    REFERENCES public.flow_deployments(workspace_id, id),
  CONSTRAINT flow_deployment_active_pointers_revision_fkey
    FOREIGN KEY (workspace_id, flow_deployment_id, active_revision_id)
    REFERENCES public.flow_deployment_revisions(workspace_id, flow_deployment_id, id)
);

CREATE TABLE public.flow_deployment_entry_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  credential_id uuid NOT NULL,
  flow_deployment_id uuid NOT NULL,
  credential_kind text NOT NULL CHECK (credential_kind = 'service_api'),
  principal_mode text NOT NULL CHECK (principal_mode = 'credential_service_principal'),
  entry_audience text NOT NULL CHECK (entry_audience = 'flow_runtime_api'),
  ingress_channel text NOT NULL CHECK (ingress_channel = 'service_api'),
  scope text NOT NULL CHECK (scope IN (
    'flow:run:create',
    'run:read',
    'run:cancel',
    'run:resume',
    'run:events:read'
  )),
  target_cardinality text NOT NULL CHECK (target_cardinality = 'exactly_one_flow_deployment'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  authorization_epoch bigint NOT NULL DEFAULT 0 CHECK (authorization_epoch >= 0),
  not_before_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_deployment_entry_grants_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT flow_deployment_entry_grants_credential_fkey
    FOREIGN KEY (workspace_id, credential_id, credential_kind)
    REFERENCES public.api_credentials(workspace_id, id, credential_kind),
  CONSTRAINT flow_deployment_entry_grants_deployment_fkey
    FOREIGN KEY (workspace_id, flow_deployment_id)
    REFERENCES public.flow_deployments(workspace_id, id),
  CONSTRAINT flow_deployment_entry_grants_lifecycle_check CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT flow_deployment_entry_grants_window_check CHECK (
    expires_at IS NULL OR not_before_at IS NULL OR expires_at > not_before_at
  )
);

CREATE UNIQUE INDEX flow_deployment_entry_grants_active_target_key
  ON public.flow_deployment_entry_grants(workspace_id, credential_id, scope)
  WHERE status = 'ACTIVE';

CREATE TABLE public.deployment_promotion_audits (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  deployment_kind text NOT NULL CHECK (deployment_kind IN ('agent', 'flow')),
  deployment_id uuid NOT NULL,
  previous_revision_id uuid,
  activated_revision_id uuid NOT NULL,
  activation_epoch bigint NOT NULL CHECK (activation_epoch > 0),
  actor_principal_id text NOT NULL CHECK (length(btrim(actor_principal_id)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT deployment_promotion_audits_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT deployment_promotion_audits_epoch_key
    UNIQUE (workspace_id, deployment_kind, deployment_id, activation_epoch)
);

CREATE TABLE public.browser_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_deployment_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  assertion_use_id uuid NOT NULL,
  client_channel text NOT NULL CHECK (client_channel IN ('WEB_SDK', 'DINGTALK_WEB')),
  canonical_origin text NOT NULL CHECK (auth.is_canonical_https_origin(canonical_origin)),
  token_audience text NOT NULL CHECK (token_audience = 'agent_browser_api'),
  observed_principal_session_epoch bigint NOT NULL CHECK (observed_principal_session_epoch >= 0),
  observed_deployment_revoke_epoch bigint NOT NULL CHECK (observed_deployment_revoke_epoch >= 0),
  session_epoch bigint NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT browser_sessions_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT browser_sessions_assertion_use_key UNIQUE (workspace_id, assertion_use_id),
  CONSTRAINT browser_sessions_deployment_fkey
    FOREIGN KEY (workspace_id, agent_deployment_id)
    REFERENCES public.agent_deployments(workspace_id, id),
  CONSTRAINT browser_sessions_principal_fkey
    FOREIGN KEY (workspace_id, principal_id)
    REFERENCES public.end_user_principals(workspace_id, id),
  CONSTRAINT browser_sessions_assertion_fkey
    FOREIGN KEY (workspace_id, assertion_use_id)
    REFERENCES public.browser_subject_assertion_uses(workspace_id, id),
  CONSTRAINT browser_sessions_lifecycle_check CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT browser_sessions_ttl_check CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'
  )
);

CREATE TABLE auth.browser_session_auth_index (
  browser_session_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  verifier_hmac bytea NOT NULL CHECK (octet_length(verifier_hmac) = 32),
  verifier_algorithm text NOT NULL CHECK (verifier_algorithm = 'hmac-sha-256'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  session_epoch bigint NOT NULL CHECK (session_epoch >= 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT browser_session_auth_index_workspace_id_id_key
    UNIQUE (workspace_id, browser_session_id),
  CONSTRAINT browser_session_auth_index_public_session_fkey
    FOREIGN KEY (workspace_id, browser_session_id)
    REFERENCES public.browser_sessions(workspace_id, id),
  CONSTRAINT browser_session_auth_index_lifecycle_check CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX published_resource_dependencies_dependency_idx
  ON public.published_resource_dependencies (
    workspace_id, dependency_kind, dependency_resource_id, dependency_resource_version_id
  );
CREATE INDEX agent_deployment_revisions_deployment_idx
  ON public.agent_deployment_revisions(workspace_id, agent_deployment_id, created_at);
CREATE INDEX flow_deployment_revisions_deployment_idx
  ON public.flow_deployment_revisions(workspace_id, flow_deployment_id, created_at);
CREATE INDEX browser_sessions_active_idx
  ON public.browser_sessions(workspace_id, agent_deployment_id, expires_at)
  WHERE status = 'ACTIVE';
CREATE INDEX browser_session_auth_index_active_idx
  ON auth.browser_session_auth_index(workspace_id, expires_at)
  WHERE status = 'ACTIVE';

CREATE FUNCTION auth.require_release_draft(
  p_workspace_id uuid,
  p_draft_revision_id uuid,
  p_kind text,
  p_resource_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.publishable_resource_draft_revisions AS draft
     WHERE draft.workspace_id = p_workspace_id
       AND draft.id = p_draft_revision_id
       AND draft.published_resource_kind = p_kind
       AND draft.resource_id = p_resource_id
  ) THEN
    RAISE EXCEPTION 'release source draft does not match the typed resource root'
      USING ERRCODE = '23503';
  END IF;
END;
$function$;
ALTER FUNCTION auth.require_release_draft(uuid, uuid, text, uuid)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION auth.require_release_draft(uuid, uuid, text, uuid) FROM PUBLIC;

CREATE FUNCTION auth.register_prepared_published_resource(
  p_prepared jsonb,
  p_expected_kind text,
  p_expected_schema_version text,
  p_source_subkind text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_pin jsonb := p_prepared -> 'full_pin';
  v_manifest jsonb := p_prepared -> 'dependency_manifest';
  v_document_text text := p_prepared ->> 'canonical_document';
  v_document jsonb;
  v_resource_id uuid;
  v_resource_version_id uuid;
  v_contract_hash text;
  v_dependency jsonb;
  v_ordinal bigint;
BEGIN
  IF p_prepared IS NULL
     OR jsonb_typeof(p_prepared) <> 'object'
     OR p_prepared ->> 'schema_version' <> 'prepared-published-resource/1'
     OR jsonb_typeof(v_pin) <> 'object'
     OR jsonb_typeof(v_manifest) <> 'object'
     OR v_document_text IS NULL THEN
    RAISE EXCEPTION 'invalid prepared published resource envelope'
      USING ERRCODE = '22023';
  END IF;

  v_document := v_document_text::jsonb;
  v_resource_id := (v_pin ->> 'resource_id')::uuid;
  v_resource_version_id := (v_pin ->> 'resource_version_id')::uuid;
  v_contract_hash := v_pin ->> 'contract_hash';

  IF v_pin ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_pin ->> 'published_resource_kind' IS DISTINCT FROM p_expected_kind
     OR v_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR v_contract_hash !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(v_document) <> 'object'
     OR v_document ->> 'schema_version' IS DISTINCT FROM p_expected_schema_version
     OR v_manifest ->> 'schema_version'
       IS DISTINCT FROM 'published-resource-dependency-manifest/1'
     OR v_manifest -> 'owner' ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_manifest -> 'owner' ->> 'published_resource_kind' IS DISTINCT FROM p_expected_kind
     OR v_manifest -> 'owner' ->> 'resource_id' IS DISTINCT FROM v_resource_id::text
     OR v_manifest -> 'owner' ->> 'resource_version_id'
       IS DISTINCT FROM v_resource_version_id::text
     OR v_manifest ->> 'manifest_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(v_manifest -> 'dependencies') <> 'array' THEN
    RAISE EXCEPTION 'prepared resource identity, schema or manifest mismatch'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.published_resource_versions (
    workspace_id,
    published_resource_kind,
    resource_id,
    resource_version_id,
    contract_hash,
    dependency_manifest_hash,
    source_schema_version,
    source_subkind,
    canonical_document,
    published_by
  ) VALUES (
    v_workspace_id,
    p_expected_kind,
    v_resource_id,
    v_resource_version_id,
    v_contract_hash,
    v_manifest ->> 'manifest_hash',
    p_expected_schema_version,
    p_source_subkind,
    v_document_text,
    v_actor
  );

  FOR v_dependency, v_ordinal IN
    SELECT dependency.value, dependency.ordinality - 1
      FROM jsonb_array_elements(v_manifest -> 'dependencies')
        WITH ORDINALITY AS dependency(value, ordinality)
  LOOP
    IF v_dependency ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
       OR v_dependency ->> 'binding_mode' IS DISTINCT FROM 'pinned'
       OR v_dependency ->> 'published_resource_kind' NOT IN (
         'AGENT_STRATEGY_RELEASE',
         'AGENT_RELEASE',
         'FLOW_VERSION',
         'EXPERIENCE_RELEASE',
         'DEPLOYMENT_REVISION'
       )
       OR v_dependency ->> 'contract_hash' !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'dependency manifest contains an invalid or cross-workspace pin'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.published_resource_dependencies (
      workspace_id,
      owner_kind,
      owner_resource_id,
      owner_resource_version_id,
      dependency_kind,
      dependency_resource_id,
      dependency_resource_version_id,
      dependency_contract_hash,
      binding_mode,
      ordinal
    ) VALUES (
      v_workspace_id,
      p_expected_kind,
      v_resource_id,
      v_resource_version_id,
      v_dependency ->> 'published_resource_kind',
      (v_dependency ->> 'resource_id')::uuid,
      (v_dependency ->> 'resource_version_id')::uuid,
      v_dependency ->> 'contract_hash',
      'pinned',
      v_ordinal::integer
    );
  END LOOP;
END;
$function$;
ALTER FUNCTION auth.register_prepared_published_resource(jsonb, text, text, text)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION auth.register_prepared_published_resource(jsonb, text, text, text)
  FROM PUBLIC;

CREATE FUNCTION app.create_publishable_resource_root(
  p_published_resource_kind text,
  p_resource_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
BEGIN
  IF p_resource_id IS NULL OR p_published_resource_kind NOT IN (
    'AGENT_STRATEGY_RELEASE', 'AGENT_RELEASE', 'FLOW_VERSION', 'EXPERIENCE_RELEASE'
  ) THEN
    RAISE EXCEPTION 'unsupported publishable resource root'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.publishable_resource_roots (
    workspace_id, published_resource_kind, resource_id, created_by
  ) VALUES (
    v_workspace_id, p_published_resource_kind, p_resource_id, v_actor
  );
  RETURN p_resource_id;
END;
$function$;

CREATE FUNCTION app.append_publishable_resource_draft_revision(
  p_draft_revision_id uuid,
  p_published_resource_kind text,
  p_resource_id uuid,
  p_revision bigint,
  p_editor_document jsonb,
  p_semantic_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_expected_revision bigint;
BEGIN
  IF p_draft_revision_id IS NULL
     OR p_published_resource_kind NOT IN (
       'AGENT_STRATEGY_RELEASE', 'AGENT_RELEASE', 'FLOW_VERSION', 'EXPERIENCE_RELEASE'
     )
     OR p_resource_id IS NULL
     OR p_revision IS NULL OR p_revision <= 0
     OR p_editor_document IS NULL OR jsonb_typeof(p_editor_document) <> 'object'
     OR p_semantic_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid typed draft revision'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM public.publishable_resource_roots AS root
   WHERE root.workspace_id = v_workspace_id
     AND root.published_resource_kind = p_published_resource_kind
     AND root.resource_id = p_resource_id
   FOR UPDATE OF root;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'typed draft resource root does not exist'
      USING ERRCODE = '23503';
  END IF;
  SELECT COALESCE(max(draft.revision), 0) + 1
    INTO v_expected_revision
    FROM public.publishable_resource_draft_revisions AS draft
   WHERE draft.workspace_id = v_workspace_id
     AND draft.published_resource_kind = p_published_resource_kind
     AND draft.resource_id = p_resource_id;
  IF p_revision <> v_expected_revision THEN
    RAISE EXCEPTION 'draft revision must append the next monotonic number'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.publishable_resource_draft_revisions (
    id,
    workspace_id,
    published_resource_kind,
    resource_id,
    revision,
    editor_document,
    semantic_hash,
    created_by
  ) VALUES (
    p_draft_revision_id,
    v_workspace_id,
    p_published_resource_kind,
    p_resource_id,
    p_revision,
    p_editor_document,
    p_semantic_hash,
    v_actor
  );
  RETURN p_draft_revision_id;
END;
$function$;

CREATE FUNCTION app.publish_agent_strategy_release(p_prepared jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_document_text text := p_prepared ->> 'canonical_document';
  v_document jsonb := v_document_text::jsonb;
  v_strategy_id uuid := (v_document ->> 'strategy_id')::uuid;
  v_release_id uuid := (v_document ->> 'strategy_release_id')::uuid;
  v_draft_id uuid := (v_document ->> 'source_draft_revision_id')::uuid;
BEGIN
  IF p_prepared -> 'full_pin' ->> 'resource_id' IS DISTINCT FROM v_strategy_id::text
     OR p_prepared -> 'full_pin' ->> 'resource_version_id'
       IS DISTINCT FROM v_release_id::text
     OR p_prepared -> 'full_pin' ->> 'contract_hash'
       IS DISTINCT FROM v_document ->> 'contract_hash' THEN
    RAISE EXCEPTION 'Strategy Release prepared identity or contract hash mismatch'
      USING ERRCODE = '22023';
  END IF;
  PERFORM auth.require_release_draft(
    v_workspace_id, v_draft_id, 'AGENT_STRATEGY_RELEASE', v_strategy_id
  );
  INSERT INTO public.agent_strategy_releases (
    id, workspace_id, strategy_id, source_draft_revision_id, contract_hash,
    dependency_manifest_hash, canonical_document, created_by
  ) VALUES (
    v_release_id, v_workspace_id, v_strategy_id, v_draft_id,
    p_prepared -> 'full_pin' ->> 'contract_hash',
    p_prepared -> 'dependency_manifest' ->> 'manifest_hash',
    v_document_text, v_actor
  );
  PERFORM auth.register_prepared_published_resource(
    p_prepared, 'AGENT_STRATEGY_RELEASE', 'agent-strategy-release/1', NULL
  );
  RETURN v_release_id;
END;
$function$;

CREATE FUNCTION app.publish_agent_release(p_prepared jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_document_text text := p_prepared ->> 'canonical_document';
  v_document jsonb := v_document_text::jsonb;
  v_agent_id uuid := (v_document ->> 'agent_id')::uuid;
  v_release_id uuid := (v_document ->> 'agent_release_id')::uuid;
  v_draft_id uuid := (v_document ->> 'source_draft_revision_id')::uuid;
BEGIN
  IF p_prepared -> 'full_pin' ->> 'resource_id' IS DISTINCT FROM v_agent_id::text
     OR p_prepared -> 'full_pin' ->> 'resource_version_id'
       IS DISTINCT FROM v_release_id::text THEN
    RAISE EXCEPTION 'Agent Release prepared identity mismatch'
      USING ERRCODE = '22023';
  END IF;
  PERFORM auth.require_release_draft(
    v_workspace_id, v_draft_id, 'AGENT_RELEASE', v_agent_id
  );
  INSERT INTO public.agent_releases (
    id, workspace_id, agent_id, source_draft_revision_id, contract_hash,
    dependency_manifest_hash, canonical_document, created_by
  ) VALUES (
    v_release_id, v_workspace_id, v_agent_id, v_draft_id,
    p_prepared -> 'full_pin' ->> 'contract_hash',
    p_prepared -> 'dependency_manifest' ->> 'manifest_hash',
    v_document_text, v_actor
  );
  PERFORM auth.register_prepared_published_resource(
    p_prepared, 'AGENT_RELEASE', 'agent-release/1', NULL
  );

  INSERT INTO public.published_resource_credential_requirements (
    workspace_id, owner_kind, owner_resource_id, owner_resource_version_id,
    owner_contract_hash, requirement_id, provider_id, audience,
    required_scopes, allowed_principal_modes
  )
  SELECT
    v_workspace_id,
    'AGENT_RELEASE',
    v_agent_id,
    v_release_id,
    p_prepared -> 'full_pin' ->> 'contract_hash',
    binding.value -> 'credential_requirement' ->> 'requirement_id',
    binding.value -> 'credential_requirement' ->> 'provider_id',
    binding.value -> 'credential_requirement' ->> 'audience',
    ARRAY(
      SELECT jsonb_array_elements_text(
        binding.value -> 'credential_requirement' -> 'required_scopes'
      )
      ORDER BY 1
    ),
    ARRAY(
      SELECT jsonb_array_elements_text(
        binding.value -> 'credential_requirement' -> 'allowed_principal_modes'
      )
      ORDER BY 1
    )
  FROM jsonb_array_elements(v_document -> 'capability_bindings') AS binding(value)
  WHERE (binding.value ->> 'enabled')::boolean
    AND binding.value ? 'credential_requirement';

  INSERT INTO public.agent_release_public_capability_handles (
    workspace_id, agent_id, agent_release_id, public_handle, binding_id,
    operation_contract_hash, input_schema_hash, enabled
  )
  SELECT
    v_workspace_id,
    v_agent_id,
    v_release_id,
    handle.value ->> 'public_handle',
    handle.value ->> 'binding_id',
    handle.value ->> 'operation_contract_hash',
    handle.value ->> 'input_schema_hash',
    COALESCE((
      SELECT (binding.value ->> 'enabled')::boolean
        FROM jsonb_array_elements(v_document -> 'capability_bindings') AS binding(value)
       WHERE binding.value ->> 'binding_id' = handle.value ->> 'binding_id'
    ), false)
  FROM jsonb_array_elements(v_document -> 'public_capability_handles') AS handle(value);
  RETURN v_release_id;
END;
$function$;

CREATE FUNCTION app.publish_flow_version(p_prepared jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_document_text text := p_prepared ->> 'canonical_document';
  v_document jsonb := v_document_text::jsonb;
  v_flow_id uuid := (v_document ->> 'flow_id')::uuid;
  v_version_id uuid := (v_document ->> 'flow_version_id')::uuid;
BEGIN
  IF p_prepared -> 'full_pin' ->> 'resource_id' IS DISTINCT FROM v_flow_id::text
     OR p_prepared -> 'full_pin' ->> 'resource_version_id'
       IS DISTINCT FROM v_version_id::text
     OR NOT EXISTS (
       SELECT 1 FROM public.publishable_resource_roots AS root
        WHERE root.workspace_id = v_workspace_id
          AND root.published_resource_kind = 'FLOW_VERSION'
          AND root.resource_id = v_flow_id
     ) THEN
    RAISE EXCEPTION 'Flow Version prepared identity or resource root mismatch'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.flow_versions (
    id, workspace_id, flow_id, source_draft_revision_id, contract_hash,
    dependency_manifest_hash, canonical_document, created_by
  ) VALUES (
    v_version_id, v_workspace_id, v_flow_id, NULL,
    p_prepared -> 'full_pin' ->> 'contract_hash',
    p_prepared -> 'dependency_manifest' ->> 'manifest_hash',
    v_document_text, v_actor
  );
  PERFORM auth.register_prepared_published_resource(
    p_prepared, 'FLOW_VERSION', 'flow-ir/1', NULL
  );
  INSERT INTO public.published_resource_credential_requirements (
    workspace_id, owner_kind, owner_resource_id, owner_resource_version_id,
    owner_contract_hash, requirement_id, provider_id, audience,
    required_scopes, allowed_principal_modes
  )
  SELECT
    v_workspace_id,
    'FLOW_VERSION',
    v_flow_id,
    v_version_id,
    p_prepared -> 'full_pin' ->> 'contract_hash',
    requirement.value ->> 'requirement_id',
    requirement.value ->> 'provider_id',
    requirement.value ->> 'audience',
    ARRAY(
      SELECT jsonb_array_elements_text(requirement.value -> 'required_scopes') ORDER BY 1
    ),
    ARRAY(
      SELECT jsonb_array_elements_text(requirement.value -> 'allowed_principal_modes') ORDER BY 1
    )
  FROM jsonb_array_elements(v_document -> 'credential_requirements') AS requirement(value);
  RETURN v_version_id;
END;
$function$;

CREATE FUNCTION app.publish_experience_release(p_prepared jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_document_text text := p_prepared ->> 'canonical_document';
  v_document jsonb := v_document_text::jsonb;
  v_experience_id uuid := (v_document ->> 'experience_id')::uuid;
  v_release_id uuid := (v_document ->> 'experience_release_id')::uuid;
  v_draft_id uuid := (v_document ->> 'source_draft_revision_id')::uuid;
BEGIN
  IF p_prepared -> 'full_pin' ->> 'resource_id' IS DISTINCT FROM v_experience_id::text
     OR p_prepared -> 'full_pin' ->> 'resource_version_id'
       IS DISTINCT FROM v_release_id::text
     OR p_prepared -> 'full_pin' ->> 'contract_hash'
       IS DISTINCT FROM v_document ->> 'content_hash' THEN
    RAISE EXCEPTION 'Experience Release prepared identity or content hash mismatch'
      USING ERRCODE = '22023';
  END IF;
  PERFORM auth.require_release_draft(
    v_workspace_id, v_draft_id, 'EXPERIENCE_RELEASE', v_experience_id
  );
  INSERT INTO public.experience_releases (
    id, workspace_id, experience_id, compatible_agent_id,
    source_draft_revision_id, content_hash, dependency_manifest_hash,
    canonical_document, created_by
  ) VALUES (
    v_release_id,
    v_workspace_id,
    v_experience_id,
    (v_document ->> 'compatible_agent_id')::uuid,
    v_draft_id,
    p_prepared -> 'full_pin' ->> 'contract_hash',
    p_prepared -> 'dependency_manifest' ->> 'manifest_hash',
    v_document_text,
    v_actor
  );
  PERFORM auth.register_prepared_published_resource(
    p_prepared, 'EXPERIENCE_RELEASE', 'experience-release/1', NULL
  );
  INSERT INTO public.experience_release_quick_entries (
    workspace_id, experience_id, experience_release_id, quick_entry_id,
    label, public_handle, operation_contract_hash, input_schema_hash, default_inputs
  )
  SELECT
    v_workspace_id,
    v_experience_id,
    v_release_id,
    entry.value ->> 'quick_entry_id',
    entry.value ->> 'label',
    entry.value ->> 'public_handle',
    entry.value ->> 'operation_contract_hash',
    entry.value ->> 'input_schema_hash',
    entry.value -> 'default_inputs'
  FROM jsonb_array_elements(v_document -> 'quick_entries') AS entry(value);
  RETURN v_release_id;
END;
$function$;

CREATE FUNCTION app.publish_deployment_policy_version(
  p_policy_version_id uuid,
  p_policy_id uuid,
  p_policy_kind text,
  p_contract_hash text,
  p_canonical_document text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
BEGIN
  IF p_policy_version_id IS NULL
     OR p_policy_id IS NULL
     OR p_policy_kind NOT IN (
       'deployment_profile', 'entry_grant', 'entry_scope',
       'oauth_delegation', 'service_principal', 'team_credential'
     )
     OR p_contract_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_canonical_document IS NULL
     OR jsonb_typeof(p_canonical_document::jsonb) <> 'object' THEN
    RAISE EXCEPTION 'invalid immutable Deployment policy version'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.deployment_policy_versions (
    id, workspace_id, policy_id, policy_kind, contract_hash,
    canonical_document, created_by
  ) VALUES (
    p_policy_version_id, v_workspace_id, p_policy_id, p_policy_kind,
    p_contract_hash, p_canonical_document, v_actor
  );
  RETURN p_policy_version_id;
END;
$function$;

CREATE FUNCTION app.create_agent_deployment(p_stable jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_deployment_id uuid := (p_stable ->> 'agent_deployment_id')::uuid;
  v_agent_id uuid := (p_stable ->> 'agent_id')::uuid;
BEGIN
  IF p_stable IS NULL
     OR jsonb_typeof(p_stable) <> 'object'
     OR p_stable ->> 'schema_version' <> 'agent-deployment-stable/1'
     OR p_stable ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR p_stable ->> 'environment' NOT IN ('development', 'staging', 'production')
     OR p_stable ->> 'ingress_channel' NOT IN ('browser', 'service_api', 'internal_preview')
     OR length(btrim(p_stable ->> 'public_selector')) = 0 THEN
    RAISE EXCEPTION 'invalid stable Agent Deployment contract'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.agent_deployments (
    id, workspace_id, agent_id, public_selector, environment,
    ingress_channel, created_by
  ) VALUES (
    v_deployment_id, v_workspace_id, v_agent_id,
    p_stable ->> 'public_selector', p_stable ->> 'environment',
    p_stable ->> 'ingress_channel', v_actor
  );
  INSERT INTO public.agent_deployment_security_states (
    workspace_id, agent_deployment_id, status, revoke_epoch, updated_by
  ) VALUES (v_workspace_id, v_deployment_id, 'SUSPENDED', 0, v_actor);
  INSERT INTO public.publishable_resource_roots (
    workspace_id, published_resource_kind, resource_id, created_by
  ) VALUES (v_workspace_id, 'DEPLOYMENT_REVISION', v_deployment_id, v_actor);
  RETURN v_deployment_id;
END;
$function$;

CREATE FUNCTION app.create_flow_deployment(p_stable jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_deployment_id uuid := (p_stable ->> 'flow_deployment_id')::uuid;
  v_flow_id uuid := (p_stable ->> 'flow_id')::uuid;
BEGIN
  IF p_stable IS NULL
     OR jsonb_typeof(p_stable) <> 'object'
     OR p_stable ->> 'schema_version' <> 'flow-deployment-stable/1'
     OR p_stable ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR p_stable ->> 'environment' NOT IN ('development', 'staging', 'production')
     OR p_stable ->> 'ingress_channel' NOT IN ('service_api', 'internal_preview')
     OR length(btrim(p_stable ->> 'public_selector')) = 0 THEN
    RAISE EXCEPTION 'invalid stable Flow Deployment contract'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.flow_deployments (
    id, workspace_id, flow_id, public_selector, environment,
    ingress_channel, created_by
  ) VALUES (
    v_deployment_id, v_workspace_id, v_flow_id,
    p_stable ->> 'public_selector', p_stable ->> 'environment',
    p_stable ->> 'ingress_channel', v_actor
  );
  INSERT INTO public.flow_deployment_security_states (
    workspace_id, flow_deployment_id, status, revoke_epoch, updated_by
  ) VALUES (v_workspace_id, v_deployment_id, 'SUSPENDED', 0, v_actor);
  INSERT INTO public.publishable_resource_roots (
    workspace_id, published_resource_kind, resource_id, created_by
  ) VALUES (v_workspace_id, 'DEPLOYMENT_REVISION', v_deployment_id, v_actor);
  RETURN v_deployment_id;
END;
$function$;

CREATE FUNCTION app.publish_agent_deployment_revision(p_prepared jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_document_text text := p_prepared ->> 'canonical_document';
  v_document jsonb := v_document_text::jsonb;
  v_deployment_id uuid := (v_document ->> 'agent_deployment_id')::uuid;
  v_revision_id uuid := (v_document ->> 'agent_deployment_revision_id')::uuid;
  v_agent_id uuid := (v_document ->> 'agent_id')::uuid;
  v_agent_release_id uuid := (v_document -> 'agent_release' ->> 'resource_version_id')::uuid;
  v_experience_id uuid := (v_document -> 'experience_release' ->> 'resource_id')::uuid;
  v_experience_release_id uuid :=
    (v_document -> 'experience_release' ->> 'resource_version_id')::uuid;
BEGIN
  IF p_prepared -> 'full_pin' ->> 'published_resource_kind' <> 'DEPLOYMENT_REVISION'
     OR p_prepared -> 'full_pin' ->> 'resource_id' IS DISTINCT FROM v_deployment_id::text
     OR p_prepared -> 'full_pin' ->> 'resource_version_id'
       IS DISTINCT FROM v_revision_id::text
     OR p_prepared -> 'full_pin' ->> 'contract_hash'
       IS DISTINCT FROM v_document ->> 'revision_contract_hash'
     OR NOT EXISTS (
       SELECT 1
         FROM public.agent_deployments AS deployment
        WHERE deployment.workspace_id = v_workspace_id
          AND deployment.id = v_deployment_id
          AND deployment.agent_id = v_agent_id
          AND deployment.environment = v_document ->> 'environment'
          AND deployment.ingress_channel = v_document ->> 'ingress_channel'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.agent_releases AS release
        WHERE release.workspace_id = v_workspace_id
          AND release.id = v_agent_release_id
          AND release.agent_id = v_agent_id
          AND release.contract_hash = v_document -> 'agent_release' ->> 'contract_hash'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.experience_releases AS release
        WHERE release.workspace_id = v_workspace_id
          AND release.id = v_experience_release_id
          AND release.experience_id = v_experience_id
          AND release.compatible_agent_id = v_agent_id
          AND release.content_hash = v_document -> 'experience_release' ->> 'contract_hash'
     ) THEN
    RAISE EXCEPTION 'Agent Deployment stable axes or Release pins mismatch'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.deployment_policy_versions AS policy
     WHERE policy.workspace_id = v_workspace_id
       AND policy.policy_kind = 'deployment_profile'
       AND policy.policy_id = (v_document -> 'policy_profile' ->> 'policy_id')::uuid
       AND policy.id = (v_document -> 'policy_profile' ->> 'policy_version_id')::uuid
       AND policy.contract_hash = v_document -> 'policy_profile' ->> 'contract_hash'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.deployment_policy_versions AS policy
     WHERE policy.workspace_id = v_workspace_id
       AND policy.policy_kind = 'entry_grant'
       AND policy.policy_id = (v_document -> 'entry_grant_policy' ->> 'policy_id')::uuid
       AND policy.id = (v_document -> 'entry_grant_policy' ->> 'policy_version_id')::uuid
       AND policy.contract_hash = v_document -> 'entry_grant_policy' ->> 'contract_hash'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.deployment_policy_versions AS policy
     WHERE policy.workspace_id = v_workspace_id
       AND policy.policy_kind = 'entry_scope'
       AND policy.policy_id = (v_document -> 'entry_scope_policy' ->> 'policy_id')::uuid
       AND policy.id = (v_document -> 'entry_scope_policy' ->> 'policy_version_id')::uuid
       AND policy.contract_hash = v_document -> 'entry_scope_policy' ->> 'contract_hash'
  ) THEN
    RAISE EXCEPTION 'Agent Deployment policy pins are missing or have the wrong type'
      USING ERRCODE = '23503';
  END IF;

  IF v_document ->> 'ingress_channel' = 'browser' AND (
    jsonb_typeof(v_document -> 'allowed_origins') <> 'array'
    OR jsonb_typeof(v_document -> 'browser_client_channels') <> 'array'
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(v_document -> 'allowed_origins') AS origin(value)
       WHERE NOT auth.is_canonical_https_origin(origin.value)
    )
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          v_document -> 'browser_client_channels'
        ) AS channel(value)
       WHERE channel.value NOT IN ('WEB_SDK', 'DINGTALK_WEB')
    )
  ) THEN
    RAISE EXCEPTION 'Agent browser Deployment origin or client-channel policy is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.agent_deployment_revisions (
    id, workspace_id, agent_deployment_id, agent_id, environment, ingress_channel,
    agent_release_id, agent_release_contract_hash,
    experience_id, experience_release_id, experience_contract_hash,
    policy_profile_id, policy_profile_version_id, policy_profile_contract_hash,
    entry_grant_policy_id, entry_grant_policy_version_id,
    entry_grant_policy_contract_hash,
    entry_scope_policy_id, entry_scope_policy_version_id,
    entry_scope_policy_contract_hash,
    credential_mapping_hash, dependency_manifest_hash, change_set_hash,
    revision_contract_hash, allowed_origins, browser_client_channels,
    session_token_audience, canonical_document, created_by
  ) VALUES (
    v_revision_id, v_workspace_id, v_deployment_id, v_agent_id,
    v_document ->> 'environment', v_document ->> 'ingress_channel',
    v_agent_release_id, v_document -> 'agent_release' ->> 'contract_hash',
    v_experience_id, v_experience_release_id,
    v_document -> 'experience_release' ->> 'contract_hash',
    (v_document -> 'policy_profile' ->> 'policy_id')::uuid,
    (v_document -> 'policy_profile' ->> 'policy_version_id')::uuid,
    v_document -> 'policy_profile' ->> 'contract_hash',
    (v_document -> 'entry_grant_policy' ->> 'policy_id')::uuid,
    (v_document -> 'entry_grant_policy' ->> 'policy_version_id')::uuid,
    v_document -> 'entry_grant_policy' ->> 'contract_hash',
    (v_document -> 'entry_scope_policy' ->> 'policy_id')::uuid,
    (v_document -> 'entry_scope_policy' ->> 'policy_version_id')::uuid,
    v_document -> 'entry_scope_policy' ->> 'contract_hash',
    v_document ->> 'credential_mapping_hash',
    v_document ->> 'dependency_manifest_hash',
    v_document ->> 'change_set_hash',
    v_document ->> 'revision_contract_hash',
    CASE WHEN v_document ->> 'ingress_channel' = 'browser' THEN ARRAY(
      SELECT jsonb_array_elements_text(v_document -> 'allowed_origins') ORDER BY 1
    ) ELSE '{}'::text[] END,
    CASE WHEN v_document ->> 'ingress_channel' = 'browser' THEN ARRAY(
      SELECT jsonb_array_elements_text(v_document -> 'browser_client_channels') ORDER BY 1
    ) ELSE '{}'::text[] END,
    v_document ->> 'session_token_audience',
    v_document_text,
    v_actor
  );

  INSERT INTO public.agent_deployment_credential_mappings (
    workspace_id, agent_deployment_revision_id, requirement_id, provider_id,
    audience, allowed_scopes, principal_mode, credential_source_kind,
    principal_source, service_principal_id, team_credential_policy_id,
    credential_policy_id, credential_policy_version_id,
    credential_policy_contract_hash, mapping_hash
  )
  SELECT
    v_workspace_id,
    v_revision_id,
    mapping.value ->> 'requirement_id',
    mapping.value ->> 'provider_id',
    mapping.value ->> 'audience',
    ARRAY(SELECT jsonb_array_elements_text(mapping.value -> 'allowed_scopes') ORDER BY 1),
    mapping.value ->> 'principal_mode',
    mapping.value ->> 'credential_source_kind',
    mapping.value ->> 'principal_source',
    NULLIF(mapping.value ->> 'service_principal_id', '')::uuid,
    NULLIF(mapping.value ->> 'team_credential_policy_id', '')::uuid,
    (mapping.value -> 'credential_policy' ->> 'policy_id')::uuid,
    (mapping.value -> 'credential_policy' ->> 'policy_version_id')::uuid,
    mapping.value -> 'credential_policy' ->> 'contract_hash',
    mapping.value ->> 'mapping_hash'
  FROM jsonb_array_elements(v_document -> 'credential_mappings') AS mapping(value);

  IF EXISTS (
    SELECT 1
      FROM public.agent_deployment_credential_mappings AS mapping
      LEFT JOIN public.published_resource_credential_requirements AS requirement
        ON requirement.workspace_id = mapping.workspace_id
       AND requirement.owner_kind = 'AGENT_RELEASE'
       AND requirement.owner_resource_id = v_agent_id
       AND requirement.owner_resource_version_id = v_agent_release_id
       AND requirement.requirement_id = mapping.requirement_id
     WHERE mapping.workspace_id = v_workspace_id
       AND mapping.agent_deployment_revision_id = v_revision_id
       AND (
         requirement.requirement_id IS NULL
         OR requirement.provider_id IS DISTINCT FROM mapping.provider_id
         OR requirement.audience IS DISTINCT FROM mapping.audience
         OR requirement.required_scopes IS DISTINCT FROM mapping.allowed_scopes
         OR NOT mapping.principal_mode = ANY(requirement.allowed_principal_modes)
       )
  ) OR (
    SELECT count(*)
      FROM public.agent_deployment_credential_mappings AS mapping
     WHERE mapping.workspace_id = v_workspace_id
       AND mapping.agent_deployment_revision_id = v_revision_id
  ) <> (
    SELECT count(*)
      FROM public.published_resource_credential_requirements AS requirement
     WHERE requirement.workspace_id = v_workspace_id
       AND requirement.owner_kind = 'AGENT_RELEASE'
       AND requirement.owner_resource_id = v_agent_id
       AND requirement.owner_resource_version_id = v_agent_release_id
  ) OR EXISTS (
    SELECT 1
      FROM public.agent_deployment_credential_mappings AS mapping
      JOIN public.deployment_policy_versions AS policy
        ON policy.workspace_id = mapping.workspace_id
       AND policy.id = mapping.credential_policy_version_id
       AND policy.policy_id = mapping.credential_policy_id
       AND policy.contract_hash = mapping.credential_policy_contract_hash
     WHERE mapping.workspace_id = v_workspace_id
       AND mapping.agent_deployment_revision_id = v_revision_id
       AND policy.policy_kind IS DISTINCT FROM CASE mapping.credential_source_kind
         WHEN 'oauth_delegation_policy' THEN 'oauth_delegation'
         WHEN 'service_principal_policy' THEN 'service_principal'
         WHEN 'team_credential_policy' THEN 'team_credential'
       END
  ) OR EXISTS (
    SELECT 1
      FROM public.experience_release_quick_entries AS entry
      LEFT JOIN public.agent_release_public_capability_handles AS handle
        ON handle.workspace_id = entry.workspace_id
       AND handle.agent_release_id = v_agent_release_id
       AND handle.public_handle = entry.public_handle
       AND handle.operation_contract_hash = entry.operation_contract_hash
       AND handle.input_schema_hash = entry.input_schema_hash
       AND handle.enabled
     WHERE entry.workspace_id = v_workspace_id
       AND entry.experience_release_id = v_experience_release_id
       AND handle.public_handle IS NULL
  ) THEN
    RAISE EXCEPTION 'Agent Deployment assembly is incomplete or incompatible'
      USING ERRCODE = '23514';
  END IF;

  PERFORM auth.register_prepared_published_resource(
    p_prepared, 'DEPLOYMENT_REVISION', 'agent-deployment/1', 'agent'
  );
  RETURN v_revision_id;
END;
$function$;

CREATE FUNCTION app.publish_flow_deployment_revision(p_prepared jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_document_text text := p_prepared ->> 'canonical_document';
  v_document jsonb := v_document_text::jsonb;
  v_deployment_id uuid := (v_document ->> 'flow_deployment_id')::uuid;
  v_revision_id uuid := (v_document ->> 'flow_deployment_revision_id')::uuid;
  v_flow_id uuid := (v_document ->> 'flow_id')::uuid;
  v_flow_version_id uuid := (v_document -> 'flow_version' ->> 'resource_version_id')::uuid;
BEGIN
  IF p_prepared -> 'full_pin' ->> 'published_resource_kind' <> 'DEPLOYMENT_REVISION'
     OR p_prepared -> 'full_pin' ->> 'resource_id' IS DISTINCT FROM v_deployment_id::text
     OR p_prepared -> 'full_pin' ->> 'resource_version_id'
       IS DISTINCT FROM v_revision_id::text
     OR p_prepared -> 'full_pin' ->> 'contract_hash'
       IS DISTINCT FROM v_document ->> 'revision_contract_hash'
     OR NOT EXISTS (
       SELECT 1
         FROM public.flow_deployments AS deployment
        WHERE deployment.workspace_id = v_workspace_id
          AND deployment.id = v_deployment_id
          AND deployment.flow_id = v_flow_id
          AND deployment.environment = v_document ->> 'environment'
          AND deployment.ingress_channel = v_document ->> 'ingress_channel'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.flow_versions AS version
        WHERE version.workspace_id = v_workspace_id
          AND version.id = v_flow_version_id
          AND version.flow_id = v_flow_id
          AND version.contract_hash = v_document -> 'flow_version' ->> 'contract_hash'
     ) THEN
    RAISE EXCEPTION 'Flow Deployment stable axes or Flow Version pin mismatch'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.deployment_policy_versions AS policy
     WHERE policy.workspace_id = v_workspace_id
       AND policy.policy_kind = 'deployment_profile'
       AND policy.policy_id = (v_document -> 'policy_profile' ->> 'policy_id')::uuid
       AND policy.id = (v_document -> 'policy_profile' ->> 'policy_version_id')::uuid
       AND policy.contract_hash = v_document -> 'policy_profile' ->> 'contract_hash'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.deployment_policy_versions AS policy
     WHERE policy.workspace_id = v_workspace_id
       AND policy.policy_kind = 'entry_grant'
       AND policy.policy_id = (v_document -> 'entry_grant_policy' ->> 'policy_id')::uuid
       AND policy.id = (v_document -> 'entry_grant_policy' ->> 'policy_version_id')::uuid
       AND policy.contract_hash = v_document -> 'entry_grant_policy' ->> 'contract_hash'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.deployment_policy_versions AS policy
     WHERE policy.workspace_id = v_workspace_id
       AND policy.policy_kind = 'entry_scope'
       AND policy.policy_id = (v_document -> 'entry_scope_policy' ->> 'policy_id')::uuid
       AND policy.id = (v_document -> 'entry_scope_policy' ->> 'policy_version_id')::uuid
       AND policy.contract_hash = v_document -> 'entry_scope_policy' ->> 'contract_hash'
  ) THEN
    RAISE EXCEPTION 'Flow Deployment policy pins are missing or have the wrong type'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.flow_deployment_revisions (
    id, workspace_id, flow_deployment_id, flow_id, environment, ingress_channel,
    flow_version_id, flow_version_contract_hash,
    policy_profile_id, policy_profile_version_id, policy_profile_contract_hash,
    entry_grant_policy_id, entry_grant_policy_version_id,
    entry_grant_policy_contract_hash,
    entry_scope_policy_id, entry_scope_policy_version_id,
    entry_scope_policy_contract_hash,
    credential_mapping_hash, dependency_manifest_hash, change_set_hash,
    revision_contract_hash, canonical_document, created_by
  ) VALUES (
    v_revision_id, v_workspace_id, v_deployment_id, v_flow_id,
    v_document ->> 'environment', v_document ->> 'ingress_channel',
    v_flow_version_id, v_document -> 'flow_version' ->> 'contract_hash',
    (v_document -> 'policy_profile' ->> 'policy_id')::uuid,
    (v_document -> 'policy_profile' ->> 'policy_version_id')::uuid,
    v_document -> 'policy_profile' ->> 'contract_hash',
    (v_document -> 'entry_grant_policy' ->> 'policy_id')::uuid,
    (v_document -> 'entry_grant_policy' ->> 'policy_version_id')::uuid,
    v_document -> 'entry_grant_policy' ->> 'contract_hash',
    (v_document -> 'entry_scope_policy' ->> 'policy_id')::uuid,
    (v_document -> 'entry_scope_policy' ->> 'policy_version_id')::uuid,
    v_document -> 'entry_scope_policy' ->> 'contract_hash',
    v_document ->> 'credential_mapping_hash',
    v_document ->> 'dependency_manifest_hash',
    v_document ->> 'change_set_hash',
    v_document ->> 'revision_contract_hash',
    v_document_text,
    v_actor
  );

  INSERT INTO public.flow_deployment_credential_mappings (
    workspace_id, flow_deployment_revision_id, requirement_id, provider_id,
    audience, allowed_scopes, principal_mode, credential_source_kind,
    principal_source, service_principal_id, team_credential_policy_id,
    credential_policy_id, credential_policy_version_id,
    credential_policy_contract_hash, mapping_hash
  )
  SELECT
    v_workspace_id,
    v_revision_id,
    mapping.value ->> 'requirement_id',
    mapping.value ->> 'provider_id',
    mapping.value ->> 'audience',
    ARRAY(SELECT jsonb_array_elements_text(mapping.value -> 'allowed_scopes') ORDER BY 1),
    mapping.value ->> 'principal_mode',
    mapping.value ->> 'credential_source_kind',
    mapping.value ->> 'principal_source',
    NULLIF(mapping.value ->> 'service_principal_id', '')::uuid,
    NULLIF(mapping.value ->> 'team_credential_policy_id', '')::uuid,
    (mapping.value -> 'credential_policy' ->> 'policy_id')::uuid,
    (mapping.value -> 'credential_policy' ->> 'policy_version_id')::uuid,
    mapping.value -> 'credential_policy' ->> 'contract_hash',
    mapping.value ->> 'mapping_hash'
  FROM jsonb_array_elements(v_document -> 'credential_mappings') AS mapping(value);

  IF EXISTS (
    SELECT 1
      FROM public.flow_deployment_credential_mappings AS mapping
      LEFT JOIN public.published_resource_credential_requirements AS requirement
        ON requirement.workspace_id = mapping.workspace_id
       AND requirement.owner_kind = 'FLOW_VERSION'
       AND requirement.owner_resource_id = v_flow_id
       AND requirement.owner_resource_version_id = v_flow_version_id
       AND requirement.requirement_id = mapping.requirement_id
     WHERE mapping.workspace_id = v_workspace_id
       AND mapping.flow_deployment_revision_id = v_revision_id
       AND (
         requirement.requirement_id IS NULL
         OR requirement.provider_id IS DISTINCT FROM mapping.provider_id
         OR requirement.audience IS DISTINCT FROM mapping.audience
         OR requirement.required_scopes IS DISTINCT FROM mapping.allowed_scopes
         OR NOT mapping.principal_mode = ANY(requirement.allowed_principal_modes)
       )
  ) OR (
    SELECT count(*)
      FROM public.flow_deployment_credential_mappings AS mapping
     WHERE mapping.workspace_id = v_workspace_id
       AND mapping.flow_deployment_revision_id = v_revision_id
  ) <> (
    SELECT count(*)
      FROM public.published_resource_credential_requirements AS requirement
     WHERE requirement.workspace_id = v_workspace_id
       AND requirement.owner_kind = 'FLOW_VERSION'
       AND requirement.owner_resource_id = v_flow_id
       AND requirement.owner_resource_version_id = v_flow_version_id
  ) OR EXISTS (
    SELECT 1
      FROM public.flow_deployment_credential_mappings AS mapping
      JOIN public.deployment_policy_versions AS policy
        ON policy.workspace_id = mapping.workspace_id
       AND policy.id = mapping.credential_policy_version_id
       AND policy.policy_id = mapping.credential_policy_id
       AND policy.contract_hash = mapping.credential_policy_contract_hash
     WHERE mapping.workspace_id = v_workspace_id
       AND mapping.flow_deployment_revision_id = v_revision_id
       AND policy.policy_kind IS DISTINCT FROM CASE mapping.credential_source_kind
         WHEN 'oauth_delegation_policy' THEN 'oauth_delegation'
         WHEN 'service_principal_policy' THEN 'service_principal'
         WHEN 'team_credential_policy' THEN 'team_credential'
       END
  ) THEN
    RAISE EXCEPTION 'Flow Deployment credential mapping assembly is incomplete'
      USING ERRCODE = '23514';
  END IF;

  PERFORM auth.register_prepared_published_resource(
    p_prepared, 'DEPLOYMENT_REVISION', 'flow-deployment/1', 'flow'
  );
  RETURN v_revision_id;
END;
$function$;

CREATE FUNCTION app.create_agent_deployment_entry_grant(p_grant jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_grant_id uuid := (p_grant ->> 'entry_grant_id')::uuid;
  v_credential_id uuid := (p_grant ->> 'credential_id')::uuid;
  v_deployment_id uuid := (p_grant ->> 'agent_deployment_id')::uuid;
BEGIN
  PERFORM 1
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = v_credential_id
     AND credential.credential_kind = p_grant ->> 'credential_kind'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
   FOR UPDATE OF credential;
  IF NOT FOUND
     OR p_grant ->> 'schema_version' <> 'agent-deployment-entry-grant/1'
     OR p_grant ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR p_grant ->> 'status' <> 'ACTIVE'
     OR COALESCE((p_grant ->> 'authorization_epoch')::bigint, -1) <> 0
     OR p_grant ? 'revoked_at'
     OR NOT EXISTS (
       SELECT 1
         FROM public.api_credential_scopes AS scope_row
        WHERE scope_row.workspace_id = v_workspace_id
          AND scope_row.credential_id = v_credential_id
          AND scope_row.credential_kind = p_grant ->> 'credential_kind'
          AND scope_row.scope = p_grant ->> 'scope'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.agent_deployments AS deployment
        WHERE deployment.workspace_id = v_workspace_id
          AND deployment.id = v_deployment_id
          AND deployment.ingress_channel = p_grant ->> 'ingress_channel'
     ) THEN
    RAISE EXCEPTION 'Agent Deployment entry grant is not eligible'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.agent_deployment_entry_grants (
    id, workspace_id, credential_id, agent_deployment_id, credential_kind,
    principal_mode, entry_audience, ingress_channel, scope,
    target_cardinality, status, authorization_epoch, not_before_at,
    expires_at, revoked_at, created_by
  ) VALUES (
    v_grant_id, v_workspace_id, v_credential_id, v_deployment_id,
    p_grant ->> 'credential_kind', p_grant ->> 'principal_mode',
    p_grant ->> 'entry_audience', p_grant ->> 'ingress_channel',
    p_grant ->> 'scope', p_grant ->> 'target_cardinality', 'ACTIVE', 0,
    (p_grant ->> 'not_before_at')::timestamptz,
    (p_grant ->> 'expires_at')::timestamptz,
    NULL,
    v_actor
  );
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'agent_deployment_entry_grant', v_grant_id,
    p_grant ->> 'scope', 0
  );
  RETURN v_grant_id;
END;
$function$;

CREATE FUNCTION app.create_flow_deployment_entry_grant(p_grant jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_grant_id uuid := (p_grant ->> 'entry_grant_id')::uuid;
  v_credential_id uuid := (p_grant ->> 'credential_id')::uuid;
  v_deployment_id uuid := (p_grant ->> 'flow_deployment_id')::uuid;
BEGIN
  PERFORM 1
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = v_credential_id
     AND credential.credential_kind = 'service_api'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
   FOR UPDATE OF credential;
  IF NOT FOUND
     OR p_grant ->> 'schema_version' <> 'flow-deployment-entry-grant/1'
     OR p_grant ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR p_grant ->> 'credential_kind' <> 'service_api'
     OR p_grant ->> 'status' <> 'ACTIVE'
     OR COALESCE((p_grant ->> 'authorization_epoch')::bigint, -1) <> 0
     OR p_grant ? 'revoked_at'
     OR NOT EXISTS (
       SELECT 1
         FROM public.api_credential_scopes AS scope_row
        WHERE scope_row.workspace_id = v_workspace_id
          AND scope_row.credential_id = v_credential_id
          AND scope_row.credential_kind = 'service_api'
          AND scope_row.scope = p_grant ->> 'scope'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.flow_deployments AS deployment
        WHERE deployment.workspace_id = v_workspace_id
          AND deployment.id = v_deployment_id
          AND deployment.ingress_channel = 'service_api'
     ) THEN
    RAISE EXCEPTION 'Flow Deployment entry grant is not eligible'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.flow_deployment_entry_grants (
    id, workspace_id, credential_id, flow_deployment_id, credential_kind,
    principal_mode, entry_audience, ingress_channel, scope,
    target_cardinality, status, authorization_epoch, not_before_at,
    expires_at, revoked_at, created_by
  ) VALUES (
    v_grant_id, v_workspace_id, v_credential_id, v_deployment_id,
    'service_api', p_grant ->> 'principal_mode', p_grant ->> 'entry_audience',
    p_grant ->> 'ingress_channel', p_grant ->> 'scope',
    p_grant ->> 'target_cardinality', 'ACTIVE', 0,
    (p_grant ->> 'not_before_at')::timestamptz,
    (p_grant ->> 'expires_at')::timestamptz,
    NULL,
    v_actor
  );
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'flow_deployment_entry_grant', v_grant_id,
    p_grant ->> 'scope', 0
  );
  RETURN v_grant_id;
END;
$function$;

CREATE FUNCTION app.revoke_agent_deployment_entry_grant(
  p_entry_grant_id uuid,
  p_expected_authorization_epoch bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_new_epoch bigint;
  v_scope text;
BEGIN
  UPDATE public.agent_deployment_entry_grants
     SET status = 'REVOKED',
         authorization_epoch = authorization_epoch + 1,
         revoked_at = clock_timestamp()
   WHERE workspace_id = v_workspace_id
     AND id = p_entry_grant_id
     AND status = 'ACTIVE'
     AND authorization_epoch = p_expected_authorization_epoch
  RETURNING authorization_epoch, scope INTO v_new_epoch, v_scope;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent entry grant revoke compare-and-swap failed'
      USING ERRCODE = '40001';
  END IF;
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'agent_deployment_entry_grant', p_entry_grant_id,
    v_scope, v_new_epoch
  );
  RETURN v_new_epoch;
END;
$function$;

CREATE FUNCTION app.revoke_flow_deployment_entry_grant(
  p_entry_grant_id uuid,
  p_expected_authorization_epoch bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_new_epoch bigint;
  v_scope text;
BEGIN
  UPDATE public.flow_deployment_entry_grants
     SET status = 'REVOKED',
         authorization_epoch = authorization_epoch + 1,
         revoked_at = clock_timestamp()
   WHERE workspace_id = v_workspace_id
     AND id = p_entry_grant_id
     AND status = 'ACTIVE'
     AND authorization_epoch = p_expected_authorization_epoch
  RETURNING authorization_epoch, scope INTO v_new_epoch, v_scope;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow entry grant revoke compare-and-swap failed'
      USING ERRCODE = '40001';
  END IF;
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'flow_deployment_entry_grant', p_entry_grant_id,
    v_scope, v_new_epoch
  );
  RETURN v_new_epoch;
END;
$function$;

CREATE FUNCTION app.promote_agent_deployment(
  p_agent_deployment_id uuid,
  p_revision_id uuid,
  p_expected_activation_epoch bigint,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_environment text;
  v_previous_revision_id uuid;
  v_current_epoch bigint;
  v_new_epoch bigint;
BEGIN
  SELECT deployment.environment
    INTO v_environment
    FROM public.agent_deployments AS deployment
   WHERE deployment.workspace_id = v_workspace_id
     AND deployment.id = p_agent_deployment_id
   FOR UPDATE OF deployment;
  IF NOT FOUND OR p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Agent Deployment promotion target or reason is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF v_environment = 'production' THEN
    RAISE EXCEPTION 'production activation requires the later human-gated release path'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.agent_deployment_revisions AS revision
   WHERE revision.workspace_id = v_workspace_id
     AND revision.agent_deployment_id = p_agent_deployment_id
     AND revision.id = p_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent Deployment revision does not belong to the stable target'
      USING ERRCODE = '23503';
  END IF;

  SELECT pointer.active_revision_id, pointer.activation_epoch
    INTO v_previous_revision_id, v_current_epoch
    FROM public.agent_deployment_active_pointers AS pointer
   WHERE pointer.workspace_id = v_workspace_id
     AND pointer.agent_deployment_id = p_agent_deployment_id
   FOR UPDATE OF pointer;
  IF NOT FOUND THEN
    IF p_expected_activation_epoch <> 0 THEN
      RAISE EXCEPTION 'Agent Deployment promotion compare-and-swap failed'
        USING ERRCODE = '40001';
    END IF;
    v_new_epoch := 1;
    INSERT INTO public.agent_deployment_active_pointers (
      workspace_id, agent_deployment_id, active_revision_id,
      activation_epoch, activated_by
    ) VALUES (
      v_workspace_id, p_agent_deployment_id, p_revision_id, v_new_epoch, v_actor
    );
  ELSE
    IF v_current_epoch <> p_expected_activation_epoch THEN
      RAISE EXCEPTION 'Agent Deployment promotion compare-and-swap failed'
        USING ERRCODE = '40001';
    END IF;
    v_new_epoch := v_current_epoch + 1;
    UPDATE public.agent_deployment_active_pointers
       SET active_revision_id = p_revision_id,
           activation_epoch = v_new_epoch,
           activated_by = v_actor,
           activated_at = clock_timestamp()
     WHERE workspace_id = v_workspace_id
       AND agent_deployment_id = p_agent_deployment_id;
  END IF;
  INSERT INTO public.deployment_promotion_audits (
    id, workspace_id, deployment_kind, deployment_id,
    previous_revision_id, activated_revision_id, activation_epoch,
    actor_principal_id, reason
  ) VALUES (
    public.gen_random_uuid(), v_workspace_id, 'agent', p_agent_deployment_id,
    v_previous_revision_id, p_revision_id, v_new_epoch, v_actor, p_reason
  );
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'agent_deployment', p_agent_deployment_id,
    'activation', v_new_epoch
  );
  RETURN v_new_epoch;
END;
$function$;

CREATE FUNCTION app.promote_flow_deployment(
  p_flow_deployment_id uuid,
  p_revision_id uuid,
  p_expected_activation_epoch bigint,
  p_reason text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_environment text;
  v_previous_revision_id uuid;
  v_current_epoch bigint;
  v_new_epoch bigint;
BEGIN
  SELECT deployment.environment
    INTO v_environment
    FROM public.flow_deployments AS deployment
   WHERE deployment.workspace_id = v_workspace_id
     AND deployment.id = p_flow_deployment_id
   FOR UPDATE OF deployment;
  IF NOT FOUND OR p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Flow Deployment promotion target or reason is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF v_environment = 'production' THEN
    RAISE EXCEPTION 'production activation requires the later human-gated release path'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.flow_deployment_revisions AS revision
   WHERE revision.workspace_id = v_workspace_id
     AND revision.flow_deployment_id = p_flow_deployment_id
     AND revision.id = p_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow Deployment revision does not belong to the stable target'
      USING ERRCODE = '23503';
  END IF;
  SELECT pointer.active_revision_id, pointer.activation_epoch
    INTO v_previous_revision_id, v_current_epoch
    FROM public.flow_deployment_active_pointers AS pointer
   WHERE pointer.workspace_id = v_workspace_id
     AND pointer.flow_deployment_id = p_flow_deployment_id
   FOR UPDATE OF pointer;
  IF NOT FOUND THEN
    IF p_expected_activation_epoch <> 0 THEN
      RAISE EXCEPTION 'Flow Deployment promotion compare-and-swap failed'
        USING ERRCODE = '40001';
    END IF;
    v_new_epoch := 1;
    INSERT INTO public.flow_deployment_active_pointers (
      workspace_id, flow_deployment_id, active_revision_id,
      activation_epoch, activated_by
    ) VALUES (
      v_workspace_id, p_flow_deployment_id, p_revision_id, v_new_epoch, v_actor
    );
  ELSE
    IF v_current_epoch <> p_expected_activation_epoch THEN
      RAISE EXCEPTION 'Flow Deployment promotion compare-and-swap failed'
        USING ERRCODE = '40001';
    END IF;
    v_new_epoch := v_current_epoch + 1;
    UPDATE public.flow_deployment_active_pointers
       SET active_revision_id = p_revision_id,
           activation_epoch = v_new_epoch,
           activated_by = v_actor,
           activated_at = clock_timestamp()
     WHERE workspace_id = v_workspace_id
       AND flow_deployment_id = p_flow_deployment_id;
  END IF;
  INSERT INTO public.deployment_promotion_audits (
    id, workspace_id, deployment_kind, deployment_id,
    previous_revision_id, activated_revision_id, activation_epoch,
    actor_principal_id, reason
  ) VALUES (
    public.gen_random_uuid(), v_workspace_id, 'flow', p_flow_deployment_id,
    v_previous_revision_id, p_revision_id, v_new_epoch, v_actor, p_reason
  );
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'flow_deployment', p_flow_deployment_id,
    'activation', v_new_epoch
  );
  RETURN v_new_epoch;
END;
$function$;

CREATE FUNCTION app.transition_agent_deployment_security(
  p_agent_deployment_id uuid,
  p_expected_revoke_epoch bigint,
  p_target_status text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_current_status text;
  v_environment text;
  v_new_epoch bigint;
BEGIN
  SELECT security.status, deployment.environment
    INTO v_current_status, v_environment
    FROM public.agent_deployment_security_states AS security
    JOIN public.agent_deployments AS deployment
      ON deployment.workspace_id = security.workspace_id
     AND deployment.id = security.agent_deployment_id
   WHERE security.workspace_id = v_workspace_id
     AND security.agent_deployment_id = p_agent_deployment_id
     AND security.revoke_epoch = p_expected_revoke_epoch
   FOR UPDATE OF security;
  IF NOT FOUND
     OR p_target_status NOT IN ('ACTIVE', 'SUSPENDED', 'REVOKED')
     OR v_current_status = 'REVOKED'
     OR v_current_status = p_target_status
     OR (p_target_status = 'ACTIVE' AND NOT EXISTS (
       SELECT 1 FROM public.agent_deployment_active_pointers AS pointer
        WHERE pointer.workspace_id = v_workspace_id
          AND pointer.agent_deployment_id = p_agent_deployment_id
     )) THEN
    RAISE EXCEPTION 'Agent Deployment security transition rejected'
      USING ERRCODE = '40001';
  END IF;
  IF p_target_status = 'ACTIVE' AND v_environment = 'production' THEN
    RAISE EXCEPTION 'production activation requires the later human-gated release path'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.agent_deployment_security_states
     SET status = p_target_status,
         revoke_epoch = revoke_epoch + 1,
         updated_by = v_actor,
         updated_at = clock_timestamp()
   WHERE workspace_id = v_workspace_id
     AND agent_deployment_id = p_agent_deployment_id
  RETURNING revoke_epoch INTO v_new_epoch;
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'agent_deployment', p_agent_deployment_id,
    'revoke', v_new_epoch
  );
  RETURN v_new_epoch;
END;
$function$;

CREATE FUNCTION app.transition_flow_deployment_security(
  p_flow_deployment_id uuid,
  p_expected_revoke_epoch bigint,
  p_target_status text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_current_status text;
  v_environment text;
  v_new_epoch bigint;
BEGIN
  SELECT security.status, deployment.environment
    INTO v_current_status, v_environment
    FROM public.flow_deployment_security_states AS security
    JOIN public.flow_deployments AS deployment
      ON deployment.workspace_id = security.workspace_id
     AND deployment.id = security.flow_deployment_id
   WHERE security.workspace_id = v_workspace_id
     AND security.flow_deployment_id = p_flow_deployment_id
     AND security.revoke_epoch = p_expected_revoke_epoch
   FOR UPDATE OF security;
  IF NOT FOUND
     OR p_target_status NOT IN ('ACTIVE', 'SUSPENDED', 'REVOKED')
     OR v_current_status = 'REVOKED'
     OR v_current_status = p_target_status
     OR (p_target_status = 'ACTIVE' AND NOT EXISTS (
       SELECT 1 FROM public.flow_deployment_active_pointers AS pointer
        WHERE pointer.workspace_id = v_workspace_id
          AND pointer.flow_deployment_id = p_flow_deployment_id
     )) THEN
    RAISE EXCEPTION 'Flow Deployment security transition rejected'
      USING ERRCODE = '40001';
  END IF;
  IF p_target_status = 'ACTIVE' AND v_environment = 'production' THEN
    RAISE EXCEPTION 'production activation requires the later human-gated release path'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.flow_deployment_security_states
     SET status = p_target_status,
         revoke_epoch = revoke_epoch + 1,
         updated_by = v_actor,
         updated_at = clock_timestamp()
   WHERE workspace_id = v_workspace_id
     AND flow_deployment_id = p_flow_deployment_id
  RETURNING revoke_epoch INTO v_new_epoch;
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'flow_deployment', p_flow_deployment_id,
    'revoke', v_new_epoch
  );
  RETURN v_new_epoch;
END;
$function$;

CREATE FUNCTION app.resolve_agent_service_admission(
  p_public_selector text,
  p_required_scope text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_credential_id uuid := app.current_api_credential_id();
  v_grant_ids uuid[];
  v_facts jsonb;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER')
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
     OR v_workspace_id IS NULL
     OR v_credential_id IS NULL
     OR p_required_scope NOT IN (
       'agent:conversation:write', 'agent:conversation:read', 'agent:run:create'
     ) THEN
    RAISE EXCEPTION 'Agent service admission requires an isolated runtime credential context'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = v_credential_id
     AND credential.credential_kind = 'service_api'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
     AND EXISTS (
       SELECT 1
         FROM public.api_credential_scopes AS scope_row
        WHERE scope_row.workspace_id = credential.workspace_id
          AND scope_row.credential_id = credential.id
          AND scope_row.credential_kind = 'service_api'
          AND scope_row.scope = p_required_scope
     )
   FOR SHARE OF credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service credential does not authorize the requested Agent scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(grant_row.id ORDER BY grant_row.id::text)
    INTO v_grant_ids
    FROM public.agent_deployment_entry_grants AS grant_row
   WHERE grant_row.workspace_id = v_workspace_id
     AND grant_row.credential_id = v_credential_id
     AND grant_row.credential_kind = 'service_api'
     AND grant_row.scope = p_required_scope
     AND grant_row.status = 'ACTIVE'
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= clock_timestamp())
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > clock_timestamp());
  IF COALESCE(cardinality(v_grant_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'Agent service credential must resolve to exactly one typed target'
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 'agent-deployment-entry-admission-facts/1',
    'deployment_kind', 'agent',
    'entry_source_kind', 'service_credential',
    'workspace_id', deployment.workspace_id,
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
    'ingress_channel', deployment.ingress_channel,
    'admission_activation_epoch', pointer.activation_epoch,
    'observed_revoke_epoch', security.revoke_epoch,
    'authenticated_principal', jsonb_build_object(
      'schema_version', 'caller-principal/1',
      'kind', 'credential',
      'credential_id', credential.id
    ),
    'credential_id', credential.id,
    'credential_authorization_epoch', credential.authorization_epoch,
    'workspace_authorization_epoch', workspace.authorization_epoch,
    'entry_grant_id', grant_row.id,
    'entry_grant_authorization_epoch', grant_row.authorization_epoch,
    'entry_credential_kind', grant_row.credential_kind,
    'entry_principal_mode', grant_row.principal_mode,
    'entry_audience', grant_row.entry_audience,
    'entry_channel', grant_row.ingress_channel,
    'entry_scope', grant_row.scope,
    'entry_target_cardinality', grant_row.target_cardinality,
    'policy_profile_contract_hash', revision.policy_profile_contract_hash,
    'entry_scope_policy_contract_hash', revision.entry_scope_policy_contract_hash,
    'credential_mapping_hash', revision.credential_mapping_hash,
    'dependency_manifest_hash', revision.dependency_manifest_hash
  )
    INTO v_facts
    FROM public.agent_deployment_entry_grants AS grant_row
    JOIN public.agent_deployments AS deployment
      ON deployment.workspace_id = grant_row.workspace_id
     AND deployment.id = grant_row.agent_deployment_id
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
    JOIN public.api_credentials AS credential
      ON credential.workspace_id = grant_row.workspace_id
     AND credential.id = grant_row.credential_id
    JOIN public.workspaces AS workspace
      ON workspace.id = deployment.workspace_id
   WHERE grant_row.workspace_id = v_workspace_id
     AND grant_row.id = v_grant_ids[1]
     AND grant_row.credential_id = v_credential_id
     AND grant_row.credential_kind = 'service_api'
     AND grant_row.principal_mode = 'credential_service_principal'
     AND grant_row.entry_audience = 'agent_runtime_api'
     AND grant_row.ingress_channel = 'service_api'
     AND grant_row.scope = p_required_scope
     AND grant_row.target_cardinality = 'exactly_one_agent_deployment'
     AND grant_row.status = 'ACTIVE'
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= clock_timestamp())
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > clock_timestamp())
     AND deployment.public_selector = p_public_selector
     AND deployment.ingress_channel = 'service_api'
     AND security.status = 'ACTIVE'
     AND credential.credential_kind = 'service_api'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
     AND EXISTS (
       SELECT 1
         FROM public.api_credential_scopes AS scope_row
        WHERE scope_row.workspace_id = credential.workspace_id
          AND scope_row.credential_id = credential.id
          AND scope_row.credential_kind = 'service_api'
          AND scope_row.scope = p_required_scope
     )
   FOR SHARE OF grant_row, deployment, security, pointer, revision, credential, workspace;
  IF v_facts IS NULL THEN
    RAISE EXCEPTION 'Agent Deployment selector, pointer or security state rejected'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_facts;
END;
$function$;

CREATE FUNCTION app.resolve_flow_service_admission(
  p_public_selector text,
  p_required_scope text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_credential_id uuid := app.current_api_credential_id();
  v_grant_ids uuid[];
  v_facts jsonb;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER')
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
     OR v_workspace_id IS NULL
     OR v_credential_id IS NULL
     OR p_required_scope <> 'flow:run:create' THEN
    RAISE EXCEPTION 'Flow service admission requires an isolated runtime credential context'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.api_credentials AS credential
   WHERE credential.workspace_id = v_workspace_id
     AND credential.id = v_credential_id
     AND credential.credential_kind = 'service_api'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
     AND EXISTS (
       SELECT 1
         FROM public.api_credential_scopes AS scope_row
        WHERE scope_row.workspace_id = credential.workspace_id
          AND scope_row.credential_id = credential.id
          AND scope_row.credential_kind = 'service_api'
          AND scope_row.scope = p_required_scope
     )
   FOR SHARE OF credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service credential does not authorize the requested Flow scope'
      USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(grant_row.id ORDER BY grant_row.id::text)
    INTO v_grant_ids
    FROM public.flow_deployment_entry_grants AS grant_row
   WHERE grant_row.workspace_id = v_workspace_id
     AND grant_row.credential_id = v_credential_id
     AND grant_row.scope = p_required_scope
     AND grant_row.status = 'ACTIVE'
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= clock_timestamp())
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > clock_timestamp());
  IF COALESCE(cardinality(v_grant_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'Flow service credential must resolve to exactly one typed target'
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 'flow-deployment-entry-admission-facts/1',
    'deployment_kind', 'flow',
    'entry_source_kind', 'service_credential',
    'workspace_id', deployment.workspace_id,
    'flow_deployment_id', deployment.id,
    'flow_deployment_revision_id', revision.id,
    'flow_deployment_revision_contract_hash', revision.revision_contract_hash,
    'flow_version', jsonb_build_object(
      'workspace_id', revision.workspace_id,
      'published_resource_kind', 'FLOW_VERSION',
      'resource_id', revision.flow_id,
      'resource_version_id', revision.flow_version_id,
      'contract_hash', revision.flow_version_contract_hash,
      'binding_mode', 'pinned'
    ),
    'environment', deployment.environment,
    'ingress_channel', deployment.ingress_channel,
    'admission_activation_epoch', pointer.activation_epoch,
    'observed_revoke_epoch', security.revoke_epoch,
    'authenticated_principal', jsonb_build_object(
      'schema_version', 'caller-principal/1',
      'kind', 'credential',
      'credential_id', credential.id
    ),
    'credential_id', credential.id,
    'credential_authorization_epoch', credential.authorization_epoch,
    'workspace_authorization_epoch', workspace.authorization_epoch,
    'entry_grant_id', grant_row.id,
    'entry_grant_authorization_epoch', grant_row.authorization_epoch,
    'entry_credential_kind', grant_row.credential_kind,
    'entry_principal_mode', grant_row.principal_mode,
    'entry_audience', grant_row.entry_audience,
    'entry_channel', grant_row.ingress_channel,
    'entry_scope', grant_row.scope,
    'entry_target_cardinality', grant_row.target_cardinality,
    'policy_profile_contract_hash', revision.policy_profile_contract_hash,
    'entry_scope_policy_contract_hash', revision.entry_scope_policy_contract_hash,
    'credential_mapping_hash', revision.credential_mapping_hash,
    'dependency_manifest_hash', revision.dependency_manifest_hash
  )
    INTO v_facts
    FROM public.flow_deployment_entry_grants AS grant_row
    JOIN public.flow_deployments AS deployment
      ON deployment.workspace_id = grant_row.workspace_id
     AND deployment.id = grant_row.flow_deployment_id
    JOIN public.flow_deployment_security_states AS security
      ON security.workspace_id = deployment.workspace_id
     AND security.flow_deployment_id = deployment.id
    JOIN public.flow_deployment_active_pointers AS pointer
      ON pointer.workspace_id = deployment.workspace_id
     AND pointer.flow_deployment_id = deployment.id
    JOIN public.flow_deployment_revisions AS revision
      ON revision.workspace_id = pointer.workspace_id
     AND revision.id = pointer.active_revision_id
     AND revision.flow_deployment_id = deployment.id
    JOIN public.api_credentials AS credential
      ON credential.workspace_id = grant_row.workspace_id
     AND credential.id = grant_row.credential_id
    JOIN public.workspaces AS workspace
      ON workspace.id = deployment.workspace_id
   WHERE grant_row.workspace_id = v_workspace_id
     AND grant_row.id = v_grant_ids[1]
     AND grant_row.credential_id = v_credential_id
     AND grant_row.credential_kind = 'service_api'
     AND grant_row.principal_mode = 'credential_service_principal'
     AND grant_row.entry_audience = 'flow_runtime_api'
     AND grant_row.ingress_channel = 'service_api'
     AND grant_row.scope = p_required_scope
     AND grant_row.target_cardinality = 'exactly_one_flow_deployment'
     AND grant_row.status = 'ACTIVE'
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= clock_timestamp())
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > clock_timestamp())
     AND deployment.public_selector = p_public_selector
     AND deployment.ingress_channel = 'service_api'
     AND security.status = 'ACTIVE'
     AND credential.credential_kind = 'service_api'
     AND credential.status IN ('active', 'overlap')
     AND credential.revoked_at IS NULL
     AND (credential.not_before_at IS NULL OR credential.not_before_at <= clock_timestamp())
     AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
     AND EXISTS (
       SELECT 1
         FROM public.api_credential_scopes AS scope_row
        WHERE scope_row.workspace_id = credential.workspace_id
          AND scope_row.credential_id = credential.id
          AND scope_row.credential_kind = 'service_api'
          AND scope_row.scope = p_required_scope
     )
   FOR SHARE OF grant_row, deployment, security, pointer, revision, credential, workspace;
  IF v_facts IS NULL THEN
    RAISE EXCEPTION 'Flow Deployment selector, pointer or security state rejected'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_facts;
END;
$function$;

CREATE FUNCTION auth.exchange_browser_subject_assertion_for_session(
  p_browser_session_id uuid,
  p_session_verifier_hmac bytea,
  p_public_selector text,
  p_client_channel text,
  p_canonical_origin text,
  p_token_audience text,
  p_session_expires_at timestamptz,
  p_issuer_config_id uuid,
  p_issuer text,
  p_subject_hash bytea,
  p_assertion_audience text,
  p_key_version integer,
  p_assertion_nonce_hash bytea,
  p_assertion_issued_at timestamptz,
  p_assertion_expires_at timestamptz
)
RETURNS TABLE (
  browser_session_id uuid,
  workspace_id uuid,
  principal_id uuid,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_credential_id uuid := app.current_api_credential_id();
  v_assertion_workspace_id uuid;
  v_assertion_use_id uuid;
  v_principal_text text;
  v_principal_id uuid;
  v_principal_session_epoch bigint;
  v_deployment_id uuid;
  v_deployment_revoke_epoch bigint;
  v_grant_ids uuid[];
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user, 'ba_subject_assertion_verifier', 'MEMBER'
  ) OR pg_catalog.pg_has_role(session_user, 'ba_runtime', 'MEMBER')
     OR v_workspace_id IS NULL
     OR v_credential_id IS NULL
     OR p_browser_session_id IS NULL
     OR p_session_verifier_hmac IS NULL
     OR octet_length(p_session_verifier_hmac) <> 32
     OR p_client_channel NOT IN ('WEB_SDK', 'DINGTALK_WEB')
     OR p_token_audience <> 'agent_browser_api'
     OR NOT auth.is_canonical_https_origin(p_canonical_origin)
     OR p_session_expires_at IS NULL
     OR p_session_expires_at <= v_now
     OR p_session_expires_at > v_now + interval '15 minutes'
     OR p_session_expires_at > p_assertion_expires_at THEN
    RAISE EXCEPTION 'invalid browser session exchange request'
      USING ERRCODE = '22023';
  END IF;

  SELECT consumed.workspace_id, consumed.assertion_use_id, consumed.principal_id
    INTO v_assertion_workspace_id, v_assertion_use_id, v_principal_text
    FROM auth.consume_browser_subject_assertion(
      p_issuer_config_id,
      p_issuer,
      p_subject_hash,
      p_assertion_audience,
      p_canonical_origin,
      p_key_version,
      p_assertion_nonce_hash,
      p_assertion_issued_at,
      p_assertion_expires_at
    ) AS consumed;
  IF v_assertion_workspace_id IS DISTINCT FROM v_workspace_id
     OR v_principal_text !~ '^end_user:[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'subject assertion produced an invalid tenant principal'
      USING ERRCODE = '42501';
  END IF;
  v_principal_id := substring(v_principal_text FROM 10)::uuid;

  SELECT array_agg(grant_row.id ORDER BY grant_row.id::text)
    INTO v_grant_ids
    FROM public.agent_deployment_entry_grants AS grant_row
   WHERE grant_row.workspace_id = v_workspace_id
     AND grant_row.credential_id = v_credential_id
     AND grant_row.credential_kind = 'publish'
     AND grant_row.scope = 'browser-session:exchange'
     AND grant_row.status = 'ACTIVE'
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= v_now)
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > v_now);
  IF COALESCE(cardinality(v_grant_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'publish credential must resolve to exactly one browser Deployment'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    deployment.id,
    security.revoke_epoch,
    principal.session_epoch
    INTO v_deployment_id, v_deployment_revoke_epoch, v_principal_session_epoch
    FROM public.agent_deployment_entry_grants AS grant_row
    JOIN public.agent_deployments AS deployment
      ON deployment.workspace_id = grant_row.workspace_id
     AND deployment.id = grant_row.agent_deployment_id
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
    JOIN public.end_user_principals AS principal
      ON principal.workspace_id = deployment.workspace_id
     AND principal.id = v_principal_id
   WHERE grant_row.workspace_id = v_workspace_id
     AND grant_row.id = v_grant_ids[1]
     AND grant_row.credential_id = v_credential_id
     AND grant_row.credential_kind = 'publish'
     AND grant_row.principal_mode = 'issuer_asserted_end_user'
     AND grant_row.entry_audience = 'browser_session_exchange'
     AND grant_row.ingress_channel = 'browser'
     AND grant_row.scope = 'browser-session:exchange'
     AND grant_row.target_cardinality = 'exactly_one_agent_deployment'
     AND grant_row.status = 'ACTIVE'
     AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at <= v_now)
     AND (grant_row.expires_at IS NULL OR grant_row.expires_at > v_now)
     AND deployment.public_selector = p_public_selector
     AND deployment.ingress_channel = 'browser'
     AND security.status = 'ACTIVE'
     AND revision.ingress_channel = 'browser'
     AND p_canonical_origin = ANY(revision.allowed_origins)
     AND p_client_channel = ANY(revision.browser_client_channels)
     AND revision.session_token_audience = p_token_audience
     AND principal.status = 'active'
   FOR SHARE OF grant_row, deployment, security, pointer, revision, principal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'browser Deployment selector, policy or security state rejected'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.browser_sessions (
    id,
    workspace_id,
    agent_deployment_id,
    principal_id,
    assertion_use_id,
    client_channel,
    canonical_origin,
    token_audience,
    observed_principal_session_epoch,
    observed_deployment_revoke_epoch,
    session_epoch,
    status,
    issued_at,
    expires_at
  ) VALUES (
    p_browser_session_id,
    v_workspace_id,
    v_deployment_id,
    v_principal_id,
    v_assertion_use_id,
    p_client_channel,
    p_canonical_origin,
    p_token_audience,
    v_principal_session_epoch,
    v_deployment_revoke_epoch,
    0,
    'ACTIVE',
    v_now,
    p_session_expires_at
  );
  INSERT INTO auth.browser_session_auth_index (
    browser_session_id,
    workspace_id,
    verifier_hmac,
    verifier_algorithm,
    status,
    session_epoch,
    expires_at
  ) VALUES (
    p_browser_session_id,
    v_workspace_id,
    p_session_verifier_hmac,
    'hmac-sha-256',
    'ACTIVE',
    0,
    p_session_expires_at
  );
  RETURN QUERY SELECT p_browser_session_id, v_workspace_id, v_principal_id, p_session_expires_at;
END;
$function$;

CREATE FUNCTION auth.revoke_browser_session(
  p_browser_session_id uuid,
  p_expected_session_epoch bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_new_epoch bigint;
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE public.browser_sessions
     SET status = 'REVOKED',
         session_epoch = session_epoch + 1,
         revoked_at = v_now
   WHERE workspace_id = v_workspace_id
     AND id = p_browser_session_id
     AND status = 'ACTIVE'
     AND session_epoch = p_expected_session_epoch
  RETURNING session_epoch INTO v_new_epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'browser session revoke compare-and-swap failed'
      USING ERRCODE = '40001';
  END IF;
  UPDATE auth.browser_session_auth_index
     SET status = 'REVOKED',
         session_epoch = v_new_epoch,
         revoked_at = v_now
   WHERE workspace_id = v_workspace_id
     AND browser_session_id = p_browser_session_id
     AND status = 'ACTIVE'
     AND session_epoch = p_expected_session_epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'browser session private projection is inconsistent'
      USING ERRCODE = '55000';
  END IF;
  PERFORM auth.record_authorization_epoch_change(
    v_workspace_id, 'browser_session', p_browser_session_id, '', v_new_epoch
  );
  RETURN v_new_epoch;
END;
$function$;

CREATE FUNCTION auth.authenticate_browser_session_facts(
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

CREATE FUNCTION app.enforce_g005_mutable_fact_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'G0-05 lifecycle facts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME IN (
    'agent_deployment_security_states', 'flow_deployment_security_states'
  ) THEN
    IF to_jsonb(NEW) - ARRAY['status', 'revoke_epoch', 'updated_by', 'updated_at']
         IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['status', 'revoke_epoch', 'updated_by', 'updated_at']
       OR (to_jsonb(NEW) ->> 'revoke_epoch')::bigint
         <> (to_jsonb(OLD) ->> 'revoke_epoch')::bigint + 1
       OR to_jsonb(NEW) ->> 'status' = to_jsonb(OLD) ->> 'status'
       OR to_jsonb(OLD) ->> 'status' = 'REVOKED' THEN
      RAISE EXCEPTION 'invalid Deployment security-state transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME IN (
    'agent_deployment_active_pointers', 'flow_deployment_active_pointers'
  ) THEN
    IF to_jsonb(NEW) - ARRAY[
         'active_revision_id', 'activation_epoch', 'activated_by', 'activated_at'
       ] IS DISTINCT FROM to_jsonb(OLD) - ARRAY[
         'active_revision_id', 'activation_epoch', 'activated_by', 'activated_at'
       ]
       OR (to_jsonb(NEW) ->> 'activation_epoch')::bigint
         <> (to_jsonb(OLD) ->> 'activation_epoch')::bigint + 1 THEN
      RAISE EXCEPTION 'invalid Deployment active-pointer transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME IN (
    'agent_deployment_entry_grants', 'flow_deployment_entry_grants'
  ) THEN
    IF to_jsonb(NEW) - ARRAY['status', 'authorization_epoch', 'revoked_at']
         IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['status', 'authorization_epoch', 'revoked_at']
       OR to_jsonb(OLD) ->> 'status' <> 'ACTIVE'
       OR to_jsonb(NEW) ->> 'status' <> 'REVOKED'
       OR (to_jsonb(NEW) ->> 'authorization_epoch')::bigint
         <> (to_jsonb(OLD) ->> 'authorization_epoch')::bigint + 1 THEN
      RAISE EXCEPTION 'invalid typed entry-grant transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME IN ('browser_sessions', 'browser_session_auth_index') THEN
    IF to_jsonb(NEW) - ARRAY['status', 'session_epoch', 'revoked_at']
         IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['status', 'session_epoch', 'revoked_at']
       OR to_jsonb(OLD) ->> 'status' <> 'ACTIVE'
       OR to_jsonb(NEW) ->> 'status' <> 'REVOKED'
       OR (to_jsonb(NEW) ->> 'session_epoch')::bigint
         <> (to_jsonb(OLD) ->> 'session_epoch')::bigint + 1 THEN
      RAISE EXCEPTION 'invalid browser-session transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unrecognized G0-05 mutable fact table'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION app.enforce_g005_mutable_fact_update()
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.enforce_g005_mutable_fact_update() FROM PUBLIC;

CREATE FUNCTION app.require_typed_published_resource_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
BEGIN
  IF (
    NEW.published_resource_kind = 'AGENT_STRATEGY_RELEASE'
    AND EXISTS (
      SELECT 1 FROM public.agent_strategy_releases AS source
       WHERE source.workspace_id = NEW.workspace_id
         AND source.strategy_id = NEW.resource_id
         AND source.id = NEW.resource_version_id
         AND source.contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )
  ) OR (
    NEW.published_resource_kind = 'AGENT_RELEASE'
    AND EXISTS (
      SELECT 1 FROM public.agent_releases AS source
       WHERE source.workspace_id = NEW.workspace_id
         AND source.agent_id = NEW.resource_id
         AND source.id = NEW.resource_version_id
         AND source.contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )
  ) OR (
    NEW.published_resource_kind = 'FLOW_VERSION'
    AND EXISTS (
      SELECT 1 FROM public.flow_versions AS source
       WHERE source.workspace_id = NEW.workspace_id
         AND source.flow_id = NEW.resource_id
         AND source.id = NEW.resource_version_id
         AND source.contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )
  ) OR (
    NEW.published_resource_kind = 'EXPERIENCE_RELEASE'
    AND EXISTS (
      SELECT 1 FROM public.experience_releases AS source
       WHERE source.workspace_id = NEW.workspace_id
         AND source.experience_id = NEW.resource_id
         AND source.id = NEW.resource_version_id
         AND source.content_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )
  ) OR (
    NEW.published_resource_kind = 'DEPLOYMENT_REVISION'
    AND NEW.source_subkind = 'agent'
    AND EXISTS (
      SELECT 1 FROM public.agent_deployment_revisions AS source
       WHERE source.workspace_id = NEW.workspace_id
         AND source.agent_deployment_id = NEW.resource_id
         AND source.id = NEW.resource_version_id
         AND source.revision_contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )
  ) OR (
    NEW.published_resource_kind = 'DEPLOYMENT_REVISION'
    AND NEW.source_subkind = 'flow'
    AND EXISTS (
      SELECT 1 FROM public.flow_deployment_revisions AS source
       WHERE source.workspace_id = NEW.workspace_id
         AND source.flow_deployment_id = NEW.resource_id
         AND source.id = NEW.resource_version_id
         AND source.revision_contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published resource registry row lacks its exact typed source'
    USING ERRCODE = '23503';
END;
$function$;
ALTER FUNCTION app.require_typed_published_resource_source()
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.require_typed_published_resource_source() FROM PUBLIC;

CREATE TRIGGER published_resource_versions_typed_source
BEFORE INSERT ON public.published_resource_versions
FOR EACH ROW EXECUTE FUNCTION app.require_typed_published_resource_source();

DO $g005_table_ownership_and_rls$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'published_resource_versions',
    'published_resource_dependencies',
    'publishable_resource_roots',
    'publishable_resource_draft_revisions',
    'agent_strategy_releases',
    'agent_releases',
    'flow_versions',
    'experience_releases',
    'published_resource_credential_requirements',
    'agent_release_public_capability_handles',
    'experience_release_quick_entries',
    'deployment_policy_versions',
    'agent_deployments',
    'agent_deployment_security_states',
    'agent_deployment_revisions',
    'agent_deployment_credential_mappings',
    'agent_deployment_active_pointers',
    'agent_deployment_entry_grants',
    'flow_deployments',
    'flow_deployment_security_states',
    'flow_deployment_revisions',
    'flow_deployment_credential_mappings',
    'flow_deployment_active_pointers',
    'flow_deployment_entry_grants',
    'deployment_promotion_audits',
    'browser_sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO ba_authorization_owner', v_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING '
      || '(workspace_id = app.current_workspace_id()) WITH CHECK '
      || '(workspace_id = app.current_workspace_id())',
      v_table || '_tenant_isolation',
      v_table
    );
  END LOOP;
END;
$g005_table_ownership_and_rls$;

ALTER TABLE auth.browser_session_auth_index OWNER TO ba_auth_owner;
ALTER TABLE auth.browser_session_auth_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.browser_session_auth_index FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_session_auth_index_owner_only
  ON auth.browser_session_auth_index
  FOR ALL TO ba_auth_owner
  USING (true)
  WITH CHECK (true);

-- Browser authentication starts before a tenant context exists. Only the
-- NOLOGIN auth owner may cross tenant RLS here, and only through the reviewed
-- SECURITY DEFINER authenticator that first validates the private verifier.
CREATE POLICY browser_sessions_auth_owner_read
  ON public.browser_sessions FOR SELECT TO ba_auth_owner USING (true);
CREATE POLICY agent_deployments_auth_owner_read
  ON public.agent_deployments FOR SELECT TO ba_auth_owner USING (true);
CREATE POLICY agent_deployment_security_states_auth_owner_read
  ON public.agent_deployment_security_states FOR SELECT TO ba_auth_owner USING (true);
CREATE POLICY agent_deployment_active_pointers_auth_owner_read
  ON public.agent_deployment_active_pointers FOR SELECT TO ba_auth_owner USING (true);
CREATE POLICY agent_deployment_revisions_auth_owner_read
  ON public.agent_deployment_revisions FOR SELECT TO ba_auth_owner USING (true);
CREATE POLICY end_user_principals_browser_session_auth_owner_read
  ON public.end_user_principals FOR SELECT TO ba_auth_owner USING (true);
CREATE POLICY workspaces_browser_session_auth_owner_read
  ON public.workspaces FOR SELECT TO ba_auth_owner USING (true);

-- Row-lock clauses are checked against UPDATE RLS policies. These permissive
-- policies let the NOLOGIN auth owner lock pre-context admission facts, while
-- the always-false check prevents that path from changing any row. Reviewed
-- control mutations still require the existing tenant policy to pass.
CREATE POLICY browser_sessions_auth_owner_lock
  ON public.browser_sessions FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);
CREATE POLICY agent_deployment_entry_grants_auth_owner_lock
  ON public.agent_deployment_entry_grants FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);
CREATE POLICY agent_deployments_auth_owner_lock
  ON public.agent_deployments FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);
CREATE POLICY agent_deployment_security_states_auth_owner_lock
  ON public.agent_deployment_security_states FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);
CREATE POLICY agent_deployment_active_pointers_auth_owner_lock
  ON public.agent_deployment_active_pointers FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);
CREATE POLICY agent_deployment_revisions_auth_owner_lock
  ON public.agent_deployment_revisions FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);
CREATE POLICY end_user_principals_browser_session_auth_owner_lock
  ON public.end_user_principals FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);
CREATE POLICY workspaces_browser_session_auth_owner_lock
  ON public.workspaces FOR UPDATE TO ba_auth_owner
  USING (true) WITH CHECK (false);

DO $g005_immutable_triggers$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'published_resource_versions',
    'published_resource_dependencies',
    'publishable_resource_roots',
    'publishable_resource_draft_revisions',
    'agent_strategy_releases',
    'agent_releases',
    'flow_versions',
    'experience_releases',
    'published_resource_credential_requirements',
    'agent_release_public_capability_handles',
    'experience_release_quick_entries',
    'deployment_policy_versions',
    'agent_deployments',
    'agent_deployment_revisions',
    'agent_deployment_credential_mappings',
    'flow_deployments',
    'flow_deployment_revisions',
    'flow_deployment_credential_mappings',
    'deployment_promotion_audits'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER g005_immutable BEFORE UPDATE OR DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_release_fact_change()',
      v_table
    );
  END LOOP;
END;
$g005_immutable_triggers$;

CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON public.agent_deployment_security_states
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();
CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON public.agent_deployment_active_pointers
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();
CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON public.agent_deployment_entry_grants
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();
CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON public.flow_deployment_security_states
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();
CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON public.flow_deployment_active_pointers
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();
CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON public.flow_deployment_entry_grants
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();
CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON public.browser_sessions
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();
CREATE TRIGGER g005_lifecycle
BEFORE UPDATE OR DELETE ON auth.browser_session_auth_index
FOR EACH ROW EXECUTE FUNCTION app.enforce_g005_mutable_fact_update();

REVOKE ALL ON TABLE
  public.published_resource_versions,
  public.published_resource_dependencies,
  public.publishable_resource_roots,
  public.publishable_resource_draft_revisions,
  public.agent_strategy_releases,
  public.agent_releases,
  public.flow_versions,
  public.experience_releases,
  public.published_resource_credential_requirements,
  public.agent_release_public_capability_handles,
  public.experience_release_quick_entries,
  public.deployment_policy_versions,
  public.agent_deployments,
  public.agent_deployment_security_states,
  public.agent_deployment_revisions,
  public.agent_deployment_credential_mappings,
  public.agent_deployment_active_pointers,
  public.agent_deployment_entry_grants,
  public.flow_deployments,
  public.flow_deployment_security_states,
  public.flow_deployment_revisions,
  public.flow_deployment_credential_mappings,
  public.flow_deployment_active_pointers,
  public.flow_deployment_entry_grants,
  public.deployment_promotion_audits,
  public.browser_sessions,
  auth.browser_session_auth_index
FROM PUBLIC, ba_runtime, ba_control_executor, ba_management_attestation_issuer,
  ba_subject_assertion_verifier;

GRANT SELECT ON TABLE
  public.agent_deployment_entry_grants,
  public.agent_deployments,
  public.agent_deployment_security_states,
  public.agent_deployment_active_pointers
TO ba_auth_owner;
-- PostgreSQL row-lock clauses require some UPDATE privilege even when the
-- caller performs no mutation. Only the NOLOGIN auth owner receives one inert
-- column per locked table; immutable/lifecycle triggers reject any misuse.
GRANT UPDATE (id) ON TABLE
  public.agent_deployment_entry_grants,
  public.agent_deployments,
  public.agent_deployment_revisions
TO ba_auth_owner;
GRANT UPDATE (status) ON TABLE public.agent_deployment_security_states
  TO ba_auth_owner;
GRANT UPDATE (active_revision_id) ON TABLE public.agent_deployment_active_pointers
  TO ba_auth_owner;
GRANT UPDATE (updated_at) ON TABLE public.workspaces TO ba_auth_owner;
GRANT SELECT (
  id, workspace_id, agent_deployment_id, agent_id, ingress_channel,
  agent_release_id, agent_release_contract_hash,
  experience_id, experience_release_id, experience_contract_hash,
  policy_profile_contract_hash, entry_scope_policy_contract_hash,
  credential_mapping_hash, dependency_manifest_hash, revision_contract_hash,
  allowed_origins, browser_client_channels, session_token_audience
) ON TABLE public.agent_deployment_revisions TO ba_auth_owner;
GRANT SELECT, INSERT, UPDATE (status, session_epoch, revoked_at)
  ON TABLE public.browser_sessions TO ba_auth_owner;

ALTER FUNCTION app.create_publishable_resource_root(text, uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.append_publishable_resource_draft_revision(
  uuid, text, uuid, bigint, jsonb, text
) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_agent_strategy_release(jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_agent_release(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_flow_version(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_experience_release(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_deployment_policy_version(uuid, uuid, text, text, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_deployment(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_flow_deployment(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_agent_deployment_revision(jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_flow_deployment_revision(jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_deployment_entry_grant(jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_flow_deployment_entry_grant(jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.revoke_agent_deployment_entry_grant(uuid, bigint)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.revoke_flow_deployment_entry_grant(uuid, bigint)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.promote_agent_deployment(uuid, uuid, bigint, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.promote_flow_deployment(uuid, uuid, bigint, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.transition_agent_deployment_security(uuid, bigint, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.transition_flow_deployment_security(uuid, bigint, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.resolve_agent_service_admission(text, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.resolve_flow_service_admission(text, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION auth.exchange_browser_subject_assertion_for_session(
  uuid, bytea, text, text, text, text, timestamptz, uuid, text, bytea,
  text, integer, bytea, timestamptz, timestamptz
) OWNER TO ba_auth_owner;
ALTER FUNCTION auth.revoke_browser_session(uuid, bigint) OWNER TO ba_auth_owner;
ALTER FUNCTION auth.authenticate_browser_session_facts(uuid, bytea, text, text, text)
  OWNER TO ba_auth_owner;

REVOKE ALL ON FUNCTION app.create_publishable_resource_root(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.append_publishable_resource_draft_revision(
  uuid, text, uuid, bigint, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_strategy_release(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_release(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_flow_version(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_experience_release(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_deployment_policy_version(uuid, uuid, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_agent_deployment(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_flow_deployment(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_deployment_revision(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_flow_deployment_revision(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  app.publish_agent_strategy_release(jsonb),
  app.publish_agent_release(jsonb),
  app.publish_flow_version(jsonb),
  app.publish_experience_release(jsonb),
  app.publish_deployment_policy_version(uuid, uuid, text, text, text),
  app.publish_agent_deployment_revision(jsonb),
  app.publish_flow_deployment_revision(jsonb)
FROM
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_auth_owner;
REVOKE ALL ON FUNCTION auth.register_prepared_published_resource(jsonb, text, text, text)
FROM
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_auth_owner;
REVOKE ALL ON FUNCTION app.create_agent_deployment_entry_grant(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_flow_deployment_entry_grant(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.revoke_agent_deployment_entry_grant(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.revoke_flow_deployment_entry_grant(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.promote_agent_deployment(uuid, uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.promote_flow_deployment(uuid, uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transition_agent_deployment_security(uuid, bigint, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transition_flow_deployment_security(uuid, bigint, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_agent_service_admission(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_flow_service_admission(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.exchange_browser_subject_assertion_for_session(
  uuid, bytea, text, text, text, text, timestamptz, uuid, text, bytea,
  text, integer, bytea, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.revoke_browser_session(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.authenticate_browser_session_facts(
  uuid, bytea, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.create_publishable_resource_root(text, uuid),
  app.append_publishable_resource_draft_revision(uuid, text, uuid, bigint, jsonb, text),
  app.create_agent_deployment(jsonb),
  app.create_flow_deployment(jsonb),
  app.create_agent_deployment_entry_grant(jsonb),
  app.create_flow_deployment_entry_grant(jsonb),
  app.revoke_agent_deployment_entry_grant(uuid, bigint),
  app.revoke_flow_deployment_entry_grant(uuid, bigint),
  app.promote_agent_deployment(uuid, uuid, bigint, text),
  app.promote_flow_deployment(uuid, uuid, bigint, text),
  app.transition_agent_deployment_security(uuid, bigint, text),
  app.transition_flow_deployment_security(uuid, bigint, text)
TO ba_control_executor;
-- Content-addressed publishers remain executable only by the NOLOGIN owner.
-- A control-plane caller must not be able to self-assert a JCS/content hash;
-- grant these only after a DB-verifiable compiler/preimage attestation exists.
GRANT EXECUTE ON FUNCTION app.resolve_agent_service_admission(text, text),
  app.resolve_flow_service_admission(text, text)
TO ba_runtime;
GRANT EXECUTE ON FUNCTION auth.exchange_browser_subject_assertion_for_session(
  uuid, bytea, text, text, text, text, timestamptz, uuid, text, bytea,
  text, integer, bytea, timestamptz, timestamptz
) TO ba_subject_assertion_verifier;
GRANT EXECUTE ON FUNCTION auth.revoke_browser_session(uuid, bigint)
  TO ba_control_executor;
GRANT EXECUTE ON FUNCTION auth.authenticate_browser_session_facts(
  uuid, bytea, text, text, text
) TO ba_runtime;

GRANT EXECUTE ON FUNCTION auth.require_control_workspace(),
  auth.record_authorization_epoch_change(uuid, text, uuid, text, bigint)
TO ba_auth_owner;
REVOKE EXECUTE ON FUNCTION auth.consume_browser_subject_assertion(
  uuid, text, bytea, text, text, integer, bytea, timestamptz, timestamptz
) FROM ba_subject_assertion_verifier;

COMMENT ON TABLE public.published_resource_versions IS
  'Canonical immutable registry. Only kind-specific publishers can create a full pinned version.';
COMMENT ON TABLE public.browser_sessions IS
  'Safe browser-session metadata; verifier material lives only in auth.browser_session_auth_index.';
COMMENT ON FUNCTION app.resolve_agent_service_admission(text, text) IS
  'Returns transaction-locked Agent admission facts. The API layer closes the domain snapshot and computes its JCS hash.';
COMMENT ON FUNCTION app.resolve_flow_service_admission(text, text) IS
  'Returns transaction-locked Flow admission facts. G0-06 persists these facts with the Run.';

REVOKE CREATE ON SCHEMA public, app, auth FROM ba_authorization_owner;
