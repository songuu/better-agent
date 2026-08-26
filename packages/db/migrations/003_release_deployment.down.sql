-- G0-05 facts are security history. Schema rollback is allowed only while the
-- entire migration remains unused; normal product rollback is pointer CAS.

DO $g005_later_migration_guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM better_agent_migrations.schema_migrations
     WHERE version > 3
  ) THEN
    RAISE EXCEPTION 'cannot remove G0-05 while later migrations remain applied'
      USING ERRCODE = '55000';
  END IF;
END;
$g005_later_migration_guard$;

SET LOCAL ROLE ba_authorization_owner;

DO $g005_disable_force_for_fact_guard$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'published_resource_versions',
    'published_resource_dependencies',
    'publishable_resource_roots',
    'publishable_resource_draft_revisions',
    'agent_strategy_releases',
    'agent_releases',
    'flow_versions',
    'experience_releases',
    'published_resource_credential_requirements',
    'agent_release_public_capability_handles',
    'experience_release_quick_entries',
    'deployment_policy_versions',
    'agent_deployments',
    'agent_deployment_security_states',
    'agent_deployment_revisions',
    'agent_deployment_credential_mappings',
    'agent_deployment_active_pointers',
    'agent_deployment_entry_grants',
    'flow_deployments',
    'flow_deployment_security_states',
    'flow_deployment_revisions',
    'flow_deployment_credential_mappings',
    'flow_deployment_active_pointers',
    'flow_deployment_entry_grants',
    'deployment_promotion_audits',
    'browser_sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_table);
  END LOOP;
  ALTER TABLE public.authorization_cache_invalidations NO FORCE ROW LEVEL SECURITY;
END;
$g005_disable_force_for_fact_guard$;

DO $g005_public_fact_guard$
DECLARE
  v_table text;
  v_has_facts boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'published_resource_versions',
    'published_resource_dependencies',
    'publishable_resource_roots',
    'publishable_resource_draft_revisions',
    'agent_strategy_releases',
    'agent_releases',
    'flow_versions',
    'experience_releases',
    'published_resource_credential_requirements',
    'agent_release_public_capability_handles',
    'experience_release_quick_entries',
    'deployment_policy_versions',
    'agent_deployments',
    'agent_deployment_security_states',
    'agent_deployment_revisions',
    'agent_deployment_credential_mappings',
    'agent_deployment_active_pointers',
    'agent_deployment_entry_grants',
    'flow_deployments',
    'flow_deployment_security_states',
    'flow_deployment_revisions',
    'flow_deployment_credential_mappings',
    'flow_deployment_active_pointers',
    'flow_deployment_entry_grants',
    'deployment_promotion_audits',
    'browser_sessions'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', v_table)
      INTO v_has_facts;
    IF v_has_facts THEN
      RAISE EXCEPTION 'cannot remove G0-05: %.% contains durable facts', 'public', v_table
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.authorization_cache_invalidations
     WHERE source_kind IN (
       'agent_deployment',
       'flow_deployment',
       'agent_deployment_entry_grant',
       'flow_deployment_entry_grant',
       'browser_session'
     )
  ) THEN
    RAISE EXCEPTION 'cannot remove G0-05: authorization invalidation history exists'
      USING ERRCODE = '55000';
  END IF;
END;
$g005_public_fact_guard$;

RESET ROLE;
SET LOCAL ROLE ba_auth_owner;
ALTER TABLE auth.browser_session_auth_index NO FORCE ROW LEVEL SECURITY;
DO $g005_private_fact_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.browser_session_auth_index) THEN
    RAISE EXCEPTION 'cannot remove G0-05: private browser-session facts exist'
      USING ERRCODE = '55000';
  END IF;
END;
$g005_private_fact_guard$;

GRANT EXECUTE ON FUNCTION auth.consume_browser_subject_assertion(
  uuid, text, bytea, text, text, integer, bytea, timestamptz, timestamptz
) TO ba_subject_assertion_verifier;
DROP FUNCTION auth.authenticate_browser_session_facts(uuid, bytea, text, text, text);
DROP FUNCTION auth.revoke_browser_session(uuid, bigint);
DROP FUNCTION auth.exchange_browser_subject_assertion_for_session(
  uuid, bytea, text, text, text, text, timestamptz, uuid, text, bytea,
  text, integer, bytea, timestamptz, timestamptz
);
DROP TABLE auth.browser_session_auth_index;

RESET ROLE;
SET LOCAL ROLE ba_authorization_owner;

REVOKE EXECUTE ON FUNCTION app.current_api_credential_id()
  FROM ba_authorization_owner;
REVOKE EXECUTE ON FUNCTION auth.require_control_workspace() FROM ba_auth_owner;
REVOKE EXECUTE ON FUNCTION auth.record_authorization_epoch_change(
  uuid, text, uuid, text, bigint
) FROM ba_auth_owner;
REVOKE UPDATE (updated_at) ON TABLE public.workspaces FROM ba_auth_owner;
DROP POLICY end_user_principals_browser_session_auth_owner_lock
  ON public.end_user_principals;
DROP POLICY workspaces_browser_session_auth_owner_lock
  ON public.workspaces;
DROP POLICY end_user_principals_browser_session_auth_owner_read
  ON public.end_user_principals;
DROP POLICY workspaces_browser_session_auth_owner_read
  ON public.workspaces;

DROP FUNCTION app.resolve_flow_service_admission(text, text);
DROP FUNCTION app.resolve_agent_service_admission(text, text);
DROP FUNCTION app.transition_flow_deployment_security(uuid, bigint, text);
DROP FUNCTION app.transition_agent_deployment_security(uuid, bigint, text);
DROP FUNCTION app.promote_flow_deployment(uuid, uuid, bigint, text);
DROP FUNCTION app.promote_agent_deployment(uuid, uuid, bigint, text);
DROP FUNCTION app.revoke_flow_deployment_entry_grant(uuid, bigint);
DROP FUNCTION app.revoke_agent_deployment_entry_grant(uuid, bigint);
DROP FUNCTION app.create_flow_deployment_entry_grant(jsonb);
DROP FUNCTION app.create_agent_deployment_entry_grant(jsonb);
DROP FUNCTION app.publish_flow_deployment_revision(jsonb);
DROP FUNCTION app.publish_agent_deployment_revision(jsonb);
DROP FUNCTION app.create_flow_deployment(jsonb);
DROP FUNCTION app.create_agent_deployment(jsonb);
DROP FUNCTION app.publish_deployment_policy_version(uuid, uuid, text, text, text);
DROP FUNCTION app.publish_experience_release(jsonb);
DROP FUNCTION app.publish_flow_version(jsonb);
DROP FUNCTION app.publish_agent_release(jsonb);
DROP FUNCTION app.publish_agent_strategy_release(jsonb);
DROP FUNCTION app.append_publishable_resource_draft_revision(
  uuid, text, uuid, bigint, jsonb, text
);
DROP FUNCTION app.create_publishable_resource_root(text, uuid);
DROP FUNCTION auth.register_prepared_published_resource(jsonb, text, text, text);
DROP FUNCTION auth.require_release_draft(uuid, uuid, text, uuid);

DROP TABLE public.browser_sessions;
DROP TABLE public.deployment_promotion_audits;
DROP TABLE public.flow_deployment_entry_grants;
DROP TABLE public.flow_deployment_active_pointers;
DROP TABLE public.flow_deployment_credential_mappings;
DROP TABLE public.flow_deployment_revisions;
DROP TABLE public.flow_deployment_security_states;
DROP TABLE public.flow_deployments;
DROP TABLE public.agent_deployment_entry_grants;
DROP TABLE public.agent_deployment_active_pointers;
DROP TABLE public.agent_deployment_credential_mappings;
DROP TABLE public.agent_deployment_revisions;
DROP TABLE public.agent_deployment_security_states;
DROP TABLE public.agent_deployments;
DROP TABLE public.deployment_policy_versions;
DROP TABLE public.experience_release_quick_entries;
DROP TABLE public.agent_release_public_capability_handles;
DROP TABLE public.published_resource_credential_requirements;
DROP TABLE public.experience_releases;
DROP TABLE public.flow_versions;
DROP TABLE public.agent_releases;
DROP TABLE public.agent_strategy_releases;
DROP TABLE public.publishable_resource_draft_revisions;
DROP TABLE public.publishable_resource_roots;
DROP TABLE public.published_resource_dependencies;
DROP TABLE public.published_resource_versions;

DROP FUNCTION app.enforce_g005_mutable_fact_update();
DROP FUNCTION app.require_typed_published_resource_source();
DROP FUNCTION app.reject_immutable_release_fact_change();

ALTER TABLE public.authorization_cache_invalidations
  DROP CONSTRAINT authorization_cache_invalidations_source_kind_check;
ALTER TABLE public.authorization_cache_invalidations
  ADD CONSTRAINT authorization_cache_invalidations_source_kind_check
  CHECK (source_kind IN (
    'workspace',
    'credential',
    'permission_callback',
    'browser_subject_issuer',
    'end_user_principal'
  ));
ALTER TABLE public.authorization_cache_invalidations FORCE ROW LEVEL SECURITY;

RESET ROLE;
