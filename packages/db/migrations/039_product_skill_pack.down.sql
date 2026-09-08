DO $guard$
BEGIN
 IF EXISTS (SELECT 1 FROM public.product_skill_pack_resources) THEN
  RAISE EXCEPTION 'Cannot roll back product Skill Pack migration while resources exist';
 END IF;
END;$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.read_agent_product_run_skill_pack(uuid,uuid,uuid);
DROP FUNCTION app.update_agent_draft_with_strategy_capabilities_v7(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint);
DROP FUNCTION app.create_agent_draft_with_strategy_capabilities_v7(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint);
DROP FUNCTION app.update_product_skill_pack(uuid,uuid,bigint,uuid,text,text,text);
DROP FUNCTION app.create_product_skill_pack(uuid,uuid,text,text,text);
DROP FUNCTION app.list_product_skill_packs(uuid);
DROP TRIGGER agent_product_release_skill_pack_snapshot ON public.agent_product_releases;
DROP FUNCTION app.snapshot_agent_product_release_skill_pack();
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
ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) TO ba_runtime;

DROP TABLE public.agent_product_release_skill_pack_bindings;
DROP TABLE public.agent_product_skill_pack_bindings;
DROP TABLE public.product_skill_pack_releases;
DROP TABLE public.product_skill_pack_resources;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
