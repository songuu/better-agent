-- Bounded recursive SubAgent execution: immutable release-chain validation and per-level receipts.
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_run_subagent_invocations (
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  parent_iteration bigint NOT NULL CHECK (parent_iteration BETWEEN 1 AND 4),
  depth smallint NOT NULL CHECK (depth BETWEEN 1 AND 3),
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL CHECK (release_version > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  model text NOT NULL CHECK (model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')),
  input_text text NOT NULL CHECK (length(btrim(input_text)) BETWEEN 1 AND 500),
  output_text text NOT NULL CHECK (length(btrim(output_text)) BETWEEN 1 AND 50000),
  provider_request_id text NOT NULL CHECK (length(provider_request_id) BETWEEN 1 AND 200),
  exclusive_input_tokens bigint NOT NULL CHECK (exclusive_input_tokens BETWEEN 0 AND 1000000000),
  exclusive_output_tokens bigint NOT NULL CHECK (exclusive_output_tokens BETWEEN 0 AND 1000000000),
  aggregate_input_tokens bigint NOT NULL CHECK (
    aggregate_input_tokens BETWEEN exclusive_input_tokens AND 1000000000
  ),
  aggregate_output_tokens bigint NOT NULL CHECK (
    aggregate_output_tokens BETWEEN exclusive_output_tokens AND 1000000000
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,run_id,parent_iteration,depth),
  FOREIGN KEY (workspace_id,run_id)
    REFERENCES public.agent_product_runs(workspace_id,id),
  FOREIGN KEY (workspace_id,agent_id,release_version)
    REFERENCES public.agent_product_releases(workspace_id,agent_id,version)
);

ALTER TABLE public.agent_product_run_subagent_invocations OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_run_subagent_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_run_subagent_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_product_run_subagent_invocations_owner_only
  ON public.agent_product_run_subagent_invocations
  USING (current_user='ba_authorization_owner')
  WITH CHECK (current_user='ba_authorization_owner');
REVOKE ALL ON public.agent_product_run_subagent_invocations FROM PUBLIC,ba_runtime;
CREATE TRIGGER agent_product_run_subagent_invocations_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_run_subagent_invocations
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_subagent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_target uuid;
  v_version bigint;
  v_current_agent uuid;
  v_current_release bigint;
  v_next_agent uuid;
  v_next_release bigint;
  v_current_strategy jsonb;
  v_seen uuid[] := ARRAY[NEW.agent_id];
  v_depth integer := 1;
BEGIN
  SELECT target_agent_id INTO v_target
  FROM public.agent_product_subagent_bindings
  WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
  IF v_target IS NULL THEN RETURN NEW; END IF;

  SELECT max(version) INTO v_version
  FROM public.agent_product_releases
  WHERE workspace_id=NEW.workspace_id AND agent_id=v_target;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'bound child Agent has no published release' USING ERRCODE='22023';
  END IF;

  v_current_agent:=v_target;
  v_current_release:=v_version;
  LOOP
    IF v_current_agent=ANY(v_seen) THEN
      RAISE EXCEPTION 'recursive SubAgent release chain contains a cycle' USING ERRCODE='22023';
    END IF;
    v_seen:=array_append(v_seen,v_current_agent);
    SELECT release.strategy_profile INTO v_current_strategy
    FROM public.agent_product_releases AS release
    WHERE release.workspace_id=NEW.workspace_id AND release.agent_id=v_current_agent
      AND release.version=v_current_release;
    IF NOT FOUND OR v_current_strategy->>'schema_version'<>'product-agent-strategy/5' THEN
      EXIT;
    END IF;
    SELECT binding.target_agent_id,binding.target_release_version
      INTO v_next_agent,v_next_release
    FROM public.agent_product_release_subagent_bindings AS binding
    WHERE binding.workspace_id=NEW.workspace_id
      AND binding.agent_id=v_current_agent
      AND binding.release_version=v_current_release;
    IF NOT FOUND THEN EXIT; END IF;
    IF v_depth>=3 THEN
      RAISE EXCEPTION 'recursive SubAgent release chain exceeds depth 3' USING ERRCODE='22023';
    END IF;
    v_current_agent:=v_next_agent;
    v_current_release:=v_next_release;
    v_depth:=v_depth+1;
  END LOOP;

  INSERT INTO public.agent_product_release_subagent_bindings(
    workspace_id,agent_id,release_version,target_agent_id,target_release_version
  ) VALUES(NEW.workspace_id,NEW.agent_id,NEW.version,v_target,v_version);
  RETURN NEW;
END;
$function$;

CREATE FUNCTION app.read_agent_product_run_subagent_chain(
  p_workspace_id uuid,p_run_id uuid,p_actor_id uuid
) RETURNS TABLE(
  depth smallint,agent_id uuid,release_version bigint,name text,instructions text,
  model text,strategy_profile jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_root_agent uuid;
  v_root_release bigint;
  v_invalid boolean;
BEGIN
  SELECT conversation.agent_id,conversation.release_version
    INTO v_root_agent,v_root_release
  FROM public.agent_product_runs AS run
  JOIN public.agent_product_conversations AS conversation
    ON conversation.workspace_id=run.workspace_id AND conversation.id=run.conversation_id
  JOIN public.agent_product_releases AS release
    ON release.workspace_id=conversation.workspace_id AND release.agent_id=conversation.agent_id
   AND release.version=conversation.release_version
  WHERE run.workspace_id=p_workspace_id AND run.id=p_run_id AND run.status='pending'
    AND conversation.actor_id=p_actor_id
    AND release.strategy_profile->>'schema_version'='product-agent-strategy/5';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recursive SubAgent Run is unavailable' USING ERRCODE='P0002';
  END IF;

  WITH RECURSIVE chain AS (
    SELECT 1 AS depth,binding.target_agent_id AS agent_id,
      binding.target_release_version AS release_version,
      ARRAY[v_root_agent,binding.target_agent_id]::uuid[] AS path,
      binding.target_agent_id=v_root_agent AS cycle
    FROM public.agent_product_release_subagent_bindings AS binding
    WHERE binding.workspace_id=p_workspace_id AND binding.agent_id=v_root_agent
      AND binding.release_version=v_root_release
    UNION ALL
    SELECT chain.depth+1,binding.target_agent_id,binding.target_release_version,
      chain.path||binding.target_agent_id,binding.target_agent_id=ANY(chain.path)
    FROM chain
    JOIN public.agent_product_releases AS current_release
      ON current_release.workspace_id=p_workspace_id AND current_release.agent_id=chain.agent_id
     AND current_release.version=chain.release_version
    JOIN public.agent_product_release_subagent_bindings AS binding
      ON binding.workspace_id=p_workspace_id AND binding.agent_id=chain.agent_id
     AND binding.release_version=chain.release_version
    WHERE chain.depth<4 AND NOT chain.cycle
      AND current_release.strategy_profile->>'schema_version'='product-agent-strategy/5'
  )
  SELECT EXISTS(SELECT 1 FROM chain WHERE chain.cycle OR chain.depth>3) INTO v_invalid;
  IF v_invalid THEN
    RAISE EXCEPTION 'recursive SubAgent release chain is cyclic or exceeds depth 3'
      USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  WITH RECURSIVE chain AS (
    SELECT 1 AS depth,binding.target_agent_id AS agent_id,
      binding.target_release_version AS release_version
    FROM public.agent_product_release_subagent_bindings AS binding
    WHERE binding.workspace_id=p_workspace_id AND binding.agent_id=v_root_agent
      AND binding.release_version=v_root_release
    UNION ALL
    SELECT chain.depth+1,binding.target_agent_id,binding.target_release_version
    FROM chain
    JOIN public.agent_product_releases AS current_release
      ON current_release.workspace_id=p_workspace_id AND current_release.agent_id=chain.agent_id
     AND current_release.version=chain.release_version
    JOIN public.agent_product_release_subagent_bindings AS binding
      ON binding.workspace_id=p_workspace_id AND binding.agent_id=chain.agent_id
     AND binding.release_version=chain.release_version
    WHERE chain.depth<3
      AND current_release.strategy_profile->>'schema_version'='product-agent-strategy/5'
  )
  SELECT chain.depth::smallint,release.agent_id,release.version,release.name,
    release.instructions,release.model,release.strategy_profile
  FROM chain
  JOIN public.agent_product_releases AS release
    ON release.workspace_id=p_workspace_id AND release.agent_id=chain.agent_id
   AND release.version=chain.release_version
  ORDER BY chain.depth;
END;
$function$;

CREATE FUNCTION app.record_agent_product_run_subagent_invocation(
  p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,p_parent_iteration bigint,p_depth smallint,
  p_agent_id uuid,p_release_version bigint,p_name text,p_model text,p_input_text text,p_output_text text,
  p_provider_request_id text,p_exclusive_input_tokens bigint,p_exclusive_output_tokens bigint,
  p_aggregate_input_tokens bigint,p_aggregate_output_tokens bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_run public.agent_product_runs;
  v_node record;
BEGIN
  SELECT run.* INTO v_run
  FROM public.agent_product_runs AS run
  JOIN public.agent_product_conversations AS conversation
    ON conversation.workspace_id=run.workspace_id AND conversation.id=run.conversation_id
  WHERE run.workspace_id=p_workspace_id AND run.id=p_run_id AND run.status='pending'
    AND conversation.actor_id=p_actor_id
  FOR UPDATE OF run;
  IF NOT FOUND OR p_parent_iteration<>jsonb_array_length(v_run.iteration_trace)+1 THEN
    RAISE EXCEPTION 'recursive SubAgent invocation Run or iteration conflict' USING ERRCODE='40001';
  END IF;

  SELECT chain.* INTO v_node
  FROM app.read_agent_product_run_subagent_chain(p_workspace_id,p_run_id,p_actor_id) AS chain
  WHERE chain.depth=p_depth;
  IF NOT FOUND OR v_node.agent_id<>p_agent_id OR v_node.release_version<>p_release_version
    OR v_node.name IS DISTINCT FROM p_name OR v_node.model IS DISTINCT FROM p_model
    OR p_input_text IS NULL OR length(btrim(p_input_text)) NOT BETWEEN 1 AND 500
    OR p_output_text IS NULL OR length(btrim(p_output_text)) NOT BETWEEN 1 AND 50000
    OR p_provider_request_id IS NULL OR length(p_provider_request_id) NOT BETWEEN 1 AND 200
    OR p_exclusive_input_tokens NOT BETWEEN 0 AND 1000000000
    OR p_exclusive_output_tokens NOT BETWEEN 0 AND 1000000000
    OR p_aggregate_input_tokens NOT BETWEEN p_exclusive_input_tokens AND 1000000000
    OR p_aggregate_output_tokens NOT BETWEEN p_exclusive_output_tokens AND 1000000000
  THEN
    RAISE EXCEPTION 'recursive SubAgent invocation evidence is invalid' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.agent_product_run_subagent_invocations(
    workspace_id,run_id,parent_iteration,depth,agent_id,release_version,name,model,
    input_text,output_text,provider_request_id,exclusive_input_tokens,exclusive_output_tokens,
    aggregate_input_tokens,aggregate_output_tokens
  ) VALUES(
    p_workspace_id,p_run_id,p_parent_iteration,p_depth,p_agent_id,p_release_version,btrim(p_name),p_model,
    btrim(p_input_text),btrim(p_output_text),p_provider_request_id,p_exclusive_input_tokens,
    p_exclusive_output_tokens,p_aggregate_input_tokens,p_aggregate_output_tokens
  );
END;
$function$;

CREATE FUNCTION app.assert_agent_product_subagent_decision_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_item jsonb;
BEGIN
  IF jsonb_array_length(NEW.iteration_trace)=jsonb_array_length(OLD.iteration_trace)+1 THEN
    v_item:=NEW.iteration_trace->(jsonb_array_length(NEW.iteration_trace)-1);
    IF v_item->>'action'='tool' AND v_item->>'capability'='subagent' AND NOT EXISTS(
      SELECT 1 FROM public.agent_product_run_subagent_invocations AS invocation
      WHERE invocation.workspace_id=NEW.workspace_id AND invocation.run_id=NEW.id
        AND invocation.parent_iteration=(v_item->>'iteration')::bigint AND invocation.depth=1
        AND invocation.agent_id=(v_item->>'target_agent_id')::uuid
        AND invocation.release_version=(v_item->>'target_release_version')::bigint
        AND invocation.provider_request_id=v_item->>'tool_provider_request_id'
        AND invocation.aggregate_input_tokens=(v_item->>'tool_input_tokens')::bigint
        AND invocation.aggregate_output_tokens=(v_item->>'tool_output_tokens')::bigint
    ) THEN
      RAISE EXCEPTION 'SubAgent decision is missing its immutable invocation receipt'
        USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER agent_product_runs_subagent_receipt_guard
BEFORE UPDATE OF iteration_trace ON public.agent_product_runs
FOR EACH ROW EXECUTE FUNCTION app.assert_agent_product_subagent_decision_receipt();

CREATE FUNCTION app.list_agent_product_run_subagent_invocations(p_workspace_id uuid)
RETURNS TABLE(
  run_id uuid,parent_iteration bigint,depth smallint,agent_id uuid,release_version bigint,
  name text,model text,input_text text,output_text text,provider_request_id text,
  exclusive_input_tokens bigint,exclusive_output_tokens bigint,
  aggregate_input_tokens bigint,aggregate_output_tokens bigint,created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $function$
  SELECT invocation.run_id,invocation.parent_iteration,invocation.depth,invocation.agent_id,
    invocation.release_version,invocation.name,invocation.model,invocation.input_text,
    invocation.output_text,invocation.provider_request_id,invocation.exclusive_input_tokens,
    invocation.exclusive_output_tokens,invocation.aggregate_input_tokens,
    invocation.aggregate_output_tokens,invocation.created_at
  FROM public.agent_product_run_subagent_invocations AS invocation
  WHERE invocation.workspace_id=p_workspace_id
  ORDER BY invocation.created_at DESC,invocation.run_id,invocation.parent_iteration,invocation.depth
  LIMIT 600;
$function$;

ALTER FUNCTION app.snapshot_agent_product_release_subagent() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_run_subagent_chain(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_agent_product_run_subagent_invocation(uuid,uuid,uuid,bigint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_agent_product_subagent_decision_receipt() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_product_run_subagent_invocations(uuid) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.read_agent_product_run_subagent_chain(uuid,uuid,uuid),
  app.record_agent_product_run_subagent_invocation(uuid,uuid,uuid,bigint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint),
  app.list_agent_product_run_subagent_invocations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_agent_product_run_subagent_chain(uuid,uuid,uuid),
  app.record_agent_product_run_subagent_invocation(uuid,uuid,uuid,bigint,smallint,uuid,bigint,text,text,text,text,text,bigint,bigint,bigint,bigint),
  app.list_agent_product_run_subagent_invocations(uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
