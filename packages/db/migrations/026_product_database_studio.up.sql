-- Product Database Studio. Rows are append-only JSON records behind a fixed
-- column allowlist; runtime callers receive only bounded, parameterized reads.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_database_tables (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE public.product_database_rows (
  workspace_id uuid NOT NULL,
  table_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4999),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, table_id, ordinal),
  FOREIGN KEY (workspace_id, table_id)
    REFERENCES public.product_database_tables(workspace_id, id)
);

ALTER TABLE public.product_database_tables OWNER TO ba_authorization_owner;
ALTER TABLE public.product_database_rows OWNER TO ba_authorization_owner;
ALTER TABLE public.product_database_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_database_tables FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_database_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_database_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY product_database_tables_owner_only ON public.product_database_tables
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_database_rows_owner_only ON public.product_database_rows
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.product_database_tables, public.product_database_rows FROM PUBLIC;
REVOKE ALL ON public.product_database_tables, public.product_database_rows FROM ba_runtime;

CREATE TRIGGER product_database_rows_immutable
BEFORE UPDATE OR DELETE ON public.product_database_rows
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE FUNCTION app.create_product_database_table(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_columns jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_column jsonb;
  v_names text[] := ARRAY[]::text[];
  v_id uuid := gen_random_uuid();
BEGIN
  IF p_columns IS NULL OR jsonb_typeof(p_columns) <> 'array'
     OR jsonb_array_length(p_columns) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Database columns are invalid' USING ERRCODE = '22023';
  END IF;
  FOR v_column IN SELECT value FROM jsonb_array_elements(p_columns)
  LOOP
    IF jsonb_typeof(v_column) <> 'string'
       OR length(btrim(v_column #>> '{}')) NOT BETWEEN 1 AND 40
       OR NOT (btrim(v_column #>> '{}') ~ '^[A-Za-z][A-Za-z0-9_]*$')
       OR btrim(v_column #>> '{}') = ANY(v_names) THEN
      RAISE EXCEPTION 'Database column is invalid or duplicated' USING ERRCODE = '22023';
    END IF;
    v_names := array_append(v_names, btrim(v_column #>> '{}'));
  END LOOP;
  INSERT INTO public.product_database_tables (
    workspace_id, id, name, description, columns, created_by
  ) VALUES (
    p_workspace_id, v_id, btrim(p_name), p_description, to_jsonb(v_names), p_actor_id
  );
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.list_product_database_tables(p_workspace_id uuid)
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

CREATE FUNCTION app.append_product_database_rows(
  p_workspace_id uuid,
  p_table_id uuid,
  p_actor_id uuid,
  p_rows jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_columns jsonb;
  v_row jsonb;
  v_next integer;
  v_count integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_table_id::text, 0));
  SELECT source.columns INTO v_columns
  FROM public.product_database_tables AS source
  WHERE source.workspace_id = p_workspace_id AND source.id = p_table_id;
  IF v_columns IS NULL THEN
    RAISE EXCEPTION 'Database table not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
     OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500
     OR octet_length(p_rows::text) > 1048576 THEN
    RAISE EXCEPTION 'Database rows are invalid' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(max(row.ordinal), -1) + 1 INTO v_next
  FROM public.product_database_rows AS row
  WHERE row.workspace_id = p_workspace_id AND row.table_id = p_table_id;
  IF v_next + jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'Database table row limit exceeded' USING ERRCODE = '54000';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF jsonb_typeof(v_row) <> 'object'
       OR (SELECT jsonb_agg(item.key ORDER BY item.key)
           FROM jsonb_object_keys(v_row) AS item(key))
          IS DISTINCT FROM
          (SELECT jsonb_agg(item.value #>> '{}' ORDER BY item.value #>> '{}')
           FROM jsonb_array_elements(v_columns) AS item(value))
       OR EXISTS (
         SELECT 1 FROM jsonb_each(v_row) AS field
         WHERE jsonb_typeof(field.value) NOT IN ('string', 'number', 'boolean', 'null')
            OR length(field.value::text) > 4000
       ) THEN
      RAISE EXCEPTION 'Database row does not match the declared columns' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.product_database_rows (
      workspace_id, table_id, ordinal, record, created_by
    ) VALUES (p_workspace_id, p_table_id, v_next + v_count, v_row, p_actor_id);
    v_count := v_count + 1;
  END LOOP;
  UPDATE public.product_database_tables
  SET updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_table_id;
  RETURN v_count;
END;
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

ALTER FUNCTION app.create_product_database_table(uuid, uuid, text, text, jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_database_tables(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.append_product_database_rows(uuid, uuid, uuid, jsonb) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.create_product_database_table(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_product_database_tables(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.append_product_database_rows(uuid, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_product_database_table(uuid, uuid, text, text, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.list_product_database_tables(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.append_product_database_rows(uuid, uuid, uuid, jsonb) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
