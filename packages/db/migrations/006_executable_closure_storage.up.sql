-- G1 executable closure bytes are immutable companions to exact typed registry rows.
-- PostgreSQL validates original canonical text hashes; semantic replay remains in release-core.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.published_executable_closures (
  workspace_id uuid NOT NULL,
  published_resource_kind text NOT NULL
    CHECK (published_resource_kind IN ('AGENT_RELEASE', 'FLOW_VERSION')),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL
    CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  semantic_seed_hash text NOT NULL CHECK (semantic_seed_hash ~ '^sha256:[0-9a-f]{64}$'),
  capability_closure_hash text NOT NULL
    CHECK (capability_closure_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_compiled_preimage text NOT NULL CHECK (
    octet_length(canonical_compiled_preimage) <= 8388608
    AND jsonb_typeof(canonical_compiled_preimage::jsonb) = 'object'
  ),
  canonical_closure_preimage text NOT NULL CHECK (
    octet_length(canonical_closure_preimage) <= 33554432
    AND jsonb_typeof(canonical_closure_preimage::jsonb) = 'object'
    AND NOT canonical_closure_preimage::jsonb ? 'closure_hash'
  ),
  stored_by text NOT NULL CHECK (length(btrim(stored_by)) > 0),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, published_resource_kind, resource_id, resource_version_id),
  CONSTRAINT published_executable_closures_registry_fkey FOREIGN KEY (
    workspace_id, published_resource_kind, resource_id, resource_version_id, contract_hash
  ) REFERENCES public.published_resource_versions (
    workspace_id, published_resource_kind, resource_id, resource_version_id, contract_hash
  )
);

CREATE FUNCTION auth.register_prepared_executable_closure(p_storage jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_actor text := app.current_authenticated_principal_id();
  v_prepared jsonb := p_storage -> 'prepared_resource';
  v_pin jsonb := v_prepared -> 'full_pin';
  v_manifest jsonb := v_prepared -> 'dependency_manifest';
  v_document jsonb := (v_prepared ->> 'canonical_document')::jsonb;
  v_compiled_text text := p_storage ->> 'canonical_compiled_preimage';
  v_closure_text text := p_storage ->> 'canonical_closure_preimage';
  v_compiled jsonb;
  v_closure jsonb;
BEGIN
  IF p_storage IS NULL OR jsonb_typeof(p_storage) <> 'object'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_storage) AS key)
       IS DISTINCT FROM ARRAY['canonical_closure_preimage','canonical_compiled_preimage','prepared_resource']::text[]
     OR v_prepared ->> 'schema_version' IS DISTINCT FROM 'prepared-published-resource/1'
     OR v_compiled_text IS NULL OR v_closure_text IS NULL THEN
    RAISE EXCEPTION 'invalid executable closure storage envelope' USING ERRCODE = '22023';
  END IF;
  v_compiled := v_compiled_text::jsonb;
  v_closure := v_closure_text::jsonb;
  IF v_pin ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_pin ->> 'published_resource_kind' NOT IN ('AGENT_RELEASE', 'FLOW_VERSION')
     OR v_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR v_compiled ->> 'schema_version' IS DISTINCT FROM 'executable-compiled-preimage/1'
     OR v_compiled ->> 'compiler_version' IS DISTINCT FROM 'capability-compiler/1'
     OR v_compiled ->> 'canonicalizer_version' IS DISTINCT FROM 'rfc8785/1'
     OR v_compiled ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_compiled ->> 'published_resource_kind'
       IS DISTINCT FROM v_pin ->> 'published_resource_kind'
     OR v_compiled ->> 'capability_closure_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR v_closure ? 'closure_hash'
     OR v_closure ->> 'schema_version' IS DISTINCT FROM 'compiled-capability-closure/1'
     OR v_closure -> 'root' -> 'pin' ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR v_closure -> 'root' -> 'pin' ->> 'published_resource_kind'
       IS DISTINCT FROM v_pin ->> 'published_resource_kind'
     OR v_closure -> 'root' -> 'pin' ->> 'resource_id'
       IS DISTINCT FROM v_pin ->> 'resource_id'
     OR v_closure -> 'root' -> 'pin' ->> 'resource_version_id'
       IS DISTINCT FROM v_pin ->> 'resource_version_id'
     OR v_closure -> 'root' ->> 'semantic_seed_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR 'sha256:' || encode(public.digest(convert_to(v_compiled_text, 'UTF8'), 'sha256'), 'hex')
       IS DISTINCT FROM v_pin ->> 'contract_hash'
     OR 'sha256:' || encode(public.digest(convert_to(v_closure_text, 'UTF8'), 'sha256'), 'hex')
       IS DISTINCT FROM v_compiled ->> 'capability_closure_hash'
     OR NOT EXISTS (
       SELECT 1 FROM public.published_resource_versions AS registry
        WHERE registry.workspace_id = v_workspace_id
          AND registry.published_resource_kind = v_pin ->> 'published_resource_kind'
          AND registry.resource_id = (v_pin ->> 'resource_id')::uuid
          AND registry.resource_version_id = (v_pin ->> 'resource_version_id')::uuid
          AND registry.contract_hash = v_pin ->> 'contract_hash'
          AND registry.dependency_manifest_hash = v_manifest ->> 'manifest_hash'
          AND registry.canonical_document::jsonb = v_document
     )
     OR (v_pin ->> 'published_resource_kind' = 'AGENT_RELEASE' AND (
       v_document ->> 'compiled_hash' IS DISTINCT FROM v_pin ->> 'contract_hash'
       OR v_document ->> 'capability_closure_hash'
         IS DISTINCT FROM v_compiled ->> 'capability_closure_hash'
     )) THEN
    RAISE EXCEPTION 'executable closure evidence is not bound to its typed registry source'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.published_executable_closures (
    workspace_id, published_resource_kind, resource_id, resource_version_id,
    contract_hash, dependency_manifest_hash, semantic_seed_hash,
    capability_closure_hash, canonical_compiled_preimage,
    canonical_closure_preimage, stored_by
  ) VALUES (
    v_workspace_id, v_pin ->> 'published_resource_kind',
    (v_pin ->> 'resource_id')::uuid, (v_pin ->> 'resource_version_id')::uuid,
    v_pin ->> 'contract_hash', v_manifest ->> 'manifest_hash',
    v_closure -> 'root' ->> 'semantic_seed_hash',
    v_compiled ->> 'capability_closure_hash', v_compiled_text, v_closure_text, v_actor
  );
END;
$function$;

CREATE FUNCTION app.publish_compiled_agent_release(p_storage jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE v_release_id uuid;
BEGIN
  v_release_id := app.publish_agent_release(p_storage -> 'prepared_resource');
  PERFORM auth.register_prepared_executable_closure(p_storage);
  RETURN v_release_id;
END;
$function$;

CREATE FUNCTION app.publish_compiled_flow_version(p_storage jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE v_version_id uuid;
BEGIN
  v_version_id := app.publish_flow_version(p_storage -> 'prepared_resource');
  PERFORM auth.register_prepared_executable_closure(p_storage);
  RETURN v_version_id;
END;
$function$;

ALTER TABLE public.published_executable_closures OWNER TO ba_authorization_owner;
ALTER TABLE public.published_executable_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_executable_closures FORCE ROW LEVEL SECURITY;
CREATE POLICY published_executable_closures_tenant_isolation
ON public.published_executable_closures FOR ALL
USING (workspace_id = app.current_workspace_id())
WITH CHECK (workspace_id = app.current_workspace_id());

CREATE TRIGGER g1_executable_closure_immutable
BEFORE UPDATE OR DELETE ON public.published_executable_closures
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_release_fact_change();

REVOKE ALL ON TABLE public.published_executable_closures FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.register_prepared_executable_closure(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_compiled_agent_release(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_compiled_flow_version(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.register_prepared_executable_closure(jsonb),
  app.publish_compiled_agent_release(jsonb), app.publish_compiled_flow_version(jsonb)
  FROM ba_runtime, ba_control_executor, ba_management_attestation_issuer,
    ba_subject_assertion_verifier, ba_auth_owner;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA auth FROM ba_authorization_owner;
