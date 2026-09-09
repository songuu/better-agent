DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM public.agent_product_async_subagent_contexts)
    OR EXISTS(SELECT 1 FROM public.agent_product_async_subagent_invocations)
    OR EXISTS(SELECT 1 FROM public.agent_product_async_subagent_events)
  THEN RAISE EXCEPTION 'cannot remove asynchronous SubAgent evidence'; END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP TRIGGER agent_product_runs_async_subagent_settlement ON public.agent_product_runs;
DROP FUNCTION app.cascade_agent_product_async_subagent_children();
DROP FUNCTION app.list_agent_product_async_subagent_events(uuid,uuid,uuid);
DROP FUNCTION app.list_agent_product_async_subagent_invocations(uuid);
DROP FUNCTION app.read_agent_product_async_subagent_run(uuid,uuid,uuid,uuid);
DROP FUNCTION app.fail_agent_product_async_subagent_job(uuid,uuid,bigint,text);
DROP FUNCTION app.complete_agent_product_async_subagent_job(uuid,uuid,bigint,bigint,bigint,text,text);
DROP FUNCTION app.record_agent_product_async_subagent_invocation(uuid,uuid,bigint,jsonb);
DROP FUNCTION app.renew_agent_product_async_subagent_job(uuid,uuid,bigint,integer);
DROP FUNCTION app.claim_agent_product_async_subagent_job(text,integer);
DROP FUNCTION app.dispatch_agent_product_async_subagent_job(uuid,uuid,uuid,uuid,bigint,text);

DROP TABLE public.agent_product_async_subagent_events;
DROP TABLE public.agent_product_async_subagent_invocations;
DROP TABLE public.agent_product_async_subagent_jobs;
DROP TABLE public.agent_product_async_subagent_runs;
DROP TABLE public.agent_product_async_subagent_contexts;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
