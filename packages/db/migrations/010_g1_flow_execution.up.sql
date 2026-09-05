-- Durable G1-A2 Flow execution facts. The executable role can only use the
-- fixed SECURITY DEFINER surface; it never receives direct table DML.

GRANT USAGE, CREATE ON SCHEMA app TO ba_run_owner;
GRANT CREATE ON SCHEMA public TO ba_run_owner;
GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;
GRANT EXECUTE ON FUNCTION app.g007_canonical_json(jsonb)
TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE auth.flow_execution_plan_attestations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  run_id uuid NOT NULL,
  flow_execution_id uuid NOT NULL,
  bound_session_user name NOT NULL,
  compiled_flow_plan_hash text NOT NULL CHECK (
    compiled_flow_plan_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  verifier_hmac bytea NOT NULL CHECK (octet_length(verifier_hmac) = 32),
  reviewed_by text NOT NULL CHECK (length(btrim(reviewed_by)) > 0),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT flow_execution_plan_attestations_expiry_check CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'
  ),
  CONSTRAINT flow_execution_plan_attestations_consumption_check CHECK (
    (consumed_at IS NULL AND consumed_by IS NULL)
    OR (consumed_at IS NOT NULL AND length(btrim(consumed_by)) > 0)
  ),
  CONSTRAINT flow_execution_plan_attestations_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND consumed_at IS NULL AND length(btrim(revoked_reason)) > 0)
  )
);
ALTER TABLE auth.flow_execution_plan_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.flow_execution_plan_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_execution_plan_attestations_owner_access
ON auth.flow_execution_plan_attestations FOR ALL TO ba_authorization_owner
USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE auth.flow_execution_plan_attestations FROM PUBLIC;

CREATE FUNCTION auth.enforce_flow_execution_plan_attestation_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Flow execution plan attestation is immutable' USING ERRCODE = '55000';
  END IF;
  IF to_jsonb(NEW) - ARRAY['consumed_at','consumed_by','revoked_at','revoked_reason']::text[]
       IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['consumed_at','consumed_by','revoked_at','revoked_reason']::text[] THEN
    RAISE EXCEPTION 'Flow execution plan attestation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.consumed_at IS NULL AND OLD.revoked_at IS NULL
     AND NEW.consumed_at IS NOT NULL AND NEW.consumed_by IS NOT NULL
     AND NEW.revoked_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NULL AND OLD.revoked_at IS NULL
     AND NEW.consumed_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Flow execution plan attestation permits only first consume or revoke'
    USING ERRCODE = '55000';
END;
$function$;
CREATE TRIGGER flow_execution_plan_attestations_controlled_change
BEFORE UPDATE OR DELETE ON auth.flow_execution_plan_attestations
FOR EACH ROW EXECUTE FUNCTION auth.enforce_flow_execution_plan_attestation_change();

CREATE FUNCTION auth.issue_flow_execution_plan_attestation(
  p_attestation_id uuid,
  p_workspace_id uuid,
  p_run_id uuid,
  p_flow_execution_id uuid,
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
    RAISE EXCEPTION 'Flow plan review requires an isolated management issuer login'
      USING ERRCODE = '42501';
  END IF;
  IF p_attestation_id IS NULL OR p_workspace_id IS NULL OR p_run_id IS NULL
     OR p_flow_execution_id IS NULL OR p_bound_session_user IS NULL
     OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR p_plan ->> 'schema_version' IS DISTINCT FROM 'compiled-flow-plan/1'
     OR COALESCE(p_plan ->> 'compiled_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR p_verifier_hmac IS NULL OR octet_length(p_verifier_hmac) <> 32
     OR p_expires_at IS NULL OR p_expires_at <= v_now
     OR p_expires_at > v_now + interval '15 minutes'
     OR NOT pg_catalog.pg_has_role(p_bound_session_user,'ba_execution_executor','MEMBER')
     OR pg_catalog.pg_has_role(p_bound_session_user,'ba_management_attestation_issuer','MEMBER') THEN
    RAISE EXCEPTION 'invalid Flow execution plan attestation input'
      USING ERRCODE = '22023';
  END IF;
  v_plan_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(p_plan - 'compiled_hash'),'UTF8'
  ),'sha256'),'hex');
  IF v_plan_hash IS DISTINCT FROM p_plan ->> 'compiled_hash'
     OR p_plan #>> '{flow_version,workspace_id}' IS DISTINCT FROM p_workspace_id::text THEN
    RAISE EXCEPTION 'reviewed FlowPlan hash or Workspace is invalid' USING ERRCODE = '55000';
  END IF;
  INSERT INTO auth.flow_execution_plan_attestations (
    id,workspace_id,run_id,flow_execution_id,bound_session_user,
    compiled_flow_plan_hash,verifier_hmac,reviewed_by,issued_at,expires_at
  ) VALUES (
    p_attestation_id,p_workspace_id,p_run_id,p_flow_execution_id,p_bound_session_user,
    v_plan_hash,p_verifier_hmac,'management-reviewer:' || session_user::text,v_now,p_expires_at
  );
END;
$function$;

CREATE FUNCTION auth.consume_flow_execution_plan_attestation(
  p_attestation_id uuid,
  p_presented_verifier bytea,
  p_run_id uuid,
  p_flow_execution_id uuid,
  p_plan jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_attestation auth.flow_execution_plan_attestations%ROWTYPE;
  v_plan_hash text;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_execution_executor','MEMBER')
     OR pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR p_attestation_id IS NULL OR p_presented_verifier IS NULL
     OR octet_length(p_presented_verifier) <> 32 THEN
    RAISE EXCEPTION 'Flow plan consumption requires an isolated execution login'
      USING ERRCODE = '42501';
  END IF;
  v_plan_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(p_plan - 'compiled_hash'),'UTF8'
  ),'sha256'),'hex');
  SELECT attestation.* INTO v_attestation
  FROM auth.flow_execution_plan_attestations AS attestation
  WHERE attestation.id = p_attestation_id
  FOR UPDATE OF attestation;
  IF NOT FOUND
     OR v_attestation.workspace_id IS DISTINCT FROM app.current_workspace_id()
     OR v_attestation.run_id IS DISTINCT FROM p_run_id
     OR v_attestation.flow_execution_id IS DISTINCT FROM p_flow_execution_id
     OR v_attestation.bound_session_user IS DISTINCT FROM session_user::name
     OR v_attestation.compiled_flow_plan_hash IS DISTINCT FROM v_plan_hash
     OR v_plan_hash IS DISTINCT FROM p_plan ->> 'compiled_hash'
     OR NOT auth.constant_time_equal_32(v_attestation.verifier_hmac,p_presented_verifier)
     OR v_attestation.consumed_at IS NOT NULL OR v_attestation.revoked_at IS NOT NULL
     OR v_attestation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Flow execution plan attestation is unavailable for this exact Plan'
      USING ERRCODE = '42501';
  END IF;
  UPDATE auth.flow_execution_plan_attestations
  SET consumed_at = clock_timestamp(), consumed_by = session_user::text
  WHERE id = p_attestation_id;
END;
$function$;

CREATE FUNCTION auth.revoke_flow_execution_plan_attestation(
  p_attestation_id uuid,
  p_reason text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR pg_catalog.pg_has_role(session_user,'ba_execution_executor','MEMBER') THEN
    RAISE EXCEPTION 'Flow plan revocation requires an isolated management issuer login'
      USING ERRCODE = '42501';
  END IF;
  IF p_attestation_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Flow plan revocation requires an id and reason'
      USING ERRCODE = '22023';
  END IF;
  UPDATE auth.flow_execution_plan_attestations
  SET revoked_at = clock_timestamp(), revoked_reason = left(btrim(p_reason),512)
  WHERE id = p_attestation_id AND consumed_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flow execution plan attestation is missing or unavailable'
      USING ERRCODE = '55000';
  END IF;
END;
$function$;

RESET ROLE;
REVOKE ALL ON FUNCTION auth.enforce_flow_execution_plan_attestation_change(),
  auth.issue_flow_execution_plan_attestation(uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz),
  auth.consume_flow_execution_plan_attestation(uuid,bytea,uuid,uuid,jsonb),
  auth.revoke_flow_execution_plan_attestation(uuid,text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.issue_flow_execution_plan_attestation(
  uuid,uuid,uuid,uuid,name,jsonb,bytea,timestamptz
) TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.revoke_flow_execution_plan_attestation(uuid,text)
TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.consume_flow_execution_plan_attestation(
  uuid,bytea,uuid,uuid,jsonb
) TO ba_run_owner;

CREATE TABLE public.flow_executions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  plan_attestation_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  flow_version_id uuid NOT NULL,
  compiled_flow_plan_hash text NOT NULL CHECK (
    compiled_flow_plan_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  resolved_execution_plan_hash text NOT NULL CHECK (
    resolved_execution_plan_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  compiled_flow_plan jsonb NOT NULL CHECK (
    jsonb_typeof(compiled_flow_plan) = 'object'
  ),
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL CHECK (
    producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  producer_lease_expires_at timestamptz NOT NULL,
  authorized_at timestamptz NOT NULL CHECK (authorized_at < producer_lease_expires_at),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT flow_executions_run_key UNIQUE (workspace_id, run_id),
  CONSTRAINT flow_executions_plan_key UNIQUE (
    workspace_id, run_id, compiled_flow_plan_hash
  ),
  CONSTRAINT flow_executions_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.runs(workspace_id, id),
  CONSTRAINT flow_executions_attempt_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id
  ) REFERENCES public.run_attempts(workspace_id, run_id, id)
);

CREATE TABLE public.flow_model_usage_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  flow_execution_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  usage_attribution_id uuid NOT NULL,
  node_id text NOT NULL CHECK (length(btrim(node_id)) BETWEEN 1 AND 256),
  model_attempt_number integer NOT NULL CHECK (model_attempt_number BETWEEN 1 AND 1000),
  producer_operation_key text NOT NULL CHECK (
    length(producer_operation_key) BETWEEN 1 AND 300
    AND length(btrim(producer_operation_key)) BETWEEN 1 AND 300
  ),
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL CHECK (
    producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  producer_lease_expires_at timestamptz NOT NULL,
  authorized_at timestamptz NOT NULL CHECK (authorized_at < producer_lease_expires_at),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT flow_model_usage_receipts_operation_key UNIQUE (
    workspace_id, run_id, producer_operation_key
  ),
  CONSTRAINT flow_model_usage_receipts_execution_fkey FOREIGN KEY (
    workspace_id, flow_execution_id
  ) REFERENCES public.flow_executions(workspace_id, id),
  CONSTRAINT flow_model_usage_receipts_step_fkey FOREIGN KEY (
    workspace_id, run_id, attempt_id, step_id
  ) REFERENCES public.run_steps(workspace_id, run_id, attempt_id, id),
  CONSTRAINT flow_model_usage_receipts_attribution_fkey FOREIGN KEY (
    workspace_id, usage_attribution_id
  ) REFERENCES public.run_usage_attributions(workspace_id, id)
);

CREATE TABLE public.flow_step_checkpoints (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  flow_execution_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  checkpoint_sequence bigint NOT NULL CHECK (
    checkpoint_sequence BETWEEN 1 AND 9007199254740991
  ),
  node_id text NOT NULL CHECK (length(btrim(node_id)) BETWEEN 1 AND 256),
  node_type text NOT NULL CHECK (node_type IN ('start','llm','output')),
  checkpoint_hash text NOT NULL CHECK (checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  model_usage_receipt_id uuid,
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL CHECK (
    producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  producer_lease_expires_at timestamptz NOT NULL,
  authorized_at timestamptz NOT NULL CHECK (authorized_at < producer_lease_expires_at),
  PRIMARY KEY (workspace_id,id),
  CONSTRAINT flow_step_checkpoints_sequence_key UNIQUE (
    workspace_id,flow_execution_id,checkpoint_sequence
  ),
  CONSTRAINT flow_step_checkpoints_hash_key UNIQUE (
    workspace_id,flow_execution_id,checkpoint_hash
  ),
  CONSTRAINT flow_step_checkpoints_execution_fkey FOREIGN KEY (
    workspace_id,flow_execution_id
  ) REFERENCES public.flow_executions(workspace_id,id),
  CONSTRAINT flow_step_checkpoints_run_checkpoint_fkey FOREIGN KEY (
    workspace_id,id
  ) REFERENCES public.run_checkpoints(workspace_id,id),
  CONSTRAINT flow_step_checkpoints_step_fkey FOREIGN KEY (
    workspace_id,run_id,attempt_id,step_id
  ) REFERENCES public.run_steps(workspace_id,run_id,attempt_id,id),
  CONSTRAINT flow_step_checkpoints_usage_fkey FOREIGN KEY (
    workspace_id,model_usage_receipt_id
  ) REFERENCES public.flow_model_usage_receipts(workspace_id,id)
);

ALTER TABLE public.flow_executions OWNER TO ba_run_owner;
ALTER TABLE public.flow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_executions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_executions FROM PUBLIC;
CREATE POLICY flow_executions_owner_access ON public.flow_executions
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);

ALTER TABLE public.flow_model_usage_receipts OWNER TO ba_run_owner;
ALTER TABLE public.flow_model_usage_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_model_usage_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_model_usage_receipts FROM PUBLIC;
CREATE POLICY flow_model_usage_receipts_owner_access ON public.flow_model_usage_receipts
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);

ALTER TABLE public.flow_step_checkpoints OWNER TO ba_run_owner;
ALTER TABLE public.flow_step_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_step_checkpoints FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_step_checkpoints FROM PUBLIC;
CREATE POLICY flow_step_checkpoints_owner_access ON public.flow_step_checkpoints
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);

CREATE FUNCTION app.reject_g1_flow_execution_fact_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'G1 Flow execution facts are immutable'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION app.reject_g1_flow_execution_fact_change() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.reject_g1_flow_execution_fact_change() FROM PUBLIC;

CREATE TRIGGER flow_executions_immutable
BEFORE UPDATE OR DELETE ON public.flow_executions
FOR EACH ROW EXECUTE FUNCTION app.reject_g1_flow_execution_fact_change();
CREATE TRIGGER flow_model_usage_receipts_immutable
BEFORE UPDATE OR DELETE ON public.flow_model_usage_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_g1_flow_execution_fact_change();
CREATE TRIGGER flow_step_checkpoints_immutable
BEFORE UPDATE OR DELETE ON public.flow_step_checkpoints
FOR EACH ROW EXECUTE FUNCTION app.reject_g1_flow_execution_fact_change();

CREATE FUNCTION app.register_flow_execution(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_plan jsonb := p_fact -> 'compiled_flow_plan';
  v_run public.runs%ROWTYPE;
  v_existing public.flow_executions%ROWTYPE;
  v_plan_hash text;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY[
       'run_id','attempt_id','lease_token','lease_fencing_token',
       'flow_execution_id','compiled_flow_plan','plan_attestation_id',
       'plan_attestation_verifier'
     ]) <> '{}'::jsonb
     OR COALESCE(p_fact ->> 'run_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token', '') !~ '^[1-9][0-9]*$'
     OR COALESCE(p_fact ->> 'flow_execution_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'plan_attestation_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'plan_attestation_verifier', '') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_plan) IS DISTINCT FROM 'object'
     OR v_plan ->> 'schema_version' IS DISTINCT FROM 'compiled-flow-plan/1'
     OR v_plan ->> 'checkpoint_contract_version'
          IS DISTINCT FROM 'flow-step-checkpoint/1'
     OR jsonb_typeof(v_plan -> 'steps') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_plan -> 'steps') <> 3
     OR v_plan #>> '{steps,0,node_type}' IS DISTINCT FROM 'start'
     OR v_plan #>> '{steps,1,node_type}' IS DISTINCT FROM 'llm'
     OR v_plan #>> '{steps,2,node_type}' IS DISTINCT FROM 'output'
     OR v_plan #>> '{flow_version,published_resource_kind}' IS DISTINCT FROM 'FLOW_VERSION'
     OR v_plan #>> '{flow_version,binding_mode}' IS DISTINCT FROM 'pinned'
     OR COALESCE(v_plan ->> 'compiled_hash', '') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_plan ->> 'resolved_execution_plan_hash', '')
          !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Flow execution registration fact is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_plan_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_plan - 'compiled_hash'), 'UTF8'
  ), 'sha256'), 'hex');
  IF v_plan_hash IS DISTINCT FROM v_plan ->> 'compiled_hash' THEN
    RAISE EXCEPTION 'compiled FlowPlan hash is invalid' USING ERRCODE = '55000';
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  SELECT run_row.* INTO v_run
  FROM public.runs AS run_row
  WHERE run_row.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND run_row.id = (v_authority ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_run.target_kind <> 'flow'
     OR v_run.flow_id::text IS DISTINCT FROM v_plan #>> '{flow_version,resource_id}'
     OR v_run.flow_version_id::text
          IS DISTINCT FROM v_plan #>> '{flow_version,resource_version_id}'
     OR v_run.accepted_plan_hash
          IS DISTINCT FROM v_plan ->> 'resolved_execution_plan_hash'
     OR v_run.workspace_id::text
          IS DISTINCT FROM v_plan #>> '{flow_version,workspace_id}' THEN
    RAISE EXCEPTION 'FlowPlan does not match the admitted Flow Run'
      USING ERRCODE = '55000';
  END IF;
  SELECT execution.* INTO v_existing
  FROM public.flow_executions AS execution
  WHERE execution.workspace_id = v_run.workspace_id AND execution.run_id = v_run.id;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM (p_fact ->> 'flow_execution_id')::uuid
       OR v_existing.plan_attestation_id IS DISTINCT FROM (p_fact ->> 'plan_attestation_id')::uuid
       OR v_existing.compiled_flow_plan IS DISTINCT FROM v_plan
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'Flow Run already has a different execution binding'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','flow-execution-registration-result/1',
      'flow_execution_id',v_existing.id,'compiled_flow_plan_hash',v_existing.compiled_flow_plan_hash,
      'replayed',true
    );
  END IF;
  PERFORM auth.consume_flow_execution_plan_attestation(
    (p_fact ->> 'plan_attestation_id')::uuid,
    decode(p_fact ->> 'plan_attestation_verifier','hex'),
    v_run.id,
    (p_fact ->> 'flow_execution_id')::uuid,
    v_plan
  );
  INSERT INTO public.flow_executions (
    workspace_id,id,run_id,attempt_id,plan_attestation_id,flow_id,flow_version_id,
    compiled_flow_plan_hash,resolved_execution_plan_hash,compiled_flow_plan,
    producer_session_user,producer_lease_token,producer_lease_fencing_token,
    producer_lease_expires_at,authorized_at
  ) VALUES (
    v_run.workspace_id,(p_fact ->> 'flow_execution_id')::uuid,v_run.id,
    (v_authority ->> 'attempt_id')::uuid,(p_fact ->> 'plan_attestation_id')::uuid,
    v_run.flow_id,v_run.flow_version_id,
    v_plan_hash,v_plan ->> 'resolved_execution_plan_hash',v_plan,
    v_authority ->> 'lease_owner',(v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,v_now
  );
  RETURN jsonb_build_object(
    'schema_version','flow-execution-registration-result/1',
    'flow_execution_id',p_fact ->> 'flow_execution_id',
    'compiled_flow_plan_hash',v_plan_hash,'replayed',false
  );
END;
$function$;
ALTER FUNCTION app.register_flow_execution(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.register_flow_execution(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_flow_execution(jsonb) TO ba_execution_executor;

CREATE FUNCTION app.record_flow_model_usage_receipt(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_authority jsonb;
  v_workspace_id uuid;
  v_existing_reservation_id uuid;
  v_receipt jsonb := p_fact -> 'receipt';
  v_execution public.flow_executions%ROWTYPE;
  v_existing public.flow_model_usage_receipts%ROWTYPE;
  v_effect_class text;
  v_effect_payload_hash text;
  v_effect_disposition text;
  v_effect_result_hash text;
  v_step jsonb;
  v_usage_result jsonb;
  v_receipt_hash text;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY[
       'run_id','attempt_id','lease_token','lease_fencing_token','reservation_id',
       'step_id','receipt'
     ]) <> '{}'::jsonb
     OR COALESCE(p_fact ->> 'run_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token','') !~ '^[1-9][0-9]*$'
     OR COALESCE(p_fact ->> 'reservation_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'step_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(v_receipt) IS DISTINCT FROM 'object'
     OR (v_receipt - ARRAY[
       'schema_version','model_usage_receipt_id','run_id','flow_execution_id',
       'flow_plan_hash','node_id','canonical_node_path_hash','model',
       'model_attempt_number','operation_key','provider_request_hash',
       'result_payload_hash','usage','receipt_hash'
     ]) <> '{}'::jsonb
     OR v_receipt ->> 'schema_version' IS DISTINCT FROM 'flow-model-usage-receipt/1'
     OR COALESCE(v_receipt ->> 'model_usage_receipt_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_receipt ->> 'flow_execution_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_receipt ->> 'run_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_receipt ->> 'run_id' IS DISTINCT FROM p_fact ->> 'run_id'
     OR COALESCE(v_receipt ->> 'receipt_hash', '') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_receipt ->> 'operation_key', '') !~ '^flow-llm:v1:[0-9a-f]{64}$'
     OR COALESCE(v_receipt ->> 'model_attempt_number', '') !~ '^[1-9][0-9]*$'
     OR length(v_receipt ->> 'model_attempt_number') > 4
     OR jsonb_typeof(v_receipt -> 'usage') IS DISTINCT FROM 'object'
     OR ((v_receipt -> 'usage') - ARRAY[
       'schema_version','amount_credits','input_tokens','output_tokens',
       'total_tokens','duration_ms'
     ]) <> '{}'::jsonb
     OR v_receipt #>> '{usage,schema_version}' IS DISTINCT FROM 'capability-budget/1'
     OR COALESCE(v_receipt #>> '{usage,amount_credits}', '') !~ '^(0|[1-9][0-9]*)$'
     OR jsonb_typeof(v_receipt #> '{usage,input_tokens}') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_receipt #> '{usage,output_tokens}') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_receipt #> '{usage,total_tokens}') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_receipt #> '{usage,duration_ms}') IS DISTINCT FROM 'number'
     OR (v_receipt #>> '{usage,input_tokens}') !~ '^(0|[1-9][0-9]*)$'
     OR (v_receipt #>> '{usage,output_tokens}') !~ '^(0|[1-9][0-9]*)$'
     OR (v_receipt #>> '{usage,total_tokens}') !~ '^(0|[1-9][0-9]*)$'
     OR (v_receipt #>> '{usage,duration_ms}') !~ '^[1-9][0-9]*$'
     OR (v_receipt #>> '{usage,total_tokens}')::numeric
          <> (v_receipt #>> '{usage,input_tokens}')::numeric
           + (v_receipt #>> '{usage,output_tokens}')::numeric THEN
    RAISE EXCEPTION 'Flow model usage receipt is invalid' USING ERRCODE = '22023';
  END IF;
  v_receipt_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_receipt - 'receipt_hash'), 'UTF8'
  ), 'sha256'), 'hex');
  IF v_receipt_hash IS DISTINCT FROM v_receipt ->> 'receipt_hash' THEN
    RAISE EXCEPTION 'Flow model usage receipt hash is invalid' USING ERRCODE = '55000';
  END IF;
  v_workspace_id := auth.require_internal_service_phase('execution');
  SELECT stored.* INTO v_existing
  FROM public.flow_model_usage_receipts AS stored
  WHERE stored.workspace_id = v_workspace_id
    AND stored.run_id = (v_receipt ->> 'run_id')::uuid
    AND stored.producer_operation_key = v_receipt ->> 'operation_key';
  IF FOUND THEN
    SELECT attribution.reservation_id INTO v_existing_reservation_id
    FROM public.run_usage_attributions AS attribution
    WHERE attribution.workspace_id = v_existing.workspace_id
      AND attribution.id = v_existing.usage_attribution_id;
    IF v_existing.receipt IS DISTINCT FROM v_receipt
       OR v_existing.attempt_id IS DISTINCT FROM (p_fact ->> 'attempt_id')::uuid
       OR v_existing.step_id IS DISTINCT FROM (p_fact ->> 'step_id')::uuid
       OR v_existing_reservation_id IS DISTINCT FROM (p_fact ->> 'reservation_id')::uuid
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'Flow model operation key conflicts with another receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','flow-model-usage-record-result/1',
      'receipt',v_existing.receipt,'usage_attribution_id',v_existing.usage_attribution_id,
      'replayed',true
    );
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  SELECT execution.* INTO v_execution
  FROM public.flow_executions AS execution
  WHERE execution.workspace_id = (v_authority ->> 'workspace_id')::uuid
    AND execution.id = (v_receipt ->> 'flow_execution_id')::uuid
    AND execution.run_id = (v_authority ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_execution.compiled_flow_plan_hash IS DISTINCT FROM v_receipt ->> 'flow_plan_hash'
     OR v_receipt ->> 'run_id' IS DISTINCT FROM v_execution.run_id::text THEN
    RAISE EXCEPTION 'Flow usage receipt does not match its execution'
      USING ERRCODE = '55000';
  END IF;
  SELECT plan_step.value INTO v_step
  FROM jsonb_array_elements(v_execution.compiled_flow_plan -> 'steps') AS plan_step(value)
  WHERE plan_step.value ->> 'node_id' = v_receipt ->> 'node_id';
  IF NOT FOUND
     OR v_step ->> 'node_type' IS DISTINCT FROM 'llm'
     OR v_step ->> 'canonical_node_path_hash'
          IS DISTINCT FROM v_receipt ->> 'canonical_node_path_hash'
     OR v_step -> 'model' IS DISTINCT FROM v_receipt -> 'model'
     OR (v_receipt ->> 'model_attempt_number')::integer
          > COALESCE((v_step #>> '{retry,max_attempts}')::integer, 1)
     OR (v_receipt #>> '{usage,amount_credits}')::numeric
          > (v_step #>> '{budget,amount_credits}')::numeric
     OR (v_receipt #>> '{usage,input_tokens}')::numeric
          > (v_step #>> '{budget,input_tokens}')::numeric
     OR (v_receipt #>> '{usage,output_tokens}')::numeric
          > (v_step #>> '{budget,output_tokens}')::numeric
     OR (v_receipt #>> '{usage,total_tokens}')::numeric
          > (v_step #>> '{budget,total_tokens}')::numeric THEN
    RAISE EXCEPTION 'Flow usage receipt exceeds or differs from its compiled LLM step'
      USING ERRCODE = '55000';
  END IF;
  IF (v_receipt #>> '{usage,duration_ms}')::numeric
       > (v_step #>> '{budget,duration_ms}')::numeric THEN
    RAISE EXCEPTION 'Flow usage receipt exceeds or differs from its compiled LLM step'
      USING ERRCODE = '55000';
  END IF;
  SELECT receipt.* INTO v_existing
  FROM public.flow_model_usage_receipts AS receipt
  WHERE receipt.workspace_id = v_execution.workspace_id
    AND receipt.run_id = v_execution.run_id
    AND receipt.producer_operation_key = v_receipt ->> 'operation_key';
  IF FOUND THEN
    IF v_existing.receipt IS DISTINCT FROM v_receipt
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'Flow model operation key conflicts with another receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','flow-model-usage-record-result/1',
      'receipt',v_existing.receipt,'usage_attribution_id',v_existing.usage_attribution_id,
      'replayed',true
    );
  END IF;
  SELECT envelope.effect_class, envelope.effect_payload_sha256,
         effect_receipt.disposition, effect_receipt.result_payload_sha256
  INTO v_effect_class, v_effect_payload_hash,
       v_effect_disposition, v_effect_result_hash
  FROM public.run_retry_effect_envelopes AS envelope
  JOIN public.run_side_effect_receipts AS effect_receipt
    ON effect_receipt.workspace_id = envelope.workspace_id
   AND effect_receipt.envelope_id = envelope.id
  WHERE envelope.workspace_id = v_execution.workspace_id
    AND envelope.run_id = v_execution.run_id
    AND envelope.attempt_id = (v_authority ->> 'attempt_id')::uuid
    AND envelope.step_id = (p_fact ->> 'step_id')::uuid
    AND envelope.operation_key = v_receipt ->> 'operation_key'
  FOR UPDATE OF envelope, effect_receipt;
  IF NOT FOUND
     OR v_effect_class <> 'requires_key'
     OR v_effect_payload_hash
          IS DISTINCT FROM v_receipt ->> 'provider_request_hash'
     OR v_effect_disposition <> 'CONFIRMED'
     OR v_effect_result_hash
          IS DISTINCT FROM v_receipt ->> 'result_payload_hash' THEN
    RAISE EXCEPTION 'Flow usage receipt requires its exact confirmed model effect'
      USING ERRCODE = '55000';
  END IF;
  v_usage_result := app.record_usage_attribution(jsonb_build_object(
    'run_id',p_fact ->> 'run_id','attempt_id',p_fact ->> 'attempt_id',
    'lease_token',p_fact ->> 'lease_token',
    'lease_fencing_token',p_fact ->> 'lease_fencing_token',
    'reservation_id',p_fact ->> 'reservation_id','step_id',p_fact ->> 'step_id',
    'producer_operation_key',v_receipt ->> 'operation_key',
    'metering_unit','model_total_tokens',
    'quantity',v_receipt #>> '{usage,total_tokens}',
    'amount',v_receipt #>> '{usage,amount_credits}',
    'detail_redacted',jsonb_build_object(
      'flow_execution_id',v_execution.id,'flow_plan_hash',v_execution.compiled_flow_plan_hash,
      'node_id',v_receipt ->> 'node_id','receipt_hash',v_receipt_hash
    )
  ));
  INSERT INTO public.flow_model_usage_receipts (
    workspace_id,id,flow_execution_id,run_id,attempt_id,step_id,
    usage_attribution_id,node_id,model_attempt_number,producer_operation_key,
    receipt_hash,receipt,producer_session_user,producer_lease_token,
    producer_lease_fencing_token,producer_lease_expires_at,authorized_at
  ) VALUES (
    v_execution.workspace_id,(v_receipt ->> 'model_usage_receipt_id')::uuid,
    v_execution.id,v_execution.run_id,(v_authority ->> 'attempt_id')::uuid,
    (p_fact ->> 'step_id')::uuid,
    (v_usage_result #>> '{source,usage_attribution_id}')::uuid,
    v_receipt ->> 'node_id',(v_receipt ->> 'model_attempt_number')::integer,
    v_receipt ->> 'operation_key',v_receipt_hash,v_receipt,
    v_authority ->> 'lease_owner',(v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,v_now
  );
  RETURN jsonb_build_object(
    'schema_version','flow-model-usage-record-result/1','receipt',v_receipt,
    'usage_attribution_id',v_usage_result #>> '{source,usage_attribution_id}',
    'replayed',false
  );
END;
$function$;
ALTER FUNCTION app.record_flow_model_usage_receipt(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_flow_model_usage_receipt(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_flow_model_usage_receipt(jsonb)
TO ba_execution_executor;

CREATE FUNCTION app.record_flow_step_checkpoint(p_fact jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid;
  v_authority jsonb;
  v_checkpoint jsonb := p_fact -> 'checkpoint';
  v_execution public.flow_executions%ROWTYPE;
  v_existing public.flow_step_checkpoints%ROWTYPE;
  v_previous public.flow_step_checkpoints%ROWTYPE;
  v_predecessor public.flow_step_checkpoints%ROWTYPE;
  v_usage public.flow_model_usage_receipts%ROWTYPE;
  v_plan_step jsonb;
  v_generic jsonb;
  v_checkpoint_hash text;
  v_expected_predecessor_node text;
  v_sequence bigint;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY[
       'run_id','attempt_id','lease_token','lease_fencing_token','step_id','checkpoint'
     ]) <> '{}'::jsonb
     OR COALESCE(p_fact ->> 'run_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token','') !~ '^[1-9][0-9]*$'
     OR COALESCE(p_fact ->> 'step_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(v_checkpoint) IS DISTINCT FROM 'object'
     OR (v_checkpoint - ARRAY[
       'schema_version','run_id','flow_execution_id','flow_plan_hash',
       'checkpoint_sequence','previous_checkpoint_hash','execution_fence',
       'node_id','node_type','canonical_node_path_hash','attempt',
       'predecessor_checkpoint_hashes','output_ref','output_hash',
       'model_usage_receipt_id','model_usage_receipt_hash','checkpoint_hash'
     ]) <> '{}'::jsonb
     OR v_checkpoint ->> 'schema_version' IS DISTINCT FROM 'flow-step-checkpoint/1'
     OR v_checkpoint ->> 'run_id' IS DISTINCT FROM p_fact ->> 'run_id'
     OR COALESCE(v_checkpoint ->> 'flow_execution_id','')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_checkpoint ->> 'flow_plan_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_checkpoint ->> 'checkpoint_sequence','') !~ '^[1-9][0-9]*$'
     OR COALESCE(v_checkpoint ->> 'execution_fence','') !~ '^[1-9][0-9]*$'
     OR v_checkpoint ->> 'execution_fence'
          IS DISTINCT FROM p_fact ->> 'lease_fencing_token'
     OR v_checkpoint ->> 'node_type' NOT IN ('start','llm','output')
     OR jsonb_typeof(v_checkpoint -> 'attempt') IS DISTINCT FROM 'number'
     OR COALESCE(v_checkpoint ->> 'attempt','') !~ '^[1-9][0-9]*$'
     OR length(v_checkpoint ->> 'attempt') > 4
     OR COALESCE(v_checkpoint ->> 'checkpoint_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR (
       v_checkpoint ? 'previous_checkpoint_hash'
       AND COALESCE(v_checkpoint ->> 'previous_checkpoint_hash','')
            !~ '^sha256:[0-9a-f]{64}$'
     )
     OR COALESCE(v_checkpoint ->> 'canonical_node_path_hash','')
          !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_checkpoint ->> 'output_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(length(btrim(v_checkpoint ->> 'output_ref')),0) NOT BETWEEN 1 AND 2048
     OR position('?' IN COALESCE(v_checkpoint ->> 'output_ref','')) <> 0
     OR position('#' IN COALESCE(v_checkpoint ->> 'output_ref','')) <> 0
     OR jsonb_typeof(v_checkpoint -> 'predecessor_checkpoint_hashes')
          IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Flow step checkpoint is invalid' USING ERRCODE = '22023';
  END IF;
  v_sequence := (v_checkpoint ->> 'checkpoint_sequence')::bigint;
  IF v_sequence > 9007199254740991 THEN
    RAISE EXCEPTION 'Flow step checkpoint sequence is invalid' USING ERRCODE = '22003';
  END IF;
  v_checkpoint_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_checkpoint - 'checkpoint_hash'),'UTF8'
  ),'sha256'),'hex');
  IF v_checkpoint_hash IS DISTINCT FROM v_checkpoint ->> 'checkpoint_hash' THEN
    RAISE EXCEPTION 'Flow step checkpoint hash is invalid' USING ERRCODE = '55000';
  END IF;
  v_workspace_id := auth.require_internal_service_phase('execution');
  SELECT stored.* INTO v_existing
  FROM public.flow_step_checkpoints AS stored
  WHERE stored.workspace_id = v_workspace_id
    AND stored.flow_execution_id = (v_checkpoint ->> 'flow_execution_id')::uuid
    AND stored.checkpoint_hash = v_checkpoint_hash;
  IF FOUND THEN
    IF v_existing.checkpoint IS DISTINCT FROM v_checkpoint
       OR v_existing.attempt_id IS DISTINCT FROM (p_fact ->> 'attempt_id')::uuid
       OR v_existing.step_id IS DISTINCT FROM (p_fact ->> 'step_id')::uuid
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'Flow checkpoint hash conflicts with another committed fact'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','flow-step-checkpoint-record-result/1',
      'run_checkpoint_id',v_existing.id,'checkpoint',v_existing.checkpoint,'replayed',true
    );
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  v_now := (v_authority ->> 'validated_at')::timestamptz;
  SELECT execution.* INTO v_execution
  FROM public.flow_executions AS execution
  WHERE execution.workspace_id = v_workspace_id
    AND execution.id = (v_checkpoint ->> 'flow_execution_id')::uuid
    AND execution.run_id = (v_authority ->> 'run_id')::uuid
  FOR UPDATE;
  IF NOT FOUND
     OR v_execution.compiled_flow_plan_hash IS DISTINCT FROM v_checkpoint ->> 'flow_plan_hash' THEN
    RAISE EXCEPTION 'Flow checkpoint does not match its execution' USING ERRCODE = '55000';
  END IF;
  SELECT plan_step.value INTO v_plan_step
  FROM jsonb_array_elements(v_execution.compiled_flow_plan -> 'steps') AS plan_step(value)
  WHERE plan_step.value ->> 'node_id' = v_checkpoint ->> 'node_id';
  IF NOT FOUND
     OR v_plan_step ->> 'node_type' IS DISTINCT FROM v_checkpoint ->> 'node_type'
     OR v_plan_step ->> 'canonical_node_path_hash'
          IS DISTINCT FROM v_checkpoint ->> 'canonical_node_path_hash' THEN
    RAISE EXCEPTION 'Flow checkpoint does not match its compiled step'
      USING ERRCODE = '55000';
  END IF;
  SELECT stored.* INTO v_existing
  FROM public.flow_step_checkpoints AS stored
  WHERE stored.workspace_id = v_workspace_id
    AND stored.flow_execution_id = v_execution.id
    AND stored.checkpoint_hash = v_checkpoint_hash;
  IF FOUND THEN
    IF v_existing.checkpoint IS DISTINCT FROM v_checkpoint
       OR v_existing.attempt_id IS DISTINCT FROM (p_fact ->> 'attempt_id')::uuid
       OR v_existing.step_id IS DISTINCT FROM (p_fact ->> 'step_id')::uuid
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'Flow checkpoint hash conflicts with another committed fact'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'schema_version','flow-step-checkpoint-record-result/1',
      'run_checkpoint_id',v_existing.id,'checkpoint',v_existing.checkpoint,'replayed',true
    );
  END IF;
  SELECT stored.* INTO v_previous
  FROM public.flow_step_checkpoints AS stored
  WHERE stored.workspace_id = v_workspace_id
    AND stored.flow_execution_id = v_execution.id
  ORDER BY stored.checkpoint_sequence DESC LIMIT 1
  FOR UPDATE;
  IF v_sequence = 1 THEN
    IF FOUND OR v_checkpoint ? 'previous_checkpoint_hash' THEN
      RAISE EXCEPTION 'first Flow checkpoint cannot extend another commit'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NOT FOUND
     OR v_previous.checkpoint_sequence + 1 <> v_sequence
     OR v_previous.checkpoint_hash
          IS DISTINCT FROM v_checkpoint ->> 'previous_checkpoint_hash' THEN
    RAISE EXCEPTION 'Flow checkpoint does not extend the exact committed sequence'
      USING ERRCODE = '55000';
  END IF;
  v_expected_predecessor_node := v_plan_step #>> '{predecessor_node_ids,0}';
  IF v_expected_predecessor_node IS NULL THEN
    IF jsonb_array_length(v_checkpoint -> 'predecessor_checkpoint_hashes') <> 0 THEN
      RAISE EXCEPTION 'Flow checkpoint has unexpected predecessor evidence'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF jsonb_array_length(v_checkpoint -> 'predecessor_checkpoint_hashes') <> 1 THEN
      RAISE EXCEPTION 'Flow checkpoint omits its exact Plan predecessor'
        USING ERRCODE = '55000';
    END IF;
    SELECT stored.* INTO v_predecessor
    FROM public.flow_step_checkpoints AS stored
    WHERE stored.workspace_id = v_workspace_id
      AND stored.flow_execution_id = v_execution.id
      AND stored.node_id = v_expected_predecessor_node
      AND stored.checkpoint_hash = v_checkpoint #>> '{predecessor_checkpoint_hashes,0}';
    IF NOT FOUND OR v_predecessor.checkpoint_sequence >= v_sequence THEN
      RAISE EXCEPTION 'Flow checkpoint predecessor is missing, foreign or stale'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_checkpoint ->> 'node_type' = 'llm' THEN
    IF COALESCE(v_checkpoint ->> 'model_usage_receipt_id','')
         !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(v_checkpoint ->> 'model_usage_receipt_hash','')
         !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'LLM checkpoint requires exact model usage evidence'
        USING ERRCODE = '22023';
    END IF;
    SELECT usage_receipt.* INTO v_usage
    FROM public.flow_model_usage_receipts AS usage_receipt
    WHERE usage_receipt.workspace_id = v_workspace_id
      AND usage_receipt.id = (v_checkpoint ->> 'model_usage_receipt_id')::uuid
      AND usage_receipt.flow_execution_id = v_execution.id
      AND usage_receipt.run_id = v_execution.run_id
      AND usage_receipt.node_id = v_checkpoint ->> 'node_id'
      AND usage_receipt.receipt_hash = v_checkpoint ->> 'model_usage_receipt_hash';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LLM checkpoint model usage evidence is unavailable'
        USING ERRCODE = '55000';
    END IF;
    IF v_usage.model_attempt_number <> (v_checkpoint ->> 'attempt')::integer THEN
      RAISE EXCEPTION 'LLM checkpoint attempt differs from its model usage receipt'
        USING ERRCODE = '55000';
    END IF;
  ELSIF v_checkpoint ? 'model_usage_receipt_id'
     OR v_checkpoint ? 'model_usage_receipt_hash' THEN
    RAISE EXCEPTION 'non-LLM checkpoint cannot consume model usage evidence'
      USING ERRCODE = '22023';
  END IF;
  v_generic := app.record_execution_checkpoint(jsonb_build_object(
    'run_id',p_fact ->> 'run_id','attempt_id',p_fact ->> 'attempt_id',
    'lease_token',p_fact ->> 'lease_token',
    'lease_fencing_token',p_fact ->> 'lease_fencing_token',
    'step_id',p_fact ->> 'step_id','checkpoint_ref',v_checkpoint ->> 'output_ref',
    'checkpoint_sha256',v_checkpoint_hash,
    'payload_redacted',jsonb_build_object(
      'flow_execution_id',v_execution.id,'flow_plan_hash',v_execution.compiled_flow_plan_hash,
      'node_id',v_checkpoint ->> 'node_id','node_type',v_checkpoint ->> 'node_type'
    )
  ));
  INSERT INTO public.flow_step_checkpoints (
    workspace_id,id,flow_execution_id,run_id,attempt_id,step_id,
    checkpoint_sequence,node_id,node_type,checkpoint_hash,checkpoint,
    model_usage_receipt_id,producer_session_user,producer_lease_token,
    producer_lease_fencing_token,producer_lease_expires_at,authorized_at
  ) VALUES (
    v_workspace_id,(v_generic ->> 'checkpoint_id')::uuid,v_execution.id,v_execution.run_id,
    (v_authority ->> 'attempt_id')::uuid,(p_fact ->> 'step_id')::uuid,v_sequence,
    v_checkpoint ->> 'node_id',v_checkpoint ->> 'node_type',v_checkpoint_hash,v_checkpoint,
    CASE WHEN v_checkpoint ->> 'node_type' = 'llm'
      THEN (v_checkpoint ->> 'model_usage_receipt_id')::uuid ELSE NULL END,
    v_authority ->> 'lease_owner',(v_authority ->> 'lease_token')::uuid,
    (v_authority ->> 'lease_fencing_token')::bigint,
    (v_authority ->> 'lease_expires_at')::timestamptz,v_now
  );
  RETURN jsonb_build_object(
    'schema_version','flow-step-checkpoint-record-result/1',
    'run_checkpoint_id',v_generic ->> 'checkpoint_id','checkpoint',v_checkpoint,'replayed',false
  );
END;
$function$;
ALTER FUNCTION app.record_flow_step_checkpoint(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.record_flow_step_checkpoint(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_flow_step_checkpoint(jsonb)
TO ba_execution_executor;

REVOKE CREATE ON SCHEMA public FROM ba_run_owner;
REVOKE CREATE ON SCHEMA app FROM ba_run_owner;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA auth FROM ba_authorization_owner;
