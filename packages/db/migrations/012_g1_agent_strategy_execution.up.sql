-- Durable G1-A4 Agent Strategy facts. Execution logins receive only the
-- fixed SECURITY DEFINER functions below and never direct table DML.

GRANT USAGE, CREATE ON SCHEMA app TO ba_run_owner;
GRANT CREATE ON SCHEMA public TO ba_run_owner;
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;
GRANT EXECUTE ON FUNCTION app.g007_canonical_json(jsonb) TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE auth.agent_strategy_plan_attestations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  run_id uuid NOT NULL,
  agent_strategy_execution_id uuid NOT NULL,
  bound_session_user name NOT NULL,
  compiled_agent_plan_hash text NOT NULL CHECK (
    compiled_agent_plan_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  verifier_hmac bytea NOT NULL CHECK (octet_length(verifier_hmac) = 32),
  reviewed_by text NOT NULL CHECK (length(btrim(reviewed_by)) > 0),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text,
  CONSTRAINT agent_strategy_plan_attestations_expiry CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'
  ),
  CONSTRAINT agent_strategy_plan_attestations_consumption CHECK (
    (consumed_at IS NULL AND consumed_by IS NULL)
    OR (consumed_at IS NOT NULL AND length(btrim(consumed_by)) > 0)
  )
);
ALTER TABLE auth.agent_strategy_plan_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.agent_strategy_plan_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_strategy_plan_attestations_owner_access
ON auth.agent_strategy_plan_attestations FOR ALL TO ba_authorization_owner
USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE auth.agent_strategy_plan_attestations FROM PUBLIC;

CREATE FUNCTION auth.issue_agent_strategy_plan_attestation(
  p_attestation_id uuid,
  p_workspace_id uuid,
  p_run_id uuid,
  p_agent_strategy_execution_id uuid,
  p_bound_session_user name,
  p_plan jsonb,
  p_verifier_hmac bytea,
  p_expires_at timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_plan_hash text;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR pg_catalog.pg_has_role(session_user,'ba_execution_executor','MEMBER') THEN
    RAISE EXCEPTION 'AgentPlan review requires an isolated management issuer login'
      USING ERRCODE = '42501';
  END IF;
  IF p_attestation_id IS NULL OR p_workspace_id IS NULL OR p_run_id IS NULL
     OR p_agent_strategy_execution_id IS NULL OR p_bound_session_user IS NULL
     OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR p_plan ->> 'schema_version' IS DISTINCT FROM 'compiled-agent-plan/1'
     OR COALESCE(p_plan ->> 'plan_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR p_plan #>> '{agent_release,workspace_id}' IS DISTINCT FROM p_workspace_id::text
     OR p_verifier_hmac IS NULL OR octet_length(p_verifier_hmac) <> 32
     OR p_expires_at IS NULL OR p_expires_at <= v_now
     OR p_expires_at > v_now + interval '15 minutes'
     OR NOT pg_catalog.pg_has_role(p_bound_session_user,'ba_execution_executor','MEMBER')
     OR pg_catalog.pg_has_role(p_bound_session_user,'ba_management_attestation_issuer','MEMBER') THEN
    RAISE EXCEPTION 'invalid AgentPlan attestation input' USING ERRCODE = '22023';
  END IF;
  v_plan_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(p_plan - 'plan_hash'),'UTF8'
  ),'sha256'),'hex');
  IF v_plan_hash IS DISTINCT FROM p_plan ->> 'plan_hash' THEN
    RAISE EXCEPTION 'reviewed AgentPlan hash is invalid' USING ERRCODE = '55000';
  END IF;
  INSERT INTO auth.agent_strategy_plan_attestations (
    id,workspace_id,run_id,agent_strategy_execution_id,bound_session_user,
    compiled_agent_plan_hash,verifier_hmac,reviewed_by,issued_at,expires_at
  ) VALUES (
    p_attestation_id,p_workspace_id,p_run_id,p_agent_strategy_execution_id,
    p_bound_session_user,v_plan_hash,p_verifier_hmac,
    'management-reviewer:' || session_user::text,v_now,p_expires_at
  );
END;
$function$;

CREATE FUNCTION auth.consume_agent_strategy_plan_attestation(
  p_attestation_id uuid,
  p_presented_verifier bytea,
  p_run_id uuid,
  p_agent_strategy_execution_id uuid,
  p_plan jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_attestation auth.agent_strategy_plan_attestations%ROWTYPE;
  v_plan_hash text;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_execution_executor','MEMBER')
     OR pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR p_presented_verifier IS NULL OR octet_length(p_presented_verifier) <> 32 THEN
    RAISE EXCEPTION 'AgentPlan consumption requires an isolated execution login'
      USING ERRCODE = '42501';
  END IF;
  v_plan_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(p_plan - 'plan_hash'),'UTF8'
  ),'sha256'),'hex');
  SELECT attestation.* INTO v_attestation
  FROM auth.agent_strategy_plan_attestations AS attestation
  WHERE attestation.id = p_attestation_id
  FOR UPDATE OF attestation;
  IF NOT FOUND
     OR v_attestation.workspace_id IS DISTINCT FROM app.current_workspace_id()
     OR v_attestation.run_id IS DISTINCT FROM p_run_id
     OR v_attestation.agent_strategy_execution_id IS DISTINCT FROM p_agent_strategy_execution_id
     OR v_attestation.bound_session_user IS DISTINCT FROM session_user::name
     OR v_attestation.compiled_agent_plan_hash IS DISTINCT FROM v_plan_hash
     OR v_plan_hash IS DISTINCT FROM p_plan ->> 'plan_hash'
     OR NOT auth.constant_time_equal_32(v_attestation.verifier_hmac,p_presented_verifier)
     OR v_attestation.consumed_at IS NOT NULL
     OR v_attestation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'AgentPlan attestation is unavailable for this exact execution'
      USING ERRCODE = '42501';
  END IF;
  UPDATE auth.agent_strategy_plan_attestations
  SET consumed_at = clock_timestamp(), consumed_by = session_user::text
  WHERE id = p_attestation_id;
END;
$function$;

REVOKE ALL ON FUNCTION auth.issue_agent_strategy_plan_attestation(
  uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz
), auth.consume_agent_strategy_plan_attestation(uuid,bytea,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.issue_agent_strategy_plan_attestation(
  uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz
) TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.consume_agent_strategy_plan_attestation(
  uuid,bytea,uuid,uuid,jsonb
) TO ba_run_owner;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA auth FROM ba_authorization_owner;

CREATE TABLE public.agent_strategy_executions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  plan_attestation_id uuid NOT NULL,
  compiled_agent_plan_hash text NOT NULL CHECK (
    compiled_agent_plan_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  resolved_execution_plan_hash text NOT NULL CHECK (
    resolved_execution_plan_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  capability_closure_hash text NOT NULL CHECK (
    capability_closure_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  strategy_release_id text NOT NULL CHECK (length(btrim(strategy_release_id)) > 0),
  implementation_digest text NOT NULL CHECK (implementation_digest ~ '^sha256:[0-9a-f]{64}$'),
  compiled_agent_plan jsonb NOT NULL CHECK (jsonb_typeof(compiled_agent_plan) = 'object'),
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL CHECK (
    producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  producer_lease_expires_at timestamptz NOT NULL,
  authorized_at timestamptz NOT NULL CHECK (authorized_at < producer_lease_expires_at),
  PRIMARY KEY (workspace_id,id),
  CONSTRAINT agent_strategy_executions_run_key UNIQUE (workspace_id,run_id),
  CONSTRAINT agent_strategy_executions_run_fkey FOREIGN KEY (workspace_id,run_id)
    REFERENCES public.runs(workspace_id,id),
  CONSTRAINT agent_strategy_executions_attempt_fkey FOREIGN KEY (workspace_id,run_id,attempt_id)
    REFERENCES public.run_attempts(workspace_id,run_id,id)
);

CREATE TABLE public.agent_strategy_checkpoints (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_strategy_execution_id uuid NOT NULL,
  checkpoint_id text NOT NULL CHECK (length(btrim(checkpoint_id)) BETWEEN 1 AND 512),
  commit_sequence bigint NOT NULL CHECK (commit_sequence BETWEEN 1 AND 9007199254740991),
  transition_sequence bigint NOT NULL CHECK (transition_sequence BETWEEN 0 AND 9007199254740991),
  phase text NOT NULL CHECK (phase IN (
    'READY','MODEL_PENDING','CAPABILITY_PENDING','SUSPENDED','RESUMING','TERMINATING','TERMINAL'
  )),
  previous_checkpoint_hash text,
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL,
  producer_lease_expires_at timestamptz NOT NULL,
  authorized_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,agent_strategy_execution_id,checkpoint_id),
  CONSTRAINT agent_strategy_checkpoints_sequence_key UNIQUE (
    workspace_id,agent_strategy_execution_id,commit_sequence
  ),
  CONSTRAINT agent_strategy_checkpoints_hash_key UNIQUE (
    workspace_id,agent_strategy_execution_id,checkpoint_hash
  ),
  CONSTRAINT agent_strategy_checkpoints_execution_fkey FOREIGN KEY (
    workspace_id,agent_strategy_execution_id
  ) REFERENCES public.agent_strategy_executions(workspace_id,id)
);

CREATE TABLE public.agent_strategy_actions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_strategy_execution_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (operation_id ~ '^sha256:[0-9a-f]{64}$'),
  transition_sequence bigint NOT NULL,
  action_kind text NOT NULL CHECK (
    action_kind IN ('model','capability','instruction_skill','human_gate','terminal')
  ),
  decision_hash text NOT NULL CHECK (decision_hash ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'),
  outbox jsonb NOT NULL CHECK (jsonb_typeof(outbox) = 'object'),
  producer_session_user name NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,agent_strategy_execution_id,operation_id),
  CONSTRAINT agent_strategy_actions_transition_key UNIQUE (
    workspace_id,agent_strategy_execution_id,transition_sequence
  ),
  CONSTRAINT agent_strategy_actions_checkpoint_fkey FOREIGN KEY (
    workspace_id,agent_strategy_execution_id,checkpoint_hash
  ) REFERENCES public.agent_strategy_checkpoints(
    workspace_id,agent_strategy_execution_id,checkpoint_hash
  )
);

CREATE TABLE public.agent_strategy_action_results (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  agent_strategy_execution_id uuid NOT NULL,
  operation_id text NOT NULL,
  action_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','OUTCOME_UNKNOWN')),
  completion_id text NOT NULL CHECK (length(btrim(completion_id)) BETWEEN 1 AND 512),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  accepted_checkpoint_hash text NOT NULL CHECK (
    accepted_checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  producer_session_user name NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,agent_strategy_execution_id,operation_id),
  CONSTRAINT agent_strategy_action_results_action_fkey FOREIGN KEY (
    workspace_id,agent_strategy_execution_id,operation_id
  ) REFERENCES public.agent_strategy_actions(workspace_id,agent_strategy_execution_id,operation_id),
  CONSTRAINT agent_strategy_action_results_checkpoint_fkey FOREIGN KEY (
    workspace_id,agent_strategy_execution_id,accepted_checkpoint_hash
  ) REFERENCES public.agent_strategy_checkpoints(
    workspace_id,agent_strategy_execution_id,checkpoint_hash
  )
);

CREATE TABLE public.agent_model_usage_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  agent_strategy_execution_id uuid NOT NULL,
  operation_id text NOT NULL,
  usage_attribution_id uuid NOT NULL,
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  producer_session_user name NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CONSTRAINT agent_model_usage_receipts_operation_key UNIQUE (
    workspace_id,agent_strategy_execution_id,operation_id
  ),
  CONSTRAINT agent_model_usage_receipts_action_fkey FOREIGN KEY (
    workspace_id,agent_strategy_execution_id,operation_id
  ) REFERENCES public.agent_strategy_actions(workspace_id,agent_strategy_execution_id,operation_id),
  CONSTRAINT agent_model_usage_receipts_attribution_fkey FOREIGN KEY (
    workspace_id,usage_attribution_id
  ) REFERENCES public.run_usage_attributions(workspace_id,id)
);

ALTER TABLE public.agent_strategy_executions OWNER TO ba_run_owner;
ALTER TABLE public.agent_strategy_checkpoints OWNER TO ba_run_owner;
ALTER TABLE public.agent_strategy_actions OWNER TO ba_run_owner;
ALTER TABLE public.agent_strategy_action_results OWNER TO ba_run_owner;
ALTER TABLE public.agent_model_usage_receipts OWNER TO ba_run_owner;

ALTER TABLE public.agent_strategy_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_strategy_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_strategy_executions_owner_access ON public.agent_strategy_executions
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
ALTER TABLE public.agent_strategy_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_strategy_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_strategy_checkpoints_owner_access ON public.agent_strategy_checkpoints
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
ALTER TABLE public.agent_strategy_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_strategy_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_strategy_actions_owner_access ON public.agent_strategy_actions
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
ALTER TABLE public.agent_strategy_action_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_strategy_action_results FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_strategy_action_results_owner_access ON public.agent_strategy_action_results
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
ALTER TABLE public.agent_model_usage_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_model_usage_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_model_usage_receipts_owner_access ON public.agent_model_usage_receipts
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.agent_strategy_executions,
  public.agent_strategy_checkpoints,public.agent_strategy_actions,
  public.agent_strategy_action_results,public.agent_model_usage_receipts FROM PUBLIC;

CREATE FUNCTION app.reject_g1_agent_strategy_fact_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'G1 Agent Strategy fact is immutable' USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION app.reject_g1_agent_strategy_fact_change() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.reject_g1_agent_strategy_fact_change() FROM PUBLIC;

CREATE TRIGGER agent_strategy_executions_immutable BEFORE UPDATE OR DELETE
ON public.agent_strategy_executions FOR EACH ROW
EXECUTE FUNCTION app.reject_g1_agent_strategy_fact_change();
CREATE TRIGGER agent_strategy_checkpoints_immutable BEFORE UPDATE OR DELETE
ON public.agent_strategy_checkpoints FOR EACH ROW
EXECUTE FUNCTION app.reject_g1_agent_strategy_fact_change();
CREATE TRIGGER agent_strategy_actions_immutable BEFORE UPDATE OR DELETE
ON public.agent_strategy_actions FOR EACH ROW
EXECUTE FUNCTION app.reject_g1_agent_strategy_fact_change();
CREATE TRIGGER agent_strategy_action_results_immutable BEFORE UPDATE OR DELETE
ON public.agent_strategy_action_results FOR EACH ROW
EXECUTE FUNCTION app.reject_g1_agent_strategy_fact_change();
CREATE TRIGGER agent_model_usage_receipts_immutable BEFORE UPDATE OR DELETE
ON public.agent_model_usage_receipts FOR EACH ROW
EXECUTE FUNCTION app.reject_g1_agent_strategy_fact_change();

CREATE FUNCTION app.register_agent_strategy_execution(p_fact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_plan jsonb := p_fact -> 'compiled_agent_plan';
  v_run public.runs%ROWTYPE;
  v_existing public.agent_strategy_executions%ROWTYPE;
  v_plan_hash text;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY[
       'run_id','attempt_id','lease_token','lease_fencing_token',
       'agent_strategy_execution_id','compiled_agent_plan','plan_attestation_id',
       'plan_attestation_verifier'
     ]) <> '{}'::jsonb
     OR COALESCE(p_fact ->> 'agent_strategy_execution_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'plan_attestation_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'plan_attestation_verifier','') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_plan) IS DISTINCT FROM 'object'
     OR v_plan ->> 'schema_version' IS DISTINCT FROM 'compiled-agent-plan/1'
     OR v_plan ->> 'checkpoint_contract_version' IS DISTINCT FROM 'agent-strategy-checkpoint/1'
     OR COALESCE(v_plan ->> 'plan_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_plan ->> 'resolved_execution_plan_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_plan ->> 'capability_closure_hash','') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Agent Strategy execution registration fact is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_plan_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_plan - 'plan_hash'),'UTF8'
  ),'sha256'),'hex');
  IF v_plan_hash IS DISTINCT FROM v_plan ->> 'plan_hash' THEN
    RAISE EXCEPTION 'compiled AgentPlan hash is invalid' USING ERRCODE = '55000';
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  SELECT run_row.* INTO v_run FROM public.runs AS run_row
  WHERE run_row.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND run_row.id = (v_authority ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND OR v_run.target_kind <> 'agent'
     OR v_run.accepted_plan_hash IS DISTINCT FROM v_plan ->> 'resolved_execution_plan_hash'
     OR v_run.workspace_id::text IS DISTINCT FROM v_plan #>> '{agent_release,workspace_id}'
     OR v_run.agent_release_id::text
          IS DISTINCT FROM v_plan #>> '{agent_release,resource_version_id}' THEN
    RAISE EXCEPTION 'AgentPlan does not match the admitted Agent Run' USING ERRCODE = '55000';
  END IF;
  SELECT execution.* INTO v_existing FROM public.agent_strategy_executions AS execution
  WHERE execution.workspace_id = v_run.workspace_id AND execution.run_id = v_run.id;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM (p_fact ->> 'agent_strategy_execution_id')::uuid
       OR v_existing.compiled_agent_plan IS DISTINCT FROM v_plan
       OR v_existing.plan_attestation_id IS DISTINCT FROM (p_fact ->> 'plan_attestation_id')::uuid
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'Agent Run already has a different Strategy execution'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','agent-strategy-execution-registration-result/1',
      'agent_strategy_execution_id',v_existing.id,
      'compiled_agent_plan_hash',v_existing.compiled_agent_plan_hash,'replayed',true
    );
  END IF;
  PERFORM auth.consume_agent_strategy_plan_attestation(
    (p_fact ->> 'plan_attestation_id')::uuid,
    decode(p_fact ->> 'plan_attestation_verifier','hex'),v_run.id,
    (p_fact ->> 'agent_strategy_execution_id')::uuid,v_plan
  );
  INSERT INTO public.agent_strategy_executions (
    workspace_id,id,run_id,attempt_id,plan_attestation_id,
    compiled_agent_plan_hash,resolved_execution_plan_hash,capability_closure_hash,
    strategy_release_id,implementation_digest,compiled_agent_plan,
    producer_session_user,producer_lease_token,producer_lease_fencing_token,
    producer_lease_expires_at,authorized_at
  ) VALUES (
    v_run.workspace_id,(p_fact ->> 'agent_strategy_execution_id')::uuid,v_run.id,
    (v_authority ->> 'attempt_id')::uuid,(p_fact ->> 'plan_attestation_id')::uuid,
    v_plan_hash,v_plan ->> 'resolved_execution_plan_hash',v_plan ->> 'capability_closure_hash',
    v_plan #>> '{strategy,strategy_pin,strategy_release_id}',
    v_plan #>> '{strategy,strategy_pin,implementation_digest}',v_plan,
    v_authority ->> 'lease_owner',(v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,v_now
  );
  RETURN jsonb_build_object(
    'schema_version','agent-strategy-execution-registration-result/1',
    'agent_strategy_execution_id',p_fact ->> 'agent_strategy_execution_id',
    'compiled_agent_plan_hash',v_plan_hash,'replayed',false
  );
END;
$function$;

CREATE FUNCTION app.commit_agent_strategy_checkpoint(p_fact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_execution public.agent_strategy_executions%ROWTYPE;
  v_previous public.agent_strategy_checkpoints%ROWTYPE;
  v_existing public.agent_strategy_checkpoints%ROWTYPE;
  v_checkpoint jsonb := p_fact -> 'checkpoint';
  v_outbox jsonb := p_fact -> 'outbox';
  v_checkpoint_hash text;
  v_commit_sequence bigint;
  v_pending jsonb;
  v_action_kind text;
  v_operation_id text;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY[
       'run_id','attempt_id','lease_token','lease_fencing_token',
       'agent_strategy_execution_id','commit_sequence','checkpoint','decision_hash','outbox'
     ]) <> '{}'::jsonb
     OR jsonb_typeof(v_checkpoint) IS DISTINCT FROM 'object'
     OR v_checkpoint ->> 'schema_version' IS DISTINCT FROM 'agent-strategy-checkpoint/1'
     OR COALESCE(v_checkpoint ->> 'checkpoint_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_fact ->> 'commit_sequence','') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Agent Strategy checkpoint fact is invalid' USING ERRCODE = '22023';
  END IF;
  v_checkpoint_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_checkpoint - 'checkpoint_hash'),'UTF8'
  ),'sha256'),'hex');
  IF v_checkpoint_hash IS DISTINCT FROM v_checkpoint ->> 'checkpoint_hash' THEN
    RAISE EXCEPTION 'Agent Strategy checkpoint hash is invalid' USING ERRCODE = '55000';
  END IF;
  v_commit_sequence := (p_fact ->> 'commit_sequence')::bigint;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  SELECT execution.* INTO v_execution FROM public.agent_strategy_executions AS execution
  WHERE execution.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND execution.id = (p_fact ->> 'agent_strategy_execution_id')::uuid
    AND execution.run_id = (v_authority ->> 'run_id')::uuid;
  IF NOT FOUND
     OR v_checkpoint ->> 'run_id' IS DISTINCT FROM v_execution.run_id::text
     OR v_checkpoint ->> 'resolved_agent_plan_hash'
          IS DISTINCT FROM v_execution.compiled_agent_plan_hash
     OR v_checkpoint ->> 'capability_closure_hash'
          IS DISTINCT FROM v_execution.capability_closure_hash
     OR v_checkpoint ->> 'strategy_release_id' IS DISTINCT FROM v_execution.strategy_release_id
     OR v_checkpoint ->> 'implementation_digest'
          IS DISTINCT FROM v_execution.implementation_digest THEN
    RAISE EXCEPTION 'checkpoint does not match the exact Agent Strategy execution'
      USING ERRCODE = '55000';
  END IF;
  SELECT stored.* INTO v_existing FROM public.agent_strategy_checkpoints AS stored
  WHERE stored.workspace_id = v_execution.workspace_id
    AND stored.agent_strategy_execution_id = v_execution.id
    AND stored.checkpoint_hash = v_checkpoint_hash;
  IF FOUND THEN
    IF v_existing.checkpoint IS DISTINCT FROM v_checkpoint
       OR v_existing.commit_sequence IS DISTINCT FROM v_commit_sequence THEN
      RAISE EXCEPTION 'Agent Strategy checkpoint hash conflicts' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','agent-strategy-checkpoint-commit-result/1',
      'checkpoint',v_existing.checkpoint,'replayed',true
    );
  END IF;
  SELECT stored.* INTO v_previous FROM public.agent_strategy_checkpoints AS stored
  WHERE stored.workspace_id = v_execution.workspace_id
    AND stored.agent_strategy_execution_id = v_execution.id
  ORDER BY stored.commit_sequence DESC LIMIT 1 FOR UPDATE;
  IF v_commit_sequence = 1 THEN
    IF FOUND OR v_checkpoint ? 'previous_checkpoint_hash' THEN
      RAISE EXCEPTION 'first Strategy checkpoint cannot extend another commit'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NOT FOUND OR v_previous.commit_sequence + 1 <> v_commit_sequence
     OR v_checkpoint ->> 'previous_checkpoint_hash' IS DISTINCT FROM v_previous.checkpoint_hash THEN
    RAISE EXCEPTION 'Strategy checkpoint does not extend the exact committed sequence'
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.agent_strategy_checkpoints (
    workspace_id,agent_strategy_execution_id,checkpoint_id,commit_sequence,
    transition_sequence,phase,previous_checkpoint_hash,checkpoint_hash,checkpoint,
    producer_session_user,producer_lease_token,producer_lease_fencing_token,
    producer_lease_expires_at,authorized_at
  ) VALUES (
    v_execution.workspace_id,v_execution.id,v_checkpoint ->> 'checkpoint_id',v_commit_sequence,
    (v_checkpoint ->> 'transition_sequence')::bigint,v_checkpoint ->> 'phase',
    v_checkpoint ->> 'previous_checkpoint_hash',v_checkpoint_hash,v_checkpoint,
    v_authority ->> 'lease_owner',(v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,v_now
  );
  v_pending := v_checkpoint -> 'pending_action';
  IF v_pending IS NOT NULL OR v_outbox IS NOT NULL THEN
    IF jsonb_typeof(v_outbox) IS DISTINCT FROM 'object'
       OR (v_outbox - ARRAY['schema_version','operation_id','decision_kind','decision_hash'])
            <> '{}'::jsonb
       OR v_outbox ->> 'schema_version' IS DISTINCT FROM 'strategy-action-outbox/1'
       OR COALESCE(p_fact ->> 'decision_hash','') !~ '^sha256:[0-9a-f]{64}$'
       OR v_outbox ->> 'decision_hash' IS DISTINCT FROM p_fact ->> 'decision_hash'
       OR COALESCE(v_outbox ->> 'operation_id','') !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'pending Strategy action requires exact decision and outbox'
        USING ERRCODE = '22023';
    END IF;
    v_operation_id := v_outbox ->> 'operation_id';
    v_action_kind := COALESCE(v_pending ->> 'action_kind','terminal');
    IF v_outbox ->> 'decision_kind' IS DISTINCT FROM (CASE v_action_kind
      WHEN 'model' THEN 'request_model'
      WHEN 'capability' THEN 'invoke_capability'
      WHEN 'instruction_skill' THEN 'activate_instruction_skill'
      WHEN 'human_gate' THEN 'suspend_for_human'
      ELSE v_outbox ->> 'decision_kind'
    END) THEN
      RAISE EXCEPTION 'checkpoint action kind differs from its decision outbox'
        USING ERRCODE = '55000';
    END IF;
    IF v_pending IS NOT NULL AND v_pending ->> 'operation_id' IS DISTINCT FROM v_operation_id THEN
      RAISE EXCEPTION 'checkpoint pending action differs from its outbox' USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.agent_strategy_actions (
      workspace_id,agent_strategy_execution_id,operation_id,transition_sequence,
      action_kind,decision_hash,checkpoint_hash,outbox,producer_session_user
    ) VALUES (
      v_execution.workspace_id,v_execution.id,v_operation_id,
      (v_checkpoint ->> 'transition_sequence')::bigint,v_action_kind,
      p_fact ->> 'decision_hash',v_checkpoint_hash,v_outbox,session_user
    );
  ELSIF p_fact ? 'decision_hash' THEN
    RAISE EXCEPTION 'decision hash without an outbox is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object(
    'schema_version','agent-strategy-checkpoint-commit-result/1',
    'checkpoint',v_checkpoint,'replayed',false
  );
END;
$function$;

CREATE FUNCTION app.commit_agent_strategy_action_result(p_fact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_execution public.agent_strategy_executions%ROWTYPE;
  v_action public.agent_strategy_actions%ROWTYPE;
  v_previous public.agent_strategy_checkpoints%ROWTYPE;
  v_existing public.agent_strategy_action_results%ROWTYPE;
  v_result jsonb := p_fact -> 'action_result';
  v_checkpoint jsonb := p_fact -> 'checkpoint';
  v_receipt jsonb := p_fact -> 'model_usage_receipt';
  v_checkpoint_hash text;
  v_result_hash text;
  v_receipt_hash text;
  v_usage_result jsonb;
  v_commit_sequence bigint;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY[
       'run_id','attempt_id','lease_token','lease_fencing_token','reservation_id','step_id',
       'agent_strategy_execution_id','commit_sequence','action_result','checkpoint',
       'model_usage_receipt'
     ]) <> '{}'::jsonb
     OR jsonb_typeof(v_result) IS DISTINCT FROM 'object'
     OR v_result ->> 'schema_version' IS DISTINCT FROM 'strategy-action-result/1'
     OR v_result ->> 'status' NOT IN ('SUCCEEDED','FAILED','OUTCOME_UNKNOWN')
     OR COALESCE(v_result ->> 'operation_id','') !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(v_checkpoint) IS DISTINCT FROM 'object'
     OR v_checkpoint ->> 'schema_version' IS DISTINCT FROM 'agent-strategy-checkpoint/1'
     OR COALESCE(p_fact ->> 'commit_sequence','') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Agent Strategy action result fact is invalid' USING ERRCODE = '22023';
  END IF;
  v_checkpoint_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_checkpoint - 'checkpoint_hash'),'UTF8'
  ),'sha256'),'hex');
  v_result_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_result),'UTF8'
  ),'sha256'),'hex');
  IF v_checkpoint_hash IS DISTINCT FROM v_checkpoint ->> 'checkpoint_hash'
     OR v_checkpoint ? 'pending_action' THEN
    RAISE EXCEPTION 'accepted result checkpoint is invalid' USING ERRCODE = '55000';
  END IF;
  v_commit_sequence := (p_fact ->> 'commit_sequence')::bigint;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  SELECT execution.* INTO v_execution FROM public.agent_strategy_executions AS execution
  WHERE execution.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND execution.id = (p_fact ->> 'agent_strategy_execution_id')::uuid
    AND execution.run_id = (v_authority ->> 'run_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent Strategy execution is unavailable' USING ERRCODE = '55000';
  END IF;
  SELECT stored.* INTO v_existing FROM public.agent_strategy_action_results AS stored
  WHERE stored.workspace_id = v_execution.workspace_id
    AND stored.agent_strategy_execution_id = v_execution.id
    AND stored.operation_id = v_result ->> 'operation_id';
  IF FOUND THEN
    IF v_existing.result IS DISTINCT FROM v_result
       OR v_existing.accepted_checkpoint_hash IS DISTINCT FROM v_checkpoint_hash THEN
      RAISE EXCEPTION 'Strategy action result conflicts with committed result'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','agent-strategy-action-result-commit/1',
      'result',v_existing.result,'checkpoint_hash',v_existing.accepted_checkpoint_hash,
      'replayed',true
    );
  END IF;
  SELECT action.* INTO v_action FROM public.agent_strategy_actions AS action
  WHERE action.workspace_id = v_execution.workspace_id
    AND action.agent_strategy_execution_id = v_execution.id
    AND action.operation_id = v_result ->> 'operation_id'
  FOR UPDATE;
  SELECT stored.* INTO v_previous FROM public.agent_strategy_checkpoints AS stored
  WHERE stored.workspace_id = v_execution.workspace_id
    AND stored.agent_strategy_execution_id = v_execution.id
  ORDER BY stored.commit_sequence DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v_action.operation_id IS NULL
     OR v_action.action_kind IS DISTINCT FROM v_result ->> 'action_kind'
     OR v_previous.checkpoint_hash IS DISTINCT FROM v_action.checkpoint_hash
     OR v_previous.commit_sequence + 1 <> v_commit_sequence
     OR v_checkpoint ->> 'previous_checkpoint_hash' IS DISTINCT FROM v_previous.checkpoint_hash
     OR (v_checkpoint ->> 'transition_sequence')::bigint IS DISTINCT FROM v_action.transition_sequence THEN
    RAISE EXCEPTION 'action result does not extend the exact pending checkpoint'
      USING ERRCODE = '40001';
  END IF;
  IF v_result ->> 'status' = 'OUTCOME_UNKNOWN' THEN
    IF (v_action.action_kind = 'model'
        AND v_checkpoint ->> 'termination_reason' IS DISTINCT FROM 'MODEL_OUTCOME_UNKNOWN')
       OR (v_action.action_kind = 'capability'
        AND v_checkpoint ->> 'termination_reason' IS DISTINCT FROM 'SIDE_EFFECT_UNKNOWN') THEN
      RAISE EXCEPTION 'OUTCOME_UNKNOWN requires its exact terminal reason'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  INSERT INTO public.agent_strategy_checkpoints (
    workspace_id,agent_strategy_execution_id,checkpoint_id,commit_sequence,
    transition_sequence,phase,previous_checkpoint_hash,checkpoint_hash,checkpoint,
    producer_session_user,producer_lease_token,producer_lease_fencing_token,
    producer_lease_expires_at,authorized_at
  ) VALUES (
    v_execution.workspace_id,v_execution.id,v_checkpoint ->> 'checkpoint_id',v_commit_sequence,
    (v_checkpoint ->> 'transition_sequence')::bigint,v_checkpoint ->> 'phase',
    v_checkpoint ->> 'previous_checkpoint_hash',v_checkpoint_hash,v_checkpoint,
    v_authority ->> 'lease_owner',(v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,v_now
  );
  IF v_action.action_kind = 'model' AND v_result ->> 'status' = 'SUCCEEDED' THEN
    IF jsonb_typeof(v_receipt) IS DISTINCT FROM 'object'
       OR COALESCE(v_receipt ->> 'receipt_hash','') !~ '^sha256:[0-9a-f]{64}$'
       OR v_receipt ->> 'operation_id' IS DISTINCT FROM v_action.operation_id
       OR COALESCE(v_receipt #>> '{usage,total_tokens}','') !~ '^[0-9]+$'
       OR COALESCE(v_receipt #>> '{usage,amount_credits}','') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'successful model action requires its exact usage receipt'
        USING ERRCODE = '22023';
    END IF;
    v_receipt_hash := 'sha256:' || encode(public.digest(convert_to(
      app.g007_canonical_json(v_receipt - 'receipt_hash'),'UTF8'
    ),'sha256'),'hex');
    IF v_receipt_hash IS DISTINCT FROM v_receipt ->> 'receipt_hash'
       OR v_receipt_hash IS DISTINCT FROM v_result ->> 'receipt_hash' THEN
      RAISE EXCEPTION 'model usage receipt hash differs from action result'
        USING ERRCODE = '55000';
    END IF;
    v_usage_result := app.record_usage_attribution(jsonb_build_object(
      'run_id',p_fact ->> 'run_id','attempt_id',p_fact ->> 'attempt_id',
      'lease_token',p_fact ->> 'lease_token',
      'lease_fencing_token',p_fact ->> 'lease_fencing_token',
      'reservation_id',p_fact ->> 'reservation_id','step_id',p_fact ->> 'step_id',
      'producer_operation_key',v_action.operation_id,'metering_unit','model_total_tokens',
      'quantity',v_receipt #>> '{usage,total_tokens}',
      'amount',v_receipt #>> '{usage,amount_credits}',
      'detail_redacted',jsonb_build_object(
        'agent_strategy_execution_id',v_execution.id,
        'operation_id',v_action.operation_id,'receipt_hash',v_receipt_hash
      )
    ));
    INSERT INTO public.agent_model_usage_receipts (
      workspace_id,id,agent_strategy_execution_id,operation_id,
      usage_attribution_id,receipt_hash,receipt,producer_session_user
    ) VALUES (
      v_execution.workspace_id,(v_receipt ->> 'model_usage_receipt_id')::uuid,
      v_execution.id,v_action.operation_id,
      (v_usage_result #>> '{source,usage_attribution_id}')::uuid,
      v_receipt_hash,v_receipt,session_user
    );
  ELSIF v_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'non-successful or non-model action cannot consume model usage'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.agent_strategy_action_results (
    workspace_id,agent_strategy_execution_id,operation_id,action_kind,status,
    completion_id,result_hash,result,accepted_checkpoint_hash,producer_session_user
  ) VALUES (
    v_execution.workspace_id,v_execution.id,v_action.operation_id,v_action.action_kind,
    v_result ->> 'status',v_result ->> 'completion_id',v_result_hash,v_result,
    v_checkpoint_hash,session_user
  );
  RETURN jsonb_build_object(
    'schema_version','agent-strategy-action-result-commit/1',
    'result',v_result,'checkpoint_hash',v_checkpoint_hash,'replayed',false
  );
END;
$function$;

ALTER FUNCTION app.register_agent_strategy_execution(jsonb) OWNER TO ba_run_owner;
ALTER FUNCTION app.commit_agent_strategy_checkpoint(jsonb) OWNER TO ba_run_owner;
ALTER FUNCTION app.commit_agent_strategy_action_result(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.register_agent_strategy_execution(jsonb),
  app.commit_agent_strategy_checkpoint(jsonb),
  app.commit_agent_strategy_action_result(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_agent_strategy_execution(jsonb)
TO ba_execution_executor;
GRANT EXECUTE ON FUNCTION app.commit_agent_strategy_checkpoint(jsonb)
TO ba_execution_executor;
GRANT EXECUTE ON FUNCTION app.commit_agent_strategy_action_result(jsonb)
TO ba_execution_executor;

REVOKE CREATE ON SCHEMA app FROM ba_run_owner;
REVOKE CREATE ON SCHEMA public FROM ba_run_owner;
RESET ROLE;
