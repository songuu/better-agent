-- Strategy v5 adds a single bounded SubAgent call. Draft bindings are mutable;
-- publication pins the exact child release and Run evidence seals child usage.
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_subagent_bindings (
  workspace_id uuid NOT NULL, agent_id uuid NOT NULL, target_agent_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,agent_id),
  FOREIGN KEY (workspace_id,agent_id) REFERENCES public.agent_drafts(workspace_id,id),
  FOREIGN KEY (workspace_id,target_agent_id) REFERENCES public.agent_drafts(workspace_id,id),
  CHECK (agent_id <> target_agent_id)
);
CREATE TABLE public.agent_product_release_subagent_bindings (
  workspace_id uuid NOT NULL,agent_id uuid NOT NULL,release_version bigint NOT NULL,
  target_agent_id uuid NOT NULL,target_release_version bigint NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,agent_id,release_version),
  FOREIGN KEY (workspace_id,agent_id,release_version)
    REFERENCES public.agent_product_releases(workspace_id,agent_id,version),
  FOREIGN KEY (workspace_id,target_agent_id,target_release_version)
    REFERENCES public.agent_product_releases(workspace_id,agent_id,version),
  CHECK (agent_id <> target_agent_id)
);
ALTER TABLE public.agent_product_subagent_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_subagent_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_subagent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_subagent_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_subagent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_subagent_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_product_subagent_bindings_owner_only ON public.agent_product_subagent_bindings
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY agent_product_release_subagent_bindings_owner_only ON public.agent_product_release_subagent_bindings
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
REVOKE ALL ON public.agent_product_subagent_bindings,public.agent_product_release_subagent_bindings FROM PUBLIC,ba_runtime;
CREATE TRIGGER agent_product_release_subagent_bindings_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_subagent_bindings
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE OR REPLACE FUNCTION app.is_valid_product_agent_strategy_profile(p_profile jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $function$
  SELECT jsonb_typeof(p_profile)='object'
    AND CASE WHEN p_profile->>'schema_version'='product-agent-strategy/1' THEN
      (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile) keys(key))=
      ARRAY['forced_capability','max_input_tokens','max_iterations','max_output_tokens','max_tool_calls','parameter_extraction','routes','routing_mode','schema_version','temperature']::text[]
    WHEN p_profile->>'schema_version' IN ('product-agent-strategy/2','product-agent-strategy/3','product-agent-strategy/4','product-agent-strategy/5') THEN
      (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile) keys(key))=
      ARRAY['forced_capability','max_input_tokens','max_iterations','max_output_tokens','max_tool_calls','parameter_defaults','parameter_extraction','routes','routing_mode','schema_version','temperature']::text[]
      AND jsonb_typeof(p_profile->'parameter_defaults')='object'
      AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile->'parameter_defaults') keys(key))=ARRAY['database_contains','knowledge_query']::text[]
      AND jsonb_typeof(p_profile->'parameter_defaults'->'database_contains')='string'
      AND length(btrim(p_profile->'parameter_defaults'->>'database_contains')) BETWEEN 0 AND 500
      AND jsonb_typeof(p_profile->'parameter_defaults'->'knowledge_query')='string'
      AND length(btrim(p_profile->'parameter_defaults'->>'knowledge_query')) BETWEEN 0 AND 500
    ELSE false END
    AND p_profile->>'routing_mode' IN ('fixed','autonomous')
    AND p_profile->>'forced_capability' IN ('none','knowledge','database','subagent')
    AND (p_profile->>'schema_version'='product-agent-strategy/5' OR p_profile->>'forced_capability'<>'subagent')
    AND jsonb_typeof(p_profile->'parameter_extraction')='boolean'
    AND CASE WHEN p_profile->>'schema_version' IN ('product-agent-strategy/3','product-agent-strategy/4','product-agent-strategy/5')
      THEN (p_profile->>'max_iterations')~'^[1-4]$' ELSE p_profile->>'max_iterations'='1' END
    AND (p_profile->>'max_tool_calls')~'^[0-2]$'
    AND (p_profile->>'forced_capability'='none' OR (p_profile->>'max_tool_calls')::int>=1)
    AND (p_profile->>'max_input_tokens')~'^[0-9]+$' AND (p_profile->>'max_input_tokens')::bigint BETWEEN 256 AND 128000
    AND (p_profile->>'max_output_tokens')~'^[0-9]+$' AND (p_profile->>'max_output_tokens')::bigint BETWEEN 64 AND 32000
    AND jsonb_typeof(p_profile->'temperature')='number' AND (p_profile->>'temperature')::numeric BETWEEN 0 AND 2
    AND jsonb_typeof(p_profile->'routes')='array' AND jsonb_array_length(p_profile->'routes') BETWEEN 1 AND 3
    AND (p_profile->>'routing_mode'='fixed' OR jsonb_array_length(p_profile->'routes')>=2)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_profile->'routes') route WHERE jsonb_typeof(route)<>'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(route) keys(key))<>ARRAY['description','model']::text[]
      OR route->>'model' NOT IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol') OR length(btrim(route->>'description')) NOT BETWEEN 1 AND 200)
    AND (SELECT count(DISTINCT route->>'model')=jsonb_array_length(p_profile->'routes') FROM jsonb_array_elements(p_profile->'routes') route);
$function$;

CREATE FUNCTION app.snapshot_agent_product_release_subagent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_target uuid;v_version bigint;
BEGIN
  SELECT target_agent_id INTO v_target FROM public.agent_product_subagent_bindings
    WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
  IF v_target IS NULL THEN RETURN NEW; END IF;
  SELECT max(version) INTO v_version FROM public.agent_product_releases
    WHERE workspace_id=NEW.workspace_id AND agent_id=v_target;
  IF v_version IS NULL THEN RAISE EXCEPTION 'bound child Agent has no published release' USING ERRCODE='22023'; END IF;
  INSERT INTO public.agent_product_release_subagent_bindings(workspace_id,agent_id,release_version,target_agent_id,target_release_version)
    VALUES(NEW.workspace_id,NEW.agent_id,NEW.version,v_target,v_version);
  RETURN NEW;
END;$function$;
CREATE TRIGGER agent_product_release_subagent_snapshot AFTER INSERT ON public.agent_product_releases
FOR EACH ROW EXECUTE FUNCTION app.snapshot_agent_product_release_subagent();

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
database_table_id uuid,role_mode text,role_profile jsonb,strategy_profile jsonb,strategy_version bigint,child_agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
 k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version,s.target_agent_id
 FROM public.agent_drafts d LEFT JOIN public.agent_product_knowledge_bindings k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 LEFT JOIN public.agent_product_subagent_bindings s ON s.workspace_id=d.workspace_id AND s.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;$function$;

CREATE FUNCTION app.create_agent_draft_with_strategy_capabilities_v5(
 p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,p_child_agent_id uuid)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF (p_strategy_profile->>'forced_capability'='subagent' AND p_child_agent_id IS NULL)
   OR (p_child_agent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.agent_product_releases WHERE workspace_id=p_workspace_id AND agent_id=p_child_agent_id))
 THEN RAISE EXCEPTION 'Agent child binding is invalid or unpublished' USING ERRCODE='22023'; END IF;
 v:=app.create_agent_draft_with_strategy_capabilities(p_workspace_id,p_actor_id,p_name,p_description,p_instructions,p_model,
   p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile);
 IF p_child_agent_id IS NOT NULL THEN INSERT INTO public.agent_product_subagent_bindings VALUES(p_workspace_id,v.id,p_child_agent_id,clock_timestamp()); END IF;
 RETURN v;
END;$function$;
CREATE FUNCTION app.update_agent_draft_with_strategy_capabilities_v5(
 p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,p_child_agent_id uuid)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts;
BEGIN
 IF p_child_agent_id=p_agent_id OR (p_strategy_profile->>'forced_capability'='subagent' AND p_child_agent_id IS NULL)
   OR (p_child_agent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.agent_product_releases WHERE workspace_id=p_workspace_id AND agent_id=p_child_agent_id))
 THEN RAISE EXCEPTION 'Agent child binding is invalid or unpublished' USING ERRCODE='22023'; END IF;
 v:=app.update_agent_draft_with_strategy_capabilities(p_workspace_id,p_agent_id,p_expected_revision,p_name,p_description,p_instructions,p_model,
   p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile,p_strategy_profile);
 DELETE FROM public.agent_product_subagent_bindings WHERE workspace_id=p_workspace_id AND agent_id=p_agent_id;
 IF p_child_agent_id IS NOT NULL THEN INSERT INTO public.agent_product_subagent_bindings VALUES(p_workspace_id,p_agent_id,p_child_agent_id,clock_timestamp()); END IF;
 RETURN v;
END;$function$;

DROP FUNCTION app.read_agent_product_run_capabilities(uuid,uuid,uuid);
CREATE FUNCTION app.read_agent_product_run_capabilities(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid)
RETURNS TABLE(knowledge boolean,database boolean,subagent boolean)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT EXISTS(SELECT 1 FROM public.agent_product_release_knowledge_bindings b WHERE b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version),
 EXISTS(SELECT 1 FROM public.agent_product_release_database_bindings b WHERE b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version),
 EXISTS(SELECT 1 FROM public.agent_product_release_subagent_bindings b WHERE b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version)
 FROM public.agent_product_runs r JOIN public.agent_product_conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 JOIN public.agent_product_releases x ON x.workspace_id=c.workspace_id AND x.agent_id=c.agent_id AND x.version=c.release_version
 WHERE r.workspace_id=p_workspace_id AND r.id=p_run_id AND r.status='pending' AND r.effective_parameters IS NOT NULL
 AND c.actor_id=p_actor_id AND x.strategy_profile->>'schema_version' IN ('product-agent-strategy/4','product-agent-strategy/5');$function$;

CREATE FUNCTION app.read_agent_product_run_subagent(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid)
RETURNS TABLE(agent_id uuid,release_version bigint,name text,instructions text,model text,max_output_tokens bigint,temperature numeric)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT child.agent_id,child.version,child.name,child.instructions,child.model,
   (child.strategy_profile->>'max_output_tokens')::bigint,(child.strategy_profile->>'temperature')::numeric
 FROM public.agent_product_runs r JOIN public.agent_product_conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 JOIN public.agent_product_release_subagent_bindings b ON b.workspace_id=c.workspace_id AND b.agent_id=c.agent_id AND b.release_version=c.release_version
 JOIN public.agent_product_releases child ON child.workspace_id=b.workspace_id AND child.agent_id=b.target_agent_id AND child.version=b.target_release_version
 JOIN public.agent_product_releases parent ON parent.workspace_id=c.workspace_id AND parent.agent_id=c.agent_id AND parent.version=c.release_version
 WHERE r.workspace_id=p_workspace_id AND r.id=p_run_id AND r.status='pending' AND c.actor_id=p_actor_id
 AND parent.strategy_profile->>'schema_version'='product-agent-strategy/5';$function$;

CREATE OR REPLACE FUNCTION app.is_valid_product_agent_iteration_trace(p_trace jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $function$
 SELECT jsonb_typeof(p_trace)='array' AND jsonb_array_length(p_trace) BETWEEN 0 AND 4
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_trace) WITH ORDINALITY i(value,ordinal)
 WHERE jsonb_typeof(i.value)<>'object'
 OR jsonb_typeof(i.value->'iteration')<>'number' OR i.value->>'iteration'!~'^[1-4]$' OR (i.value->>'iteration')::bigint<>i.ordinal
 OR jsonb_typeof(i.value->'model')<>'string' OR i.value->>'model' NOT IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')
 OR jsonb_typeof(i.value->'provider_request_id')<>'string' OR length(i.value->>'provider_request_id') NOT BETWEEN 1 AND 200
 OR jsonb_typeof(i.value->'input_tokens')<>'number' OR i.value->>'input_tokens'!~'^[0-9]+$' OR (i.value->>'input_tokens')::bigint>1000000000
 OR jsonb_typeof(i.value->'output_tokens')<>'number' OR i.value->>'output_tokens'!~'^[0-9]+$' OR (i.value->>'output_tokens')::bigint>1000000000
 OR NOT (
  ((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(i.value) keys(key))=
    ARRAY['input_tokens','iteration','model','output_text','output_tokens','provider_request_id']::text[]
    AND jsonb_typeof(i.value->'output_text')='string' AND length(btrim(i.value->>'output_text')) BETWEEN 1 AND 50000)
  OR ((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(i.value) keys(key))=
    ARRAY['action','capability','input_tokens','iteration','model','output_text','output_tokens','provider_request_id','tool_input','tool_output']::text[]
    AND i.value->>'action' IN ('tool','final') AND (
      (i.value->>'action'='final' AND jsonb_typeof(i.value->'output_text')='string'
       AND length(btrim(i.value->>'output_text')) BETWEEN 1 AND 50000 AND jsonb_typeof(i.value->'capability')='null'
       AND jsonb_typeof(i.value->'tool_input')='null' AND jsonb_typeof(i.value->'tool_output')='null')
      OR (i.value->>'action'='tool' AND i.value->>'capability' IN ('knowledge','database')
       AND jsonb_typeof(i.value->'output_text')='null' AND jsonb_typeof(i.value->'tool_input')='string'
       AND length(btrim(i.value->>'tool_input')) BETWEEN 1 AND 500 AND jsonb_typeof(i.value->'tool_output')='string'
       AND length(i.value->>'tool_output') BETWEEN 1 AND 50000)))
  OR ((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(i.value) keys(key))=
    ARRAY['action','capability','input_tokens','iteration','model','output_text','output_tokens','provider_request_id','target_agent_id','target_release_version','tool_input','tool_input_tokens','tool_output','tool_output_tokens','tool_provider_request_id']::text[]
    AND i.value->>'action' IN ('tool','final')
    AND jsonb_typeof(i.value->'tool_input_tokens')='number' AND i.value->>'tool_input_tokens'~'^[0-9]+$'
    AND (i.value->>'tool_input_tokens')::bigint<=1000000000
    AND jsonb_typeof(i.value->'tool_output_tokens')='number' AND i.value->>'tool_output_tokens'~'^[0-9]+$'
    AND (i.value->>'tool_output_tokens')::bigint<=1000000000 AND (
      (i.value->>'action'='final' AND jsonb_typeof(i.value->'output_text')='string'
       AND length(btrim(i.value->>'output_text')) BETWEEN 1 AND 50000 AND jsonb_typeof(i.value->'capability')='null'
       AND jsonb_typeof(i.value->'tool_input')='null' AND jsonb_typeof(i.value->'tool_output')='null'
       AND (i.value->>'tool_input_tokens')::bigint=0 AND (i.value->>'tool_output_tokens')::bigint=0
       AND jsonb_typeof(i.value->'tool_provider_request_id')='null' AND jsonb_typeof(i.value->'target_agent_id')='null'
       AND jsonb_typeof(i.value->'target_release_version')='null')
      OR (i.value->>'action'='tool' AND i.value->>'capability' IN ('knowledge','database','subagent')
       AND jsonb_typeof(i.value->'output_text')='null' AND jsonb_typeof(i.value->'tool_input')='string'
       AND length(btrim(i.value->>'tool_input')) BETWEEN 1 AND 500 AND jsonb_typeof(i.value->'tool_output')='string'
       AND length(i.value->>'tool_output') BETWEEN 1 AND 50000 AND (
        (i.value->>'capability'='subagent' AND jsonb_typeof(i.value->'target_agent_id')='string'
         AND (i.value->>'target_agent_id')~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND jsonb_typeof(i.value->'target_release_version')='number' AND i.value->>'target_release_version'~'^[1-9][0-9]*$'
         AND jsonb_typeof(i.value->'tool_provider_request_id')='string'
         AND length(i.value->>'tool_provider_request_id') BETWEEN 1 AND 200)
        OR (i.value->>'capability' IN ('knowledge','database') AND jsonb_typeof(i.value->'target_agent_id')='null'
         AND jsonb_typeof(i.value->'target_release_version')='null' AND (i.value->>'tool_input_tokens')::bigint=0
         AND (i.value->>'tool_output_tokens')::bigint=0 AND jsonb_typeof(i.value->'tool_provider_request_id')='null')))))
 ));$function$;

CREATE FUNCTION app.record_agent_product_run_decision_v5(
 p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_iteration bigint,p_model text,p_action text,p_capability text,
 p_tool_input text,p_tool_output text,p_output_text text,p_provider_request_id text,p_input_tokens bigint,p_output_tokens bigint,
 p_tool_input_tokens bigint,p_tool_output_tokens bigint,p_tool_provider_request_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_run public.agent_product_runs;v_strategy jsonb;v_agent uuid;v_release bigint;v_binding public.agent_product_release_subagent_bindings;v_tools bigint;v_in bigint;v_out bigint;
BEGIN
 SELECT r.* INTO v_run FROM public.agent_product_runs r JOIN public.agent_product_conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 JOIN public.agent_product_releases x ON x.workspace_id=c.workspace_id AND x.agent_id=c.agent_id AND x.version=c.release_version
 WHERE r.workspace_id=p_workspace_id AND r.id=p_run_id AND r.status='pending' AND r.effective_parameters IS NOT NULL AND c.actor_id=p_actor_id
 AND x.strategy_profile->>'schema_version'='product-agent-strategy/5' FOR UPDATE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'model SubAgent decision, binding, order or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 SELECT x.strategy_profile,c.agent_id,c.release_version INTO v_strategy,v_agent,v_release FROM public.agent_product_conversations c
 JOIN public.agent_product_releases x ON x.workspace_id=c.workspace_id AND x.agent_id=c.agent_id AND x.version=c.release_version
 WHERE c.workspace_id=p_workspace_id AND c.id=v_run.conversation_id;
 SELECT * INTO v_binding FROM public.agent_product_release_subagent_bindings WHERE workspace_id=p_workspace_id AND agent_id=v_agent AND release_version=v_release;
 IF p_action NOT IN ('tool','final') OR p_iteration<>jsonb_array_length(v_run.iteration_trace)+1 OR p_iteration>(v_strategy->>'max_iterations')::bigint
 OR p_model IS DISTINCT FROM v_run.model OR p_provider_request_id IS NULL OR length(p_provider_request_id) NOT BETWEEN 1 AND 200 OR p_input_tokens IS NULL OR p_input_tokens NOT BETWEEN 0 AND 1000000000 OR p_output_tokens IS NULL OR p_output_tokens NOT BETWEEN 0 AND 1000000000
 OR p_tool_input_tokens IS NULL OR p_tool_input_tokens NOT BETWEEN 0 AND 1000000000 OR p_tool_output_tokens IS NULL OR p_tool_output_tokens NOT BETWEEN 0 AND 1000000000
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_run.iteration_trace)i WHERE i->>'action'='final')
 OR (p_action='final' AND (p_output_text IS NULL OR length(btrim(p_output_text)) NOT BETWEEN 1 AND 50000 OR p_capability IS NOT NULL OR p_tool_input IS NOT NULL OR p_tool_output IS NOT NULL OR p_tool_input_tokens<>0 OR p_tool_output_tokens<>0 OR p_tool_provider_request_id IS NOT NULL))
 OR (p_action='tool' AND (p_capability IS NULL OR p_capability NOT IN ('knowledge','database','subagent') OR p_tool_input IS NULL OR length(btrim(p_tool_input)) NOT BETWEEN 1 AND 500 OR p_tool_output IS NULL OR length(p_tool_output) NOT BETWEEN 1 AND 50000 OR p_output_text IS NOT NULL))
 OR (p_action='tool' AND p_capability='subagent' AND (v_binding.agent_id IS NULL OR p_tool_provider_request_id IS NULL OR length(p_tool_provider_request_id) NOT BETWEEN 1 AND 200))
 OR (p_action='tool' AND p_capability<>'subagent' AND (p_tool_input_tokens<>0 OR p_tool_output_tokens<>0 OR p_tool_provider_request_id IS NOT NULL))
 THEN RAISE EXCEPTION 'model SubAgent decision, binding, order or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 IF p_action='tool' AND p_capability='knowledge' AND NOT EXISTS(SELECT 1 FROM public.agent_product_release_knowledge_bindings b
   WHERE b.workspace_id=p_workspace_id AND b.agent_id=v_agent AND b.release_version=v_release)
 THEN RAISE EXCEPTION 'model SubAgent decision, binding, order or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 IF p_action='tool' AND p_capability='database' AND NOT EXISTS(SELECT 1 FROM public.agent_product_release_database_bindings b
   WHERE b.workspace_id=p_workspace_id AND b.agent_id=v_agent AND b.release_version=v_release)
 THEN RAISE EXCEPTION 'model SubAgent decision, binding, order or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 SELECT count(*) INTO v_tools FROM jsonb_array_elements(v_run.iteration_trace) i WHERE i->>'action'='tool';
 IF v_tools+(p_action='tool')::int>(v_strategy->>'max_tool_calls')::bigint OR (p_action='final' AND v_strategy->>'forced_capability'<>'none'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_run.iteration_trace) i WHERE i->>'action'='tool' AND i->>'capability'=v_strategy->>'forced_capability'))
 THEN RAISE EXCEPTION 'model SubAgent decision, binding, order or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 SELECT COALESCE(sum((i->>'input_tokens')::bigint+COALESCE((i->>'tool_input_tokens')::bigint,0)),0),
 COALESCE(sum((i->>'output_tokens')::bigint+COALESCE((i->>'tool_output_tokens')::bigint,0)),0) INTO v_in,v_out FROM jsonb_array_elements(v_run.iteration_trace)i;
 IF v_in+p_input_tokens+p_tool_input_tokens+v_run.router_input_tokens+v_run.parameter_input_tokens>(v_strategy->>'max_input_tokens')::bigint
 OR v_out+p_output_tokens+p_tool_output_tokens+v_run.router_output_tokens+v_run.parameter_output_tokens>(v_strategy->>'max_output_tokens')::bigint
 THEN RAISE EXCEPTION 'model SubAgent decision, binding, order or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 UPDATE public.agent_product_runs SET iteration_count=p_iteration,iteration_trace=iteration_trace||jsonb_build_array(jsonb_build_object(
 'action',p_action,'capability',p_capability,'input_tokens',p_input_tokens,'iteration',p_iteration,'model',p_model,
 'output_text',CASE WHEN p_action='final' THEN btrim(p_output_text) END,'output_tokens',p_output_tokens,'provider_request_id',p_provider_request_id,
 'target_agent_id',CASE WHEN p_capability='subagent' THEN v_binding.target_agent_id END,'target_release_version',CASE WHEN p_capability='subagent' THEN v_binding.target_release_version END,
 'tool_input',CASE WHEN p_action='tool' THEN btrim(p_tool_input) END,'tool_input_tokens',p_tool_input_tokens,
 'tool_output',CASE WHEN p_action='tool' THEN p_tool_output END,'tool_output_tokens',p_tool_output_tokens,'tool_provider_request_id',p_tool_provider_request_id))
 WHERE workspace_id=p_workspace_id AND id=p_run_id;
END;$function$;

-- v5 completion includes child-model usage kept in the v5 decision trace.
CREATE OR REPLACE FUNCTION app.complete_agent_product_run(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_output_text text,p_provider_request_id text,p_input_tokens bigint,p_output_tokens bigint)
RETURNS public.agent_product_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_product_runs;s jsonb;last_item jsonb;vin bigint;vout bigint;tools bigint;
BEGIN
 SELECT r.* INTO v FROM public.agent_product_runs r JOIN public.agent_product_conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
 WHERE r.workspace_id=p_workspace_id AND r.id=p_run_id AND r.status='pending' AND c.actor_id=p_actor_id FOR UPDATE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 SELECT x.strategy_profile INTO s FROM public.agent_product_conversations c JOIN public.agent_product_releases x ON x.workspace_id=c.workspace_id AND x.agent_id=c.agent_id AND x.version=c.release_version WHERE c.workspace_id=p_workspace_id AND c.id=v.conversation_id;
 IF p_output_text IS NULL OR length(btrim(p_output_text)) NOT BETWEEN 1 AND 50000
 OR p_provider_request_id IS NULL OR length(p_provider_request_id) NOT BETWEEN 1 AND 200
 OR p_input_tokens IS NULL OR p_input_tokens NOT BETWEEN 0 AND 1000000000
 OR p_output_tokens IS NULL OR p_output_tokens NOT BETWEEN 0 AND 1000000000
 THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 IF s->>'schema_version' IN ('product-agent-strategy/4','product-agent-strategy/5') THEN
  IF v.iteration_count NOT BETWEEN 1 AND (s->>'max_iterations')::bigint THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
  last_item:=v.iteration_trace->(v.iteration_count::int-1);
  SELECT COALESCE(sum((i->>'input_tokens')::bigint+CASE WHEN s->>'schema_version'='product-agent-strategy/5' THEN COALESCE((i->>'tool_input_tokens')::bigint,0) ELSE 0 END),0),
   COALESCE(sum((i->>'output_tokens')::bigint+CASE WHEN s->>'schema_version'='product-agent-strategy/5' THEN COALESCE((i->>'tool_output_tokens')::bigint,0) ELSE 0 END),0),count(*) FILTER(WHERE i->>'action'='tool') INTO vin,vout,tools FROM jsonb_array_elements(v.iteration_trace)i;
  IF last_item->>'action'<>'final' OR btrim(p_output_text) IS DISTINCT FROM last_item->>'output_text' OR p_provider_request_id IS DISTINCT FROM last_item->>'provider_request_id'
   OR p_input_tokens IS DISTINCT FROM vin OR p_output_tokens IS DISTINCT FROM vout OR tools>(s->>'max_tool_calls')::bigint
   OR (s->>'forced_capability'<>'none' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.iteration_trace)i WHERE i->>'action'='tool' AND i->>'capability'=s->>'forced_capability'))
  THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 ELSIF s->>'schema_version'='product-agent-strategy/3' THEN
  IF v.iteration_count NOT BETWEEN 1 AND (s->>'max_iterations')::bigint THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
  last_item:=v.iteration_trace->(v.iteration_count::int-1);
  SELECT COALESCE(sum((i->>'input_tokens')::bigint),0),COALESCE(sum((i->>'output_tokens')::bigint),0) INTO vin,vout FROM jsonb_array_elements(v.iteration_trace)i;
  IF btrim(p_output_text) IS DISTINCT FROM last_item->>'output_text' OR p_provider_request_id IS DISTINCT FROM last_item->>'provider_request_id'
   OR p_input_tokens IS DISTINCT FROM vin OR p_output_tokens IS DISTINCT FROM vout
  THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 ELSE
  IF v.iteration_count<>0 THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
  vin:=p_input_tokens;vout:=p_output_tokens;
 END IF;
 IF vin+v.router_input_tokens+v.parameter_input_tokens>(s->>'max_input_tokens')::bigint OR vout+v.router_output_tokens+v.parameter_output_tokens>(s->>'max_output_tokens')::bigint
 THEN RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE='40001'; END IF;
 UPDATE public.agent_product_runs SET status='completed',output_text=btrim(p_output_text),provider_request_id=p_provider_request_id,input_tokens=vin,output_tokens=vout,completed_at=clock_timestamp()
 WHERE workspace_id=p_workspace_id AND id=p_run_id RETURNING * INTO v;RETURN v;
END;$function$;

ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_strategy_capabilities_v5(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_strategy_capabilities_v5(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_run_capabilities(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_run_subagent(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_agent_product_run_decision_v5(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,bigint,bigint,bigint,text) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),app.create_agent_draft_with_strategy_capabilities_v5(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid),app.update_agent_draft_with_strategy_capabilities_v5(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid),app.read_agent_product_run_capabilities(uuid,uuid,uuid),app.read_agent_product_run_subagent(uuid,uuid,uuid),app.record_agent_product_run_decision_v5(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,bigint,bigint,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid),app.create_agent_draft_with_strategy_capabilities_v5(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid),app.update_agent_draft_with_strategy_capabilities_v5(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid),app.read_agent_product_run_capabilities(uuid,uuid,uuid),app.read_agent_product_run_subagent(uuid,uuid,uuid),app.record_agent_product_run_decision_v5(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,bigint,bigint,bigint,bigint,text) TO ba_runtime;
RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
