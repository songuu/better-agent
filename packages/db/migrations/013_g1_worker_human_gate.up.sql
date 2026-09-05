-- G1-A5 Human Gate resume. The runtime receives one definer transaction and
-- never receives table DML; authenticated identity is derived from context.

GRANT USAGE, CREATE ON SCHEMA app TO ba_run_owner;
GRANT CREATE ON SCHEMA public TO ba_run_owner;
GRANT SELECT (id,workspace_id,ingress_channel)
  ON public.flow_deployments TO ba_run_owner;
GRANT SELECT (workspace_id,flow_deployment_id,status)
  ON public.flow_deployment_security_states TO ba_run_owner;
GRANT SELECT (
  workspace_id,flow_deployment_id,credential_id,credential_kind,ingress_channel,
  scope,status,not_before_at,expires_at
) ON public.flow_deployment_entry_grants TO ba_run_owner;
GRANT SELECT (
  workspace_id,id,credential_kind,status,revoked_at,not_before_at,expires_at
) ON public.api_credentials TO ba_run_owner;
GRANT SELECT (workspace_id,credential_id,credential_kind,scope)
  ON public.api_credential_scopes TO ba_run_owner;
SET LOCAL ROLE ba_run_owner;

CREATE TABLE public.human_gate_evidence (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  gate_id uuid NOT NULL,
  mutation_id uuid NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('CLAIM','DECISION')),
  object_ref text NOT NULL CHECK (length(btrim(object_ref)) BETWEEN 1 AND 2048),
  object_sha256 text NOT NULL CHECK (object_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  private_payload jsonb NOT NULL CHECK (jsonb_typeof(private_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,mutation_id,evidence_kind),
  UNIQUE (workspace_id,object_ref),
  FOREIGN KEY (workspace_id,gate_id,run_id)
    REFERENCES public.human_gates(workspace_id,id,run_id),
  FOREIGN KEY (workspace_id,mutation_id)
    REFERENCES public.run_mutation_idempotency(workspace_id,id)
);
ALTER TABLE public.human_gate_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_gate_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY human_gate_evidence_owner_access ON public.human_gate_evidence
  FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
CREATE TRIGGER human_gate_evidence_immutable BEFORE UPDATE OR DELETE
  ON public.human_gate_evidence FOR EACH ROW
  EXECUTE FUNCTION app.reject_g006_immutable_change();

ALTER TABLE public.run_mutation_idempotency
  ADD CONSTRAINT run_mutation_idempotency_gate_fkey
  FOREIGN KEY (workspace_id, target_gate_id, target_run_id)
  REFERENCES public.human_gates(workspace_id, id, run_id);

ALTER TABLE public.run_events DROP CONSTRAINT run_events_event_type_check;
ALTER TABLE public.run_events ADD CONSTRAINT run_events_event_type_check CHECK (event_type IN (
  'RUN_ACCEPTED','RUN_QUEUED','RUN_STARTED','RUN_RETRY_WAIT','RUN_RECOVERING',
  'RUN_CANCEL_REQUESTED','RUN_FINISHED','ATTEMPT_LEASED','ATTEMPT_FINISHED',
  'STEP_STARTED','STEP_FINISHED','CREDIT_RESERVED','CREDIT_SETTLED',
  'OUTBOX_ENQUEUED','SSE_TASK','RUN_WAITING','RUN_RESUMED','RUN_TERMINAL_INTENT'
));

CREATE FUNCTION app.require_human_gate_authorization(
  p_run_id uuid, p_auth jsonb, p_revalidate_resume boolean
) RETURNS public.runs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_run public.runs%ROWTYPE;
  v_workspace_id uuid := app.current_workspace_id();
  v_credential_id uuid := app.current_api_credential_id();
  v_now timestamptz := clock_timestamp();
BEGIN
  -- Historical key hits use only the original-target read gate. They must not
  -- revalidate current resume authority or gate state.
  v_run := app.require_original_run_authorization(p_run_id, 'run:read', p_auth);
  IF NOT p_revalidate_resume OR jsonb_typeof(p_auth -> 'browserIdentity') = 'object' THEN
    RETURN v_run;
  END IF;
  IF v_credential_id IS NULL OR v_workspace_id IS DISTINCT FROM v_run.workspace_id THEN
    RAISE EXCEPTION 'Human Gate resume has no service principal' USING ERRCODE = '42501';
  END IF;
  IF v_run.target_kind = 'agent' THEN
    PERFORM 1 FROM public.agent_deployments AS deployment
    JOIN public.agent_deployment_security_states AS security_state
      ON security_state.workspace_id=deployment.workspace_id
     AND security_state.agent_deployment_id=deployment.id
    JOIN public.agent_deployment_entry_grants AS grant_row
      ON grant_row.workspace_id=deployment.workspace_id
     AND grant_row.agent_deployment_id=deployment.id
    JOIN public.api_credentials AS credential
      ON credential.workspace_id=grant_row.workspace_id AND credential.id=grant_row.credential_id
     AND credential.credential_kind=grant_row.credential_kind
    JOIN public.api_credential_scopes AS literal_scope
      ON literal_scope.workspace_id=credential.workspace_id
     AND literal_scope.credential_id=credential.id
     AND literal_scope.credential_kind=credential.credential_kind
     AND literal_scope.scope=grant_row.scope
    WHERE deployment.workspace_id=v_workspace_id AND deployment.id=v_run.agent_deployment_id
      AND deployment.ingress_channel='service_api' AND security_state.status='ACTIVE'
      AND grant_row.credential_id=v_credential_id AND grant_row.credential_kind='service_api'
      AND grant_row.ingress_channel='service_api' AND grant_row.scope='run:resume'
      AND grant_row.status='ACTIVE' AND credential.status IN ('active','overlap')
      AND credential.revoked_at IS NULL
      AND (credential.not_before_at IS NULL OR credential.not_before_at<=v_now)
      AND (credential.expires_at IS NULL OR credential.expires_at>v_now)
      AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at<=v_now)
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at>v_now)
      AND literal_scope.scope='run:resume';
  ELSE
    PERFORM 1 FROM public.flow_deployments AS deployment
    JOIN public.flow_deployment_security_states AS security_state
      ON security_state.workspace_id=deployment.workspace_id
     AND security_state.flow_deployment_id=deployment.id
    JOIN public.flow_deployment_entry_grants AS grant_row
      ON grant_row.workspace_id=deployment.workspace_id
     AND grant_row.flow_deployment_id=deployment.id
    JOIN public.api_credentials AS credential
      ON credential.workspace_id=grant_row.workspace_id AND credential.id=grant_row.credential_id
     AND credential.credential_kind=grant_row.credential_kind
    JOIN public.api_credential_scopes AS literal_scope
      ON literal_scope.workspace_id=credential.workspace_id
     AND literal_scope.credential_id=credential.id
     AND literal_scope.credential_kind=credential.credential_kind
     AND literal_scope.scope=grant_row.scope
    WHERE deployment.workspace_id=v_workspace_id AND deployment.id=v_run.flow_deployment_id
      AND deployment.ingress_channel='service_api' AND security_state.status='ACTIVE'
      AND grant_row.credential_id=v_credential_id AND grant_row.credential_kind='service_api'
      AND grant_row.ingress_channel='service_api' AND grant_row.scope='run:resume'
      AND grant_row.status='ACTIVE' AND credential.status IN ('active','overlap')
      AND credential.revoked_at IS NULL
      AND (credential.not_before_at IS NULL OR credential.not_before_at<=v_now)
      AND (credential.expires_at IS NULL OR credential.expires_at>v_now)
      AND (grant_row.not_before_at IS NULL OR grant_row.not_before_at<=v_now)
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at>v_now)
      AND literal_scope.scope='run:resume';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current run:resume grant is unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN v_run;
END;
$function$;

CREATE FUNCTION app.resume_human_gate(p_fact jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_workspace_id uuid := app.current_workspace_id();
  v_run_id uuid := (p_fact->>'runId')::uuid;
  v_gate_id uuid := (p_fact->>'gateId')::uuid;
  v_key text := p_fact->>'idempotencyKey';
  v_action text := p_fact->>'action';
  v_principal jsonb := p_fact->'authenticatedPrincipal';
  v_principal_kind text := v_principal->>'kind';
  v_credential_id uuid;
  v_end_user_id uuid;
  v_intent jsonb;
  v_intent_hash text;
  v_mutation public.run_mutation_idempotency%ROWTYPE;
  v_mutation_id uuid;
  v_run public.runs%ROWTYPE;
  v_gate public.human_gates%ROWTYPE;
  v_next_gate public.human_gates%ROWTYPE;
  v_actor text;
  v_claim_ref text;
  v_decision_ref text;
  v_claim_hash text;
  v_decision_hash text;
  v_sequence bigint;
  v_attempt_number bigint;
  v_outcome text;
  v_receipt_data jsonb;
  v_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_fact) <> 'object'
     OR NOT (p_fact ?& ARRAY['workspaceId','authenticatedPrincipal','browserIdentity',
       'idempotencyKey','runId','gateId','action','requiredScope'])
     OR (p_fact - ARRAY['workspaceId','authenticatedPrincipal','browserIdentity',
       'idempotencyKey','runId','gateId','action','input','requiredScope'
       ]) <> '{}'::jsonb
     OR p_fact->>'requiredScope' <> 'run:resume'
     OR jsonb_typeof(v_principal) IS DISTINCT FROM 'object'
     OR v_principal->>'schema_version' IS DISTINCT FROM 'conversation-principal/1'
     OR v_workspace_id IS NULL OR (p_fact->>'workspaceId')::uuid IS DISTINCT FROM v_workspace_id
     OR length(v_key) NOT BETWEEN 1 AND 128
     OR v_action NOT IN ('submit','approve','reject')
     OR (v_action='submit' AND jsonb_typeof(p_fact->'input') IS DISTINCT FROM 'object')
     OR (v_action<>'submit' AND p_fact ? 'input') THEN
    RAISE EXCEPTION 'invalid Human Gate resume intent' USING ERRCODE = '22023';
  END IF;
  IF v_principal_kind='credential' THEN
    v_credential_id := app.current_api_credential_id();
    IF (v_principal-ARRAY['schema_version','kind','credential_id'])<>'{}'::jsonb
       OR v_credential_id IS NULL
       OR (v_principal->>'credential_id')::uuid IS DISTINCT FROM v_credential_id
       OR (p_fact ? 'browserIdentity'
         AND p_fact->'browserIdentity' IS DISTINCT FROM 'null'::jsonb) THEN
      RAISE EXCEPTION 'Human Gate principal mismatch' USING ERRCODE = '42501';
    END IF;
    v_actor := 'credential:'||v_credential_id::text;
  ELSIF v_principal_kind='end_user' THEN
    v_end_user_id := (v_principal->>'end_user_principal_id')::uuid;
    IF (v_principal-ARRAY['schema_version','kind','end_user_principal_id'])<>'{}'::jsonb
       OR jsonb_typeof(p_fact->'browserIdentity') IS DISTINCT FROM 'object'
       OR app.current_authenticated_principal_id() IS DISTINCT FROM 'end_user:'||v_end_user_id::text THEN
      RAISE EXCEPTION 'Human Gate browser principal mismatch' USING ERRCODE = '42501';
    END IF;
    v_actor := 'end_user:'||v_end_user_id::text;
  ELSE
    RAISE EXCEPTION 'invalid Human Gate principal' USING ERRCODE = '42501';
  END IF;

  v_intent := jsonb_build_object('intent_schema','intent/1','route',
    '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume','request',
    jsonb_build_object('run_id',v_run_id,'gate_id',v_gate_id,'action',v_action));
  IF v_action='submit' THEN
    v_intent := jsonb_set(v_intent,'{request,input}',p_fact->'input');
  END IF;
  v_intent_hash := 'sha256:'||encode(public.digest(convert_to(
    app.g007_canonical_json(v_intent),'UTF8'),'sha256'),'hex');

  SELECT mutation.* INTO v_mutation FROM public.run_mutation_idempotency AS mutation
  WHERE mutation.workspace_id=v_workspace_id AND mutation.principal_kind=v_principal_kind
    AND mutation.credential_id IS NOT DISTINCT FROM v_credential_id
    AND mutation.end_user_principal_id IS NOT DISTINCT FROM v_end_user_id
    AND mutation.fixed_route='/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'
    AND mutation.idempotency_key=v_key FOR UPDATE;
  IF FOUND THEN
    v_run := app.require_human_gate_authorization(v_mutation.target_run_id,p_fact,false);
    IF v_mutation.target_run_id IS DISTINCT FROM v_run_id
       OR v_mutation.target_gate_id IS DISTINCT FROM v_gate_id
       OR v_mutation.intent_hash IS DISTINCT FROM v_intent_hash THEN
      RAISE EXCEPTION 'Human Gate Idempotency-Key reused' USING ERRCODE = '23505';
    END IF;
    IF v_mutation.http_status IS NULL OR v_mutation.completed_at IS NULL THEN
      RAISE EXCEPTION 'Human Gate receipt is incomplete' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('outcome', 'REPLAY', 'receipt',v_mutation.receipt_data_redacted);
  END IF;

  v_run := app.require_human_gate_authorization(v_run_id,p_fact,true);
  INSERT INTO public.run_mutation_idempotency (
    workspace_id,id,principal_kind,credential_id,end_user_principal_id,fixed_route,
    idempotency_key,target_run_id,target_gate_id,intent_hash,receipt_data_redacted,
    active,expires_at,created_at
  ) VALUES (
    v_workspace_id,gen_random_uuid(),v_principal_kind,v_credential_id,v_end_user_id,
    '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',v_key,v_run_id,v_gate_id,
    v_intent_hash,'{}'::jsonb,true,v_now+interval '24 hours',v_now
  ) ON CONFLICT DO NOTHING RETURNING id INTO v_mutation_id;
  IF v_mutation_id IS NULL THEN
    SELECT mutation.* INTO v_mutation FROM public.run_mutation_idempotency AS mutation
    WHERE mutation.workspace_id=v_workspace_id AND mutation.principal_kind=v_principal_kind
      AND mutation.credential_id IS NOT DISTINCT FROM v_credential_id
      AND mutation.end_user_principal_id IS NOT DISTINCT FROM v_end_user_id
      AND mutation.fixed_route='/v1/oapi/runs/{run_id}/gates/{gate_id}/resume'
      AND mutation.idempotency_key=v_key FOR UPDATE;
    v_run := app.require_human_gate_authorization(v_mutation.target_run_id,p_fact,false);
    IF v_mutation.target_run_id IS DISTINCT FROM v_run_id
       OR v_mutation.target_gate_id IS DISTINCT FROM v_gate_id
       OR v_mutation.intent_hash IS DISTINCT FROM v_intent_hash THEN
      RAISE EXCEPTION 'Human Gate Idempotency-Key reused' USING ERRCODE = '23505';
    END IF;
    IF v_mutation.http_status IS NULL THEN
      RAISE EXCEPTION 'concurrent Human Gate receipt is incomplete' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('outcome','REPLAY','receipt',v_mutation.receipt_data_redacted);
  END IF;

  SELECT gate_row.* INTO v_gate FROM public.human_gates AS gate_row
  WHERE gate_row.workspace_id=v_workspace_id AND gate_row.id=v_gate_id
    AND gate_row.run_id=v_run_id FOR UPDATE OF gate_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Human Gate is unavailable' USING ERRCODE='P0002'; END IF;
  IF v_gate.status<>'PENDING' OR v_run.status NOT IN ('WAITING_FOR_INPUT','WAITING_FOR_APPROVAL')
     OR v_gate.resolved_plan_hash IS DISTINCT FROM v_run.accepted_plan_hash THEN
    RAISE EXCEPTION 'Human Gate is not resumable' USING ERRCODE='23505';
  END IF;
  IF v_gate.expires_at<=v_now THEN RAISE EXCEPTION 'Human Gate expired' USING ERRCODE='P0003'; END IF;
  IF (v_gate.gate_type='INPUT') IS DISTINCT FROM (v_action='submit') THEN
    RAISE EXCEPTION 'Human Gate action does not match type' USING ERRCODE='22023';
  END IF;
  v_claim_ref := 'human-gate-evidence:'||v_mutation_id::text||':claim';
  v_decision_ref := 'human-gate-evidence:'||v_mutation_id::text||':decision';
  v_claim_hash := 'sha256:'||encode(public.digest(convert_to(
    app.g007_canonical_json(jsonb_build_object('actor',v_actor,'claim_ref',v_claim_ref)),'UTF8'),'sha256'),'hex');
  v_decision_hash := 'sha256:'||encode(public.digest(convert_to(
    app.g007_canonical_json(jsonb_build_object('action',v_action,'input',COALESCE(p_fact->'input','{}'::jsonb))),
    'UTF8'),'sha256'),'hex');
  INSERT INTO public.human_gate_evidence (
    workspace_id,id,run_id,gate_id,mutation_id,evidence_kind,object_ref,
    object_sha256,private_payload,created_at
  ) VALUES
    (v_workspace_id,gen_random_uuid(),v_run_id,v_gate_id,v_mutation_id,'CLAIM',
      v_claim_ref,v_claim_hash,jsonb_build_object('actor',v_actor,'claim_ref',v_claim_ref),v_now),
    (v_workspace_id,gen_random_uuid(),v_run_id,v_gate_id,v_mutation_id,'DECISION',
      v_decision_ref,v_decision_hash,jsonb_build_object('action',v_action,
        'input',COALESCE(p_fact->'input','{}'::jsonb)),v_now);
  UPDATE public.human_gates SET status='CLAIMED',claimed_by=v_actor,claim_ref=v_claim_ref,
    claim_hash=v_claim_hash,claimed_at=v_now WHERE workspace_id=v_workspace_id AND id=v_gate_id;
  UPDATE public.human_gates SET status=CASE WHEN v_action='reject' THEN 'REJECTED' ELSE 'APPROVED' END,
    decision_kind=CASE WHEN v_action='reject' THEN 'REJECT' ELSE 'APPROVE' END,
    decision_ref=v_decision_ref,decision_hash=v_decision_hash,decided_by=v_actor,
    decided_at=v_now,resolved_at=v_now WHERE workspace_id=v_workspace_id AND id=v_gate_id;

  v_sequence := v_run.last_event_sequence+1;
  IF v_action='reject' THEN
    v_outcome := 'TERMINAL_INTENT_ACCEPTED';
    INSERT INTO public.run_events VALUES (v_workspace_id,gen_random_uuid(),v_run_id,v_sequence,
      'RUN_TERMINAL_INTENT','gate-finalize:'||v_gate.id::text,
      jsonb_build_object('type','run.terminal_intent','gate_id',v_gate.id),v_now);
    INSERT INTO public.outbox (workspace_id,id,run_id,message_type,dedupe_key,payload_ref,
      payload_hash,producer_fencing_token,payload_redacted,status,available_at,created_at)
    VALUES (v_workspace_id,gen_random_uuid(),v_run_id,'RUN_DISPATCH','gate-finalize:'||v_gate.id::text,
      v_decision_ref,v_decision_hash,1,jsonb_build_object('kind','FINALIZE_REJECTED_GATE'),'PENDING',v_now,v_now);
    UPDATE public.runs SET status='CANCEL_REQUESTED',execution_status='CANCELLING',
      last_event_sequence=v_sequence
      WHERE workspace_id=v_workspace_id AND id=v_run_id;
  ELSE
    SELECT gate_row.* INTO v_next_gate FROM public.human_gates AS gate_row
    WHERE gate_row.workspace_id=v_workspace_id AND gate_row.run_id=v_run_id
      AND gate_row.status='PENDING' AND gate_row.barrier_generation>v_gate.barrier_generation
    ORDER BY gate_row.barrier_generation,gate_row.id LIMIT 1 FOR UPDATE OF gate_row;
    IF FOUND THEN
      v_outcome := 'NEXT_GATE_WAITING';
      INSERT INTO public.run_events VALUES (v_workspace_id,gen_random_uuid(),v_run_id,v_sequence,
        'RUN_WAITING','gate-waiting:'||v_next_gate.id::text,
        jsonb_build_object('type','run.waiting','gate_id',v_next_gate.id),v_now);
      UPDATE public.runs SET status=CASE WHEN v_next_gate.gate_type='INPUT' THEN 'WAITING_FOR_INPUT'
        ELSE 'WAITING_FOR_APPROVAL' END,execution_status=CASE WHEN v_next_gate.gate_type='INPUT'
        THEN 'WAITING_FOR_INPUT' ELSE 'WAITING_FOR_APPROVAL' END,last_event_sequence=v_sequence
        WHERE workspace_id=v_workspace_id AND id=v_run_id;
    ELSE
      v_outcome := 'RUN_RESUMED';
      SELECT COALESCE(max(attempt_number),0)+1 INTO v_attempt_number FROM public.run_attempts
        WHERE workspace_id=v_workspace_id AND run_id=v_run_id;
      INSERT INTO public.run_attempts (workspace_id,id,run_id,attempt_number,status,
        runtime_protocol_version,lease_generation) VALUES
        (v_workspace_id,gen_random_uuid(),v_run_id,v_attempt_number,'PENDING',5,0);
      INSERT INTO public.run_events VALUES (v_workspace_id,gen_random_uuid(),v_run_id,v_sequence,
        'RUN_RESUMED','gate-resume:'||v_gate.id::text,
        jsonb_build_object('type','run.resumed','gate_id',v_gate.id,'action',v_action),v_now);
      INSERT INTO public.outbox (workspace_id,id,run_id,message_type,dedupe_key,payload_ref,
        payload_hash,producer_fencing_token,payload_redacted,status,available_at,created_at)
      VALUES (v_workspace_id,gen_random_uuid(),v_run_id,'RUN_DISPATCH','gate-resume:'||v_gate.id::text,
        v_decision_ref,v_decision_hash,1,jsonb_build_object('kind','RESUME_GATE'),'PENDING',v_now,v_now);
      UPDATE public.runs SET status='RESUMING',execution_status='RESUMING',last_event_sequence=v_sequence
        WHERE workspace_id=v_workspace_id AND id=v_run_id;
    END IF;
  END IF;
  v_receipt_data := jsonb_build_object(
    'run_id',v_run_id,'accepted_request_id',v_run.accepted_request_id,
    'status','RUNNING','outcome',v_outcome,
    'operation_url','/v1/oapi/runs/'||v_run_id::text,
    'events_url','/v1/oapi/runs/'||v_run_id::text||'/events');
  IF v_outcome='NEXT_GATE_WAITING' THEN
    v_receipt_data := v_receipt_data||jsonb_build_object('pending_action',
      jsonb_build_object('gate_id',v_next_gate.id,'type',lower(v_next_gate.gate_type),
        'actions',CASE WHEN v_next_gate.gate_type='INPUT' THEN '["submit"]'::jsonb
          ELSE '["approve","reject"]'::jsonb END,
        'expires_at',v_next_gate.expires_at)
      ||CASE WHEN v_next_gate.gate_type='INPUT'
        THEN jsonb_build_object('schema',v_next_gate.public_schema) ELSE '{}'::jsonb END);
  END IF;
  v_receipt := jsonb_build_object('http_status',202,'data',v_receipt_data);
  UPDATE public.run_mutation_idempotency SET http_status=202,receipt_data_redacted=v_receipt,
    event_sequence=v_sequence,completed_at=v_now WHERE workspace_id=v_workspace_id AND id=v_mutation_id;
  RETURN jsonb_build_object('outcome','ACCEPTED','receipt',v_receipt);
END;
$function$;

REVOKE ALL ON FUNCTION app.require_human_gate_authorization(uuid,jsonb,boolean),
  app.resume_human_gate(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resume_human_gate(jsonb) TO ba_runtime;
RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_run_owner;
REVOKE CREATE ON SCHEMA public FROM ba_run_owner;
