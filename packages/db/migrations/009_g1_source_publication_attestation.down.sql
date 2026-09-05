DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.g1_source_publication_attestations) THEN
    RAISE EXCEPTION 'G1 source publication attestations exist; downgrade rejected'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

REVOKE EXECUTE ON FUNCTION
  app.publish_attested_agent_strategy_source(uuid, bytea, jsonb),
  app.publish_attested_instruction_skill_release(uuid, bytea, jsonb),
  app.publish_attested_knowledge_index_generation(uuid, bytea, jsonb),
  app.publish_attested_database_operation_release(uuid, bytea, jsonb),
  app.publish_attested_plugin_tool_release(uuid, bytea, jsonb),
  app.publish_attested_a2a_agent_release(uuid, bytea, jsonb),
  app.publish_attested_skill_pack_release(uuid, bytea, jsonb)
FROM ba_control_executor;
REVOKE EXECUTE ON FUNCTION auth.issue_g1_source_publication_attestation(
  uuid, uuid, name, jsonb, bytea, timestamptz
) FROM ba_management_attestation_issuer;
REVOKE EXECUTE ON FUNCTION auth.revoke_g1_source_publication_attestation(uuid, text)
FROM ba_management_attestation_issuer;

DROP FUNCTION app.publish_attested_skill_pack_release(uuid, bytea, jsonb);
DROP FUNCTION app.publish_attested_a2a_agent_release(uuid, bytea, jsonb);
DROP FUNCTION app.publish_attested_plugin_tool_release(uuid, bytea, jsonb);
DROP FUNCTION app.publish_attested_database_operation_release(uuid, bytea, jsonb);
DROP FUNCTION app.publish_attested_knowledge_index_generation(uuid, bytea, jsonb);
DROP FUNCTION app.publish_attested_instruction_skill_release(uuid, bytea, jsonb);
DROP FUNCTION app.publish_attested_agent_strategy_source(uuid, bytea, jsonb);
DROP FUNCTION auth.consume_g1_source_publication_attestation(uuid, bytea, jsonb, text, text);
DROP FUNCTION auth.revoke_g1_source_publication_attestation(uuid, text);
DROP FUNCTION auth.issue_g1_source_publication_attestation(
  uuid, uuid, name, jsonb, bytea, timestamptz
);
DROP TRIGGER g1_source_publication_attestations_controlled_change
  ON auth.g1_source_publication_attestations;
DROP FUNCTION auth.enforce_g1_source_publication_attestation_change();
DROP POLICY g1_source_publication_attestations_capability_access
  ON auth.g1_source_publication_attestations;
DROP TABLE auth.g1_source_publication_attestations;

SET LOCAL ROLE ba_auth_owner;
REVOKE EXECUTE ON FUNCTION auth.constant_time_equal_32(bytea, bytea)
  FROM ba_authorization_owner;
RESET ROLE;
