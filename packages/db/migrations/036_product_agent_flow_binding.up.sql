-- Agent Drafts may bind a Flow; publication pins the exact immutable Flow release.
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_flow_bindings (
  workspace_id uuid NOT NULL, agent_id uuid NOT NULL, flow_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES public.agent_drafts(workspace_id, id),
  FOREIGN KEY (workspace_id, flow_id) REFERENCES public.product_flow_drafts(workspace_id, id)
);
CREATE TABLE public.agent_product_release_flow_bindings (
  workspace_id uuid NOT NULL, agent_id uuid NOT NULL, release_version bigint NOT NULL,
  flow_id uuid NOT NULL, flow_release_version bigint NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id, release_version),
  FOREIGN KEY (workspace_id, agent_id, release_version)
    REFERENCES public.agent_product_releases(workspace_id, agent_id, version),
  FOREIGN KEY (workspace_id, flow_id, flow_release_version)
    REFERENCES public.product_flow_releases(workspace_id, flow_id, version)
);
ALTER TABLE public.agent_product_flow_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_flow_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_flow_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_flow_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_flow_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_flow_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_product_flow_bindings_owner_only ON public.agent_product_flow_bindings
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY agent_product_release_flow_bindings_owner_only ON public.agent_product_release_flow_bindings
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
REVOKE ALL ON public.agent_product_flow_bindings, public.agent_product_release_flow_bindings FROM PUBLIC,ba_runtime;
CREATE TRIGGER agent_product_release_flow_bindings_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_flow_bindings
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.snapshot_agent_product_release_flow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_flow uuid; v_version bigint;
BEGIN
  SELECT flow_id INTO v_flow FROM public.agent_product_flow_bindings
    WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
  IF v_flow IS NULL THEN RETURN NEW; END IF;
  SELECT max(version) INTO v_version FROM public.product_flow_releases
    WHERE workspace_id=NEW.workspace_id AND flow_id=v_flow;
  IF v_version IS NULL THEN RAISE EXCEPTION 'bound Flow has no published release' USING ERRCODE='22023'; END IF;
  INSERT INTO public.agent_product_release_flow_bindings(workspace_id,agent_id,release_version,flow_id,flow_release_version)
    VALUES(NEW.workspace_id,NEW.agent_id,NEW.version,v_flow,v_version);
  RETURN NEW;
END;$function$;
CREATE TRIGGER agent_product_release_flow_snapshot AFTER INSERT ON public.agent_product_releases
FOR EACH ROW EXECUTE FUNCTION app.snapshot_agent_product_release_flow();

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
database_table_id uuid,role_mode text,role_profile jsonb,strategy_profile jsonb,strategy_version bigint,child_agent_id uuid,flow_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
 k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version,s.target_agent_id,f.flow_id
 FROM public.agent_drafts d LEFT JOIN public.agent_product_knowledge_bindings k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 LEFT JOIN public.agent_product_subagent_bindings s ON s.workspace_id=d.workspace_id AND s.agent_id=d.id
 LEFT JOIN public.agent_product_flow_bindings f ON f.workspace_id=d.workspace_id AND f.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;$function$;

CREATE FUNCTION app.create_agent_draft_with_strategy_capabilities_v6(
 p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,p_child_agent_id uuid,p_flow_id uuid)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF p_flow_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.product_flow_releases WHERE workspace_id=p_workspace_id AND flow_id=p_flow_id)
 THEN RAISE EXCEPTION 'Agent Flow binding is invalid or unpublished' USING ERRCODE='22023'; END IF;
 v:=app.create_agent_draft_with_strategy_capabilities_v5(p_workspace_id,p_actor_id,p_name,p_description,p_instructions,p_model,
   p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_id);
 IF p_flow_id IS NOT NULL THEN INSERT INTO public.agent_product_flow_bindings VALUES(p_workspace_id,v.id,p_flow_id,clock_timestamp()); END IF;
 RETURN v;
END;$function$;
CREATE FUNCTION app.update_agent_draft_with_strategy_capabilities_v6(
 p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,p_child_agent_id uuid,p_flow_id uuid)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF p_flow_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.product_flow_releases WHERE workspace_id=p_workspace_id AND flow_id=p_flow_id)
 THEN RAISE EXCEPTION 'Agent Flow binding is invalid or unpublished' USING ERRCODE='22023'; END IF;
 v:=app.update_agent_draft_with_strategy_capabilities_v5(p_workspace_id,p_agent_id,p_expected_revision,p_name,p_description,p_instructions,p_model,
   p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_id);
 DELETE FROM public.agent_product_flow_bindings WHERE workspace_id=p_workspace_id AND agent_id=p_agent_id;
 IF p_flow_id IS NOT NULL THEN INSERT INTO public.agent_product_flow_bindings VALUES(p_workspace_id,p_agent_id,p_flow_id,clock_timestamp()); END IF;
 RETURN v;
END;$function$;

CREATE FUNCTION app.read_agent_product_run_flow(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid)
RETURNS TABLE(flow_id uuid,flow_release_version bigint,name text,graph jsonb)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT f.flow_id,f.version,f.name,f.graph
 FROM public.agent_product_runs r
 JOIN public.agent_product_conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 JOIN public.agent_product_release_flow_bindings b ON b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version
 JOIN public.product_flow_releases f ON f.workspace_id=b.workspace_id AND f.flow_id=b.flow_id AND f.version=b.flow_release_version
 WHERE r.workspace_id=p_workspace_id AND r.id=p_run_id AND r.status='pending' AND c.actor_id=p_actor_id;$function$;

ALTER FUNCTION app.snapshot_agent_product_release_flow() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_strategy_capabilities_v6(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_strategy_capabilities_v6(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_run_flow(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.snapshot_agent_product_release_flow(),app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v6(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid),
 app.update_agent_draft_with_strategy_capabilities_v6(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid),
 app.read_agent_product_run_flow(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v6(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid),
 app.update_agent_draft_with_strategy_capabilities_v6(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid),
 app.read_agent_product_run_flow(uuid,uuid,uuid) TO ba_runtime;
RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
