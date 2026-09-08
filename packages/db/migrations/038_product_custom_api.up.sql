-- Workspace-scoped custom HTTPS APIs. Every resource change creates an
-- immutable revision; Flow graphs pin the exact revision and its public
-- transport snapshot so published behavior cannot float.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_custom_api_resources (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  current_revision bigint NOT NULL CHECK (current_revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE public.product_custom_api_releases (
  workspace_id uuid NOT NULL,
  api_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) <= 500),
  method text NOT NULL CHECK (method IN ('GET', 'POST')),
  endpoint_url text NOT NULL CHECK (
    length(endpoint_url) BETWEEN 12 AND 2000
    AND endpoint_url ~ '^https://[A-Za-z0-9.-]*[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z0-9-]+(/[^#]*)?$'
  ),
  response_path text NOT NULL CHECK (
    response_path = ''
    OR response_path ~ '^[A-Za-z][A-Za-z0-9_]{0,39}(\.[A-Za-z][A-Za-z0-9_]{0,39}){0,5}$'
  ),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, api_id, revision),
  FOREIGN KEY (workspace_id, api_id)
    REFERENCES public.product_custom_api_resources(workspace_id, id)
);

ALTER TABLE public.product_custom_api_resources OWNER TO ba_authorization_owner;
ALTER TABLE public.product_custom_api_releases OWNER TO ba_authorization_owner;
ALTER TABLE public.product_custom_api_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_custom_api_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_custom_api_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_custom_api_releases FORCE ROW LEVEL SECURITY;

CREATE POLICY product_custom_api_resources_owner_only ON public.product_custom_api_resources
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_custom_api_releases_owner_only ON public.product_custom_api_releases
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.product_custom_api_resources, public.product_custom_api_releases FROM PUBLIC;
REVOKE ALL ON public.product_custom_api_resources, public.product_custom_api_releases FROM ba_runtime;

CREATE TRIGGER product_custom_api_releases_immutable
BEFORE UPDATE OR DELETE ON public.product_custom_api_releases
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.list_product_custom_apis(p_workspace_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  revision bigint,
  method text,
  endpoint_url text,
  response_path text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT resource.id, release.name, release.description, release.revision,
    release.method, release.endpoint_url, release.response_path,
    resource.created_at, resource.updated_at
  FROM public.product_custom_api_resources AS resource
  JOIN public.product_custom_api_releases AS release
    ON release.workspace_id = resource.workspace_id
   AND release.api_id = resource.id
   AND release.revision = resource.current_revision
  WHERE resource.workspace_id = p_workspace_id
  ORDER BY resource.updated_at DESC, resource.id
  LIMIT 100;
$function$;

CREATE FUNCTION app.create_product_custom_api(
  p_workspace_id uuid, p_actor_id uuid, p_name text, p_description text,
  p_method text, p_endpoint_url text, p_response_path text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Custom API actor is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.product_custom_api_resources (
    workspace_id, id, name, description, current_revision, created_by
  ) VALUES (p_workspace_id, v_id, btrim(p_name), p_description, 1, p_actor_id);
  INSERT INTO public.product_custom_api_releases (
    workspace_id, api_id, revision, name, description, method,
    endpoint_url, response_path, published_by
  ) VALUES (
    p_workspace_id, v_id, 1, btrim(p_name), p_description, p_method,
    p_endpoint_url, p_response_path, p_actor_id
  );
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.update_product_custom_api(
  p_workspace_id uuid, p_api_id uuid, p_expected_revision bigint, p_actor_id uuid,
  p_name text, p_description text, p_method text, p_endpoint_url text, p_response_path text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_revision bigint;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Custom API actor is required' USING ERRCODE = '22023';
  END IF;
  SELECT resource.current_revision + 1 INTO v_revision
  FROM public.product_custom_api_resources AS resource
  WHERE resource.workspace_id = p_workspace_id
    AND resource.id = p_api_id
    AND resource.current_revision = p_expected_revision
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom API revision conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE public.product_custom_api_resources
  SET name = btrim(p_name), description = p_description,
      current_revision = v_revision, updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_api_id;
  INSERT INTO public.product_custom_api_releases (
    workspace_id, api_id, revision, name, description, method,
    endpoint_url, response_path, published_by
  ) VALUES (
    p_workspace_id, p_api_id, v_revision, btrim(p_name), p_description,
    p_method, p_endpoint_url, p_response_path, p_actor_id
  );
END;
$function$;

CREATE FUNCTION app.assert_product_flow_apis_pinned(p_workspace_id uuid, p_graph jsonb)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_node jsonb;
  v_api_id uuid;
  v_revision bigint;
BEGIN
  IF p_graph IS NULL OR jsonb_typeof(p_graph) <> 'object'
     OR jsonb_typeof(p_graph -> 'nodes') <> 'array' THEN
    RAISE EXCEPTION 'Flow graph is invalid' USING ERRCODE = '22023';
  END IF;
  FOR v_node IN
    SELECT node FROM jsonb_array_elements(p_graph -> 'nodes') AS node
    WHERE node ->> 'type' = 'api'
  LOOP
    BEGIN
      v_api_id := (v_node #>> '{config,apiId}')::uuid;
      v_revision := (v_node #>> '{config,apiRevision}')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Flow API resource snapshot is not pinned' USING ERRCODE = '22023';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM public.product_custom_api_releases AS release
      WHERE release.workspace_id = p_workspace_id
        AND release.api_id = v_api_id
        AND release.revision = v_revision
        AND release.method = v_node #>> '{config,method}'
        AND release.endpoint_url = v_node #>> '{config,url}'
        AND release.response_path = v_node #>> '{config,responsePath}'
    ) THEN
      RAISE EXCEPTION 'Flow API resource snapshot is not pinned' USING ERRCODE = '42501';
    END IF;
  END LOOP;
END;
$function$;

CREATE FUNCTION app.assert_product_flow_resources_pinned(p_workspace_id uuid, p_graph jsonb)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  PERFORM app.assert_product_flow_plugins_installed(p_workspace_id, p_graph);
  PERFORM app.assert_product_flow_apis_pinned(p_workspace_id, p_graph);
END;
$function$;

CREATE OR REPLACE FUNCTION app.create_product_flow_draft(
  p_workspace_id uuid, p_actor_id uuid, p_name text, p_description text, p_graph jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM app.assert_product_flow_resources_pinned(p_workspace_id, p_graph);
  INSERT INTO public.product_flow_drafts (workspace_id, id, name, description, graph, created_by)
  VALUES (p_workspace_id, v_id, btrim(p_name), p_description, p_graph, p_actor_id);
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION app.update_product_flow_draft(
  p_workspace_id uuid, p_flow_id uuid, p_expected_revision bigint,
  p_name text, p_description text, p_graph jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  PERFORM app.assert_product_flow_resources_pinned(p_workspace_id, p_graph);
  UPDATE public.product_flow_drafts
  SET name = btrim(p_name), description = p_description, graph = p_graph,
      status = 'draft', revision = revision + 1, updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_flow_id AND revision = p_expected_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow draft revision conflict' USING ERRCODE = '40001';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION app.publish_product_flow(
  p_workspace_id uuid, p_flow_id uuid, p_expected_revision bigint,
  p_actor_id uuid, p_environment text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_draft public.product_flow_drafts; v_version bigint;
BEGIN
  IF p_environment NOT IN ('development', 'staging', 'production') THEN
    RAISE EXCEPTION 'unsupported Flow environment' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_draft FROM public.product_flow_drafts
  WHERE workspace_id = p_workspace_id AND id = p_flow_id AND revision = p_expected_revision
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow draft revision conflict' USING ERRCODE = '40001';
  END IF;
  PERFORM app.assert_product_flow_resources_pinned(p_workspace_id, v_draft.graph);
  SELECT COALESCE(max(version), 0) + 1 INTO v_version FROM public.product_flow_releases
  WHERE workspace_id = p_workspace_id AND flow_id = p_flow_id;
  INSERT INTO public.product_flow_releases
    (workspace_id, flow_id, version, name, description, graph, published_by)
  VALUES (p_workspace_id, p_flow_id, v_version, v_draft.name, v_draft.description, v_draft.graph, p_actor_id);
  INSERT INTO public.product_flow_deployments
    (workspace_id, flow_id, environment, release_version, deployed_by)
  VALUES (p_workspace_id, p_flow_id, p_environment, v_version, p_actor_id)
  ON CONFLICT (workspace_id, flow_id, environment) DO UPDATE
    SET release_version = EXCLUDED.release_version,
        revision = public.product_flow_deployments.revision + 1,
        deployed_by = EXCLUDED.deployed_by, deployed_at = clock_timestamp();
  UPDATE public.product_flow_drafts
  SET status = 'published', revision = revision + 1, updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_flow_id;
END;
$function$;

CREATE OR REPLACE FUNCTION app.prepare_product_flow_debug(
  p_workspace_id uuid, p_flow_id uuid, p_expected_revision bigint, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_graph jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Flow debug actor is required' USING ERRCODE = '22023';
  END IF;
  SELECT draft.graph INTO v_graph FROM public.product_flow_drafts AS draft
  WHERE draft.workspace_id = p_workspace_id AND draft.id = p_flow_id
    AND draft.revision = p_expected_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow draft revision conflict' USING ERRCODE = '40001';
  END IF;
  PERFORM app.assert_product_flow_resources_pinned(p_workspace_id, v_graph);
  RETURN v_graph;
END;
$function$;

ALTER FUNCTION app.list_product_custom_apis(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_product_custom_api(uuid, uuid, text, text, text, text, text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_product_custom_api(uuid, uuid, bigint, uuid, text, text, text, text, text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_apis_pinned(uuid, jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_resources_pinned(uuid, jsonb) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_product_custom_apis(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_product_custom_api(uuid, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_product_custom_api(uuid, uuid, bigint, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assert_product_flow_apis_pinned(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assert_product_flow_resources_pinned(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_custom_apis(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_product_custom_api(uuid, uuid, text, text, text, text, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.update_product_custom_api(uuid, uuid, bigint, uuid, text, text, text, text, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.assert_product_flow_apis_pinned(uuid, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.assert_product_flow_resources_pinned(uuid, jsonb) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
