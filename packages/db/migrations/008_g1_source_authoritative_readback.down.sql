GRANT USAGE, CREATE ON SCHEMA app TO ba_authorization_owner;

SET LOCAL ROLE ba_authorization_owner;

REVOKE ALL ON FUNCTION app.resolve_g1_published_source(jsonb),
  app.resolve_registered_dependency_pins(jsonb) FROM PUBLIC, ba_runtime,
  ba_control_executor, ba_management_attestation_issuer,
  ba_subject_assertion_verifier, ba_auth_owner;
DROP FUNCTION app.resolve_g1_published_source(jsonb);
DROP FUNCTION app.resolve_registered_dependency_pins(jsonb);

RESET ROLE;

REVOKE CREATE ON SCHEMA app FROM ba_authorization_owner;
