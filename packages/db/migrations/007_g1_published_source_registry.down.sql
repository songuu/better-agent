-- A published G1 source is immutable evidence; downgrade is only safe while unused.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;
ALTER TABLE public.published_g1_resource_sources NO FORCE ROW LEVEL SECURITY;

DO $g1_published_source_down_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.published_g1_resource_sources) THEN
    RAISE EXCEPTION 'cannot remove G1 published source registry after publication'
      USING ERRCODE = '55000';
  END IF;
END;
$g1_published_source_down_guard$;

DROP FUNCTION app.publish_skill_pack_release(jsonb);
DROP FUNCTION app.publish_a2a_agent_release(jsonb);
DROP FUNCTION app.publish_plugin_tool_release(jsonb);
DROP FUNCTION app.publish_database_operation_release(jsonb);
DROP FUNCTION app.publish_knowledge_index_generation(jsonb);
DROP FUNCTION app.publish_instruction_skill_release(jsonb);
DROP FUNCTION app.publish_agent_strategy_source(jsonb);
DROP FUNCTION auth.register_prepared_g1_published_source(jsonb, text, text);
DROP TABLE public.published_g1_resource_sources;

CREATE OR REPLACE FUNCTION app.require_typed_published_resource_source()
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

ALTER TABLE public.published_resource_versions
  DROP CONSTRAINT published_resource_versions_kind_schema_check;
ALTER TABLE public.published_resource_versions
  ADD CONSTRAINT published_resource_versions_kind_schema_check CHECK (
    (published_resource_kind = 'AGENT_STRATEGY_RELEASE'
      AND source_schema_version = 'agent-strategy-release/1')
    OR (published_resource_kind = 'AGENT_RELEASE' AND source_schema_version = 'agent-release/1')
    OR (published_resource_kind = 'FLOW_VERSION' AND source_schema_version = 'flow-ir/1')
    OR (published_resource_kind = 'EXPERIENCE_RELEASE'
      AND source_schema_version = 'experience-release/1')
    OR (published_resource_kind = 'DEPLOYMENT_REVISION'
      AND source_schema_version IN ('agent-deployment/1', 'flow-deployment/1'))
  );
ALTER TABLE public.published_resource_versions
  DROP CONSTRAINT published_resource_versions_published_resource_kind_check;
ALTER TABLE public.published_resource_versions
  ADD CONSTRAINT published_resource_versions_published_resource_kind_check CHECK (
    published_resource_kind IN (
      'AGENT_STRATEGY_RELEASE', 'AGENT_RELEASE', 'FLOW_VERSION',
      'EXPERIENCE_RELEASE', 'DEPLOYMENT_REVISION'
    )
  );

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
