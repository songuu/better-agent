-- Asynchronous product SubAgent child Runs with immutable context, leased jobs and exact receipts.
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_async_subagent_contexts (
  workspace_id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  parent_call_id uuid NOT NULL,
  parent_iteration bigint NOT NULL CHECK (parent_iteration BETWEEN 1 AND 4),
  actor_id uuid NOT NULL,
  prompt text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 500),
  chains jsonb NOT NULL CHECK (jsonb_typeof(chains)='array' AND jsonb_array_length(chains) BETWEEN 1 AND 3),
  join_policy text NOT NULL DEFAULT 'join' CHECK (join_policy='join'),
  cascade_policy text NOT NULL DEFAULT 'cascade' CHECK (cascade_policy='cascade'),
  context_policy text NOT NULL DEFAULT 'safe_summary' CHECK (context_policy='safe_summary'),
  settlement_policy text NOT NULL DEFAULT 'wait_for_settlement' CHECK (settlement_policy='wait_for_settlement'),
  outcome_map text NOT NULL DEFAULT 'G1JoinChildTerminalOutcomeMapV1'
    CHECK (outcome_map='G1JoinChildTerminalOutcomeMapV1'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,child_run_id),
  UNIQUE (workspace_id,parent_run_id,parent_call_id),
  FOREIGN KEY (workspace_id,parent_run_id) REFERENCES public.agent_product_runs(workspace_id,id)
);

CREATE TABLE public.agent_product_async_subagent_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  parent_call_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','completed','failed')),
  output_text text CHECK (output_text IS NULL OR length(btrim(output_text)) BETWEEN 1 AND 50000),
  provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 200),
  aggregate_input_tokens bigint NOT NULL DEFAULT 0 CHECK (aggregate_input_tokens BETWEEN 0 AND 1000000000),
  aggregate_output_tokens bigint NOT NULL DEFAULT 0 CHECK (aggregate_output_tokens BETWEEN 0 AND 1000000000),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (id),
  UNIQUE (workspace_id,parent_run_id,parent_call_id),
  FOREIGN KEY (workspace_id,id) REFERENCES public.agent_product_async_subagent_contexts(workspace_id,child_run_id),
  CHECK (
    (status='queued' AND output_text IS NULL AND error_code IS NULL AND started_at IS NULL AND completed_at IS NULL)
    OR (status='leased' AND output_text IS NULL AND error_code IS NULL AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status='completed' AND output_text IS NOT NULL AND provider_request_id IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL)
    OR (status='failed' AND output_text IS NULL AND provider_request_id IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE public.agent_product_async_subagent_jobs (
  workspace_id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','completed','failed')),
  worker_id text CHECK (worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 200),
  lease_token uuid,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation>=0),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id,child_run_id),
  UNIQUE (child_run_id),
  FOREIGN KEY (workspace_id,child_run_id) REFERENCES public.agent_product_async_subagent_runs(workspace_id,id),
  CHECK (
    (status='queued' AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (status='leased' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('completed','failed') AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status='failed' AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX agent_product_async_subagent_jobs_claim_idx
  ON public.agent_product_async_subagent_jobs(status,created_at,child_run_id);

CREATE TABLE public.agent_product_async_subagent_invocations (
  workspace_id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  branch smallint NOT NULL CHECK (branch BETWEEN 1 AND 3),
  depth smallint NOT NULL CHECK (depth BETWEEN 1 AND 3),
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL CHECK (release_version>0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  model text NOT NULL CHECK (model IN ('gpt-5.4-mini','gpt-5.5','gpt-5.6-sol')),
  input_text text NOT NULL CHECK (length(btrim(input_text)) BETWEEN 1 AND 500),
  output_text text NOT NULL CHECK (length(btrim(output_text)) BETWEEN 1 AND 50000),
  provider_request_id text NOT NULL CHECK (length(provider_request_id) BETWEEN 1 AND 200),
  exclusive_input_tokens bigint NOT NULL CHECK (exclusive_input_tokens BETWEEN 0 AND 1000000000),
  exclusive_output_tokens bigint NOT NULL CHECK (exclusive_output_tokens BETWEEN 0 AND 1000000000),
  aggregate_input_tokens bigint NOT NULL CHECK (aggregate_input_tokens BETWEEN exclusive_input_tokens AND 1000000000),
  aggregate_output_tokens bigint NOT NULL CHECK (aggregate_output_tokens BETWEEN exclusive_output_tokens AND 1000000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,child_run_id,branch,depth),
  FOREIGN KEY (workspace_id,child_run_id) REFERENCES public.agent_product_async_subagent_runs(workspace_id,id),
  FOREIGN KEY (workspace_id,agent_id,release_version) REFERENCES public.agent_product_releases(workspace_id,agent_id,version)
);

CREATE TABLE public.agent_product_async_subagent_events (
  workspace_id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  kind text NOT NULL CHECK (kind IN ('queued','started','completed','failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,child_run_id,sequence),
  FOREIGN KEY (workspace_id,child_run_id) REFERENCES public.agent_product_async_subagent_runs(workspace_id,id),
  FOREIGN KEY (workspace_id,parent_run_id) REFERENCES public.agent_product_runs(workspace_id,id)
);

ALTER TABLE public.agent_product_async_subagent_contexts OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_async_subagent_runs OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_async_subagent_jobs OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_async_subagent_invocations OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_async_subagent_events OWNER TO ba_authorization_owner;
ALTER INDEX public.agent_product_async_subagent_jobs_claim_idx OWNER TO ba_authorization_owner;

ALTER TABLE public.agent_product_async_subagent_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_contexts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_invocations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_async_subagent_events FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_product_async_subagent_contexts_owner_only ON public.agent_product_async_subagent_contexts
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY agent_product_async_subagent_runs_owner_only ON public.agent_product_async_subagent_runs
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY agent_product_async_subagent_jobs_owner_only ON public.agent_product_async_subagent_jobs
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY agent_product_async_subagent_invocations_owner_only ON public.agent_product_async_subagent_invocations
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');
CREATE POLICY agent_product_async_subagent_events_owner_only ON public.agent_product_async_subagent_events
  USING (current_user='ba_authorization_owner') WITH CHECK (current_user='ba_authorization_owner');

REVOKE ALL ON public.agent_product_async_subagent_contexts,
  public.agent_product_async_subagent_runs,
  public.agent_product_async_subagent_jobs,
  public.agent_product_async_subagent_invocations,
  public.agent_product_async_subagent_events FROM PUBLIC,ba_runtime,ba_execution_executor;

CREATE TRIGGER agent_product_async_subagent_contexts_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_async_subagent_contexts
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();
CREATE TRIGGER agent_product_async_subagent_invocations_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_async_subagent_invocations
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();
CREATE TRIGGER agent_product_async_subagent_events_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_async_subagent_events
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE FUNCTION app.dispatch_agent_product_async_subagent_job(
  p_workspace_id uuid,p_parent_run_id uuid,p_actor_id uuid,p_parent_call_id uuid,
  p_parent_iteration bigint,p_prompt text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_run public.agent_product_runs;
  v_existing public.agent_product_async_subagent_contexts;
  v_child_run_id uuid:=gen_random_uuid();
  v_chains jsonb;
BEGIN
  IF p_parent_call_id IS NULL OR p_prompt IS NULL OR length(btrim(p_prompt)) NOT BETWEEN 1 AND 500
    OR p_parent_iteration NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'async SubAgent dispatch input is invalid' USING ERRCODE='22023';
  END IF;
  SELECT run.* INTO v_run
  FROM public.agent_product_runs AS run
  JOIN public.agent_product_conversations AS conversation
    ON conversation.workspace_id=run.workspace_id AND conversation.id=run.conversation_id
  WHERE run.workspace_id=p_workspace_id AND run.id=p_parent_run_id AND run.status='pending'
    AND conversation.actor_id=p_actor_id
  FOR UPDATE OF run;
  IF NOT FOUND OR p_parent_iteration<>jsonb_array_length(v_run.iteration_trace)+1 THEN
    RAISE EXCEPTION 'async SubAgent parent Run or iteration conflict' USING ERRCODE='40001';
  END IF;
  SELECT context.* INTO v_existing
  FROM public.agent_product_async_subagent_contexts AS context
  WHERE context.workspace_id=p_workspace_id AND context.parent_run_id=p_parent_run_id
    AND context.parent_call_id=p_parent_call_id;
  IF FOUND THEN
    IF v_existing.actor_id=p_actor_id AND v_existing.parent_iteration=p_parent_iteration
      AND v_existing.prompt=btrim(p_prompt) THEN RETURN v_existing.child_run_id; END IF;
    RAISE EXCEPTION 'async SubAgent dispatch intent conflict' USING ERRCODE='40001';
  END IF;
  SELECT jsonb_agg(branch.nodes ORDER BY branch.branch) INTO v_chains
  FROM (
    SELECT chain.branch,jsonb_agg(jsonb_build_object(
      'agentId',chain.agent_id,'branch',chain.branch,'depth',chain.depth,
      'instructions',chain.instructions,'maxOutputTokens',(chain.strategy_profile->>'max_output_tokens')::bigint,
      'model',chain.model,'name',chain.name,'releaseVersion',chain.release_version,
      'strategyProfile',jsonb_build_object(
        'forcedCapability',chain.strategy_profile->>'forced_capability',
        'maxInputTokens',(chain.strategy_profile->>'max_input_tokens')::bigint,
        'maxIterations',(chain.strategy_profile->>'max_iterations')::integer,
        'maxOutputTokens',(chain.strategy_profile->>'max_output_tokens')::bigint,
        'maxToolCalls',(chain.strategy_profile->>'max_tool_calls')::integer,
        'schemaVersion',chain.strategy_profile->>'schema_version',
        'temperature',(chain.strategy_profile->>'temperature')::numeric),
      'temperature',(chain.strategy_profile->>'temperature')::numeric
    ) ORDER BY chain.depth) AS nodes
    FROM app.read_agent_product_run_subagent_chains(p_workspace_id,p_parent_run_id,p_actor_id) AS chain
    GROUP BY chain.branch
  ) AS branch;
  IF v_chains IS NULL OR jsonb_array_length(v_chains) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'async SubAgent released chain is unavailable' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.agent_product_async_subagent_contexts(
    workspace_id,child_run_id,parent_run_id,parent_call_id,parent_iteration,actor_id,prompt,chains
  ) VALUES(p_workspace_id,v_child_run_id,p_parent_run_id,p_parent_call_id,p_parent_iteration,p_actor_id,btrim(p_prompt),v_chains);
  INSERT INTO public.agent_product_async_subagent_runs(workspace_id,id,parent_run_id,parent_call_id)
    VALUES(p_workspace_id,v_child_run_id,p_parent_run_id,p_parent_call_id);
  INSERT INTO public.agent_product_async_subagent_jobs(workspace_id,child_run_id)
    VALUES(p_workspace_id,v_child_run_id);
  INSERT INTO public.agent_product_async_subagent_events(workspace_id,child_run_id,parent_run_id,sequence,kind,payload)
    VALUES(p_workspace_id,v_child_run_id,p_parent_run_id,1,'queued',jsonb_build_object('parentCallId',p_parent_call_id));
  RETURN v_child_run_id;
END;
$function$;

CREATE FUNCTION app.claim_agent_product_async_subagent_job(p_worker_id text,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_expired record;
  v_job public.agent_product_async_subagent_jobs;
  v_context public.agent_product_async_subagent_contexts;
  v_token uuid:=gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 200
    OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'async SubAgent worker lease input is invalid' USING ERRCODE='22023';
  END IF;
  FOR v_expired IN
    SELECT job.workspace_id,job.child_run_id
    FROM public.agent_product_async_subagent_jobs AS job
    WHERE job.status='leased' AND job.lease_expires_at<=v_now
    ORDER BY job.created_at,job.child_run_id FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.agent_product_async_subagent_jobs SET status='failed',completed_at=v_now
      WHERE workspace_id=v_expired.workspace_id AND child_run_id=v_expired.child_run_id;
    UPDATE public.agent_product_async_subagent_runs SET status='failed',error_code='async_subagent_worker_lost',completed_at=v_now
      WHERE workspace_id=v_expired.workspace_id AND id=v_expired.child_run_id AND status='leased';
    INSERT INTO public.agent_product_async_subagent_events(workspace_id,child_run_id,parent_run_id,sequence,kind,payload)
      SELECT run.workspace_id,run.id,run.parent_run_id,3,'failed',jsonb_build_object('errorCode','async_subagent_worker_lost')
      FROM public.agent_product_async_subagent_runs AS run
      WHERE run.workspace_id=v_expired.workspace_id AND run.id=v_expired.child_run_id
      ON CONFLICT DO NOTHING;
  END LOOP;
  SELECT job.* INTO v_job FROM public.agent_product_async_subagent_jobs AS job
  WHERE job.status='queued' ORDER BY job.created_at,job.child_run_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.agent_product_async_subagent_jobs SET status='leased',worker_id=btrim(p_worker_id),
    lease_token=v_token,lease_generation=lease_generation+1,
    lease_expires_at=v_now+make_interval(secs=>p_lease_seconds)
  WHERE workspace_id=v_job.workspace_id AND child_run_id=v_job.child_run_id
  RETURNING * INTO v_job;
  UPDATE public.agent_product_async_subagent_runs SET status='leased',started_at=v_now
    WHERE workspace_id=v_job.workspace_id AND id=v_job.child_run_id;
  INSERT INTO public.agent_product_async_subagent_events(workspace_id,child_run_id,parent_run_id,sequence,kind,payload)
    SELECT run.workspace_id,run.id,run.parent_run_id,2,'started',jsonb_build_object('leaseGeneration',v_job.lease_generation)
    FROM public.agent_product_async_subagent_runs AS run
    WHERE run.workspace_id=v_job.workspace_id AND run.id=v_job.child_run_id;
  SELECT context.* INTO STRICT v_context FROM public.agent_product_async_subagent_contexts AS context
    WHERE context.workspace_id=v_job.workspace_id AND context.child_run_id=v_job.child_run_id;
  RETURN jsonb_build_object('childRunId',v_job.child_run_id,'leaseGeneration',v_job.lease_generation,
    'leaseToken',v_job.lease_token,'parentIteration',v_context.parent_iteration,
    'prompt',v_context.prompt,'chains',v_context.chains);
END;
$function$;

CREATE FUNCTION app.record_agent_product_async_subagent_invocation(
  p_child_run_id uuid,p_lease_token uuid,p_lease_generation bigint,p_invocation jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_job public.agent_product_async_subagent_jobs;
  v_context public.agent_product_async_subagent_contexts;
  v_node jsonb;
  v_existing public.agent_product_async_subagent_invocations;
  v_branch smallint;v_depth smallint;
BEGIN
  SELECT job.* INTO v_job FROM public.agent_product_async_subagent_jobs AS job
    WHERE job.child_run_id=p_child_run_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'leased' OR v_job.lease_token<>p_lease_token
    OR v_job.lease_generation<>p_lease_generation OR v_job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'async SubAgent lease conflict' USING ERRCODE='40001';
  END IF;
  IF p_invocation IS NULL OR jsonb_typeof(p_invocation)<>'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_invocation))<>14 THEN
    RAISE EXCEPTION 'async SubAgent invocation is invalid' USING ERRCODE='22023';
  END IF;
  v_branch:=(p_invocation->>'branch')::smallint;v_depth:=(p_invocation->>'depth')::smallint;
  SELECT context.* INTO STRICT v_context FROM public.agent_product_async_subagent_contexts AS context
    WHERE context.workspace_id=v_job.workspace_id AND context.child_run_id=p_child_run_id;
  SELECT node INTO v_node FROM jsonb_array_elements(v_context.chains) AS branch(nodes)
    CROSS JOIN LATERAL jsonb_array_elements(branch.nodes) AS item(node)
    WHERE (node->>'branch')::smallint=v_branch AND (node->>'depth')::smallint=v_depth;
  IF v_node IS NULL OR (p_invocation->>'parentIteration')::bigint<>v_context.parent_iteration
    OR p_invocation->>'agentId'<>v_node->>'agentId'
    OR (p_invocation->>'releaseVersion')::bigint<>(v_node->>'releaseVersion')::bigint
    OR p_invocation->>'name'<>v_node->>'name' OR p_invocation->>'model'<>v_node->>'model'
    OR (v_depth=1 AND btrim(p_invocation->>'inputText')<>v_context.prompt)
    OR length(btrim(p_invocation->>'inputText')) NOT BETWEEN 1 AND 500
    OR length(btrim(p_invocation->>'outputText')) NOT BETWEEN 1 AND 50000
    OR length(p_invocation->>'providerRequestId') NOT BETWEEN 1 AND 200
    OR (p_invocation->>'exclusiveInputTokens')::bigint NOT BETWEEN 0 AND 1000000000
    OR (p_invocation->>'exclusiveOutputTokens')::bigint NOT BETWEEN 0 AND 1000000000
    OR (p_invocation->>'aggregateInputTokens')::bigint NOT BETWEEN (p_invocation->>'exclusiveInputTokens')::bigint AND 1000000000
    OR (p_invocation->>'aggregateOutputTokens')::bigint NOT BETWEEN (p_invocation->>'exclusiveOutputTokens')::bigint AND 1000000000 THEN
    RAISE EXCEPTION 'async SubAgent invocation is invalid' USING ERRCODE='22023';
  END IF;
  SELECT invocation.* INTO v_existing FROM public.agent_product_async_subagent_invocations AS invocation
    WHERE invocation.workspace_id=v_job.workspace_id AND invocation.child_run_id=p_child_run_id
      AND invocation.branch=v_branch AND invocation.depth=v_depth;
  IF FOUND THEN
    IF v_existing.agent_id=(p_invocation->>'agentId')::uuid
      AND v_existing.release_version=(p_invocation->>'releaseVersion')::bigint
      AND v_existing.input_text=btrim(p_invocation->>'inputText')
      AND v_existing.output_text=btrim(p_invocation->>'outputText')
      AND v_existing.provider_request_id=p_invocation->>'providerRequestId'
      AND v_existing.exclusive_input_tokens=(p_invocation->>'exclusiveInputTokens')::bigint
      AND v_existing.exclusive_output_tokens=(p_invocation->>'exclusiveOutputTokens')::bigint
      AND v_existing.aggregate_input_tokens=(p_invocation->>'aggregateInputTokens')::bigint
      AND v_existing.aggregate_output_tokens=(p_invocation->>'aggregateOutputTokens')::bigint THEN RETURN; END IF;
    RAISE EXCEPTION 'async SubAgent invocation replay conflict' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.agent_product_async_subagent_invocations(
    workspace_id,child_run_id,branch,depth,agent_id,release_version,name,model,input_text,output_text,
    provider_request_id,exclusive_input_tokens,exclusive_output_tokens,aggregate_input_tokens,aggregate_output_tokens
  ) VALUES(v_job.workspace_id,p_child_run_id,v_branch,v_depth,(p_invocation->>'agentId')::uuid,
    (p_invocation->>'releaseVersion')::bigint,btrim(p_invocation->>'name'),p_invocation->>'model',
    btrim(p_invocation->>'inputText'),btrim(p_invocation->>'outputText'),p_invocation->>'providerRequestId',
    (p_invocation->>'exclusiveInputTokens')::bigint,(p_invocation->>'exclusiveOutputTokens')::bigint,
    (p_invocation->>'aggregateInputTokens')::bigint,(p_invocation->>'aggregateOutputTokens')::bigint);
END;
$function$;

CREATE FUNCTION app.complete_agent_product_async_subagent_job(
  p_child_run_id uuid,p_lease_token uuid,p_lease_generation bigint,
  p_aggregate_input_tokens bigint,p_aggregate_output_tokens bigint,p_output_text text,p_provider_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE
  v_job public.agent_product_async_subagent_jobs;v_run public.agent_product_async_subagent_runs;
  v_context public.agent_product_async_subagent_contexts;v_expected bigint;v_actual bigint;v_input bigint;v_output bigint;
BEGIN
  SELECT run.* INTO v_run FROM public.agent_product_async_subagent_runs AS run WHERE run.id=p_child_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'async SubAgent terminal conflict' USING ERRCODE='40001'; END IF;
  SELECT job.* INTO STRICT v_job FROM public.agent_product_async_subagent_jobs AS job
    WHERE job.workspace_id=v_run.workspace_id AND job.child_run_id=p_child_run_id FOR UPDATE;
  IF v_job.lease_token<>p_lease_token OR v_job.lease_generation<>p_lease_generation THEN
    RAISE EXCEPTION 'async SubAgent lease conflict' USING ERRCODE='40001';
  END IF;
  IF v_run.status='completed' THEN
    IF v_run.aggregate_input_tokens=p_aggregate_input_tokens AND v_run.aggregate_output_tokens=p_aggregate_output_tokens
      AND v_run.output_text=btrim(p_output_text) AND v_run.provider_request_id=p_provider_request_id THEN RETURN; END IF;
    RAISE EXCEPTION 'async SubAgent terminal conflict' USING ERRCODE='40001';
  ELSIF v_run.status='failed' THEN RAISE EXCEPTION 'async SubAgent terminal conflict' USING ERRCODE='40001'; END IF;
  IF v_job.status<>'leased' OR v_job.lease_token<>p_lease_token OR v_job.lease_generation<>p_lease_generation
    OR v_job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'async SubAgent lease conflict' USING ERRCODE='40001';
  END IF;
  IF p_aggregate_input_tokens NOT BETWEEN 0 AND 1000000000 OR p_aggregate_output_tokens NOT BETWEEN 0 AND 1000000000
    OR p_output_text IS NULL OR length(btrim(p_output_text)) NOT BETWEEN 1 AND 50000
    OR p_provider_request_id IS NULL OR length(p_provider_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'async SubAgent terminal evidence is invalid' USING ERRCODE='22023';
  END IF;
  SELECT context.* INTO STRICT v_context FROM public.agent_product_async_subagent_contexts AS context
    WHERE context.workspace_id=v_run.workspace_id AND context.child_run_id=p_child_run_id;
  SELECT sum(jsonb_array_length(branch.nodes)) INTO v_expected FROM jsonb_array_elements(v_context.chains) AS branch(nodes);
  SELECT count(*),coalesce(sum(invocation.aggregate_input_tokens) FILTER (WHERE invocation.depth=1),0),
    coalesce(sum(invocation.aggregate_output_tokens) FILTER (WHERE invocation.depth=1),0)
    INTO v_actual,v_input,v_output
  FROM public.agent_product_async_subagent_invocations AS invocation
  WHERE invocation.workspace_id=v_run.workspace_id AND invocation.child_run_id=p_child_run_id;
  IF v_actual<>v_expected OR v_input<>p_aggregate_input_tokens OR v_output<>p_aggregate_output_tokens
    OR NOT EXISTS(SELECT 1 FROM public.agent_product_async_subagent_invocations AS invocation
      WHERE invocation.workspace_id=v_run.workspace_id AND invocation.child_run_id=p_child_run_id
        AND invocation.branch=1 AND invocation.depth=1 AND invocation.provider_request_id=p_provider_request_id) THEN
    RAISE EXCEPTION 'async SubAgent terminal receipts are incomplete' USING ERRCODE='40001';
  END IF;
  UPDATE public.agent_product_async_subagent_runs SET status='completed',output_text=btrim(p_output_text),
    provider_request_id=p_provider_request_id,aggregate_input_tokens=p_aggregate_input_tokens,
    aggregate_output_tokens=p_aggregate_output_tokens,completed_at=clock_timestamp()
    WHERE workspace_id=v_run.workspace_id AND id=p_child_run_id;
  UPDATE public.agent_product_async_subagent_jobs SET status='completed',completed_at=clock_timestamp()
    WHERE workspace_id=v_run.workspace_id AND child_run_id=p_child_run_id;
  INSERT INTO public.agent_product_async_subagent_events(workspace_id,child_run_id,parent_run_id,sequence,kind,payload)
    VALUES(v_run.workspace_id,p_child_run_id,v_run.parent_run_id,3,'completed',
      jsonb_build_object('aggregateInputTokens',p_aggregate_input_tokens,'aggregateOutputTokens',p_aggregate_output_tokens));
END;
$function$;

CREATE FUNCTION app.fail_agent_product_async_subagent_job(
  p_child_run_id uuid,p_lease_token uuid,p_lease_generation bigint,p_error_code text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_job public.agent_product_async_subagent_jobs;v_run public.agent_product_async_subagent_runs;
BEGIN
  IF p_error_code IS NULL OR p_error_code!~'^[a-z0-9_]{1,100}$' THEN
    RAISE EXCEPTION 'async SubAgent failure evidence is invalid' USING ERRCODE='22023'; END IF;
  SELECT run.* INTO v_run FROM public.agent_product_async_subagent_runs AS run WHERE run.id=p_child_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'async SubAgent terminal conflict' USING ERRCODE='40001'; END IF;
  SELECT job.* INTO STRICT v_job FROM public.agent_product_async_subagent_jobs AS job
    WHERE job.workspace_id=v_run.workspace_id AND job.child_run_id=p_child_run_id FOR UPDATE;
  IF v_job.lease_token<>p_lease_token OR v_job.lease_generation<>p_lease_generation THEN
    RAISE EXCEPTION 'async SubAgent lease conflict' USING ERRCODE='40001';
  END IF;
  IF v_run.status='failed' THEN
    IF v_run.error_code=p_error_code THEN RETURN; END IF;
    RAISE EXCEPTION 'async SubAgent terminal conflict' USING ERRCODE='40001';
  ELSIF v_run.status='completed' THEN RAISE EXCEPTION 'async SubAgent terminal conflict' USING ERRCODE='40001'; END IF;
  IF v_job.status<>'leased' OR v_job.lease_token<>p_lease_token OR v_job.lease_generation<>p_lease_generation
    OR v_job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'async SubAgent lease conflict' USING ERRCODE='40001'; END IF;
  UPDATE public.agent_product_async_subagent_runs SET status='failed',error_code=p_error_code,completed_at=clock_timestamp()
    WHERE workspace_id=v_run.workspace_id AND id=p_child_run_id;
  UPDATE public.agent_product_async_subagent_jobs SET status='failed',completed_at=clock_timestamp()
    WHERE workspace_id=v_run.workspace_id AND child_run_id=p_child_run_id;
  INSERT INTO public.agent_product_async_subagent_events(workspace_id,child_run_id,parent_run_id,sequence,kind,payload)
    VALUES(v_run.workspace_id,p_child_run_id,v_run.parent_run_id,3,'failed',jsonb_build_object('errorCode',p_error_code));
END;
$function$;

CREATE FUNCTION app.read_agent_product_async_subagent_run(
  p_workspace_id uuid,p_parent_run_id uuid,p_actor_id uuid,p_parent_call_id uuid
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
  SELECT jsonb_build_object('childRunId',run.id,'parentCallId',run.parent_call_id,'status',run.status,
    'outputText',run.output_text,'providerRequestId',run.provider_request_id,
    'aggregateInputTokens',run.aggregate_input_tokens,'aggregateOutputTokens',run.aggregate_output_tokens,
    'errorCode',run.error_code,'createdAt',run.created_at,'startedAt',run.started_at,'completedAt',run.completed_at,
    'joinPolicy',context.join_policy,'cascadePolicy',context.cascade_policy,
    'contextPolicy',context.context_policy,'settlementPolicy',context.settlement_policy,'outcomeMap',context.outcome_map)
  FROM public.agent_product_async_subagent_runs AS run
  JOIN public.agent_product_async_subagent_contexts AS context
    ON context.workspace_id=run.workspace_id AND context.child_run_id=run.id
  JOIN public.agent_product_runs AS parent ON parent.workspace_id=run.workspace_id AND parent.id=run.parent_run_id
  JOIN public.agent_product_conversations AS conversation
    ON conversation.workspace_id=parent.workspace_id AND conversation.id=parent.conversation_id
  WHERE run.workspace_id=p_workspace_id AND run.parent_run_id=p_parent_run_id
    AND run.parent_call_id=p_parent_call_id AND conversation.actor_id=p_actor_id;
$function$;

CREATE FUNCTION app.list_agent_product_async_subagent_events(
  p_workspace_id uuid,p_parent_run_id uuid,p_actor_id uuid
) RETURNS TABLE(child_run_id uuid,sequence smallint,kind text,payload jsonb,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
  SELECT event.child_run_id,event.sequence,event.kind,event.payload,event.created_at
  FROM public.agent_product_async_subagent_events AS event
  JOIN public.agent_product_runs AS parent ON parent.workspace_id=event.workspace_id AND parent.id=event.parent_run_id
  JOIN public.agent_product_conversations AS conversation
    ON conversation.workspace_id=parent.workspace_id AND conversation.id=parent.conversation_id
  WHERE event.workspace_id=p_workspace_id AND event.parent_run_id=p_parent_run_id AND conversation.actor_id=p_actor_id
  ORDER BY event.child_run_id,event.sequence;
$function$;

CREATE FUNCTION app.cascade_agent_product_async_subagent_children()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v_child record;v_now timestamptz:=clock_timestamp();
BEGIN
  IF OLD.status='pending' AND NEW.status='completed' AND EXISTS(
    SELECT 1 FROM public.agent_product_async_subagent_runs AS child
    WHERE child.workspace_id=NEW.workspace_id AND child.parent_run_id=NEW.id AND child.status<>'completed'
  ) THEN RAISE EXCEPTION 'async SubAgent children must settle before parent completion' USING ERRCODE='40001'; END IF;
  IF OLD.status='pending' AND NEW.status='failed' THEN
    FOR v_child IN SELECT child.* FROM public.agent_product_async_subagent_runs AS child
      WHERE child.workspace_id=NEW.workspace_id AND child.parent_run_id=NEW.id
        AND child.status IN ('queued','leased') FOR UPDATE
    LOOP
      UPDATE public.agent_product_async_subagent_runs SET status='failed',error_code='parent_run_failed',completed_at=v_now
        WHERE workspace_id=v_child.workspace_id AND id=v_child.id;
      UPDATE public.agent_product_async_subagent_jobs SET status='failed',completed_at=v_now
        WHERE workspace_id=v_child.workspace_id AND child_run_id=v_child.id;
      INSERT INTO public.agent_product_async_subagent_events(workspace_id,child_run_id,parent_run_id,sequence,kind,payload)
        VALUES(v_child.workspace_id,v_child.id,NEW.id,
          CASE WHEN v_child.status='queued' THEN 2 ELSE 3 END,'failed',jsonb_build_object('errorCode','parent_run_failed'));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER agent_product_runs_async_subagent_settlement
BEFORE UPDATE OF status ON public.agent_product_runs
FOR EACH ROW EXECUTE FUNCTION app.cascade_agent_product_async_subagent_children();

ALTER FUNCTION app.dispatch_agent_product_async_subagent_job(uuid,uuid,uuid,uuid,bigint,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.claim_agent_product_async_subagent_job(text,integer) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.record_agent_product_async_subagent_invocation(uuid,uuid,bigint,jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.complete_agent_product_async_subagent_job(uuid,uuid,bigint,bigint,bigint,text,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.fail_agent_product_async_subagent_job(uuid,uuid,bigint,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_async_subagent_run(uuid,uuid,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_product_async_subagent_events(uuid,uuid,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.cascade_agent_product_async_subagent_children() OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.dispatch_agent_product_async_subagent_job(uuid,uuid,uuid,uuid,bigint,text),
  app.claim_agent_product_async_subagent_job(text,integer),
  app.record_agent_product_async_subagent_invocation(uuid,uuid,bigint,jsonb),
  app.complete_agent_product_async_subagent_job(uuid,uuid,bigint,bigint,bigint,text,text),
  app.fail_agent_product_async_subagent_job(uuid,uuid,bigint,text),
  app.read_agent_product_async_subagent_run(uuid,uuid,uuid,uuid),
  app.list_agent_product_async_subagent_events(uuid,uuid,uuid) FROM PUBLIC,ba_runtime,ba_execution_executor;
GRANT EXECUTE ON FUNCTION app.dispatch_agent_product_async_subagent_job(uuid,uuid,uuid,uuid,bigint,text),
  app.read_agent_product_async_subagent_run(uuid,uuid,uuid,uuid),
  app.list_agent_product_async_subagent_events(uuid,uuid,uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.claim_agent_product_async_subagent_job(text,integer),
  app.record_agent_product_async_subagent_invocation(uuid,uuid,bigint,jsonb),
  app.complete_agent_product_async_subagent_job(uuid,uuid,bigint,bigint,bigint,text,text),
  app.fail_agent_product_async_subagent_job(uuid,uuid,bigint,text) TO ba_execution_executor;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
