-- one-use host-reviewed publication capability; raw publishers remain owner-only.

GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;
GRANT USAGE, CREATE ON SCHEMA auth TO ba_authorization_owner;

SET LOCAL ROLE ba_auth_owner;
GRANT EXECUTE ON FUNCTION auth.constant_time_equal_32(bytea, bytea)
  TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

CREATE TABLE auth.g1_source_publication_attestations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  bound_session_user name NOT NULL,
  published_resource_kind text NOT NULL CHECK (published_resource_kind IN (
    'AGENT_STRATEGY_RELEASE', 'INSTRUCTION_SKILL_RELEASE',
    'KNOWLEDGE_INDEX_GENERATION', 'DATABASE_OPERATION_RELEASE',
    'PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
  )),
  resource_id uuid NOT NULL,
  resource_version_id uuid NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_schema_version text NOT NULL,
  storage_sha256 bytea NOT NULL CHECK (octet_length(storage_sha256) = 32),
  verifier_hmac bytea NOT NULL CHECK (octet_length(verifier_hmac) = 32),
  reviewed_by text NOT NULL CHECK (length(btrim(reviewed_by)) > 0),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT g1_source_publication_attestations_expiry_check CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'
  ),
  CONSTRAINT g1_source_publication_attestations_consumption_check CHECK (
    (consumed_at IS NULL AND consumed_by IS NULL)
    OR (consumed_at IS NOT NULL AND length(btrim(consumed_by)) > 0)
  ),
  CONSTRAINT g1_source_publication_attestations_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND consumed_at IS NULL)
  ),
  CONSTRAINT g1_source_publication_attestations_identity_key UNIQUE (
    workspace_id, published_resource_kind, resource_id, resource_version_id,
    contract_hash, id
  )
);

ALTER TABLE auth.g1_source_publication_attestations OWNER TO ba_authorization_owner;
ALTER TABLE auth.g1_source_publication_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.g1_source_publication_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY g1_source_publication_attestations_capability_access
ON auth.g1_source_publication_attestations FOR ALL
USING (
  pg_catalog.pg_has_role(session_user, 'ba_management_attestation_issuer', 'MEMBER')
  OR (
    pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
    AND workspace_id = app.current_workspace_id()
  )
)
WITH CHECK (
  pg_catalog.pg_has_role(session_user, 'ba_management_attestation_issuer', 'MEMBER')
  OR (
    pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
    AND workspace_id = app.current_workspace_id()
  )
);

CREATE FUNCTION auth.enforce_g1_source_publication_attestation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'G1 source publication attestation is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF to_jsonb(NEW) - ARRAY['consumed_at','consumed_by','revoked_at','revoked_reason']::text[]
       IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['consumed_at','consumed_by','revoked_at','revoked_reason']::text[] THEN
    RAISE EXCEPTION 'G1 source publication attestation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.consumed_at IS NULL AND OLD.revoked_at IS NULL
     AND NEW.consumed_at IS NOT NULL AND NEW.consumed_by IS NOT NULL
     AND NEW.revoked_at IS NULL AND NEW.revoked_reason IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NULL AND OLD.revoked_at IS NULL
     AND NEW.consumed_at IS NULL AND NEW.consumed_by IS NULL
     AND NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'G1 source publication attestation permits only first consume or revoke'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER g1_source_publication_attestations_controlled_change
BEFORE UPDATE OR DELETE ON auth.g1_source_publication_attestations
FOR EACH ROW EXECUTE FUNCTION auth.enforce_g1_source_publication_attestation_change();

CREATE FUNCTION auth.issue_g1_source_publication_attestation(
  p_attestation_id uuid,
  p_workspace_id uuid,
  p_bound_session_user name,
  p_storage jsonb,
  p_verifier_hmac bytea,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_pin jsonb := p_storage -> 'full_pin';
BEGIN
  IF NOT pg_catalog.pg_has_role(
       session_user,
       'ba_management_attestation_issuer',
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER') THEN
    RAISE EXCEPTION 'G1 publication review requires an isolated management issuer login'
      USING ERRCODE = '42501';
  END IF;
  IF p_attestation_id IS NULL OR p_workspace_id IS NULL OR p_bound_session_user IS NULL
     OR p_storage IS NULL OR jsonb_typeof(p_storage) <> 'object'
     OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_storage) AS key)
       IS DISTINCT FROM ARRAY[
         'canonical_document','canonical_source_artifact','canonical_source_preimage',
         'dependency_manifest','full_pin','schema_version','source_schema_version'
       ]::text[]
     OR p_storage ->> 'schema_version'
       IS DISTINCT FROM 'prepared-g1-published-source-storage/1'
     OR jsonb_typeof(v_pin) <> 'object'
     OR v_pin ->> 'workspace_id' IS DISTINCT FROM p_workspace_id::text
     OR v_pin ->> 'binding_mode' IS DISTINCT FROM 'pinned'
     OR v_pin ->> 'published_resource_kind' NOT IN (
       'AGENT_STRATEGY_RELEASE', 'INSTRUCTION_SKILL_RELEASE',
       'KNOWLEDGE_INDEX_GENERATION', 'DATABASE_OPERATION_RELEASE',
       'PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE', 'SKILL_PACK_RELEASE'
     )
     OR v_pin ->> 'contract_hash' !~ '^sha256:[0-9a-f]{64}$'
     OR p_verifier_hmac IS NULL OR octet_length(p_verifier_hmac) <> 32
     OR p_expires_at IS NULL OR p_expires_at <= v_now
     OR p_expires_at > v_now + interval '15 minutes'
     OR NOT pg_catalog.pg_has_role(p_bound_session_user, 'ba_control_executor', 'MEMBER')
     OR pg_catalog.pg_has_role(
       p_bound_session_user,
       'ba_management_attestation_issuer',
       'MEMBER'
     ) THEN
    RAISE EXCEPTION 'invalid G1 source publication attestation input'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO auth.g1_source_publication_attestations (
    id, workspace_id, bound_session_user, published_resource_kind,
    resource_id, resource_version_id, contract_hash, source_schema_version,
    storage_sha256, verifier_hmac, reviewed_by, issued_at, expires_at
  ) VALUES (
    p_attestation_id, p_workspace_id, p_bound_session_user,
    v_pin ->> 'published_resource_kind', (v_pin ->> 'resource_id')::uuid,
    (v_pin ->> 'resource_version_id')::uuid, v_pin ->> 'contract_hash',
    p_storage ->> 'source_schema_version',
    public.digest(convert_to(p_storage::text, 'UTF8'), 'sha256'),
    p_verifier_hmac, 'management-reviewer:' || session_user::text, v_now, p_expires_at
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'G1 source publication attestation id already exists'
      USING ERRCODE = '23505';
END;
$function$;

CREATE FUNCTION auth.revoke_g1_source_publication_attestation(
  p_attestation_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, pg_temp
AS $function$
BEGIN
  IF NOT pg_catalog.pg_has_role(
       session_user,
       'ba_management_attestation_issuer',
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER') THEN
    RAISE EXCEPTION 'G1 publication revocation requires an isolated management issuer login'
      USING ERRCODE = '42501';
  END IF;
  IF p_attestation_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'G1 source publication revocation requires an id and reason'
      USING ERRCODE = '22023';
  END IF;
  UPDATE auth.g1_source_publication_attestations
     SET revoked_at = clock_timestamp(), revoked_reason = left(btrim(p_reason), 512)
   WHERE id = p_attestation_id AND consumed_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G1 source publication attestation is missing or unavailable'
      USING ERRCODE = '55000';
  END IF;
END;
$function$;

CREATE FUNCTION auth.consume_g1_source_publication_attestation(
  p_attestation_id uuid,
  p_presented_verifier bytea,
  p_storage jsonb,
  p_expected_kind text,
  p_expected_schema text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, app, pg_temp
AS $function$
DECLARE
  v_workspace_id uuid := auth.require_control_workspace();
  v_pin jsonb := p_storage -> 'full_pin';
  v_storage_sha256 bytea := public.digest(convert_to(p_storage::text, 'UTF8'), 'sha256');
  v_attestation auth.g1_source_publication_attestations%ROWTYPE;
  v_resource_version_id uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'ba_control_executor', 'MEMBER')
     OR pg_catalog.pg_has_role(
       session_user,
       'ba_management_attestation_issuer',
       'MEMBER'
     ) THEN
    RAISE EXCEPTION 'G1 publication requires an isolated control executor login'
      USING ERRCODE = '42501';
  END IF;
  IF p_attestation_id IS NULL OR p_presented_verifier IS NULL
     OR octet_length(p_presented_verifier) <> 32 OR p_storage IS NULL
     OR jsonb_typeof(p_storage) <> 'object' OR jsonb_typeof(v_pin) <> 'object' THEN
    RAISE EXCEPTION 'invalid G1 source publication proof input'
      USING ERRCODE = '22023';
  END IF;

  SELECT attestation.* INTO v_attestation
    FROM auth.g1_source_publication_attestations AS attestation
   WHERE attestation.id = p_attestation_id
   FOR UPDATE OF attestation;
  IF NOT FOUND
     OR v_attestation.workspace_id IS DISTINCT FROM v_workspace_id
     OR v_attestation.bound_session_user IS DISTINCT FROM session_user::name
     OR v_attestation.published_resource_kind IS DISTINCT FROM p_expected_kind
     OR v_attestation.source_schema_version IS DISTINCT FROM p_expected_schema
     OR v_attestation.resource_id::text IS DISTINCT FROM v_pin ->> 'resource_id'
     OR v_attestation.resource_version_id::text
       IS DISTINCT FROM v_pin ->> 'resource_version_id'
     OR v_attestation.contract_hash IS DISTINCT FROM v_pin ->> 'contract_hash'
     OR v_attestation.storage_sha256 IS DISTINCT FROM v_storage_sha256
     OR NOT auth.constant_time_equal_32(
       v_attestation.verifier_hmac,
       p_presented_verifier
     )
     OR v_attestation.consumed_at IS NOT NULL OR v_attestation.revoked_at IS NOT NULL
     OR v_attestation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'G1 source publication attestation is unavailable for this exact source'
      USING ERRCODE = '42501';
  END IF;

  v_resource_version_id := auth.register_prepared_g1_published_source(
    p_storage,
    p_expected_kind,
    p_expected_schema
  );
  UPDATE auth.g1_source_publication_attestations
     SET consumed_at = clock_timestamp(),
         consumed_by = app.current_authenticated_principal_id()
   WHERE id = p_attestation_id;
  RETURN v_resource_version_id;
END;
$function$;

CREATE FUNCTION app.publish_attested_agent_strategy_source(uuid, bytea, jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth, app, pg_temp
AS $$ SELECT auth.consume_g1_source_publication_attestation($1, $2, $3, 'AGENT_STRATEGY_RELEASE', 'agent-strategy-source/1') $$;
CREATE FUNCTION app.publish_attested_instruction_skill_release(uuid, bytea, jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth, app, pg_temp
AS $$ SELECT auth.consume_g1_source_publication_attestation($1, $2, $3, 'INSTRUCTION_SKILL_RELEASE', 'instruction-skill-source/1') $$;
CREATE FUNCTION app.publish_attested_knowledge_index_generation(uuid, bytea, jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth, app, pg_temp
AS $$ SELECT auth.consume_g1_source_publication_attestation($1, $2, $3, 'KNOWLEDGE_INDEX_GENERATION', 'knowledge-index-generation-source/1') $$;
CREATE FUNCTION app.publish_attested_database_operation_release(uuid, bytea, jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth, app, pg_temp
AS $$ SELECT auth.consume_g1_source_publication_attestation($1, $2, $3, 'DATABASE_OPERATION_RELEASE', 'database-operation-source/1') $$;
CREATE FUNCTION app.publish_attested_plugin_tool_release(uuid, bytea, jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth, app, pg_temp
AS $$ SELECT auth.consume_g1_source_publication_attestation($1, $2, $3, 'PLUGIN_TOOL_RELEASE', 'plugin-tool-source/1') $$;
CREATE FUNCTION app.publish_attested_a2a_agent_release(uuid, bytea, jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth, app, pg_temp
AS $$ SELECT auth.consume_g1_source_publication_attestation($1, $2, $3, 'A2A_AGENT_RELEASE', 'a2a-agent-source/1') $$;
CREATE FUNCTION app.publish_attested_skill_pack_release(uuid, bytea, jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, auth, app, pg_temp
AS $$ SELECT auth.consume_g1_source_publication_attestation($1, $2, $3, 'SKILL_PACK_RELEASE', 'skill-pack-source/1') $$;

REVOKE ALL ON TABLE auth.g1_source_publication_attestations FROM PUBLIC;
REVOKE ALL ON TABLE auth.g1_source_publication_attestations
  FROM ba_runtime, ba_control_executor, ba_management_attestation_issuer,
    ba_subject_assertion_verifier, ba_auth_owner;
REVOKE ALL ON FUNCTION auth.enforce_g1_source_publication_attestation_change(),
  auth.issue_g1_source_publication_attestation(uuid, uuid, name, jsonb, bytea, timestamptz),
  auth.revoke_g1_source_publication_attestation(uuid, text),
  auth.consume_g1_source_publication_attestation(uuid, bytea, jsonb, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  app.publish_attested_agent_strategy_source(uuid, bytea, jsonb),
  app.publish_attested_instruction_skill_release(uuid, bytea, jsonb),
  app.publish_attested_knowledge_index_generation(uuid, bytea, jsonb),
  app.publish_attested_database_operation_release(uuid, bytea, jsonb),
  app.publish_attested_plugin_tool_release(uuid, bytea, jsonb),
  app.publish_attested_a2a_agent_release(uuid, bytea, jsonb),
  app.publish_attested_skill_pack_release(uuid, bytea, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.issue_g1_source_publication_attestation(
  uuid, uuid, name, jsonb, bytea, timestamptz
) TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION auth.revoke_g1_source_publication_attestation(uuid, text)
  TO ba_management_attestation_issuer;
GRANT EXECUTE ON FUNCTION
  app.publish_attested_agent_strategy_source(uuid, bytea, jsonb),
  app.publish_attested_instruction_skill_release(uuid, bytea, jsonb),
  app.publish_attested_knowledge_index_generation(uuid, bytea, jsonb),
  app.publish_attested_database_operation_release(uuid, bytea, jsonb),
  app.publish_attested_plugin_tool_release(uuid, bytea, jsonb),
  app.publish_attested_a2a_agent_release(uuid, bytea, jsonb),
  app.publish_attested_skill_pack_release(uuid, bytea, jsonb)
TO ba_control_executor;

RESET ROLE;
REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
REVOKE CREATE ON SCHEMA auth FROM ba_authorization_owner;
