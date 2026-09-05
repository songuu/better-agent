SET LOCAL ROLE ba_run_owner;
DO $guard_public$
BEGIN
  IF EXISTS (SELECT 1 FROM public.run_event_sessions) THEN
    RAISE EXCEPTION 'browser Run event session facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard_public$;
REVOKE EXECUTE ON FUNCTION app.issue_browser_run_event_session(uuid,bytea,uuid,jsonb) FROM ba_runtime;
DROP FUNCTION app.issue_browser_run_event_session(uuid,bytea,uuid,jsonb);

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
DO $guard_private$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.run_event_session_auth_index) THEN
    RAISE EXCEPTION 'browser Run event session facts exist; downgrade rejected' USING ERRCODE='55000';
  END IF;
END;
$guard_private$;
REVOKE EXECUTE ON FUNCTION auth.authenticate_run_event_session_facts(uuid,bytea,text) FROM ba_runtime;
DROP FUNCTION auth.authenticate_run_event_session_facts(uuid,bytea,text);
REVOKE EXECUTE ON FUNCTION auth.store_run_event_session_verifier(uuid,uuid,bytea,timestamptz) FROM ba_run_owner;
DROP FUNCTION auth.store_run_event_session_verifier(uuid,uuid,bytea,timestamptz);
REVOKE EXECUTE ON FUNCTION auth.validate_run_event_session_identity(uuid,uuid,jsonb) FROM ba_run_owner;
DROP FUNCTION auth.validate_run_event_session_identity(uuid,uuid,jsonb);
DROP POLICY run_event_session_auth_index_owner_only ON auth.run_event_session_auth_index;
DROP TABLE auth.run_event_session_auth_index;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;
REVOKE REFERENCES (workspace_id,id) ON TABLE public.run_event_sessions FROM ba_auth_owner;
DROP TRIGGER run_event_sessions_immutable ON public.run_event_sessions;
REVOKE EXECUTE ON FUNCTION app.lock_run_event_session(uuid,uuid) FROM ba_auth_owner;
DROP FUNCTION app.lock_run_event_session(uuid,uuid);
REVOKE SELECT ON TABLE public.run_event_sessions FROM ba_auth_owner;
DROP POLICY run_event_sessions_auth_owner_read ON public.run_event_sessions;
DROP POLICY run_event_sessions_run_owner_access ON public.run_event_sessions;
DROP TABLE public.run_event_sessions;

RESET ROLE;
SET LOCAL ROLE ba_authorization_owner;
REVOKE REFERENCES (workspace_id,id) ON TABLE public.browser_sessions FROM ba_run_owner;
RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
REVOKE EXECUTE ON FUNCTION auth.is_canonical_https_origin(text) FROM ba_run_owner;
RESET ROLE;
