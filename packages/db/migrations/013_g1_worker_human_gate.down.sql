DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.run_mutation_idempotency
    WHERE fixed_route='/v1/oapi/runs/{run_id}/gates/{gate_id}/resume')
     OR EXISTS (SELECT 1 FROM public.run_events
       WHERE event_type IN ('RUN_WAITING','RUN_RESUMED','RUN_TERMINAL_INTENT'))
     OR EXISTS (SELECT 1 FROM public.human_gate_evidence) THEN
    RAISE EXCEPTION 'Human Gate resume facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard$;
REVOKE EXECUTE ON FUNCTION app.resume_human_gate(jsonb) FROM ba_runtime;
DROP FUNCTION app.resume_human_gate(jsonb);
DROP FUNCTION app.require_human_gate_authorization(uuid,jsonb,boolean);
REVOKE SELECT (id,workspace_id,ingress_channel)
  ON public.flow_deployments FROM ba_run_owner;
REVOKE SELECT (workspace_id,flow_deployment_id,status)
  ON public.flow_deployment_security_states FROM ba_run_owner;
REVOKE SELECT (
  workspace_id,flow_deployment_id,credential_id,credential_kind,ingress_channel,
  scope,status,not_before_at,expires_at
) ON public.flow_deployment_entry_grants FROM ba_run_owner;
REVOKE SELECT (
  workspace_id,id,credential_kind,status,revoked_at,not_before_at,expires_at
) ON public.api_credentials FROM ba_run_owner;
REVOKE SELECT (workspace_id,credential_id,credential_kind,scope)
  ON public.api_credential_scopes FROM ba_run_owner;
DROP TRIGGER human_gate_evidence_immutable ON public.human_gate_evidence;
DROP POLICY human_gate_evidence_owner_access ON public.human_gate_evidence;
DROP TABLE public.human_gate_evidence;
ALTER TABLE public.run_mutation_idempotency DROP CONSTRAINT run_mutation_idempotency_gate_fkey;
ALTER TABLE public.run_events DROP CONSTRAINT run_events_event_type_check;
ALTER TABLE public.run_events ADD CONSTRAINT run_events_event_type_check CHECK (event_type IN (
  'RUN_ACCEPTED','RUN_QUEUED','RUN_STARTED','RUN_RETRY_WAIT','RUN_RECOVERING',
  'RUN_CANCEL_REQUESTED','RUN_FINISHED','ATTEMPT_LEASED','ATTEMPT_FINISHED',
  'STEP_STARTED','STEP_FINISHED','CREDIT_RESERVED','CREDIT_SETTLED',
  'OUTBOX_ENQUEUED','SSE_TASK'
));
