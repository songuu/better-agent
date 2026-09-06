-- Product-facing Flow Studio. Graph validation is closed in the Web boundary;
-- PostgreSQL owns durable Draft/Release/Deployment/debug facts and CAS.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_flow_drafts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  graph jsonb NOT NULL CHECK (
    jsonb_typeof(graph) = 'object'
    AND jsonb_typeof(graph -> 'nodes') = 'array'
    AND jsonb_typeof(graph -> 'edges') = 'array'
    AND octet_length(graph::text) <= 262144
  ),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE public.product_flow_releases (
  workspace_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text NOT NULL,
  graph jsonb NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, flow_id, version),
  FOREIGN KEY (workspace_id, flow_id)
    REFERENCES public.product_flow_drafts(workspace_id, id)
);

CREATE TABLE public.product_flow_deployments (
  workspace_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  release_version bigint NOT NULL CHECK (release_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  deployed_by uuid NOT NULL,
  deployed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, flow_id, environment),
  FOREIGN KEY (workspace_id, flow_id, release_version)
    REFERENCES public.product_flow_releases(workspace_id, flow_id, version)
);

CREATE TABLE public.product_flow_debug_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  flow_id uuid NOT NULL,
  draft_revision bigint NOT NULL CHECK (draft_revision > 0),
  input_text text NOT NULL CHECK (length(btrim(input_text)) BETWEEN 1 AND 8000),
  output_text text NOT NULL CHECK (length(output_text) <= 20000),
  logs jsonb NOT NULL CHECK (
    jsonb_typeof(logs) = 'array'
    AND jsonb_array_length(logs) BETWEEN 2 AND 32
    AND octet_length(logs::text) <= 65536
  ),
  status text NOT NULL CHECK (status = 'completed'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, flow_id)
    REFERENCES public.product_flow_drafts(workspace_id, id)
);

ALTER TABLE public.product_flow_drafts OWNER TO ba_authorization_owner;
ALTER TABLE public.product_flow_releases OWNER TO ba_authorization_owner;
ALTER TABLE public.product_flow_deployments OWNER TO ba_authorization_owner;
ALTER TABLE public.product_flow_debug_runs OWNER TO ba_authorization_owner;

ALTER TABLE public.product_flow_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_deployments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_debug_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_debug_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY product_flow_drafts_owner_only ON public.product_flow_drafts
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_flow_releases_owner_only ON public.product_flow_releases
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_flow_deployments_owner_only ON public.product_flow_deployments
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_flow_debug_runs_owner_only ON public.product_flow_debug_runs
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.product_flow_drafts, public.product_flow_releases,
  public.product_flow_deployments, public.product_flow_debug_runs FROM PUBLIC;
REVOKE ALL ON public.product_flow_drafts, public.product_flow_releases,
  public.product_flow_deployments, public.product_flow_debug_runs FROM ba_runtime;

CREATE FUNCTION app.reject_product_flow_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'product Flow history is immutable' USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER product_flow_releases_immutable
BEFORE UPDATE OR DELETE ON public.product_flow_releases
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE TRIGGER product_flow_debug_runs_immutable
BEFORE UPDATE OR DELETE ON public.product_flow_debug_runs
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.list_product_flow_drafts(p_workspace_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  graph jsonb,
  status text,
  revision bigint,
  published_version bigint,
  created_at timestamptz,
  updated_at timestamptz,
  deployments jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT
    draft.id,
    draft.name,
    draft.description,
    draft.graph,
    draft.status,
    draft.revision,
    (
      SELECT max(release.version)
      FROM public.product_flow_releases AS release
      WHERE release.workspace_id = draft.workspace_id
        AND release.flow_id = draft.id
    ),
    draft.created_at,
    draft.updated_at,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'environment', deployment.environment,
          'release_version', deployment.release_version,
          'deployed_at', deployment.deployed_at
        ) ORDER BY deployment.environment
      )
      FROM public.product_flow_deployments AS deployment
      WHERE deployment.workspace_id = draft.workspace_id
        AND deployment.flow_id = draft.id
    ), '[]'::jsonb)
  FROM public.product_flow_drafts AS draft
  WHERE draft.workspace_id = p_workspace_id
  ORDER BY draft.updated_at DESC, draft.id
  LIMIT 200;
$function$;

CREATE FUNCTION app.create_product_flow_draft(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_graph jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.product_flow_drafts (
    workspace_id, id, name, description, graph, created_by
  ) VALUES (
    p_workspace_id, v_id, btrim(p_name), p_description, p_graph, p_actor_id
  );
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.update_product_flow_draft(
  p_workspace_id uuid,
  p_flow_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_description text,
  p_graph jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  UPDATE public.product_flow_drafts
  SET name = btrim(p_name),
      description = p_description,
      graph = p_graph,
      status = 'draft',
      revision = revision + 1,
      updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id
    AND id = p_flow_id
    AND revision = p_expected_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow draft revision conflict' USING ERRCODE = '40001';
  END IF;
END;
$function$;

CREATE FUNCTION app.publish_product_flow(
  p_workspace_id uuid,
  p_flow_id uuid,
  p_expected_revision bigint,
  p_actor_id uuid,
  p_environment text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_draft public.product_flow_drafts;
  v_version bigint;
BEGIN
  IF p_environment NOT IN ('development', 'staging', 'production') THEN
    RAISE EXCEPTION 'unsupported Flow environment' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_draft
  FROM public.product_flow_drafts
  WHERE workspace_id = p_workspace_id
    AND id = p_flow_id
    AND revision = p_expected_revision
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow draft revision conflict' USING ERRCODE = '40001';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v_version
  FROM public.product_flow_releases
  WHERE workspace_id = p_workspace_id AND flow_id = p_flow_id;
  INSERT INTO public.product_flow_releases (
    workspace_id, flow_id, version, name, description, graph, published_by
  ) VALUES (
    p_workspace_id, p_flow_id, v_version, v_draft.name, v_draft.description,
    v_draft.graph, p_actor_id
  );
  INSERT INTO public.product_flow_deployments (
    workspace_id, flow_id, environment, release_version, deployed_by
  ) VALUES (
    p_workspace_id, p_flow_id, p_environment, v_version, p_actor_id
  ) ON CONFLICT (workspace_id, flow_id, environment) DO UPDATE
    SET release_version = EXCLUDED.release_version,
        revision = public.product_flow_deployments.revision + 1,
        deployed_by = EXCLUDED.deployed_by,
        deployed_at = clock_timestamp();
  UPDATE public.product_flow_drafts
  SET status = 'published', revision = revision + 1, updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_flow_id;
END;
$function$;

CREATE FUNCTION app.prepare_product_flow_debug(
  p_workspace_id uuid,
  p_flow_id uuid,
  p_expected_revision bigint,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_graph jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Flow debug actor is required' USING ERRCODE = '22023';
  END IF;
  SELECT draft.graph INTO v_graph
  FROM public.product_flow_drafts AS draft
  WHERE draft.workspace_id = p_workspace_id
    AND draft.id = p_flow_id
    AND draft.revision = p_expected_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow draft revision conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_graph;
END;
$function$;

CREATE FUNCTION app.record_product_flow_debug(
  p_workspace_id uuid,
  p_flow_id uuid,
  p_draft_revision bigint,
  p_actor_id uuid,
  p_input_text text,
  p_output_text text,
  p_logs jsonb
) RETURNS public.product_flow_debug_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.product_flow_debug_runs;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.product_flow_drafts AS draft
    WHERE draft.workspace_id = p_workspace_id
      AND draft.id = p_flow_id
      AND draft.revision = p_draft_revision
  ) THEN
    RAISE EXCEPTION 'Flow draft changed during debug' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.product_flow_debug_runs (
    workspace_id, id, flow_id, draft_revision, input_text, output_text,
    logs, status, created_by
  ) VALUES (
    p_workspace_id, gen_random_uuid(), p_flow_id, p_draft_revision,
    btrim(p_input_text), p_output_text, p_logs, 'completed', p_actor_id
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.list_product_flow_debug_runs(p_workspace_id uuid, p_flow_id uuid)
RETURNS SETOF public.product_flow_debug_runs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT debug.*
  FROM public.product_flow_debug_runs AS debug
  WHERE debug.workspace_id = p_workspace_id AND debug.flow_id = p_flow_id
  ORDER BY debug.created_at DESC, debug.id
  LIMIT 100;
$function$;

ALTER FUNCTION app.reject_product_flow_immutable_mutation() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_flow_drafts(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_product_flow_draft(uuid, uuid, text, text, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_product_flow_draft(uuid, uuid, bigint, text, text, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_product_flow(uuid, uuid, bigint, uuid, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.prepare_product_flow_debug(uuid, uuid, bigint, uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_product_flow_debug(uuid, uuid, bigint, uuid, text, text, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_flow_debug_runs(uuid, uuid)
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.reject_product_flow_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_product_flow_drafts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_product_flow_draft(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_product_flow_draft(uuid, uuid, bigint, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_product_flow(uuid, uuid, bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prepare_product_flow_debug(uuid, uuid, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_product_flow_debug(uuid, uuid, bigint, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_product_flow_debug_runs(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.list_product_flow_drafts(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_product_flow_draft(uuid, uuid, text, text, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.update_product_flow_draft(uuid, uuid, bigint, text, text, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.publish_product_flow(uuid, uuid, bigint, uuid, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.prepare_product_flow_debug(uuid, uuid, bigint, uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.record_product_flow_debug(uuid, uuid, bigint, uuid, text, text, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.list_product_flow_debug_runs(uuid, uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
