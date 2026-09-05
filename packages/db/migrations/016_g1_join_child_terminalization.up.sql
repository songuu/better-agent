-- G1-A5 production child terminalization. Execution authors one immutable
-- terminal intent; billing closes only that child's allocation against the
-- shared root reservation; the finalizer writes the durable Run tombstone.

SET LOCAL ROLE ba_billing_owner;
GRANT REFERENCES (workspace_id,id) ON public.run_budget_allocations TO ba_run_owner;
CREATE FUNCTION app.require_active_join_child_allocation(
  p_workspace_id uuid,p_child_run_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE v_allocation public.run_budget_allocations%ROWTYPE;
BEGIN
  IF p_workspace_id IS DISTINCT FROM app.current_workspace_id() OR p_child_run_id IS NULL THEN
    RAISE EXCEPTION 'invalid active join allocation lookup' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_allocation FROM public.run_budget_allocations
    WHERE workspace_id=p_workspace_id AND child_run_id=p_child_run_id FOR SHARE;
  IF NOT FOUND OR v_allocation.status<>'ACTIVE' THEN
    RAISE EXCEPTION 'join-child allocation is not active' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('allocation_id',v_allocation.id,
    'parent_run_id',v_allocation.parent_run_id,
    'billing_owner_run_id',v_allocation.billing_owner_run_id,
    'reservation_id',v_allocation.parent_reservation_id,
    'allocated_credits',v_allocation.allocated_credits::text);
END;
$function$;
REVOKE ALL ON FUNCTION app.require_active_join_child_allocation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_active_join_child_allocation(uuid,uuid) TO ba_run_owner;
RESET ROLE;

SET LOCAL ROLE ba_run_owner;
CREATE TABLE public.join_child_terminal_intents (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  billing_owner_run_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  terminal_status text NOT NULL CHECK (terminal_status IN (
    'SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_ATTENTION'
  )),
  termination_reason text NOT NULL,
  terminal_result_redacted jsonb,
  terminal_error_redacted jsonb,
  terminal_payload_sha256 text NOT NULL CHECK (terminal_payload_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  settle_credits bigint NOT NULL CHECK (settle_credits>=0),
  producer_operation_key text NOT NULL CHECK (length(btrim(producer_operation_key)) BETWEEN 1 AND 300),
  producer_request_sha256 text NOT NULL CHECK (producer_request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  producer_session_user name NOT NULL,
  producer_lease_token uuid NOT NULL,
  producer_lease_fencing_token bigint NOT NULL CHECK (
    producer_lease_fencing_token BETWEEN 1 AND 9007199254740991
  ),
  producer_lease_expires_at timestamptz NOT NULL,
  source_authority_hash text NOT NULL CHECK (source_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,child_run_id),
  UNIQUE (workspace_id,child_run_id,producer_operation_key),
  FOREIGN KEY (workspace_id,child_run_id,parent_run_id)
    REFERENCES public.run_parent_links(workspace_id,child_run_id,parent_run_id),
  FOREIGN KEY (workspace_id,allocation_id)
    REFERENCES public.run_budget_allocations(workspace_id,id),
  FOREIGN KEY (workspace_id,child_run_id,attempt_id)
    REFERENCES public.run_attempts(workspace_id,run_id,id),
  FOREIGN KEY (workspace_id,child_run_id,attempt_id,step_id)
    REFERENCES public.run_steps(workspace_id,run_id,attempt_id,id),
  CONSTRAINT join_child_terminal_intents_payload_check CHECK ((
    terminal_status='SUCCEEDED'
    AND jsonb_typeof(terminal_result_redacted)='object'
    AND terminal_error_redacted IS NULL
  ) OR (
    terminal_status<>'SUCCEEDED'
    AND terminal_result_redacted IS NULL
    AND jsonb_typeof(terminal_error_redacted)='object'
  )),
  CONSTRAINT join_child_terminal_intents_lease_window_check CHECK (
    authorized_at<producer_lease_expires_at
  )
);
ALTER TABLE public.join_child_terminal_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.join_child_terminal_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY join_child_terminal_intents_owner_access
  ON public.join_child_terminal_intents FOR ALL TO ba_run_owner
  USING (workspace_id=app.current_workspace_id())
  WITH CHECK (workspace_id=app.current_workspace_id());
CREATE TRIGGER join_child_terminal_intents_immutable BEFORE UPDATE OR DELETE
  ON public.join_child_terminal_intents FOR EACH ROW
  EXECUTE FUNCTION app.reject_g006_immutable_change();
REVOKE ALL ON TABLE public.join_child_terminal_intents FROM PUBLIC;

CREATE FUNCTION app.commit_join_child_terminal_intent(p_fact jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid;
  v_authority jsonb;
  v_child public.runs%ROWTYPE;
  v_link public.run_parent_links%ROWTYPE;
  v_allocation jsonb;
  v_existing public.join_child_terminal_intents%ROWTYPE;
  v_status text := p_fact->>'terminal_status';
  v_reason text := p_fact->>'termination_reason';
  v_settle_credits bigint := (p_fact->>'settled_credits')::bigint;
  v_payload jsonb := p_fact->'terminal_payload_redacted';
  v_error jsonb;
  v_payload_sha256 text;
  v_request_sha256 text;
  v_source_hash text;
  v_now timestamptz;
BEGIN
  IF jsonb_typeof(p_fact)<>'object' OR p_fact?'workspace_id'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_fact) key)
       IS DISTINCT FROM ARRAY['attempt_id','lease_fencing_token','lease_token',
         'producer_operation_key','run_id','settled_credits','step_id','terminal_intent_id',
         'terminal_payload_redacted','terminal_status','termination_reason']::text[]
     OR jsonb_typeof(v_payload)<>'object'
     OR (p_fact->>'settled_credits') !~ '^(0|[1-9][0-9]{0,15})$'
     OR length(btrim(p_fact->>'producer_operation_key')) NOT BETWEEN 1 AND 300
     OR v_status NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_ATTENTION')
     OR NOT (
       (v_status='SUCCEEDED' AND v_reason='COMPLETED')
       OR (v_status='FAILED' AND v_reason IN ('MAX_ITERATIONS','MAX_MODEL_ATTEMPTS',
         'MAX_TOOL_CALLS','BUDGET_EXHAUSTED','AUTHORIZATION_REVALIDATION_FAILED',
         'RESOURCE_REVOKED','MODEL_FAILED','MODEL_OUTCOME_UNKNOWN','CAPABILITY_FAILED',
         'INVALID_DECISION','STRATEGY_IMPLEMENTATION_UNAVAILABLE','INTERNAL_FAILURE'))
       OR (v_status='CANCELLED' AND v_reason IN ('USER_CANCELLED','HUMAN_REJECTED','HUMAN_GATE_EXPIRED'))
       OR (v_status='TIMED_OUT' AND v_reason='RUN_TIMED_OUT')
       OR (v_status='NEEDS_ATTENTION' AND v_reason='SIDE_EFFECT_UNKNOWN')
     ) THEN
    RAISE EXCEPTION 'invalid join-child terminal intent envelope' USING ERRCODE='22023';
  END IF;
  IF v_status<>'SUCCEEDED' THEN
    v_error:=jsonb_build_object('code',v_reason,'retryable',false,'category','EXECUTION')
      || CASE WHEN v_status='NEEDS_ATTENTION'
        THEN jsonb_build_object('requires_operator_action',true) ELSE '{}'::jsonb END;
    IF v_payload IS DISTINCT FROM v_error THEN
      RAISE EXCEPTION 'join-child terminal error payload is not canonical' USING ERRCODE='22023';
    END IF;
  END IF;
  v_request_sha256:=app.g007_sha256('better-agent/join-child-terminal-request/1',
    app.g007_canonical_json(p_fact));
  SELECT * INTO v_existing FROM public.join_child_terminal_intents
    WHERE workspace_id=app.current_workspace_id() AND child_run_id=(p_fact->>'run_id')::uuid;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM (p_fact->>'terminal_intent_id')::uuid
       OR v_existing.producer_operation_key IS DISTINCT FROM p_fact->>'producer_operation_key'
       OR v_existing.producer_request_sha256 IS DISTINCT FROM v_request_sha256
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'join-child terminal intent replay conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('terminal_intent_id',v_existing.id,
      'terminal_intent_hash',v_existing.source_authority_hash,'replayed',true);
  END IF;
  PERFORM 1 FROM public.runs WHERE workspace_id=app.current_workspace_id()
    AND id=(p_fact->>'run_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'join-child terminal intent Run is unavailable' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO v_existing FROM public.join_child_terminal_intents
    WHERE workspace_id=app.current_workspace_id() AND child_run_id=(p_fact->>'run_id')::uuid;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM (p_fact->>'terminal_intent_id')::uuid
       OR v_existing.producer_operation_key IS DISTINCT FROM p_fact->>'producer_operation_key'
       OR v_existing.producer_request_sha256 IS DISTINCT FROM v_request_sha256
       OR v_existing.producer_session_user IS DISTINCT FROM session_user THEN
      RAISE EXCEPTION 'join-child terminal intent replay conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('terminal_intent_id',v_existing.id,
      'terminal_intent_hash',v_existing.source_authority_hash,'replayed',true);
  END IF;
  v_authority:=app.require_execution_owner_lease(p_fact-ARRAY[
    'producer_operation_key','settled_credits','terminal_intent_id',
    'terminal_payload_redacted','terminal_status','termination_reason']);
  v_workspace_id:=(v_authority->>'workspace_id')::uuid;
  v_now:=(v_authority->>'validated_at')::timestamptz;
  SELECT * INTO v_child FROM public.runs WHERE workspace_id=v_workspace_id
    AND id=(p_fact->>'run_id')::uuid FOR UPDATE;
  SELECT * INTO v_link FROM public.run_parent_links WHERE workspace_id=v_workspace_id
    AND child_run_id=v_child.id FOR SHARE;
  v_allocation:=app.require_active_join_child_allocation(v_workspace_id,v_child.id);
  IF v_link.child_run_id IS NULL OR v_child.run_kind<>'join_child'
     OR (v_allocation->>'parent_run_id')::uuid<>v_link.parent_run_id
     OR (v_allocation->>'billing_owner_run_id')::uuid<>v_child.billing_owner_run_id
     OR v_settle_credits>(v_allocation->>'allocated_credits')::bigint THEN
    RAISE EXCEPTION 'join-child terminal intent lacks an exact active allocation' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_retry_effect_envelopes envelope
    LEFT JOIN public.run_side_effect_receipts receipt
      ON receipt.workspace_id=envelope.workspace_id AND receipt.envelope_id=envelope.id
    WHERE envelope.workspace_id=v_workspace_id AND envelope.run_id=v_child.id
      AND envelope.attempt_id=(p_fact->>'attempt_id')::uuid
      AND (envelope.effect_class='unsafe' OR receipt.disposition IS DISTINCT FROM 'CONFIRMED')) THEN
    RAISE EXCEPTION 'join-child terminal intent requires closed effects' USING ERRCODE='55000';
  END IF;
  v_payload_sha256:='sha256:'||encode(public.digest(
    convert_to(app.g007_canonical_json(v_payload),'UTF8'),'sha256'),'hex');
  v_source_hash:=app.g007_sha256('better-agent/join-child-terminal-source/1',
    app.g007_canonical_json(jsonb_build_object(
      'terminal_intent_id',p_fact->>'terminal_intent_id','workspace_id',v_workspace_id,
      'child_run_id',v_child.id,'parent_run_id',v_link.parent_run_id,
      'allocation_id',v_allocation->>'allocation_id','billing_owner_run_id',v_child.billing_owner_run_id,
      'reservation_id',v_allocation->>'reservation_id',
      'attempt_id',p_fact->>'attempt_id','step_id',p_fact->>'step_id',
      'terminal_status',v_status,'termination_reason',v_reason,
      'terminal_payload_sha256',v_payload_sha256,'settle_credits',v_settle_credits::text,
      'producer_operation_key',p_fact->>'producer_operation_key',
      'producer_request_sha256',v_request_sha256,
      'producer_session_user',session_user,
      'producer_lease_token',p_fact->>'lease_token',
      'producer_lease_fencing_token',p_fact->>'lease_fencing_token')));
  INSERT INTO public.join_child_terminal_intents(workspace_id,id,child_run_id,parent_run_id,
    allocation_id,billing_owner_run_id,reservation_id,attempt_id,step_id,terminal_status,
    termination_reason,terminal_result_redacted,terminal_error_redacted,terminal_payload_sha256,
    settle_credits,producer_operation_key,producer_request_sha256,producer_session_user,
    producer_lease_token,producer_lease_fencing_token,producer_lease_expires_at,
    source_authority_hash,authorized_at)
  VALUES(v_workspace_id,(p_fact->>'terminal_intent_id')::uuid,v_child.id,v_link.parent_run_id,
    (v_allocation->>'allocation_id')::uuid,v_child.billing_owner_run_id,
    (v_allocation->>'reservation_id')::uuid,
    (p_fact->>'attempt_id')::uuid,(p_fact->>'step_id')::uuid,v_status,v_reason,
    CASE WHEN v_status='SUCCEEDED' THEN v_payload END,
    CASE WHEN v_status<>'SUCCEEDED' THEN v_error END,v_payload_sha256,v_settle_credits,
    p_fact->>'producer_operation_key',v_request_sha256,session_user,
    (p_fact->>'lease_token')::uuid,(p_fact->>'lease_fencing_token')::bigint,
    (v_authority->>'lease_expires_at')::timestamptz,v_source_hash,v_now);
  UPDATE public.run_attempts SET status=CASE v_status WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'FAILED' END,
    lease_owner=NULL,lease_token=NULL,lease_fencing_token=NULL,lease_expires_at=NULL,
    finished_at=v_now,updated_at=v_now
    WHERE workspace_id=v_workspace_id AND id=(p_fact->>'attempt_id')::uuid;
  RETURN jsonb_build_object('terminal_intent_id',p_fact->>'terminal_intent_id',
    'terminal_intent_hash',v_source_hash,'replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION app.commit_join_child_terminal_intent(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.commit_join_child_terminal_intent(jsonb) TO ba_execution_executor;
RESET ROLE;

SET LOCAL ROLE ba_billing_owner;
CREATE FUNCTION app.protect_run_budget_allocation_close() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
BEGIN
  IF TG_OP='UPDATE' AND current_user='ba_billing_owner'
     AND OLD.status='ACTIVE' AND NEW.status IN ('SETTLED','RELEASED')
     AND NEW.workspace_id=OLD.workspace_id AND NEW.id=OLD.id
     AND NEW.child_run_id=OLD.child_run_id AND NEW.parent_run_id=OLD.parent_run_id
     AND NEW.parent_reservation_id=OLD.parent_reservation_id
     AND NEW.billing_owner_run_id=OLD.billing_owner_run_id
     AND NEW.allocated_credits=OLD.allocated_credits AND NEW.created_at=OLD.created_at
     AND NEW.settled_credits+NEW.released_credits=NEW.allocated_credits THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'join-child allocation changes require the controlled billing close path'
    USING ERRCODE='55000';
END;
$function$;
DROP TRIGGER run_budget_allocations_immutable ON public.run_budget_allocations;
CREATE TRIGGER run_budget_allocations_controlled_close BEFORE UPDATE OR DELETE
  ON public.run_budget_allocations FOR EACH ROW
  EXECUTE FUNCTION app.protect_run_budget_allocation_close();

CREATE FUNCTION app.settle_join_child_allocation(
  p_workspace_id uuid,p_child_run_id uuid,p_billing_owner_run_id uuid,p_reservation_id uuid,
  p_producer_attempt_id uuid,p_step_id uuid,p_fencing_token bigint,p_source_id uuid,
  p_source_hash text,p_settle_credits bigint,p_authority_id uuid,p_ledger_id uuid,
  p_authorized_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_allocation public.run_budget_allocations%ROWTYPE;
  v_ledger uuid;
  v_charge_key text;
  v_intent_hash text;
BEGIN
  IF p_workspace_id IS DISTINCT FROM app.current_workspace_id() OR p_settle_credits<0
     OR p_source_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid join-child billing settlement' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_allocation FROM public.run_budget_allocations
    WHERE workspace_id=p_workspace_id AND child_run_id=p_child_run_id FOR UPDATE;
  IF NOT FOUND OR v_allocation.billing_owner_run_id<>p_billing_owner_run_id
     OR v_allocation.parent_reservation_id<>p_reservation_id
     OR p_settle_credits>v_allocation.allocated_credits THEN
    RAISE EXCEPTION 'join-child allocation does not bind the settlement source' USING ERRCODE='55000';
  END IF;
  v_charge_key:='billing-v2/join-child/'||p_source_id::text||'/'||substr(p_source_hash,8,16);
  v_intent_hash:=app.g007_sha256('better-agent/join-child-billing-intent/1',
    app.g007_canonical_json(jsonb_build_object('billing_owner_run_id',p_billing_owner_run_id,
      'reservation_id',p_reservation_id,'child_run_id',p_child_run_id,
      'amount_credits',p_settle_credits::text,'source_authority_hash',p_source_hash)));
  IF v_allocation.status IN ('SETTLED','RELEASED') THEN
    IF v_allocation.settled_credits<>p_settle_credits
       OR v_allocation.released_credits<>v_allocation.allocated_credits-p_settle_credits
       OR NOT EXISTS (SELECT 1 FROM public.run_billing_authority_receipts receipt
         WHERE receipt.workspace_id=p_workspace_id AND receipt.id=p_authority_id
           AND receipt.ledger_entry_id=p_ledger_id AND receipt.source_id=p_source_id
           AND receipt.source_authority_hash=p_source_hash
           AND receipt.amount=p_settle_credits) THEN
      RAISE EXCEPTION 'join-child allocation settlement replay conflict' USING ERRCODE='23505';
    END IF;
  ELSE
    v_ledger:=app.apply_credit_settlement_kernel(jsonb_build_object(
      'workspace_id',p_workspace_id,'run_id',p_billing_owner_run_id,
      'reservation_id',p_reservation_id,'authority_id',p_authority_id,
      'ledger_entry_id',p_ledger_id,'authority_kind','EXECUTION_USAGE','operation','SETTLE',
      'source_id',p_source_id,'source_authority_hash',p_source_hash,
      'source_consumption_generation','1','amount',p_settle_credits::text,
      'producer_run_id',p_child_run_id,'producer_attempt_id',p_producer_attempt_id,
      'producer_lease_fencing_token',p_fencing_token::text,'step_id',p_step_id,
      'charge_key',v_charge_key,'charge_attribution_hash',p_source_hash,
      'billing_intent_hash',v_intent_hash,
      'detail_redacted',jsonb_build_object('source_kind','JOIN_CHILD_TERMINAL_INTENT'),
      'authorized_at',p_authorized_at));
    UPDATE public.run_budget_allocations
      SET settled_credits=p_settle_credits,
        released_credits=v_allocation.allocated_credits-p_settle_credits,
        status=CASE WHEN p_settle_credits>0 THEN 'SETTLED' ELSE 'RELEASED' END
      WHERE workspace_id=p_workspace_id AND id=v_allocation.id;
  END IF;
  RETURN jsonb_build_object('allocation_id',v_allocation.id,
    'status',CASE WHEN p_settle_credits>0 THEN 'SETTLED' ELSE 'RELEASED' END,
    'ledger_entry_id',COALESCE(v_ledger,p_ledger_id));
END;
$function$;
REVOKE ALL ON FUNCTION app.settle_join_child_allocation(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,text,bigint,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.settle_join_child_allocation(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid,text,bigint,uuid,uuid,timestamptz) TO ba_run_owner;
RESET ROLE;

SET LOCAL ROLE ba_run_owner;
CREATE FUNCTION app.finalize_join_child(p_fact jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('finalizer');
  v_child public.runs%ROWTYPE;
  v_intent public.join_child_terminal_intents%ROWTYPE;
  v_sequence bigint;
  v_finished_at timestamptz := (p_fact->>'finished_at')::timestamptz;
  v_execution_status text;
  v_step_status text;
BEGIN
  IF jsonb_typeof(p_fact)<>'object' OR p_fact?'workspace_id'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_fact) key)
       IS DISTINCT FROM ARRAY['authority_id','child_run_id','events_retention_until','finished_at',
         'ledger_entry_id','recovery_retention_until','retention_until','terminal_event_id',
         'terminal_intent_hash','terminal_intent_id','terminal_outbox_id']::text[]
     OR (p_fact->>'terminal_intent_hash') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_fact->>'events_retention_until')::timestamptz<v_finished_at+interval '7 days'
     OR (p_fact->>'recovery_retention_until')::timestamptz<v_finished_at+interval '30 days'
     OR (p_fact->>'recovery_retention_until')::timestamptz<(p_fact->>'events_retention_until')::timestamptz
     OR (p_fact->>'retention_until')::timestamptz<(p_fact->>'recovery_retention_until')::timestamptz THEN
    RAISE EXCEPTION 'invalid join-child finalization envelope' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_child FROM public.runs WHERE workspace_id=v_workspace_id
    AND id=(p_fact->>'child_run_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'join-child Run is unavailable' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_intent FROM public.join_child_terminal_intents
    WHERE workspace_id=v_workspace_id AND id=(p_fact->>'terminal_intent_id')::uuid
      AND child_run_id=v_child.id FOR SHARE;
  IF v_child.status IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_ATTENTION') THEN
    IF v_child.terminal_intent_hash IS DISTINCT FROM p_fact->>'terminal_intent_hash'
       OR v_child.terminal_event_id IS DISTINCT FROM (p_fact->>'terminal_event_id')::uuid
       OR NOT EXISTS (SELECT 1 FROM public.outbox WHERE workspace_id=v_workspace_id
         AND id=(p_fact->>'terminal_outbox_id')::uuid AND run_id=v_child.id) THEN
      RAISE EXCEPTION 'join-child finalization replay conflict' USING ERRCODE='23505';
    END IF;
    PERFORM app.settle_join_child_allocation(v_workspace_id,v_child.id,
      v_intent.billing_owner_run_id,v_intent.reservation_id,v_intent.attempt_id,v_intent.step_id,
      v_intent.producer_lease_fencing_token,v_intent.id,v_intent.source_authority_hash,
      v_intent.settle_credits,(p_fact->>'authority_id')::uuid,
      (p_fact->>'ledger_entry_id')::uuid,v_child.finished_at);
    RETURN jsonb_build_object('child_run_id',v_child.id,'status',v_child.status,
      'billing_state',v_child.billing_state,'replayed',true);
  END IF;
  IF NOT FOUND OR v_child.run_kind<>'join_child'
     OR v_intent.source_authority_hash IS DISTINCT FROM p_fact->>'terminal_intent_hash'
     OR v_finished_at<v_intent.authorized_at THEN
    RAISE EXCEPTION 'join-child finalization lacks its execution authority' USING ERRCODE='55000';
  END IF;
  PERFORM app.settle_join_child_allocation(v_workspace_id,v_child.id,
    v_intent.billing_owner_run_id,v_intent.reservation_id,v_intent.attempt_id,v_intent.step_id,
    v_intent.producer_lease_fencing_token,v_intent.id,v_intent.source_authority_hash,
    v_intent.settle_credits,(p_fact->>'authority_id')::uuid,
    (p_fact->>'ledger_entry_id')::uuid,v_finished_at);
  v_sequence:=v_child.last_event_sequence+1;
  v_execution_status:=CASE v_intent.terminal_status WHEN 'TIMED_OUT' THEN 'EXPIRED'
    ELSE v_intent.terminal_status END;
  v_step_status:=CASE v_intent.terminal_status WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
    WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'NEEDS_ATTENTION' THEN 'NEEDS_ATTENTION'
    ELSE 'FAILED' END;
  UPDATE public.run_steps SET status=v_step_status,output_hash=v_intent.terminal_payload_sha256,
    updated_at=v_finished_at WHERE workspace_id=v_workspace_id AND id=v_intent.step_id;
  INSERT INTO public.run_events(workspace_id,id,run_id,sequence,event_type,dedupe_key,
    payload_redacted,occurred_at)
  VALUES(v_workspace_id,(p_fact->>'terminal_event_id')::uuid,v_child.id,v_sequence,'RUN_FINISHED',
    'join-child-terminal:'||v_intent.id::text,
    jsonb_build_object('status',v_intent.terminal_status,'billing_state','SETTLED'),v_finished_at);
  INSERT INTO public.outbox(workspace_id,id,run_id,message_type,dedupe_key,payload_ref,payload_hash,
    producer_fencing_token,payload_redacted,status,available_at,created_at)
  VALUES(v_workspace_id,(p_fact->>'terminal_outbox_id')::uuid,v_child.id,'SSE_WAKE',
    'join-child-terminal:'||v_intent.id::text,'run:'||v_child.id::text||':terminal',
    v_intent.source_authority_hash,v_intent.producer_lease_fencing_token,
    jsonb_build_object('run_id',v_child.id,'status',v_intent.terminal_status),
    'PENDING',v_finished_at,v_finished_at);
  UPDATE public.runs SET status=v_intent.terminal_status,execution_status=v_execution_status,
    billing_state='SETTLED',billing_settled_at=v_finished_at,last_event_sequence=v_sequence,
    termination_reason=v_intent.termination_reason,terminal_intent_hash=v_intent.source_authority_hash,
    terminal_result_redacted=v_intent.terminal_result_redacted,
    terminal_error_redacted=v_intent.terminal_error_redacted,
    terminal_billing_pending=false,terminal_billing_pending_at=v_finished_at,
    terminal_event_id=(p_fact->>'terminal_event_id')::uuid,terminal_event_sequence=v_sequence,
    finished_at=v_finished_at,events_retention_until=(p_fact->>'events_retention_until')::timestamptz,
    recovery_retention_until=(p_fact->>'recovery_retention_until')::timestamptz,
    retention_until=(p_fact->>'retention_until')::timestamptz
    WHERE workspace_id=v_workspace_id AND id=v_child.id;
  RETURN jsonb_build_object('child_run_id',v_child.id,'status',v_intent.terminal_status,
    'billing_state','SETTLED','terminal_intent_hash',v_intent.source_authority_hash,'replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION app.finalize_join_child(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finalize_join_child(jsonb) TO ba_finalizer_executor;
RESET ROLE;
