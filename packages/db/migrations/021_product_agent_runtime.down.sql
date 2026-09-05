DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_product_conversations LIMIT 1) THEN
    RAISE EXCEPTION 'cannot remove product Agent runtime with retained conversations'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

DROP FUNCTION app.list_agent_product_runs(uuid);
DROP FUNCTION app.fail_agent_product_run(uuid, uuid, uuid, text);
DROP FUNCTION app.complete_agent_product_run(uuid, uuid, uuid, text, text, bigint, bigint);
DROP FUNCTION app.begin_agent_product_run(uuid, uuid, uuid, text);
DROP FUNCTION app.create_agent_product_conversation(uuid, uuid, uuid);
DROP TABLE public.agent_product_runs;
DROP TABLE public.agent_product_conversations;
