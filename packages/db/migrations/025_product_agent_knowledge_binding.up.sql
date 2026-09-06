-- Product Agent Knowledge binding. Draft selection remains mutable, while every
-- published Agent release pins the exact immutable document set available at publish time.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE public.agent_product_knowledge_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  knowledge_base_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (workspace_id, agent_id)
    REFERENCES public.agent_drafts(workspace_id, id),
  FOREIGN KEY (workspace_id, knowledge_base_id)
    REFERENCES public.product_knowledge_bases(workspace_id, id)
);

CREATE TABLE public.agent_product_release_knowledge_bindings (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL,
  knowledge_base_id uuid NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, agent_id, release_version),
  FOREIGN KEY (workspace_id, agent_id, release_version)
    REFERENCES public.agent_product_releases(workspace_id, agent_id, version),
  FOREIGN KEY (workspace_id, knowledge_base_id)
    REFERENCES public.product_knowledge_bases(workspace_id, id)
);

CREATE TABLE public.agent_product_release_knowledge_documents (
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  release_version bigint NOT NULL,
  document_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, release_version, document_id),
  FOREIGN KEY (workspace_id, agent_id, release_version)
    REFERENCES public.agent_product_release_knowledge_bindings(
      workspace_id, agent_id, release_version
    ),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES public.product_knowledge_documents(workspace_id, id)
);

CREATE INDEX agent_product_release_knowledge_documents_lookup_idx
  ON public.agent_product_release_knowledge_documents (
    workspace_id, agent_id, release_version
  );

ALTER TABLE public.agent_product_knowledge_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_knowledge_bindings OWNER TO ba_authorization_owner;
ALTER TABLE public.agent_product_release_knowledge_documents OWNER TO ba_authorization_owner;
ALTER INDEX public.agent_product_release_knowledge_documents_lookup_idx
  OWNER TO ba_authorization_owner;

ALTER TABLE public.agent_product_knowledge_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_knowledge_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_knowledge_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_knowledge_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_release_knowledge_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_product_knowledge_bindings_owner_only
  ON public.agent_product_knowledge_bindings
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_release_knowledge_bindings_owner_only
  ON public.agent_product_release_knowledge_bindings
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');
CREATE POLICY agent_product_release_knowledge_documents_owner_only
  ON public.agent_product_release_knowledge_documents
  USING (current_user = 'ba_authorization_owner')
  WITH CHECK (current_user = 'ba_authorization_owner');

REVOKE ALL ON public.agent_product_knowledge_bindings,
  public.agent_product_release_knowledge_bindings,
  public.agent_product_release_knowledge_documents FROM PUBLIC;
REVOKE ALL ON public.agent_product_knowledge_bindings,
  public.agent_product_release_knowledge_bindings,
  public.agent_product_release_knowledge_documents FROM ba_runtime;

CREATE TRIGGER agent_product_release_knowledge_bindings_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_knowledge_bindings
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE TRIGGER agent_product_release_knowledge_documents_immutable
BEFORE UPDATE OR DELETE ON public.agent_product_release_knowledge_documents
FOR EACH ROW EXECUTE FUNCTION app.reject_product_knowledge_immutable_mutation();

CREATE FUNCTION app.snapshot_agent_product_release_knowledge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_knowledge_base_id uuid;
BEGIN
  SELECT binding.knowledge_base_id INTO v_knowledge_base_id
  FROM public.agent_product_knowledge_bindings AS binding
  WHERE binding.workspace_id = NEW.workspace_id
    AND binding.agent_id = NEW.agent_id;
  IF v_knowledge_base_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.agent_product_release_knowledge_bindings (
    workspace_id, agent_id, release_version, knowledge_base_id
  ) VALUES (
    NEW.workspace_id, NEW.agent_id, NEW.version, v_knowledge_base_id
  );
  INSERT INTO public.agent_product_release_knowledge_documents (
    workspace_id, agent_id, release_version, document_id
  )
  SELECT NEW.workspace_id, NEW.agent_id, NEW.version, document.id
  FROM public.product_knowledge_documents AS document
  WHERE document.workspace_id = NEW.workspace_id
    AND document.knowledge_base_id = v_knowledge_base_id;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER agent_product_release_knowledge_snapshot
AFTER INSERT ON public.agent_product_releases
FOR EACH ROW EXECUTE FUNCTION app.snapshot_agent_product_release_knowledge();

CREATE FUNCTION app.list_agent_drafts_with_knowledge(p_workspace_id uuid)
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
  knowledge_base_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT draft.workspace_id, draft.id, draft.name, draft.description,
    draft.instructions, draft.model, draft.status, draft.revision, draft.created_by,
    draft.created_at, draft.updated_at, binding.knowledge_base_id
  FROM public.agent_drafts AS draft
  LEFT JOIN public.agent_product_knowledge_bindings AS binding
    ON binding.workspace_id = draft.workspace_id AND binding.agent_id = draft.id
  WHERE draft.workspace_id = p_workspace_id
  ORDER BY draft.updated_at DESC, draft.id
  LIMIT 200;
$function$;

CREATE FUNCTION app.create_agent_draft_with_knowledge(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text,
  p_knowledge_base_id uuid
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
BEGIN
  IF p_knowledge_base_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_knowledge_bases AS base
    WHERE base.workspace_id = p_workspace_id AND base.id = p_knowledge_base_id
  ) THEN
    RAISE EXCEPTION 'Knowledge base not found' USING ERRCODE = 'P0002';
  END IF;
  v_row := app.create_agent_draft(
    p_workspace_id, p_actor_id, p_name, p_description, p_instructions, p_model
  );
  IF p_knowledge_base_id IS NOT NULL THEN
    INSERT INTO public.agent_product_knowledge_bindings (
      workspace_id, agent_id, knowledge_base_id
    ) VALUES (p_workspace_id, v_row.id, p_knowledge_base_id);
  END IF;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.update_agent_draft_with_knowledge(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_description text,
  p_instructions text,
  p_model text,
  p_knowledge_base_id uuid
) RETURNS public.agent_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_row public.agent_drafts;
BEGIN
  IF p_knowledge_base_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_knowledge_bases AS base
    WHERE base.workspace_id = p_workspace_id AND base.id = p_knowledge_base_id
  ) THEN
    RAISE EXCEPTION 'Knowledge base not found' USING ERRCODE = 'P0002';
  END IF;
  v_row := app.update_agent_draft(
    p_workspace_id, p_agent_id, p_expected_revision, p_name, p_description,
    p_instructions, p_model
  );
  DELETE FROM public.agent_product_knowledge_bindings
  WHERE workspace_id = p_workspace_id AND agent_id = p_agent_id;
  IF p_knowledge_base_id IS NOT NULL THEN
    INSERT INTO public.agent_product_knowledge_bindings (
      workspace_id, agent_id, knowledge_base_id
    ) VALUES (p_workspace_id, p_agent_id, p_knowledge_base_id);
  END IF;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.search_agent_product_conversation_knowledge(
  p_workspace_id uuid,
  p_conversation_id uuid,
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
  IF length(v_query) NOT BETWEEN 1 AND 500 OR p_limit NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'Agent Knowledge query is invalid' USING ERRCODE = '22023';
  END IF;
  v_tsquery := plainto_tsquery('simple', v_query);
  RETURN QUERY
  SELECT document.id, document.title, chunk.ordinal, chunk.content,
    (ts_rank_cd(chunk.search_vector, v_tsquery) +
      CASE WHEN strpos(lower(chunk.content), lower(v_query)) > 0 THEN 0.25 ELSE 0 END
    )::double precision AS score
  FROM public.agent_product_conversations AS conversation
  JOIN public.agent_product_release_knowledge_documents AS release_document
    ON release_document.workspace_id = conversation.workspace_id
   AND release_document.agent_id = conversation.agent_id
   AND conversation.release_version = release_document.release_version
  JOIN public.product_knowledge_documents AS document
    ON document.workspace_id = release_document.workspace_id
   AND document.id = release_document.document_id
  JOIN public.product_knowledge_chunks AS chunk
    ON chunk.workspace_id = document.workspace_id AND chunk.document_id = document.id
  WHERE conversation.workspace_id = p_workspace_id
    AND conversation.id = p_conversation_id
    AND (chunk.search_vector @@ v_tsquery OR strpos(lower(chunk.content), lower(v_query)) > 0)
  ORDER BY score DESC, document.created_at DESC, chunk.ordinal
  LIMIT p_limit;
END;
$function$;

ALTER FUNCTION app.snapshot_agent_product_release_knowledge()
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.list_agent_drafts_with_knowledge(uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.create_agent_draft_with_knowledge(uuid, uuid, text, text, text, text, uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.update_agent_draft_with_knowledge(uuid, uuid, bigint, text, text, text, text, uuid)
  OWNER TO ba_authorization_owner;
ALTER FUNCTION app.search_agent_product_conversation_knowledge(uuid, uuid, text, integer)
  OWNER TO ba_authorization_owner;

REVOKE ALL ON FUNCTION app.snapshot_agent_product_release_knowledge() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_knowledge(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_agent_draft_with_knowledge(uuid, uuid, text, text, text, text, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_agent_draft_with_knowledge(uuid, uuid, bigint, text, text, text, text, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_agent_product_conversation_knowledge(uuid, uuid, text, integer)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_knowledge(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.create_agent_draft_with_knowledge(uuid, uuid, text, text, text, text, uuid)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.update_agent_draft_with_knowledge(uuid, uuid, bigint, text, text, text, text, uuid)
  TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.search_agent_product_conversation_knowledge(uuid, uuid, text, integer)
  TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
