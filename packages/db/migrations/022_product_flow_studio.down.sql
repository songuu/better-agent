DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_flow_drafts LIMIT 1) THEN
    RAISE EXCEPTION 'cannot remove product Flow Studio while Flow facts exist';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.list_product_flow_debug_runs(uuid, uuid);
DROP FUNCTION app.record_product_flow_debug(uuid, uuid, bigint, uuid, text, text, jsonb);
DROP FUNCTION app.prepare_product_flow_debug(uuid, uuid, bigint, uuid);
DROP FUNCTION app.publish_product_flow(uuid, uuid, bigint, uuid, text);
DROP FUNCTION app.update_product_flow_draft(uuid, uuid, bigint, text, text, jsonb);
DROP FUNCTION app.create_product_flow_draft(uuid, uuid, text, text, jsonb);
DROP FUNCTION app.list_product_flow_drafts(uuid);
DROP TABLE public.product_flow_debug_runs;
DROP TABLE public.product_flow_deployments;
DROP TABLE public.product_flow_releases;
DROP TABLE public.product_flow_drafts;
DROP FUNCTION app.reject_product_flow_immutable_mutation();

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
