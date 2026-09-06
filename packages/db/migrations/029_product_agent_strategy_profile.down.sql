DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_drafts)
    OR EXISTS (SELECT 1 FROM public.agent_product_releases)
    OR EXISTS (SELECT 1 FROM public.agent_product_runs)
  THEN RAISE EXCEPTION 'cannot remove product Agent strategies with retained product data' USING ERRCODE='55000';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.route_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint);
DROP FUNCTION app.update_agent_draft_with_strategy_capabilities(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb);
DROP FUNCTION app.create_agent_draft_with_strategy_capabilities(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb);
DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
DROP FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text);
DROP FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid);
DROP FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint);

ALTER TABLE public.agent_product_runs DROP COLUMN router_output_tokens,DROP COLUMN router_input_tokens,DROP COLUMN router_provider_request_id,
  DROP COLUMN routing_mode,DROP COLUMN strategy_version;
ALTER TABLE public.agent_product_releases DROP CONSTRAINT agent_product_releases_strategy_profile_check,
  DROP COLUMN strategy_version,DROP COLUMN strategy_profile;
ALTER TABLE public.agent_drafts DROP CONSTRAINT agent_drafts_strategy_profile_check,
  DROP COLUMN strategy_version,DROP COLUMN strategy_profile;
DROP FUNCTION app.is_valid_product_agent_strategy_profile(jsonb);

CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
  revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
  database_table_id uuid,role_mode text,role_profile jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
  SELECT draft.workspace_id,draft.id,draft.name,draft.description,draft.instructions,draft.model,draft.status,
    draft.revision,draft.created_by,draft.created_at,draft.updated_at,knowledge.knowledge_base_id,
    database_binding.database_table_id,draft.role_mode,draft.role_profile
  FROM public.agent_drafts draft
  LEFT JOIN public.agent_product_knowledge_bindings knowledge
    ON knowledge.workspace_id=draft.workspace_id AND knowledge.agent_id=draft.id
  LEFT JOIN public.agent_product_database_bindings database_binding
    ON database_binding.workspace_id=draft.workspace_id AND database_binding.agent_id=draft.id
  WHERE draft.workspace_id=p_workspace_id ORDER BY draft.updated_at DESC,draft.id LIMIT 200;
$function$;

CREATE FUNCTION app.publish_agent_draft(p_workspace_id uuid,p_agent_id uuid,p_expected_revision bigint,p_actor_id uuid)
RETURNS public.agent_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
DECLARE v_row public.agent_drafts; v_version bigint;
BEGIN
  SELECT COALESCE(max(version),0)+1 INTO v_version FROM public.agent_product_releases
    WHERE workspace_id=p_workspace_id AND agent_id=p_agent_id;
  UPDATE public.agent_drafts SET status='published',revision=revision+1,updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND id=p_agent_id AND revision=p_expected_revision RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent draft revision conflict' USING ERRCODE='40001'; END IF;
  INSERT INTO public.agent_product_releases(workspace_id,agent_id,version,name,description,instructions,model,
    published_by,role_mode,role_profile) VALUES(v_row.workspace_id,v_row.id,v_version,v_row.name,
    v_row.description,v_row.instructions,v_row.model,p_actor_id,v_row.role_mode,v_row.role_profile);
  RETURN v_row;
END;
$function$;

CREATE FUNCTION app.begin_agent_product_run(p_workspace_id uuid,p_conversation_id uuid,p_actor_id uuid,p_input_text text)
RETURNS TABLE(run_id uuid,conversation_id uuid,agent_id uuid,sequence bigint,instructions text,model text,input_text text,history jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
DECLARE v_conversation public.agent_product_conversations; v_release public.agent_product_releases;
  v_run_id uuid:=gen_random_uuid(); v_sequence bigint; v_history jsonb;
BEGIN
  SELECT conversation.* INTO v_conversation FROM public.agent_product_conversations conversation
    WHERE conversation.workspace_id=p_workspace_id AND conversation.id=p_conversation_id
      AND conversation.actor_id=p_actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found' USING ERRCODE='P0002'; END IF;
  SELECT release.* INTO STRICT v_release FROM public.agent_product_releases release
    WHERE release.workspace_id=v_conversation.workspace_id AND release.agent_id=v_conversation.agent_id
      AND release.version=v_conversation.release_version;
  SELECT COALESCE(max(run.sequence),0)+1 INTO v_sequence FROM public.agent_product_runs run
    WHERE run.workspace_id=p_workspace_id AND run.conversation_id=p_conversation_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user',run.input_text,'assistant',run.output_text) ORDER BY run.sequence),'[]'::jsonb)
    INTO v_history FROM (SELECT previous.input_text,previous.output_text,previous.sequence
      FROM public.agent_product_runs previous WHERE previous.workspace_id=p_workspace_id
      AND previous.conversation_id=p_conversation_id AND previous.status='completed'
      ORDER BY previous.sequence DESC LIMIT 20) run;
  INSERT INTO public.agent_product_runs(workspace_id,id,conversation_id,sequence,input_text,model)
    VALUES(p_workspace_id,v_run_id,p_conversation_id,v_sequence,btrim(p_input_text),v_release.model);
  UPDATE public.agent_product_conversations SET updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace_id AND id=p_conversation_id;
  RETURN QUERY SELECT v_run_id,v_conversation.id,v_conversation.agent_id,v_sequence,v_release.instructions,
    v_release.model,btrim(p_input_text),v_history;
END;
$function$;

CREATE FUNCTION app.complete_agent_product_run(p_workspace_id uuid,p_run_id uuid,p_actor_id uuid,
  p_output_text text,p_provider_request_id text,p_input_tokens bigint,p_output_tokens bigint)
RETURNS public.agent_product_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $function$
DECLARE v_row public.agent_product_runs;
BEGIN
  UPDATE public.agent_product_runs SET status='completed',output_text=p_output_text,
    provider_request_id=p_provider_request_id,input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    completed_at=clock_timestamp()
  WHERE workspace_id=p_workspace_id AND id=p_run_id AND status='pending'
    AND EXISTS(SELECT 1 FROM public.agent_product_conversations conversation
      WHERE conversation.workspace_id=p_workspace_id AND conversation.id=agent_product_runs.conversation_id
        AND conversation.actor_id=p_actor_id)
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'product Run terminal conflict' USING ERRCODE='40001'; END IF;
  RETURN v_row;
END;
$function$;

ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.publish_agent_draft(uuid,uuid,bigint,uuid) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.begin_agent_product_run(uuid,uuid,uuid,text) TO ba_runtime;
GRANT EXECUTE ON FUNCTION app.complete_agent_product_run(uuid,uuid,uuid,text,text,bigint,bigint) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
