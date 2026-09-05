DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_strategy_executions)
     OR EXISTS (SELECT 1 FROM public.agent_strategy_checkpoints)
     OR EXISTS (SELECT 1 FROM public.agent_strategy_actions)
     OR EXISTS (SELECT 1 FROM public.agent_strategy_action_results)
     OR EXISTS (SELECT 1 FROM public.agent_model_usage_receipts) THEN
    RAISE EXCEPTION 'durable Agent Strategy facts exist; downgrade rejected'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

REVOKE EXECUTE ON FUNCTION app.register_agent_strategy_execution(jsonb),
  app.commit_agent_strategy_checkpoint(jsonb),
  app.commit_agent_strategy_action_result(jsonb) FROM ba_execution_executor;
DROP FUNCTION app.commit_agent_strategy_action_result(jsonb);
DROP FUNCTION app.commit_agent_strategy_checkpoint(jsonb);
DROP FUNCTION app.register_agent_strategy_execution(jsonb);
DROP TRIGGER agent_model_usage_receipts_immutable ON public.agent_model_usage_receipts;
DROP TRIGGER agent_strategy_action_results_immutable ON public.agent_strategy_action_results;
DROP TRIGGER agent_strategy_actions_immutable ON public.agent_strategy_actions;
DROP TRIGGER agent_strategy_checkpoints_immutable ON public.agent_strategy_checkpoints;
DROP TRIGGER agent_strategy_executions_immutable ON public.agent_strategy_executions;
DROP FUNCTION app.reject_g1_agent_strategy_fact_change();
DROP POLICY agent_model_usage_receipts_owner_access ON public.agent_model_usage_receipts;
DROP POLICY agent_strategy_action_results_owner_access ON public.agent_strategy_action_results;
DROP POLICY agent_strategy_actions_owner_access ON public.agent_strategy_actions;
DROP POLICY agent_strategy_checkpoints_owner_access ON public.agent_strategy_checkpoints;
DROP POLICY agent_strategy_executions_owner_access ON public.agent_strategy_executions;
DROP TABLE public.agent_model_usage_receipts;
DROP TABLE public.agent_strategy_action_results;
DROP TABLE public.agent_strategy_actions;
DROP TABLE public.agent_strategy_checkpoints;
DROP TABLE public.agent_strategy_executions;
REVOKE EXECUTE ON FUNCTION auth.issue_agent_strategy_plan_attestation(
  uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz
) FROM ba_management_attestation_issuer;
REVOKE EXECUTE ON FUNCTION auth.consume_agent_strategy_plan_attestation(
  uuid,bytea,uuid,uuid,jsonb
) FROM ba_run_owner;
DROP FUNCTION auth.consume_agent_strategy_plan_attestation(uuid,bytea,uuid,uuid,jsonb);
DROP FUNCTION auth.issue_agent_strategy_plan_attestation(
  uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz
);
DROP POLICY agent_strategy_plan_attestations_owner_access
ON auth.agent_strategy_plan_attestations;
DROP TABLE auth.agent_strategy_plan_attestations;
