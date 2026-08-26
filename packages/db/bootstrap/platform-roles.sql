-- Run once against the target database as a DBA before the application
-- migration runner. This script creates only the G0-04 role boundary; the
-- phase-specific G0-07 executor/attestation roles deliberately do not exist yet.

DO $platform_roles$
DECLARE
  v_role name;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'ba_migrator'::name,
    'ba_runtime'::name,
    'ba_control_executor'::name,
    'ba_management_attestation_issuer'::name,
    'ba_subject_assertion_verifier'::name,
    'ba_auth_owner'::name,
    'ba_authorization_owner'::name
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = v_role
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        v_role
      );
    END IF;
  END LOOP;
END;
$platform_roles$;

-- Group/owner roles never authenticate directly. ba_migrator remains an
-- inheriting NOLOGIN group so an explicitly enrolled deployment login can own
-- and update migration objects without becoming a superuser.
ALTER ROLE ba_migrator
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_control_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_management_attestation_issuer
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_subject_assertion_verifier
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_auth_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_authorization_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ba_migrator, ba_auth_owner, ba_authorization_owner FROM
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier;
REVOKE
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier
FROM ba_migrator, ba_auth_owner, ba_authorization_owner;
REVOKE ba_runtime FROM ba_subject_assertion_verifier;
REVOKE ba_subject_assertion_verifier FROM ba_runtime;
REVOKE ba_management_attestation_issuer FROM ba_control_executor;
REVOKE ba_control_executor FROM ba_management_attestation_issuer;

-- The deployment login is granted ba_migrator separately by the DBA. ADMIN
-- OPTION is intentionally held only by the isolated migrator group.
GRANT ba_auth_owner, ba_authorization_owner TO ba_migrator WITH ADMIN OPTION;

-- Both extensions are installed at the platform boundary because pgvector is
-- not assumed to be trusted-installable by the non-superuser migrator.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- SECURITY DEFINER functions schema-qualify persistent relations and place
-- pg_temp last, but untrusted CREATE in public is still independently denied.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- The migrator must create relations and temporarily pass CREATE to a NOLOGIN
-- relation owner during ALTER OWNER. Application/executable roles receive no
-- such capability, and each migration immediately revokes the temporary grant.
GRANT USAGE, CREATE ON SCHEMA public TO ba_migrator WITH GRANT OPTION;
