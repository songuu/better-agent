DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.knowledge_query_receipts)
     OR EXISTS (SELECT 1 FROM public.database_operation_receipts) THEN
    RAISE EXCEPTION 'durable G1 capability receipts exist; downgrade rejected'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

REVOKE EXECUTE ON FUNCTION app.record_knowledge_query_receipt(jsonb),
  app.record_database_operation_receipt(jsonb) FROM ba_execution_executor;
DROP FUNCTION app.record_database_operation_receipt(jsonb);
DROP FUNCTION app.record_knowledge_query_receipt(jsonb);
DROP TRIGGER database_operation_receipts_immutable ON public.database_operation_receipts;
DROP TRIGGER knowledge_query_receipts_immutable ON public.knowledge_query_receipts;
DROP FUNCTION app.reject_g1_capability_receipt_change();
REVOKE EXECUTE ON FUNCTION auth.require_g1_execution_source_pin(uuid,jsonb,text,text)
FROM ba_run_owner;
DROP FUNCTION auth.require_g1_execution_source_pin(uuid,jsonb,text,text);
DROP POLICY database_operation_receipts_owner_access ON public.database_operation_receipts;
DROP POLICY knowledge_query_receipts_owner_access ON public.knowledge_query_receipts;
DROP TABLE public.database_operation_receipts;
DROP TABLE public.knowledge_query_receipts;
