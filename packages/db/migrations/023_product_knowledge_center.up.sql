-- Product-facing Knowledge Center. The Web boundary performs bounded deterministic
-- chunking; PostgreSQL owns tenant-scoped ingestion facts and retrieval readback.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.product_knowledge_bases (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE public.product_knowledge_documents (
  workspace_id uuid NOT NULL,
  knowledge_base_id uuid NOT NULL,
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 320),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, knowledge_base_id)
    REFERENCES public.product_knowledge_bases(workspace_id, id)
);

CREATE TABLE public.product_knowledge_chunks (
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 319),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 800),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  PRIMARY KEY (workspace_id, document_id, ordinal),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES public.product_knowledge_documents(workspace_id, id)
);

CREATE INDEX product_knowledge_chunks_search_idx
  ON public.product_knowledge_chunks USING gin (search_vector);

ALTER TABLE public.product_knowledge_bases OWNER TO ba_authorization_owner;
ALTER TABLE public.product_knowledge_documents OWNER TO ba_authorization_owner;
ALTER TABLE public.product_knowledge_chunks OWNER TO ba_authorization_owner;
ALTER INDEX public.product_knowledge_chunks_search_idx OWNER TO ba_authorization_owner;

ALTER TABLE public.product_knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_knowledge_bases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_knowledge_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_knowledge_chunks FORCE ROW LEVEL SECURITY;

CREATE POLICY product_knowledge_bases_owner_only ON public.product_knowledge_bases
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_knowledge_documents_owner_only ON public.product_knowledge_documents
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY product_knowledge_chunks_owner_only ON public.product_knowledge_chunks
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.product_knowledge_bases, public.product_knowledge_documents,
  public.product_knowledge_chunks FROM PUBLIC;
REVOKE ALL ON public.product_knowledge_bases, public.product_knowledge_documents,
  public.product_knowledge_chunks FROM ba_runtime;

CREATE FUNCTION app.reject_product_knowledge_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'product Knowledge ingestion history is immutable' USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER product_knowledge_documents_immutable
BEFORE UPDATE OR DELETE ON public.product_knowledge_documents
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE TRIGGER product_knowledge_chunks_immutable
BEFORE UPDATE OR DELETE ON public.product_knowledge_chunks
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE FUNCTION app.list_product_knowledge_bases(p_workspace_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  document_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT
    base.id,
    base.name,
    base.description,
    count(document.id),
    base.created_at,
    base.updated_at
  FROM public.product_knowledge_bases AS base
  LEFT JOIN public.product_knowledge_documents AS document
    ON document.workspace_id = base.workspace_id
   AND document.knowledge_base_id = base.id
  WHERE base.workspace_id = p_workspace_id
  GROUP BY base.workspace_id, base.id
  ORDER BY base.updated_at DESC, base.id
  LIMIT 200;
$function$;

CREATE FUNCTION app.create_product_knowledge_base(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.product_knowledge_bases (
    workspace_id, id, name, description, created_by
  ) VALUES (
    p_workspace_id, v_id, btrim(p_name), p_description, p_actor_id
  );
  RETURN v_id;
END;
$function$;

CREATE FUNCTION app.ingest_product_knowledge_document(
  p_workspace_id uuid,
  p_knowledge_base_id uuid,
  p_actor_id uuid,
  p_title text,
  p_chunks jsonb
) RETURNS public.product_knowledge_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_document public.product_knowledge_documents;
  v_chunk jsonb;
  v_expected_ordinal integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.product_knowledge_bases AS base
    WHERE base.workspace_id = p_workspace_id AND base.id = p_knowledge_base_id
  ) THEN
    RAISE EXCEPTION 'Knowledge base not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array'
     OR jsonb_array_length(p_chunks) NOT BETWEEN 1 AND 320
     OR octet_length(p_chunks::text) > 1048576 THEN
    RAISE EXCEPTION 'Knowledge chunks are invalid' USING ERRCODE = '22023';
  END IF;
  FOR v_chunk IN SELECT value FROM jsonb_array_elements(p_chunks)
  LOOP
    IF jsonb_typeof(v_chunk) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_chunk)) <> 2
       OR NOT (v_chunk ? 'ordinal' AND v_chunk ? 'content')
       OR jsonb_typeof(v_chunk -> 'ordinal') <> 'number'
       OR jsonb_typeof(v_chunk -> 'content') <> 'string'
       OR (v_chunk ->> 'ordinal')::integer <> v_expected_ordinal
       OR length(btrim(v_chunk ->> 'content')) NOT BETWEEN 1 AND 800 THEN
      RAISE EXCEPTION 'Knowledge chunk sequence is invalid' USING ERRCODE = '22023';
    END IF;
    v_expected_ordinal := v_expected_ordinal + 1;
  END LOOP;
  INSERT INTO public.product_knowledge_documents (
    workspace_id, knowledge_base_id, id, title, chunk_count, created_by
  ) VALUES (
    p_workspace_id, p_knowledge_base_id, gen_random_uuid(), btrim(p_title),
    jsonb_array_length(p_chunks), p_actor_id
  ) RETURNING * INTO v_document;
  INSERT INTO public.product_knowledge_chunks (workspace_id, document_id, ordinal, content)
  SELECT p_workspace_id, v_document.id, (item.chunk ->> 'ordinal')::integer, item.chunk ->> 'content'
  FROM jsonb_array_elements(p_chunks) AS item(chunk);
  UPDATE public.product_knowledge_bases
  SET updated_at = clock_timestamp()
  WHERE workspace_id = p_workspace_id AND id = p_knowledge_base_id;
  RETURN v_document;
END;
$function$;

CREATE FUNCTION app.list_product_knowledge_documents(
  p_workspace_id uuid,
  p_knowledge_base_id uuid
) RETURNS SETOF public.product_knowledge_documents
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT document.*
  FROM public.product_knowledge_documents AS document
  WHERE document.workspace_id = p_workspace_id
    AND document.knowledge_base_id = p_knowledge_base_id
  ORDER BY document.created_at DESC, document.id
  LIMIT 500;
$function$;

CREATE FUNCTION app.search_product_knowledge(
  p_workspace_id uuid,
  p_knowledge_base_id uuid,
  p_query text,
  p_limit integer
) RETURNS TABLE (
  document_id uuid,
  document_title text,
  ordinal integer,
  content text,
  score double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_query text := btrim(p_query);
  v_tsquery tsquery;
BEGIN
  IF length(v_query) NOT BETWEEN 1 AND 500 OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Knowledge query is invalid' USING ERRCODE = '22023';
  END IF;
  v_tsquery := plainto_tsquery('simple', v_query);
  RETURN QUERY
  SELECT
    document.id,
    document.title,
    chunk.ordinal,
    chunk.content,
    (ts_rank_cd(chunk.search_vector, v_tsquery) +
      CASE WHEN strpos(lower(chunk.content), lower(v_query)) > 0 THEN 0.25 ELSE 0 END
    )::double precision AS score
  FROM public.product_knowledge_chunks AS chunk
  JOIN public.product_knowledge_documents AS document
    ON document.workspace_id = chunk.workspace_id AND document.id = chunk.document_id
  WHERE chunk.workspace_id = p_workspace_id
    AND document.knowledge_base_id = p_knowledge_base_id
    AND (chunk.search_vector @@ v_tsquery OR strpos(lower(chunk.content), lower(v_query)) > 0)
  ORDER BY score DESC, document.created_at DESC, chunk.ordinal
  LIMIT p_limit;
END;
$function$;

ALTER FUNCTION app.reject_product_knowledge_immutable_mutation() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_knowledge_bases(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_product_knowledge_base(uuid, uuid, text, text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.ingest_product_knowledge_document(uuid, uuid, uuid, text, jsonb)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_product_knowledge_documents(uuid, uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.search_product_knowledge(uuid, uuid, text, integer) OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.reject_product_knowledge_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_product_knowledge_bases(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_product_knowledge_base(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.ingest_product_knowledge_document(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_product_knowledge_documents(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_product_knowledge(uuid, uuid, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.list_product_knowledge_bases(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_product_knowledge_base(uuid, uuid, text, text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.ingest_product_knowledge_document(uuid, uuid, uuid, text, jsonb)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.list_product_knowledge_documents(uuid, uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.search_product_knowledge(uuid, uuid, text, integer) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
