-- Product Flow immutable release history and audited Deployment pointer rollback.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_flow_deployment_rollbacks (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  flow_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  from_release_version bigint NOT NULL CHECK (from_release_version > 0),
  target_release_version bigint NOT NULL CHECK (target_release_version > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  rolled_back_by uuid NOT NULL,
  rolled_back_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, flow_id, environment)
    REFERENCES public.product_flow_deployments(workspace_id, flow_id, environment),
  FOREIGN KEY (workspace_id, flow_id, from_release_version)
    REFERENCES public.product_flow_releases(workspace_id, flow_id, version),
  FOREIGN KEY (workspace_id, flow_id, target_release_version)
    REFERENCES public.product_flow_releases(workspace_id, flow_id, version),
  CHECK (from_release_version <> target_release_version)
);

CREATE INDEX product_flow_deployment_rollbacks_history_idx
  ON public.product_flow_deployment_rollbacks (
    workspace_id, flow_id, rolled_back_at DESC, id
  );

ALTER TABLE public.product_flow_deployment_rollbacks OWNER TO ba_authorization_owner;
ALTER INDEX public.product_flow_deployment_rollbacks_history_idx OWNER TO ba_authorization_owner;
ALTER TABLE public.product_flow_deployment_rollbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_flow_deployment_rollbacks FORCE ROW LEVEL SECURITY;

CREATE POLICY product_flow_deployment_rollbacks_owner_only
  ON public.product_flow_deployment_rollbacks
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.product_flow_deployment_rollbacks FROM PUBLIC;
REVOKE ALL ON public.product_flow_deployment_rollbacks FROM ba_runtime;

CREATE TRIGGER product_flow_deployment_rollbacks_immutable
BEFORE UPDATE OR DELETE ON public.product_flow_deployment_rollbacks
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.list_product_flow_releases(
  p_workspace_id uuid,
  p_flow_id uuid
) RETURNS TABLE (
  version bigint,
  name text,
  description text,
  published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT release.version, release.name, release.description, release.published_at
  FROM public.product_flow_releases AS release
  WHERE release.workspace_id = p_workspace_id
    AND release.flow_id = p_flow_id
  ORDER BY release.version DESC
  LIMIT 200;
$function$;

CREATE FUNCTION app.list_product_flow_rollbacks(
  p_workspace_id uuid,
  p_flow_id uuid
) RETURNS TABLE (
  id uuid,
  environment text,
  from_release_version bigint,
  target_release_version bigint,
  reason text,
  rolled_back_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT rollback.id, rollback.environment, rollback.from_release_version,
    rollback.target_release_version, rollback.reason, rollback.rolled_back_at
  FROM public.product_flow_deployment_rollbacks AS rollback
  WHERE rollback.workspace_id = p_workspace_id
    AND rollback.flow_id = p_flow_id
  ORDER BY rollback.rolled_back_at DESC, rollback.id
  LIMIT 100;
$function$;

CREATE FUNCTION app.rollback_product_flow_deployment(
  p_workspace_id uuid,
  p_flow_id uuid,
  p_environment text,
  p_expected_release_version bigint,
  p_target_release_version bigint,
  p_actor_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_current_release bigint;
BEGIN
  IF p_environment NOT IN ('development', 'staging', 'production')
    OR p_expected_release_version IS NULL OR p_expected_release_version < 1
    OR p_target_release_version IS NULL OR p_target_release_version < 1
    OR p_actor_id IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'invalid Flow rollback request' USING ERRCODE = '22023';
  END IF;

  SELECT deployment.release_version INTO v_current_release
  FROM public.product_flow_deployments AS deployment
  WHERE deployment.workspace_id = p_workspace_id
    AND deployment.flow_id = p_flow_id
    AND deployment.environment = p_environment
  FOR UPDATE;

  IF NOT FOUND OR v_current_release IS DISTINCT FROM p_expected_release_version THEN
    RAISE EXCEPTION 'Flow deployment rollback conflict' USING ERRCODE = '40001';
  END IF;
  IF v_current_release = p_target_release_version THEN
    RAISE EXCEPTION 'Flow rollback target is already deployed' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.product_flow_releases AS release
    WHERE release.workspace_id = p_workspace_id
      AND release.flow_id = p_flow_id
      AND release.version = p_target_release_version
  ) THEN
    RAISE EXCEPTION 'Flow rollback target release not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.product_flow_deployments
  SET release_version = p_target_release_version,
      revision = revision + 1,
      deployed_by = p_actor_id,
      deployed_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id
    AND flow_id = p_flow_id
    AND environment = p_environment;

  INSERT INTO public.product_flow_deployment_rollbacks (
    workspace_id, id, flow_id, environment, from_release_version,
    target_release_version, reason, rolled_back_by
  ) VALUES (
    p_workspace_id, gen_random_uuid(), p_flow_id, p_environment, v_current_release,
    p_target_release_version, btrim(p_reason), p_actor_id
  );
END;
$function$;

ALTER FUNCTION app.list_product_flow_releases(uuid, uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_flow_rollbacks(uuid, uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.rollback_product_flow_deployment(uuid, uuid, text, bigint, bigint, uuid, text)
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.list_product_flow_releases(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_product_flow_rollbacks(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.rollback_product_flow_deployment(uuid, uuid, text, bigint, bigint, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.list_product_flow_releases(uuid, uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.list_product_flow_rollbacks(uuid, uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.rollback_product_flow_deployment(uuid, uuid, text, bigint, bigint, uuid, text) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
