-- Platform roles/extensions are provisioned by bootstrap/platform-roles.sql as
-- a DBA. Application migrations must run as an explicitly enrolled,
-- non-superuser migrator and fail before creating tenant objects if that trust
-- boundary is incomplete.
DO $platform_prerequisites$
DECLARE
  v_missing_roles text;
  v_unsafe_roles text;
  v_session_is_unsafe boolean;
BEGIN
  SELECT pg_catalog.string_agg(required.role_name, ', ' ORDER BY required.role_name)
    INTO v_missing_roles
    FROM (
      VALUES
        ('ba_migrator'),
        ('ba_runtime'),
        ('ba_control_executor'),
        ('ba_management_attestation_issuer'),
        ('ba_subject_assertion_verifier'),
        ('ba_auth_owner'),
        ('ba_authorization_owner')
    ) AS required(role_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = required.role_name
   );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'missing required platform roles: %', v_missing_roles
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.string_agg(role_row.rolname, ', ' ORDER BY role_row.rolname)
    INTO v_unsafe_roles
    FROM pg_catalog.pg_roles AS role_row
   WHERE role_row.rolname = ANY (ARRAY[
     'ba_migrator',
     'ba_runtime',
     'ba_control_executor',
     'ba_management_attestation_issuer',
     'ba_subject_assertion_verifier',
     'ba_auth_owner',
     'ba_authorization_owner'
   ])
     AND (
       role_row.rolcanlogin
       OR role_row.rolsuper
       OR role_row.rolcreatedb
       OR role_row.rolcreaterole
       OR role_row.rolreplication
       OR role_row.rolbypassrls
     );

  IF v_unsafe_roles IS NOT NULL THEN
    RAISE EXCEPTION 'platform roles must be NOLOGIN and unprivileged: %', v_unsafe_roles
      USING ERRCODE = '55000';
  END IF;

  SELECT (
    role_row.rolsuper
    OR role_row.rolcreatedb
    OR role_row.rolcreaterole
    OR role_row.rolreplication
    OR role_row.rolbypassrls
  )
    INTO v_session_is_unsafe
    FROM pg_catalog.pg_roles AS role_row
   WHERE role_row.rolname = session_user;

  IF COALESCE(v_session_is_unsafe, true) THEN
    RAISE EXCEPTION 'application migrations require an unprivileged, non-BYPASSRLS session_user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT pg_catalog.pg_has_role(session_user, 'ba_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'session_user must be an explicitly enrolled ba_migrator member'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role
        ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
     WHERE member_role.rolname = 'ba_migrator'
       AND granted_role.rolname = 'ba_auth_owner'
       AND membership.admin_option
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role
        ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
     WHERE member_role.rolname = 'ba_migrator'
       AND granted_role.rolname = 'ba_authorization_owner'
       AND membership.admin_option
  ) THEN
    RAISE EXCEPTION 'ba_migrator requires ADMIN OPTION on both NOLOGIN owner roles'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS executable_role
      CROSS JOIN pg_catalog.pg_roles AS owner_role
     WHERE pg_catalog.pg_has_role(
       executable_role.oid,
       owner_role.oid,
       'MEMBER'
     )
       AND executable_role.rolname IN (
         'ba_runtime',
         'ba_control_executor',
         'ba_management_attestation_issuer',
         'ba_subject_assertion_verifier'
       )
       AND owner_role.rolname IN ('ba_auth_owner', 'ba_authorization_owner')
  ) THEN
    RAISE EXCEPTION 'executable G0-04 roles must not directly or indirectly inherit owner roles'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
     FROM pg_catalog.pg_roles AS login_role
     WHERE login_role.rolcanlogin
       AND NOT login_role.rolsuper
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_roles AS executable_role
          WHERE pg_catalog.pg_has_role(
            login_role.oid,
            executable_role.oid,
            'MEMBER'
          )
            AND executable_role.rolname IN (
              'ba_runtime',
              'ba_control_executor',
              'ba_management_attestation_issuer',
              'ba_subject_assertion_verifier'
            )
       )
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_roles AS privileged_role
          WHERE pg_catalog.pg_has_role(
            login_role.oid,
            privileged_role.oid,
            'MEMBER'
          )
            AND privileged_role.rolname IN (
              'ba_migrator',
              'ba_auth_owner',
              'ba_authorization_owner'
            )
       )
  ) THEN
    RAISE EXCEPTION 'executable and migration/owner capabilities must use separate login roles'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
     FROM pg_catalog.pg_roles AS login_role
     WHERE login_role.rolcanlogin
       AND NOT login_role.rolsuper
       AND pg_catalog.pg_has_role(login_role.oid, 'ba_runtime', 'MEMBER')
       AND pg_catalog.pg_has_role(
         login_role.oid,
         'ba_subject_assertion_verifier',
         'MEMBER'
       )
  ) THEN
    RAISE EXCEPTION 'runtime and subject assertion verifier must use separate login roles'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
     FROM pg_catalog.pg_roles AS login_role
     WHERE login_role.rolcanlogin
       AND NOT login_role.rolsuper
       AND pg_catalog.pg_has_role(
         login_role.oid,
         'ba_management_attestation_issuer',
         'MEMBER'
       )
       AND pg_catalog.pg_has_role(
         login_role.oid,
         'ba_control_executor',
         'MEMBER'
       )
  ) THEN
    RAISE EXCEPTION 'management attestation issuer and control executor must use separate login roles'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'
  ) THEN
    RAISE EXCEPTION 'vector and pgcrypto must be installed by the platform bootstrap'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_namespace AS namespace_row,
           LATERAL pg_catalog.aclexplode(
             COALESCE(
               namespace_row.nspacl,
               pg_catalog.acldefault('n', namespace_row.nspowner)
             )
           ) AS acl_row
     WHERE namespace_row.nspname = 'public'
       AND acl_row.grantee = 0
       AND acl_row.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION 'CREATE on schema public must be revoked from PUBLIC'
      USING ERRCODE = '42501';
  END IF;

  IF NOT pg_catalog.has_schema_privilege('ba_migrator', 'public', 'USAGE')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_namespace AS namespace_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(namespace_row.nspacl) AS acl_row
         JOIN pg_catalog.pg_roles AS grantee_role
           ON grantee_role.oid = acl_row.grantee
        WHERE namespace_row.nspname = 'public'
          AND grantee_role.rolname = 'ba_migrator'
          AND acl_row.privilege_type = 'CREATE'
          AND acl_row.is_grantable
     ) THEN
    RAISE EXCEPTION 'ba_migrator requires USAGE and grantable CREATE on schema public'
      USING ERRCODE = '42501';
  END IF;
END;
$platform_prerequisites$;

-- There is intentionally no 000 down migration. Dropping platform extensions
-- or role boundaries can invalidate later data and SECURITY DEFINER assumptions.
