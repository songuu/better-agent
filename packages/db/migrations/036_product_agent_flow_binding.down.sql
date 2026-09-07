DO $block$ BEGIN
 IF EXISTS(SELECT 1 FROM public.agent_product_release_flow_bindings) THEN
  RAISE EXCEPTION 'cannot roll back migration 036: immutable Agent Flow release bindings exist' USING ERRCODE='55000';
 END IF;
END $block$;
DROP FUNCTION app.read_agent_product_run_flow(uuid,uuid,uuid);
DROP FUNCTION app.update_agent_draft_with_strategy_capabilities_v6(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid);
DROP FUNCTION app.create_agent_draft_with_strategy_capabilities_v6(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid);
DROP TRIGGER agent_product_release_flow_snapshot ON public.agent_product_releases;
DROP FUNCTION app.snapshot_agent_product_release_flow();
DROP TABLE public.agent_product_release_flow_bindings;
DROP TABLE public.agent_product_flow_bindings;
