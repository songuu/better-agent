-- Parallel root SubAgent fan-out with immutable exact releases and branch-aware receipts.
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_parallel_subagent_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 2 AND 3),
  target_agent_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,agent_id,position),
  UNIQUE (workspace_id,agent_id,target_agent_id),
  FOREIGN KEY (workspace_id,agent_id) REFERENCES public.agent_drafts(workspace_id,id),
  FOREIGN KEY (workspace_id,target_agent_id) REFERENCES public.agent_drafts(workspace_id,id),
  CHECK (agent_id<>target_agent_id)
);

CREATE TABLE public.agent_product_release_parallel_subagent_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 2 AND 3),
  target_agent_id uuid NOT NULL,
  target_release_version bigint NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,agent_id,release_version,position),
  UNIQUE (workspace_id,agent_id,release_version,target_agent_id),
  FOREIGN KEY (workspace_id,agent_id,release_version)
    REFERENCES public.agent_product_releases(workspace_id,agent_id,version),
  FOREIGN KEY (workspace_id,target_agent_id,target_release_version)
    REFERENCES public.agent_product_releases(workspace_id,agent_id,version),
  CHECK (agent_id<>target_agent_id)
);

ALTER TABLE public.agent_product_parallel_subagent_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_parallel_subagent_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_parallel_subagent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_parallel_subagent_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_parallel_subagent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_parallel_subagent_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_product_parallel_subagent_bindings_owner_only
  ON public.agent_product_parallel_subagent_bindings
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY agent_product_release_parallel_subagent_bindings_owner_only
  ON public.agent_product_release_parallel_subagent_bindings
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
REVOKE ALL ON public.agent_product_parallel_subagent_bindings,
  public.agent_product_release_parallel_subagent_bindings FROM PUBLIC,ba_runtime;
CREATE TRIGGER agent_product_release_parallel_subagent_bindings_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_parallel_subagent_bindings
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

ALTER TABLE public.agent_product_run_subagent_invocations
  DROP CONSTRAINT agent_product_run_subagent_invocations_pkey,
  ADD COLUMN branch smallint NOT NULL DEFAULT 1 CHECK (branch BETWEEN 1 AND 3),
  ADD PRIMARY KEY (workspace_id,run_id,parent_iteration,branch,depth);

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
database_table_id uuid,role_mode text,role_profile jsonb,strategy_profile jsonb,strategy_version bigint,
child_agent_id uuid,child_agent_ids uuid[],flow_id uuid,skill_pack_id uuid,skill_pack_release_version bigint,
mcp_server_id uuid,mcp_server_release_version bigint,database_operation_id uuid,database_operation_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
  k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version,
  children.child_agent_ids[1],children.child_agent_ids,f.flow_id,sp.skill_pack_id,sp.skill_pack_release_version,
  m.mcp_server_id,m.mcp_server_release_version,db.operation_id,db.operation_revision
 FROM public.agent_drafts AS d
 LEFT JOIN public.agent_product_knowledge_bindings AS k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings AS db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 LEFT JOIN LATERAL (
   SELECT coalesce(array_agg(binding.target_agent_id ORDER BY binding.position),ARRAY[]::uuid[]) AS child_agent_ids
   FROM (
     SELECT 1::smallint AS position,primary_binding.target_agent_id
     FROM public.agent_product_subagent_bindings AS primary_binding
     WHERE primary_binding.workspace_id=d.workspace_id AND primary_binding.agent_id=d.id
     UNION ALL
     SELECT parallel_binding.position,parallel_binding.target_agent_id
     FROM public.agent_product_parallel_subagent_bindings AS parallel_binding
     WHERE parallel_binding.workspace_id=d.workspace_id AND parallel_binding.agent_id=d.id
   ) AS binding
 ) AS children ON true
 LEFT JOIN public.agent_product_flow_bindings AS f ON f.workspace_id=d.workspace_id AND f.agent_id=d.id
 LEFT JOIN public.agent_product_skill_pack_bindings AS sp ON sp.workspace_id=d.workspace_id AND sp.agent_id=d.id
 LEFT JOIN public.agent_product_mcp_server_bindings AS m ON m.workspace_id=d.workspace_id AND m.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;
$function$;

CREATE FUNCTION app.create_agent_draft_with_strategy_capabilities_v10(
 p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,
 p_child_agent_ids uuid[],p_flow_id uuid,p_skill_pack_id uuid,p_skill_pack_release_version bigint,
 p_mcp_server_id uuid,p_mcp_server_release_version bigint,p_database_operation_id uuid,p_database_operation_revision bigint)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF p_child_agent_ids IS NULL OR NOT cardinality(p_child_agent_ids) BETWEEN 0 AND 3
  OR EXISTS(SELECT 1 FROM unnest(p_child_agent_ids) AS child(id) WHERE child.id IS NULL)
  OR (SELECT count(*)<>count(DISTINCT child.id) FROM unnest(p_child_agent_ids) AS child(id))
  OR (p_strategy_profile->>'forced_capability'='subagent' AND cardinality(p_child_agent_ids)=0)
  OR EXISTS(SELECT 1 FROM unnest(p_child_agent_ids) AS child(id) WHERE NOT EXISTS(
    SELECT 1 FROM public.agent_product_releases AS release
    WHERE release.workspace_id=p_workspace_id AND release.agent_id=child.id))
 THEN RAISE EXCEPTION 'Agent parallel child binding is invalid or unpublished' USING ERRCODE='22023'; END IF;
 v:=app.create_agent_draft_with_strategy_capabilities_v9(p_workspace_id,p_actor_id,p_name,p_description,p_instructions,p_model,
  p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_ids[1],p_flow_id,
  p_skill_pack_id,p_skill_pack_release_version,p_mcp_server_id,p_mcp_server_release_version,
  p_database_operation_id,p_database_operation_revision);
 INSERT INTO public.agent_product_parallel_subagent_bindings(workspace_id,agent_id,position,target_agent_id)
 SELECT p_workspace_id,v.id,child.ordinality::smallint,child.id
 FROM unnest(p_child_agent_ids) WITH ORDINALITY AS child(id,ordinality) WHERE child.ordinality>1;
 RETURN v;
END;
$function$;

CREATE FUNCTION app.update_agent_draft_with_strategy_capabilities_v10(
 p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,
 p_child_agent_ids uuid[],p_flow_id uuid,p_skill_pack_id uuid,p_skill_pack_release_version bigint,
 p_mcp_server_id uuid,p_mcp_server_release_version bigint,p_database_operation_id uuid,p_database_operation_revision bigint)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF p_child_agent_ids IS NULL OR NOT cardinality(p_child_agent_ids) BETWEEN 0 AND 3
  OR EXISTS(SELECT 1 FROM unnest(p_child_agent_ids) AS child(id) WHERE child.id IS NULL OR child.id=p_agent_id)
  OR (SELECT count(*)<>count(DISTINCT child.id) FROM unnest(p_child_agent_ids) AS child(id))
  OR (p_strategy_profile->>'forced_capability'='subagent' AND cardinality(p_child_agent_ids)=0)
  OR EXISTS(SELECT 1 FROM unnest(p_child_agent_ids) AS child(id) WHERE NOT EXISTS(
    SELECT 1 FROM public.agent_product_releases AS release
    WHERE release.workspace_id=p_workspace_id AND release.agent_id=child.id))
 THEN RAISE EXCEPTION 'Agent parallel child binding is invalid or unpublished' USING ERRCODE='22023'; END IF;
 v:=app.update_agent_draft_with_strategy_capabilities_v9(p_workspace_id,p_agent_id,p_expected_revision,p_name,p_description,p_instructions,p_model,
  p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_ids[1],p_flow_id,
  p_skill_pack_id,p_skill_pack_release_version,p_mcp_server_id,p_mcp_server_release_version,
  p_database_operation_id,p_database_operation_revision);
 DELETE FROM public.agent_product_parallel_subagent_bindings
 WHERE workspace_id=p_workspace_id AND agent_id=p_agent_id;
 INSERT INTO public.agent_product_parallel_subagent_bindings(workspace_id,agent_id,position,target_agent_id)
 SELECT p_workspace_id,p_agent_id,child.ordinality::smallint,child.id
 FROM unnest(p_child_agent_ids) WITH ORDINALITY AS child(id,ordinality) WHERE child.ordinality>1;
 RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_subagent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_binding record;
  v_version bigint;
  v_current_agent uuid;
  v_current_release bigint;
  v_next_agent uuid;
  v_next_release bigint;
  v_current_strategy jsonb;
  v_seen uuid[];
  v_depth integer;
BEGIN
 FOR v_binding IN
  SELECT 1::smallint AS position,binding.target_agent_id
  FROM public.agent_product_subagent_bindings AS binding
  WHERE binding.workspace_id=NEW.workspace_id AND binding.agent_id=NEW.agent_id
  UNION ALL
  SELECT binding.position,binding.target_agent_id
  FROM public.agent_product_parallel_subagent_bindings AS binding
  WHERE binding.workspace_id=NEW.workspace_id AND binding.agent_id=NEW.agent_id
  ORDER BY position
 LOOP
  SELECT max(version) INTO v_version FROM public.agent_product_releases
  WHERE workspace_id=NEW.workspace_id AND agent_id=v_binding.target_agent_id;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'bound child Agent has no published release' USING ERRCODE='22023';
  END IF;
  IF v_binding.position=1 THEN
    INSERT INTO public.agent_product_release_subagent_bindings(
      workspace_id,agent_id,release_version,target_agent_id,target_release_version
    ) VALUES(NEW.workspace_id,NEW.agent_id,NEW.version,v_binding.target_agent_id,v_version);
  ELSE
    INSERT INTO public.agent_product_release_parallel_subagent_bindings(
      workspace_id,agent_id,release_version,position,target_agent_id,target_release_version
    ) VALUES(NEW.workspace_id,NEW.agent_id,NEW.version,v_binding.position,v_binding.target_agent_id,v_version);
  END IF;

  v_current_agent:=v_binding.target_agent_id;
  v_current_release:=v_version;
  v_seen:=ARRAY[NEW.agent_id];
  v_depth:=1;
  LOOP
    IF v_current_agent=ANY(v_seen) THEN
      RAISE EXCEPTION 'parallel SubAgent release chain contains a cycle' USING ERRCODE='22023';
    END IF;
    v_seen:=array_append(v_seen,v_current_agent);
    IF EXISTS(SELECT 1 FROM public.agent_product_release_parallel_subagent_bindings AS nested
      WHERE nested.workspace_id=NEW.workspace_id AND nested.agent_id=v_current_agent
        AND nested.release_version=v_current_release) THEN
      RAISE EXCEPTION 'nested parallel SubAgent fan-out is not supported' USING ERRCODE='22023';
    END IF;
    SELECT release.strategy_profile INTO v_current_strategy
    FROM public.agent_product_releases AS release
    WHERE release.workspace_id=NEW.workspace_id AND release.agent_id=v_current_agent
      AND release.version=v_current_release;
    IF NOT FOUND OR v_current_strategy->>'schema_version'<>'product-agent-strategy/5' THEN EXIT; END IF;
    SELECT binding.target_agent_id,binding.target_release_version INTO v_next_agent,v_next_release
    FROM public.agent_product_release_subagent_bindings AS binding
    WHERE binding.workspace_id=NEW.workspace_id AND binding.agent_id=v_current_agent
      AND binding.release_version=v_current_release;
    IF NOT FOUND THEN EXIT; END IF;
    IF v_depth>=3 THEN
      RAISE EXCEPTION 'parallel SubAgent release chain exceeds depth 3' USING ERRCODE='22023';
    END IF;
    v_current_agent:=v_next_agent;
    v_current_release:=v_next_release;
    v_depth:=v_depth+1;
  END LOOP;
 END LOOP;
 RETURN NEW;
END;
$function$;

CREATE FUNCTION app.read_agent_product_run_subagent_chains(
 p_workspace_id uuid,p_run_id uuid,p_actor_id uuid
) RETURNS TABLE(branch smallint,depth smallint,agent_id uuid,release_version bigint,name text,
 instructions text,model text,strategy_profile jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 WITH RECURSIVE root AS (
  SELECT conversation.agent_id,conversation.release_version
  FROM public.agent_product_runs AS run
  JOIN public.agent_product_conversations AS conversation
    ON conversation.workspace_id=run.workspace_id AND conversation.id=run.conversation_id
  JOIN public.agent_product_releases AS release
    ON release.workspace_id=conversation.workspace_id AND release.agent_id=conversation.agent_id
   AND release.version=conversation.release_version
  WHERE run.workspace_id=p_workspace_id AND run.id=p_run_id AND run.status='pending'
   AND conversation.actor_id=p_actor_id AND release.strategy_profile->>'schema_version'='product-agent-strategy/5'
 ), roots AS (
  SELECT 1::smallint AS branch,binding.target_agent_id AS agent_id,binding.target_release_version AS release_version
  FROM root JOIN public.agent_product_release_subagent_bindings AS binding
    ON binding.workspace_id=p_workspace_id AND binding.agent_id=root.agent_id
   AND binding.release_version=root.release_version
  UNION ALL
  SELECT binding.position,binding.target_agent_id,binding.target_release_version
  FROM root JOIN public.agent_product_release_parallel_subagent_bindings AS binding
    ON binding.workspace_id=p_workspace_id AND binding.agent_id=root.agent_id
   AND binding.release_version=root.release_version
 ), chain AS (
  SELECT roots.branch,1 AS depth,roots.agent_id,roots.release_version FROM roots
  UNION ALL
  SELECT chain.branch,chain.depth+1,binding.target_agent_id,binding.target_release_version
  FROM chain
  JOIN public.agent_product_releases AS current_release
    ON current_release.workspace_id=p_workspace_id AND current_release.agent_id=chain.agent_id
   AND current_release.version=chain.release_version
  JOIN public.agent_product_release_subagent_bindings AS binding
    ON binding.workspace_id=p_workspace_id AND binding.agent_id=chain.agent_id
   AND binding.release_version=chain.release_version
  WHERE chain.depth<3 AND current_release.strategy_profile->>'schema_version'='product-agent-strategy/5'
 )
 SELECT chain.branch,chain.depth::smallint,release.agent_id,release.version,release.name,
  release.instructions,release.model,release.strategy_profile
 FROM chain JOIN public.agent_product_releases AS release
  ON release.workspace_id=p_workspace_id AND release.agent_id=chain.agent_id AND release.version=chain.release_version
 ORDER BY chain.branch,chain.depth;
$function$;

CREATE FUNCTION app.record_agent_product_run_subagent_invocation_v2(
 p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_parent_iteration bigint,p_branch smallint,p_depth smallint,
 p_agent_id uuid,p_release_version bigint,p_name text,p_model text,p_input_text text,p_output_text text,
 p_provider_request_id text,p_exclusive_input_tokens bigint,p_exclusive_output_tokens bigint,
 p_aggregate_input_tokens bigint,p_aggregate_output_tokens bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_run public.agent_product_runs;v_node record;
BEGIN
 SELECT run.* INTO v_run FROM public.agent_product_runs AS run
 JOIN public.agent_product_conversations AS conversation
  ON conversation.workspace_id=run.workspace_id AND conversation.id=run.conversation_id
 WHERE run.workspace_id=p_workspace_id AND run.id=p_run_id AND run.status='pending'
  AND conversation.actor_id=p_actor_id FOR UPDATE OF run;
 IF NOT FOUND OR p_parent_iteration<>jsonb_array_length(v_run.iteration_trace)+1 THEN
  RAISE EXCEPTION 'parallel SubAgent invocation Run or iteration conflict' USING ERRCODE='40001'; END IF;
 SELECT chain.* INTO v_node FROM app.read_agent_product_run_subagent_chains(
  p_workspace_id,p_run_id,p_actor_id) AS chain WHERE chain.branch=p_branch AND chain.depth=p_depth;
 IF NOT FOUND OR v_node.agent_id<>p_agent_id OR v_node.release_version<>p_release_version
  OR v_node.name IS DISTINCT FROM p_name OR v_node.model IS DISTINCT FROM p_model
  OR p_input_text IS NULL OR length(btrim(p_input_text)) NOT BETWEEN 1 AND 500
  OR p_output_text IS NULL OR length(btrim(p_output_text)) NOT BETWEEN 1 AND 50000
  OR p_provider_request_id IS NULL OR length(p_provider_request_id) NOT BETWEEN 1 AND 200
  OR p_exclusive_input_tokens NOT BETWEEN 0 AND 1000000000
  OR p_exclusive_output_tokens NOT BETWEEN 0 AND 1000000000
  OR p_aggregate_input_tokens NOT BETWEEN p_exclusive_input_tokens AND 1000000000
  OR p_aggregate_output_tokens NOT BETWEEN p_exclusive_output_tokens AND 1000000000
 THEN RAISE EXCEPTION 'parallel SubAgent invocation evidence is invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO public.agent_product_run_subagent_invocations(
  workspace_id,run_id,parent_iteration,branch,depth,agent_id,release_version,name,model,input_text,output_text,
  provider_request_id,exclusive_input_tokens,exclusive_output_tokens,aggregate_input_tokens,aggregate_output_tokens
 ) VALUES(p_workspace_id,p_run_id,p_parent_iteration,p_branch,p_depth,p_agent_id,p_release_version,btrim(p_name),
  p_model,btrim(p_input_text),btrim(p_output_text),p_provider_request_id,p_exclusive_input_tokens,
  p_exclusive_output_tokens,p_aggregate_input_tokens,p_aggregate_output_tokens);
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_agent_product_subagent_decision_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_item jsonb;v_expected bigint;v_actual bigint;v_input bigint;v_output bigint;
BEGIN
 IF jsonb_array_length(NEW.iteration_trace)=jsonb_array_length(OLD.iteration_trace)+1 THEN
  v_item:=NEW.iteration_trace->(jsonb_array_length(NEW.iteration_trace)-1);
  IF v_item->>'action'='tool' AND v_item->>'capability'='subagent' THEN
   SELECT count(*) INTO v_expected FROM (
    SELECT 1 FROM public.agent_product_conversations AS conversation
    JOIN public.agent_product_release_subagent_bindings AS binding
     ON binding.workspace_id=conversation.workspace_id AND binding.agent_id=conversation.agent_id
      AND binding.release_version=conversation.release_version
    WHERE conversation.workspace_id=NEW.workspace_id AND conversation.id=NEW.conversation_id
    UNION ALL
    SELECT 1 FROM public.agent_product_conversations AS conversation
    JOIN public.agent_product_release_parallel_subagent_bindings AS binding
     ON binding.workspace_id=conversation.workspace_id AND binding.agent_id=conversation.agent_id
      AND binding.release_version=conversation.release_version
    WHERE conversation.workspace_id=NEW.workspace_id AND conversation.id=NEW.conversation_id
   ) AS expected;
   SELECT count(*),coalesce(sum(invocation.aggregate_input_tokens),0),
    coalesce(sum(invocation.aggregate_output_tokens),0) INTO v_actual,v_input,v_output
   FROM public.agent_product_run_subagent_invocations AS invocation
   WHERE invocation.workspace_id=NEW.workspace_id AND invocation.run_id=NEW.id
    AND invocation.parent_iteration=(v_item->>'iteration')::bigint AND invocation.depth=1;
   IF v_expected NOT BETWEEN 1 AND 3 OR v_actual<>v_expected
    OR v_input<>(v_item->>'tool_input_tokens')::bigint
    OR v_output<>(v_item->>'tool_output_tokens')::bigint
    OR NOT EXISTS(SELECT 1 FROM public.agent_product_run_subagent_invocations AS invocation
      WHERE invocation.workspace_id=NEW.workspace_id AND invocation.run_id=NEW.id
       AND invocation.parent_iteration=(v_item->>'iteration')::bigint AND invocation.branch=1 AND invocation.depth=1
       AND invocation.agent_id=(v_item->>'target_agent_id')::uuid
       AND invocation.release_version=(v_item->>'target_release_version')::bigint
       AND invocation.provider_request_id=v_item->>'tool_provider_request_id')
   THEN RAISE EXCEPTION 'SubAgent decision is missing its complete immutable parallel receipts'
    USING ERRCODE='40001'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;

DROP FUNCTION app.list_agent_product_run_subagent_invocations(uuid);
CREATE FUNCTION app.list_agent_product_run_subagent_invocations(p_workspace_id uuid)
RETURNS TABLE(run_id uuid,parent_iteration bigint,branch smallint,depth smallint,agent_id uuid,
 release_version bigint,name text,model text,input_text text,output_text text,provider_request_id text,
 exclusive_input_tokens bigint,exclusive_output_tokens bigint,aggregate_input_tokens bigint,
 aggregate_output_tokens bigint,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT invocation.run_id,invocation.parent_iteration,invocation.branch,invocation.depth,invocation.agent_id,
  invocation.release_version,invocation.name,invocation.model,invocation.input_text,invocation.output_text,
  invocation.provider_request_id,invocation.exclusive_input_tokens,invocation.exclusive_output_tokens,
  invocation.aggregate_input_tokens,invocation.aggregate_output_tokens,invocation.created_at
 FROM public.agent_product_run_subagent_invocations AS invocation
 WHERE invocation.workspace_id=p_workspace_id
 ORDER BY invocation.created_at DESC,invocation.run_id,invocation.parent_iteration,invocation.branch,invocation.depth
 LIMIT 600;
$function$;

ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_strategy_capabilities_v10(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_strategy_capabilities_v10(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.snapshot_agent_product_release_subagent() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_run_subagent_chains(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_agent_product_run_subagent_invocation_v2(uuid,uuid,uuid,bigint,smallint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_agent_product_subagent_decision_receipt() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_product_run_subagent_invocations(uuid) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v10(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.update_agent_draft_with_strategy_capabilities_v10(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.read_agent_product_run_subagent_chains(uuid,uuid,uuid),
 app.record_agent_product_run_subagent_invocation_v2(uuid,uuid,uuid,bigint,smallint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint),
 app.list_agent_product_run_subagent_invocations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v10(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.update_agent_draft_with_strategy_capabilities_v10(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid[],uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.read_agent_product_run_subagent_chains(uuid,uuid,uuid),
 app.record_agent_product_run_subagent_invocation_v2(uuid,uuid,uuid,bigint,smallint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint),
 app.list_agent_product_run_subagent_invocations(uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
