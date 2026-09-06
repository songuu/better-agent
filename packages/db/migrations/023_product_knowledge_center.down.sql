DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_knowledge_bases LIMIT 1) THEN
    RAISE EXCEPTION 'cannot remove product Knowledge Center while Knowledge facts exist';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.search_product_knowledge(uuid, uuid, text, integer);
DROP FUNCTION app.list_product_knowledge_documents(uuid, uuid);
DROP FUNCTION app.ingest_product_knowledge_document(uuid, uuid, uuid, text, jsonb);
DROP FUNCTION app.create_product_knowledge_base(uuid, uuid, text, text);
DROP FUNCTION app.list_product_knowledge_bases(uuid);
DROP TABLE public.product_knowledge_chunks;
DROP TABLE public.product_knowledge_documents;
DROP TABLE public.product_knowledge_bases;
DROP FUNCTION app.reject_product_knowledge_immutable_mutation();

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
