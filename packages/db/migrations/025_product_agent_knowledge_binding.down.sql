GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.search_agent_product_conversation_knowledge(uuid, uuid, text, integer);
DROP FUNCTION app.update_agent_draft_with_knowledge(uuid, uuid, bigint, text, text, text, text, uuid);
DROP FUNCTION app.create_agent_draft_with_knowledge(uuid, uuid, text, text, text, text, uuid);
DROP FUNCTION app.list_agent_drafts_with_knowledge(uuid);
DROP TRIGGER agent_product_release_knowledge_snapshot ON public.agent_product_releases;
DROP FUNCTION app.snapshot_agent_product_release_knowledge();
DROP TABLE public.agent_product_release_knowledge_documents;
DROP TABLE public.agent_product_release_knowledge_bindings;
DROP TABLE public.agent_product_knowledge_bindings;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
