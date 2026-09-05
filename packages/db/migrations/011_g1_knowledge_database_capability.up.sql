-- Immutable G1-A3 Knowledge/Database execution receipts. The executable role
-- has fixed-function access only; all durable facts are owner-only and FORCE RLS.

GRANT USAGE, CREATE ON SCHEMA app TO ba_run_owner;
GRANT CREATE ON SCHEMA public TO ba_run_owner;
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE FUNCTION auth.require_g1_execution_source_pin(
  p_workspace_id uuid,
  p_pin jsonb,
  p_expected_kind text,
  p_expected_schema text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
BEGIN
  IF p_workspace_id IS NULL
     OR p_expected_kind NOT IN ('KNOWLEDGE_INDEX_GENERATION','DATABASE_OPERATION_RELEASE')
     OR p_expected_schema NOT IN (
       'knowledge-index-generation-source/1','database-operation-source/1'
     )
     OR jsonb_typeof(p_pin) IS DISTINCT FROM 'object'
     OR p_pin ->> 'workspace_id' IS DISTINCT FROM p_workspace_id::text
     OR p_pin ->> 'published_resource_kind' IS DISTINCT FROM p_expected_kind
     OR p_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR NOT EXISTS (
       SELECT 1 FROM public.published_g1_resource_sources AS source
       WHERE source.workspace_id=p_workspace_id
         AND source.published_resource_kind=p_expected_kind
         AND source.resource_id=(p_pin->>'resource_id')::uuid
         AND source.resource_version_id=(p_pin->>'resource_version_id')::uuid
         AND source.contract_hash=p_pin->>'contract_hash'
         AND source.source_schema_version=p_expected_schema
     ) THEN
    RAISE EXCEPTION 'G1 execution source pin is not published' USING ERRCODE = '23503';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION auth.require_g1_execution_source_pin(uuid,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.require_g1_execution_source_pin(uuid,jsonb,text,text)
TO ba_run_owner;

RESET ROLE;
REVOKE CREATE ON SCHEMA auth FROM ba_authorization_owner;

CREATE TABLE public.knowledge_query_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 512),
  published_resource_kind text NOT NULL DEFAULT 'KNOWLEDGE_INDEX_GENERATION'
    CHECK (published_resource_kind = 'KNOWLEDGE_INDEX_GENERATION'),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  authority_hash text NOT NULL CHECK (authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  compiled_hash text NOT NULL CHECK (compiled_hash ~ '^sha256:[0-9a-f]{64}$'),
  compiled_query jsonb NOT NULL CHECK (
    jsonb_typeof(compiled_query) = 'object'
    AND compiled_query ->> 'schema_version' = 'compiled-knowledge-query/1'
    AND jsonb_typeof(compiled_query -> 'authorized_sources') = 'array'
  ),
  result_ref text NOT NULL CHECK (length(btrim(result_ref)) BETWEEN 1 AND 4096),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_count integer NOT NULL CHECK (result_count >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 300000),
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  execution_fence bigint NOT NULL CHECK (execution_fence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,run_id,operation_key),
  CONSTRAINT knowledge_query_receipts_run_fkey FOREIGN KEY (workspace_id,run_id)
    REFERENCES public.runs(workspace_id,id),
  CONSTRAINT knowledge_query_receipts_attempt_fkey FOREIGN KEY (workspace_id,run_id,attempt_id)
    REFERENCES public.run_attempts(workspace_id,run_id,id),
  CONSTRAINT knowledge_query_receipts_step_fkey FOREIGN KEY (workspace_id,run_id,attempt_id,step_id)
    REFERENCES public.run_steps(workspace_id,run_id,attempt_id,id),
  CONSTRAINT knowledge_query_receipts_source_fkey FOREIGN KEY (
    workspace_id,published_resource_kind,resource_id,resource_version_id
  ) REFERENCES public.published_g1_resource_sources (
    workspace_id,published_resource_kind,resource_id,resource_version_id
  )
);

CREATE TABLE public.database_operation_receipts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  step_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 512),
  published_resource_kind text NOT NULL DEFAULT 'DATABASE_OPERATION_RELEASE'
    CHECK (published_resource_kind = 'DATABASE_OPERATION_RELEASE'),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  compiled_hash text NOT NULL CHECK (compiled_hash ~ '^sha256:[0-9a-f]{64}$'),
  compiled_select jsonb NOT NULL CHECK (
    jsonb_typeof(compiled_select) = 'object'
    AND compiled_select ->> 'schema_version' = 'compiled-database-select/1'
    AND compiled_select ->> 'transaction_mode' = 'read_only'
  ),
  result_ref text NOT NULL CHECK (length(btrim(result_ref)) BETWEEN 1 AND 4096),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 300000),
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  execution_fence bigint NOT NULL CHECK (execution_fence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,run_id,operation_key),
  CONSTRAINT database_operation_receipts_run_fkey FOREIGN KEY (workspace_id,run_id)
    REFERENCES public.runs(workspace_id,id),
  CONSTRAINT database_operation_receipts_attempt_fkey FOREIGN KEY (workspace_id,run_id,attempt_id)
    REFERENCES public.run_attempts(workspace_id,run_id,id),
  CONSTRAINT database_operation_receipts_step_fkey FOREIGN KEY (workspace_id,run_id,attempt_id,step_id)
    REFERENCES public.run_steps(workspace_id,run_id,attempt_id,id),
  CONSTRAINT database_operation_receipts_source_fkey FOREIGN KEY (
    workspace_id,published_resource_kind,resource_id,resource_version_id
  ) REFERENCES public.published_g1_resource_sources (
    workspace_id,published_resource_kind,resource_id,resource_version_id
  )
);

ALTER TABLE public.knowledge_query_receipts OWNER TO ba_run_owner;
ALTER TABLE public.database_operation_receipts OWNER TO ba_run_owner;

ALTER TABLE public.knowledge_query_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_query_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_query_receipts_owner_access ON public.knowledge_query_receipts
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.knowledge_query_receipts FROM PUBLIC;

ALTER TABLE public.database_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.database_operation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY database_operation_receipts_owner_access ON public.database_operation_receipts
FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.database_operation_receipts FROM PUBLIC;

CREATE FUNCTION app.reject_g1_capability_receipt_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'G1 capability receipts are immutable' USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER knowledge_query_receipts_immutable
BEFORE UPDATE OR DELETE ON public.knowledge_query_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_g1_capability_receipt_change();
CREATE TRIGGER database_operation_receipts_immutable
BEFORE UPDATE OR DELETE ON public.database_operation_receipts
FOR EACH ROW EXECUTE FUNCTION app.reject_g1_capability_receipt_change();

CREATE FUNCTION app.record_knowledge_query_receipt(p_fact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('execution');
  v_receipt jsonb := p_fact -> 'receipt';
  v_compiled jsonb := v_receipt -> 'compiled_query';
  v_pin jsonb := v_compiled -> 'generation_pin';
  v_authority jsonb;
  v_existing public.knowledge_query_receipts%ROWTYPE;
  v_compiled_hash text;
  v_receipt_hash text;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY['run_id','attempt_id','step_id','lease_token','lease_fencing_token','receipt']) <> '{}'::jsonb
     OR jsonb_typeof(v_receipt) IS DISTINCT FROM 'object'
     OR (v_receipt - ARRAY['schema_version','receipt_id','operation_key','compiled_query','result_ref','result_hash','result_count','duration_ms','receipt_hash']) <> '{}'::jsonb
     OR v_receipt ->> 'schema_version' IS DISTINCT FROM 'knowledge-query-execution-receipt/1'
     OR jsonb_typeof(v_compiled) IS DISTINCT FROM 'object'
     OR v_compiled ->> 'schema_version' IS DISTINCT FROM 'compiled-knowledge-query/1'
     OR (v_compiled - ARRAY[
       'schema_version','generation_pin','authority_hash','workspace_id','subject_id',
       'authorized_sources','text','filters','embedding','retrieval','rerank',
       'index_manifest','timeout_ms','compiled_hash'
     ]) <> '{}'::jsonb
     OR v_pin ->> 'published_resource_kind' IS DISTINCT FROM 'KNOWLEDGE_INDEX_GENERATION'
     OR v_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR v_compiled ->> 'workspace_id' IS DISTINCT FROM v_workspace_id::text
     OR jsonb_typeof(v_compiled -> 'authorized_sources') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_compiled -> 'authorized_sources') = 0
     OR COALESCE(v_compiled ->> 'authority_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_compiled ->> 'compiled_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_receipt ->> 'receipt_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_receipt ->> 'result_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_fact ->> 'run_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'step_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token','') !~ '^[1-9][0-9]{0,15}$'
     OR COALESCE(v_receipt ->> 'receipt_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_pin ->> 'resource_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_pin ->> 'resource_version_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_pin ->> 'contract_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR length(COALESCE(v_receipt ->> 'operation_key','')) NOT BETWEEN 1 AND 512
     OR COALESCE(v_receipt ->> 'result_count','') !~ '^(0|[1-9][0-9]*)$'
     OR length(COALESCE(v_receipt ->> 'result_count','')) > 10
     OR COALESCE(v_receipt ->> 'duration_ms','') !~ '^[1-9][0-9]{0,5}$'
     OR COALESCE(v_compiled ->> 'timeout_ms','') !~ '^[1-9][0-9]{0,5}$'
     OR COALESCE(v_compiled #>> '{retrieval,top_k}','') !~ '^[1-9][0-9]{0,3}$' THEN
    RAISE EXCEPTION 'Knowledge query receipt is invalid' USING ERRCODE = '22023';
  END IF;
  IF (v_receipt ->> 'duration_ms')::integer > (v_compiled ->> 'timeout_ms')::integer
     OR (v_receipt ->> 'result_count')::bigint >
          (v_compiled #>> '{retrieval,top_k}')::integer
     OR (v_compiled ->> 'timeout_ms')::integer > 300000
     OR (v_compiled #>> '{retrieval,top_k}')::integer > 1000 THEN
    RAISE EXCEPTION 'Knowledge query result exceeds compiled bounds' USING ERRCODE = '22023';
  END IF;
  v_compiled_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_compiled - 'compiled_hash'),'UTF8'
  ),'sha256'),'hex');
  v_receipt_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_receipt - 'receipt_hash'),'UTF8'
  ),'sha256'),'hex');
  IF v_compiled_hash IS DISTINCT FROM v_compiled ->> 'compiled_hash'
     OR v_receipt_hash IS DISTINCT FROM v_receipt ->> 'receipt_hash' THEN
    RAISE EXCEPTION 'Knowledge query compiled or receipt hash is invalid' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_existing FROM public.knowledge_query_receipts
  WHERE workspace_id=v_workspace_id AND run_id=(p_fact->>'run_id')::uuid
    AND operation_key=v_receipt->>'operation_key';
  IF FOUND THEN
    IF v_existing.receipt_hash IS DISTINCT FROM v_receipt_hash THEN
      RAISE EXCEPTION 'Knowledge query operation key conflicts' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('receipt_id',v_existing.id,'replayed',true);
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  PERFORM auth.require_g1_execution_source_pin(
    v_workspace_id,v_pin,'KNOWLEDGE_INDEX_GENERATION','knowledge-index-generation-source/1'
  );
  INSERT INTO public.knowledge_query_receipts (
    workspace_id,id,run_id,attempt_id,step_id,operation_key,resource_id,
    resource_version_id,contract_hash,authority_hash,compiled_hash,compiled_query,
    result_ref,result_hash,result_count,duration_ms,receipt_hash,execution_fence
  ) VALUES (
    v_workspace_id,(v_receipt->>'receipt_id')::uuid,(p_fact->>'run_id')::uuid,
    (p_fact->>'attempt_id')::uuid,(p_fact->>'step_id')::uuid,v_receipt->>'operation_key',
    (v_pin->>'resource_id')::uuid,(v_pin->>'resource_version_id')::uuid,
    v_pin->>'contract_hash',v_compiled->>'authority_hash',v_compiled_hash,v_compiled,
    v_receipt->>'result_ref',v_receipt->>'result_hash',(v_receipt->>'result_count')::integer,
    (v_receipt->>'duration_ms')::integer,v_receipt_hash,
    (v_authority->>'lease_fencing_token')::bigint
  );
  RETURN jsonb_build_object('receipt_id',v_receipt->>'receipt_id','replayed',false);
END;
$function$;

CREATE FUNCTION app.record_database_operation_receipt(p_fact jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_internal_service_phase('execution');
  v_receipt jsonb := p_fact -> 'receipt';
  v_compiled jsonb := v_receipt -> 'compiled_select';
  v_pin jsonb := v_compiled -> 'database_operation_pin';
  v_authority jsonb;
  v_existing public.database_operation_receipts%ROWTYPE;
  v_compiled_hash text;
  v_receipt_hash text;
BEGIN
  IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object'
     OR (p_fact - ARRAY['run_id','attempt_id','step_id','lease_token','lease_fencing_token','receipt']) <> '{}'::jsonb
     OR jsonb_typeof(v_receipt) IS DISTINCT FROM 'object'
     OR (v_receipt - ARRAY['schema_version','receipt_id','operation_key','compiled_select','result_ref','result_hash','row_count','duration_ms','receipt_hash']) <> '{}'::jsonb
     OR v_receipt ->> 'schema_version' IS DISTINCT FROM 'database-operation-execution-receipt/1'
     OR jsonb_typeof(v_compiled) IS DISTINCT FROM 'object'
     OR v_compiled ->> 'schema_version' IS DISTINCT FROM 'compiled-database-select/1'
     OR (v_compiled - ARRAY[
       'schema_version','connector_id','connector_revision_id','database_operation_pin',
       'table_revision_id','operation_contract_hash','sql','values','result_columns',
       'max_rows','timeout_ms','transaction_mode','compiled_hash'
     ]) <> '{}'::jsonb
     OR v_compiled ->> 'transaction_mode' IS DISTINCT FROM 'read_only'
     OR v_pin ->> 'published_resource_kind' IS DISTINCT FROM 'DATABASE_OPERATION_RELEASE'
     OR v_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR COALESCE(v_compiled ->> 'compiled_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_receipt ->> 'receipt_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(v_receipt ->> 'result_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_fact ->> 'run_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'attempt_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'step_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_token','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_fact ->> 'lease_fencing_token','') !~ '^[1-9][0-9]{0,15}$'
     OR COALESCE(v_receipt ->> 'receipt_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_pin ->> 'workspace_id','') IS DISTINCT FROM v_workspace_id::text
     OR COALESCE(v_pin ->> 'resource_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_pin ->> 'resource_version_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_pin ->> 'contract_hash','') !~ '^sha256:[0-9a-f]{64}$'
     OR length(COALESCE(v_receipt ->> 'operation_key','')) NOT BETWEEN 1 AND 512
     OR COALESCE(v_receipt ->> 'row_count','') !~ '^(0|[1-9][0-9]*)$'
     OR length(COALESCE(v_receipt ->> 'row_count','')) > 10
     OR COALESCE(v_receipt ->> 'duration_ms','') !~ '^[1-9][0-9]{0,5}$'
     OR COALESCE(v_compiled ->> 'max_rows','') !~ '^[1-9][0-9]{0,2}$'
     OR COALESCE(v_compiled ->> 'timeout_ms','') !~ '^[1-9][0-9]{0,5}$'
     OR COALESCE(v_compiled ->> 'sql','') !~ '^SELECT .+ LIMIT [1-9][0-9]*$'
     OR position(';' IN COALESCE(v_compiled ->> 'sql','')) <> 0 THEN
    RAISE EXCEPTION 'Database operation receipt is invalid' USING ERRCODE = '22023';
  END IF;
  IF (v_receipt ->> 'duration_ms')::integer > (v_compiled ->> 'timeout_ms')::integer
     OR (v_receipt ->> 'row_count')::bigint > (v_compiled ->> 'max_rows')::integer
     OR (v_compiled ->> 'timeout_ms')::integer > 300000
     OR (v_compiled ->> 'max_rows')::integer > 500 THEN
    RAISE EXCEPTION 'Database operation result exceeds compiled bounds' USING ERRCODE = '22023';
  END IF;
  v_compiled_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_compiled - 'compiled_hash'),'UTF8'
  ),'sha256'),'hex');
  v_receipt_hash := 'sha256:' || encode(public.digest(convert_to(
    app.g007_canonical_json(v_receipt - 'receipt_hash'),'UTF8'
  ),'sha256'),'hex');
  IF v_compiled_hash IS DISTINCT FROM v_compiled ->> 'compiled_hash'
     OR v_receipt_hash IS DISTINCT FROM v_receipt ->> 'receipt_hash' THEN
    RAISE EXCEPTION 'Database operation compiled or receipt hash is invalid' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_existing FROM public.database_operation_receipts
  WHERE workspace_id=v_workspace_id AND run_id=(p_fact->>'run_id')::uuid
    AND operation_key=v_receipt->>'operation_key';
  IF FOUND THEN
    IF v_existing.receipt_hash IS DISTINCT FROM v_receipt_hash THEN
      RAISE EXCEPTION 'Database operation key conflicts' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('receipt_id',v_existing.id,'replayed',true);
  END IF;
  v_authority := app.require_execution_owner_lease(p_fact);
  PERFORM auth.require_g1_execution_source_pin(
    v_workspace_id,v_pin,'DATABASE_OPERATION_RELEASE','database-operation-source/1'
  );
  INSERT INTO public.database_operation_receipts (
    workspace_id,id,run_id,attempt_id,step_id,operation_key,resource_id,
    resource_version_id,contract_hash,compiled_hash,compiled_select,result_ref,
    result_hash,row_count,duration_ms,receipt_hash,execution_fence
  ) VALUES (
    v_workspace_id,(v_receipt->>'receipt_id')::uuid,(p_fact->>'run_id')::uuid,
    (p_fact->>'attempt_id')::uuid,(p_fact->>'step_id')::uuid,v_receipt->>'operation_key',
    (v_pin->>'resource_id')::uuid,(v_pin->>'resource_version_id')::uuid,
    v_pin->>'contract_hash',v_compiled_hash,v_compiled,v_receipt->>'result_ref',
    v_receipt->>'result_hash',(v_receipt->>'row_count')::integer,
    (v_receipt->>'duration_ms')::integer,v_receipt_hash,
    (v_authority->>'lease_fencing_token')::bigint
  );
  RETURN jsonb_build_object('receipt_id',v_receipt->>'receipt_id','replayed',false);
END;
$function$;

ALTER FUNCTION app.reject_g1_capability_receipt_change() OWNER TO ba_run_owner;
ALTER FUNCTION app.record_knowledge_query_receipt(jsonb) OWNER TO ba_run_owner;
ALTER FUNCTION app.record_database_operation_receipt(jsonb) OWNER TO ba_run_owner;
REVOKE ALL ON FUNCTION app.reject_g1_capability_receipt_change(),
  app.record_knowledge_query_receipt(jsonb),
  app.record_database_operation_receipt(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_knowledge_query_receipt(jsonb)
TO ba_execution_executor;
GRANT EXECUTE ON FUNCTION app.record_database_operation_receipt(jsonb)
TO ba_execution_executor;

REVOKE CREATE ON SCHEMA public FROM ba_run_owner;
REVOKE CREATE ON SCHEMA app FROM ba_run_owner;
