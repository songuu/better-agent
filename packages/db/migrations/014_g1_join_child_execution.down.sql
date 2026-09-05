DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.runs WHERE run_kind='join_child')
     OR EXISTS (SELECT 1 FROM public.run_parent_links)
     OR EXISTS (SELECT 1 FROM public.run_budget_allocations) THEN
    RAISE EXCEPTION 'join-child execution facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard$;

REVOKE EXECUTE ON FUNCTION app.create_child_run(jsonb) FROM ba_execution_executor;
DROP FUNCTION app.create_child_run(jsonb);
DROP TRIGGER credit_reservations_no_child ON public.credit_reservations;
REVOKE EXECUTE ON FUNCTION app.reject_child_credit_reservation() FROM ba_billing_owner;
DROP FUNCTION app.reject_child_credit_reservation();
DROP TRIGGER run_parent_links_immutable ON public.run_parent_links;
REVOKE EXECUTE ON FUNCTION app.allocate_child_run_budget(jsonb) FROM ba_run_owner;
DROP FUNCTION app.allocate_child_run_budget(jsonb);
DROP TRIGGER run_budget_allocations_immutable ON public.run_budget_allocations;
DROP FUNCTION app.reject_g1_join_allocation_change();

ALTER TABLE public.run_parent_links DROP CONSTRAINT run_parent_links_parent_checkpoint_fkey,
  DROP CONSTRAINT run_parent_links_child_parent_key,
  DROP CONSTRAINT run_parent_links_parent_call_key,
  DROP COLUMN context_projection_sha256,DROP COLUMN context_projection_object_ref,
  DROP COLUMN delegation_expires_at,DROP COLUMN delegation_reason,
  DROP COLUMN delegation_policy_hash,DROP COLUMN call_sequence,DROP COLUMN child_depth,
  DROP COLUMN parent_depth,DROP COLUMN ancestor_target_refs,DROP COLUMN target_ref,
  DROP COLUMN binding_id,DROP COLUMN canonical_operation_hash,DROP COLUMN child_plan_hash,
  DROP COLUMN parent_checkpoint_sha256,DROP COLUMN parent_checkpoint_object_ref,
  DROP COLUMN parent_checkpoint_id,DROP COLUMN parent_plan_hash;
CREATE TRIGGER run_parent_links_unavailable BEFORE INSERT ON public.run_parent_links
  FOR EACH ROW EXECUTE FUNCTION app.reject_g006_unavailable_path();
CREATE TRIGGER run_budget_allocations_unavailable BEFORE INSERT ON public.run_budget_allocations
  FOR EACH ROW EXECUTE FUNCTION app.reject_g006_unavailable_path();

ALTER TABLE public.runs DROP CONSTRAINT runs_billing_root_fkey;
ALTER TABLE public.runs DROP CONSTRAINT runs_billing_owner_shape_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_self_billing_owner_check CHECK (billing_owner_run_id=id);
ALTER TABLE public.runs DROP CONSTRAINT runs_run_kind_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_run_kind_check CHECK (run_kind='top_level');
ALTER TABLE public.runs DROP CONSTRAINT runs_status_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_status_check CHECK (status IN (
  'QUEUED','RUNNING','WAITING_FOR_INPUT','WAITING_FOR_APPROVAL','RESUMING',
  'CANCEL_REQUESTED','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_ATTENTION'));
ALTER TABLE public.runs DROP CONSTRAINT runs_execution_status_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_execution_status_check CHECK (execution_status IN (
  'ACCEPTED','QUEUED','RUNNING','WAITING_FOR_INPUT','WAITING_FOR_APPROVAL','RESUMING',
  'RETRY_WAIT','RECOVERING','CANCELLING','SUCCEEDED','FAILED','CANCELLED','EXPIRED','NEEDS_ATTENTION'));
ALTER TABLE public.runs DROP CONSTRAINT runs_target_shape_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_target_shape_check CHECK (
  (target_kind='agent' AND fixed_route='/v1/oapi/agent/chat'
    AND agent_deployment_id IS NOT NULL AND agent_deployment_revision_id IS NOT NULL
    AND agent_id IS NOT NULL AND agent_release_id IS NOT NULL AND experience_release_id IS NOT NULL
    AND conversation_id IS NOT NULL AND conversation_contract_hash ~ '^sha256:[0-9a-f]{64}$'
    AND accepted_conversation_state_version>0 AND user_message_id IS NOT NULL
    AND flow_deployment_id IS NULL AND flow_deployment_revision_id IS NULL
    AND flow_id IS NULL AND flow_version_id IS NULL)
  OR (target_kind='flow' AND fixed_route='/v1/oapi/flow/run' AND accepted_principal_kind='credential'
    AND agent_deployment_id IS NULL AND agent_deployment_revision_id IS NULL AND agent_id IS NULL
    AND agent_release_id IS NULL AND experience_release_id IS NULL AND conversation_id IS NULL
    AND conversation_contract_hash IS NULL AND accepted_conversation_state_version IS NULL
    AND user_message_id IS NULL AND flow_deployment_id IS NOT NULL
    AND flow_deployment_revision_id IS NOT NULL AND flow_id IS NOT NULL AND flow_version_id IS NOT NULL)
);

CREATE FUNCTION app.create_child_run(p_fact jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'child Run creation is unavailable before G0-07'
    USING ERRCODE = '0A000';
END;
$function$;
ALTER FUNCTION app.create_child_run(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.create_child_run(jsonb) FROM PUBLIC;
CREATE FUNCTION app.allocate_child_run_budget(p_fact jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'child Run budget allocation is unavailable before G0-07'
    USING ERRCODE = '0A000';
END;
$function$;
ALTER FUNCTION app.allocate_child_run_budget(jsonb) OWNER TO ba_billing_owner;
REVOKE ALL ON FUNCTION app.allocate_child_run_budget(jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA app FROM ba_run_owner,ba_billing_owner;
