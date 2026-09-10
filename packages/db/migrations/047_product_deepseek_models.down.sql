-- Refuse to narrow the model contract while any immutable or mutable DeepSeek
-- fact remains. Downgrade is safe only when the provider was never used.
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_drafts WHERE model LIKE 'deepseek-v4-%')
    OR EXISTS (SELECT 1 FROM public.agent_product_releases WHERE model LIKE 'deepseek-v4-%')
    OR EXISTS (SELECT 1 FROM public.agent_product_runs WHERE model LIKE 'deepseek-v4-%')
    OR EXISTS (SELECT 1 FROM public.agent_product_run_subagent_invocations WHERE model LIKE 'deepseek-v4-%')
    OR EXISTS (SELECT 1 FROM public.agent_product_async_subagent_invocations WHERE model LIKE 'deepseek-v4-%')
    OR EXISTS (SELECT 1 FROM public.agent_drafts WHERE strategy_profile::text ~ '"deepseek-v4-(flash|pro)"')
    OR EXISTS (SELECT 1 FROM public.agent_product_releases WHERE strategy_profile::text ~ '"deepseek-v4-(flash|pro)"')
    OR EXISTS (SELECT 1 FROM public.agent_product_runs WHERE iteration_trace::text ~ '"deepseek-v4-(flash|pro)"')
    OR EXISTS (SELECT 1 FROM public.agent_product_async_subagent_contexts WHERE chains::text ~ '"deepseek-v4-(flash|pro)"') THEN
    RAISE EXCEPTION 'cannot remove DeepSeek model support while model facts exist';
  END IF;
END;
$guard$;

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
    IF pg_catalog.strpos(function_definition, new_models) = 0 THEN
      RAISE EXCEPTION 'DeepSeek model downgrade found unexpected validator definition: %', function_name;
    END IF;
    EXECUTE pg_catalog.replace(function_definition, new_models, old_models);
  END LOOP;
END;
$migration$;

ALTER TABLE public.agent_product_async_subagent_invocations
  DROP CONSTRAINT agent_product_async_subagent_invocations_model_check,
  ADD CONSTRAINT agent_product_async_subagent_invocations_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')
  );

ALTER TABLE public.agent_product_run_subagent_invocations
  DROP CONSTRAINT agent_product_run_subagent_invocations_model_check,
  ADD CONSTRAINT agent_product_run_subagent_invocations_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')
  );

ALTER TABLE public.agent_product_runs
  DROP CONSTRAINT agent_product_runs_model_check,
  ADD CONSTRAINT agent_product_runs_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')
  );

ALTER TABLE public.agent_drafts
  DROP CONSTRAINT agent_drafts_model_check,
  ADD CONSTRAINT agent_drafts_model_check CHECK (
    model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')
  );

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
