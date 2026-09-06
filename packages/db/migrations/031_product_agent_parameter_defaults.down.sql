DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.agent_drafts
    WHERE strategy_profile ->> 'schema_version' = 'product-agent-strategy/2'
  ) OR EXISTS (
    SELECT 1 FROM public.agent_product_releases
    WHERE strategy_profile ->> 'schema_version' = 'product-agent-strategy/2'
  ) OR EXISTS (
    SELECT 1 FROM public.agent_product_runs
    WHERE parameter_source = 'defaults'
       OR (effective_parameters IS NOT NULL AND effective_parameters IS DISTINCT FROM extracted_parameters)
  ) THEN
    RAISE EXCEPTION 'cannot remove product Agent parameter defaults with retained evidence'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

REVOKE EXECUTE ON FUNCTION app.resolve_agent_product_run_parameters(uuid,uuid,uuid,jsonb,jsonb,text,bigint,bigint) FROM ba_runtime;
DROP FUNCTION app.resolve_agent_product_run_parameters(uuid,uuid,uuid,jsonb,jsonb,text,bigint,bigint);
GRANT EXECUTE ON FUNCTION app.record_agent_product_run_parameters(uuid,uuid,uuid,jsonb,text,bigint,bigint) TO ba_runtime;

CREATE OR REPLACE FUNCTION app.complete_agent_product_run(
  p_workspace_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_output_text text,
  p_provider_request_id text,
  p_input_tokens bigint,
  p_output_tokens bigint
) RETURNS public.agent_product_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_row public.agent_product_runs;
BEGIN
  UPDATE public.agent_product_runs run
  SET status = 'completed',
      output_text = p_output_text,
      provider_request_id = p_provider_request_id,
      input_tokens = p_input_tokens,
      output_tokens = p_output_tokens,
      completed_at = clock_timestamp()
  FROM public.agent_product_conversations conversation, public.agent_product_releases release
  WHERE run.workspace_id = p_workspace_id
    AND run.id = p_run_id
    AND run.status = 'pending'
    AND conversation.workspace_id = run.workspace_id
    AND conversation.id = run.conversation_id
    AND conversation.actor_id = p_actor_id
    AND release.workspace_id = conversation.workspace_id
    AND release.agent_id = conversation.agent_id
    AND release.version = conversation.release_version
    AND p_input_tokens >= 0
    AND p_output_tokens >= 0
    AND p_input_tokens + run.router_input_tokens + run.parameter_input_tokens
      <= (release.strategy_profile ->> 'max_input_tokens')::bigint
    AND p_output_tokens + run.router_output_tokens + run.parameter_output_tokens
      <= (release.strategy_profile ->> 'max_output_tokens')::bigint
  RETURNING run.* INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product Run terminal or aggregate budget conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
END;
$function$;

ALTER FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;

ALTER TABLE public.agent_product_runs
  DROP CONSTRAINT agent_product_runs_effective_parameters_check,
  DROP COLUMN parameter_source,
  DROP COLUMN effective_parameters;

ALTER TABLE public.agent_drafts ALTER COLUMN strategy_profile SET DEFAULT
  '{"schema_version":"product-agent-strategy/1","routing_mode":"fixed","routes":[{"model":"gpt-5.6-sol","description":"default model"}],"parameter_extraction":false,"forced_capability":"none","max_iterations":1,"max_tool_calls":2,"max_input_tokens":32000,"max_output_tokens":2000,"temperature":0.2}'::jsonb;

CREATE OR REPLACE FUNCTION app.is_valid_product_agent_strategy_profile(p_profile jsonb)
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

CREATE OR REPLACE FUNCTION app.is_valid_product_agent_extracted_parameters(p_parameters jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_typeof(p_parameters) = 'object'
    AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_parameters) keys(key))
      = ARRAY['database_contains','knowledge_query']::text[]
    AND jsonb_typeof(p_parameters -> 'database_contains') = 'string'
    AND length(btrim(p_parameters ->> 'database_contains')) BETWEEN 0 AND 500
    AND jsonb_typeof(p_parameters -> 'knowledge_query') = 'string'
    AND length(btrim(p_parameters ->> 'knowledge_query')) BETWEEN 1 AND 500;
$function$;

ALTER FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.is_valid_product_agent_extracted_parameters(jsonb) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.is_valid_product_agent_extracted_parameters(jsonb) FROM PUBLIC;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
