DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_custom_plugin_resources) THEN
    RAISE EXCEPTION 'cannot remove custom Plugin storage while resources exist';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.update_product_custom_plugin(uuid,uuid,bigint,uuid,text,text,text,text,text);
DROP FUNCTION app.create_product_custom_plugin(uuid,uuid,text,text,text,text,text);
DROP FUNCTION app.list_product_custom_plugins(uuid);
DROP FUNCTION app.assert_product_flow_plugins_installed(uuid,jsonb);
DROP FUNCTION app.list_product_plugin_catalog(uuid);
DROP TABLE public.product_custom_plugin_releases;
DROP TABLE public.product_custom_plugin_resources;
ALTER TABLE public.product_plugin_releases DROP COLUMN owner_workspace_id;

CREATE FUNCTION app.list_product_plugin_catalog(p_workspace_id uuid)
RETURNS TABLE(plugin_id text,release_version integer,identity text,name text,description text,manifest jsonb,
 installation_id uuid,installed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT release.plugin_id,release.version,release.identity,release.name,release.description,release.manifest,
  installation.id,installation.installed_at FROM public.product_plugin_releases release
 LEFT JOIN public.product_plugin_installations installation ON installation.workspace_id=p_workspace_id
  AND installation.plugin_id=release.plugin_id AND installation.release_version=release.version
 ORDER BY release.plugin_id,release.version DESC LIMIT 100;
$function$;

CREATE FUNCTION app.assert_product_flow_plugins_installed(p_workspace_id uuid,p_graph jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_identity text;
BEGIN
 IF p_graph IS NULL OR jsonb_typeof(p_graph)<>'object' OR jsonb_typeof(p_graph->'nodes')<>'array'
 THEN RAISE EXCEPTION 'Flow graph is invalid' USING ERRCODE='22023'; END IF;
 FOR v_identity IN SELECT DISTINCT node#>>'{config,plugin}' FROM jsonb_array_elements(p_graph->'nodes') node
  WHERE node->>'type'='plugin' LOOP
  IF v_identity IS NULL OR NOT EXISTS(SELECT 1 FROM public.product_plugin_installations installation
   JOIN public.product_plugin_releases release ON release.plugin_id=installation.plugin_id
    AND release.version=installation.release_version
   WHERE installation.workspace_id=p_workspace_id AND release.identity=v_identity)
  THEN RAISE EXCEPTION 'plugin is not installed in this workspace: %',coalesce(v_identity,'<missing>')
   USING ERRCODE='42501'; END IF;
 END LOOP;
END;$function$;

ALTER FUNCTION app.list_product_plugin_catalog(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_plugins_installed(uuid,jsonb) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_product_plugin_catalog(uuid),app.assert_product_flow_plugins_installed(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_plugin_catalog(uuid),app.assert_product_flow_plugins_installed(uuid,jsonb) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
