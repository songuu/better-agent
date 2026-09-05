-- G1-A6 browser EventSource bridge. The bearer-derived capability is single-Run,
-- host-only at transport, valid for at most 60 seconds and never stored raw.

SET LOCAL ROLE ba_auth_owner;
GRANT EXECUTE ON FUNCTION auth.is_canonical_https_origin(text) TO ba_run_owner;

RESET ROLE;
SET LOCAL ROLE ba_authorization_owner;
GRANT REFERENCES (workspace_id,id) ON TABLE public.browser_sessions TO ba_run_owner;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;

CREATE TABLE public.run_event_sessions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  browser_session_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  agent_deployment_id uuid NOT NULL,
  canonical_origin text NOT NULL CHECK (auth.is_canonical_https_origin(canonical_origin)),
  session_epoch bigint NOT NULL CHECK (session_epoch >= 0),
  principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
  deployment_epoch bigint NOT NULL CHECK (deployment_epoch >= 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,id),
  CONSTRAINT run_event_sessions_run_fkey
    FOREIGN KEY (workspace_id,run_id) REFERENCES public.runs(workspace_id,id),
  CONSTRAINT run_event_sessions_browser_session_fkey
    FOREIGN KEY (workspace_id,browser_session_id)
    REFERENCES public.browser_sessions(workspace_id,id),
  CONSTRAINT run_event_sessions_ttl_check CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '60 seconds'
  )
);

ALTER TABLE public.run_event_sessions OWNER TO ba_run_owner;
ALTER TABLE public.run_event_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_event_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY run_event_sessions_run_owner_access ON public.run_event_sessions
  FOR ALL TO ba_run_owner USING (true) WITH CHECK (true);
CREATE POLICY run_event_sessions_auth_owner_read ON public.run_event_sessions
  FOR SELECT TO ba_auth_owner USING (true);
REVOKE ALL ON TABLE public.run_event_sessions FROM PUBLIC;
GRANT SELECT ON TABLE public.run_event_sessions TO ba_auth_owner;
GRANT REFERENCES (workspace_id,id) ON TABLE public.run_event_sessions TO ba_auth_owner;

CREATE TRIGGER run_event_sessions_immutable BEFORE UPDATE OR DELETE
  ON public.run_event_sessions FOR EACH ROW
  EXECUTE FUNCTION app.reject_g006_immutable_change();

CREATE FUNCTION app.lock_run_event_session(p_workspace_id uuid,p_event_session_id uuid)
RETURNS public.run_event_sessions LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE v_session public.run_event_sessions%ROWTYPE;
BEGIN
  SELECT event_session.* INTO v_session FROM public.run_event_sessions event_session
  WHERE event_session.workspace_id=p_workspace_id
    AND event_session.id=p_event_session_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run event session is unavailable' USING ERRCODE='42501';
  END IF;
  RETURN v_session;
END;
$function$;
REVOKE ALL ON FUNCTION app.lock_run_event_session(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_run_event_session(uuid,uuid) TO ba_auth_owner;

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;

CREATE TABLE auth.run_event_session_auth_index (
  event_session_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  verifier_hmac bytea NOT NULL CHECK (octet_length(verifier_hmac)=32),
  verifier_algorithm text NOT NULL CHECK (verifier_algorithm='hmac-sha-256'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT run_event_session_auth_index_session_fkey
    FOREIGN KEY (workspace_id,event_session_id)
    REFERENCES public.run_event_sessions(workspace_id,id)
);

ALTER TABLE auth.run_event_session_auth_index OWNER TO ba_auth_owner;
ALTER TABLE auth.run_event_session_auth_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.run_event_session_auth_index FORCE ROW LEVEL SECURITY;
CREATE POLICY run_event_session_auth_index_owner_only
  ON auth.run_event_session_auth_index FOR ALL TO ba_auth_owner
  USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE auth.run_event_session_auth_index FROM PUBLIC;

CREATE FUNCTION auth.validate_run_event_session_identity(
  p_workspace_id uuid,p_agent_deployment_id uuid,p_identity jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE v_facts jsonb;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_runtime','MEMBER')
     OR app.current_workspace_id() IS DISTINCT FROM p_workspace_id
     OR jsonb_typeof(p_identity)<>'object' THEN
    RAISE EXCEPTION 'invalid Run event session identity validation request' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object(
    'browser_session_id',browser_session.id,
    'principal_id',browser_session.principal_id,
    'agent_deployment_id',browser_session.agent_deployment_id,
    'canonical_origin',browser_session.canonical_origin,
    'session_epoch',browser_session.session_epoch,
    'principal_epoch',principal.session_epoch,
    'deployment_epoch',security_state.revoke_epoch,
    'browser_expires_at',browser_session.expires_at)
  INTO v_facts
  FROM public.browser_sessions browser_session
  JOIN public.end_user_principals principal
    ON principal.workspace_id=browser_session.workspace_id
   AND principal.id=browser_session.principal_id
  JOIN public.agent_deployments deployment
    ON deployment.workspace_id=browser_session.workspace_id
   AND deployment.id=browser_session.agent_deployment_id
  JOIN public.agent_deployment_security_states security_state
    ON security_state.workspace_id=deployment.workspace_id
   AND security_state.agent_deployment_id=deployment.id
  JOIN public.agent_deployment_active_pointers pointer
    ON pointer.workspace_id=deployment.workspace_id
   AND pointer.agent_deployment_id=deployment.id
  JOIN public.agent_deployment_revisions revision
    ON revision.workspace_id=pointer.workspace_id
   AND revision.id=pointer.active_revision_id
   AND revision.agent_deployment_id=deployment.id
  WHERE browser_session.workspace_id=p_workspace_id
    AND browser_session.id=(p_identity->>'browserSessionId')::uuid
    AND browser_session.principal_id=(p_identity->>'endUserPrincipalId')::uuid
    AND browser_session.agent_deployment_id=p_agent_deployment_id
    AND browser_session.session_epoch=(p_identity->>'sessionAuthorizationEpoch')::bigint
    AND browser_session.observed_principal_session_epoch=
      (p_identity->>'principalAuthorizationEpoch')::bigint
    AND browser_session.observed_deployment_revoke_epoch=
      (p_identity->>'deploymentAuthorizationEpoch')::bigint
    AND browser_session.status='ACTIVE'
    AND browser_session.expires_at>clock_timestamp()
    AND principal.status='active'
    AND principal.session_epoch=browser_session.observed_principal_session_epoch
    AND security_state.status='ACTIVE'
    AND security_state.revoke_epoch=browser_session.observed_deployment_revoke_epoch
    AND revision.ingress_channel='browser'
    AND browser_session.canonical_origin = ANY(revision.allowed_origins)
  FOR SHARE OF browser_session,principal,deployment,security_state,pointer,revision;
  IF v_facts IS NULL THEN
    RAISE EXCEPTION 'browser Run event session origin or lifecycle rejected' USING ERRCODE='42501';
  END IF;
  RETURN v_facts;
END;
$function$;
REVOKE ALL ON FUNCTION auth.validate_run_event_session_identity(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.validate_run_event_session_identity(uuid,uuid,jsonb)
  TO ba_run_owner;

CREATE FUNCTION auth.store_run_event_session_verifier(
  p_workspace_id uuid,p_event_session_id uuid,p_verifier_hmac bytea,p_expires_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'ba_runtime','MEMBER')
     OR p_verifier_hmac IS NULL OR octet_length(p_verifier_hmac)<>32
     OR NOT EXISTS (
       SELECT 1 FROM public.run_event_sessions event_session
       WHERE event_session.workspace_id=p_workspace_id
         AND event_session.id=p_event_session_id
         AND event_session.expires_at=p_expires_at
         AND event_session.issued_at<=clock_timestamp()
         AND event_session.expires_at>clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'invalid Run event session verifier registration' USING ERRCODE='42501';
  END IF;
  INSERT INTO auth.run_event_session_auth_index(
    event_session_id,workspace_id,verifier_hmac,verifier_algorithm,expires_at)
  VALUES(p_event_session_id,p_workspace_id,p_verifier_hmac,'hmac-sha-256',p_expires_at);
END;
$function$;
REVOKE ALL ON FUNCTION auth.store_run_event_session_verifier(uuid,uuid,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.store_run_event_session_verifier(uuid,uuid,bytea,timestamptz)
  TO ba_run_owner;

CREATE FUNCTION auth.authenticate_run_event_session_facts(
  p_event_session_id uuid,p_presented_verifier_hmac bytea,p_actual_origin text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_private auth.run_event_session_auth_index%ROWTYPE;
  v_event_session public.run_event_sessions%ROWTYPE;
  v_browser_private auth.browser_session_auth_index%ROWTYPE;
  v_txid bigint;
  v_signature text;
BEGIN
  PERFORM set_config('app.tenant_context','',true);
  IF NOT pg_catalog.pg_has_role(session_user,'ba_runtime','MEMBER')
     OR p_event_session_id IS NULL OR p_presented_verifier_hmac IS NULL
     OR octet_length(p_presented_verifier_hmac)<>32
     OR NOT auth.is_canonical_https_origin(p_actual_origin) THEN
    RAISE EXCEPTION 'invalid Run event session authentication request' USING ERRCODE='42501';
  END IF;
  SELECT private_row.* INTO v_private
  FROM auth.run_event_session_auth_index private_row
  WHERE private_row.event_session_id=p_event_session_id FOR SHARE;
  IF NOT FOUND OR v_private.expires_at<=clock_timestamp()
     OR NOT auth.constant_time_equal_32(v_private.verifier_hmac,p_presented_verifier_hmac) THEN
    RAISE EXCEPTION 'Run event session authentication rejected' USING ERRCODE='42501';
  END IF;
  v_event_session:=app.lock_run_event_session(v_private.workspace_id,p_event_session_id);
  IF v_event_session.workspace_id IS DISTINCT FROM v_private.workspace_id
     OR v_event_session.id IS DISTINCT FROM v_private.event_session_id
     OR v_event_session.expires_at IS DISTINCT FROM v_private.expires_at
     OR v_event_session.expires_at<=clock_timestamp()
     OR v_event_session.canonical_origin<>p_actual_origin THEN
    RAISE EXCEPTION 'Run event session lifecycle or origin rejected' USING ERRCODE='42501';
  END IF;
  PERFORM 1
  FROM public.browser_sessions browser_session
  JOIN auth.browser_session_auth_index browser_private
    ON browser_private.workspace_id=browser_session.workspace_id
   AND browser_private.browser_session_id=browser_session.id
  JOIN public.end_user_principals principal
    ON principal.workspace_id=browser_session.workspace_id
   AND principal.id=browser_session.principal_id
  JOIN public.agent_deployments deployment
    ON deployment.workspace_id=browser_session.workspace_id
   AND deployment.id=browser_session.agent_deployment_id
  JOIN public.agent_deployment_security_states security_state
    ON security_state.workspace_id=deployment.workspace_id
   AND security_state.agent_deployment_id=deployment.id
  JOIN public.agent_deployment_active_pointers pointer
    ON pointer.workspace_id=deployment.workspace_id
   AND pointer.agent_deployment_id=deployment.id
  JOIN public.agent_deployment_revisions revision
    ON revision.workspace_id=pointer.workspace_id
   AND revision.id=pointer.active_revision_id
   AND revision.agent_deployment_id=deployment.id
  WHERE browser_session.workspace_id=v_event_session.workspace_id
    AND browser_session.id=v_event_session.browser_session_id
    AND browser_session.status='ACTIVE'
    AND browser_session.session_epoch=v_event_session.session_epoch
    AND browser_session.expires_at>clock_timestamp()
    AND browser_session.principal_id=v_event_session.principal_id
    AND browser_session.agent_deployment_id=v_event_session.agent_deployment_id
    AND browser_session.canonical_origin=p_actual_origin
    AND browser_private.status='ACTIVE'
    AND browser_private.session_epoch=v_event_session.session_epoch
    AND browser_private.expires_at=browser_session.expires_at
    AND principal.status='active'
    AND principal.session_epoch=v_event_session.principal_epoch
    AND security_state.status='ACTIVE'
    AND security_state.revoke_epoch=v_event_session.deployment_epoch
    AND revision.ingress_channel='browser'
    AND p_actual_origin = ANY(revision.allowed_origins)
  FOR SHARE OF browser_session,browser_private,principal,deployment,
    security_state,pointer,revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run event session lifecycle or origin rejected' USING ERRCODE='42501';
  END IF;
  SELECT private_row.* INTO v_browser_private
  FROM auth.browser_session_auth_index private_row
  WHERE private_row.workspace_id=v_event_session.workspace_id
    AND private_row.browser_session_id=v_event_session.browser_session_id;
  v_txid:=txid_current();
  v_signature:=encode(public.hmac(convert_to(format(
    'browser:%s:%s:%s:%s:%s:%s',v_event_session.workspace_id,
    v_event_session.browser_session_id,v_event_session.principal_id,
    v_event_session.agent_deployment_id,v_txid,session_user),'UTF8'),
    v_browser_private.verifier_hmac,'sha256'),'hex');
  PERFORM set_config('app.tenant_context',format(
    'browser:%s:%s:%s:%s:%s:%s',v_event_session.workspace_id,
    v_event_session.browser_session_id,v_event_session.principal_id,
    v_event_session.agent_deployment_id,v_txid,v_signature),true);
  IF app.current_workspace_id() IS DISTINCT FROM v_event_session.workspace_id THEN
    PERFORM set_config('app.tenant_context','',true);
    RAISE EXCEPTION 'Run event session tenant context could not be established' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object(
    'workspace_id',v_event_session.workspace_id,
    'run_id',v_event_session.run_id,
    'browser_session_id',v_event_session.browser_session_id,
    'end_user_principal_id',v_event_session.principal_id,
    'agent_deployment_id',v_event_session.agent_deployment_id,
    'session_epoch',v_event_session.session_epoch,
    'observed_principal_session_epoch',v_event_session.principal_epoch,
    'observed_deployment_revoke_epoch',v_event_session.deployment_epoch);
END;
$function$;
REVOKE ALL ON FUNCTION auth.authenticate_run_event_session_facts(uuid,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.authenticate_run_event_session_facts(uuid,bytea,text) TO ba_runtime;

RESET ROLE;
SET LOCAL ROLE ba_run_owner;

CREATE FUNCTION app.issue_browser_run_event_session(
  p_event_session_id uuid,p_verifier_hmac bytea,p_run_id uuid,p_auth jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,auth,app,pg_temp AS $function$
DECLARE
  v_run public.runs%ROWTYPE;
  v_identity jsonb;
  v_browser jsonb;
  v_issued_at timestamptz:=clock_timestamp();
  v_expires_at timestamptz;
BEGIN
  IF p_event_session_id IS NULL OR p_verifier_hmac IS NULL
     OR octet_length(p_verifier_hmac)<>32 OR jsonb_typeof(p_auth)<>'object'
     OR COALESCE(p_auth->>'auth_mode','')<>'browser' THEN
    RAISE EXCEPTION 'invalid browser Run event session request' USING ERRCODE='22023';
  END IF;
  v_run:=app.require_original_run_authorization(p_run_id,'run:events:read',p_auth);
  v_identity:=COALESCE(p_auth->'browserIdentity',p_auth->'browser_identity');
  v_browser:=auth.validate_run_event_session_identity(
    v_run.workspace_id,v_run.agent_deployment_id,v_identity);
  v_expires_at:=LEAST(
    v_issued_at+interval '60 seconds',(v_browser->>'browser_expires_at')::timestamptz);
  INSERT INTO public.run_event_sessions(
    workspace_id,id,run_id,browser_session_id,principal_id,agent_deployment_id,
    canonical_origin,session_epoch,principal_epoch,deployment_epoch,issued_at,expires_at)
  VALUES(v_run.workspace_id,p_event_session_id,v_run.id,
    (v_browser->>'browser_session_id')::uuid,(v_browser->>'principal_id')::uuid,
    (v_browser->>'agent_deployment_id')::uuid,v_browser->>'canonical_origin',
    (v_browser->>'session_epoch')::bigint,(v_browser->>'principal_epoch')::bigint,
    (v_browser->>'deployment_epoch')::bigint,
    v_issued_at,v_expires_at);
  PERFORM auth.store_run_event_session_verifier(
    v_run.workspace_id,p_event_session_id,p_verifier_hmac,v_expires_at);
  RETURN jsonb_build_object(
    'event_session_id',p_event_session_id,'run_id',v_run.id,'expires_at',v_expires_at,
    'max_age_seconds',GREATEST(1,LEAST(60,floor(extract(epoch FROM v_expires_at-v_issued_at))::integer)),
    'cookie_path','/v1/oapi/runs/'||v_run.id::text||'/events');
END;
$function$;
REVOKE ALL ON FUNCTION app.issue_browser_run_event_session(uuid,bytea,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.issue_browser_run_event_session(uuid,bytea,uuid,jsonb) TO ba_runtime;

RESET ROLE;
