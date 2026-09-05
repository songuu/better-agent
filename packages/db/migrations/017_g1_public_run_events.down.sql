DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.public_run_event_projections) THEN
    RAISE EXCEPTION 'public Run event projection facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard$;
REVOKE EXECUTE ON FUNCTION app.read_public_run_events(uuid,bigint,jsonb) FROM ba_runtime;
DROP FUNCTION app.read_public_run_events(uuid,bigint,jsonb);
DROP TRIGGER public_run_event_projections_immutable ON public.public_run_event_projections;
REVOKE EXECUTE ON FUNCTION app.append_public_run_event_projection(jsonb) FROM ba_run_owner;
DROP FUNCTION app.append_public_run_event_projection(jsonb);
REVOKE EXECUTE ON FUNCTION app.validate_public_run_event_projection(jsonb,uuid,uuid,bigint,uuid,timestamptz) FROM ba_run_owner;
DROP FUNCTION app.validate_public_run_event_projection(jsonb,uuid,uuid,bigint,uuid,timestamptz);
DROP POLICY public_run_event_projections_owner_access ON public.public_run_event_projections;
DROP TABLE public.public_run_event_projections;
