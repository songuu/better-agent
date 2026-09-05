DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.join_child_terminal_intents) THEN
    RAISE EXCEPTION 'join-child terminal intent facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard$;
REVOKE EXECUTE ON FUNCTION app.finalize_join_child(jsonb) FROM ba_finalizer_executor;
DROP FUNCTION app.finalize_join_child(jsonb);
REVOKE EXECUTE ON FUNCTION app.settle_join_child_allocation(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,text,bigint,uuid,uuid,timestamptz) FROM ba_run_owner;
DROP FUNCTION app.settle_join_child_allocation(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,text,bigint,uuid,uuid,timestamptz);
DROP TRIGGER run_budget_allocations_controlled_close ON public.run_budget_allocations;
DROP FUNCTION app.protect_run_budget_allocation_close();
CREATE TRIGGER run_budget_allocations_immutable BEFORE UPDATE OR DELETE
  ON public.run_budget_allocations FOR EACH ROW
  EXECUTE FUNCTION app.reject_g006_immutable_change();
REVOKE EXECUTE ON FUNCTION app.commit_join_child_terminal_intent(jsonb) FROM ba_execution_executor;
DROP FUNCTION app.commit_join_child_terminal_intent(jsonb);
DROP TRIGGER join_child_terminal_intents_immutable ON public.join_child_terminal_intents;
DROP POLICY join_child_terminal_intents_owner_access ON public.join_child_terminal_intents;
DROP TABLE public.join_child_terminal_intents;
REVOKE EXECUTE ON FUNCTION app.require_active_join_child_allocation(uuid,uuid) FROM ba_run_owner;
DROP FUNCTION app.require_active_join_child_allocation(uuid,uuid);
SET LOCAL ROLE ba_billing_owner;
REVOKE REFERENCES (workspace_id,id) ON public.run_budget_allocations FROM ba_run_owner;
RESET ROLE;
