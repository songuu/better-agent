-- Typed immutable registry writers for G1 source resources. The database binds
-- original canonical preimage bytes; semantic replay remains in release-core.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

ALTER TABLE public.published_resource_versions
  DROP CONSTRAINT published_resource_versions_published_resource_kind_check;
ALTER TABLE public.published_resource_versions
  ADD CONSTRAINT published_resource_versions_published_resource_kind_check CHECK (
    published_resource_kind IN (
      'AGENT_STRATEGY_RELEASE', 'AGENT_RELEASE', 'FLOW_VERSION',
      'EXPERIENCE_RELEASE', 'DEPLOYMENT_REVISION',
      'INSTRUCTION_SKILL_RELEASE', 'KNOWLEDGE_INDEX_GENERATION',
      'DATABASE_OPERATION_RELEASE', 'PLUGIN_TOOL_RELEASE',
      'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
    )
  );
ALTER TABLE public.published_resource_versions
  DROP CONSTRAINT published_resource_versions_kind_schema_check;
ALTER TABLE public.published_resource_versions
  ADD CONSTRAINT published_resource_versions_kind_schema_check CHECK (
    (published_resource_kind = 'AGENT_STRATEGY_RELEASE'
      AND source_schema_version IN ('agent-strategy-release/1', 'agent-strategy-source/1'))
    OR (published_resource_kind = 'AGENT_RELEASE' AND source_schema_version = 'agent-release/1')
    OR (published_resource_kind = 'FLOW_VERSION' AND source_schema_version = 'flow-ir/1')
    OR (published_resource_kind = 'EXPERIENCE_RELEASE'
      AND source_schema_version = 'experience-release/1')
    OR (published_resource_kind = 'DEPLOYMENT_REVISION'
      AND source_schema_version IN ('agent-deployment/1', 'flow-deployment/1'))
    OR (published_resource_kind = 'INSTRUCTION_SKILL_RELEASE'
      AND source_schema_version = 'instruction-skill-source/1')
    OR (published_resource_kind = 'KNOWLEDGE_INDEX_GENERATION'
      AND source_schema_version = 'knowledge-index-generation-source/1')
    OR (published_resource_kind = 'DATABASE_OPERATION_RELEASE'
      AND source_schema_version = 'database-operation-source/1')
    OR (published_resource_kind = 'PLUGIN_TOOL_RELEASE'
      AND source_schema_version = 'plugin-tool-source/1')
    OR (published_resource_kind = 'A2A_AGENT_RELEASE'
      AND source_schema_version = 'a2a-agent-source/1')
    OR (published_resource_kind = 'SKILL_PACK_RELEASE'
      AND source_schema_version = 'skill-pack-source/1')
  );

CREATE TABLE public.published_g1_resource_sources (
  workspace_id uuid NOT NULL,
  published_resource_kind text NOT NULL CHECK (published_resource_kind IN (
    'AGENT_STRATEGY_RELEASE', 'INSTRUCTION_SKILL_RELEASE',
    'KNOWLEDGE_INDEX_GENERATION', 'DATABASE_OPERATION_RELEASE',
    'PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
  )),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_schema_version text NOT NULL,
  canonical_document text NOT NULL CHECK (
    octet_length(canonical_document) <= 8388608
    AND jsonb_typeof(canonical_document::jsonb) = 'object'
  ),
  canonical_source_preimage text NOT NULL CHECK (
    octet_length(canonical_source_preimage) <= 8388608
    AND jsonb_typeof(canonical_source_preimage::jsonb) = 'object'
  ),
  canonical_source_artifact text NOT NULL CHECK (
    octet_length(canonical_source_artifact) <= 8388608
    AND jsonb_typeof(canonical_source_artifact::jsonb) = 'object'
  ),
  stored_by text NOT NULL CHECK (length(btrim(stored_by)) > 0),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, published_resource_kind, resource_id, resource_version_id),
  CONSTRAINT published_g1_resource_sources_registry_fkey FOREIGN KEY (
    workspace_id, published_resource_kind, resource_id, resource_version_id, contract_hash
  ) REFERENCES public.published_resource_versions (
    workspace_id, published_resource_kind, resource_id, resource_version_id, contract_hash
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION auth.register_prepared_g1_published_source(
  p_storage jsonb,
  p_expected_kind text,
  p_expected_schema text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_pin jsonb := p_storage -> 'full_pin';
  v_manifest jsonb := p_storage -> 'dependency_manifest';
  v_document_text text := p_storage ->> 'canonical_document';
  v_preimage_text text := p_storage ->> 'canonical_source_preimage';
  v_artifact_text text := p_storage ->> 'canonical_source_artifact';
  v_document jsonb;
  v_preimage jsonb;
  v_artifact jsonb;
  v_resource_id uuid;
  v_resource_version_id uuid;
  v_dependency jsonb;
  v_ordinal bigint;
  v_expected_artifact_schema text;
BEGIN
  IF p_storage IS NULL OR jsonb_typeof(p_storage) <> 'object'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_storage) AS key)
       IS DISTINCT FROM ARRAY[
         'canonical_document','canonical_source_artifact','canonical_source_preimage',
         'dependency_manifest','full_pin','schema_version','source_schema_version'
       ]::text[]
     OR p_storage ->> 'schema_version'
       IS DISTINCT FROM 'prepared-g1-published-source-storage/1'
     OR jsonb_typeof(v_pin) <> 'object'
     OR jsonb_typeof(v_manifest) <> 'object'
     OR v_document_text IS NULL OR v_preimage_text IS NULL OR v_artifact_text IS NULL THEN
    RAISE EXCEPTION 'invalid prepared G1 published source envelope' USING ERRCODE = '22023';
  END IF;

  v_document := v_document_text::jsonb;
  v_preimage := v_preimage_text::jsonb;
  v_artifact := v_artifact_text::jsonb;
  v_resource_id := (v_pin ->> 'resource_id')::uuid;
  v_resource_version_id := (v_pin ->> 'resource_version_id')::uuid;
  v_expected_artifact_schema := CASE
    WHEN p_expected_kind = 'AGENT_STRATEGY_RELEASE' THEN 'prepared-agent-strategy-source/1'
    WHEN p_expected_kind = 'INSTRUCTION_SKILL_RELEASE' THEN 'prepared-instruction-skill-source/1'
    WHEN p_expected_kind IN (
      'KNOWLEDGE_INDEX_GENERATION', 'DATABASE_OPERATION_RELEASE',
      'PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE'
    ) THEN 'prepared-leaf-resource-source/1'
    WHEN p_expected_kind = 'SKILL_PACK_RELEASE' THEN 'prepared-skill-pack-source/1'
    ELSE NULL
  END;

  IF v_expected_artifact_schema IS NULL
     OR p_storage ->> 'source_schema_version' IS DISTINCT FROM p_expected_schema
     OR v_pin ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_pin ->> 'published_resource_kind' IS DISTINCT FROM p_expected_kind
     OR v_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR v_pin ->> 'contract_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(v_document) <> 'object'
     OR v_document ->> 'schema_version' IS DISTINCT FROM p_expected_schema
     OR v_preimage ->> 'compiler_version' IS DISTINCT FROM 'capability-compiler/1'
     OR v_preimage ->> 'canonicalizer_version' IS DISTINCT FROM 'rfc8785/1'
     OR v_preimage ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_preimage ->> 'published_resource_kind' IS DISTINCT FROM p_expected_kind
     OR v_preimage -> 'document' IS DISTINCT FROM v_document
     OR 'sha256:' || encode(public.digest(convert_to(v_preimage_text, 'UTF8'), 'sha256'), 'hex')
       IS DISTINCT FROM v_pin ->> 'contract_hash'
     OR v_artifact ->> 'schema_version' IS DISTINCT FROM v_expected_artifact_schema
     OR v_artifact -> 'full_pin' IS DISTINCT FROM v_pin
     OR v_artifact -> 'document' IS DISTINCT FROM v_document
     OR v_artifact -> 'preimage' IS DISTINCT FROM v_preimage
     OR v_artifact -> 'dependency_manifest' IS DISTINCT FROM v_manifest
     OR v_manifest ->> 'schema_version'
       IS DISTINCT FROM 'published-resource-dependency-manifest/1'
     OR v_manifest -> 'owner' ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_manifest -> 'owner' ->> 'published_resource_kind' IS DISTINCT FROM p_expected_kind
     OR v_manifest -> 'owner' ->> 'resource_id' IS DISTINCT FROM v_resource_id::text
     OR v_manifest -> 'owner' ->> 'resource_version_id'
       IS DISTINCT FROM v_resource_version_id::text
     OR v_manifest ->> 'manifest_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(v_manifest -> 'dependencies') <> 'array' THEN
    RAISE EXCEPTION 'G1 source identity, bytes, schema or manifest mismatch'
      USING ERRCODE = '22023';
  END IF;

  -- The companion row is inserted first under a deferred full-identity FK so
  -- the existing registry BEFORE INSERT trigger can attest the typed source.
  INSERT INTO public.published_g1_resource_sources (
    workspace_id, published_resource_kind, resource_id, resource_version_id,
    contract_hash, dependency_manifest_hash, source_schema_version,
    canonical_document, canonical_source_preimage, canonical_source_artifact, stored_by
  ) VALUES (
    v_workspace_id, p_expected_kind, v_resource_id, v_resource_version_id,
    v_pin ->> 'contract_hash', v_manifest ->> 'manifest_hash', p_expected_schema,
    v_document_text, v_preimage_text, v_artifact_text, v_actor
  );

  INSERT INTO public.published_resource_versions (
    workspace_id, published_resource_kind, resource_id, resource_version_id,
    contract_hash, dependency_manifest_hash, source_schema_version,
    source_subkind, canonical_document, published_by
  ) VALUES (
    v_workspace_id, p_expected_kind, v_resource_id, v_resource_version_id,
    v_pin ->> 'contract_hash', v_manifest ->> 'manifest_hash', p_expected_schema,
    NULL, v_document_text, v_actor
  );

  FOR v_dependency, v_ordinal IN
    SELECT dependency.value, dependency.ordinality - 1
      FROM jsonb_array_elements(v_manifest -> 'dependencies')
        WITH ORDINALITY AS dependency(value, ordinality)
  LOOP
    IF v_dependency ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
       OR v_dependency ->> 'binding_mode' IS DISTINCT FROM 'pinned'
       OR v_dependency ->> 'published_resource_kind' NOT IN (
         'AGENT_STRATEGY_RELEASE', 'AGENT_RELEASE', 'FLOW_VERSION',
         'EXPERIENCE_RELEASE', 'DEPLOYMENT_REVISION',
         'INSTRUCTION_SKILL_RELEASE', 'KNOWLEDGE_INDEX_GENERATION',
         'DATABASE_OPERATION_RELEASE', 'PLUGIN_TOOL_RELEASE',
         'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
       )
       OR v_dependency ->> 'contract_hash' !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'G1 dependency manifest contains an invalid or cross-workspace pin'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.published_resource_dependencies (
      workspace_id, owner_kind, owner_resource_id, owner_resource_version_id,
      dependency_kind, dependency_resource_id, dependency_resource_version_id,
      dependency_contract_hash, binding_mode, ordinal
    ) VALUES (
      v_workspace_id, p_expected_kind, v_resource_id, v_resource_version_id,
      v_dependency ->> 'published_resource_kind',
      (v_dependency ->> 'resource_id')::uuid,
      (v_dependency ->> 'resource_version_id')::uuid,
      v_dependency ->> 'contract_hash', 'pinned', v_ordinal::integer
    );
  END LOOP;

  RETURN v_resource_version_id;
END;
$function$;

CREATE OR REPLACE FUNCTION app.require_typed_published_resource_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
BEGIN
  IF NEW.published_resource_kind IN (
    'INSTRUCTION_SKILL_RELEASE', 'KNOWLEDGE_INDEX_GENERATION',
    'DATABASE_OPERATION_RELEASE', 'PLUGIN_TOOL_RELEASE',
    'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
  ) OR (
    NEW.published_resource_kind = 'AGENT_STRATEGY_RELEASE'
    AND NEW.source_schema_version = 'agent-strategy-source/1'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.published_g1_resource_sources AS source
       WHERE source.workspace_id = NEW.workspace_id
         AND source.published_resource_kind = NEW.published_resource_kind
         AND source.resource_id = NEW.resource_id
         AND source.resource_version_id = NEW.resource_version_id
         AND source.contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.source_schema_version = NEW.source_schema_version
         AND source.canonical_document = NEW.canonical_document
    ) THEN
      RETURN NEW;
    END IF;
  ELSE
    IF (NEW.published_resource_kind = 'AGENT_STRATEGY_RELEASE' AND EXISTS (
      SELECT 1 FROM public.agent_strategy_releases AS source
       WHERE source.workspace_id = NEW.workspace_id AND source.strategy_id = NEW.resource_id
         AND source.id = NEW.resource_version_id AND source.contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )) OR (NEW.published_resource_kind = 'AGENT_RELEASE' AND EXISTS (
      SELECT 1 FROM public.agent_releases AS source
       WHERE source.workspace_id = NEW.workspace_id AND source.agent_id = NEW.resource_id
         AND source.id = NEW.resource_version_id AND source.contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )) OR (NEW.published_resource_kind = 'FLOW_VERSION' AND EXISTS (
      SELECT 1 FROM public.flow_versions AS source
       WHERE source.workspace_id = NEW.workspace_id AND source.flow_id = NEW.resource_id
         AND source.id = NEW.resource_version_id AND source.contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )) OR (NEW.published_resource_kind = 'EXPERIENCE_RELEASE' AND EXISTS (
      SELECT 1 FROM public.experience_releases AS source
       WHERE source.workspace_id = NEW.workspace_id AND source.experience_id = NEW.resource_id
         AND source.id = NEW.resource_version_id AND source.content_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document
    )) OR (NEW.published_resource_kind = 'DEPLOYMENT_REVISION' AND NEW.source_subkind = 'agent'
      AND EXISTS (SELECT 1 FROM public.agent_deployment_revisions AS source
       WHERE source.workspace_id = NEW.workspace_id AND source.agent_deployment_id = NEW.resource_id
         AND source.id = NEW.resource_version_id AND source.revision_contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document)
    ) OR (NEW.published_resource_kind = 'DEPLOYMENT_REVISION' AND NEW.source_subkind = 'flow'
      AND EXISTS (SELECT 1 FROM public.flow_deployment_revisions AS source
       WHERE source.workspace_id = NEW.workspace_id AND source.flow_deployment_id = NEW.resource_id
         AND source.id = NEW.resource_version_id AND source.revision_contract_hash = NEW.contract_hash
         AND source.dependency_manifest_hash = NEW.dependency_manifest_hash
         AND source.canonical_document = NEW.canonical_document)
    ) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'published resource registry row lacks its exact typed source'
    USING ERRCODE = '23503';
END;
$function$;

CREATE FUNCTION app.publish_agent_strategy_source(p_storage jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app, pg_temp
AS $$ SELECT auth.register_prepared_g1_published_source($1, 'AGENT_STRATEGY_RELEASE', 'agent-strategy-source/1') $$;
CREATE FUNCTION app.publish_instruction_skill_release(p_storage jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app, pg_temp
AS $$ SELECT auth.register_prepared_g1_published_source($1, 'INSTRUCTION_SKILL_RELEASE', 'instruction-skill-source/1') $$;
CREATE FUNCTION app.publish_knowledge_index_generation(p_storage jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app, pg_temp
AS $$ SELECT auth.register_prepared_g1_published_source($1, 'KNOWLEDGE_INDEX_GENERATION', 'knowledge-index-generation-source/1') $$;
CREATE FUNCTION app.publish_database_operation_release(p_storage jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app, pg_temp
AS $$ SELECT auth.register_prepared_g1_published_source($1, 'DATABASE_OPERATION_RELEASE', 'database-operation-source/1') $$;
CREATE FUNCTION app.publish_plugin_tool_release(p_storage jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app, pg_temp
AS $$ SELECT auth.register_prepared_g1_published_source($1, 'PLUGIN_TOOL_RELEASE', 'plugin-tool-source/1') $$;
CREATE FUNCTION app.publish_a2a_agent_release(p_storage jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app, pg_temp
AS $$ SELECT auth.register_prepared_g1_published_source($1, 'A2A_AGENT_RELEASE', 'a2a-agent-source/1') $$;
CREATE FUNCTION app.publish_skill_pack_release(p_storage jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, auth, app, pg_temp
AS $$ SELECT auth.register_prepared_g1_published_source($1, 'SKILL_PACK_RELEASE', 'skill-pack-source/1') $$;

ALTER TABLE public.published_g1_resource_sources OWNER TO ba_authorization_owner;
ALTER TABLE public.published_g1_resource_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_g1_resource_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY published_g1_resource_sources_tenant_isolation
ON public.published_g1_resource_sources FOR ALL
USING (workspace_id = app.current_workspace_id())
WITH CHECK (workspace_id = app.current_workspace_id());
CREATE TRIGGER g1_published_resource_source_immutable
BEFORE UPDATE OR DELETE ON public.published_g1_resource_sources
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_release_fact_change();

REVOKE ALL ON TABLE public.published_g1_resource_sources FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.register_prepared_g1_published_source(jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_strategy_source(jsonb),
  app.publish_instruction_skill_release(jsonb), app.publish_knowledge_index_generation(jsonb),
  app.publish_database_operation_release(jsonb), app.publish_plugin_tool_release(jsonb),
  app.publish_a2a_agent_release(jsonb), app.publish_skill_pack_release(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.register_prepared_g1_published_source(jsonb, text, text),
  app.publish_agent_strategy_source(jsonb), app.publish_instruction_skill_release(jsonb),
  app.publish_knowledge_index_generation(jsonb), app.publish_database_operation_release(jsonb),
  app.publish_plugin_tool_release(jsonb), app.publish_a2a_agent_release(jsonb),
  app.publish_skill_pack_release(jsonb)
  FROM ba_runtime, ba_control_executor, ba_management_attestation_issuer,
    ba_subject_assertion_verifier, ba_auth_owner;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA auth FROM ba_authorization_owner;
