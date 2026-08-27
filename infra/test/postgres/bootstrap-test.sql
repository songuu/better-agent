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

-- Fail container bootstrap before migrations if the G0-06 owner boundary
-- drifts. Owner roles never get test logins; the enrolled migrator exercises
-- owner-only fixtures through its audited ADMIN OPTION membership.
DO $g0_06_owner_contract$
DECLARE
  v_owner_count integer;
  v_admin_membership_count integer;
BEGIN
  SELECT count(*)
  INTO v_owner_count
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.rolname = ANY (ARRAY[
    'ba_auth_owner',
    'ba_authorization_owner',
    'ba_run_owner',
    'ba_billing_owner',
    'ba_archive_evidence_owner',
    'ba_retention'
  ]::name[])
    AND NOT role_row.rolcanlogin
    AND NOT role_row.rolinherit
    AND NOT role_row.rolsuper
    AND NOT role_row.rolcreatedb
    AND NOT role_row.rolcreaterole
    AND NOT role_row.rolreplication
    AND NOT role_row.rolbypassrls;

  IF v_owner_count <> 6 THEN
    RAISE EXCEPTION 'G0-06 owner roles must be NOLOGIN/NOINHERIT/NOBYPASSRLS';
  END IF;

  SELECT count(*)
  INTO v_admin_membership_count
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS granted_role
    ON granted_role.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member_role
    ON member_role.oid = membership.member
  WHERE granted_role.rolname = ANY (ARRAY[
    'ba_auth_owner',
    'ba_authorization_owner',
    'ba_run_owner',
    'ba_billing_owner',
    'ba_archive_evidence_owner',
    'ba_retention'
  ]::name[])
    AND member_role.rolname = 'ba_migrator'
    AND membership.admin_option;

  IF v_admin_membership_count <> 6 THEN
    RAISE EXCEPTION 'ba_migrator must hold ADMIN OPTION for every G0-06 owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE granted_role.rolname = ANY (ARRAY[
      'ba_auth_owner',
      'ba_authorization_owner',
      'ba_run_owner',
      'ba_billing_owner',
      'ba_archive_evidence_owner',
      'ba_retention'
    ]::name[])
      AND member_role.rolname <> 'ba_migrator'
  ) THEN
    RAISE EXCEPTION 'ba_migrator must be the only direct G0-06 owner member';
  END IF;

  IF EXISTS (
    SELECT 1
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
          'ba_subject_assertion_verifier'
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
      )
  ) THEN
    RAISE EXCEPTION 'non-super LOGIN cannot inherit executable and G0-06 owner capabilities';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE (
      granted_role.rolname = ANY (ARRAY[
        'ba_auth_owner',
        'ba_authorization_owner',
        'ba_run_owner',
        'ba_billing_owner',
        'ba_archive_evidence_owner',
        'ba_retention'
      ]::name[])
      AND member_role.rolname = ANY (ARRAY[
        'ba_runtime',
        'ba_control_executor',
        'ba_management_attestation_issuer',
        'ba_subject_assertion_verifier',
        'ba_auth_owner',
        'ba_authorization_owner',
        'ba_run_owner',
        'ba_billing_owner',
        'ba_archive_evidence_owner',
        'ba_retention'
      ]::name[])
      AND granted_role.rolname <> member_role.rolname
    ) OR (
      member_role.rolname = ANY (ARRAY[
        'ba_auth_owner',
        'ba_authorization_owner',
        'ba_run_owner',
        'ba_billing_owner',
        'ba_archive_evidence_owner',
        'ba_retention'
      ]::name[])
      AND granted_role.rolname = ANY (ARRAY[
        'ba_runtime',
        'ba_control_executor',
        'ba_management_attestation_issuer',
        'ba_subject_assertion_verifier',
        'ba_auth_owner',
        'ba_authorization_owner'
      ]::name[])
    )
  ) THEN
    RAISE EXCEPTION 'G0-06 owners must not inherit executable or peer owner roles';
  END IF;
END;
$g0_06_owner_contract$;

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
