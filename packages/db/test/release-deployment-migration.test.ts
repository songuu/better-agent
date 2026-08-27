import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMigrations, renderDownMigrationSql, renderUpMigrationSql } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('003 release and Deployment migration inventory', () => {
  it('adds one reviewed up/down migration with the closed G0-05 fact families', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const migration = migrations.find(({ id }) => id === '003');

    expect(migration).toMatchObject({ id: '003', name: 'release_deployment' });
    expect(migration?.downSql).toBeDefined();
    expect(migration?.downSql).toMatch(/ERRCODE\s*=\s*'55000'/u);
    expect(renderUpMigrationSql(migrations)).toContain('\\if :ba_apply_003');
    expect(renderDownMigrationSql(migrations, 2, { allowDown: true })).toContain(
      '\\if :ba_revert_003',
    );
    for (const objectName of [
      'published_resource_versions',
      'published_resource_dependencies',
      'agent_strategy_releases',
      'agent_releases',
      'flow_versions',
      'experience_releases',
      'deployment_policy_versions',
      'agent_deployments',
      'agent_deployment_revisions',
      'agent_deployment_entry_grants',
      'flow_deployments',
      'flow_deployment_revisions',
      'flow_deployment_entry_grants',
      'browser_sessions',
      'browser_session_auth_index',
    ]) {
      expect(migration?.upSql).toContain(objectName);
    }
  });

  it('installs only restricted kind-specific mutation and admission entry points', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '003')?.upSql ?? '';

    for (const functionName of [
      'publish_agent_strategy_release',
      'publish_agent_release',
      'publish_flow_version',
      'publish_experience_release',
      'publish_agent_deployment_revision',
      'publish_flow_deployment_revision',
      'promote_agent_deployment',
      'promote_flow_deployment',
      'resolve_agent_service_admission',
      'resolve_flow_service_admission',
      'exchange_browser_subject_assertion_for_session',
      'authenticate_browser_session_facts',
    ]) {
      expect(sql).toContain(functionName);
    }
    expect(sql).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*TO\s+ba_(?:runtime|control_executor)\s*;/iu,
    );
    expect(sql).not.toContain('publish_opaque_resource');
  });

  it('keeps content-addressed publishers owner-only until canonical attestation exists', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '003')?.upSql ?? '';
    const controlGrant = sql.match(
      /GRANT EXECUTE ON FUNCTION app\.create_publishable_resource_root[\s\S]*?TO ba_control_executor;/u,
    )?.[0];

    expect(controlGrant).toBeDefined();
    for (const publisher of [
      'publish_agent_strategy_release',
      'publish_agent_release',
      'publish_flow_version',
      'publish_experience_release',
      'publish_deployment_policy_version',
      'publish_agent_deployment_revision',
      'publish_flow_deployment_revision',
    ]) {
      expect(controlGrant).not.toContain(publisher);
    }
  });

  it('does not reuse selector-based entry resolution for original-Run scopes', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '003')?.upSql ?? '';
    const agentResolver = sql.match(
      /CREATE FUNCTION app\.resolve_agent_service_admission[\s\S]*?\$function\$;/u,
    )?.[0];
    const flowResolver = sql.match(
      /CREATE FUNCTION app\.resolve_flow_service_admission[\s\S]*?\$function\$;/u,
    )?.[0];

    expect(agentResolver).toBeDefined();
    expect(flowResolver).toBeDefined();
    for (const resolver of [agentResolver, flowResolver]) {
      expect(resolver).not.toMatch(/'run:(?:read|cancel|resume|events:read)'/u);
    }
  });

  it('uses the reviewed Agent Conversation scope names end to end', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '003')?.upSql ?? '';
    const agentResolver = sql.match(
      /CREATE FUNCTION app\.resolve_agent_service_admission[\s\S]*?\$function\$;/u,
    )?.[0];

    expect(agentResolver).toContain("'agent:conversation:write'");
    expect(agentResolver).toContain("'agent:conversation:read'");
    expect(sql).not.toContain("'conversation:write'");
    expect(sql).not.toContain("'conversation:read'");
  });

  it('explicitly revokes publisher helpers from every executable platform role', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const sql = migrations.find(({ id }) => id === '003')?.upSql ?? '';

    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION auth\.register_prepared_published_resource[\s\S]*?FROM\s+ba_runtime,\s*ba_control_executor,\s*ba_management_attestation_issuer,\s*ba_subject_assertion_verifier,\s*ba_auth_owner;/u,
    );
  });
});
