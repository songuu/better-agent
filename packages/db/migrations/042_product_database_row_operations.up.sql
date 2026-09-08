-- Versioned Database row operations. Base rows remain immutable; updates and
-- deletes append CAS-protected versions, while Agent releases pin exact values.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

ALTER TABLE public.agent_product_release_database_rows
  ADD COLUMN row_version bigint NOT NULL DEFAULT 1
  CHECK (row_version BETWEEN 1 AND 2147483647);

CREATE TABLE public.product_database_row_versions (
  workspace_id uuid NOT NULL,
  table_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4999),
  version bigint NOT NULL CHECK (version BETWEEN 2 AND 2147483647),
  operation text NOT NULL CHECK (operation IN ('update', 'delete')),
  record jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, table_id, ordinal, version),
  FOREIGN KEY (workspace_id, table_id, ordinal)
    REFERENCES public.product_database_rows(workspace_id, table_id, ordinal),
  CHECK (
    (operation = 'update' AND jsonb_typeof(record) = 'object')
    OR (operation = 'delete' AND record IS NULL)
  )
);

CREATE INDEX product_database_row_versions_latest_idx
  ON public.product_database_row_versions (workspace_id, table_id, ordinal, version DESC);

ALTER TABLE public.product_database_row_versions OWNER TO ba_authorization_owner;
ALTER INDEX public.product_database_row_versions_latest_idx OWNER TO ba_authorization_owner;
ALTER TABLE public.product_database_row_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_database_row_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY product_database_row_versions_owner_only
  ON public.product_database_row_versions
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
REVOKE ALL ON public.product_database_row_versions FROM PUBLIC, ba_runtime;

CREATE TRIGGER product_database_row_versions_immutable
BEFORE UPDATE OR DELETE ON public.product_database_row_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE FUNCTION app.mutate_product_database_row(
  p_workspace_id uuid,
  p_table_id uuid,
  p_ordinal integer,
  p_expected_version bigint,
  p_actor_id uuid,
  p_operation text,
  p_record jsonb
) RETURNS TABLE (
  ordinal integer,
  version bigint,
  record jsonb,
  deleted boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_columns jsonb;
  v_current_operation text;
  v_current_version bigint;
  v_created_at timestamptz;
  v_next_version bigint;
BEGIN
  IF p_ordinal NOT BETWEEN 0 AND 4999
     OR p_expected_version NOT BETWEEN 1 AND 2147483646
     OR p_operation NOT IN ('update', 'delete') THEN
    RAISE EXCEPTION 'Database row mutation is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':' || p_table_id::text || ':' || p_ordinal::text, 0)
  );
  SELECT source.columns INTO v_columns
  FROM public.product_database_tables AS source
  JOIN public.product_database_rows AS base
    ON base.workspace_id = source.workspace_id
   AND base.table_id = source.id
   AND base.ordinal = p_ordinal
  WHERE source.workspace_id = p_workspace_id AND source.id = p_table_id;
  IF v_columns IS NULL THEN
    RAISE EXCEPTION 'Database row not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT history.version, history.operation
    INTO v_current_version, v_current_operation
  FROM public.product_database_row_versions AS history
  WHERE history.workspace_id = p_workspace_id
    AND history.table_id = p_table_id
    AND history.ordinal = p_ordinal
  ORDER BY history.version DESC
  LIMIT 1;
  v_current_version := coalesce(v_current_version, 1);
  IF v_current_operation = 'delete' THEN
    RAISE EXCEPTION 'Database row not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_version <> v_current_version THEN
    RAISE EXCEPTION 'Database row revision conflict' USING ERRCODE = '40001';
  END IF;
  IF p_operation = 'delete' THEN
    IF p_record IS NOT NULL THEN
      RAISE EXCEPTION 'Database delete record must be null' USING ERRCODE = '22023';
    END IF;
  ELSIF p_record IS NULL OR jsonb_typeof(p_record) <> 'object'
     OR (SELECT jsonb_agg(item.key ORDER BY item.key)
         FROM jsonb_object_keys(p_record) AS item(key))
        IS DISTINCT FROM
        (SELECT jsonb_agg(item.value #>> '{}' ORDER BY item.value #>> '{}')
         FROM jsonb_array_elements(v_columns) AS item(value))
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_record) AS field
       WHERE jsonb_typeof(field.value) NOT IN ('string', 'number', 'boolean', 'null')
          OR length(field.value::text) > 4000
     ) THEN
    RAISE EXCEPTION 'Database row does not match the declared columns' USING ERRCODE = '22023';
  END IF;
  v_next_version := v_current_version + 1;
  INSERT INTO public.product_database_row_versions (
    workspace_id, table_id, ordinal, version, operation, record, created_by
  ) VALUES (
    p_workspace_id, p_table_id, p_ordinal, v_next_version, p_operation,
    CASE WHEN p_operation = 'delete' THEN NULL ELSE p_record END, p_actor_id
  ) RETURNING product_database_row_versions.created_at INTO v_created_at;
  UPDATE public.product_database_tables
  SET updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_table_id;
  RETURN QUERY SELECT p_ordinal, v_next_version,
    CASE WHEN p_operation = 'delete' THEN NULL ELSE p_record END,
    p_operation = 'delete', v_created_at;
END;
$function$;

CREATE OR REPLACE FUNCTION app.list_product_database_tables(p_workspace_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  columns jsonb,
  row_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT source.id, source.name, source.description, source.columns,
    count(base.ordinal) FILTER (WHERE coalesce(latest.operation, 'update') <> 'delete'),
    source.created_at, source.updated_at
  FROM public.product_database_tables AS source
  LEFT JOIN public.product_database_rows AS base
    ON base.workspace_id = source.workspace_id AND base.table_id = source.id
  LEFT JOIN LATERAL (
    SELECT history.operation
    FROM public.product_database_row_versions AS history
    WHERE history.workspace_id = base.workspace_id
      AND history.table_id = base.table_id
      AND history.ordinal = base.ordinal
    ORDER BY history.version DESC
    LIMIT 1
  ) AS latest ON true
  WHERE source.workspace_id = p_workspace_id
  GROUP BY source.workspace_id, source.id
  ORDER BY source.updated_at DESC, source.id
  LIMIT 200;
$function$;

DROP FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer);
CREATE FUNCTION app.query_product_database_table(
  p_workspace_id uuid,
  p_table_id uuid,
  p_column text,
  p_contains text,
  p_limit integer
) RETURNS TABLE (ordinal integer, version bigint, record jsonb, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_columns jsonb;
  v_contains text := btrim(p_contains);
BEGIN
  SELECT source.columns INTO v_columns
  FROM public.product_database_tables AS source
  WHERE source.workspace_id = p_workspace_id AND source.id = p_table_id;
  IF v_columns IS NULL THEN
    RETURN;
  END IF;
  IF NOT v_columns ? p_column OR length(v_contains) > 500 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Database query is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT base.ordinal, coalesce(latest.version, 1),
    coalesce(latest.record, base.record), coalesce(latest.created_at, base.created_at)
  FROM public.product_database_rows AS base
  LEFT JOIN LATERAL (
    SELECT history.version, history.operation, history.record, history.created_at
    FROM public.product_database_row_versions AS history
    WHERE history.workspace_id = base.workspace_id
      AND history.table_id = base.table_id
      AND history.ordinal = base.ordinal
    ORDER BY history.version DESC
    LIMIT 1
  ) AS latest ON true
  WHERE base.workspace_id = p_workspace_id AND base.table_id = p_table_id
    AND coalesce(latest.operation, 'update') <> 'delete'
    AND (
      v_contains = ''
      OR strpos(
        lower(coalesce(coalesce(latest.record, base.record) ->> p_column, '')),
        lower(v_contains)
      ) > 0
    )
  ORDER BY base.ordinal
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_database()
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
  ) VALUES (NEW.workspace_id, NEW.agent_id, NEW.version, v_database_table_id);
  INSERT INTO public.agent_product_release_database_rows (
    workspace_id, agent_id, release_version, database_table_id, row_ordinal, row_version
  )
  SELECT NEW.workspace_id, NEW.agent_id, NEW.version, v_database_table_id,
    base.ordinal, coalesce(latest.version, 1)
  FROM public.product_database_rows AS base
  LEFT JOIN LATERAL (
    SELECT history.version, history.operation
    FROM public.product_database_row_versions AS history
    WHERE history.workspace_id = base.workspace_id
      AND history.table_id = base.table_id
      AND history.ordinal = base.ordinal
    ORDER BY history.version DESC
    LIMIT 1
  ) AS latest ON true
  WHERE base.workspace_id = NEW.workspace_id AND base.table_id = v_database_table_id
    AND coalesce(latest.operation, 'update') <> 'delete';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.read_agent_product_conversation_database(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_limit integer
) RETURNS TABLE (table_name text, columns jsonb, row_ordinal integer, record jsonb)
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
  SELECT source.name, source.columns, release_row.row_ordinal,
    CASE WHEN release_row.row_version = 1 THEN base.record ELSE pinned.record END
  FROM public.agent_product_conversations AS conversation
  JOIN public.agent_product_release_database_rows AS release_row
    ON release_row.workspace_id = conversation.workspace_id
   AND release_row.agent_id = conversation.agent_id
   AND release_row.release_version = conversation.release_version
  JOIN public.product_database_tables AS source
    ON source.workspace_id = release_row.workspace_id
   AND source.id = release_row.database_table_id
  JOIN public.product_database_rows AS base
    ON base.workspace_id = release_row.workspace_id
   AND base.table_id = release_row.database_table_id
   AND base.ordinal = release_row.row_ordinal
  LEFT JOIN public.product_database_row_versions AS pinned
    ON pinned.workspace_id = release_row.workspace_id
   AND pinned.table_id = release_row.database_table_id
   AND pinned.ordinal = release_row.row_ordinal
   AND pinned.version = release_row.row_version
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND (release_row.row_version = 1 OR pinned.operation = 'update')
  ORDER BY release_row.row_ordinal
  LIMIT p_limit;
END;
$function$;

ALTER FUNCTION app.mutate_product_database_row(uuid, uuid, integer, bigint, uuid, text, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_database_tables(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.snapshot_agent_product_release_database() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.mutate_product_database_row(uuid, uuid, integer, bigint, uuid, text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_product_database_tables(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.snapshot_agent_product_release_database() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mutate_product_database_row(uuid, uuid, integer, bigint, uuid, text, jsonb)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.list_product_database_tables(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
