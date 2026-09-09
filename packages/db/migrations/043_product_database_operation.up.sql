-- Versioned, read-only Database Operations shared by Flow and Agent releases.
-- Policies are data, never caller SQL: table, projection, filter, order and limit are pinned.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_database_operations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  database_table_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) <= 500),
  select_columns jsonb NOT NULL CHECK (
    jsonb_typeof(select_columns) = 'array'
    AND jsonb_array_length(select_columns) BETWEEN 1 AND 20
  ),
  filter_column text NOT NULL CHECK (filter_column ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  order_column text NOT NULL CHECK (order_column ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  order_direction text NOT NULL CHECK (order_direction IN ('asc', 'desc')),
  row_limit integer NOT NULL CHECK (row_limit BETWEEN 1 AND 100),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, database_table_id)
    REFERENCES public.product_database_tables(workspace_id, id)
);

CREATE TABLE public.product_database_operation_releases (
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  database_table_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description) <= 500),
  select_columns jsonb NOT NULL CHECK (
    jsonb_typeof(select_columns) = 'array'
    AND jsonb_array_length(select_columns) BETWEEN 1 AND 20
  ),
  filter_column text NOT NULL CHECK (filter_column ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  order_column text NOT NULL CHECK (order_column ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  order_direction text NOT NULL CHECK (order_direction IN ('asc', 'desc')),
  row_limit integer NOT NULL CHECK (row_limit BETWEEN 1 AND 100),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, operation_id, revision),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES public.product_database_operations(workspace_id, id),
  FOREIGN KEY (workspace_id, database_table_id)
    REFERENCES public.product_database_tables(workspace_id, id)
);

ALTER TABLE public.product_database_operations OWNER TO ba_authorization_owner;
ALTER TABLE public.product_database_operation_releases OWNER TO ba_authorization_owner;
ALTER TABLE public.product_database_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_database_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_database_operation_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_database_operation_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY product_database_operations_owner_only
  ON public.product_database_operations
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_database_operation_releases_owner_only
  ON public.product_database_operation_releases
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
REVOKE ALL ON public.product_database_operations,
  public.product_database_operation_releases FROM PUBLIC, ba_runtime;
CREATE TRIGGER product_database_operation_releases_immutable
BEFORE UPDATE OR DELETE ON public.product_database_operation_releases
FOR EACH ROW EXECUTE FUNCTION app.reject_product_flow_immutable_mutation();

CREATE FUNCTION app.assert_product_database_operation_policy(
  p_workspace_id uuid,
  p_database_table_id uuid,
  p_select_columns jsonb,
  p_filter_column text,
  p_order_column text,
  p_row_limit integer
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_columns jsonb;
BEGIN
  SELECT source.columns INTO v_columns
  FROM public.product_database_tables AS source
  WHERE source.workspace_id = p_workspace_id AND source.id = p_database_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Database Operation table is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_select_columns IS NULL OR jsonb_typeof(p_select_columns) <> 'array'
     OR jsonb_array_length(p_select_columns) NOT BETWEEN 1 AND 20
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_select_columns) AS selected
       WHERE jsonb_typeof(selected) <> 'string'
         OR NOT v_columns @> jsonb_build_array(selected)
     )
     OR (SELECT count(*) FROM jsonb_array_elements_text(p_select_columns))
        <> (SELECT count(DISTINCT selected) FROM jsonb_array_elements_text(p_select_columns) AS selected)
     OR NOT v_columns ? p_filter_column
     OR NOT v_columns ? p_order_column
     OR NOT p_select_columns ? p_filter_column
     OR NOT p_select_columns ? p_order_column
     OR p_row_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Database Operation policy is invalid' USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE FUNCTION app.list_product_database_operations(p_workspace_id uuid)
RETURNS TABLE (
  id uuid, database_table_id uuid, name text, description text, select_columns jsonb,
  filter_column text, order_column text, order_direction text, row_limit integer,
  revision bigint, created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT operation.id, operation.database_table_id, operation.name, operation.description,
    operation.select_columns, operation.filter_column, operation.order_column,
    operation.order_direction, operation.row_limit, operation.revision,
    operation.created_at, operation.updated_at
  FROM public.product_database_operations AS operation
  WHERE operation.workspace_id = p_workspace_id
  ORDER BY operation.updated_at DESC, operation.id
  LIMIT 200;
$function$;

CREATE FUNCTION app.create_product_database_operation(
  p_workspace_id uuid, p_actor_id uuid, p_database_table_id uuid,
  p_name text, p_description text, p_select_columns jsonb,
  p_filter_column text, p_order_column text, p_order_direction text, p_row_limit integer
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_actor_id IS NULL OR p_order_direction NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'Database Operation metadata is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM app.assert_product_database_operation_policy(
    p_workspace_id, p_database_table_id, p_select_columns,
    btrim(p_filter_column), btrim(p_order_column), p_row_limit
  );
  INSERT INTO public.product_database_operations (
    workspace_id, id, database_table_id, name, description, select_columns,
    filter_column, order_column, order_direction, row_limit, created_by
  ) VALUES (
    p_workspace_id, v_id, p_database_table_id, btrim(p_name), p_description, p_select_columns,
    btrim(p_filter_column), btrim(p_order_column), p_order_direction, p_row_limit, p_actor_id
  );
  INSERT INTO public.product_database_operation_releases (
    workspace_id, operation_id, revision, database_table_id, name, description,
    select_columns, filter_column, order_column, order_direction, row_limit, published_by
  ) VALUES (
    p_workspace_id, v_id, 1, p_database_table_id, btrim(p_name), p_description,
    p_select_columns, btrim(p_filter_column), btrim(p_order_column),
    p_order_direction, p_row_limit, p_actor_id
  );
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.update_product_database_operation(
  p_workspace_id uuid, p_operation_id uuid, p_expected_revision bigint, p_actor_id uuid,
  p_database_table_id uuid, p_name text, p_description text, p_select_columns jsonb,
  p_filter_column text, p_order_column text, p_order_direction text, p_row_limit integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_revision bigint;
BEGIN
  IF p_actor_id IS NULL OR p_order_direction NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'Database Operation metadata is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM app.assert_product_database_operation_policy(
    p_workspace_id, p_database_table_id, p_select_columns,
    btrim(p_filter_column), btrim(p_order_column), p_row_limit
  );
  UPDATE public.product_database_operations
  SET database_table_id = p_database_table_id, name = btrim(p_name),
      description = p_description, select_columns = p_select_columns,
      filter_column = btrim(p_filter_column), order_column = btrim(p_order_column),
      order_direction = p_order_direction, row_limit = p_row_limit,
      revision = revision + 1, updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_operation_id
    AND revision = p_expected_revision
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Database Operation revision conflict' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.product_database_operation_releases (
    workspace_id, operation_id, revision, database_table_id, name, description,
    select_columns, filter_column, order_column, order_direction, row_limit, published_by
  ) VALUES (
    p_workspace_id, p_operation_id, v_revision, p_database_table_id, btrim(p_name),
    p_description, p_select_columns, btrim(p_filter_column), btrim(p_order_column),
    p_order_direction, p_row_limit, p_actor_id
  );
END;
$function$;

CREATE FUNCTION app.execute_product_database_operation(
  p_workspace_id uuid, p_operation_id uuid, p_operation_revision bigint, p_input text
) RETURNS TABLE (ordinal integer, record jsonb, version bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_release public.product_database_operation_releases;
BEGIN
  IF p_input IS NULL OR length(p_input) > 500 THEN
    RAISE EXCEPTION 'Database Operation input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_release FROM public.product_database_operation_releases AS release
  WHERE release.workspace_id = p_workspace_id
    AND release.operation_id = p_operation_id
    AND release.revision = p_operation_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Database Operation release is not found' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH current_rows AS (
    SELECT base.ordinal,
      CASE WHEN latest.version IS NULL THEN base.record ELSE latest.record END AS record,
      coalesce(latest.version, 1::bigint) AS version,
      latest.operation
    FROM public.product_database_rows AS base
    LEFT JOIN LATERAL (
      SELECT history.version, history.operation, history.record
      FROM public.product_database_row_versions AS history
      WHERE history.workspace_id = base.workspace_id
        AND history.table_id = base.table_id
        AND history.ordinal = base.ordinal
      ORDER BY history.version DESC LIMIT 1
    ) AS latest ON true
    WHERE base.workspace_id = p_workspace_id
      AND base.table_id = v_release.database_table_id
      AND coalesce(latest.operation, 'update') <> 'delete'
  )
  SELECT current.ordinal, projected.record, current.version
  FROM current_rows AS current
  CROSS JOIN LATERAL (
    SELECT jsonb_object_agg(selected.column_name, current.record -> selected.column_name) AS record
    FROM jsonb_array_elements_text(v_release.select_columns)
      WITH ORDINALITY AS selected(column_name, position)
  ) AS projected
  WHERE btrim(p_input) = ''
    OR position(lower(btrim(p_input)) IN lower(coalesce(current.record ->> v_release.filter_column, ''))) > 0
  ORDER BY
    CASE WHEN v_release.order_direction = 'asc' THEN current.record ->> v_release.order_column END ASC NULLS LAST,
    CASE WHEN v_release.order_direction = 'desc' THEN current.record ->> v_release.order_column END DESC NULLS LAST,
    current.ordinal
  LIMIT v_release.row_limit;
END;
$function$;

CREATE FUNCTION app.assert_product_flow_database_operations_pinned(
  p_workspace_id uuid, p_graph jsonb
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_node jsonb; v_operation_id uuid; v_revision bigint;
BEGIN
  IF p_graph IS NULL OR jsonb_typeof(p_graph) <> 'object'
     OR jsonb_typeof(p_graph -> 'nodes') <> 'array' THEN
    RAISE EXCEPTION 'Flow graph is invalid' USING ERRCODE = '22023';
  END IF;
  FOR v_node IN
    SELECT node FROM jsonb_array_elements(p_graph -> 'nodes') AS node
    WHERE node ->> 'type' = 'database'
  LOOP
    BEGIN
      v_operation_id := (v_node #>> '{config,operationId}')::uuid;
      v_revision := (v_node #>> '{config,operationRevision}')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Flow Database Operation snapshot is not pinned' USING ERRCODE = '22023';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM public.product_database_operation_releases AS release
      WHERE release.workspace_id = p_workspace_id
        AND release.operation_id = v_operation_id
        AND release.revision = v_revision
    ) THEN
      RAISE EXCEPTION 'Flow Database Operation snapshot is not pinned' USING ERRCODE = '42501';
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_product_flow_resources_pinned(
  p_workspace_id uuid, p_graph jsonb
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  PERFORM app.assert_product_flow_plugins_installed(p_workspace_id, p_graph);
  PERFORM app.assert_product_flow_apis_pinned(p_workspace_id, p_graph);
  PERFORM app.assert_product_flow_database_operations_pinned(p_workspace_id, p_graph);
END;
$function$;

ALTER TABLE public.agent_product_database_bindings
  ADD COLUMN operation_id uuid,
  ADD COLUMN operation_revision bigint,
  ADD CONSTRAINT agent_product_database_operation_pair CHECK (
    (operation_id IS NULL) = (operation_revision IS NULL)
  ),
  ADD CONSTRAINT agent_product_database_operation_release_fk
    FOREIGN KEY (workspace_id, operation_id, operation_revision)
    REFERENCES public.product_database_operation_releases(workspace_id, operation_id, revision);

ALTER TABLE public.agent_product_release_database_bindings
  ADD COLUMN operation_id uuid,
  ADD COLUMN operation_revision bigint,
  ADD CONSTRAINT agent_product_release_database_operation_pair CHECK (
    (operation_id IS NULL) = (operation_revision IS NULL)
  ),
  ADD CONSTRAINT agent_product_release_database_operation_release_fk
    FOREIGN KEY (workspace_id, operation_id, operation_revision)
    REFERENCES public.product_database_operation_releases(workspace_id, operation_id, revision);

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
database_table_id uuid,role_mode text,role_profile jsonb,strategy_profile jsonb,strategy_version bigint,
child_agent_id uuid,flow_id uuid,skill_pack_id uuid,skill_pack_release_version bigint,
mcp_server_id uuid,mcp_server_release_version bigint,database_operation_id uuid,database_operation_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
 k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version,s.target_agent_id,f.flow_id,
 sp.skill_pack_id,sp.skill_pack_release_version,m.mcp_server_id,m.mcp_server_release_version,db.operation_id,db.operation_revision
 FROM public.agent_drafts d LEFT JOIN public.agent_product_knowledge_bindings k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 LEFT JOIN public.agent_product_subagent_bindings s ON s.workspace_id=d.workspace_id AND s.agent_id=d.id
 LEFT JOIN public.agent_product_flow_bindings f ON f.workspace_id=d.workspace_id AND f.agent_id=d.id
 LEFT JOIN public.agent_product_skill_pack_bindings sp ON sp.workspace_id=d.workspace_id AND sp.agent_id=d.id
 LEFT JOIN public.agent_product_mcp_server_bindings m ON m.workspace_id=d.workspace_id AND m.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;
$function$;

CREATE FUNCTION app.create_agent_draft_with_strategy_capabilities_v9(
 p_workspace_id uuid,p_actor_id uuid,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,
 p_child_agent_id uuid,p_flow_id uuid,p_skill_pack_id uuid,p_skill_pack_release_version bigint,
 p_mcp_server_id uuid,p_mcp_server_release_version bigint,p_database_operation_id uuid,p_database_operation_revision bigint)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts; v_table_id uuid;
BEGIN
 IF (p_database_operation_id IS NULL) <> (p_database_operation_revision IS NULL) THEN
  RAISE EXCEPTION 'Agent Database Operation binding is incomplete' USING ERRCODE='22023'; END IF;
 IF p_database_operation_id IS NOT NULL THEN
  SELECT release.database_table_id INTO v_table_id FROM public.product_database_operation_releases AS release
  WHERE release.workspace_id=p_workspace_id AND release.operation_id=p_database_operation_id
    AND release.revision=p_database_operation_revision;
  IF NOT FOUND OR (p_database_table_id IS NOT NULL AND p_database_table_id<>v_table_id) THEN
   RAISE EXCEPTION 'Agent Database Operation binding is invalid' USING ERRCODE='22023'; END IF;
 ELSE v_table_id:=p_database_table_id; END IF;
 v:=app.create_agent_draft_with_strategy_capabilities_v8(p_workspace_id,p_actor_id,p_name,p_description,p_instructions,p_model,
  p_knowledge_base_id,v_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_id,p_flow_id,
  p_skill_pack_id,p_skill_pack_release_version,p_mcp_server_id,p_mcp_server_release_version);
 IF p_database_operation_id IS NOT NULL THEN UPDATE public.agent_product_database_bindings
  SET operation_id=p_database_operation_id,operation_revision=p_database_operation_revision
  WHERE workspace_id=p_workspace_id AND agent_id=v.id; END IF;
 RETURN v;
END;$function$;

CREATE FUNCTION app.update_agent_draft_with_strategy_capabilities_v9(
 p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_name text,p_description text,p_instructions text,p_model text,
 p_knowledge_base_id uuid,p_database_table_id uuid,p_role_mode text,p_role_profile jsonb,p_strategy_profile jsonb,
 p_child_agent_id uuid,p_flow_id uuid,p_skill_pack_id uuid,p_skill_pack_release_version bigint,
 p_mcp_server_id uuid,p_mcp_server_release_version bigint,p_database_operation_id uuid,p_database_operation_revision bigint)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE v public.agent_drafts; v_table_id uuid;
BEGIN
 IF (p_database_operation_id IS NULL) <> (p_database_operation_revision IS NULL) THEN
  RAISE EXCEPTION 'Agent Database Operation binding is incomplete' USING ERRCODE='22023'; END IF;
 IF p_database_operation_id IS NOT NULL THEN
  SELECT release.database_table_id INTO v_table_id FROM public.product_database_operation_releases AS release
  WHERE release.workspace_id=p_workspace_id AND release.operation_id=p_database_operation_id
    AND release.revision=p_database_operation_revision;
  IF NOT FOUND OR (p_database_table_id IS NOT NULL AND p_database_table_id<>v_table_id) THEN
   RAISE EXCEPTION 'Agent Database Operation binding is invalid' USING ERRCODE='22023'; END IF;
 ELSE v_table_id:=p_database_table_id; END IF;
 v:=app.update_agent_draft_with_strategy_capabilities_v8(p_workspace_id,p_agent_id,p_expected_revision,p_name,p_description,p_instructions,p_model,
  p_knowledge_base_id,v_table_id,p_role_mode,p_role_profile,p_strategy_profile,p_child_agent_id,p_flow_id,
  p_skill_pack_id,p_skill_pack_release_version,p_mcp_server_id,p_mcp_server_release_version);
 IF p_database_operation_id IS NOT NULL THEN UPDATE public.agent_product_database_bindings
  SET operation_id=p_database_operation_id,operation_revision=p_database_operation_revision
  WHERE workspace_id=p_workspace_id AND agent_id=p_agent_id; END IF;
 RETURN v;
END;$function$;

CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_database()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $function$
DECLARE v_binding public.agent_product_database_bindings;
BEGIN
  SELECT * INTO v_binding FROM public.agent_product_database_bindings AS binding
  WHERE binding.workspace_id = NEW.workspace_id AND binding.agent_id = NEW.agent_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.agent_product_release_database_bindings (
    workspace_id, agent_id, release_version, database_table_id, operation_id, operation_revision
  ) VALUES (
    NEW.workspace_id, NEW.agent_id, NEW.version, v_binding.database_table_id,
    v_binding.operation_id, v_binding.operation_revision
  );
  INSERT INTO public.agent_product_release_database_rows (
    workspace_id, agent_id, release_version, database_table_id, row_ordinal, row_version
  )
  SELECT NEW.workspace_id, NEW.agent_id, NEW.version, v_binding.database_table_id,
    base.ordinal, coalesce(latest.version, 1)
  FROM public.product_database_rows AS base
  LEFT JOIN LATERAL (
    SELECT history.version, history.operation FROM public.product_database_row_versions AS history
    WHERE history.workspace_id=base.workspace_id AND history.table_id=base.table_id AND history.ordinal=base.ordinal
    ORDER BY history.version DESC LIMIT 1
  ) AS latest ON true
  WHERE base.workspace_id=NEW.workspace_id AND base.table_id=v_binding.database_table_id
    AND coalesce(latest.operation,'update')<>'delete';
  RETURN NEW;
END;$function$;

CREATE FUNCTION app.read_agent_product_conversation_database(
  p_workspace_id uuid, p_conversation_id uuid, p_contains text, p_limit integer
) RETURNS TABLE (table_name text, columns jsonb, row_ordinal integer, record jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $function$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 20 OR p_contains IS NULL OR length(p_contains)>500 THEN
    RAISE EXCEPTION 'Agent Database read input is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH pinned_rows AS (
    SELECT source.name AS table_name, source.columns AS table_columns,
      release_row.row_ordinal,
      CASE WHEN release_row.row_version=1 THEN base.record ELSE pinned.record END AS source_record,
      operation.select_columns, operation.filter_column, operation.order_column,
      operation.order_direction, operation.row_limit
    FROM public.agent_product_conversations AS conversation
    JOIN public.agent_product_release_database_bindings AS binding
      ON binding.workspace_id=conversation.workspace_id AND binding.agent_id=conversation.agent_id
     AND binding.release_version=conversation.release_version
    JOIN public.agent_product_release_database_rows AS release_row
      ON release_row.workspace_id=conversation.workspace_id AND release_row.agent_id=conversation.agent_id
     AND release_row.release_version=conversation.release_version
    JOIN public.product_database_tables AS source
      ON source.workspace_id=release_row.workspace_id AND source.id=release_row.database_table_id
    JOIN public.product_database_rows AS base
      ON base.workspace_id=release_row.workspace_id AND base.table_id=release_row.database_table_id
     AND base.ordinal=release_row.row_ordinal
    LEFT JOIN public.product_database_row_versions AS pinned
      ON pinned.workspace_id=release_row.workspace_id AND pinned.table_id=release_row.database_table_id
     AND pinned.ordinal=release_row.row_ordinal AND pinned.version=release_row.row_version
    LEFT JOIN public.product_database_operation_releases AS operation
      ON operation.workspace_id=binding.workspace_id AND operation.operation_id=binding.operation_id
     AND operation.revision=binding.operation_revision
    WHERE conversation.workspace_id=p_workspace_id AND conversation.id=p_conversation_id
      AND (release_row.row_version=1 OR pinned.operation='update')
  ), projected AS (
    SELECT pinned.table_name,
      coalesce(pinned.select_columns,pinned.table_columns) AS columns,
      pinned.row_ordinal,
      CASE WHEN pinned.select_columns IS NULL THEN pinned.source_record ELSE (
        SELECT jsonb_object_agg(selected.column_name,pinned.source_record->selected.column_name)
        FROM jsonb_array_elements_text(pinned.select_columns) AS selected(column_name)
      ) END AS record,
      pinned.source_record, pinned.filter_column, pinned.order_column,
      pinned.order_direction, coalesce(pinned.row_limit,p_limit) AS row_limit
    FROM pinned_rows AS pinned
  )
  SELECT projected.table_name,projected.columns,projected.row_ordinal,projected.record
  FROM projected
  WHERE btrim(p_contains)='' OR projected.filter_column IS NULL
    OR position(lower(btrim(p_contains)) IN lower(coalesce(projected.source_record->>projected.filter_column,'')))>0
  ORDER BY
    CASE WHEN projected.order_direction='asc' THEN projected.source_record->>projected.order_column END ASC NULLS LAST,
    CASE WHEN projected.order_direction='desc' THEN projected.source_record->>projected.order_column END DESC NULLS LAST,
    projected.row_ordinal
  LIMIT least(p_limit,coalesce((SELECT min(row_limit) FROM projected),p_limit));
END;$function$;

CREATE OR REPLACE FUNCTION app.read_agent_product_conversation_database(
  p_workspace_id uuid, p_conversation_id uuid, p_limit integer
) RETURNS TABLE (table_name text, columns jsonb, row_ordinal integer, record jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $function$
  SELECT * FROM app.read_agent_product_conversation_database(
    p_workspace_id,p_conversation_id,''::text,p_limit
  );
$function$;

ALTER FUNCTION app.assert_product_database_operation_policy(uuid,uuid,jsonb,text,text,integer) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_database_operations(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_product_database_operation(uuid,uuid,uuid,text,text,jsonb,text,text,text,integer) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_product_database_operation(uuid,uuid,bigint,uuid,uuid,text,text,jsonb,text,text,text,integer) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.execute_product_database_operation(uuid,uuid,bigint,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_database_operations_pinned(uuid,jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_resources_pinned(uuid,jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_strategy_capabilities_v9(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_strategy_capabilities_v9(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.snapshot_agent_product_release_database() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_conversation_database(uuid,uuid,text,integer) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_conversation_database(uuid,uuid,integer) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.assert_product_database_operation_policy(uuid,uuid,jsonb,text,text,integer),
 app.list_product_database_operations(uuid),
 app.create_product_database_operation(uuid,uuid,uuid,text,text,jsonb,text,text,text,integer),
 app.update_product_database_operation(uuid,uuid,bigint,uuid,uuid,text,text,jsonb,text,text,text,integer),
 app.execute_product_database_operation(uuid,uuid,bigint,text),
 app.assert_product_flow_database_operations_pinned(uuid,jsonb),
 app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v9(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.update_agent_draft_with_strategy_capabilities_v9(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.read_agent_product_conversation_database(uuid,uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_database_operations(uuid),
 app.create_product_database_operation(uuid,uuid,uuid,text,text,jsonb,text,text,text,integer),
 app.update_product_database_operation(uuid,uuid,bigint,uuid,uuid,text,text,jsonb,text,text,text,integer),
 app.execute_product_database_operation(uuid,uuid,bigint,text),
 app.list_agent_drafts_with_role_capabilities(uuid),
 app.create_agent_draft_with_strategy_capabilities_v9(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.update_agent_draft_with_strategy_capabilities_v9(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint),
 app.read_agent_product_conversation_database(uuid,uuid,text,integer) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
