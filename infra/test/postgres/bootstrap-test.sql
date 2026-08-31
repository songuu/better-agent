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
CREATE ROLE ba_internal_issuer_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_internal_service_attestation_issuer;
CREATE ROLE ba_admission_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_admission_executor;
CREATE ROLE ba_execution_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_execution_executor;
CREATE ROLE ba_execution_other_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_execution_executor;
CREATE ROLE ba_metering_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_metering_executor;
CREATE ROLE ba_finalizer_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_finalizer_executor;
CREATE ROLE ba_reclaimer_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_reclaimer_executor;
CREATE ROLE ba_reconciliation_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_reconciliation_executor;
CREATE ROLE ba_archive_evidence_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_archive_evidence_executor;
CREATE ROLE ba_retention_executor_test
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  IN ROLE ba_retention_executor;
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

-- Every disposable phase login receives exactly one capability. The second
-- execution login is the adversarial same-phase/wrong-session_user fixture.
DO $g0_07_test_login_contract$
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
    RAISE EXCEPTION 'G0-07 phase roles must be NOLOGIN/NOINHERIT/NOBYPASSRLS';
  END IF;

  IF EXISTS (
    WITH expected_membership(login_name, role_name) AS (
      VALUES
        ('ba_internal_issuer_test'::name, 'ba_internal_service_attestation_issuer'::name),
        ('ba_admission_test'::name, 'ba_admission_executor'::name),
        ('ba_execution_test'::name, 'ba_execution_executor'::name),
        ('ba_execution_other_test'::name, 'ba_execution_executor'::name),
        ('ba_metering_test'::name, 'ba_metering_executor'::name),
        ('ba_finalizer_test'::name, 'ba_finalizer_executor'::name),
        ('ba_reclaimer_test'::name, 'ba_reclaimer_executor'::name),
        ('ba_reconciliation_test'::name, 'ba_reconciliation_executor'::name),
        ('ba_archive_evidence_test'::name, 'ba_archive_evidence_executor'::name),
        ('ba_retention_executor_test'::name, 'ba_retention_executor'::name)
    )
    SELECT 1
    FROM expected_membership AS expected
    LEFT JOIN pg_catalog.pg_roles AS login_role
      ON login_role.rolname = expected.login_name
    LEFT JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.rolname = expected.role_name
    LEFT JOIN pg_catalog.pg_auth_members AS membership
      ON membership.member = login_role.oid
     AND membership.roleid = granted_role.oid
     AND membership.inherit_option
    WHERE login_role.oid IS NULL
       OR NOT login_role.rolcanlogin
       OR granted_role.oid IS NULL
       OR membership.member IS NULL
    UNION ALL
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS login_role
      ON login_role.oid = membership.member
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    LEFT JOIN expected_membership AS expected
      ON expected.login_name = login_role.rolname
     AND expected.role_name = granted_role.rolname
    WHERE login_role.rolname = ANY (ARRAY[
      'ba_internal_issuer_test',
      'ba_admission_test',
      'ba_execution_test',
      'ba_execution_other_test',
      'ba_metering_test',
      'ba_finalizer_test',
      'ba_reclaimer_test',
      'ba_reconciliation_test',
      'ba_archive_evidence_test',
      'ba_retention_executor_test'
    ]::name[])
      AND expected.login_name IS NULL
  ) THEN
    RAISE EXCEPTION 'G0-07 test login membership graph is incomplete or has extra edges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS login_role
    WHERE login_role.rolname = ANY (ARRAY[
      'ba_internal_issuer_test',
      'ba_admission_test',
      'ba_execution_test',
      'ba_execution_other_test',
      'ba_metering_test',
      'ba_finalizer_test',
      'ba_reclaimer_test',
      'ba_reconciliation_test',
      'ba_archive_evidence_test',
      'ba_retention_executor_test'
    ]::name[])
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS forbidden_role
        WHERE forbidden_role.rolname = ANY (ARRAY[
          'ba_migrator',
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
          AND pg_catalog.pg_has_role(login_role.oid, forbidden_role.oid, 'MEMBER')
      )
  ) THEN
    RAISE EXCEPTION 'G0-07 test logins must not inherit legacy executable or owner roles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = ANY (ARRAY[
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
       OR (
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
    RAISE EXCEPTION 'G0-07 phase capabilities must not inherit through group roles';
  END IF;
END;
$g0_07_test_login_contract$;

REVOKE ALL ON DATABASE better_agent_test FROM PUBLIC;
GRANT CONNECT ON DATABASE better_agent_test TO
  ba_migrator,
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_plain_app_test;
GRANT CREATE, TEMPORARY ON DATABASE better_agent_test TO ba_migrator;
GRANT CONNECT ON DATABASE better_agent_test TO
  ba_internal_service_attestation_issuer,
  ba_admission_executor,
  ba_execution_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reclaimer_executor,
  ba_reconciliation_executor,
  ba_archive_evidence_executor,
  ba_retention_executor;

GRANT USAGE ON SCHEMA public TO
  ba_runtime,
  ba_control_executor,
  ba_management_attestation_issuer,
  ba_subject_assertion_verifier,
  ba_plain_app_test;
GRANT USAGE ON SCHEMA public TO
  ba_internal_service_attestation_issuer,
  ba_admission_executor,
  ba_execution_executor,
  ba_metering_executor,
  ba_finalizer_executor,
  ba_reclaimer_executor,
  ba_reconciliation_executor,
  ba_archive_evidence_executor,
  ba_retention_executor;
