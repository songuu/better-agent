-- Product Agent role profiles. Structured drafts use a closed seven-theme
-- profile; publication copies the exact profile and server-compiled prompt.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE FUNCTION app.is_valid_product_agent_role_profile(p_profile jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT jsonb_typeof(p_profile) = 'object'
    AND (
      SELECT array_agg(key ORDER BY key) = ARRAY[
        'audience', 'constraints', 'expertise', 'identity',
        'objective', 'process', 'tone'
      ]::text[]
      FROM jsonb_object_keys(p_profile) AS keys(key)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(p_profile) AS item(theme, section)
      WHERE jsonb_typeof(item.section) <> 'object'
        OR (
          SELECT array_agg(key ORDER BY key) <> ARRAY['content', 'weight']::text[]
          FROM jsonb_object_keys(item.section) AS section_keys(key)
        )
        OR jsonb_typeof(item.section -> 'content') <> 'string'
        OR length(btrim(item.section ->> 'content')) NOT BETWEEN 1 AND 1000
        OR jsonb_typeof(item.section -> 'weight') <> 'number'
        OR (item.section ->> 'weight') !~ '^(0|[1-9][0-9]?|100)$'
    );
$function$;

CREATE FUNCTION app.render_product_agent_role_instructions(p_profile jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT 'STRUCTURED_ROLE_PROFILE'
    || E'\n\n以下七项定义角色行为；权重仅用于角色要求冲突时的优先级，不得覆盖系统安全边界。\n\n'
    || string_agg(
      format(
        '[%s | 权重 %s/100]%s%s',
        theme.label,
        p_profile -> theme.key ->> 'weight',
        E'\n',
        btrim(p_profile -> theme.key ->> 'content')
      ),
      E'\n\n' ORDER BY theme.ordinal
    )
    || E'\n\nEND_STRUCTURED_ROLE_PROFILE'
  FROM (VALUES
    (1, 'identity', '身份定位'),
    (2, 'objective', '核心目标'),
    (3, 'audience', '服务对象'),
    (4, 'expertise', '专业能力'),
    (5, 'tone', '表达风格'),
    (6, 'constraints', '边界约束'),
    (7, 'process', '工作流程')
  ) AS theme(ordinal, key, label);
$function$;

ALTER TABLE public.agent_drafts
  ADD COLUMN role_mode text NOT NULL DEFAULT 'text',
  ADD COLUMN role_profile jsonb,
  ADD CONSTRAINT agent_drafts_role_mode_check
    CHECK (role_mode IN ('text', 'structured')),
  ADD CONSTRAINT agent_drafts_role_profile_check
    CHECK (
      (role_mode = 'text' AND role_profile IS NULL)
      OR (role_mode = 'structured' AND app.is_valid_product_agent_role_profile(role_profile))
    );

ALTER TABLE public.agent_product_releases
  ADD COLUMN role_mode text NOT NULL DEFAULT 'text',
  ADD COLUMN role_profile jsonb,
  ADD CONSTRAINT agent_product_releases_role_mode_check
    CHECK (role_mode IN ('text', 'structured')),
  ADD CONSTRAINT agent_product_releases_role_profile_check
    CHECK (
      (role_mode = 'text' AND role_profile IS NULL)
      OR (role_mode = 'structured' AND app.is_valid_product_agent_role_profile(role_profile))
    );

CREATE FUNCTION app.reject_product_agent_role_release_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'product Agent release is immutable' USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER agent_product_releases_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_releases
FOR EACH ROW EXECUTE FUNCTION app.reject_product_agent_role_release_mutation();

CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE (
  workspace_id uuid,
  id uuid,
  name text,
  description text,
  instructions text,
  model text,
  status text,
  revision bigint,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  knowledge_base_id uuid,
  database_table_id uuid,
  role_mode text,
  role_profile jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT draft.workspace_id, draft.id, draft.name, draft.description,
    draft.instructions, draft.model, draft.status, draft.revision, draft.created_by,
    draft.created_at, draft.updated_at, knowledge.knowledge_base_id,
    database_binding.database_table_id, draft.role_mode, draft.role_profile
  FROM public.agent_drafts AS draft
  LEFT JOIN public.agent_product_knowledge_bindings AS knowledge
    ON knowledge.workspace_id = draft.workspace_id AND knowledge.agent_id = draft.id
  LEFT JOIN public.agent_product_database_bindings AS database_binding
    ON database_binding.workspace_id = draft.workspace_id
   AND database_binding.agent_id = draft.id
  WHERE draft.workspace_id = p_workspace_id
  ORDER BY draft.updated_at DESC, draft.id
  LIMIT 200;
$function$;

CREATE FUNCTION app.create_agent_draft_with_role_capabilities(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text,
  p_knowledge_base_id uuid,
  p_database_table_id uuid,
  p_role_mode text,
  p_role_profile jsonb
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
  v_instructions text;
BEGIN
  IF p_role_mode = 'structured' THEN
    IF NOT COALESCE(app.is_valid_product_agent_role_profile(p_role_profile), false) THEN
      RAISE EXCEPTION 'Agent structured role profile is invalid' USING ERRCODE = '22023';
    END IF;
    v_instructions := app.render_product_agent_role_instructions(p_role_profile);
  ELSIF p_role_mode = 'text' AND p_role_profile IS NULL THEN
    v_instructions := p_instructions;
  ELSE
    RAISE EXCEPTION 'Agent role mode and profile are inconsistent' USING ERRCODE = '22023';
  END IF;
  v_row := app.create_agent_draft_with_capabilities(
    p_workspace_id, p_actor_id, p_name, p_description, v_instructions, p_model,
    p_knowledge_base_id, p_database_table_id
  );
  UPDATE public.agent_drafts
  SET role_mode = p_role_mode, role_profile = p_role_profile
  WHERE workspace_id = p_workspace_id AND id = v_row.id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.update_agent_draft_with_role_capabilities(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text,
  p_knowledge_base_id uuid,
  p_database_table_id uuid,
  p_role_mode text,
  p_role_profile jsonb
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
  v_instructions text;
BEGIN
  IF p_role_mode = 'structured' THEN
    IF NOT COALESCE(app.is_valid_product_agent_role_profile(p_role_profile), false) THEN
      RAISE EXCEPTION 'Agent structured role profile is invalid' USING ERRCODE = '22023';
    END IF;
    v_instructions := app.render_product_agent_role_instructions(p_role_profile);
  ELSIF p_role_mode = 'text' AND p_role_profile IS NULL THEN
    v_instructions := p_instructions;
  ELSE
    RAISE EXCEPTION 'Agent role mode and profile are inconsistent' USING ERRCODE = '22023';
  END IF;
  v_row := app.update_agent_draft_with_capabilities(
    p_workspace_id, p_agent_id, p_expected_revision, p_name, p_description,
    v_instructions, p_model, p_knowledge_base_id, p_database_table_id
  );
  UPDATE public.agent_drafts
  SET role_mode = p_role_mode, role_profile = p_role_profile
  WHERE workspace_id = p_workspace_id AND id = p_agent_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

DROP FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid);
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
    workspace_id, agent_id, version, name, description, instructions, model,
    published_by, role_mode, role_profile
  ) VALUES (
    v_row.workspace_id, v_row.id, v_version, v_row.name, v_row.description,
    v_row.instructions, v_row.model, p_actor_id, v_row.role_mode, v_row.role_profile
  );
  RETURN v_row;
END;
$function$;

ALTER FUNCTION app.is_valid_product_agent_role_profile(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.render_product_agent_role_instructions(jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.reject_product_agent_role_release_mutation() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_role_capabilities(uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_role_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid, text, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.is_valid_product_agent_role_profile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.render_product_agent_role_instructions(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_product_agent_role_release_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_agent_draft_with_role_capabilities(uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_agent_draft_with_role_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_agent_draft_with_role_capabilities(uuid, uuid, text, text, text, text, uuid, uuid, text, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.update_agent_draft_with_role_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid, text, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
