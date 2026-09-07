DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM public.agent_drafts WHERE strategy_profile->>'schema_version'='product-agent-strategy/5')
 OR EXISTS(SELECT 1 FROM public.agent_product_releases WHERE strategy_profile->>'schema_version'='product-agent-strategy/5')
 OR EXISTS(SELECT 1 FROM public.agent_product_subagent_bindings)
 OR EXISTS(SELECT 1 FROM public.agent_product_release_subagent_bindings)
 THEN RAISE EXCEPTION 'cannot remove product Agent SubAgent evidence while v5 policy or pinned evidence exists'; END IF;
END;$guard$;

REVOKE EXECUTE ON FUNCTION app.create_agent_draft_with_strategy_capabilities_v5(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid),app.update_agent_draft_with_strategy_capabilities_v5(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid),app.read_agent_product_run_subagent(uuid,uuid,uuid),app.record_agent_product_run_decision_v5(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,bigint,bigint,bigint,text) FROM ba_runtime;
DROP FUNCTION app.create_agent_draft_with_strategy_capabilities_v5(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid);
DROP FUNCTION app.update_agent_draft_with_strategy_capabilities_v5(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid);
DROP FUNCTION app.read_agent_product_run_subagent(uuid,uuid,uuid);
DROP FUNCTION app.record_agent_product_run_decision_v5(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,bigint,bigint,bigint,text);
DROP FUNCTION app.read_agent_product_run_capabilities(uuid,uuid,uuid);
DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);

GRANT USAGE,CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;
DROP TRIGGER agent_product_release_subagent_snapshot ON public.agent_product_releases;
DROP FUNCTION app.snapshot_agent_product_release_subagent();
DROP TRIGGER agent_product_release_subagent_bindings_immutable ON public.agent_product_release_subagent_bindings;
DROP TABLE public.agent_product_release_subagent_bindings;
DROP TABLE public.agent_product_subagent_bindings;

CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,revision bigint,
created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,database_table_id uuid,role_mode text,
role_profile jsonb,strategy_profile jsonb,strategy_version bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
 k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version
 FROM public.agent_drafts d LEFT JOIN public.agent_product_knowledge_bindings k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;$function$;
CREATE FUNCTION app.read_agent_product_run_capabilities(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid)
RETURNS TABLE(knowledge boolean,database boolean) LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT EXISTS(SELECT 1 FROM public.agent_product_release_knowledge_bindings b WHERE b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version),
 EXISTS(SELECT 1 FROM public.agent_product_release_database_bindings b WHERE b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version)
 FROM public.agent_product_runs r JOIN public.agent_product_conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 JOIN public.agent_product_releases x ON x.workspace_id=c.workspace_id AND x.agent_id=c.agent_id AND x.version=c.release_version
 WHERE r.workspace_id=p_workspace_id AND r.id=p_run_id AND r.status='pending' AND r.effective_parameters IS NOT NULL
 AND c.actor_id=p_actor_id AND x.strategy_profile->>'schema_version'='product-agent-strategy/4';$function$;
ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_run_capabilities(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),app.read_agent_product_run_capabilities(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),app.read_agent_product_run_capabilities(uuid,uuid,uuid) TO ba_runtime;
RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
