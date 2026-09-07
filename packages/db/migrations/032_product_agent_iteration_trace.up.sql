-- Product Agent strategy v3 permits 1-4 bounded model iterations. Each model
-- result is sealed on the pending Run before the next provider call or terminalization.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE OR REPLACE FUNCTION app.is_valid_product_agent_strategy_profile(p_profile jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_typeof(p_profile) = 'object'
    AND CASE p_profile ->> 'schema_version'
      WHEN 'product-agent-strategy/1' THEN
        (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile) keys(key))
          = ARRAY['forced_capability','max_input_tokens','max_iterations','max_output_tokens',
                  'max_tool_calls','parameter_extraction','routes','routing_mode','schema_version','temperature']::text[]
      WHEN 'product-agent-strategy/2' THEN
        (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile) keys(key))
          = ARRAY['forced_capability','max_input_tokens','max_iterations','max_output_tokens',
                  'max_tool_calls','parameter_defaults','parameter_extraction','routes','routing_mode',
                  'schema_version','temperature']::text[]
        AND jsonb_typeof(p_profile -> 'parameter_defaults') = 'object'
        AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile -> 'parameter_defaults') keys(key))
          = ARRAY['database_contains','knowledge_query']::text[]
        AND jsonb_typeof(p_profile -> 'parameter_defaults' -> 'database_contains') = 'string'
        AND length(btrim(p_profile -> 'parameter_defaults' ->> 'database_contains')) BETWEEN 0 AND 500
        AND jsonb_typeof(p_profile -> 'parameter_defaults' -> 'knowledge_query') = 'string'
        AND length(btrim(p_profile -> 'parameter_defaults' ->> 'knowledge_query')) BETWEEN 0 AND 500
      WHEN 'product-agent-strategy/3' THEN
        (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile) keys(key))
          = ARRAY['forced_capability','max_input_tokens','max_iterations','max_output_tokens',
                  'max_tool_calls','parameter_defaults','parameter_extraction','routes','routing_mode',
                  'schema_version','temperature']::text[]
        AND jsonb_typeof(p_profile -> 'parameter_defaults') = 'object'
        AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_profile -> 'parameter_defaults') keys(key))
          = ARRAY['database_contains','knowledge_query']::text[]
        AND jsonb_typeof(p_profile -> 'parameter_defaults' -> 'database_contains') = 'string'
        AND length(btrim(p_profile -> 'parameter_defaults' ->> 'database_contains')) BETWEEN 0 AND 500
        AND jsonb_typeof(p_profile -> 'parameter_defaults' -> 'knowledge_query') = 'string'
        AND length(btrim(p_profile -> 'parameter_defaults' ->> 'knowledge_query')) BETWEEN 0 AND 500
      ELSE false
    END
    AND p_profile ->> 'routing_mode' IN ('fixed','autonomous')
    AND p_profile ->> 'forced_capability' IN ('none','knowledge','database')
    AND jsonb_typeof(p_profile -> 'parameter_extraction') = 'boolean'
    AND CASE p_profile ->> 'schema_version'
      WHEN 'product-agent-strategy/3' THEN (p_profile ->> 'max_iterations') ~ '^[1-4]$'
      ELSE (p_profile ->> 'max_iterations') = '1' END
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

CREATE FUNCTION app.is_valid_product_agent_iteration_trace(p_trace jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_typeof(p_trace) = 'array'
    AND jsonb_array_length(p_trace) BETWEEN 0 AND 4
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_trace) WITH ORDINALITY item(value, ordinal)
      WHERE jsonb_typeof(item.value) <> 'object'
        OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item.value) keys(key))
          <> ARRAY['input_tokens','iteration','model','output_text','output_tokens','provider_request_id']::text[]
        OR item.value ->> 'iteration' !~ '^[1-4]$'
        OR jsonb_typeof(item.value -> 'iteration') <> 'number'
        OR (item.value ->> 'iteration')::bigint <> item.ordinal
        OR jsonb_typeof(item.value -> 'model') <> 'string'
        OR item.value ->> 'model' NOT IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')
        OR jsonb_typeof(item.value -> 'output_text') <> 'string'
        OR length(btrim(item.value ->> 'output_text')) NOT BETWEEN 1 AND 50000
        OR jsonb_typeof(item.value -> 'provider_request_id') <> 'string'
        OR length(item.value ->> 'provider_request_id') NOT BETWEEN 1 AND 200
        OR item.value ->> 'input_tokens' !~ '^[0-9]+$'
        OR jsonb_typeof(item.value -> 'input_tokens') <> 'number'
        OR (item.value ->> 'input_tokens')::bigint > 1000000000
        OR item.value ->> 'output_tokens' !~ '^[0-9]+$'
        OR jsonb_typeof(item.value -> 'output_tokens') <> 'number'
        OR (item.value ->> 'output_tokens')::bigint > 1000000000
    );
$function$;

ALTER TABLE public.agent_drafts ALTER COLUMN strategy_profile SET DEFAULT
  '{"schema_version":"product-agent-strategy/3","routing_mode":"fixed","routes":[{"model":"gpt-5.6-sol","description":"default model"}],"parameter_defaults":{"database_contains":"","knowledge_query":""},"parameter_extraction":false,"forced_capability":"none","max_iterations":1,"max_tool_calls":2,"max_input_tokens":32000,"max_output_tokens":2000,"temperature":0.2}'::jsonb;

ALTER TABLE public.agent_product_runs
  ADD COLUMN iteration_count bigint NOT NULL DEFAULT 0 CHECK (iteration_count BETWEEN 0 AND 4),
  ADD COLUMN iteration_trace jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.agent_product_runs
  ADD CONSTRAINT agent_product_runs_iteration_trace_check CHECK (
    COALESCE(app.is_valid_product_agent_iteration_trace(iteration_trace), false)
    AND jsonb_array_length(iteration_trace) = iteration_count
  );

CREATE FUNCTION app.record_agent_product_run_iteration(
  p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_iteration bigint,p_model text,
  p_output_text text,p_provider_request_id text,p_input_tokens bigint,p_output_tokens bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_run public.agent_product_runs;
  v_strategy jsonb;
  v_input_total bigint;
  v_output_total bigint;
BEGIN
  SELECT run, release.strategy_profile INTO v_run, v_strategy
  FROM public.agent_product_runs run
  JOIN public.agent_product_conversations conversation
    ON conversation.workspace_id = run.workspace_id AND conversation.id = run.conversation_id
  JOIN public.agent_product_releases release
    ON release.workspace_id = conversation.workspace_id
   AND release.agent_id = conversation.agent_id
   AND release.version = conversation.release_version
  WHERE run.workspace_id = p_workspace_id
    AND run.id = p_run_id
    AND run.status = 'pending'
    AND run.effective_parameters IS NOT NULL
    AND conversation.actor_id = p_actor_id
    AND release.strategy_profile ->> 'schema_version' = 'product-agent-strategy/3'
  FOR UPDATE OF run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product Run iteration or aggregate budget conflict' USING ERRCODE = '40001';
  END IF;
  IF p_iteration IS DISTINCT FROM jsonb_array_length(v_run.iteration_trace) + 1
    OR p_iteration > (v_strategy ->> 'max_iterations')::bigint
    OR p_model IS DISTINCT FROM v_run.model
    OR p_output_text IS NULL OR length(btrim(p_output_text)) NOT BETWEEN 1 AND 50000
    OR p_provider_request_id IS NULL OR length(p_provider_request_id) NOT BETWEEN 1 AND 200
    OR p_input_tokens IS NULL OR p_input_tokens NOT BETWEEN 0 AND 1000000000
    OR p_output_tokens IS NULL OR p_output_tokens NOT BETWEEN 0 AND 1000000000
  THEN
    RAISE EXCEPTION 'product Run iteration or aggregate budget conflict' USING ERRCODE = '40001';
  END IF;
  SELECT COALESCE(sum((item ->> 'input_tokens')::bigint), 0),
         COALESCE(sum((item ->> 'output_tokens')::bigint), 0)
  INTO v_input_total, v_output_total
  FROM jsonb_array_elements(v_run.iteration_trace) item;
  v_input_total := v_input_total + p_input_tokens;
  v_output_total := v_output_total + p_output_tokens;
  IF v_input_total + v_run.router_input_tokens + v_run.parameter_input_tokens
       > (v_strategy ->> 'max_input_tokens')::bigint
    OR v_output_total + v_run.router_output_tokens + v_run.parameter_output_tokens
       > (v_strategy ->> 'max_output_tokens')::bigint
  THEN
    RAISE EXCEPTION 'product Run iteration or aggregate budget conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE public.agent_product_runs run
  SET iteration_count = p_iteration,
      iteration_trace = run.iteration_trace || jsonb_build_array(jsonb_build_object(
        'input_tokens',p_input_tokens,'iteration',p_iteration,'model',p_model,
        'output_text',btrim(p_output_text),'output_tokens',p_output_tokens,
        'provider_request_id',p_provider_request_id
      ))
  WHERE run.workspace_id = p_workspace_id AND run.id = p_run_id;
END;
$function$;

CREATE OR REPLACE FUNCTION app.complete_agent_product_run(
  p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_output_text text,
  p_provider_request_id text,p_input_tokens bigint,p_output_tokens bigint
) RETURNS public.agent_product_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_run public.agent_product_runs;
  v_strategy jsonb;
  v_last jsonb;
  v_input_total bigint;
  v_output_total bigint;
BEGIN
  SELECT run, release.strategy_profile INTO v_run, v_strategy
  FROM public.agent_product_runs run
  JOIN public.agent_product_conversations conversation
    ON conversation.workspace_id = run.workspace_id AND conversation.id = run.conversation_id
  JOIN public.agent_product_releases release
    ON release.workspace_id = conversation.workspace_id
   AND release.agent_id = conversation.agent_id
   AND release.version = conversation.release_version
  WHERE run.workspace_id = p_workspace_id
    AND run.id = p_run_id
    AND run.status = 'pending'
    AND run.effective_parameters IS NOT NULL
    AND conversation.actor_id = p_actor_id
  FOR UPDATE OF run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE = '40001';
  END IF;
  IF p_output_text IS NULL OR length(btrim(p_output_text)) NOT BETWEEN 1 AND 50000
    OR p_provider_request_id IS NULL OR length(p_provider_request_id) NOT BETWEEN 1 AND 200
    OR p_input_tokens IS NULL OR p_input_tokens NOT BETWEEN 0 AND 1000000000
    OR p_output_tokens IS NULL OR p_output_tokens NOT BETWEEN 0 AND 1000000000
  THEN
    RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE = '40001';
  END IF;
  IF v_strategy ->> 'schema_version' = 'product-agent-strategy/3' THEN
    IF v_run.iteration_count NOT BETWEEN 1 AND (v_strategy ->> 'max_iterations')::bigint THEN
      RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE = '40001';
    END IF;
    v_last := v_run.iteration_trace -> (v_run.iteration_count::int - 1);
    SELECT COALESCE(sum((item ->> 'input_tokens')::bigint), 0),
           COALESCE(sum((item ->> 'output_tokens')::bigint), 0)
    INTO v_input_total, v_output_total
    FROM jsonb_array_elements(v_run.iteration_trace) item;
    IF btrim(p_output_text) IS DISTINCT FROM v_last ->> 'output_text'
      OR p_provider_request_id IS DISTINCT FROM v_last ->> 'provider_request_id'
      OR p_input_tokens IS DISTINCT FROM v_input_total
      OR p_output_tokens IS DISTINCT FROM v_output_total
    THEN
      RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE = '40001';
    END IF;
  ELSE
    IF v_run.iteration_count <> 0 THEN
      RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE = '40001';
    END IF;
    v_input_total := p_input_tokens;
    v_output_total := p_output_tokens;
  END IF;
  IF v_input_total + v_run.router_input_tokens + v_run.parameter_input_tokens
       > (v_strategy ->> 'max_input_tokens')::bigint
    OR v_output_total + v_run.router_output_tokens + v_run.parameter_output_tokens
       > (v_strategy ->> 'max_output_tokens')::bigint
  THEN
    RAISE EXCEPTION 'product Run terminal, iteration or aggregate budget conflict' USING ERRCODE = '40001';
  END IF;
  UPDATE public.agent_product_runs run
  SET status='completed',output_text=btrim(p_output_text),provider_request_id=p_provider_request_id,
      input_tokens=v_input_total,output_tokens=v_output_total,completed_at=clock_timestamp()
  WHERE run.workspace_id=p_workspace_id AND run.id=p_run_id
  RETURNING run.* INTO v_run;
  RETURN v_run;
END;
$function$;

ALTER FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.is_valid_product_agent_iteration_trace(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_agent_product_run_iteration(uuid,uuid,uuid,bigint,text,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.is_valid_product_agent_iteration_trace(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_agent_product_run_iteration(uuid,uuid,uuid,bigint,text,text,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_agent_product_run_iteration(uuid,uuid,uuid,bigint,text,text,text,bigint,bigint) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
