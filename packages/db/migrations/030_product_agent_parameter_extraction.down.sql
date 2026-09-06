DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.agent_product_runs WHERE extracted_parameters IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot remove product Agent parameter extraction with retained evidence'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.record_agent_product_run_parameters(uuid,uuid,uuid,jsonb,text,bigint,bigint);

CREATE OR REPLACE FUNCTION app.route_agent_product_run(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_model text,p_router_provider_request_id text,
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

CREATE OR REPLACE FUNCTION app.complete_agent_product_run(
  p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_output_text text,
  p_provider_request_id text,p_input_tokens bigint,p_output_tokens bigint
) RETURNS public.agent_product_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
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

ALTER TABLE public.agent_product_runs
  DROP CONSTRAINT agent_product_runs_parameter_evidence_check,
  DROP COLUMN parameter_output_tokens,
  DROP COLUMN parameter_input_tokens,
  DROP COLUMN parameter_provider_request_id,
  DROP COLUMN extracted_parameters;
DROP FUNCTION app.is_valid_product_agent_extracted_parameters(jsonb);

ALTER FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
