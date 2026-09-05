-- Fixed, read-only G1 registry projections for an attested control transaction.
-- Raw tables stay unavailable to executable roles; release-core still replays
-- every returned canonical artifact before it becomes application authority.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE FUNCTION app.resolve_registered_dependency_pins(p_pins jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_pin jsonb;
  v_ordinal bigint;
  v_seen text[] := ARRAY[]::text[];
  v_key text;
  v_result jsonb := '[]'::jsonb;
BEGIN
  IF p_pins IS NULL OR jsonb_typeof(p_pins) <> 'array'
     OR jsonb_array_length(p_pins) > 1024 THEN
    RAISE EXCEPTION 'published dependency pin request must be a bounded array'
      USING ERRCODE = '22023';
  END IF;

  FOR v_pin, v_ordinal IN
    SELECT requested.value, requested.ordinality
      FROM jsonb_array_elements(p_pins)
        WITH ORDINALITY AS requested(value, ordinality)
  LOOP
    IF jsonb_typeof(v_pin) <> 'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_pin) AS key)
         IS DISTINCT FROM ARRAY[
           'binding_mode','contract_hash','published_resource_kind',
           'resource_id','resource_version_id','workspace_id'
         ]::text[] THEN
      RAISE EXCEPTION 'published dependency pin fields differ from the closed contract'
        USING ERRCODE = '22023';
    END IF;
    IF v_pin ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
       OR v_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
       OR v_pin ->> 'published_resource_kind' NOT IN (
         'AGENT_STRATEGY_RELEASE', 'AGENT_RELEASE', 'FLOW_VERSION',
         'EXPERIENCE_RELEASE', 'DEPLOYMENT_REVISION',
         'INSTRUCTION_SKILL_RELEASE', 'KNOWLEDGE_INDEX_GENERATION',
         'DATABASE_OPERATION_RELEASE', 'PLUGIN_TOOL_RELEASE',
         'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
       )
       OR v_pin ->> 'contract_hash' !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'published dependency pin identity is invalid or cross-workspace'
        USING ERRCODE = '22023';
    END IF;

    v_key := v_pin::text;
    IF array_position(v_seen, v_key) IS NOT NULL THEN
      RAISE EXCEPTION 'duplicate published dependency pin'
        USING ERRCODE = '22023';
    END IF;
    v_seen := array_append(v_seen, v_key);

    IF NOT EXISTS (
      SELECT 1
        FROM public.published_resource_versions AS registry
       WHERE registry.workspace_id = v_workspace_id
         AND registry.published_resource_kind = v_pin ->> 'published_resource_kind'
         AND registry.resource_id = (v_pin ->> 'resource_id')::uuid
         AND registry.resource_version_id = (v_pin ->> 'resource_version_id')::uuid
         AND registry.contract_hash = v_pin ->> 'contract_hash'
    ) THEN
      RAISE EXCEPTION 'published dependency pin is not registered'
        USING ERRCODE = '23503';
    END IF;
    v_result := v_result || jsonb_build_array(v_pin);
  END LOOP;

  RETURN v_result;
END;
$function$;

CREATE FUNCTION app.resolve_g1_published_source(p_pin jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_result jsonb;
BEGIN
  IF p_pin IS NULL OR jsonb_typeof(p_pin) <> 'object'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_pin) AS key)
       IS DISTINCT FROM ARRAY[
         'binding_mode','contract_hash','published_resource_kind',
         'resource_id','resource_version_id','workspace_id'
       ]::text[] THEN
    RAISE EXCEPTION 'G1 source pin fields differ from the closed contract'
      USING ERRCODE = '22023';
  END IF;
  IF p_pin ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR p_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR p_pin ->> 'published_resource_kind' NOT IN (
       'AGENT_STRATEGY_RELEASE', 'INSTRUCTION_SKILL_RELEASE',
       'KNOWLEDGE_INDEX_GENERATION', 'DATABASE_OPERATION_RELEASE',
       'PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
     )
     OR p_pin ->> 'contract_hash' !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G1 source pin identity is invalid or cross-workspace'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 'prepared-g1-published-source-storage/1',
    'full_pin', jsonb_build_object(
      'workspace_id', source.workspace_id,
      'published_resource_kind', source.published_resource_kind,
      'resource_id', source.resource_id,
      'resource_version_id', source.resource_version_id,
      'contract_hash', source.contract_hash,
      'binding_mode', 'pinned'),
    'source_schema_version', source.source_schema_version,
    'canonical_document', source.canonical_document,
    'dependency_manifest', jsonb_build_object(
      'schema_version', 'published-resource-dependency-manifest/1',
      'owner', jsonb_build_object(
        'workspace_id', registry.workspace_id,
        'published_resource_kind', registry.published_resource_kind,
        'resource_id', registry.resource_id,
        'resource_version_id', registry.resource_version_id),
      'manifest_hash', registry.dependency_manifest_hash,
      'dependencies', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'workspace_id', dependency.workspace_id,
          'published_resource_kind', dependency.dependency_kind,
          'resource_id', dependency.dependency_resource_id,
          'resource_version_id', dependency.dependency_resource_version_id,
          'contract_hash', dependency.dependency_contract_hash,
          'binding_mode', dependency.binding_mode)
          ORDER BY dependency.ordinal)
          FROM public.published_resource_dependencies AS dependency
         WHERE dependency.workspace_id = registry.workspace_id
           AND dependency.owner_kind = registry.published_resource_kind
           AND dependency.owner_resource_id = registry.resource_id
           AND dependency.owner_resource_version_id = registry.resource_version_id
      ), '[]'::jsonb)),
    'canonical_source_preimage', source.canonical_source_preimage,
    'canonical_source_artifact', source.canonical_source_artifact)
    INTO v_result
    FROM public.published_g1_resource_sources AS source
    JOIN public.published_resource_versions AS registry USING (
      workspace_id, published_resource_kind, resource_id,
      resource_version_id, contract_hash
    )
   WHERE source.workspace_id = v_workspace_id
     AND source.published_resource_kind = p_pin ->> 'published_resource_kind'
     AND source.resource_id = (p_pin ->> 'resource_id')::uuid
     AND source.resource_version_id = (p_pin ->> 'resource_version_id')::uuid
     AND source.contract_hash = p_pin ->> 'contract_hash';

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'G1 published source is not registered'
      USING ERRCODE = '23503';
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION app.resolve_registered_dependency_pins(jsonb),
  app.resolve_g1_published_source(jsonb) FROM PUBLIC, ba_runtime,
  ba_management_attestation_issuer, ba_subject_assertion_verifier, ba_auth_owner;
GRANT EXECUTE ON FUNCTION app.resolve_registered_dependency_pins(jsonb),
  app.resolve_g1_published_source(jsonb) TO ba_control_executor;

RESET ROLE;

REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
