-- G1-A5 join settlement barrier. Terminal child facts remain private; only a
-- safe payload reference/hash and the deterministic parent disposition escape.

GRANT USAGE,CREATE ON SCHEMA app TO ba_run_owner,ba_billing_owner;
GRANT CREATE ON SCHEMA public TO ba_run_owner;

SET LOCAL ROLE ba_run_owner;
CREATE TABLE public.join_child_settlement_receipts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  child_run_id uuid NOT NULL,
  child_terminal_status text NOT NULL CHECK (child_terminal_status IN (
    'SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_ATTENTION'
  )),
  child_terminal_intent_hash text NOT NULL CHECK (child_terminal_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  terminal_payload_object_ref text NOT NULL CHECK (
    length(btrim(terminal_payload_object_ref)) BETWEEN 1 AND 2048
    AND position('?' IN terminal_payload_object_ref)=0
    AND position('#' IN terminal_payload_object_ref)=0
  ),
  terminal_payload_sha256 text NOT NULL CHECK (terminal_payload_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  allocation_status text NOT NULL CHECK (allocation_status IN ('SETTLED','RELEASED')),
  parent_disposition text NOT NULL CHECK (parent_disposition IN (
    'RESUME_PARENT','FAIL_PARENT','CANCEL_PARENT','FAIL_PARENT_CHILD_TIMED_OUT',
    'HOLD_PARENT_NEEDS_ATTENTION'
  )),
  settled_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,child_run_id),
  FOREIGN KEY (workspace_id,child_run_id) REFERENCES public.runs(workspace_id,id),
  FOREIGN KEY (workspace_id,child_run_id,parent_run_id)
    REFERENCES public.run_parent_links(workspace_id,child_run_id,parent_run_id)
);
ALTER TABLE public.join_child_settlement_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.join_child_settlement_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY join_child_settlement_receipts_owner_access
  ON public.join_child_settlement_receipts FOR ALL TO ba_run_owner
  USING (workspace_id=app.current_workspace_id())
  WITH CHECK (workspace_id=app.current_workspace_id());
CREATE TRIGGER join_child_settlement_receipts_immutable BEFORE UPDATE OR DELETE
  ON public.join_child_settlement_receipts FOR EACH ROW
  EXECUTE FUNCTION app.reject_g006_immutable_change();
REVOKE ALL ON TABLE public.join_child_settlement_receipts FROM PUBLIC;
RESET ROLE;

SET LOCAL ROLE ba_billing_owner;
CREATE FUNCTION app.require_closed_join_allocation(p_workspace_id uuid,p_child_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE v_allocation public.run_budget_allocations%ROWTYPE;
BEGIN
  IF p_workspace_id IS DISTINCT FROM app.current_workspace_id() OR p_child_run_id IS NULL THEN
    RAISE EXCEPTION 'invalid join allocation lookup' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_allocation FROM public.run_budget_allocations
    WHERE workspace_id=p_workspace_id AND child_run_id=p_child_run_id FOR UPDATE;
  IF NOT FOUND OR v_allocation.status NOT IN ('SETTLED','RELEASED')
     OR v_allocation.settled_credits+v_allocation.released_credits<>v_allocation.allocated_credits THEN
    RAISE EXCEPTION 'join allocation is not closed' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('allocation_id',v_allocation.id,'status',v_allocation.status,
    'settled_credits',v_allocation.settled_credits,'released_credits',v_allocation.released_credits);
END;
$function$;
REVOKE ALL ON FUNCTION app.require_closed_join_allocation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_closed_join_allocation(uuid,uuid) TO ba_run_owner;
RESET ROLE;

SET LOCAL ROLE ba_run_owner;
CREATE FUNCTION app.settle_join_child(p_fact jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('finalizer');
  v_child public.runs%ROWTYPE;
  v_parent public.runs%ROWTYPE;
  v_link public.run_parent_links%ROWTYPE;
  v_existing public.join_child_settlement_receipts%ROWTYPE;
  v_allocation jsonb;
  v_payload jsonb;
  v_payload_hash text;
  v_disposition text;
  v_sequence bigint;
  v_attempt_number bigint;
  v_outbox_payload jsonb;
BEGIN
  IF jsonb_typeof(p_fact)<>'object' OR p_fact ? 'workspace_id'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_fact) key)
       IS DISTINCT FROM ARRAY['child_run_id','child_terminal_intent_hash','parent_attempt_id',
         'parent_event_id','parent_outbox_id','settled_at','settlement_id',
         'terminal_payload_object_ref','terminal_payload_sha256']::text[] THEN
    RAISE EXCEPTION 'invalid join-child settlement envelope' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.join_child_settlement_receipts
    WHERE workspace_id=v_workspace_id AND child_run_id=(p_fact->>'child_run_id')::uuid;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM (p_fact->>'settlement_id')::uuid
       OR v_existing.child_terminal_intent_hash IS DISTINCT FROM p_fact->>'child_terminal_intent_hash'
       OR v_existing.terminal_payload_sha256 IS DISTINCT FROM p_fact->>'terminal_payload_sha256' THEN
      RAISE EXCEPTION 'join-child settlement replay conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('child_run_id',v_existing.child_run_id,
      'parent_run_id',v_existing.parent_run_id,'parent_disposition',v_existing.parent_disposition,
      'outcome','REPLAY','replayed',true);
  END IF;

  SELECT * INTO v_child FROM public.runs WHERE workspace_id=v_workspace_id
    AND id=(p_fact->>'child_run_id')::uuid FOR UPDATE;
  SELECT * INTO v_existing FROM public.join_child_settlement_receipts
    WHERE workspace_id=v_workspace_id AND child_run_id=(p_fact->>'child_run_id')::uuid;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM (p_fact->>'settlement_id')::uuid
       OR v_existing.child_terminal_intent_hash IS DISTINCT FROM p_fact->>'child_terminal_intent_hash'
       OR v_existing.terminal_payload_sha256 IS DISTINCT FROM p_fact->>'terminal_payload_sha256' THEN
      RAISE EXCEPTION 'join-child settlement replay conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('child_run_id',v_existing.child_run_id,
      'parent_run_id',v_existing.parent_run_id,'parent_disposition',v_existing.parent_disposition,
      'outcome','REPLAY','replayed',true);
  END IF;
  SELECT * INTO v_link FROM public.run_parent_links WHERE workspace_id=v_workspace_id
    AND child_run_id=v_child.id FOR UPDATE;
  SELECT * INTO v_parent FROM public.runs WHERE workspace_id=v_workspace_id
    AND id=v_link.parent_run_id FOR UPDATE;
  IF NOT FOUND OR v_child.run_kind<>'join_child'
     OR v_child.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_ATTENTION')
     OR v_child.billing_state<>'SETTLED'
     OR v_child.terminal_intent_hash IS DISTINCT FROM p_fact->>'child_terminal_intent_hash'
     OR v_parent.status<>'WAITING_FOR_CHILD' OR v_parent.execution_status<>'WAITING_FOR_CHILD' THEN
    RAISE EXCEPTION 'child or waiting parent is not settlement-ready' USING ERRCODE='55000';
  END IF;
  v_payload:=CASE WHEN v_child.status='SUCCEEDED'
    THEN v_child.terminal_result_redacted ELSE v_child.terminal_error_redacted END;
  v_payload_hash:='sha256:'||encode(public.digest(
    convert_to(app.g007_canonical_json(v_payload),'UTF8'),'sha256'),'hex');
  IF v_payload_hash IS DISTINCT FROM p_fact->>'terminal_payload_sha256' THEN
    RAISE EXCEPTION 'terminal payload hash does not match the child tombstone' USING ERRCODE='55000';
  END IF;
  v_allocation:=app.require_closed_join_allocation(v_workspace_id,v_child.id);
  v_disposition:=CASE v_child.status
    WHEN 'SUCCEEDED' THEN 'RESUME_PARENT'
    WHEN 'FAILED' THEN 'FAIL_PARENT'
    WHEN 'CANCELLED' THEN 'CANCEL_PARENT'
    WHEN 'TIMED_OUT' THEN 'FAIL_PARENT_CHILD_TIMED_OUT'
    ELSE 'HOLD_PARENT_NEEDS_ATTENTION' END;
  INSERT INTO public.join_child_settlement_receipts(workspace_id,id,parent_run_id,child_run_id,
    child_terminal_status,child_terminal_intent_hash,terminal_payload_object_ref,
    terminal_payload_sha256,allocation_status,parent_disposition,settled_at)
  VALUES(v_workspace_id,(p_fact->>'settlement_id')::uuid,v_parent.id,v_child.id,v_child.status,
    v_child.terminal_intent_hash,p_fact->>'terminal_payload_object_ref',v_payload_hash,
    v_allocation->>'status',v_disposition,(p_fact->>'settled_at')::timestamptz);

  IF EXISTS (SELECT 1 FROM public.run_parent_links sibling
    WHERE sibling.workspace_id=v_workspace_id AND sibling.parent_run_id=v_parent.id
      AND NOT EXISTS (SELECT 1 FROM public.join_child_settlement_receipts receipt
        WHERE receipt.workspace_id=sibling.workspace_id AND receipt.child_run_id=sibling.child_run_id)) THEN
    RETURN jsonb_build_object('child_run_id',v_child.id,'parent_run_id',v_parent.id,
      'parent_disposition',v_disposition,'outcome','BARRIER_WAITING','replayed',false);
  END IF;
  IF EXISTS (SELECT 1 FROM public.join_child_settlement_receipts receipt
    WHERE receipt.workspace_id=v_workspace_id AND receipt.parent_run_id=v_parent.id
      AND receipt.parent_disposition<>'RESUME_PARENT') THEN
    v_sequence:=v_parent.last_event_sequence+1;
    INSERT INTO public.run_events(workspace_id,id,run_id,sequence,event_type,dedupe_key,
      payload_redacted,occurred_at)
    VALUES(v_workspace_id,(p_fact->>'parent_event_id')::uuid,v_parent.id,v_sequence,
      'RUN_CANCEL_REQUESTED','join-child-terminal:'||v_child.id::text,
      jsonb_build_object('child_run_id',v_child.id,'disposition',v_disposition),
      (p_fact->>'settled_at')::timestamptz);
    v_outbox_payload:=jsonb_build_object('run_id',v_parent.id,'child_run_id',v_child.id,
      'disposition',v_disposition);
    INSERT INTO public.outbox(workspace_id,id,run_id,message_type,dedupe_key,payload_ref,payload_hash,
      producer_fencing_token,payload_redacted,status,available_at,created_at)
    VALUES(v_workspace_id,(p_fact->>'parent_outbox_id')::uuid,v_parent.id,'RUN_DISPATCH',
      'join-child-terminal:'||v_child.id::text,'run:'||v_parent.id::text||':join-terminal',
      'sha256:'||encode(public.digest(convert_to(app.g007_canonical_json(v_outbox_payload),'UTF8'),'sha256'),'hex'),
      1,v_outbox_payload,'PENDING',(p_fact->>'settled_at')::timestamptz,
      (p_fact->>'settled_at')::timestamptz);
    UPDATE public.runs SET status='CANCEL_REQUESTED',execution_status='CANCELLING',
      last_event_sequence=v_sequence WHERE workspace_id=v_workspace_id AND id=v_parent.id;
    RETURN jsonb_build_object('child_run_id',v_child.id,'parent_run_id',v_parent.id,
      'parent_disposition',v_disposition,'outcome','PARENT_FINALIZER_DISPATCHED','replayed',false);
  END IF;

  SELECT COALESCE(max(attempt_number),0)+1 INTO v_attempt_number FROM public.run_attempts
    WHERE workspace_id=v_workspace_id AND run_id=v_parent.id;
  INSERT INTO public.run_attempts(workspace_id,id,run_id,attempt_number,status,
    runtime_protocol_version,lease_generation,created_at,updated_at)
  VALUES(v_workspace_id,(p_fact->>'parent_attempt_id')::uuid,v_parent.id,v_attempt_number,
    'PENDING',5,0,(p_fact->>'settled_at')::timestamptz,(p_fact->>'settled_at')::timestamptz);
  v_sequence:=v_parent.last_event_sequence+1;
  INSERT INTO public.run_events(workspace_id,id,run_id,sequence,event_type,dedupe_key,
    payload_redacted,occurred_at)
  VALUES(v_workspace_id,(p_fact->>'parent_event_id')::uuid,v_parent.id,v_sequence,'RUN_QUEUED',
    'join-child-settled:'||v_child.id::text,jsonb_build_object('child_run_id',v_child.id),
    (p_fact->>'settled_at')::timestamptz);
  v_outbox_payload:=jsonb_build_object('run_id',v_parent.id,'child_run_id',v_child.id,
    'attempt_id',p_fact->>'parent_attempt_id');
  INSERT INTO public.outbox(workspace_id,id,run_id,message_type,dedupe_key,payload_ref,payload_hash,
    producer_fencing_token,payload_redacted,status,available_at,created_at)
  VALUES(v_workspace_id,(p_fact->>'parent_outbox_id')::uuid,v_parent.id,'RUN_DISPATCH',
    'join-child-settled:'||v_child.id::text,'run:'||v_parent.id::text||':dispatch',
    'sha256:'||encode(public.digest(convert_to(app.g007_canonical_json(v_outbox_payload),'UTF8'),'sha256'),'hex'),
    1,v_outbox_payload,'PENDING',(p_fact->>'settled_at')::timestamptz,
    (p_fact->>'settled_at')::timestamptz);
  UPDATE public.runs SET status='QUEUED',execution_status='QUEUED',last_event_sequence=v_sequence
    WHERE workspace_id=v_workspace_id AND id=v_parent.id;
  RETURN jsonb_build_object('child_run_id',v_child.id,'parent_run_id',v_parent.id,
    'parent_disposition','RESUME_PARENT','outcome','PARENT_RESUMED','replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION app.settle_join_child(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.settle_join_child(jsonb) TO ba_finalizer_executor;
RESET ROLE;
