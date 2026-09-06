GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.list_product_release_evaluation_targets(uuid);

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
