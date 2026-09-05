-- Only an unused closure-storage migration may be removed.

SET LOCAL ROLE ba_authorization_owner;
ALTER TABLE public.published_executable_closures NO FORCE ROW LEVEL SECURITY;

DO $g1_closure_storage_down_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.published_executable_closures) THEN
    RAISE EXCEPTION 'cannot remove executable closure storage after publication'
      USING ERRCODE = '55000';
  END IF;
END;
$g1_closure_storage_down_guard$;

DROP FUNCTION app.publish_compiled_flow_version(jsonb);
DROP FUNCTION app.publish_compiled_agent_release(jsonb);
DROP FUNCTION auth.register_prepared_executable_closure(jsonb);
DROP TABLE public.published_executable_closures;

RESET ROLE;
