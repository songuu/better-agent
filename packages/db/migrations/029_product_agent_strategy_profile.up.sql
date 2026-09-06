-- Product Agent strategy profile v1. Draft strategy is versioned, publication
-- snapshots it into the immutable release, and each Run records the pinned version.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE FUNCTION app.is_valid_product_agent_strategy_profile(p_profile jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_typeof(p_profile) = 'object'
    AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile) keys(key))
      = ARRAY['forced_capability','max_input_tokens','max_iterations','max_output_tokens',
              'max_tool_calls','parameter_extraction','routes','routing_mode','schema_version','temperature']::text[]
    AND p_profile ->> 'schema_version' = 'product-agent-strategy/1'
    AND p_profile ->> 'routing_mode' IN ('fixed','autonomous')
    AND p_profile ->> 'forced_capability' IN ('none','knowledge','database')
    AND jsonb_typeof(p_profile -> 'parameter_extraction') = 'boolean'
    AND (p_profile ->> 'max_iterations') = '1'
    AND (p_profile ->> 'max_tool_calls') ~ '^[0-2]$'
    AND (p_profile ->> 'forced_capability' = 'none' OR (p_profile ->> 'max_tool_calls')::int >= 1)
    AND (p_profile ->> 'max_input_tokens') ~ '^[0-9]+$'
    AND (p_profile ->> 'max_input_tokens')::bigint BETWEEN 256 AND 128000
    AND (p_profile ->> 'max_output_tokens') ~ '^[0-9]+$'
    AND (p_profile ->> 'max_output_tokens')::bigint BETWEEN 64 AND 32000
    AND jsonb_typeof(p_profile -> 'temperature') = 'number'
    AND (p_profile ->> 'temperature')::numeric BETWEEN 0 AND 2
    AND jsonb_typeof(p_profile -> 'routes') = 'array'
    AND jsonb_array_length(p_profile -> 'routes') BETWEEN 1 AND 3
    AND (p_profile ->> 'routing_mode' = 'fixed' OR jsonb_array_length(p_profile -> 'routes') >= 2)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_profile -> 'routes') route
      WHERE jsonb_typeof(route) <> 'object'
        OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(route) keys(key))
          <> ARRAY['description','model']::text[]
        OR route ->> 'model' NOT IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')
        OR length(btrim(route ->> 'description')) NOT BETWEEN 1 AND 200
    )
    AND (SELECT count(DISTINCT route ->> 'model') = jsonb_array_length(p_profile -> 'routes')
         FROM jsonb_array_elements(p_profile -> 'routes') route);
$function$;

ALTER TABLE public.agent_drafts
  ADD COLUMN strategy_profile jsonb,
  ADD COLUMN strategy_version bigint NOT NULL DEFAULT 1 CHECK (strategy_version > 0);
ALTER TABLE public.agent_product_releases
  ADD COLUMN strategy_profile jsonb,
  ADD COLUMN strategy_version bigint NOT NULL DEFAULT 1 CHECK (strategy_version > 0);

ALTER TABLE public.agent_drafts ALTER COLUMN strategy_profile SET DEFAULT
  '{"schema_version":"product-agent-strategy/1","routing_mode":"fixed","routes":[{"model":"gpt-5.6-sol","description":"default model"}],"parameter_extraction":false,"forced_capability":"none","max_iterations":1,"max_tool_calls":2,"max_input_tokens":32000,"max_output_tokens":2000,"temperature":0.2}'::jsonb;

ALTER TABLE public.agent_product_releases DISABLE TRIGGER agent_product_releases_immutable;
UPDATE public.agent_drafts SET strategy_profile = jsonb_build_object(
  'schema_version','product-agent-strategy/1','routing_mode','fixed',
  'routes',jsonb_build_array(jsonb_build_object('model',model,'description','default model')),
  'parameter_extraction',false,'forced_capability','none','max_iterations',1,
  'max_tool_calls',2,'max_input_tokens',32000,'max_output_tokens',2000,'temperature',0.2
);
UPDATE public.agent_product_releases SET strategy_profile = jsonb_build_object(
  'schema_version','product-agent-strategy/1','routing_mode','fixed',
  'routes',jsonb_build_array(jsonb_build_object('model',model,'description','default model')),
  'parameter_extraction',false,'forced_capability','none','max_iterations',1,
  'max_tool_calls',2,'max_input_tokens',32000,'max_output_tokens',2000,'temperature',0.2
);
ALTER TABLE public.agent_product_releases ENABLE TRIGGER agent_product_releases_immutable;
ALTER TABLE public.agent_drafts ALTER COLUMN strategy_profile SET NOT NULL,
  ADD CONSTRAINT agent_drafts_strategy_profile_check CHECK (app.is_valid_product_agent_strategy_profile(strategy_profile));
ALTER TABLE public.agent_product_releases ALTER COLUMN strategy_profile SET NOT NULL,
  ADD CONSTRAINT agent_product_releases_strategy_profile_check CHECK (app.is_valid_product_agent_strategy_profile(strategy_profile));

ALTER TABLE public.agent_product_runs
  ADD COLUMN strategy_version bigint NOT NULL DEFAULT 1 CHECK (strategy_version > 0),
  ADD COLUMN routing_mode text NOT NULL DEFAULT 'fixed' CHECK (routing_mode IN ('fixed','autonomous')),
  ADD COLUMN router_provider_request_id text CHECK (router_provider_request_id IS NULL OR length(router_provider_request_id) BETWEEN 1 AND 200),
  ADD COLUMN router_input_tokens bigint NOT NULL DEFAULT 0 CHECK (router_input_tokens >= 0),
  ADD COLUMN router_output_tokens bigint NOT NULL DEFAULT 0 CHECK (router_output_tokens >= 0);

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE (
  workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
  revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,
  knowledge_base_id uuid,database_table_id uuid,role_mode text,role_profile jsonb,
  strategy_profile jsonb,strategy_version bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT draft.workspace_id,draft.id,draft.name,draft.description,draft.instructions,draft.model,
    draft.status,draft.revision,draft.created_by,draft.created_at,draft.updated_at,
    knowledge.knowledge_base_id,database_binding.database_table_id,draft.role_mode,draft.role_profile,
    draft.strategy_profile,draft.strategy_version
  FROM public.agent_drafts draft
  LEFT JOIN public.agent_product_knowledge_bindings knowledge
    ON knowledge.workspace_id=draft.workspace_id AND knowledge.agent_id=draft.id
  LEFT JOIN public.agent_product_database_bindings database_binding
    ON database_binding.workspace_id=draft.workspace_id AND database_binding.agent_id=draft.id
  WHERE draft.workspace_id=p_workspace_id ORDER BY draft.updated_at DESC,draft.id LIMIT 200;
$function$;

CREATE FUNCTION app.create_agent_draft_with_strategy_capabilities(
  p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_instructions text,p_model text,
  p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb
) RETURNS public.agent_drafts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_row public.agent_drafts;
BEGIN
  IF NOT COALESCE(app.is_valid_product_agent_strategy_profile(p_strategy_profile),false)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_strategy_profile->'routes') route WHERE route->>'model'=p_model)
    OR (p_strategy_profile->>'forced_capability'='knowledge' AND p_knowledge_base_id IS NULL)
    OR (p_strategy_profile->>'forced_capability'='database' AND p_database_table_id IS NULL)
  THEN RAISE EXCEPTION 'Agent strategy profile is invalid for its model or capabilities' USING ERRCODE='22023'; END IF;
  v_row := app.create_agent_draft_with_role_capabilities(p_workspace_id,p_actor_id,p_name,p_description,
    p_instructions,p_model,p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile);
  UPDATE public.agent_drafts SET strategy_profile=p_strategy_profile,strategy_version=1
    WHERE workspace_id=p_workspace_id AND id=v_row.id RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.update_agent_draft_with_strategy_capabilities(
  p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_name text,p_description text,
  p_instructions text,p_model text,p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,
  p_role_profile jsonb,p_strategy_profile jsonb
) RETURNS public.agent_drafts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_row public.agent_drafts; v_previous jsonb;
BEGIN
  SELECT strategy_profile INTO v_previous FROM public.agent_drafts
    WHERE workspace_id=p_workspace_id AND id=p_agent_id;
  IF NOT COALESCE(app.is_valid_product_agent_strategy_profile(p_strategy_profile),false)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_strategy_profile->'routes') route WHERE route->>'model'=p_model)
    OR (p_strategy_profile->>'forced_capability'='knowledge' AND p_knowledge_base_id IS NULL)
    OR (p_strategy_profile->>'forced_capability'='database' AND p_database_table_id IS NULL)
  THEN RAISE EXCEPTION 'Agent strategy profile is invalid for its model or capabilities' USING ERRCODE='22023'; END IF;
  v_row := app.update_agent_draft_with_role_capabilities(p_workspace_id,p_agent_id,p_expected_revision,
    p_name,p_description,p_instructions,p_model,p_knowledge_base_id,p_database_table_id,p_role_mode,p_role_profile);
  UPDATE public.agent_drafts SET strategy_profile=p_strategy_profile,
    strategy_version=strategy_version + CASE WHEN v_previous IS DISTINCT FROM p_strategy_profile THEN 1 ELSE 0 END
    WHERE workspace_id=p_workspace_id AND id=p_agent_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

DROP FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid);
CREATE FUNCTION app.publish_agent_draft(p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_actor_id uuid)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
DECLARE v_row public.agent_drafts; v_version bigint;
BEGIN
  SELECT COALESCE(max(version),0)+1 INTO v_version FROM public.agent_product_releases
    WHERE workspace_id=p_workspace_id AND agent_id=p_agent_id;
  UPDATE public.agent_drafts SET status='published',revision=revision+1,updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND id=p_agent_id AND revision=p_expected_revision RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent draft revision conflict' USING ERRCODE='40001'; END IF;
  INSERT INTO public.agent_product_releases(workspace_id,agent_id,version,name,description,instructions,model,
    published_by,role_mode,role_profile,strategy_profile,strategy_version)
  VALUES(v_row.workspace_id,v_row.id,v_version,v_row.name,v_row.description,v_row.instructions,v_row.model,
    p_actor_id,v_row.role_mode,v_row.role_profile,v_row.strategy_profile,v_row.strategy_version);
  RETURN v_row;
END;
$function$;

DROP FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text);
CREATE FUNCTION app.begin_agent_product_run(p_workspace_id uuid,p_conversation_id uuid,p_actor_id uuid,p_input_text text)
RETURNS TABLE(run_id uuid,conversation_id uuid,agent_id uuid,sequence bigint,instructions text,model text,
  input_text text,history jsonb,strategy_profile jsonb,strategy_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
DECLARE v_conversation public.agent_product_conversations; v_release public.agent_product_releases;
  v_run_id uuid:=gen_random_uuid(); v_sequence bigint; v_history jsonb;
BEGIN
  SELECT conversation.* INTO v_conversation FROM public.agent_product_conversations conversation
    WHERE conversation.workspace_id=p_workspace_id AND conversation.id=p_conversation_id
      AND conversation.actor_id=p_actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found' USING ERRCODE='P0002'; END IF;
  SELECT release.* INTO STRICT v_release FROM public.agent_product_releases release
    WHERE release.workspace_id=v_conversation.workspace_id AND release.agent_id=v_conversation.agent_id
      AND release.version=v_conversation.release_version;
  SELECT COALESCE(max(run.sequence),0)+1 INTO v_sequence FROM public.agent_product_runs run
    WHERE run.workspace_id=p_workspace_id AND run.conversation_id=p_conversation_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user',run.input_text,'assistant',run.output_text) ORDER BY run.sequence),'[]'::jsonb)
    INTO v_history FROM (SELECT previous.input_text,previous.output_text,previous.sequence
      FROM public.agent_product_runs previous WHERE previous.workspace_id=p_workspace_id
      AND previous.conversation_id=p_conversation_id AND previous.status='completed'
      ORDER BY previous.sequence DESC LIMIT 20) run;
  INSERT INTO public.agent_product_runs(workspace_id,id,conversation_id,sequence,input_text,model,strategy_version,routing_mode)
    VALUES(p_workspace_id,v_run_id,p_conversation_id,v_sequence,btrim(p_input_text),v_release.model,
      v_release.strategy_version,v_release.strategy_profile->>'routing_mode');
  UPDATE public.agent_product_conversations SET updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND id=p_conversation_id;
  RETURN QUERY SELECT v_run_id,v_conversation.id,v_conversation.agent_id,v_sequence,v_release.instructions,
    v_release.model,btrim(p_input_text),v_history,v_release.strategy_profile,v_release.strategy_version;
END;
$function$;

CREATE FUNCTION app.route_agent_product_run(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_model text,p_router_provider_request_id text,
  p_router_input_tokens bigint,p_router_output_tokens bigint) RETURNS public.agent_product_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
DECLARE v_row public.agent_product_runs;
BEGIN
  UPDATE public.agent_product_runs run SET model=p_model,router_provider_request_id=p_router_provider_request_id,router_input_tokens=p_router_input_tokens,
    router_output_tokens=p_router_output_tokens
  FROM public.agent_product_conversations conversation, public.agent_product_releases release
  WHERE run.workspace_id=p_workspace_id AND run.id=p_run_id AND run.status='pending'
    AND conversation.workspace_id=run.workspace_id AND conversation.id=run.conversation_id
    AND conversation.actor_id=p_actor_id AND release.workspace_id=conversation.workspace_id
    AND release.agent_id=conversation.agent_id AND release.version=conversation.release_version
    AND release.strategy_profile->>'routing_mode'='autonomous'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(release.strategy_profile->'routes') route WHERE route->>'model'=p_model)
    AND length(p_router_provider_request_id) BETWEEN 1 AND 200
    AND p_router_input_tokens>=0 AND p_router_output_tokens>=0
    AND p_router_input_tokens <= (release.strategy_profile->>'max_input_tokens')::bigint
  RETURNING run.* INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'product Run routing conflict' USING ERRCODE='40001'; END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION app.complete_agent_product_run(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,
  p_output_text text,p_provider_request_id text,p_input_tokens bigint,p_output_tokens bigint)
RETURNS public.agent_product_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
DECLARE v_row public.agent_product_runs;
BEGIN
  UPDATE public.agent_product_runs run SET status='completed',output_text=p_output_text,
    provider_request_id=p_provider_request_id,input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    completed_at=clock_timestamp()
  FROM public.agent_product_conversations conversation, public.agent_product_releases release
  WHERE run.workspace_id=p_workspace_id AND run.id=p_run_id AND run.status='pending'
    AND conversation.workspace_id=run.workspace_id AND conversation.id=run.conversation_id
    AND conversation.actor_id=p_actor_id AND release.workspace_id=conversation.workspace_id
    AND release.agent_id=conversation.agent_id AND release.version=conversation.release_version
    AND p_input_tokens>=0 AND p_output_tokens>=0
    AND p_input_tokens+run.router_input_tokens <= (release.strategy_profile->>'max_input_tokens')::bigint
    AND p_output_tokens <= (release.strategy_profile->>'max_output_tokens')::bigint
  RETURNING run.* INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'product Run terminal or budget conflict' USING ERRCODE='40001'; END IF;
  RETURN v_row;
END;
$function$;

ALTER FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_strategy_capabilities(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_strategy_capabilities(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_agent_draft_with_strategy_capabilities(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_agent_draft_with_strategy_capabilities(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_agent_draft_with_strategy_capabilities(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.update_agent_draft_with_strategy_capabilities(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
