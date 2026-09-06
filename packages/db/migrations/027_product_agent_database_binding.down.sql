GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.read_agent_product_conversation_database(uuid, uuid, integer);
DROP FUNCTION app.update_agent_draft_with_capabilities(uuid, uuid, bigint, text, text, text, text, uuid, uuid);
DROP FUNCTION app.create_agent_draft_with_capabilities(uuid, uuid, text, text, text, text, uuid, uuid);
DROP FUNCTION app.list_agent_drafts_with_capabilities(uuid);
DROP TRIGGER agent_product_release_database_snapshot ON public.agent_product_releases;
DROP FUNCTION app.snapshot_agent_product_release_database();
DROP TABLE public.agent_product_release_database_rows;
DROP TABLE public.agent_product_release_database_bindings;
DROP TABLE public.agent_product_database_bindings;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
