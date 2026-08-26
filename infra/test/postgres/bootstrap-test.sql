-- Test-only login enrollment. Production credentials and login provisioning are
-- deployment responsibilities and must not copy these role names verbatim.

CREATE ROLE ba_migrator_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_migrator;
CREATE ROLE ba_runtime_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_runtime;
CREATE ROLE ba_runtime_other_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_runtime;
CREATE ROLE ba_control_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_control_executor;
CREATE ROLE ba_control_other_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_control_executor;
CREATE ROLE ba_management_issuer_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_management_attestation_issuer;
CREATE ROLE ba_assertion_verifier_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_subject_assertion_verifier;
CREATE ROLE ba_plain_app_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON DATABASE better_agent_test FROM PUBLIC;
GRANT CONNECT ON DATABASE better_agent_test TO
  ba_migrator,
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_plain_app_test;
GRANT CREATE, TEMPORARY ON DATABASE better_agent_test TO ba_migrator;

GRANT USAGE ON SCHEMA public TO
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_plain_app_test;
