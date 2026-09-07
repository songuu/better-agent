DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_flow_deployment_rollbacks LIMIT 1) THEN
    RAISE EXCEPTION 'cannot remove product Flow rollback while receipts exist';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.rollback_product_flow_deployment(uuid, uuid, text, bigint, bigint, uuid, text);
DROP FUNCTION app.list_product_flow_rollbacks(uuid, uuid);
DROP FUNCTION app.list_product_flow_releases(uuid, uuid);
DROP TABLE public.product_flow_deployment_rollbacks;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
