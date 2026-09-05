-- G1-A5 join-only child admission. A child shares one billing root and may
-- only be created from an exact capability in the parent's compiled AgentPlan.

GRANT USAGE, CREATE ON SCHEMA app TO ba_run_owner,ba_billing_owner;

ALTER TABLE public.runs DROP CONSTRAINT runs_run_kind_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_run_kind_check
  CHECK (run_kind IN ('top_level','join_child'));
ALTER TABLE public.runs DROP CONSTRAINT runs_self_billing_owner_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_billing_owner_shape_check CHECK (
  (run_kind='top_level' AND billing_owner_run_id=id)
  OR (run_kind='join_child' AND billing_owner_run_id<>id)
);
ALTER TABLE public.runs ADD CONSTRAINT runs_billing_root_fkey
  FOREIGN KEY (workspace_id,billing_owner_run_id,billing_owner_run_id)
  REFERENCES public.runs(workspace_id,id,billing_owner_run_id);

ALTER TABLE public.runs DROP CONSTRAINT runs_target_shape_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_target_shape_check CHECK (
  (run_kind='top_level' AND (
    (target_kind='agent' AND fixed_route='/v1/oapi/agent/chat'
      AND agent_deployment_id IS NOT NULL AND agent_deployment_revision_id IS NOT NULL
      AND agent_id IS NOT NULL AND agent_release_id IS NOT NULL
      AND experience_release_id IS NOT NULL AND conversation_id IS NOT NULL
      AND conversation_contract_hash ~ '^sha256:[0-9a-f]{64}$'
      AND accepted_conversation_state_version>0 AND user_message_id IS NOT NULL
      AND flow_deployment_id IS NULL AND flow_deployment_revision_id IS NULL
      AND flow_id IS NULL AND flow_version_id IS NULL)
    OR
    (target_kind='flow' AND fixed_route='/v1/oapi/flow/run'
      AND accepted_principal_kind='credential'
      AND agent_deployment_id IS NULL AND agent_deployment_revision_id IS NULL
      AND agent_id IS NULL AND agent_release_id IS NULL
      AND experience_release_id IS NULL AND conversation_id IS NULL
      AND conversation_contract_hash IS NULL AND accepted_conversation_state_version IS NULL
      AND user_message_id IS NULL AND flow_deployment_id IS NOT NULL
      AND flow_deployment_revision_id IS NOT NULL AND flow_id IS NOT NULL
      AND flow_version_id IS NOT NULL)
  )) OR (run_kind='join_child' AND target_kind='agent'
      AND fixed_route='/v1/oapi/agent/chat'
      AND agent_id IS NOT NULL AND agent_release_id IS NOT NULL
      AND agent_deployment_id IS NULL AND agent_deployment_revision_id IS NULL
      AND experience_release_id IS NULL AND conversation_id IS NULL
      AND conversation_contract_hash IS NULL AND accepted_conversation_state_version IS NULL
      AND user_message_id IS NULL AND flow_deployment_id IS NULL
      AND flow_deployment_revision_id IS NULL AND flow_id IS NULL AND flow_version_id IS NULL)
);

ALTER TABLE public.runs DROP CONSTRAINT runs_status_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_status_check CHECK (status IN (
  'QUEUED','RUNNING','WAITING_FOR_INPUT','WAITING_FOR_APPROVAL','WAITING_FOR_CHILD',
  'RESUMING','CANCEL_REQUESTED','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_ATTENTION'
));
ALTER TABLE public.runs DROP CONSTRAINT runs_execution_status_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_execution_status_check CHECK (execution_status IN (
  'ACCEPTED','QUEUED','RUNNING','WAITING_FOR_INPUT','WAITING_FOR_APPROVAL','WAITING_FOR_CHILD',
  'RESUMING','RETRY_WAIT','RECOVERING','CANCELLING','SUCCEEDED','FAILED','CANCELLED',
  'EXPIRED','NEEDS_ATTENTION'
));

DROP TRIGGER run_parent_links_unavailable ON public.run_parent_links;
DROP TRIGGER run_budget_allocations_unavailable ON public.run_budget_allocations;

ALTER TABLE public.run_parent_links
  ADD COLUMN parent_plan_hash text NOT NULL CHECK (parent_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN parent_checkpoint_id uuid NOT NULL,
  ADD COLUMN parent_checkpoint_object_ref text NOT NULL CHECK (
    length(btrim(parent_checkpoint_object_ref)) BETWEEN 1 AND 2048
    AND position('?' IN parent_checkpoint_object_ref)=0
    AND position('#' IN parent_checkpoint_object_ref)=0
  ),
  ADD COLUMN parent_checkpoint_sha256 text NOT NULL CHECK (parent_checkpoint_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN child_plan_hash text NOT NULL CHECK (child_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN canonical_operation_hash text NOT NULL CHECK (canonical_operation_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN binding_id text NOT NULL CHECK (length(btrim(binding_id))>0),
  ADD COLUMN target_ref text NOT NULL CHECK (length(btrim(target_ref))>0),
  ADD COLUMN ancestor_target_refs jsonb NOT NULL CHECK (jsonb_typeof(ancestor_target_refs)='array'),
  ADD COLUMN parent_depth integer NOT NULL CHECK (parent_depth>=0),
  ADD COLUMN child_depth integer NOT NULL CHECK (child_depth=parent_depth+1),
  ADD COLUMN call_sequence integer NOT NULL CHECK (call_sequence>0),
  ADD COLUMN delegation_policy_hash text NOT NULL CHECK (delegation_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN delegation_reason text NOT NULL CHECK (length(btrim(delegation_reason)) BETWEEN 1 AND 1024),
  ADD COLUMN delegation_expires_at timestamptz NOT NULL,
  ADD COLUMN context_projection_object_ref text NOT NULL CHECK (
    length(btrim(context_projection_object_ref)) BETWEEN 1 AND 2048
    AND position('?' IN context_projection_object_ref)=0
    AND position('#' IN context_projection_object_ref)=0
  ),
  ADD COLUMN context_projection_sha256 text NOT NULL CHECK (context_projection_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT run_parent_links_parent_call_key UNIQUE
    (workspace_id,parent_run_id,binding_id,call_sequence),
  ADD CONSTRAINT run_parent_links_child_parent_key UNIQUE
    (workspace_id,child_run_id,parent_run_id),
  ADD CONSTRAINT run_parent_links_parent_checkpoint_fkey FOREIGN KEY
    (workspace_id,parent_run_id,parent_checkpoint_id)
    REFERENCES public.run_checkpoints(workspace_id,run_id,id);

SET LOCAL ROLE ba_billing_owner;
DROP FUNCTION app.allocate_child_run_budget(jsonb);
CREATE FUNCTION app.reject_g1_join_allocation_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'join-child allocations are immutable' USING ERRCODE='55000';
END;
$function$;
CREATE TRIGGER run_budget_allocations_immutable BEFORE UPDATE OR DELETE
  ON public.run_budget_allocations FOR EACH ROW
  EXECUTE FUNCTION app.reject_g1_join_allocation_change();

CREATE OR REPLACE FUNCTION app.allocate_child_run_budget(p_fact jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid := app.current_workspace_id();
  v_reservation public.credit_reservations%ROWTYPE;
  v_existing public.run_budget_allocations%ROWTYPE;
  v_allocated bigint := (p_fact->>'allocated_credits')::bigint;
BEGIN
  IF current_user<>'ba_billing_owner' OR session_user=current_user
     OR jsonb_typeof(p_fact)<>'object'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_fact) key)
       IS DISTINCT FROM ARRAY['allocated_credits','allocation_id','billing_owner_run_id',
         'child_run_id','parent_reservation_id','parent_run_id','workspace_id']::text[]
     OR p_fact->>'workspace_id' IS DISTINCT FROM v_workspace_id::text OR v_allocated<0 THEN
    RAISE EXCEPTION 'invalid child budget allocation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.run_budget_allocations
   WHERE workspace_id=v_workspace_id AND child_run_id=(p_fact->>'child_run_id')::uuid;
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM (p_fact->>'allocation_id')::uuid
       OR v_existing.parent_run_id IS DISTINCT FROM (p_fact->>'parent_run_id')::uuid
       OR v_existing.billing_owner_run_id IS DISTINCT FROM (p_fact->>'billing_owner_run_id')::uuid
       OR v_existing.allocated_credits IS DISTINCT FROM v_allocated THEN
      RAISE EXCEPTION 'child allocation replay conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('allocation_id',v_existing.id,'replayed',true);
  END IF;
  SELECT * INTO v_reservation FROM public.credit_reservations
   WHERE workspace_id=v_workspace_id AND id=(p_fact->>'parent_reservation_id')::uuid
     AND run_id=(p_fact->>'billing_owner_run_id')::uuid
     AND billing_owner_run_id=(p_fact->>'billing_owner_run_id')::uuid FOR UPDATE;
  IF NOT FOUND OR v_reservation.status<>'HELD' OR v_reservation.expires_at<=clock_timestamp()
     OR v_allocated + COALESCE((SELECT sum(allocated_credits) FROM public.run_budget_allocations
       WHERE workspace_id=v_workspace_id AND billing_owner_run_id=v_reservation.run_id),0)
       > v_reservation.reserved_credits THEN
    RAISE EXCEPTION 'child allocation exceeds the live billing root reservation' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.run_budget_allocations(
    workspace_id,id,child_run_id,parent_run_id,parent_reservation_id,billing_owner_run_id,
    allocated_credits,settled_credits,released_credits,status
  ) VALUES (v_workspace_id,(p_fact->>'allocation_id')::uuid,(p_fact->>'child_run_id')::uuid,
    (p_fact->>'parent_run_id')::uuid,v_reservation.id,v_reservation.run_id,
    v_allocated,0,0,'ACTIVE') ON CONFLICT DO NOTHING;
  SELECT * INTO v_existing FROM public.run_budget_allocations
   WHERE workspace_id=v_workspace_id AND child_run_id=(p_fact->>'child_run_id')::uuid;
  IF NOT FOUND OR v_existing.id IS DISTINCT FROM (p_fact->>'allocation_id')::uuid
     OR v_existing.allocated_credits IS DISTINCT FROM v_allocated THEN
    RAISE EXCEPTION 'child allocation replay conflict' USING ERRCODE='23505';
  END IF;
  RETURN jsonb_build_object('allocation_id',v_existing.id,'replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION app.allocate_child_run_budget(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.allocate_child_run_budget(jsonb) TO ba_run_owner;
RESET ROLE;

SET LOCAL ROLE ba_run_owner;
CREATE TRIGGER run_parent_links_immutable BEFORE UPDATE OR DELETE
  ON public.run_parent_links FOR EACH ROW EXECUTE FUNCTION app.reject_g006_immutable_change();

CREATE FUNCTION app.reject_child_credit_reservation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.runs WHERE workspace_id=NEW.workspace_id
    AND id=NEW.run_id AND run_kind='join_child') THEN
    RAISE EXCEPTION 'child Run cannot own a credit reservation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION app.reject_child_credit_reservation() OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.reject_child_credit_reservation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reject_child_credit_reservation() TO ba_billing_owner;
RESET ROLE;
SET LOCAL ROLE ba_billing_owner;
CREATE TRIGGER credit_reservations_no_child BEFORE INSERT ON public.credit_reservations
  FOR EACH ROW EXECUTE FUNCTION app.reject_child_credit_reservation();
RESET ROLE;

SET LOCAL ROLE ba_run_owner;
DROP FUNCTION app.create_child_run(jsonb);
CREATE OR REPLACE FUNCTION app.create_child_run(p_fact jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('execution');
  v_admission jsonb := p_fact->'admission';
  v_delegation jsonb := v_admission->'delegation';
  v_policy jsonb := v_admission->'async_child_policy';
  v_parent public.runs%ROWTYPE;
  v_existing public.run_parent_links%ROWTYPE;
  v_execution public.agent_strategy_executions%ROWTYPE;
  v_catalog jsonb;
  v_parent_depth integer;
  v_completed integer;
  v_ancestor_refs jsonb;
  v_policy_hash text;
  v_recursive boolean;
  v_child public.runs%ROWTYPE;
  v_event_payload jsonb;
  v_outbox_payload jsonb;
  v_parent_sequence bigint;
BEGIN
  IF jsonb_typeof(p_fact)<>'object' OR p_fact ? 'workspace_id'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_fact) key)
       IS DISTINCT FROM ARRAY['admission','allocation_id','attempt_id','child_event_id',
         'child_outbox_id','lease_fencing_token','lease_token','parent_reservation_id',
         'parent_wait_event_id','parent_wait_outbox_id']::text[]
     OR jsonb_typeof(v_admission)<>'object'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_admission) key)
       IS DISTINCT FROM ARRAY['accepted_output_schema_hash','accepted_output_schema_ref',
         'admission_snapshot_hash','allocated_credits','ancestor_target_refs','async_child_policy',
         'billing_owner_run_id','binding_id','call_sequence','canonical_operation_hash',
         'child_depth','child_plan_hash','child_run_id','compiled_child_ceiling','completed_child_calls',
         'context_projection_object_ref','context_projection_sha256','created_at','delegation',
         'delegation_reason','dependency_pins_hash','link_id','parent_checkpoint_id',
         'parent_checkpoint_object_ref','parent_checkpoint_sha256','parent_depth','parent_plan_hash',
         'parent_run_id','schema_version','target_agent_id','target_agent_release_id','target_ref',
         'workspace_id']::text[]
     OR jsonb_typeof(v_delegation)<>'object'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v_delegation) key)
       IS DISTINCT FROM ARRAY['allowed_target_refs','expires_at','issued_at','max_budget_credits',
         'max_calls','max_depth','policy_hash','schema_version']::text[]
     OR v_delegation->>'schema_version'<>'g1-bounded-child-delegation/1'
     OR v_admission->>'schema_version'<>'g1-join-child-admission/1'
     OR v_admission->>'workspace_id' IS DISTINCT FROM v_workspace_id::text THEN
    RAISE EXCEPTION 'invalid join-child admission envelope' USING ERRCODE='22023';
  END IF;
  SELECT link.* INTO v_existing FROM public.run_parent_links link
   WHERE link.workspace_id=v_workspace_id AND link.child_run_id=(v_admission->>'child_run_id')::uuid;
  IF FOUND THEN
    IF v_existing.parent_run_id IS DISTINCT FROM (v_admission->>'parent_run_id')::uuid
       OR v_existing.parent_plan_hash IS DISTINCT FROM v_admission->>'parent_plan_hash'
       OR v_existing.child_plan_hash IS DISTINCT FROM v_admission->>'child_plan_hash'
       OR v_existing.parent_checkpoint_id IS DISTINCT FROM (v_admission->>'parent_checkpoint_id')::uuid
       OR v_existing.parent_checkpoint_sha256 IS DISTINCT FROM v_admission->>'parent_checkpoint_sha256'
       OR v_existing.canonical_operation_hash IS DISTINCT FROM v_admission->>'canonical_operation_hash'
       OR v_existing.delegation_policy_hash IS DISTINCT FROM v_delegation->>'policy_hash' THEN
      RAISE EXCEPTION 'join-child replay conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('child_run_id',v_existing.child_run_id,'replayed',true);
  END IF;

  PERFORM app.require_execution_owner_lease(p_fact || jsonb_build_object(
    'run_id',v_admission->>'parent_run_id'));
  SELECT * INTO v_parent FROM public.runs WHERE workspace_id=v_workspace_id
    AND id=(v_admission->>'parent_run_id')::uuid FOR UPDATE;
  SELECT * INTO v_execution FROM public.agent_strategy_executions
    WHERE workspace_id=v_workspace_id AND run_id=v_parent.id;
  SELECT item INTO v_catalog FROM jsonb_array_elements(v_execution.compiled_agent_plan->'capability_catalog') item
    WHERE item->>'local_binding_id'=v_admission->>'binding_id';
  v_policy_hash := 'sha256:'||encode(public.digest(
    convert_to(app.g007_canonical_json(v_policy),'UTF8'),'sha256'),'hex');
  IF NOT FOUND OR v_parent.accepted_plan_hash IS DISTINCT FROM v_admission->>'parent_plan_hash'
     OR v_parent.billing_owner_run_id::text IS DISTINCT FROM v_admission->>'billing_owner_run_id'
     OR v_catalog->>'binding_kind'<>'subagent'
     OR v_catalog->>'async_child_policy_hash' IS DISTINCT FROM v_policy_hash
     OR v_catalog->'join_child_ceiling' IS DISTINCT FROM v_admission->'compiled_child_ceiling'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_catalog->'operations') operation
       WHERE operation->>'contract_hash'=v_admission->>'canonical_operation_hash')
     OR v_catalog#>>'{target,published_resource_kind}'<>'AGENT_RELEASE'
     OR v_catalog#>>'{target,resource_id}' IS DISTINCT FROM v_admission->>'target_agent_id'
     OR v_catalog#>>'{target,resource_version_id}' IS DISTINCT FROM v_admission->>'target_agent_release_id' THEN
    RAISE EXCEPTION 'child target or policy is not fixed by the parent Plan' USING ERRCODE='42501';
  END IF;
  IF v_policy IS DISTINCT FROM jsonb_build_object(
    'schema_version','async-child-policy/1','invocation','async','completion_policy','join',
    'cancel_propagation','cascade','result_projection','safe_summary',
    'parent_terminal_policy','wait_for_settlement','terminal_outcome_map',jsonb_build_object(
      'schema_version','g1-join-child-terminal-map/1',
      'SUCCEEDED','PARENT_CALL_SUCCEEDED_CONTINUE','FAILED','PARENT_CALL_FAILED_PARENT_FAILED',
      'CANCELLED','PARENT_CALL_CANCELLED_PARENT_CANCELLED',
      'TIMED_OUT','PARENT_CALL_FAILED_CHILD_TIMED_OUT_PARENT_FAILED',
      'NEEDS_ATTENTION','PARENT_CALL_AND_RUN_NEEDS_ATTENTION')) THEN
    RAISE EXCEPTION 'only the frozen G1 join child policy is supported' USING ERRCODE='22023';
  END IF;
  v_parent_depth := CASE WHEN v_parent.run_kind='top_level' THEN 0 ELSE
    (SELECT child_depth FROM public.run_parent_links WHERE workspace_id=v_workspace_id AND child_run_id=v_parent.id) END;
  SELECT count(*)::integer INTO v_completed FROM public.run_parent_links
    WHERE workspace_id=v_workspace_id AND parent_run_id=v_parent.id;
  WITH RECURSIVE ancestry AS (
    SELECT v_parent.id AS run_id,
      CASE WHEN v_parent.run_kind='top_level'
        THEN 'agent-release:'||v_parent.agent_id::text||':'||v_parent.agent_release_id::text
        ELSE (SELECT target_ref FROM public.run_parent_links WHERE workspace_id=v_workspace_id AND child_run_id=v_parent.id) END AS target_ref,
      (SELECT parent_run_id FROM public.run_parent_links WHERE workspace_id=v_workspace_id AND child_run_id=v_parent.id) AS next_id
    UNION ALL
    SELECT ancestor.id,
      CASE WHEN ancestor.run_kind='top_level'
        THEN 'agent-release:'||ancestor.agent_id::text||':'||ancestor.agent_release_id::text ELSE link.target_ref END,
      link.parent_run_id
    FROM ancestry prior JOIN public.runs ancestor ON ancestor.workspace_id=v_workspace_id AND ancestor.id=prior.next_id
    LEFT JOIN public.run_parent_links link ON link.workspace_id=v_workspace_id AND link.child_run_id=ancestor.id
   ) SELECT jsonb_agg(target_ref ORDER BY target_ref),bool_or(target_ref=v_admission->>'target_ref')
     INTO STRICT v_ancestor_refs,v_recursive FROM ancestry;
   IF v_recursive THEN
    RAISE EXCEPTION 'recursive child target is denied' USING ERRCODE='42501';
  END IF;
  IF v_admission->'ancestor_target_refs' IS DISTINCT FROM v_ancestor_refs
     OR v_admission#>>'{compiled_child_ceiling,target_ref}' IS DISTINCT FROM v_admission->>'target_ref'
     OR v_admission#>>'{compiled_child_ceiling,delegation_policy_hash}'
       IS DISTINCT FROM v_delegation->>'policy_hash'
     OR (v_admission#>>'{compiled_child_ceiling,max_calls}')::integer
       IS DISTINCT FROM (v_delegation->>'max_calls')::integer
     OR (v_admission#>>'{compiled_child_ceiling,max_depth}')::integer
       IS DISTINCT FROM (v_delegation->>'max_depth')::integer
     OR (v_admission#>>'{compiled_child_ceiling,max_budget_credits}')::bigint
       IS DISTINCT FROM (v_delegation->>'max_budget_credits')::bigint
     OR (v_delegation->>'expires_at')::timestamptz-(v_delegation->>'issued_at')::timestamptz
       > make_interval(secs=>(v_admission#>>'{compiled_child_ceiling,max_ttl_seconds}')::integer)
     OR (v_admission->>'parent_depth')::integer<>v_parent_depth
     OR (v_admission->>'child_depth')::integer<>v_parent_depth+1
     OR (v_admission->>'completed_child_calls')::integer<>v_completed
     OR (v_admission->>'call_sequence')::integer<>v_completed+1
     OR NOT (v_delegation->'allowed_target_refs' ? (v_admission->>'target_ref'))
     OR (v_admission->>'call_sequence')::integer>(v_delegation->>'max_calls')::integer
     OR (v_admission->>'child_depth')::integer>(v_delegation->>'max_depth')::integer
     OR (v_admission->>'allocated_credits')::bigint>(v_delegation->>'max_budget_credits')::bigint
     OR (v_admission->>'created_at')::timestamptz<(v_delegation->>'issued_at')::timestamptz
     OR (v_admission->>'created_at')::timestamptz>=(v_delegation->>'expires_at')::timestamptz
     OR clock_timestamp()>=(v_delegation->>'expires_at')::timestamptz THEN
    RAISE EXCEPTION 'bounded child delegation is invalid or expired' USING ERRCODE='42501';
  END IF;

  INSERT INTO public.runs(workspace_id,id,run_kind,billing_owner_run_id,accepted_request_id,
    accepted_principal_kind,accepted_credential_id,accepted_end_user_principal_id,fixed_route,
    intent_hash,admission_snapshot_hash,accepted_plan_hash,accepted_output_schema_ref,
    accepted_output_schema_hash,dependency_pins_hash,target_kind,agent_id,agent_release_id,
    status,execution_status,billing_state,acceptance_receipt_data_redacted,last_event_sequence,accepted_at)
  VALUES(v_workspace_id,(v_admission->>'child_run_id')::uuid,'join_child',v_parent.billing_owner_run_id,
    v_parent.accepted_request_id,v_parent.accepted_principal_kind,v_parent.accepted_credential_id,
    v_parent.accepted_end_user_principal_id,'/v1/oapi/agent/chat',
    v_admission->>'canonical_operation_hash',v_admission->>'admission_snapshot_hash',
    v_admission->>'child_plan_hash',v_admission->>'accepted_output_schema_ref',
    v_admission->>'accepted_output_schema_hash',v_admission->>'dependency_pins_hash','agent',
    (v_admission->>'target_agent_id')::uuid,(v_admission->>'target_agent_release_id')::uuid,
    'QUEUED','ACCEPTED','PENDING',jsonb_build_object('parent_run_id',v_parent.id),1,
     (v_admission->>'created_at')::timestamptz) ON CONFLICT DO NOTHING;
  SELECT * INTO v_child FROM public.runs WHERE workspace_id=v_workspace_id
    AND id=(v_admission->>'child_run_id')::uuid;
  IF NOT FOUND OR v_child.run_kind<>'join_child'
     OR v_child.billing_owner_run_id IS DISTINCT FROM v_parent.billing_owner_run_id
     OR v_child.accepted_plan_hash IS DISTINCT FROM v_admission->>'child_plan_hash'
     OR v_child.agent_id IS DISTINCT FROM (v_admission->>'target_agent_id')::uuid
     OR v_child.agent_release_id IS DISTINCT FROM (v_admission->>'target_agent_release_id')::uuid THEN
    RAISE EXCEPTION 'child Run identity conflicts with an existing Run' USING ERRCODE='23505';
  END IF;
  INSERT INTO public.run_checkpoints(workspace_id,id,run_id,step_id,checkpoint_hash,
    payload_ref,payload_redacted,created_at)
  VALUES(v_workspace_id,(v_admission->>'parent_checkpoint_id')::uuid,v_parent.id,NULL,
    v_admission->>'parent_checkpoint_sha256',v_admission->>'parent_checkpoint_object_ref',
    jsonb_build_object('waiting_for_child_run_id',v_admission->>'child_run_id'),
    (v_admission->>'created_at')::timestamptz);
  INSERT INTO public.run_parent_links(workspace_id,id,child_run_id,parent_run_id,billing_owner_run_id,
    completion_policy,cancel_propagation,result_projection,parent_terminal_policy,parent_plan_hash,
    child_plan_hash,canonical_operation_hash,binding_id,target_ref,ancestor_target_refs,parent_depth,
    child_depth,call_sequence,delegation_policy_hash,delegation_reason,delegation_expires_at,
    context_projection_object_ref,context_projection_sha256,parent_checkpoint_id,
    parent_checkpoint_object_ref,parent_checkpoint_sha256,created_at)
  VALUES(v_workspace_id,(v_admission->>'link_id')::uuid,(v_admission->>'child_run_id')::uuid,
    v_parent.id,v_parent.billing_owner_run_id,'join','cascade','safe_summary','wait_for_settlement',
    v_admission->>'parent_plan_hash',v_admission->>'child_plan_hash',
    v_admission->>'canonical_operation_hash',v_admission->>'binding_id',v_admission->>'target_ref',
    v_ancestor_refs,v_parent_depth,v_parent_depth+1,(v_admission->>'call_sequence')::integer,
    v_delegation->>'policy_hash',v_admission->>'delegation_reason',
    (v_delegation->>'expires_at')::timestamptz,v_admission->>'context_projection_object_ref',
    v_admission->>'context_projection_sha256',(v_admission->>'parent_checkpoint_id')::uuid,
    v_admission->>'parent_checkpoint_object_ref',v_admission->>'parent_checkpoint_sha256',
    (v_admission->>'created_at')::timestamptz);
  PERFORM app.allocate_child_run_budget(jsonb_build_object('workspace_id',v_workspace_id,
    'allocation_id',p_fact->>'allocation_id','child_run_id',v_admission->>'child_run_id',
    'parent_run_id',v_parent.id,'parent_reservation_id',p_fact->>'parent_reservation_id',
    'billing_owner_run_id',v_parent.billing_owner_run_id,
    'allocated_credits',v_admission->>'allocated_credits'));
  v_event_payload:=jsonb_build_object('parent_run_id',v_parent.id,'child_run_id',v_admission->>'child_run_id');
  INSERT INTO public.run_events(workspace_id,id,run_id,sequence,event_type,dedupe_key,payload_redacted,occurred_at)
  VALUES(v_workspace_id,(p_fact->>'child_event_id')::uuid,(v_admission->>'child_run_id')::uuid,1,
    'RUN_ACCEPTED','join-child:'||v_parent.id::text,v_event_payload,(v_admission->>'created_at')::timestamptz);
  v_parent_sequence:=v_parent.last_event_sequence+1;
  INSERT INTO public.run_events(workspace_id,id,run_id,sequence,event_type,dedupe_key,payload_redacted,occurred_at)
  VALUES(v_workspace_id,(p_fact->>'parent_wait_event_id')::uuid,v_parent.id,v_parent_sequence,
    'RUN_WAITING','join-child:'||(v_admission->>'child_run_id'),
    jsonb_build_object('status','WAITING_FOR_CHILD','child_run_id',v_admission->>'child_run_id'),
    (v_admission->>'created_at')::timestamptz);
  v_outbox_payload:=jsonb_build_object('run_id',v_admission->>'child_run_id','parent_run_id',v_parent.id);
  INSERT INTO public.outbox(workspace_id,id,run_id,message_type,dedupe_key,payload_ref,payload_hash,
    producer_fencing_token,payload_redacted,status,available_at,created_at)
  VALUES(v_workspace_id,(p_fact->>'child_outbox_id')::uuid,(v_admission->>'child_run_id')::uuid,
    'RUN_DISPATCH','join-child:'||v_parent.id::text,'run:'||(v_admission->>'child_run_id')||':dispatch',
    'sha256:'||encode(public.digest(convert_to(app.g007_canonical_json(v_outbox_payload),'UTF8'),'sha256'),'hex'),
    (p_fact->>'lease_fencing_token')::bigint,v_outbox_payload,'PENDING',
    (v_admission->>'created_at')::timestamptz,(v_admission->>'created_at')::timestamptz);
  INSERT INTO public.outbox(workspace_id,id,run_id,message_type,dedupe_key,payload_ref,payload_hash,
    producer_fencing_token,payload_redacted,status,available_at,created_at)
  VALUES(v_workspace_id,(p_fact->>'parent_wait_outbox_id')::uuid,v_parent.id,'SSE_WAKE',
    'join-child-wait:'||(v_admission->>'child_run_id'),
    'run:'||v_parent.id::text||':join-child-wait:'||(v_admission->>'child_run_id'),
    'sha256:'||encode(public.digest(convert_to(app.g007_canonical_json(jsonb_build_object(
      'run_id',v_parent.id,'status','WAITING_FOR_CHILD','child_run_id',v_admission->>'child_run_id')),
      'UTF8'),'sha256'),'hex'),(p_fact->>'lease_fencing_token')::bigint,
    jsonb_build_object('run_id',v_parent.id,'status','WAITING_FOR_CHILD'),
    'PENDING',(v_admission->>'created_at')::timestamptz,(v_admission->>'created_at')::timestamptz);
  UPDATE public.run_attempts SET status='RELINQUISHED',lease_owner=NULL,lease_token=NULL,
    lease_fencing_token=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=v_workspace_id AND id=(p_fact->>'attempt_id')::uuid;
  UPDATE public.runs SET status='WAITING_FOR_CHILD',execution_status='WAITING_FOR_CHILD',
    last_event_sequence=v_parent_sequence
    WHERE workspace_id=v_workspace_id AND id=v_parent.id;
  RETURN jsonb_build_object('child_run_id',v_admission->>'child_run_id','replayed',false);
END;
$function$;
REVOKE ALL ON FUNCTION app.create_child_run(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_child_run(jsonb) TO ba_execution_executor;
RESET ROLE;
