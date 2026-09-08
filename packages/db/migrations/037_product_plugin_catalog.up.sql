-- Versioned plugin catalog and workspace installations. Flow drafts, debug
-- runs and releases may reference only an exact plugin release installed in
-- the same workspace.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_plugin_releases (
  plugin_id text NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  identity text GENERATED ALWAYS AS (plugin_id || '.v' || version::text) STORED,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) <= 500),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (plugin_id, version),
  UNIQUE (identity)
);

CREATE TABLE public.product_plugin_installations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  plugin_id text NOT NULL,
  release_version integer NOT NULL,
  installed_by uuid NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, plugin_id),
  FOREIGN KEY (plugin_id, release_version)
    REFERENCES public.product_plugin_releases(plugin_id, version)
);

ALTER TABLE public.product_plugin_releases OWNER TO ba_authorization_owner;
ALTER TABLE public.product_plugin_installations OWNER TO ba_authorization_owner;
ALTER TABLE public.product_plugin_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_plugin_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_plugin_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_plugin_installations FORCE ROW LEVEL SECURITY;

CREATE POLICY product_plugin_releases_owner_only ON public.product_plugin_releases
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_plugin_installations_owner_only ON public.product_plugin_installations
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.product_plugin_releases, public.product_plugin_installations FROM PUBLIC;
REVOKE ALL ON public.product_plugin_releases, public.product_plugin_installations FROM ba_runtime;

INSERT INTO public.product_plugin_releases (
  plugin_id, version, name, description, manifest
) VALUES (
  'builtin.text', 1, '文本分析', 'Unicode 码点与空白分隔词数统计。',
  '{"identity":"builtin.text.v1","operations":["character_count","word_count"],"runtime":"deterministic"}'::jsonb
);

CREATE TRIGGER product_plugin_releases_immutable
BEFORE UPDATE OR DELETE ON public.product_plugin_releases
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.list_product_plugin_catalog(p_workspace_id uuid)
RETURNS TABLE (
  plugin_id text,
  release_version integer,
  identity text,
  name text,
  description text,
  manifest jsonb,
  installation_id uuid,
  installed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT release.plugin_id, release.version, release.identity, release.name,
    release.description, release.manifest, installation.id, installation.installed_at
  FROM public.product_plugin_releases AS release
  LEFT JOIN public.product_plugin_installations AS installation
    ON installation.workspace_id = p_workspace_id
   AND installation.plugin_id = release.plugin_id
   AND installation.release_version = release.version
  ORDER BY release.plugin_id, release.version DESC
  LIMIT 100;
$function$;

CREATE FUNCTION app.install_product_plugin(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_plugin_id text,
  p_release_version integer
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_plugin_id IS NULL OR p_release_version IS NULL THEN
    RAISE EXCEPTION 'Plugin installation request is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.product_plugin_releases AS release
    WHERE release.plugin_id = p_plugin_id AND release.version = p_release_version
  ) THEN
    RAISE EXCEPTION 'Plugin release not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.product_plugin_installations (
    workspace_id, id, plugin_id, release_version, installed_by
  ) VALUES (
    p_workspace_id, gen_random_uuid(), p_plugin_id, p_release_version, p_actor_id
  ) ON CONFLICT (workspace_id, plugin_id) DO UPDATE
    SET release_version = EXCLUDED.release_version,
        installed_by = EXCLUDED.installed_by,
        installed_at = clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.assert_product_flow_plugins_installed(
  p_workspace_id uuid,
  p_graph jsonb
) RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_identity text;
BEGIN
  IF p_graph IS NULL OR jsonb_typeof(p_graph) <> 'object'
     OR jsonb_typeof(p_graph -> 'nodes') <> 'array' THEN
    RAISE EXCEPTION 'Flow graph is invalid' USING ERRCODE = '22023';
  END IF;
  FOR v_identity IN
    SELECT DISTINCT node #>> '{config,plugin}'
    FROM jsonb_array_elements(p_graph -> 'nodes') AS node
    WHERE node ->> 'type' = 'plugin'
  LOOP
    IF v_identity IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.product_plugin_installations AS installation
      JOIN public.product_plugin_releases AS release
        ON release.plugin_id = installation.plugin_id
       AND release.version = installation.release_version
      WHERE installation.workspace_id = p_workspace_id
        AND release.identity = v_identity
    ) THEN
      RAISE EXCEPTION 'plugin is not installed in this workspace: %', coalesce(v_identity, '<missing>')
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END;
$function$;

-- Preserve already-valid plugin Flow drafts across the new installation gate.
INSERT INTO public.product_plugin_installations (
  workspace_id, id, plugin_id, release_version, installed_by
)
SELECT DISTINCT draft.workspace_id, gen_random_uuid(), 'builtin.text', 1, draft.created_by
FROM public.product_flow_drafts AS draft
CROSS JOIN LATERAL jsonb_array_elements(draft.graph -> 'nodes') AS node
WHERE node ->> 'type' = 'plugin'
  AND node #>> '{config,plugin}' = 'builtin.text.v1'
ON CONFLICT (workspace_id, plugin_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app.create_product_flow_draft(
  p_workspace_id uuid, p_actor_id uuid, p_name text, p_description text, p_graph jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM app.assert_product_flow_plugins_installed(p_workspace_id, p_graph);
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
  PERFORM app.assert_product_flow_plugins_installed(p_workspace_id, p_graph);
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
  PERFORM app.assert_product_flow_plugins_installed(p_workspace_id, v_draft.graph);
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
  PERFORM app.assert_product_flow_plugins_installed(p_workspace_id, v_graph);
  RETURN v_graph;
END;
$function$;

ALTER FUNCTION app.list_product_plugin_catalog(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.install_product_plugin(uuid, uuid, text, integer) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_plugins_installed(uuid, jsonb) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_product_plugin_catalog(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.install_product_plugin(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assert_product_flow_plugins_installed(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_plugin_catalog(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.install_product_plugin(uuid, uuid, text, integer) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.assert_product_flow_plugins_installed(uuid, jsonb) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
