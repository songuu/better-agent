DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM public.agent_product_parallel_subagent_bindings)
  OR EXISTS(SELECT 1 FROM public.agent_product_release_parallel_subagent_bindings)
  OR EXISTS(SELECT 1 FROM public.agent_product_run_subagent_invocations WHERE branch>1)
 THEN RAISE EXCEPTION 'cannot remove parallel SubAgent evidence'; END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.create_agent_draft_with_strategy_capabilities_v10(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint);
DROP FUNCTION app.update_agent_draft_with_strategy_capabilities_v10(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint);
DROP FUNCTION app.read_agent_product_run_subagent_chains(uuid,uuid,uuid);
DROP FUNCTION app.record_agent_product_run_subagent_invocation_v2(uuid,uuid,uuid,bigint,smallint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint);
DROP FUNCTION app.list_agent_product_run_subagent_invocations(uuid);

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
database_table_id uuid,role_mode text,role_profile jsonb,strategy_profile jsonb,strategy_version bigint,
child_agent_id uuid,flow_id uuid,skill_pack_id uuid,skill_pack_release_version bigint,
mcp_server_id uuid,mcp_server_release_version bigint,database_operation_id uuid,database_operation_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
  k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version,s.target_agent_id,f.flow_id,
  sp.skill_pack_id,sp.skill_pack_release_version,m.mcp_server_id,m.mcp_server_release_version,db.operation_id,db.operation_revision
 FROM public.agent_drafts AS d
 LEFT JOIN public.agent_product_knowledge_bindings AS k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings AS db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 LEFT JOIN public.agent_product_subagent_bindings AS s ON s.workspace_id=d.workspace_id AND s.agent_id=d.id
 LEFT JOIN public.agent_product_flow_bindings AS f ON f.workspace_id=d.workspace_id AND f.agent_id=d.id
 LEFT JOIN public.agent_product_skill_pack_bindings AS sp ON sp.workspace_id=d.workspace_id AND sp.agent_id=d.id
 LEFT JOIN public.agent_product_mcp_server_bindings AS m ON m.workspace_id=d.workspace_id AND m.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;
$function$;

CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_subagent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
 v_target uuid;v_version bigint;v_current_agent uuid;v_current_release bigint;
 v_next_agent uuid;v_next_release bigint;v_current_strategy jsonb;
 v_seen uuid[]:=ARRAY[NEW.agent_id];v_depth integer:=1;
BEGIN
 SELECT target_agent_id INTO v_target FROM public.agent_product_subagent_bindings
 WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
 IF v_target IS NULL THEN RETURN NEW; END IF;
 SELECT max(version) INTO v_version FROM public.agent_product_releases
 WHERE workspace_id=NEW.workspace_id AND agent_id=v_target;
 IF v_version IS NULL THEN RAISE EXCEPTION 'bound child Agent has no published release' USING ERRCODE='22023'; END IF;
 v_current_agent:=v_target;v_current_release:=v_version;
 LOOP
  IF v_current_agent=ANY(v_seen) THEN RAISE EXCEPTION 'recursive SubAgent release chain contains a cycle' USING ERRCODE='22023'; END IF;
  v_seen:=array_append(v_seen,v_current_agent);
  SELECT release.strategy_profile INTO v_current_strategy FROM public.agent_product_releases AS release
  WHERE release.workspace_id=NEW.workspace_id AND release.agent_id=v_current_agent AND release.version=v_current_release;
  IF NOT FOUND OR v_current_strategy->>'schema_version'<>'product-agent-strategy/5' THEN EXIT; END IF;
  SELECT binding.target_agent_id,binding.target_release_version INTO v_next_agent,v_next_release
  FROM public.agent_product_release_subagent_bindings AS binding
  WHERE binding.workspace_id=NEW.workspace_id AND binding.agent_id=v_current_agent AND binding.release_version=v_current_release;
  IF NOT FOUND THEN EXIT; END IF;
  IF v_depth>=3 THEN RAISE EXCEPTION 'recursive SubAgent release chain exceeds depth 3' USING ERRCODE='22023'; END IF;
  v_current_agent:=v_next_agent;v_current_release:=v_next_release;v_depth:=v_depth+1;
 END LOOP;
 INSERT INTO public.agent_product_release_subagent_bindings(
  workspace_id,agent_id,release_version,target_agent_id,target_release_version
 ) VALUES(NEW.workspace_id,NEW.agent_id,NEW.version,v_target,v_version);
 RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_agent_product_subagent_decision_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_item jsonb;
BEGIN
 IF jsonb_array_length(NEW.iteration_trace)=jsonb_array_length(OLD.iteration_trace)+1 THEN
  v_item:=NEW.iteration_trace->(jsonb_array_length(NEW.iteration_trace)-1);
  IF v_item->>'action'='tool' AND v_item->>'capability'='subagent' AND NOT EXISTS(
   SELECT 1 FROM public.agent_product_run_subagent_invocations AS invocation
   WHERE invocation.workspace_id=NEW.workspace_id AND invocation.run_id=NEW.id
    AND invocation.parent_iteration=(v_item->>'iteration')::bigint AND invocation.depth=1
    AND invocation.agent_id=(v_item->>'target_agent_id')::uuid
    AND invocation.release_version=(v_item->>'target_release_version')::bigint
    AND invocation.provider_request_id=v_item->>'tool_provider_request_id'
    AND invocation.aggregate_input_tokens=(v_item->>'tool_input_tokens')::bigint
    AND invocation.aggregate_output_tokens=(v_item->>'tool_output_tokens')::bigint
  ) THEN RAISE EXCEPTION 'SubAgent decision is missing its immutable invocation receipt' USING ERRCODE='40001'; END IF;
 END IF;
 RETURN NEW;
END;
$function$;

DROP TABLE public.agent_product_release_parallel_subagent_bindings;
DROP TABLE public.agent_product_parallel_subagent_bindings;

ALTER TABLE public.agent_product_run_subagent_invocations
 DROP CONSTRAINT agent_product_run_subagent_invocations_pkey,
 ADD PRIMARY KEY (workspace_id,run_id,parent_iteration,depth),
 DROP COLUMN branch;

CREATE FUNCTION app.list_agent_product_run_subagent_invocations(p_workspace_id uuid)
RETURNS TABLE(run_id uuid,parent_iteration bigint,depth smallint,agent_id uuid,release_version bigint,
 name text,model text,input_text text,output_text text,provider_request_id text,
 exclusive_input_tokens bigint,exclusive_output_tokens bigint,aggregate_input_tokens bigint,
 aggregate_output_tokens bigint,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT invocation.run_id,invocation.parent_iteration,invocation.depth,invocation.agent_id,
  invocation.release_version,invocation.name,invocation.model,invocation.input_text,
  invocation.output_text,invocation.provider_request_id,invocation.exclusive_input_tokens,
  invocation.exclusive_output_tokens,invocation.aggregate_input_tokens,
  invocation.aggregate_output_tokens,invocation.created_at
 FROM public.agent_product_run_subagent_invocations AS invocation
 WHERE invocation.workspace_id=p_workspace_id
 ORDER BY invocation.created_at DESC,invocation.run_id,invocation.parent_iteration,invocation.depth
 LIMIT 600;
$function$;

ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.snapshot_agent_product_release_subagent() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_agent_product_subagent_decision_receipt() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_product_run_subagent_invocations(uuid) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),
 app.list_agent_product_run_subagent_invocations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),
 app.list_agent_product_run_subagent_invocations(uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
