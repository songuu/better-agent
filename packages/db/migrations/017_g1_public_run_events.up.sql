-- G1-A6 public Run-event projection. Internal events remain private; this
-- append-only relation carries only the independently validated SSE contract.

SET LOCAL ROLE ba_run_owner;

CREATE TABLE public.public_run_event_projections (
  workspace_id uuid NOT NULL,
  event_id uuid NOT NULL,
  run_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  accepted_request_id uuid NOT NULL,
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,event_id),
  CONSTRAINT public_run_event_projections_event_fkey
    FOREIGN KEY (workspace_id, event_id) REFERENCES public.run_events(workspace_id,id),
  CONSTRAINT public_run_event_projections_run_fkey
    FOREIGN KEY (workspace_id, run_id) REFERENCES public.runs(workspace_id,id),
  CONSTRAINT public_run_event_projections_sequence_key UNIQUE (workspace_id,run_id,sequence)
);

ALTER TABLE public.public_run_event_projections OWNER TO ba_run_owner;
ALTER TABLE public.public_run_event_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_run_event_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY public_run_event_projections_owner_access
  ON public.public_run_event_projections FOR ALL TO ba_run_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.public_run_event_projections FROM PUBLIC;

CREATE FUNCTION app.validate_public_run_event_projection(
  p_projection jsonb,p_event_id uuid,p_run_id uuid,p_sequence bigint,
  p_accepted_request_id uuid,p_occurred_at timestamptz
) RETURNS void LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE v_type text;
BEGIN
  IF jsonb_typeof(p_projection)<>'object'
     OR p_projection->>'schema_version'<>'run-event/1'
     OR (p_projection->>'event_id')::uuid<>p_event_id
     OR (p_projection->>'run_id')::uuid<>p_run_id
     OR (p_projection->>'sequence')::bigint<>p_sequence
     OR (p_projection->>'accepted_request_id')::uuid<>p_accepted_request_id
     OR (p_projection->>'occurred_at')::timestamptz<>p_occurred_at
     OR jsonb_typeof(p_projection->'data')<>'object'
     OR p_projection ?| ARRAY['workspace_id','plan_hash','closure_hash','credential_id',
       'deployment_revision_id','resource_version_id','payload_object_ref','payload_sha256'] THEN
    RAISE EXCEPTION 'invalid public Run event projection' USING ERRCODE='22023';
  END IF;
  v_type:=p_projection->>'type';
  IF v_type NOT IN (
    'run.accepted','run.started','node.started','task.delta','task.completed',
    'node.completed','node.failed','run.usage','run.waiting','run.resumed',
    'run.cancel_requested','run.terminal'
  ) THEN
    RAISE EXCEPTION 'unknown public Run event discriminator' USING ERRCODE='22023';
  END IF;
  IF (v_type LIKE 'node.%') IS DISTINCT FROM (p_projection?'node') THEN
    RAISE EXCEPTION 'public node event shape mismatch' USING ERRCODE='22023';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION app.validate_public_run_event_projection(jsonb,uuid,uuid,bigint,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.validate_public_run_event_projection(jsonb,uuid,uuid,bigint,uuid,timestamptz) TO ba_run_owner;

CREATE FUNCTION app.append_public_run_event_projection(p_projection jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_event public.run_events%ROWTYPE;
  v_run public.runs%ROWTYPE;
  v_existing public.public_run_event_projections%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.run_events
    WHERE workspace_id=(p_projection->>'workspace_id')::uuid
      AND id=(p_projection->>'event_id')::uuid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source Run event is unavailable' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_run FROM public.runs
    WHERE workspace_id=v_event.workspace_id AND id=v_event.run_id FOR SHARE;
  PERFORM app.validate_public_run_event_projection(
    p_projection - ARRAY['workspace_id']::text[],v_event.id,v_event.run_id,v_event.sequence,
    v_run.accepted_request_id,v_event.occurred_at);
  SELECT * INTO v_existing FROM public.public_run_event_projections
    WHERE workspace_id=v_event.workspace_id AND event_id=v_event.id;
  IF FOUND THEN
    IF v_existing.projection IS DISTINCT FROM p_projection - ARRAY['workspace_id']::text[] THEN
      RAISE EXCEPTION 'public Run event projection replay conflict' USING ERRCODE='23505';
    END IF;
    RETURN v_existing.event_id;
  END IF;
  INSERT INTO public.public_run_event_projections(
    workspace_id,event_id,run_id,sequence,accepted_request_id,projection,occurred_at)
  VALUES(v_event.workspace_id,v_event.id,v_event.run_id,v_event.sequence,v_run.accepted_request_id,
    p_projection - ARRAY['workspace_id']::text[],v_event.occurred_at);
  RETURN v_event.id;
END;
$function$;
REVOKE ALL ON FUNCTION app.append_public_run_event_projection(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.append_public_run_event_projection(jsonb) TO ba_run_owner;

CREATE TRIGGER public_run_event_projections_immutable BEFORE UPDATE OR DELETE
  ON public.public_run_event_projections FOR EACH ROW
  EXECUTE FUNCTION app.reject_g006_immutable_change();

CREATE FUNCTION app.read_public_run_events(p_run_id uuid,p_cursor bigint,p_auth jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_run public.runs%ROWTYPE;
  v_events jsonb;
BEGIN
  IF p_cursor IS NOT NULL AND p_cursor<0 THEN
    RAISE EXCEPTION 'invalid public Run event cursor' USING ERRCODE='22023';
  END IF;
  v_run:=app.require_original_run_authorization(p_run_id,'run:events:read',p_auth);
  SELECT COALESCE(jsonb_agg(projection.projection ORDER BY projection.sequence),'[]'::jsonb)
    INTO v_events FROM (
      SELECT public_projection.projection,public_projection.sequence
      FROM public.public_run_event_projections public_projection
      WHERE public_projection.workspace_id=v_run.workspace_id
        AND public_projection.run_id=v_run.id
        AND (p_cursor IS NULL OR public_projection.sequence>p_cursor)
      ORDER BY public_projection.sequence
      LIMIT 1000
    ) projection;
  RETURN jsonb_build_object('accepted_request_id',v_run.accepted_request_id,'events',v_events);
EXCEPTION
  WHEN insufficient_privilege OR no_data_found OR invalid_parameter_value OR data_exception THEN
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION app.read_public_run_events(uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_public_run_events(uuid,bigint,jsonb) TO ba_runtime;

RESET ROLE;
