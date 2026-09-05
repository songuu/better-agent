DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.join_child_settlement_receipts) THEN
    RAISE EXCEPTION 'join-child settlement facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard$;
REVOKE EXECUTE ON FUNCTION app.settle_join_child(jsonb) FROM ba_finalizer_executor;
DROP FUNCTION app.settle_join_child(jsonb);
REVOKE EXECUTE ON FUNCTION app.require_closed_join_allocation(uuid,uuid) FROM ba_run_owner;
DROP FUNCTION app.require_closed_join_allocation(uuid,uuid);
DROP TRIGGER join_child_settlement_receipts_immutable ON public.join_child_settlement_receipts;
DROP POLICY join_child_settlement_receipts_owner_access ON public.join_child_settlement_receipts;
DROP TABLE public.join_child_settlement_receipts;
REVOKE CREATE ON SCHEMA public FROM ba_run_owner;
