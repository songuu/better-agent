SET LOCAL ROLE ba_authorization_owner;
DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM public.evaluation_suite_releases)
     OR EXISTS(SELECT 1 FROM public.evaluation_runs)
     OR EXISTS(SELECT 1 FROM public.evaluation_evidence_bundles)
     OR EXISTS(SELECT 1 FROM public.production_promotion_decisions) THEN
    RAISE EXCEPTION 'production evaluation facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard$;
REVOKE EXECUTE ON FUNCTION app.consume_production_promotion_decision(uuid,bigint,text)
  FROM ba_control_executor;
REVOKE EXECUTE ON FUNCTION app.register_evaluation_suite_release(jsonb),
  app.register_evaluation_run(jsonb),app.register_evaluation_evidence_bundle(jsonb),
  app.create_production_promotion_decision(uuid,jsonb,text,timestamptz),
  app.transition_production_promotion_decision(uuid,uuid,bigint,text,text)
FROM ba_management_attestation_issuer;
DROP POLICY flow_deployment_pointers_evaluation_reviewer_read ON public.flow_deployment_active_pointers;
DROP POLICY flow_deployment_revisions_evaluation_reviewer_read ON public.flow_deployment_revisions;
DROP POLICY flow_deployments_evaluation_reviewer_lock ON public.flow_deployments;
DROP POLICY flow_deployments_evaluation_reviewer_read ON public.flow_deployments;
DROP POLICY agent_deployment_pointers_evaluation_reviewer_read ON public.agent_deployment_active_pointers;
DROP POLICY agent_deployment_revisions_evaluation_reviewer_read ON public.agent_deployment_revisions;
DROP POLICY agent_deployments_evaluation_reviewer_lock ON public.agent_deployments;
DROP POLICY agent_deployments_evaluation_reviewer_read ON public.agent_deployments;
DROP POLICY published_executable_closures_evaluation_reviewer_read ON public.published_executable_closures;
DROP FUNCTION app.consume_production_promotion_decision(uuid,bigint,text);
DROP FUNCTION app.transition_production_promotion_decision(uuid,uuid,bigint,text,text);
DROP FUNCTION app.create_production_promotion_decision(uuid,jsonb,text,timestamptz);
DROP FUNCTION app.register_evaluation_evidence_bundle(jsonb);
DROP FUNCTION app.register_evaluation_run(jsonb);
DROP FUNCTION app.register_evaluation_suite_release(jsonb);
DROP TRIGGER production_promotion_decisions_guard ON public.production_promotion_decisions;
DROP FUNCTION app.guard_production_promotion_decision_update();
DROP TRIGGER evaluation_evidence_bundles_immutable ON public.evaluation_evidence_bundles;
DROP TRIGGER evaluation_runs_immutable ON public.evaluation_runs;
DROP TRIGGER evaluation_suite_releases_immutable ON public.evaluation_suite_releases;
DROP FUNCTION app.reject_g1_production_evaluation_immutable();
DROP TABLE public.production_promotion_decisions;
DROP TABLE public.evaluation_evidence_bundles;
DROP TABLE public.evaluation_runs;
DROP TABLE public.evaluation_suite_releases;
RESET ROLE;
