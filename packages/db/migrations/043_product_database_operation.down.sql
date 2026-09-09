DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_database_operation_releases) THEN
    RAISE EXCEPTION 'cannot roll back migration 043: immutable Database Operation releases exist'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT CREATE ON SCHEMA public TO ba_authorization_owner;
SET LOCAL ROLE ba_authorization_owner;

DROP FUNCTION app.create_agent_draft_with_strategy_capabilities_v9(uuid,uuid,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint);
DROP FUNCTION app.update_agent_draft_with_strategy_capabilities_v9(uuid,uuid,bigint,text,text,text,text,uuid,uuid,text,jsonb,jsonb,uuid,uuid,uuid,bigint,uuid,bigint,uuid,bigint);
DROP FUNCTION app.read_agent_product_conversation_database(uuid,uuid,text,integer);

DROP FUNCTION app.list_agent_drafts_with_role_capabilities(uuid);
CREATE FUNCTION app.list_agent_drafts_with_role_capabilities(p_workspace_id uuid)
RETURNS TABLE(workspace_id uuid,id uuid,name text,description text,instructions text,model text,status text,
revision bigint,created_by uuid,created_at timestamptz,updated_at timestamptz,knowledge_base_id uuid,
database_table_id uuid,role_mode text,role_profile jsonb,strategy_profile jsonb,strategy_version bigint,
child_agent_id uuid,flow_id uuid,skill_pack_id uuid,skill_pack_release_version bigint,
mcp_server_id uuid,mcp_server_release_version bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
 SELECT d.workspace_id,d.id,d.name,d.description,d.instructions,d.model,d.status,d.revision,d.created_by,d.created_at,d.updated_at,
 k.knowledge_base_id,db.database_table_id,d.role_mode,d.role_profile,d.strategy_profile,d.strategy_version,s.target_agent_id,f.flow_id,
 sp.skill_pack_id,sp.skill_pack_release_version,m.mcp_server_id,m.mcp_server_release_version
 FROM public.agent_drafts d LEFT JOIN public.agent_product_knowledge_bindings k ON k.workspace_id=d.workspace_id AND k.agent_id=d.id
 LEFT JOIN public.agent_product_database_bindings db ON db.workspace_id=d.workspace_id AND db.agent_id=d.id
 LEFT JOIN public.agent_product_subagent_bindings s ON s.workspace_id=d.workspace_id AND s.agent_id=d.id
 LEFT JOIN public.agent_product_flow_bindings f ON f.workspace_id=d.workspace_id AND f.agent_id=d.id
 LEFT JOIN public.agent_product_skill_pack_bindings sp ON sp.workspace_id=d.workspace_id AND sp.agent_id=d.id
 LEFT JOIN public.agent_product_mcp_server_bindings m ON m.workspace_id=d.workspace_id AND m.agent_id=d.id
 WHERE d.workspace_id=p_workspace_id ORDER BY d.updated_at DESC,d.id LIMIT 200;
$function$;

CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_database()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_database_table_id uuid;
BEGIN
  SELECT binding.database_table_id INTO v_database_table_id
  FROM public.agent_product_database_bindings AS binding
  WHERE binding.workspace_id = NEW.workspace_id AND binding.agent_id = NEW.agent_id;
  IF v_database_table_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.agent_product_release_database_bindings (
    workspace_id, agent_id, release_version, database_table_id
  ) VALUES (NEW.workspace_id, NEW.agent_id, NEW.version, v_database_table_id);
  INSERT INTO public.agent_product_release_database_rows (
    workspace_id, agent_id, release_version, database_table_id, row_ordinal, row_version
  )
  SELECT NEW.workspace_id, NEW.agent_id, NEW.version, v_database_table_id,
    base.ordinal, coalesce(latest.version, 1)
  FROM public.product_database_rows AS base
  LEFT JOIN LATERAL (
    SELECT history.version, history.operation
    FROM public.product_database_row_versions AS history
    WHERE history.workspace_id=base.workspace_id AND history.table_id=base.table_id
      AND history.ordinal=base.ordinal ORDER BY history.version DESC LIMIT 1
  ) AS latest ON true
  WHERE base.workspace_id=NEW.workspace_id AND base.table_id=v_database_table_id
    AND coalesce(latest.operation,'update')<>'delete';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION app.read_agent_product_conversation_database(
  p_workspace_id uuid, p_conversation_id uuid, p_limit integer
) RETURNS TABLE (table_name text, columns jsonb, row_ordinal integer, record jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Agent Database read limit is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT source.name, source.columns, release_row.row_ordinal,
    CASE WHEN release_row.row_version = 1 THEN base.record ELSE pinned.record END
  FROM public.agent_product_conversations AS conversation
  JOIN public.agent_product_release_database_rows AS release_row
    ON release_row.workspace_id=conversation.workspace_id AND release_row.agent_id=conversation.agent_id
   AND release_row.release_version=conversation.release_version
  JOIN public.product_database_tables AS source
    ON source.workspace_id=release_row.workspace_id AND source.id=release_row.database_table_id
  JOIN public.product_database_rows AS base
    ON base.workspace_id=release_row.workspace_id AND base.table_id=release_row.database_table_id
   AND base.ordinal=release_row.row_ordinal
  LEFT JOIN public.product_database_row_versions AS pinned
    ON pinned.workspace_id=release_row.workspace_id AND pinned.table_id=release_row.database_table_id
   AND pinned.ordinal=release_row.row_ordinal AND pinned.version=release_row.row_version
  WHERE conversation.workspace_id=p_workspace_id AND conversation.id=p_conversation_id
    AND (release_row.row_version=1 OR pinned.operation='update')
  ORDER BY release_row.row_ordinal LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION app.assert_product_flow_resources_pinned(
  p_workspace_id uuid, p_graph jsonb
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  PERFORM app.assert_product_flow_plugins_installed(p_workspace_id, p_graph);
  PERFORM app.assert_product_flow_apis_pinned(p_workspace_id, p_graph);
END;
$function$;

ALTER TABLE public.agent_product_release_database_bindings
  DROP CONSTRAINT agent_product_release_database_operation_release_fk,
  DROP CONSTRAINT agent_product_release_database_operation_pair,
  DROP COLUMN operation_revision,
  DROP COLUMN operation_id;
ALTER TABLE public.agent_product_database_bindings
  DROP CONSTRAINT agent_product_database_operation_release_fk,
  DROP CONSTRAINT agent_product_database_operation_pair,
  DROP COLUMN operation_revision,
  DROP COLUMN operation_id;

DROP FUNCTION app.assert_product_flow_database_operations_pinned(uuid,jsonb);
DROP FUNCTION app.execute_product_database_operation(uuid,uuid,bigint,text);
DROP FUNCTION app.update_product_database_operation(uuid,uuid,bigint,uuid,uuid,text,text,jsonb,text,text,text,integer);
DROP FUNCTION app.create_product_database_operation(uuid,uuid,uuid,text,text,jsonb,text,text,text,integer);
DROP FUNCTION app.list_product_database_operations(uuid);
DROP FUNCTION app.assert_product_database_operation_policy(uuid,uuid,jsonb,text,text,integer);
DROP TABLE public.product_database_operation_releases;
DROP TABLE public.product_database_operations;

ALTER FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.snapshot_agent_product_release_database() OWNER TO ba_authorization_owner;
ALTER FUNCTION app.read_agent_product_conversation_database(uuid,uuid,integer) OWNER TO ba_authorization_owner;
ALTER FUNCTION app.assert_product_flow_resources_pinned(uuid,jsonb) OWNER TO ba_authorization_owner;
REVOKE ALL ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_agent_drafts_with_role_capabilities(uuid) TO ba_runtime;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA public FROM ba_authorization_owner;
