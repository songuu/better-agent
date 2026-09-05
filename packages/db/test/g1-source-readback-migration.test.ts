import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '008',
  );
  expect(migration).toMatchObject({ id: '008', name: 'g1_source_authoritative_readback' });
  return migration?.[direction] ?? '';
}

describe('008 G1 authoritative source readback migration', () => {
  it('adds fixed dependency and source resolvers for the control role only', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.resolve_registered_dependency_pins(jsonb)');
    expect(sql).toContain('app.resolve_g1_published_source(jsonb)');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*resolve_registered_dependency_pins\(jsonb\)[\s\S]*resolve_g1_published_source\(jsonb\)[\s\S]*TO ba_control_executor;/u,
    );
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*published_/u);
  });

  it('requires closed exact pins, the current Workspace and bounded unique requests', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('auth.require_control_workspace()');
    expect(sql).toContain('jsonb_array_length(p_pins) > 1024');
    expect(sql).toContain('published dependency pin fields differ from the closed contract');
    expect(sql).toContain('duplicate published dependency pin');
    expect(sql).toContain('published dependency pin is not registered');
  });

  it('reconstructs canonical source storage and dependency ordinals behind RLS', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain("'prepared-g1-published-source-storage/1'");
    expect(sql).toContain("'published-resource-dependency-manifest/1'");
    expect(sql).toContain('ORDER BY dependency.ordinal');
    expect(sql).toContain('published_g1_resource_sources');
    expect(sql).toContain('published_resource_dependencies');
    expect(sql).toContain('G1 published source is not registered');
  });

  it('removes only the two read-only functions on downgrade', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('DROP FUNCTION app.resolve_g1_published_source(jsonb)');
    expect(sql).toContain('DROP FUNCTION app.resolve_registered_dependency_pins(jsonb)');
    expect(sql).not.toContain('DROP TABLE');
  });
});
