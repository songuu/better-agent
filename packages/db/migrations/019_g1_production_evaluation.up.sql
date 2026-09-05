-- G1-A7 immutable evaluation evidence and one shared Agent/Flow production CAS.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.evaluation_suite_releases (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  dataset_release_id uuid NOT NULL,
  dataset_hash text NOT NULL CHECK (dataset_hash ~ '^sha256:[0-9a-f]{64}$'),
  evaluator_pins jsonb NOT NULL CHECK (
    jsonb_typeof(evaluator_pins)='array' AND jsonb_array_length(evaluator_pins)>0
  ),
  evaluation_policy jsonb NOT NULL CHECK (
    evaluation_policy->>'schema_version'='production-evaluation-policy/1'
  ),
  evaluation_policy_hash text NOT NULL
    CHECK (evaluation_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  suite_hash text NOT NULL CHECK (suite_hash ~ '^sha256:[0-9a-f]{64}$'),
  registered_by text NOT NULL CHECK (length(btrim(registered_by))>0),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,id,suite_hash)
);

CREATE TABLE public.evaluation_runs (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  evaluation_suite_release_id uuid NOT NULL,
  evaluation_suite_hash text NOT NULL CHECK (evaluation_suite_hash ~ '^sha256:[0-9a-f]{64}$'),
  deployment_kind text NOT NULL CHECK (deployment_kind IN ('agent','flow')),
  deployment_id uuid NOT NULL,
  deployment_revision_id uuid NOT NULL,
  revision_contract_hash text NOT NULL CHECK (revision_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_kind text NOT NULL CHECK (target_kind IN ('AGENT_RELEASE','FLOW_VERSION')),
  target_resource_id uuid NOT NULL,
  target_resource_version_id uuid NOT NULL,
  target_contract_hash text NOT NULL CHECK (target_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  capability_closure_hash text NOT NULL CHECK (capability_closure_hash ~ '^sha256:[0-9a-f]{64}$'),
  strategy_release_id uuid,
  strategy_contract_hash text CHECK (strategy_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  flow_plan_hash text CHECK (flow_plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  model_policy_hash text NOT NULL CHECK (model_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  knowledge_generation_ids text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('PASSED','FAILED','INVALIDATED')),
  case_count bigint NOT NULL CHECK (case_count>0),
  passed_case_count bigint NOT NULL CHECK (passed_case_count BETWEEN 0 AND case_count),
  safety_passed_case_count bigint NOT NULL CHECK (safety_passed_case_count BETWEEN 0 AND case_count),
  cost_micredits bigint NOT NULL CHECK (cost_micredits>=0),
  p95_latency_ms bigint NOT NULL CHECK (p95_latency_ms>=0),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  observed_evidence_epoch_hash text NOT NULL
    CHECK (observed_evidence_epoch_hash ~ '^sha256:[0-9a-f]{64}$'),
  invalidation_reason text,
  completed_at timestamptz NOT NULL,
  registered_by text NOT NULL CHECK (length(btrim(registered_by))>0),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,evaluation_suite_release_id,evaluation_suite_hash)
    REFERENCES public.evaluation_suite_releases(workspace_id,id,suite_hash),
  FOREIGN KEY(workspace_id,target_kind,target_resource_id,target_resource_version_id)
    REFERENCES public.published_executable_closures(
      workspace_id,published_resource_kind,resource_id,resource_version_id),
  CHECK (
    (deployment_kind='agent' AND target_kind='AGENT_RELEASE'
      AND strategy_release_id IS NOT NULL AND strategy_contract_hash IS NOT NULL
      AND flow_plan_hash IS NULL)
    OR
    (deployment_kind='flow' AND target_kind='FLOW_VERSION'
      AND strategy_release_id IS NULL AND strategy_contract_hash IS NULL
      AND flow_plan_hash IS NOT NULL)
  ),
  CHECK ((status='INVALIDATED')=(invalidation_reason IS NOT NULL))
);

CREATE TABLE public.evaluation_evidence_bundles (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  evidence_bundle_hash text NOT NULL CHECK (evidence_bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  evaluation_suite_release_id uuid NOT NULL,
  evaluation_suite_hash text NOT NULL CHECK (evaluation_suite_hash ~ '^sha256:[0-9a-f]{64}$'),
  evaluation_policy_hash text NOT NULL CHECK (evaluation_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  evaluation_run_ids uuid[] NOT NULL CHECK (cardinality(evaluation_run_ids)>0),
  deployment_kind text NOT NULL CHECK (deployment_kind IN ('agent','flow')),
  deployment_id uuid NOT NULL,
  deployment_revision_id uuid NOT NULL,
  revision_contract_hash text NOT NULL CHECK (revision_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_kind text NOT NULL CHECK (target_kind IN ('AGENT_RELEASE','FLOW_VERSION')),
  target_resource_id uuid NOT NULL,
  target_resource_version_id uuid NOT NULL,
  target_contract_hash text NOT NULL CHECK (target_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  capability_closure_hash text NOT NULL CHECK (capability_closure_hash ~ '^sha256:[0-9a-f]{64}$'),
  total_case_count bigint NOT NULL CHECK (total_case_count>0),
  passed_case_count bigint NOT NULL CHECK (passed_case_count BETWEEN 0 AND total_case_count),
  safety_passed_case_count bigint NOT NULL CHECK (safety_passed_case_count BETWEEN 0 AND total_case_count),
  total_cost_micredits bigint NOT NULL CHECK (total_cost_micredits>=0),
  p95_latency_ms bigint NOT NULL CHECK (p95_latency_ms>=0),
  observed_evidence_epoch_hash text NOT NULL
    CHECK (observed_evidence_epoch_hash ~ '^sha256:[0-9a-f]{64}$'),
  registered_by text NOT NULL CHECK (length(btrim(registered_by))>0),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,evidence_bundle_hash),
  FOREIGN KEY(workspace_id,evaluation_suite_release_id,evaluation_suite_hash)
    REFERENCES public.evaluation_suite_releases(workspace_id,id,suite_hash)
);

CREATE TABLE public.production_promotion_decisions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  key_hash text NOT NULL CHECK (key_hash ~ '^sha256:[0-9a-f]{64}$'),
  deployment_kind text NOT NULL CHECK (deployment_kind IN ('agent','flow')),
  deployment_id uuid NOT NULL,
  candidate_revision_id uuid NOT NULL,
  candidate_revision_contract_hash text NOT NULL
    CHECK (candidate_revision_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  target_kind text NOT NULL CHECK (target_kind IN ('AGENT_RELEASE','FLOW_VERSION')),
  target_resource_id uuid NOT NULL,
  target_resource_version_id uuid NOT NULL,
  target_contract_hash text NOT NULL CHECK (target_contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  dependency_manifest_hash text NOT NULL CHECK (dependency_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  capability_closure_hash text NOT NULL CHECK (capability_closure_hash ~ '^sha256:[0-9a-f]{64}$'),
  evaluation_suite_release_id uuid NOT NULL,
  evaluation_policy_hash text NOT NULL CHECK (evaluation_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  evaluation_run_ids uuid[] NOT NULL CHECK (cardinality(evaluation_run_ids)>0),
  evidence_bundle_hash text NOT NULL CHECK (evidence_bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  observed_evidence_epoch_hash text NOT NULL
    CHECK (observed_evidence_epoch_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_activation_epoch bigint NOT NULL CHECK (expected_activation_epoch>=0),
  status text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','INVALIDATED','CONSUMED')),
  decision_version bigint NOT NULL CHECK (decision_version>0),
  expires_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  consumed_at timestamptz,
  created_by text NOT NULL CHECK (length(btrim(created_by))>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,id,decision_version),
  FOREIGN KEY(workspace_id,evidence_bundle_hash)
    REFERENCES public.evaluation_evidence_bundles(workspace_id,evidence_bundle_hash),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
  CHECK (
    (status='PENDING' AND decided_by IS NULL AND decided_at IS NULL
      AND invalidated_at IS NULL AND invalidation_reason IS NULL AND consumed_at IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND invalidated_at IS NULL AND invalidation_reason IS NULL AND consumed_at IS NULL)
    OR (status='INVALIDATED' AND invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL
      AND consumed_at IS NULL)
    OR (status='CONSUMED' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND invalidated_at IS NULL AND invalidation_reason IS NULL AND consumed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX production_promotion_decisions_live_key
  ON public.production_promotion_decisions(workspace_id,key_hash)
  WHERE status IN ('PENDING','APPROVED');

CREATE FUNCTION app.reject_g1_production_evaluation_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'production evaluation facts are immutable' USING ERRCODE='55000';
END;
$function$;
REVOKE ALL ON FUNCTION app.reject_g1_production_evaluation_immutable() FROM PUBLIC;

DO $tables$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'evaluation_suite_releases','evaluation_runs','evaluation_evidence_bundles',
    'production_promotion_decisions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO ba_authorization_owner',v_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO ba_authorization_owner USING (true) WITH CHECK (true)',
      v_table||'_owner_only',v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',v_table);
  END LOOP;
END;
$tables$;

-- Evaluation registration runs before a control-plane tenant session exists.
-- The NOLOGIN authorization owner may read only the immutable candidate facts
-- while the invoking login is the host-attested reviewer role. Direct table
-- access is still revoked from that login below.
CREATE POLICY published_executable_closures_evaluation_reviewer_read
  ON public.published_executable_closures FOR SELECT TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'));
CREATE POLICY agent_deployments_evaluation_reviewer_read
  ON public.agent_deployments FOR SELECT TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'));
CREATE POLICY agent_deployments_evaluation_reviewer_lock
  ON public.agent_deployments FOR UPDATE TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'))
  WITH CHECK (false);
CREATE POLICY agent_deployment_revisions_evaluation_reviewer_read
  ON public.agent_deployment_revisions FOR SELECT TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'));
CREATE POLICY agent_deployment_pointers_evaluation_reviewer_read
  ON public.agent_deployment_active_pointers FOR SELECT TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'));
CREATE POLICY flow_deployments_evaluation_reviewer_read
  ON public.flow_deployments FOR SELECT TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'));
CREATE POLICY flow_deployments_evaluation_reviewer_lock
  ON public.flow_deployments FOR UPDATE TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'))
  WITH CHECK (false);
CREATE POLICY flow_deployment_revisions_evaluation_reviewer_read
  ON public.flow_deployment_revisions FOR SELECT TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'));
CREATE POLICY flow_deployment_pointers_evaluation_reviewer_read
  ON public.flow_deployment_active_pointers FOR SELECT TO ba_authorization_owner
  USING (pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER'));

CREATE TRIGGER evaluation_suite_releases_immutable BEFORE UPDATE OR DELETE
  ON public.evaluation_suite_releases FOR EACH ROW
  EXECUTE FUNCTION app.reject_g1_production_evaluation_immutable();
CREATE TRIGGER evaluation_runs_immutable BEFORE UPDATE OR DELETE
  ON public.evaluation_runs FOR EACH ROW
  EXECUTE FUNCTION app.reject_g1_production_evaluation_immutable();
CREATE TRIGGER evaluation_evidence_bundles_immutable BEFORE UPDATE OR DELETE
  ON public.evaluation_evidence_bundles FOR EACH ROW
  EXECUTE FUNCTION app.reject_g1_production_evaluation_immutable();

CREATE FUNCTION app.guard_production_promotion_decision_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'production promotion decision deletion rejected' USING ERRCODE='55000';
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.key_hash IS DISTINCT FROM NEW.key_hash
     OR OLD.deployment_kind IS DISTINCT FROM NEW.deployment_kind
     OR OLD.deployment_id IS DISTINCT FROM NEW.deployment_id
     OR OLD.candidate_revision_id IS DISTINCT FROM NEW.candidate_revision_id
     OR OLD.candidate_revision_contract_hash IS DISTINCT FROM NEW.candidate_revision_contract_hash
     OR OLD.target_kind IS DISTINCT FROM NEW.target_kind
     OR OLD.target_resource_id IS DISTINCT FROM NEW.target_resource_id
     OR OLD.target_resource_version_id IS DISTINCT FROM NEW.target_resource_version_id
     OR OLD.target_contract_hash IS DISTINCT FROM NEW.target_contract_hash
     OR OLD.dependency_manifest_hash IS DISTINCT FROM NEW.dependency_manifest_hash
     OR OLD.capability_closure_hash IS DISTINCT FROM NEW.capability_closure_hash
     OR OLD.evaluation_suite_release_id IS DISTINCT FROM NEW.evaluation_suite_release_id
     OR OLD.evaluation_policy_hash IS DISTINCT FROM NEW.evaluation_policy_hash
     OR OLD.evaluation_run_ids IS DISTINCT FROM NEW.evaluation_run_ids
     OR OLD.evidence_bundle_hash IS DISTINCT FROM NEW.evidence_bundle_hash
     OR OLD.observed_evidence_epoch_hash IS DISTINCT FROM NEW.observed_evidence_epoch_hash
     OR OLD.expected_activation_epoch IS DISTINCT FROM NEW.expected_activation_epoch
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR NEW.decision_version<>OLD.decision_version+1
     OR NOT ((OLD.status='PENDING' AND NEW.status IN ('APPROVED','REJECTED','INVALIDATED'))
       OR (OLD.status='APPROVED' AND NEW.status IN ('CONSUMED','INVALIDATED'))) THEN
    RAISE EXCEPTION 'production promotion decision mutation rejected' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER production_promotion_decisions_guard BEFORE UPDATE OR DELETE
  ON public.production_promotion_decisions FOR EACH ROW
  EXECUTE FUNCTION app.guard_production_promotion_decision_update();

CREATE FUNCTION app.register_evaluation_suite_release(p_suite jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid;
  v_id uuid;
  v_actor text:=session_user;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR jsonb_typeof(p_suite)<>'object'
     OR p_suite->>'schema_version'<>'evaluation-suite-release/1'
     OR p_suite->>'workspace_id' IS NULL
     OR jsonb_typeof(p_suite->'evaluator_pins')<>'array'
     OR jsonb_array_length(p_suite->'evaluator_pins')=0
     OR p_suite->>'dataset_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR p_suite->>'policy_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR p_suite->>'suite_hash' !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid evaluation suite release' USING ERRCODE='22023';
  END IF;
  v_workspace_id:=(p_suite->>'workspace_id')::uuid;
  v_id:=(p_suite->>'evaluation_suite_release_id')::uuid;
  INSERT INTO public.evaluation_suite_releases(
    workspace_id,id,dataset_release_id,dataset_hash,evaluator_pins,evaluation_policy,
    evaluation_policy_hash,suite_hash,registered_by)
  VALUES(v_workspace_id,v_id,(p_suite->>'dataset_release_id')::uuid,p_suite->>'dataset_hash',
    p_suite->'evaluator_pins',p_suite->'policy',p_suite->>'policy_hash',p_suite->>'suite_hash',v_actor);
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.register_evaluation_run(p_run jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid;
  v_id uuid;
  v_actor text:=session_user;
  v_target jsonb:=p_run->'executable_target';
  v_generations text[];
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR p_run->>'schema_version'<>'evaluation-run/1'
     OR p_run->>'workspace_id' IS NULL
     OR p_run->>'status' NOT IN ('PASSED','FAILED','INVALIDATED') THEN
    RAISE EXCEPTION 'invalid terminal evaluation Run' USING ERRCODE='22023';
  END IF;
  v_workspace_id:=(p_run->>'workspace_id')::uuid;
  SELECT COALESCE(array_agg(value ORDER BY value),'{}'::text[]) INTO v_generations
  FROM jsonb_array_elements_text(p_run->'knowledge_generation_ids') AS value;
  IF to_jsonb(v_generations)<>p_run->'knowledge_generation_ids' THEN
    RAISE EXCEPTION 'evaluation Run knowledge pins are not canonical' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.published_executable_closures closure
  WHERE closure.workspace_id=v_workspace_id
    AND closure.published_resource_kind=v_target->>'published_resource_kind'
    AND closure.resource_id=(v_target->>'resource_id')::uuid
    AND closure.resource_version_id=(v_target->>'resource_version_id')::uuid
    AND closure.contract_hash=v_target->>'contract_hash'
    AND closure.dependency_manifest_hash=p_run->>'dependency_manifest_hash'
    AND closure.capability_closure_hash=p_run->>'capability_closure_hash';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evaluation Run executable closure mismatch' USING ERRCODE='23503';
  END IF;
  IF p_run->>'candidate_deployment_kind'='agent' THEN
    PERFORM 1 FROM public.agent_deployments deployment
    JOIN public.agent_deployment_revisions revision
      ON revision.workspace_id=deployment.workspace_id
     AND revision.agent_deployment_id=deployment.id
    WHERE deployment.workspace_id=v_workspace_id
      AND deployment.id=(p_run->>'candidate_deployment_id')::uuid
      AND deployment.environment='production'
      AND revision.id=(p_run->>'candidate_deployment_revision_id')::uuid
      AND revision.revision_contract_hash=p_run->>'candidate_revision_contract_hash'
      AND revision.agent_id=(v_target->>'resource_id')::uuid
      AND revision.agent_release_id=(v_target->>'resource_version_id')::uuid
      AND revision.agent_release_contract_hash=v_target->>'contract_hash'
      AND revision.dependency_manifest_hash=p_run->>'dependency_manifest_hash';
  ELSIF p_run->>'candidate_deployment_kind'='flow' THEN
    PERFORM 1 FROM public.flow_deployments deployment
    JOIN public.flow_deployment_revisions revision
      ON revision.workspace_id=deployment.workspace_id
     AND revision.flow_deployment_id=deployment.id
    WHERE deployment.workspace_id=v_workspace_id
      AND deployment.id=(p_run->>'candidate_deployment_id')::uuid
      AND deployment.environment='production'
      AND revision.id=(p_run->>'candidate_deployment_revision_id')::uuid
      AND revision.revision_contract_hash=p_run->>'candidate_revision_contract_hash'
      AND revision.flow_id=(v_target->>'resource_id')::uuid
      AND revision.flow_version_id=(v_target->>'resource_version_id')::uuid
      AND revision.flow_version_contract_hash=v_target->>'contract_hash'
      AND revision.dependency_manifest_hash=p_run->>'dependency_manifest_hash';
  ELSE
    RAISE EXCEPTION 'unknown evaluation deployment kind' USING ERRCODE='22023';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evaluation Run candidate mismatch' USING ERRCODE='23503';
  END IF;
  v_id:=(p_run->>'evaluation_run_id')::uuid;
  INSERT INTO public.evaluation_runs(
    workspace_id,id,evaluation_suite_release_id,evaluation_suite_hash,deployment_kind,
    deployment_id,deployment_revision_id,revision_contract_hash,target_kind,target_resource_id,
    target_resource_version_id,target_contract_hash,dependency_manifest_hash,capability_closure_hash,
    strategy_release_id,strategy_contract_hash,flow_plan_hash,model_policy_hash,
    knowledge_generation_ids,status,case_count,passed_case_count,safety_passed_case_count,
    cost_micredits,p95_latency_ms,evidence_hash,observed_evidence_epoch_hash,
    invalidation_reason,completed_at,registered_by)
  VALUES(v_workspace_id,v_id,(p_run->>'evaluation_suite_release_id')::uuid,
    p_run->>'evaluation_suite_hash',p_run->>'candidate_deployment_kind',
    (p_run->>'candidate_deployment_id')::uuid,(p_run->>'candidate_deployment_revision_id')::uuid,
    p_run->>'candidate_revision_contract_hash',v_target->>'published_resource_kind',
    (v_target->>'resource_id')::uuid,(v_target->>'resource_version_id')::uuid,
    v_target->>'contract_hash',p_run->>'dependency_manifest_hash',p_run->>'capability_closure_hash',
    (p_run->>'strategy_release_id')::uuid,p_run->>'strategy_contract_hash',
    p_run->>'flow_plan_hash',p_run->>'model_policy_hash',v_generations,p_run->>'status',
    (p_run->>'case_count')::bigint,(p_run->>'passed_case_count')::bigint,
    (p_run->>'safety_passed_case_count')::bigint,(p_run->>'cost_micredits')::bigint,
    (p_run->>'p95_latency_ms')::bigint,p_run->>'evidence_hash',
    p_run->>'observed_evidence_epoch_hash',p_run->>'invalidation_reason',
    (p_run->>'completed_at')::timestamptz,v_actor);
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.register_evaluation_evidence_bundle(p_bundle jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid;
  v_actor text:=session_user;
  v_run_ids uuid[];
  v_count bigint;
  v_distinct_count bigint;
  v_bad boolean;
  v_total_cases bigint;
  v_passed bigint;
  v_safety bigint;
  v_cost bigint;
  v_latency bigint;
  v_policy jsonb;
  v_target jsonb:=p_bundle->'executable_target';
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR p_bundle->>'schema_version'<>'evaluation-evidence-bundle/1'
     OR p_bundle->>'workspace_id' IS NULL THEN
    RAISE EXCEPTION 'invalid evaluation evidence bundle' USING ERRCODE='22023';
  END IF;
  v_workspace_id:=(p_bundle->>'workspace_id')::uuid;
  SELECT array_agg(value::uuid ORDER BY value::uuid),count(*),count(DISTINCT value)
    INTO v_run_ids,v_count,v_distinct_count
  FROM jsonb_array_elements_text(p_bundle->'evaluation_run_ids') AS value;
  IF v_count=0 OR v_count<>v_distinct_count OR to_jsonb(v_run_ids)<>p_bundle->'evaluation_run_ids' THEN
    RAISE EXCEPTION 'evaluation Run set is not canonical' USING ERRCODE='22023';
  END IF;
  SELECT bool_or(evaluation_run.status<>'PASSED'
      OR evaluation_run.evaluation_suite_release_id<>(p_bundle->>'evaluation_suite_release_id')::uuid
      OR evaluation_run.evaluation_suite_hash<>p_bundle->>'evaluation_suite_hash'
      OR evaluation_run.deployment_kind<>p_bundle->>'candidate_deployment_kind'
      OR evaluation_run.deployment_id<>(p_bundle->>'candidate_deployment_id')::uuid
      OR evaluation_run.deployment_revision_id<>(p_bundle->>'candidate_deployment_revision_id')::uuid
      OR evaluation_run.revision_contract_hash<>p_bundle->>'candidate_revision_contract_hash'
      OR evaluation_run.target_kind<>v_target->>'published_resource_kind'
      OR evaluation_run.target_resource_id<>(v_target->>'resource_id')::uuid
      OR evaluation_run.target_resource_version_id<>(v_target->>'resource_version_id')::uuid
      OR evaluation_run.target_contract_hash<>v_target->>'contract_hash'
      OR evaluation_run.dependency_manifest_hash<>p_bundle->>'dependency_manifest_hash'
      OR evaluation_run.capability_closure_hash<>p_bundle->>'capability_closure_hash'
      OR evaluation_run.observed_evidence_epoch_hash<>p_bundle->>'observed_evidence_epoch_hash'),
    count(*),sum(case_count),sum(passed_case_count),sum(safety_passed_case_count),
    sum(cost_micredits),max(p95_latency_ms)
  INTO v_bad,v_count,v_total_cases,v_passed,v_safety,v_cost,v_latency
  FROM public.evaluation_runs evaluation_run
  WHERE evaluation_run.workspace_id=v_workspace_id AND evaluation_run.id=ANY(v_run_ids);
  IF v_count<>cardinality(v_run_ids) OR COALESCE(v_bad,true)
     OR v_total_cases<>(p_bundle->>'total_case_count')::bigint
     OR v_passed<>(p_bundle->>'passed_case_count')::bigint
     OR v_safety<>(p_bundle->>'safety_passed_case_count')::bigint
     OR v_cost<>(p_bundle->>'total_cost_micredits')::bigint
     OR v_latency<>(p_bundle->>'p95_latency_ms')::bigint THEN
    RAISE EXCEPTION 'evaluation evidence aggregate mismatch' USING ERRCODE='42501';
  END IF;
  SELECT suite.evaluation_policy INTO v_policy
  FROM public.evaluation_suite_releases suite
  WHERE suite.workspace_id=v_workspace_id
    AND suite.id=(p_bundle->>'evaluation_suite_release_id')::uuid
    AND suite.suite_hash=p_bundle->>'evaluation_suite_hash'
    AND suite.evaluation_policy_hash=p_bundle->>'evaluation_policy_hash';
  IF v_policy IS NULL OR v_total_cases<(v_policy->>'minimum_case_count')::bigint
     OR v_passed::numeric*1000000<v_total_cases::numeric*(v_policy->>'minimum_pass_rate_ppm')::bigint
     OR v_safety::numeric*1000000<v_total_cases::numeric*(v_policy->>'minimum_safety_rate_ppm')::bigint
     OR v_cost>(v_policy->>'maximum_cost_micredits')::bigint
     OR v_latency>(v_policy->>'maximum_p95_latency_ms')::bigint THEN
    RAISE EXCEPTION 'production evaluation threshold failed' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.evaluation_evidence_bundles(
    workspace_id,evidence_bundle_hash,evaluation_suite_release_id,evaluation_suite_hash,
    evaluation_policy_hash,evaluation_run_ids,deployment_kind,deployment_id,
    deployment_revision_id,revision_contract_hash,target_kind,target_resource_id,
    target_resource_version_id,target_contract_hash,dependency_manifest_hash,
    capability_closure_hash,total_case_count,passed_case_count,safety_passed_case_count,
    total_cost_micredits,p95_latency_ms,observed_evidence_epoch_hash,registered_by)
  VALUES(v_workspace_id,p_bundle->>'evidence_bundle_hash',
    (p_bundle->>'evaluation_suite_release_id')::uuid,p_bundle->>'evaluation_suite_hash',
    p_bundle->>'evaluation_policy_hash',v_run_ids,p_bundle->>'candidate_deployment_kind',
    (p_bundle->>'candidate_deployment_id')::uuid,
    (p_bundle->>'candidate_deployment_revision_id')::uuid,
    p_bundle->>'candidate_revision_contract_hash',v_target->>'published_resource_kind',
    (v_target->>'resource_id')::uuid,(v_target->>'resource_version_id')::uuid,
    v_target->>'contract_hash',p_bundle->>'dependency_manifest_hash',
    p_bundle->>'capability_closure_hash',v_total_cases,v_passed,v_safety,v_cost,v_latency,
    p_bundle->>'observed_evidence_epoch_hash',v_actor);
  RETURN p_bundle->>'evidence_bundle_hash';
END;
$function$;

CREATE FUNCTION app.create_production_promotion_decision(
  p_decision_id uuid,p_key jsonb,p_key_hash text,p_expires_at timestamptz
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid;
  v_actor text:=session_user;
  v_bundle public.evaluation_evidence_bundles%ROWTYPE;
  v_epoch bigint;
  v_target jsonb:=p_key->'executable_target';
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR p_key->>'schema_version'<>'production-promotion-gate-key/1'
     OR p_key->>'workspace_id' IS NULL
     OR p_key_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_expires_at<=clock_timestamp() OR p_expires_at>clock_timestamp()+interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid production promotion decision' USING ERRCODE='22023';
  END IF;
  v_workspace_id:=(p_key->>'workspace_id')::uuid;
  SELECT bundle.* INTO v_bundle FROM public.evaluation_evidence_bundles bundle
  WHERE bundle.workspace_id=v_workspace_id
    AND bundle.evidence_bundle_hash=p_key->>'evidence_bundle_hash' FOR SHARE;
  IF NOT FOUND OR v_bundle.deployment_kind<>p_key->>'deployment_kind'
     OR v_bundle.deployment_id<>(p_key->>'deployment_id')::uuid
     OR v_bundle.deployment_revision_id<>(p_key->>'candidate_deployment_revision_id')::uuid
     OR v_bundle.revision_contract_hash<>p_key->>'candidate_revision_contract_hash'
     OR v_bundle.target_kind<>v_target->>'published_resource_kind'
     OR v_bundle.target_resource_id<>(v_target->>'resource_id')::uuid
     OR v_bundle.target_resource_version_id<>(v_target->>'resource_version_id')::uuid
     OR v_bundle.target_contract_hash<>v_target->>'contract_hash'
     OR v_bundle.dependency_manifest_hash<>p_key->>'dependency_manifest_hash'
     OR v_bundle.capability_closure_hash<>p_key->>'capability_closure_hash'
     OR v_bundle.evaluation_suite_release_id<>(p_key->>'evaluation_suite_release_id')::uuid
     OR v_bundle.evaluation_policy_hash<>p_key->>'evaluation_policy_hash'
     OR v_bundle.evaluation_run_ids<>ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_key->'evaluation_run_ids') value)
     OR v_bundle.observed_evidence_epoch_hash<>p_key->>'observed_evidence_epoch_hash' THEN
    RAISE EXCEPTION 'promotion key does not match evaluation evidence' USING ERRCODE='42501';
  END IF;
  IF v_bundle.deployment_kind='agent' THEN
    SELECT COALESCE(pointer.activation_epoch,0) INTO v_epoch
    FROM public.agent_deployments deployment
    LEFT JOIN public.agent_deployment_active_pointers pointer
      ON pointer.workspace_id=deployment.workspace_id AND pointer.agent_deployment_id=deployment.id
    WHERE deployment.workspace_id=v_workspace_id AND deployment.id=v_bundle.deployment_id
      AND deployment.environment='production' FOR SHARE OF deployment;
  ELSE
    SELECT COALESCE(pointer.activation_epoch,0) INTO v_epoch
    FROM public.flow_deployments deployment
    LEFT JOIN public.flow_deployment_active_pointers pointer
      ON pointer.workspace_id=deployment.workspace_id AND pointer.flow_deployment_id=deployment.id
    WHERE deployment.workspace_id=v_workspace_id AND deployment.id=v_bundle.deployment_id
      AND deployment.environment='production' FOR SHARE OF deployment;
  END IF;
  IF v_epoch IS NULL OR v_epoch<>(p_key->>'expected_activation_epoch')::bigint THEN
    RAISE EXCEPTION 'promotion activation epoch mismatch (observed %, expected %, deployment %/%)',
      v_epoch,p_key->>'expected_activation_epoch',v_bundle.deployment_kind,v_bundle.deployment_id
      USING ERRCODE='40001';
  END IF;
  INSERT INTO public.production_promotion_decisions(
    workspace_id,id,key_hash,deployment_kind,deployment_id,candidate_revision_id,
    candidate_revision_contract_hash,target_kind,target_resource_id,target_resource_version_id,
    target_contract_hash,dependency_manifest_hash,capability_closure_hash,
    evaluation_suite_release_id,evaluation_policy_hash,evaluation_run_ids,
    evidence_bundle_hash,observed_evidence_epoch_hash,expected_activation_epoch,
    status,decision_version,expires_at,created_by)
  VALUES(v_workspace_id,p_decision_id,p_key_hash,v_bundle.deployment_kind,v_bundle.deployment_id,
    v_bundle.deployment_revision_id,v_bundle.revision_contract_hash,v_bundle.target_kind,
    v_bundle.target_resource_id,v_bundle.target_resource_version_id,v_bundle.target_contract_hash,
    v_bundle.dependency_manifest_hash,v_bundle.capability_closure_hash,
    v_bundle.evaluation_suite_release_id,v_bundle.evaluation_policy_hash,v_bundle.evaluation_run_ids,
    v_bundle.evidence_bundle_hash,v_bundle.observed_evidence_epoch_hash,v_epoch,
    'PENDING',1,p_expires_at,v_actor);
  RETURN p_decision_id;
END;
$function$;

CREATE FUNCTION app.transition_production_promotion_decision(
  p_workspace_id uuid,p_decision_id uuid,p_expected_decision_version bigint,
  p_target_status text,p_reason text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_version bigint;
  v_actor text:=session_user;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_management_attestation_issuer','MEMBER')
     OR p_target_status NOT IN ('APPROVED','REJECTED','INVALIDATED')
     OR p_reason IS NULL OR length(btrim(p_reason))=0 THEN
    RAISE EXCEPTION 'invalid promotion decision transition' USING ERRCODE='22023';
  END IF;
  UPDATE public.production_promotion_decisions
  SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'INVALIDATED' ELSE p_target_status END,
      decision_version=decision_version+1,
      decided_by=CASE WHEN expires_at>clock_timestamp() AND p_target_status IN ('APPROVED','REJECTED')
        THEN v_actor ELSE NULL END,
      decided_at=CASE WHEN expires_at>clock_timestamp() AND p_target_status IN ('APPROVED','REJECTED')
        THEN clock_timestamp() ELSE NULL END,
      invalidated_at=CASE WHEN expires_at<=clock_timestamp() OR p_target_status='INVALIDATED'
        THEN clock_timestamp() ELSE NULL END,
      invalidation_reason=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' WHEN p_target_status='INVALIDATED'
        THEN p_reason ELSE NULL END
  WHERE workspace_id=p_workspace_id AND id=p_decision_id
    AND decision_version=p_expected_decision_version
    AND (status='PENDING' OR (status='APPROVED' AND p_target_status='INVALIDATED'))
  RETURNING decision_version INTO v_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'promotion decision CAS failed' USING ERRCODE='40001'; END IF;
  RETURN v_version;
END;
$function$;

CREATE FUNCTION app.consume_production_promotion_decision(
  p_decision_id uuid,p_expected_decision_version bigint,p_reason text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_workspace_id uuid:=auth.require_control_workspace();
  v_actor text:=app.current_authenticated_principal_id();
  v_decision public.production_promotion_decisions%ROWTYPE;
  v_previous uuid; v_epoch bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_control_executor','MEMBER')
     OR p_reason IS NULL OR length(btrim(p_reason))=0 THEN
    RAISE EXCEPTION 'invalid production promotion consumption' USING ERRCODE='22023';
  END IF;
  SELECT decision.* INTO v_decision FROM public.production_promotion_decisions decision
  WHERE decision.workspace_id=v_workspace_id AND decision.id=p_decision_id
    AND decision.decision_version=p_expected_decision_version FOR UPDATE;
  IF NOT FOUND OR v_decision.status<>'APPROVED' OR v_decision.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'approved production promotion decision unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.evaluation_evidence_bundles bundle
  WHERE bundle.workspace_id=v_workspace_id
    AND bundle.evidence_bundle_hash=v_decision.evidence_bundle_hash
    AND bundle.observed_evidence_epoch_hash=v_decision.observed_evidence_epoch_hash FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'production evidence changed' USING ERRCODE='42501'; END IF;
  IF v_decision.deployment_kind='agent' THEN
    PERFORM 1 FROM public.agent_deployments deployment
    JOIN public.agent_deployment_security_states security_state
      ON security_state.workspace_id=deployment.workspace_id AND security_state.agent_deployment_id=deployment.id
    JOIN public.agent_deployment_revisions revision
      ON revision.workspace_id=deployment.workspace_id AND revision.agent_deployment_id=deployment.id
    JOIN public.published_executable_closures closure
      ON closure.workspace_id=revision.workspace_id AND closure.published_resource_kind='AGENT_RELEASE'
     AND closure.resource_id=revision.agent_id AND closure.resource_version_id=revision.agent_release_id
    WHERE deployment.workspace_id=v_workspace_id AND deployment.id=v_decision.deployment_id
      AND deployment.environment='production' AND security_state.status='ACTIVE'
      AND revision.id=v_decision.candidate_revision_id
      AND revision.revision_contract_hash=v_decision.candidate_revision_contract_hash
      AND revision.agent_id=v_decision.target_resource_id
      AND revision.agent_release_id=v_decision.target_resource_version_id
      AND revision.agent_release_contract_hash=v_decision.target_contract_hash
      AND revision.dependency_manifest_hash=v_decision.dependency_manifest_hash
      AND closure.capability_closure_hash=v_decision.capability_closure_hash FOR UPDATE OF deployment,security_state,revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Agent production candidate changed' USING ERRCODE='42501'; END IF;
    SELECT pointer.active_revision_id,pointer.activation_epoch INTO v_previous,v_epoch
    FROM public.agent_deployment_active_pointers pointer WHERE pointer.workspace_id=v_workspace_id
      AND pointer.agent_deployment_id=v_decision.deployment_id FOR UPDATE;
    IF NOT FOUND THEN
      IF v_decision.expected_activation_epoch<>0 THEN RAISE EXCEPTION 'Agent production CAS failed' USING ERRCODE='40001'; END IF;
      v_epoch:=1;
      INSERT INTO public.agent_deployment_active_pointers(workspace_id,agent_deployment_id,
        active_revision_id,activation_epoch,activated_by)
      VALUES(v_workspace_id,v_decision.deployment_id,v_decision.candidate_revision_id,v_epoch,v_actor);
    ELSE
      IF v_epoch<>v_decision.expected_activation_epoch THEN RAISE EXCEPTION 'Agent production CAS failed' USING ERRCODE='40001'; END IF;
      v_epoch:=v_epoch+1;
      UPDATE public.agent_deployment_active_pointers SET active_revision_id=v_decision.candidate_revision_id,
        activation_epoch=v_epoch,activated_by=v_actor,activated_at=clock_timestamp()
      WHERE workspace_id=v_workspace_id AND agent_deployment_id=v_decision.deployment_id;
    END IF;
  ELSIF v_decision.deployment_kind='flow' THEN
    PERFORM 1 FROM public.flow_deployments deployment
    JOIN public.flow_deployment_security_states security_state
      ON security_state.workspace_id=deployment.workspace_id AND security_state.flow_deployment_id=deployment.id
    JOIN public.flow_deployment_revisions revision
      ON revision.workspace_id=deployment.workspace_id AND revision.flow_deployment_id=deployment.id
    JOIN public.published_executable_closures closure
      ON closure.workspace_id=revision.workspace_id AND closure.published_resource_kind='FLOW_VERSION'
     AND closure.resource_id=revision.flow_id AND closure.resource_version_id=revision.flow_version_id
    WHERE deployment.workspace_id=v_workspace_id AND deployment.id=v_decision.deployment_id
      AND deployment.environment='production' AND security_state.status='ACTIVE'
      AND revision.id=v_decision.candidate_revision_id
      AND revision.revision_contract_hash=v_decision.candidate_revision_contract_hash
      AND revision.flow_id=v_decision.target_resource_id
      AND revision.flow_version_id=v_decision.target_resource_version_id
      AND revision.flow_version_contract_hash=v_decision.target_contract_hash
      AND revision.dependency_manifest_hash=v_decision.dependency_manifest_hash
      AND closure.capability_closure_hash=v_decision.capability_closure_hash FOR UPDATE OF deployment,security_state,revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Flow production candidate changed' USING ERRCODE='42501'; END IF;
    SELECT pointer.active_revision_id,pointer.activation_epoch INTO v_previous,v_epoch
    FROM public.flow_deployment_active_pointers pointer WHERE pointer.workspace_id=v_workspace_id
      AND pointer.flow_deployment_id=v_decision.deployment_id FOR UPDATE;
    IF NOT FOUND THEN
      IF v_decision.expected_activation_epoch<>0 THEN RAISE EXCEPTION 'Flow production CAS failed' USING ERRCODE='40001'; END IF;
      v_epoch:=1;
      INSERT INTO public.flow_deployment_active_pointers(workspace_id,flow_deployment_id,
        active_revision_id,activation_epoch,activated_by)
      VALUES(v_workspace_id,v_decision.deployment_id,v_decision.candidate_revision_id,v_epoch,v_actor);
    ELSE
      IF v_epoch<>v_decision.expected_activation_epoch THEN RAISE EXCEPTION 'Flow production CAS failed' USING ERRCODE='40001'; END IF;
      v_epoch:=v_epoch+1;
      UPDATE public.flow_deployment_active_pointers SET active_revision_id=v_decision.candidate_revision_id,
        activation_epoch=v_epoch,activated_by=v_actor,activated_at=clock_timestamp()
      WHERE workspace_id=v_workspace_id AND flow_deployment_id=v_decision.deployment_id;
    END IF;
  ELSE RAISE EXCEPTION 'unknown production deployment kind' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.deployment_promotion_audits(id,workspace_id,deployment_kind,deployment_id,
    previous_revision_id,activated_revision_id,activation_epoch,actor_principal_id,reason)
  VALUES(public.gen_random_uuid(),v_workspace_id,v_decision.deployment_kind,v_decision.deployment_id,
    v_previous,v_decision.candidate_revision_id,v_epoch,v_actor,p_reason);
  PERFORM auth.record_authorization_epoch_change(v_workspace_id,
    v_decision.deployment_kind||'_deployment',v_decision.deployment_id,'activation',v_epoch);
  UPDATE public.production_promotion_decisions
    SET status='CONSUMED',decision_version=decision_version+1,consumed_at=clock_timestamp()
  WHERE workspace_id=v_workspace_id AND id=p_decision_id
    AND decision_version=p_expected_decision_version AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'production decision consume CAS failed' USING ERRCODE='40001'; END IF;
  RETURN v_epoch;
END;
$function$;

ALTER FUNCTION app.guard_production_promotion_decision_update() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.reject_g1_production_evaluation_immutable() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.register_evaluation_suite_release(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.register_evaluation_run(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.register_evaluation_evidence_bundle(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_production_promotion_decision(uuid,jsonb,text,timestamptz) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.transition_production_promotion_decision(uuid,uuid,bigint,text,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.consume_production_promotion_decision(uuid,bigint,text) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.guard_production_promotion_decision_update(),
  app.register_evaluation_suite_release(jsonb),app.register_evaluation_run(jsonb),
  app.register_evaluation_evidence_bundle(jsonb),
  app.create_production_promotion_decision(uuid,jsonb,text,timestamptz),
  app.transition_production_promotion_decision(uuid,uuid,bigint,text,text),
  app.consume_production_promotion_decision(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_evaluation_suite_release(jsonb),
  app.register_evaluation_run(jsonb),app.register_evaluation_evidence_bundle(jsonb),
  app.create_production_promotion_decision(uuid,jsonb,text,timestamptz),
  app.transition_production_promotion_decision(uuid,uuid,bigint,text,text)
TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION app.consume_production_promotion_decision(uuid,bigint,text)
TO ba_control_executor;

REVOKE ALL ON TABLE public.evaluation_suite_releases,public.evaluation_runs,
  public.evaluation_evidence_bundles,public.production_promotion_decisions
FROM ba_control_executor,ba_management_attestation_issuer,ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
