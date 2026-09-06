-- Product Agent strategy v2 adds closed capability parameter defaults. Every
-- Run persists the database-resolved effective values before capability I/O.

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
        AND (SELECT array_agg(key ORDER BY key)
             FROM jsonb_object_keys(p_profile -> 'parameter_defaults') keys(key))
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
    AND length(btrim(p_parameters ->> 'knowledge_query')) BETWEEN 0 AND 500;
$function$;

ALTER TABLE public.agent_drafts ALTER COLUMN strategy_profile SET DEFAULT
  '{"schema_version":"product-agent-strategy/2","routing_mode":"fixed","routes":[{"model":"gpt-5.6-sol","description":"default model"}],"parameter_defaults":{"database_contains":"","knowledge_query":""},"parameter_extraction":false,"forced_capability":"none","max_iterations":1,"max_tool_calls":2,"max_input_tokens":32000,"max_output_tokens":2000,"temperature":0.2}'::jsonb;

ALTER TABLE public.agent_product_runs
  ADD COLUMN effective_parameters jsonb,
  ADD COLUMN parameter_source text;

UPDATE public.agent_product_runs run
SET effective_parameters = CASE
      WHEN run.extracted_parameters IS NOT NULL THEN run.extracted_parameters
      ELSE jsonb_build_object(
        'database_contains', COALESCE(btrim(release.strategy_profile -> 'parameter_defaults' ->> 'database_contains'), ''),
        'knowledge_query', COALESCE(
          NULLIF(btrim(release.strategy_profile -> 'parameter_defaults' ->> 'knowledge_query'), ''),
          left(run.input_text, 500)
        )
      ) END,
    parameter_source = CASE WHEN run.extracted_parameters IS NULL THEN 'defaults' ELSE 'extracted' END
FROM public.agent_product_conversations conversation, public.agent_product_releases release
WHERE (run.status = 'completed' OR run.extracted_parameters IS NOT NULL)
  AND conversation.workspace_id = run.workspace_id
  AND conversation.id = run.conversation_id
  AND release.workspace_id = conversation.workspace_id
  AND release.agent_id = conversation.agent_id
  AND release.version = conversation.release_version;

ALTER TABLE public.agent_product_runs
  ADD CONSTRAINT agent_product_runs_effective_parameters_check CHECK (
    (status <> 'completed' OR effective_parameters IS NOT NULL)
    AND (
      (effective_parameters IS NULL AND parameter_source IS NULL)
      OR
      (COALESCE(app.is_valid_product_agent_extracted_parameters(effective_parameters), false)
        AND length(btrim(effective_parameters ->> 'knowledge_query')) BETWEEN 1 AND 500
        AND parameter_source IN ('defaults','extracted'))
    )
  );

CREATE FUNCTION app.resolve_agent_product_run_parameters(
  p_workspace_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_effective_parameters jsonb,
  p_extracted_parameters jsonb,
  p_provider_request_id text,
  p_input_tokens bigint,
  p_output_tokens bigint
) RETURNS TABLE(database_contains text, knowledge_query text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_input_text text;
  v_strategy jsonb;
  v_existing jsonb;
  v_expected jsonb;
  v_source text;
BEGIN
  SELECT run.input_text, release.strategy_profile, run.effective_parameters
  INTO v_input_text, v_strategy, v_existing
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
    AND conversation.actor_id = p_actor_id
  FOR UPDATE OF run;

  IF NOT FOUND OR v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'product Run parameter resolution conflict' USING ERRCODE = '40001';
  END IF;

  IF v_strategy ->> 'parameter_extraction' = 'true' THEN
    IF NOT COALESCE(app.is_valid_product_agent_extracted_parameters(p_extracted_parameters), false)
      OR p_provider_request_id IS NULL
      OR length(p_provider_request_id) NOT BETWEEN 1 AND 200
      OR p_input_tokens IS NULL
      OR p_output_tokens IS NULL
      OR p_input_tokens NOT BETWEEN 0 AND 1000000000
      OR p_output_tokens NOT BETWEEN 0 AND 1000000000
    THEN
      RAISE EXCEPTION 'product Run parameter resolution conflict' USING ERRCODE = '40001';
    END IF;
    v_source := 'extracted';
  ELSE
    IF p_extracted_parameters IS NOT NULL
      OR p_provider_request_id IS NOT NULL
      OR p_input_tokens IS NULL
      OR p_output_tokens IS NULL
      OR p_input_tokens <> 0
      OR p_output_tokens <> 0
    THEN
      RAISE EXCEPTION 'product Run parameter resolution conflict' USING ERRCODE = '40001';
    END IF;
    v_source := 'defaults';
  END IF;

  v_expected := jsonb_build_object(
    'database_contains', COALESCE(
      NULLIF(btrim(p_extracted_parameters ->> 'database_contains'), ''),
      btrim(v_strategy -> 'parameter_defaults' ->> 'database_contains'),
      ''
    ),
    'knowledge_query', COALESCE(
      NULLIF(btrim(p_extracted_parameters ->> 'knowledge_query'), ''),
      NULLIF(btrim(v_strategy -> 'parameter_defaults' ->> 'knowledge_query'), ''),
      left(v_input_text, 500)
    )
  );

  IF NOT COALESCE(app.is_valid_product_agent_extracted_parameters(p_effective_parameters), false)
    OR length(btrim(p_effective_parameters ->> 'knowledge_query')) NOT BETWEEN 1 AND 500
    OR jsonb_build_object(
      'database_contains', btrim(p_effective_parameters ->> 'database_contains'),
      'knowledge_query', btrim(p_effective_parameters ->> 'knowledge_query')
    ) IS DISTINCT FROM v_expected
  THEN
    RAISE EXCEPTION 'product Run parameter resolution conflict' USING ERRCODE = '40001';
  END IF;

  UPDATE public.agent_product_runs
  SET effective_parameters = v_expected,
      parameter_source = v_source,
      extracted_parameters = p_extracted_parameters,
      parameter_provider_request_id = p_provider_request_id,
      parameter_input_tokens = p_input_tokens,
      parameter_output_tokens = p_output_tokens
  WHERE workspace_id = p_workspace_id AND id = p_run_id;

  RETURN QUERY SELECT v_expected ->> 'database_contains', v_expected ->> 'knowledge_query';
END;
$function$;

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
    AND run.effective_parameters IS NOT NULL
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
    RAISE EXCEPTION 'product Run terminal, parameter or aggregate budget conflict'
      USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
END;
$function$;

ALTER FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.is_valid_product_agent_extracted_parameters(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.resolve_agent_product_run_parameters(uuid,uuid,uuid,jsonb,jsonb,text,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.is_valid_product_agent_strategy_profile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.is_valid_product_agent_extracted_parameters(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_agent_product_run_parameters(uuid,uuid,uuid,jsonb,jsonb,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.record_agent_product_run_parameters(uuid,uuid,uuid,jsonb,text,bigint,bigint) FROM ba_runtime;
GRANT EXECUTE ON FUNCTION app.resolve_agent_product_run_parameters(uuid,uuid,uuid,jsonb,jsonb,text,bigint,bigint) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
