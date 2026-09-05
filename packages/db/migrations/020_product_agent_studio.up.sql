-- Product-facing Agent Studio state. Runtime callers can only use the bounded
-- definer functions below; direct table access remains owner-only.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_drafts (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  instructions text NOT NULL CHECK (length(btrim(instructions)) BETWEEN 1 AND 20000),
  model text NOT NULL CHECK (model IN ('gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE public.agent_product_releases (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  model text NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id, version),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES public.agent_drafts(workspace_id, id)
);

ALTER TABLE public.agent_drafts OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_releases OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_releases FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_drafts_owner_only ON public.agent_drafts
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_releases_owner_only ON public.agent_product_releases
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.agent_drafts, public.agent_product_releases FROM PUBLIC;
REVOKE ALL ON public.agent_drafts, public.agent_product_releases FROM ba_runtime;

CREATE FUNCTION app.list_agent_drafts(p_workspace_id uuid)
RETURNS SETOF public.agent_drafts
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT draft.*
  FROM public.agent_drafts AS draft
  WHERE draft.workspace_id = p_workspace_id
  ORDER BY draft.updated_at DESC, draft.id;
$function$;

CREATE FUNCTION app.create_agent_draft(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
BEGIN
  INSERT INTO public.agent_drafts (
    workspace_id, id, name, description, instructions, model, created_by
  ) VALUES (
    p_workspace_id, gen_random_uuid(), btrim(p_name), p_description,
    p_instructions, p_model, p_actor_id
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.update_agent_draft(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
BEGIN
  UPDATE public.agent_drafts
  SET name = btrim(p_name),
      description = p_description,
      instructions = p_instructions,
      model = p_model,
      status = 'draft',
      revision = revision + 1,
      updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id
    AND id = p_agent_id
    AND revision = p_expected_revision
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent draft revision conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_row;
END;
$function$;

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

ALTER FUNCTION app.list_agent_drafts(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft(uuid, uuid, text, text, text, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft(uuid, uuid, bigint, text, text, text, text)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid)
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.list_agent_drafts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_agent_draft(uuid, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_agent_draft(uuid, uuid, bigint, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_agent_draft(uuid, uuid, text, text, text, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.update_agent_draft(uuid, uuid, bigint, text, text, text, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
