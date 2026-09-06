DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.agent_drafts
    WHERE role_mode = 'structured' OR role_profile IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.agent_product_releases
    WHERE role_mode = 'structured' OR role_profile IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot remove product Agent role profiles with retained structured data'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid);
DROP FUNCTION app.update_agent_draft_with_role_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid, text, jsonb);
DROP FUNCTION app.create_agent_draft_with_role_capabilities(uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb);
DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
DROP TRIGGER agent_product_releases_immutable ON public.agent_product_releases;
DROP FUNCTION app.reject_product_agent_role_release_mutation();

ALTER TABLE public.agent_product_releases
  DROP CONSTRAINT agent_product_releases_role_profile_check,
  DROP CONSTRAINT agent_product_releases_role_mode_check,
  DROP COLUMN role_profile,
  DROP COLUMN role_mode;
ALTER TABLE public.agent_drafts
  DROP CONSTRAINT agent_drafts_role_profile_check,
  DROP CONSTRAINT agent_drafts_role_mode_check,
  DROP COLUMN role_profile,
  DROP COLUMN role_mode;

DROP FUNCTION app.is_valid_product_agent_role_profile(jsonb);
DROP FUNCTION app.render_product_agent_role_instructions(jsonb);

CREATE FUNCTION app.publish_agent_draft(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_expected_revision bigint,
  p_actor_id uuid
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
  v_version bigint;
BEGIN
  SELECT COALESCE(max(version), 0) + 1 INTO v_version
  FROM public.agent_product_releases
  WHERE workspace_id = p_workspace_id AND agent_id = p_agent_id;
  UPDATE public.agent_drafts
  SET status = 'published', revision = revision + 1, updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id
    AND id = p_agent_id
    AND revision = p_expected_revision
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent draft revision conflict' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.agent_product_releases (
    workspace_id, agent_id, version, name, description, instructions, model, published_by
  ) VALUES (
    v_row.workspace_id, v_row.id, v_version, v_row.name, v_row.description,
    v_row.instructions, v_row.model, p_actor_id
  );
  RETURN v_row;
END;
$function$;

ALTER FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
