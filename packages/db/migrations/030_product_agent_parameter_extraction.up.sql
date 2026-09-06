-- Product Agent parameter extraction v1. Extraction is an audited model action
-- recorded before capability dispatch; aggregate model usage remains bounded by
-- the immutable release strategy.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE FUNCTION app.is_valid_product_agent_extracted_parameters(p_parameters jsonb)
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

ALTER TABLE public.agent_product_runs
  ADD COLUMN extracted_parameters jsonb,
  ADD COLUMN parameter_provider_request_id text,
  ADD COLUMN parameter_input_tokens bigint NOT NULL DEFAULT 0 CHECK (parameter_input_tokens >= 0),
  ADD COLUMN parameter_output_tokens bigint NOT NULL DEFAULT 0 CHECK (parameter_output_tokens >= 0),
  ADD CONSTRAINT agent_product_runs_parameter_evidence_check CHECK (
    (extracted_parameters IS NULL AND parameter_provider_request_id IS NULL
      AND parameter_input_tokens = 0 AND parameter_output_tokens = 0)
    OR
    (COALESCE(app.is_valid_product_agent_extracted_parameters(extracted_parameters), false)
      AND parameter_provider_request_id IS NOT NULL
      AND length(parameter_provider_request_id) BETWEEN 1 AND 200)
  );

CREATE OR REPLACE FUNCTION app.route_agent_product_run(
  p_workspace_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_model text,
  p_router_provider_request_id text,
  p_router_input_tokens bigint,
  p_router_output_tokens bigint
) RETURNS public.agent_product_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_row public.agent_product_runs;
BEGIN
  UPDATE public.agent_product_runs run
  SET model = p_model,
      router_provider_request_id = p_router_provider_request_id,
      router_input_tokens = p_router_input_tokens,
      router_output_tokens = p_router_output_tokens
  FROM public.agent_product_conversations conversation, public.agent_product_releases release
  WHERE run.workspace_id = p_workspace_id
    AND run.id = p_run_id
    AND run.status = 'pending'
    AND run.router_provider_request_id IS NULL
    AND conversation.workspace_id = run.workspace_id
    AND conversation.id = run.conversation_id
    AND conversation.actor_id = p_actor_id
    AND release.workspace_id = conversation.workspace_id
    AND release.agent_id = conversation.agent_id
    AND release.version = conversation.release_version
    AND release.strategy_profile ->> 'routing_mode' = 'autonomous'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(release.strategy_profile -> 'routes') route
      WHERE route ->> 'model' = p_model
    )
    AND length(p_router_provider_request_id) BETWEEN 1 AND 200
    AND p_router_input_tokens BETWEEN 0 AND 1000000000
    AND p_router_output_tokens BETWEEN 0 AND 1000000000
  RETURNING run.* INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product Run routing conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.record_agent_product_run_parameters(
  p_workspace_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_parameters jsonb,
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
  SET extracted_parameters = jsonb_build_object(
        'database_contains', btrim(p_parameters ->> 'database_contains'),
        'knowledge_query', btrim(p_parameters ->> 'knowledge_query')
      ),
      parameter_provider_request_id = p_provider_request_id,
      parameter_input_tokens = p_input_tokens,
      parameter_output_tokens = p_output_tokens
  FROM public.agent_product_conversations conversation, public.agent_product_releases release
  WHERE run.workspace_id = p_workspace_id
    AND run.id = p_run_id
    AND run.status = 'pending'
    AND run.parameter_provider_request_id IS NULL
    AND conversation.workspace_id = run.workspace_id
    AND conversation.id = run.conversation_id
    AND conversation.actor_id = p_actor_id
    AND release.workspace_id = conversation.workspace_id
    AND release.agent_id = conversation.agent_id
    AND release.version = conversation.release_version
    AND release.strategy_profile->>'parameter_extraction'='true'
    AND COALESCE(app.is_valid_product_agent_extracted_parameters(p_parameters), false)
    AND length(p_provider_request_id) BETWEEN 1 AND 200
    AND p_input_tokens BETWEEN 0 AND 1000000000
    AND p_output_tokens BETWEEN 0 AND 1000000000
  RETURNING run.* INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product Run parameter extraction conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
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

ALTER FUNCTION app.is_valid_product_agent_extracted_parameters(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_agent_product_run_parameters(uuid,uuid,uuid,jsonb,text,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.is_valid_product_agent_extracted_parameters(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_agent_product_run_parameters(uuid,uuid,uuid,jsonb,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_agent_product_run_parameters(uuid,uuid,uuid,jsonb,text,bigint,bigint) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
