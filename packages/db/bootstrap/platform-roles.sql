-- Run once against the target database as a DBA before the application
-- migration runner. This script creates the G0-04/G0-06 owner boundary and the
-- G0-07 internal-service issuer/phase capability roles. LOGIN enrollment remains
-- an explicit DBA/deployment responsibility.

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
    'ba_authorization_owner'::name,
    'ba_run_owner'::name,
    'ba_billing_owner'::name,
    'ba_archive_evidence_owner'::name,
    'ba_retention'::name,
    'ba_internal_service_attestation_issuer'::name,
    'ba_admission_executor'::name,
    'ba_execution_executor'::name,
    'ba_metering_executor'::name,
    'ba_finalizer_executor'::name,
    'ba_reclaimer_executor'::name,
    'ba_reconciliation_executor'::name,
    'ba_archive_evidence_executor'::name,
    'ba_retention_executor'::name
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
ALTER ROLE ba_run_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_billing_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_archive_evidence_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_retention
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_internal_service_attestation_issuer
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_admission_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_execution_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_metering_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_finalizer_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_reclaimer_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_reconciliation_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_archive_evidence_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE ba_retention_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- Normalize only platform-role edges. Direct LOGIN enrollment into exactly one
-- capability role is intentionally preserved; aggregating phase roles through a
-- NOLOGIN group would make the signed session_user/phase binding ambiguous.
DO $g0_07_phase_membership_reset$
DECLARE
  v_granted_role name;
  v_member_role name;
BEGIN
  FOREACH v_granted_role IN ARRAY ARRAY[
    'ba_internal_service_attestation_issuer'::name,
    'ba_admission_executor'::name,
    'ba_execution_executor'::name,
    'ba_metering_executor'::name,
    'ba_finalizer_executor'::name,
    'ba_reclaimer_executor'::name,
    'ba_reconciliation_executor'::name,
    'ba_archive_evidence_executor'::name,
    'ba_retention_executor'::name
  ] LOOP
    FOREACH v_member_role IN ARRAY ARRAY[
      'ba_migrator'::name,
      'ba_runtime'::name,
      'ba_control_executor'::name,
      'ba_management_attestation_issuer'::name,
      'ba_subject_assertion_verifier'::name,
      'ba_auth_owner'::name,
      'ba_authorization_owner'::name,
      'ba_run_owner'::name,
      'ba_billing_owner'::name,
      'ba_archive_evidence_owner'::name,
      'ba_retention'::name,
      'ba_internal_service_attestation_issuer'::name,
      'ba_admission_executor'::name,
      'ba_execution_executor'::name,
      'ba_metering_executor'::name,
      'ba_finalizer_executor'::name,
      'ba_reclaimer_executor'::name,
      'ba_reconciliation_executor'::name,
      'ba_archive_evidence_executor'::name,
      'ba_retention_executor'::name
    ] LOOP
      IF v_granted_role <> v_member_role
         AND EXISTS (
           SELECT 1
           FROM pg_catalog.pg_auth_members AS membership
           JOIN pg_catalog.pg_roles AS granted_role
             ON granted_role.oid = membership.roleid
           JOIN pg_catalog.pg_roles AS member_role
             ON member_role.oid = membership.member
           WHERE granted_role.rolname = v_granted_role
             AND member_role.rolname = v_member_role
         ) THEN
        EXECUTE pg_catalog.format('REVOKE %I FROM %I', v_granted_role, v_member_role);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_granted_role IN ARRAY ARRAY[
    'ba_migrator'::name,
    'ba_runtime'::name,
    'ba_control_executor'::name,
    'ba_management_attestation_issuer'::name,
    'ba_subject_assertion_verifier'::name,
    'ba_auth_owner'::name,
    'ba_authorization_owner'::name,
    'ba_run_owner'::name,
    'ba_billing_owner'::name,
    'ba_archive_evidence_owner'::name,
    'ba_retention'::name
  ] LOOP
    FOREACH v_member_role IN ARRAY ARRAY[
      'ba_internal_service_attestation_issuer'::name,
      'ba_admission_executor'::name,
      'ba_execution_executor'::name,
      'ba_metering_executor'::name,
      'ba_finalizer_executor'::name,
      'ba_reclaimer_executor'::name,
      'ba_reconciliation_executor'::name,
      'ba_archive_evidence_executor'::name,
      'ba_retention_executor'::name
    ] LOOP
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS granted_role
          ON granted_role.oid = membership.roleid
        JOIN pg_catalog.pg_roles AS member_role
          ON member_role.oid = membership.member
        WHERE granted_role.rolname = v_granted_role
          AND member_role.rolname = v_member_role
      ) THEN
        EXECUTE pg_catalog.format('REVOKE %I FROM %I', v_granted_role, v_member_role);
      END IF;
    END LOOP;
  END LOOP;
END;
$g0_07_phase_membership_reset$;

REVOKE
  ba_migrator,
  ba_auth_owner,
  ba_authorization_owner,
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention
FROM
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_internal_service_attestation_issuer,
  ba_admission_executor,
  ba_execution_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reclaimer_executor,
  ba_reconciliation_executor,
  ba_archive_evidence_executor,
  ba_retention_executor;
REVOKE
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_internal_service_attestation_issuer,
  ba_admission_executor,
  ba_execution_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reclaimer_executor,
  ba_reconciliation_executor,
  ba_archive_evidence_executor,
  ba_retention_executor
FROM
  ba_migrator,
  ba_auth_owner,
  ba_authorization_owner,
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE ba_migrator FROM
  ba_auth_owner,
  ba_authorization_owner,
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE ba_auth_owner, ba_authorization_owner FROM
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention
FROM ba_auth_owner, ba_authorization_owner;
REVOKE ba_run_owner FROM
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE ba_billing_owner FROM
  ba_run_owner,
  ba_archive_evidence_owner,
  ba_retention;
REVOKE ba_archive_evidence_owner FROM
  ba_run_owner,
  ba_billing_owner,
  ba_retention;
REVOKE ba_retention FROM
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner;
REVOKE ba_runtime FROM ba_subject_assertion_verifier;
REVOKE ba_subject_assertion_verifier FROM ba_runtime;
REVOKE ba_management_attestation_issuer FROM ba_control_executor;
REVOKE ba_control_executor FROM ba_management_attestation_issuer;

-- The deployment login is granted ba_migrator separately by the DBA. ADMIN
-- OPTION is intentionally held only by the isolated migrator group.
GRANT
  ba_auth_owner,
  ba_authorization_owner,
  ba_run_owner,
  ba_billing_owner,
  ba_archive_evidence_owner,
  ba_retention
TO ba_migrator WITH ADMIN OPTION;

-- Owner membership is a capability boundary, not an operational convenience.
-- A LOGIN that also inherits an executable role could otherwise authenticate a
-- tenant context and then exercise owner-only facts directly. Keep the direct
-- member graph exact and reject transitive executable/owner overlap on reruns.
DO $g0_06_owner_membership_contract$
DECLARE
  v_unexpected_members text;
  v_overlapping_logins text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I->%I', member_role.rolname, owner_role.rolname),
    ', ' ORDER BY member_role.rolname, owner_role.rolname
  )
  INTO v_unexpected_members
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member_role
    ON member_role.oid = membership.member
  WHERE owner_role.rolname = ANY (ARRAY[
    'ba_auth_owner',
    'ba_authorization_owner',
    'ba_run_owner',
    'ba_billing_owner',
    'ba_archive_evidence_owner',
    'ba_retention'
  ]::name[])
    AND member_role.rolname <> 'ba_migrator';

  IF v_unexpected_members IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected G0-06 owner membership: %', v_unexpected_members
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.string_agg(login_role.rolname, ', ' ORDER BY login_role.rolname)
  INTO v_overlapping_logins
  FROM pg_catalog.pg_roles AS login_role
  WHERE login_role.rolcanlogin
    AND NOT login_role.rolsuper
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS executable_role
      WHERE executable_role.rolname = ANY (ARRAY[
        'ba_runtime',
        'ba_control_executor',
        'ba_management_attestation_issuer',
        'ba_subject_assertion_verifier',
        'ba_internal_service_attestation_issuer',
        'ba_admission_executor',
        'ba_execution_executor',
        'ba_metering_executor',
        'ba_finalizer_executor',
        'ba_reclaimer_executor',
        'ba_reconciliation_executor',
        'ba_archive_evidence_executor',
        'ba_retention_executor'
      ]::name[])
        AND pg_catalog.pg_has_role(login_role.oid, executable_role.oid, 'MEMBER')
    )
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS owner_role
      WHERE owner_role.rolname = ANY (ARRAY[
        'ba_auth_owner',
        'ba_authorization_owner',
        'ba_run_owner',
        'ba_billing_owner',
        'ba_archive_evidence_owner',
        'ba_retention'
      ]::name[])
        AND pg_catalog.pg_has_role(login_role.oid, owner_role.oid, 'MEMBER')
    );

  IF v_overlapping_logins IS NOT NULL THEN
    RAISE EXCEPTION
      'non-super LOGIN inherits executable and G0-06 owner capabilities: %',
      v_overlapping_logins USING ERRCODE = '42501';
  END IF;
END;
$g0_06_owner_membership_contract$;

DO $g0_07_phase_role_contract$
DECLARE
  v_phase_role_count integer;
BEGIN
  SELECT count(*)
  INTO v_phase_role_count
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.rolname = ANY (ARRAY[
    'ba_internal_service_attestation_issuer',
    'ba_admission_executor',
    'ba_execution_executor',
    'ba_metering_executor',
    'ba_finalizer_executor',
    'ba_reclaimer_executor',
    'ba_reconciliation_executor',
    'ba_archive_evidence_executor',
    'ba_retention_executor'
  ]::name[])
    AND NOT role_row.rolcanlogin
    AND NOT role_row.rolinherit
    AND NOT role_row.rolsuper
    AND NOT role_row.rolcreatedb
    AND NOT role_row.rolcreaterole
    AND NOT role_row.rolreplication
    AND NOT role_row.rolbypassrls;

  IF v_phase_role_count <> 9 THEN
    RAISE EXCEPTION 'G0-07 phase roles must be NOLOGIN/NOINHERIT/NOBYPASSRLS'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE (
      member_role.rolname = ANY (ARRAY[
        'ba_internal_service_attestation_issuer',
        'ba_admission_executor',
        'ba_execution_executor',
        'ba_metering_executor',
        'ba_finalizer_executor',
        'ba_reclaimer_executor',
        'ba_reconciliation_executor',
        'ba_archive_evidence_executor',
        'ba_retention_executor'
      ]::name[])
    ) OR (
      granted_role.rolname = ANY (ARRAY[
        'ba_internal_service_attestation_issuer',
        'ba_admission_executor',
        'ba_execution_executor',
        'ba_metering_executor',
        'ba_finalizer_executor',
        'ba_reclaimer_executor',
        'ba_reconciliation_executor',
        'ba_archive_evidence_executor',
        'ba_retention_executor'
      ]::name[])
      AND NOT member_role.rolcanlogin
    )
  ) THEN
    RAISE EXCEPTION 'G0-07 phase roles must not inherit legacy or peer capabilities'
      USING ERRCODE = '42501';
  END IF;
END;
$g0_07_phase_role_contract$;

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
