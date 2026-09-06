GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION IF EXISTS app.query_product_database_table(uuid, uuid, text, text, integer);
DROP FUNCTION IF EXISTS app.append_product_database_rows(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS app.list_product_database_tables(uuid);
DROP FUNCTION IF EXISTS app.create_product_database_table(uuid, uuid, text, text, jsonb);
DROP TABLE IF EXISTS public.product_database_rows;
DROP TABLE IF EXISTS public.product_database_tables;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
