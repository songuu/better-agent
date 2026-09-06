-- Product Agent Database binding. Draft selection is mutable; each published
-- release pins the exact managed-table row set visible at publication time.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_database_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  database_table_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES public.agent_drafts(workspace_id, id),
  FOREIGN KEY (workspace_id, database_table_id)
    REFERENCES public.product_database_tables(workspace_id, id)
);

CREATE TABLE public.agent_product_release_database_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL,
  database_table_id uuid NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id, release_version),
  FOREIGN KEY (workspace_id, agent_id, release_version)
    REFERENCES public.agent_product_releases(workspace_id, agent_id, version),
  FOREIGN KEY (workspace_id, database_table_id)
    REFERENCES public.product_database_tables(workspace_id, id)
);

CREATE TABLE public.agent_product_release_database_rows (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL,
  database_table_id uuid NOT NULL,
  row_ordinal integer NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, release_version, row_ordinal),
  FOREIGN KEY (workspace_id, agent_id, release_version)
    REFERENCES public.agent_product_release_database_bindings(
      workspace_id, agent_id, release_version
    ),
  FOREIGN KEY (workspace_id, database_table_id, row_ordinal)
    REFERENCES public.product_database_rows(workspace_id, table_id, ordinal)
);

CREATE INDEX agent_product_release_database_rows_lookup_idx
  ON public.agent_product_release_database_rows (
    workspace_id, agent_id, release_version, row_ordinal
  );

ALTER TABLE public.agent_product_database_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_database_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_database_rows OWNER TO ba_authorization_owner;
ALTER INDEX public.agent_product_release_database_rows_lookup_idx OWNER TO ba_authorization_owner;

ALTER TABLE public.agent_product_database_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_database_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_database_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_database_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_database_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_database_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_product_database_bindings_owner_only
  ON public.agent_product_database_bindings
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_release_database_bindings_owner_only
  ON public.agent_product_release_database_bindings
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_release_database_rows_owner_only
  ON public.agent_product_release_database_rows
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.agent_product_database_bindings,
  public.agent_product_release_database_bindings,
  public.agent_product_release_database_rows FROM PUBLIC;
REVOKE ALL ON public.agent_product_database_bindings,
  public.agent_product_release_database_bindings,
  public.agent_product_release_database_rows FROM ba_runtime;

CREATE TRIGGER agent_product_release_database_bindings_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_database_bindings
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();
CREATE TRIGGER agent_product_release_database_rows_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_database_rows
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE FUNCTION app.snapshot_agent_product_release_database()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_database_table_id uuid;
BEGIN
  SELECT binding.database_table_id INTO v_database_table_id
  FROM public.agent_product_database_bindings AS binding
  WHERE binding.workspace_id = NEW.workspace_id AND binding.agent_id = NEW.agent_id;
  IF v_database_table_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.agent_product_release_database_bindings (
    workspace_id, agent_id, release_version, database_table_id
  ) VALUES (
    NEW.workspace_id, NEW.agent_id, NEW.version, v_database_table_id
  );
  INSERT INTO public.agent_product_release_database_rows (
    workspace_id, agent_id, release_version, database_table_id, row_ordinal
  )
  SELECT NEW.workspace_id, NEW.agent_id, NEW.version, v_database_table_id, row.ordinal
  FROM public.product_database_rows AS row
  WHERE row.workspace_id = NEW.workspace_id AND row.table_id = v_database_table_id;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER agent_product_release_database_snapshot
AFTER INSERT ON public.agent_product_releases
FOR EACH ROW EXECUTE FUNCTION app.snapshot_agent_product_release_database();

CREATE FUNCTION app.list_agent_drafts_with_capabilities(p_workspace_id uuid)
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
  database_table_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT draft.workspace_id, draft.id, draft.name, draft.description,
    draft.instructions, draft.model, draft.status, draft.revision, draft.created_by,
    draft.created_at, draft.updated_at, knowledge.knowledge_base_id,
    database_binding.database_table_id
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

CREATE FUNCTION app.create_agent_draft_with_capabilities(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text,
  p_knowledge_base_id uuid,
  p_database_table_id uuid
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
BEGIN
  IF p_database_table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_database_tables AS source
    WHERE source.workspace_id = p_workspace_id AND source.id = p_database_table_id
  ) THEN
    RAISE EXCEPTION 'Database table not found' USING ERRCODE = 'P0002';
  END IF;
  v_row := app.create_agent_draft_with_knowledge(
    p_workspace_id, p_actor_id, p_name, p_description, p_instructions, p_model,
    p_knowledge_base_id
  );
  IF p_database_table_id IS NOT NULL THEN
    INSERT INTO public.agent_product_database_bindings (
      workspace_id, agent_id, database_table_id
    ) VALUES (p_workspace_id, v_row.id, p_database_table_id);
  END IF;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.update_agent_draft_with_capabilities(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text,
  p_knowledge_base_id uuid,
  p_database_table_id uuid
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
BEGIN
  IF p_database_table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_database_tables AS source
    WHERE source.workspace_id = p_workspace_id AND source.id = p_database_table_id
  ) THEN
    RAISE EXCEPTION 'Database table not found' USING ERRCODE = 'P0002';
  END IF;
  v_row := app.update_agent_draft_with_knowledge(
    p_workspace_id, p_agent_id, p_expected_revision, p_name, p_description,
    p_instructions, p_model, p_knowledge_base_id
  );
  DELETE FROM public.agent_product_database_bindings
  WHERE workspace_id = p_workspace_id AND agent_id = p_agent_id;
  IF p_database_table_id IS NOT NULL THEN
    INSERT INTO public.agent_product_database_bindings (
      workspace_id, agent_id, database_table_id
    ) VALUES (p_workspace_id, p_agent_id, p_database_table_id);
  END IF;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.read_agent_product_conversation_database(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_limit integer
) RETURNS TABLE (
  table_name text,
  columns jsonb,
  row_ordinal integer,
  record jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Agent Database read limit is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT source.name, source.columns, release_row.row_ordinal, row.record
  FROM public.agent_product_conversations AS conversation
  JOIN public.agent_product_release_database_rows AS release_row
    ON release_row.workspace_id = conversation.workspace_id
   AND release_row.agent_id = conversation.agent_id
   AND release_row.release_version = conversation.release_version
  JOIN public.product_database_tables AS source
    ON source.workspace_id = release_row.workspace_id
   AND source.id = release_row.database_table_id
  JOIN public.product_database_rows AS row
    ON row.workspace_id = release_row.workspace_id
   AND row.table_id = release_row.database_table_id
   AND row.ordinal = release_row.row_ordinal
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
  ORDER BY release_row.row_ordinal
  LIMIT p_limit;
END;
$function$;

ALTER FUNCTION app.snapshot_agent_product_release_database() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_drafts_with_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_capabilities(uuid, uuid, text, text, text, text, uuid, uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.snapshot_agent_product_release_database() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_capabilities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_agent_draft_with_capabilities(uuid, uuid, text, text, text, text, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_agent_draft_with_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_capabilities(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_agent_draft_with_capabilities(uuid, uuid, text, text, text, text, uuid, uuid)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.update_agent_draft_with_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
