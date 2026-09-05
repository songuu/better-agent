DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_drafts LIMIT 1) THEN
    RAISE EXCEPTION 'cannot remove product Agent Studio with retained drafts'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

DROP FUNCTION app.publish_agent_draft(uuid, uuid, bigint, uuid);
DROP FUNCTION app.update_agent_draft(uuid, uuid, bigint, text, text, text, text);
DROP FUNCTION app.create_agent_draft(uuid, uuid, text, text, text, text);
DROP FUNCTION app.list_agent_drafts(uuid);
DROP TABLE public.agent_product_releases;
DROP TABLE public.agent_drafts;
