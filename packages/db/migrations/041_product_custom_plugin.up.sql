-- Workspace-owned HTTPS Plugin releases. Flow graphs carry an exact executable
-- snapshot and the database verifies it against the installed immutable manifest.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

ALTER TABLE public.product_plugin_releases
  ADD COLUMN owner_workspace_id uuid REFERENCES public.workspaces(id);

CREATE TABLE public.product_custom_plugin_resources (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) <= 500),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_]{0,39}$'),
  endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 12 AND 2000 AND endpoint_url ~ '^https://[A-Za-z0-9.-]*[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z0-9-]+(/[^#]*)?$'),
  response_path text NOT NULL CHECK (response_path = '' OR response_path ~ '^[A-Za-z][A-Za-z0-9_]{0,39}(\.[A-Za-z][A-Za-z0-9_]{0,39}){0,5}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE public.product_custom_plugin_releases (
  workspace_id uuid NOT NULL,
  plugin_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) <= 500),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_]{0,39}$'),
  endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 12 AND 2000 AND endpoint_url ~ '^https://[A-Za-z0-9.-]*[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z0-9-]+(/[^#]*)?$'),
  response_path text NOT NULL CHECK (response_path = '' OR response_path ~ '^[A-Za-z][A-Za-z0-9_]{0,39}(\.[A-Za-z][A-Za-z0-9_]{0,39}){0,5}$'),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, plugin_id, version),
  FOREIGN KEY (workspace_id, plugin_id)
    REFERENCES public.product_custom_plugin_resources(workspace_id, id)
);

ALTER TABLE public.product_custom_plugin_resources OWNER TO ba_authorization_owner;
ALTER TABLE public.product_custom_plugin_releases OWNER TO ba_authorization_owner;
ALTER TABLE public.product_custom_plugin_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_custom_plugin_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_custom_plugin_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_custom_plugin_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY product_custom_plugin_resources_owner_only ON public.product_custom_plugin_resources
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY product_custom_plugin_releases_owner_only ON public.product_custom_plugin_releases
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
REVOKE ALL ON public.product_custom_plugin_resources,public.product_custom_plugin_releases FROM PUBLIC,ba_runtime;
CREATE TRIGGER product_custom_plugin_releases_immutable BEFORE UPDATE OR DELETE
ON public.product_custom_plugin_releases FOR EACH ROW
EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.list_product_custom_plugins(p_workspace_id uuid)
RETURNS TABLE(id uuid,name text,description text,operation text,endpoint_url text,response_path text,
 revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT r.id,r.name,r.description,r.operation,r.endpoint_url,r.response_path,r.revision,r.created_at,r.updated_at
 FROM public.product_custom_plugin_resources r WHERE r.workspace_id=p_workspace_id
 ORDER BY r.updated_at DESC,r.id LIMIT 100;
$function$;

CREATE FUNCTION app.create_product_custom_plugin(
 p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_operation text,
 p_endpoint_url text,p_response_path text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_id uuid:=gen_random_uuid(); v_plugin_id text; v_identity text;
BEGIN
 IF p_actor_id IS NULL THEN RAISE EXCEPTION 'Custom Plugin actor is required' USING ERRCODE='22023'; END IF;
 v_plugin_id:='custom.'||replace(v_id::text,'-',''); v_identity:=v_plugin_id||'.v1';
 INSERT INTO public.product_custom_plugin_resources(workspace_id,id,name,description,operation,endpoint_url,response_path,created_by)
 VALUES(p_workspace_id,v_id,btrim(p_name),p_description,btrim(p_operation),btrim(p_endpoint_url),btrim(p_response_path),p_actor_id);
 INSERT INTO public.product_custom_plugin_releases(workspace_id,plugin_id,version,name,description,operation,endpoint_url,response_path,published_by)
 VALUES(p_workspace_id,v_id,1,btrim(p_name),p_description,btrim(p_operation),btrim(p_endpoint_url),btrim(p_response_path),p_actor_id);
 INSERT INTO public.product_plugin_releases(plugin_id,version,name,description,manifest,owner_workspace_id)
 VALUES(v_plugin_id,1,btrim(p_name),p_description,jsonb_build_object('identity',v_identity,'operations',jsonb_build_array(btrim(p_operation)),
  'runtime','https','pluginId',v_id,'pluginRevision',1,'endpointUrl',btrim(p_endpoint_url),'responsePath',btrim(p_response_path)),p_workspace_id);
 INSERT INTO public.product_plugin_installations(workspace_id,id,plugin_id,release_version,installed_by)
 VALUES(p_workspace_id,gen_random_uuid(),v_plugin_id,1,p_actor_id);
 RETURN v_id;
END;$function$;

CREATE FUNCTION app.update_product_custom_plugin(
 p_workspace_id uuid,p_plugin_id uuid,p_expected_revision bigint,p_actor_id uuid,p_name text,p_description text,
 p_operation text,p_endpoint_url text,p_response_path text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_revision bigint; v_catalog_id text; v_identity text;
BEGIN
 IF p_actor_id IS NULL THEN RAISE EXCEPTION 'Custom Plugin actor is required' USING ERRCODE='22023'; END IF;
 UPDATE public.product_custom_plugin_resources SET name=btrim(p_name),description=p_description,operation=btrim(p_operation),
  endpoint_url=btrim(p_endpoint_url),response_path=btrim(p_response_path),revision=revision+1,updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace_id AND id=p_plugin_id AND revision=p_expected_revision RETURNING revision INTO v_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'Custom Plugin revision conflict' USING ERRCODE='40001'; END IF;
 v_catalog_id:='custom.'||replace(p_plugin_id::text,'-',''); v_identity:=v_catalog_id||'.v'||v_revision::text;
 INSERT INTO public.product_custom_plugin_releases(workspace_id,plugin_id,version,name,description,operation,endpoint_url,response_path,published_by)
 VALUES(p_workspace_id,p_plugin_id,v_revision,btrim(p_name),p_description,btrim(p_operation),btrim(p_endpoint_url),btrim(p_response_path),p_actor_id);
 INSERT INTO public.product_plugin_releases(plugin_id,version,name,description,manifest,owner_workspace_id)
 VALUES(v_catalog_id,v_revision::integer,btrim(p_name),p_description,jsonb_build_object('identity',v_identity,
  'operations',jsonb_build_array(btrim(p_operation)),'runtime','https','pluginId',p_plugin_id,'pluginRevision',v_revision,
  'endpointUrl',btrim(p_endpoint_url),'responsePath',btrim(p_response_path)),p_workspace_id);
 INSERT INTO public.product_plugin_installations(workspace_id,id,plugin_id,release_version,installed_by)
 VALUES(p_workspace_id,gen_random_uuid(),v_catalog_id,v_revision::integer,p_actor_id)
 ON CONFLICT(workspace_id,plugin_id) DO UPDATE SET release_version=EXCLUDED.release_version,
  installed_by=EXCLUDED.installed_by,installed_at=clock_timestamp();
END;$function$;

CREATE OR REPLACE FUNCTION app.list_product_plugin_catalog(p_workspace_id uuid)
RETURNS TABLE(plugin_id text,release_version integer,identity text,name text,description text,manifest jsonb,
 installation_id uuid,installed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT release.plugin_id,release.version,release.identity,release.name,release.description,release.manifest,
  installation.id,installation.installed_at FROM public.product_plugin_releases release
 LEFT JOIN public.product_plugin_installations installation ON installation.workspace_id=p_workspace_id
  AND installation.plugin_id=release.plugin_id AND installation.release_version=release.version
 WHERE release.owner_workspace_id IS NULL OR release.owner_workspace_id=p_workspace_id
 ORDER BY release.plugin_id,release.version DESC LIMIT 200;
$function$;

CREATE OR REPLACE FUNCTION app.assert_product_flow_plugins_installed(p_workspace_id uuid,p_graph jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_node jsonb; v_manifest jsonb;
BEGIN
 IF p_graph IS NULL OR jsonb_typeof(p_graph)<>'object' OR jsonb_typeof(p_graph->'nodes')<>'array'
 THEN RAISE EXCEPTION 'Flow graph is invalid' USING ERRCODE='22023'; END IF;
 FOR v_node IN SELECT value FROM jsonb_array_elements(p_graph->'nodes') WHERE value->>'type'='plugin' LOOP
  SELECT release.manifest INTO v_manifest FROM public.product_plugin_installations installation
  JOIN public.product_plugin_releases release ON release.plugin_id=installation.plugin_id
   AND release.version=installation.release_version
  WHERE installation.workspace_id=p_workspace_id AND release.identity=v_node#>>'{config,plugin}';
  IF NOT FOUND THEN RAISE EXCEPTION 'plugin is not installed in this workspace: %',coalesce(v_node#>>'{config,plugin}','<missing>')
   USING ERRCODE='42501'; END IF;
  IF v_manifest->>'runtime'='https' AND (
    v_node#>>'{config,pluginId}' IS DISTINCT FROM v_manifest->>'pluginId' OR
    v_node#>>'{config,pluginRevision}' IS DISTINCT FROM v_manifest->>'pluginRevision' OR
    v_node#>>'{config,operation}' IS DISTINCT FROM v_manifest#>>'{operations,0}' OR
    v_node#>>'{config,endpointUrl}' IS DISTINCT FROM v_manifest->>'endpointUrl' OR
    v_node#>>'{config,responsePath}' IS DISTINCT FROM v_manifest->>'responsePath')
  THEN RAISE EXCEPTION 'custom Plugin snapshot does not match installed release' USING ERRCODE='42501'; END IF;
 END LOOP;
END;$function$;

ALTER FUNCTION app.list_product_custom_plugins(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_product_custom_plugin(uuid,uuid,text,text,text,text,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_product_custom_plugin(uuid,uuid,bigint,uuid,text,text,text,text,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_plugin_catalog(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_plugins_installed(uuid,jsonb) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_product_custom_plugins(uuid),app.create_product_custom_plugin(uuid,uuid,text,text,text,text,text),
 app.update_product_custom_plugin(uuid,uuid,bigint,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_custom_plugins(uuid),app.create_product_custom_plugin(uuid,uuid,text,text,text,text,text),
 app.update_product_custom_plugin(uuid,uuid,bigint,uuid,text,text,text,text,text) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
