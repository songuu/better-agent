GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_plugin_installations) THEN
    RAISE EXCEPTION 'cannot remove product plugin catalog while installations exist';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION app.create_product_flow_draft(
  p_workspace_id uuid, p_actor_id uuid, p_name text, p_description text, p_graph jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
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
  RETURN v_graph;
END;
$function$;

DROP FUNCTION app.assert_product_flow_plugins_installed(uuid, jsonb);
DROP FUNCTION app.install_product_plugin(uuid, uuid, text, integer);
DROP FUNCTION app.list_product_plugin_catalog(uuid);
DROP TABLE public.product_plugin_installations;
DROP TABLE public.product_plugin_releases;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
