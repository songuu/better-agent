-- Product release/evaluation readback. This migration adds no mutable facts:
-- it projects immutable releases and evidence already owned by PostgreSQL.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE FUNCTION app.list_product_release_evaluation_targets(p_workspace_id uuid)
RETURNS TABLE (
  target_kind text,
  target_id uuid,
  release_version bigint,
  name text,
  model text,
  published_at timestamptz,
  environments text[],
  successful_evidence_count bigint,
  failed_evidence_count bigint,
  total_evidence_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH targets AS (
    SELECT
      'agent'::text AS target_kind,
      release.agent_id AS target_id,
      release.version AS release_version,
      release.name,
      release.model,
      release.published_at,
      ARRAY['release']::text[] AS environments,
      (
        SELECT count(*)
        FROM public.agent_product_conversations AS conversation
        JOIN public.agent_product_runs AS run
          ON run.workspace_id = conversation.workspace_id
         AND run.conversation_id = conversation.id
        WHERE conversation.workspace_id = release.workspace_id
          AND conversation.agent_id = release.agent_id
          AND conversation.release_version = release.version
          AND run.status = 'completed'
      ) AS successful_evidence_count,
      (
        SELECT count(*)
        FROM public.agent_product_conversations AS conversation
        JOIN public.agent_product_runs AS run
          ON run.workspace_id = conversation.workspace_id
         AND run.conversation_id = conversation.id
        WHERE conversation.workspace_id = release.workspace_id
          AND conversation.agent_id = release.agent_id
          AND conversation.release_version = release.version
          AND run.status = 'failed'
      ) AS failed_evidence_count,
      (
        SELECT count(*)
        FROM public.agent_product_conversations AS conversation
        JOIN public.agent_product_runs AS run
          ON run.workspace_id = conversation.workspace_id
         AND run.conversation_id = conversation.id
        WHERE conversation.workspace_id = release.workspace_id
          AND conversation.agent_id = release.agent_id
          AND conversation.release_version = release.version
      ) AS total_evidence_count
    FROM public.agent_product_releases AS release
    WHERE release.workspace_id = p_workspace_id

    UNION ALL

    SELECT
      'flow'::text,
      release.flow_id,
      release.version,
      release.name,
      NULL::text,
      release.published_at,
      COALESCE((
        SELECT array_agg(deployment.environment ORDER BY deployment.environment)
        FROM public.product_flow_deployments AS deployment
        WHERE deployment.workspace_id = release.workspace_id
          AND deployment.flow_id = release.flow_id
          AND deployment.release_version = release.version
      ), '{}'::text[]),
      0::bigint,
      0::bigint,
      0::bigint
    FROM public.product_flow_releases AS release
    WHERE release.workspace_id = p_workspace_id
  )
  SELECT *
  FROM targets
  ORDER BY published_at DESC, target_kind, target_id, release_version DESC
  LIMIT 400;
$function$;

ALTER FUNCTION app.list_product_release_evaluation_targets(uuid)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_product_release_evaluation_targets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_release_evaluation_targets(uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
