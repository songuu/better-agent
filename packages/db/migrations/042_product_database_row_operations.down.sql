DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_database_row_versions) THEN
    RAISE EXCEPTION 'cannot roll back migration 042: immutable Database row versions exist'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.mutate_product_database_row(uuid, uuid, integer, bigint, uuid, text, jsonb);
DROP FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer);
DROP TRIGGER product_database_row_versions_immutable ON public.product_database_row_versions;
DROP TABLE public.product_database_row_versions;
ALTER TABLE public.agent_product_release_database_rows DROP COLUMN row_version;

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
    count(row.ordinal), source.created_at, source.updated_at
  FROM public.product_database_tables AS source
  LEFT JOIN public.product_database_rows AS row
    ON row.workspace_id = source.workspace_id AND row.table_id = source.id
  WHERE source.workspace_id = p_workspace_id
  GROUP BY source.workspace_id, source.id
  ORDER BY source.updated_at DESC, source.id
  LIMIT 200;
$function$;

CREATE FUNCTION app.query_product_database_table(
  p_workspace_id uuid,
  p_table_id uuid,
  p_column text,
  p_contains text,
  p_limit integer
) RETURNS TABLE (ordinal integer, record jsonb, created_at timestamptz)
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
  SELECT row.ordinal, row.record, row.created_at
  FROM public.product_database_rows AS row
  WHERE row.workspace_id = p_workspace_id AND row.table_id = p_table_id
    AND (v_contains = '' OR strpos(lower(coalesce(row.record ->> p_column, '')), lower(v_contains)) > 0)
  ORDER BY row.ordinal
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
    workspace_id, agent_id, release_version, database_table_id, row_ordinal
  )
  SELECT NEW.workspace_id, NEW.agent_id, NEW.version, v_database_table_id, row.ordinal
  FROM public.product_database_rows AS row
  WHERE row.workspace_id = NEW.workspace_id AND row.table_id = v_database_table_id;
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

ALTER FUNCTION app.list_product_database_tables(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.snapshot_agent_product_release_database() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_product_database_tables(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.snapshot_agent_product_release_database() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_product_database_tables(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer)
  TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
