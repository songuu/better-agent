DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_product_run_subagent_invocations) THEN
    RAISE EXCEPTION 'cannot remove recursive SubAgent invocation evidence';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP TRIGGER agent_product_runs_subagent_receipt_guard ON public.agent_product_runs;
DROP FUNCTION app.assert_agent_product_subagent_decision_receipt();
DROP FUNCTION app.list_agent_product_run_subagent_invocations(uuid);
DROP FUNCTION app.record_agent_product_run_subagent_invocation(uuid,uuid,uuid,bigint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint);
DROP FUNCTION app.read_agent_product_run_subagent_chain(uuid,uuid,uuid);
DROP TABLE public.agent_product_run_subagent_invocations;

CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_subagent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_target uuid;v_version bigint;
BEGIN
  SELECT target_agent_id INTO v_target FROM public.agent_product_subagent_bindings
    WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
  IF v_target IS NULL THEN RETURN NEW; END IF;
  SELECT max(version) INTO v_version FROM public.agent_product_releases
    WHERE workspace_id=NEW.workspace_id AND agent_id=v_target;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'bound child Agent has no published release' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.agent_product_release_subagent_bindings(
    workspace_id,agent_id,release_version,target_agent_id,target_release_version
  ) VALUES(NEW.workspace_id,NEW.agent_id,NEW.version,v_target,v_version);
  RETURN NEW;
END;
$function$;

ALTER FUNCTION app.snapshot_agent_product_release_subagent() OWNER TO ba_authorization_owner;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
