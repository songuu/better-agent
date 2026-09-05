DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.flow_step_checkpoints)
     OR EXISTS (SELECT 1 FROM public.flow_model_usage_receipts)
     OR EXISTS (SELECT 1 FROM public.flow_executions)
     OR EXISTS (SELECT 1 FROM auth.flow_execution_plan_attestations) THEN
    RAISE EXCEPTION 'durable Flow execution facts exist; downgrade rejected'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

REVOKE EXECUTE ON FUNCTION app.record_flow_model_usage_receipt(jsonb)
FROM ba_execution_executor;
REVOKE EXECUTE ON FUNCTION app.record_flow_step_checkpoint(jsonb)
FROM ba_execution_executor;
REVOKE EXECUTE ON FUNCTION app.register_flow_execution(jsonb)
FROM ba_execution_executor;
DROP FUNCTION app.record_flow_model_usage_receipt(jsonb);
DROP FUNCTION app.record_flow_step_checkpoint(jsonb);
DROP FUNCTION app.register_flow_execution(jsonb);
REVOKE EXECUTE ON FUNCTION auth.consume_flow_execution_plan_attestation(
  uuid,bytea,uuid,uuid,jsonb
) FROM ba_run_owner;
REVOKE EXECUTE ON FUNCTION auth.issue_flow_execution_plan_attestation(
  uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz
) FROM ba_management_attestation_issuer;
REVOKE EXECUTE ON FUNCTION auth.revoke_flow_execution_plan_attestation(uuid,text)
FROM ba_management_attestation_issuer;
DROP FUNCTION auth.revoke_flow_execution_plan_attestation(uuid,text);
DROP FUNCTION auth.consume_flow_execution_plan_attestation(uuid,bytea,uuid,uuid,jsonb);
DROP FUNCTION auth.issue_flow_execution_plan_attestation(
  uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz
);
DROP TRIGGER flow_execution_plan_attestations_controlled_change
  ON auth.flow_execution_plan_attestations;
DROP FUNCTION auth.enforce_flow_execution_plan_attestation_change();
DROP POLICY flow_execution_plan_attestations_owner_access
  ON auth.flow_execution_plan_attestations;
DROP TABLE auth.flow_execution_plan_attestations;
REVOKE EXECUTE ON FUNCTION app.g007_canonical_json(jsonb)
FROM ba_authorization_owner;
DROP TRIGGER flow_model_usage_receipts_immutable
  ON public.flow_model_usage_receipts;
DROP TRIGGER flow_step_checkpoints_immutable
  ON public.flow_step_checkpoints;
DROP TRIGGER flow_executions_immutable ON public.flow_executions;
DROP FUNCTION app.reject_g1_flow_execution_fact_change();
DROP POLICY flow_model_usage_receipts_owner_access
  ON public.flow_model_usage_receipts;
DROP POLICY flow_step_checkpoints_owner_access
  ON public.flow_step_checkpoints;
DROP POLICY flow_executions_owner_access ON public.flow_executions;
DROP TABLE public.flow_step_checkpoints;
DROP TABLE public.flow_model_usage_receipts;
DROP TABLE public.flow_executions;
