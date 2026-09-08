-- Workspace-owned MCP Streamable HTTP endpoints. Mutable heads use CAS;
-- executable Agent releases pin immutable endpoint/tool versions.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_mcp_server_resources (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) <= 500),
  endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 12 AND 2000 AND endpoint_url ~ '^https://'),
  tool_name text NOT NULL CHECK (tool_name ~ '^[A-Za-z][A-Za-z0-9_.-]{0,79}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE public.product_mcp_server_releases (
  workspace_id uuid NOT NULL,
  mcp_server_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text NOT NULL,
  endpoint_url text NOT NULL,
  tool_name text NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, mcp_server_id, version),
  FOREIGN KEY (workspace_id, mcp_server_id)
    REFERENCES public.product_mcp_server_resources(workspace_id, id)
);

CREATE TABLE public.agent_product_mcp_server_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  mcp_server_id uuid NOT NULL,
  mcp_server_release_version bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES public.agent_drafts(workspace_id, id),
  FOREIGN KEY (workspace_id, mcp_server_id, mcp_server_release_version)
    REFERENCES public.product_mcp_server_releases(workspace_id, mcp_server_id, version)
);

CREATE TABLE public.agent_product_release_mcp_server_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL,
  mcp_server_id uuid NOT NULL,
  mcp_server_release_version bigint NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id, release_version),
  FOREIGN KEY (workspace_id, agent_id, release_version)
    REFERENCES public.agent_product_releases(workspace_id, agent_id, version),
  FOREIGN KEY (workspace_id, mcp_server_id, mcp_server_release_version)
    REFERENCES public.product_mcp_server_releases(workspace_id, mcp_server_id, version)
);

ALTER TABLE public.product_mcp_server_resources OWNER TO ba_authorization_owner;
ALTER TABLE public.product_mcp_server_releases OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_mcp_server_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_mcp_server_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.product_mcp_server_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_mcp_server_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_mcp_server_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_mcp_server_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_mcp_server_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_mcp_server_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_mcp_server_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_mcp_server_bindings FORCE ROW LEVEL SECURITY;

CREATE POLICY product_mcp_server_resources_owner_only ON public.product_mcp_server_resources
  USING (current_user = 'ba_authorization_owner') WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_mcp_server_releases_owner_only ON public.product_mcp_server_releases
  USING (current_user = 'ba_authorization_owner') WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_mcp_server_bindings_owner_only ON public.agent_product_mcp_server_bindings
  USING (current_user = 'ba_authorization_owner') WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_release_mcp_server_bindings_owner_only ON public.agent_product_release_mcp_server_bindings
  USING (current_user = 'ba_authorization_owner') WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.product_mcp_server_resources, public.product_mcp_server_releases,
  public.agent_product_mcp_server_bindings, public.agent_product_release_mcp_server_bindings
  FROM PUBLIC,ba_runtime;

CREATE TRIGGER product_mcp_server_releases_immutable
BEFORE UPDATE OR DELETE ON public.product_mcp_server_releases
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();
CREATE TRIGGER agent_product_release_mcp_server_bindings_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_mcp_server_bindings
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.list_product_mcp_servers(p_workspace_id uuid)
RETURNS TABLE(id uuid,name text,description text,endpoint_url text,tool_name text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT r.id,r.name,r.description,r.endpoint_url,r.tool_name,r.revision,r.created_at,r.updated_at
 FROM public.product_mcp_server_resources r WHERE r.workspace_id=p_workspace_id
 ORDER BY r.updated_at DESC,r.id LIMIT 100;
$function$;

CREATE FUNCTION app.create_product_mcp_server(
 p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_endpoint_url text,p_tool_name text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.product_mcp_server_resources(workspace_id,id,name,description,endpoint_url,tool_name,created_by)
 VALUES(p_workspace_id,v_id,btrim(p_name),p_description,btrim(p_endpoint_url),btrim(p_tool_name),p_actor_id);
 INSERT INTO public.product_mcp_server_releases(workspace_id,mcp_server_id,version,name,description,endpoint_url,tool_name,published_by)
 VALUES(p_workspace_id,v_id,1,btrim(p_name),p_description,btrim(p_endpoint_url),btrim(p_tool_name),p_actor_id);
 RETURN v_id;
END;$function$;

CREATE FUNCTION app.update_product_mcp_server(
 p_workspace_id uuid,p_mcp_server_id uuid,p_expected_revision bigint,p_actor_id uuid,
 p_name text,p_description text,p_endpoint_url text,p_tool_name text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_revision bigint;
BEGIN
 UPDATE public.product_mcp_server_resources SET name=btrim(p_name),description=p_description,
  endpoint_url=btrim(p_endpoint_url),tool_name=btrim(p_tool_name),revision=revision+1,updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace_id AND id=p_mcp_server_id AND revision=p_expected_revision
 RETURNING revision INTO v_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'MCP server revision conflict' USING ERRCODE='40001'; END IF;
 INSERT INTO public.product_mcp_server_releases(workspace_id,mcp_server_id,version,name,description,endpoint_url,tool_name,published_by)
 VALUES(p_workspace_id,p_mcp_server_id,v_revision,btrim(p_name),p_description,btrim(p_endpoint_url),btrim(p_tool_name),p_actor_id);
END;$function$;

CREATE FUNCTION app.snapshot_agent_product_release_mcp_server() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
BEGIN
 INSERT INTO public.agent_product_release_mcp_server_bindings(
  workspace_id,agent_id,release_version,mcp_server_id,mcp_server_release_version)
 SELECT NEW.workspace_id,NEW.agent_id,NEW.version,b.mcp_server_id,b.mcp_server_release_version
 FROM public.agent_product_mcp_server_bindings b
 WHERE b.workspace_id=NEW.workspace_id AND b.agent_id=NEW.agent_id;
 RETURN NEW;
END;$function$;
CREATE TRIGGER agent_product_release_mcp_server_snapshot AFTER INSERT ON public.agent_product_releases
FOR EACH ROW EXECUTE FUNCTION app.snapshot_agent_product_release_mcp_server();

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
database_table_id uuid,role_mode text,role_profile jsonb,strategy_profile jsonb,strategy_version bigint,
child_agent_id uuid,flow_id uuid,skill_pack_id uuid,skill_pack_release_version bigint,
mcp_server_id uuid,mcp_server_release_version bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
 k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version,s.target_agent_id,f.flow_id,
 sp.skill_pack_id,sp.skill_pack_release_version,m.mcp_server_id,m.mcp_server_release_version
 FROM public.agent_drafts d LEFT JOIN public.agent_product_knowledge_bindings k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 LEFT JOIN public.agent_product_subagent_bindings s ON s.workspace_id=d.workspace_id AND s.agent_id=d.id
 LEFT JOIN public.agent_product_flow_bindings f ON f.workspace_id=d.workspace_id AND f.agent_id=d.id
 LEFT JOIN public.agent_product_skill_pack_bindings sp ON sp.workspace_id=d.workspace_id AND sp.agent_id=d.id
 LEFT JOIN public.agent_product_mcp_server_bindings m ON m.workspace_id=d.workspace_id AND m.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;
$function$;

CREATE FUNCTION app.create_agent_draft_with_strategy_capabilities_v8(
 p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,
 p_child_agent_id uuid,p_flow_id uuid,p_skill_pack_id uuid,p_skill_pack_release_version bigint,
 p_mcp_server_id uuid,p_mcp_server_release_version bigint)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF (p_mcp_server_id IS NULL) <> (p_mcp_server_release_version IS NULL) THEN
  RAISE EXCEPTION 'Agent MCP server binding is incomplete' USING ERRCODE='22023'; END IF;
 IF p_mcp_server_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.product_mcp_server_releases
  WHERE workspace_id=p_workspace_id AND mcp_server_id=p_mcp_server_id AND version=p_mcp_server_release_version)
 THEN RAISE EXCEPTION 'Agent MCP server binding is invalid' USING ERRCODE='22023'; END IF;
 v:=app.create_agent_draft_with_strategy_capabilities_v7(p_workspace_id,p_actor_id,p_name,p_description,p_instructions,p_model,
  p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_id,p_flow_id,
  p_skill_pack_id,p_skill_pack_release_version);
 IF p_mcp_server_id IS NOT NULL THEN INSERT INTO public.agent_product_mcp_server_bindings
  VALUES(p_workspace_id,v.id,p_mcp_server_id,p_mcp_server_release_version,clock_timestamp()); END IF;
 RETURN v;
END;$function$;

CREATE FUNCTION app.update_agent_draft_with_strategy_capabilities_v8(
 p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,
 p_child_agent_id uuid,p_flow_id uuid,p_skill_pack_id uuid,p_skill_pack_release_version bigint,
 p_mcp_server_id uuid,p_mcp_server_release_version bigint)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF (p_mcp_server_id IS NULL) <> (p_mcp_server_release_version IS NULL) THEN
  RAISE EXCEPTION 'Agent MCP server binding is incomplete' USING ERRCODE='22023'; END IF;
 IF p_mcp_server_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.product_mcp_server_releases
  WHERE workspace_id=p_workspace_id AND mcp_server_id=p_mcp_server_id AND version=p_mcp_server_release_version)
 THEN RAISE EXCEPTION 'Agent MCP server binding is invalid' USING ERRCODE='22023'; END IF;
 v:=app.update_agent_draft_with_strategy_capabilities_v7(p_workspace_id,p_agent_id,p_expected_revision,p_name,p_description,p_instructions,p_model,
  p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_id,p_flow_id,
  p_skill_pack_id,p_skill_pack_release_version);
 DELETE FROM public.agent_product_mcp_server_bindings WHERE workspace_id=p_workspace_id AND agent_id=p_agent_id;
 IF p_mcp_server_id IS NOT NULL THEN INSERT INTO public.agent_product_mcp_server_bindings
  VALUES(p_workspace_id,p_agent_id,p_mcp_server_id,p_mcp_server_release_version,clock_timestamp()); END IF;
 RETURN v;
END;$function$;

CREATE FUNCTION app.read_agent_product_run_mcp_server(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid)
RETURNS TABLE(mcp_server_id uuid,release_version bigint,name text,endpoint_url text,tool_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT p.mcp_server_id,p.version,p.name,p.endpoint_url,p.tool_name
 FROM public.agent_product_runs r
 JOIN public.agent_product_conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 JOIN public.agent_product_release_mcp_server_bindings b ON b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version
 JOIN public.product_mcp_server_releases p ON p.workspace_id=b.workspace_id AND p.mcp_server_id=b.mcp_server_id AND p.version=b.mcp_server_release_version
 WHERE r.workspace_id=p_workspace_id AND r.id=p_run_id AND r.status='pending' AND c.actor_id=p_actor_id;
$function$;

ALTER FUNCTION app.list_product_mcp_servers(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_product_mcp_server(uuid,uuid,text,text,text,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_product_mcp_server(uuid,uuid,bigint,uuid,text,text,text,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.snapshot_agent_product_release_mcp_server() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_strategy_capabilities_v8(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_strategy_capabilities_v8(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_run_mcp_server(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_product_mcp_servers(uuid),app.create_product_mcp_server(uuid,uuid,text,text,text,text),
 app.update_product_mcp_server(uuid,uuid,bigint,uuid,text,text,text,text),app.snapshot_agent_product_release_mcp_server(),
 app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v8(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint),
 app.update_agent_draft_with_strategy_capabilities_v8(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint),
 app.read_agent_product_run_mcp_server(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_mcp_servers(uuid),app.create_product_mcp_server(uuid,uuid,text,text,text,text),
 app.update_product_mcp_server(uuid,uuid,bigint,uuid,text,text,text,text),app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v8(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint),
 app.update_agent_draft_with_strategy_capabilities_v8(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint),
 app.read_agent_product_run_mcp_server(uuid,uuid,uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
