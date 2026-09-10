-- Extend the product model contract to the current DeepSeek V4 OpenAI-compatible
-- models without rewriting immutable historical Agent or Run facts.
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

ALTER TABLE public.agent_drafts
  DROP CONSTRAINT agent_drafts_model_check,
  ADD CONSTRAINT agent_drafts_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol','deepseek-v4-flash','deepseek-v4-pro')
  );

ALTER TABLE public.agent_product_runs
  DROP CONSTRAINT agent_product_runs_model_check,
  ADD CONSTRAINT agent_product_runs_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol','deepseek-v4-flash','deepseek-v4-pro')
  );

ALTER TABLE public.agent_product_run_subagent_invocations
  DROP CONSTRAINT agent_product_run_subagent_invocations_model_check,
  ADD CONSTRAINT agent_product_run_subagent_invocations_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol','deepseek-v4-flash','deepseek-v4-pro')
  );

ALTER TABLE public.agent_product_async_subagent_invocations
  DROP CONSTRAINT agent_product_async_subagent_invocations_model_check,
  ADD CONSTRAINT agent_product_async_subagent_invocations_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol','deepseek-v4-flash','deepseek-v4-pro')
  );

DO $migration$
DECLARE
  function_name regprocedure;
  function_definition text;
  old_models constant text := '(''gpt-5.4-mini'',''gpt-5.5'',''gpt-5.6-sol'')';
  new_models constant text := '(''gpt-5.4-mini'',''gpt-5.5'',''gpt-5.6-sol'',''deepseek-v4-flash'',''deepseek-v4-pro'')';
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'app.is_valid_product_agent_strategy_profile(jsonb)'::regprocedure,
    'app.is_valid_product_agent_iteration_trace(jsonb)'::regprocedure
  ] LOOP
    function_definition := pg_catalog.pg_get_functiondef(function_name);
    IF pg_catalog.strpos(function_definition, old_models) = 0
      OR pg_catalog.strpos(function_definition, new_models) <> 0 THEN
      RAISE EXCEPTION 'DeepSeek model migration found unexpected validator definition: %', function_name;
    END IF;
    EXECUTE pg_catalog.replace(function_definition, old_models, new_models);
  END LOOP;
END;
$migration$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
