import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('006 executable closure storage migration', () => {
  it('adds a paired reviewed up/down migration without changing historical migrations', async () => {
    const migrations = await loadMigrations(path.join(packageDirectory, 'migrations'));
    const migration = migrations.find(({ id }) => id === '006');
    expect(migration).toMatchObject({ id: '006', name: 'executable_closure_storage' });
    expect(migration?.downSql).toContain(
      'cannot remove executable closure storage after publication',
    );
    expect(migration?.upSql).toContain('published_executable_closures');
  });

  it('uses typed atomic wrappers and leaves every executable platform role denied', async () => {
    const sql =
      (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
        ({ id }) => id === '006',
      )?.upSql ?? '';
    for (const name of ['publish_compiled_agent_release', 'publish_compiled_flow_version'])
      expect(sql).toContain(name);
    expect(sql).toContain('register_prepared_executable_closure');
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/u);
    expect(sql).toMatch(/FROM ba_runtime, ba_control_executor,[\s\S]*ba_auth_owner;/u);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO ba_(?:runtime|control_executor)/u);
  });

  it('binds raw UTF-8 hashes, full registry identity, manifest and Agent compiled fields', async () => {
    const sql =
      (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
        ({ id }) => id === '006',
      )?.upSql ?? '';
    expect(sql).toContain("public.digest(convert_to(v_compiled_text, 'UTF8'), 'sha256')");
    expect(sql).toContain("public.digest(convert_to(v_closure_text, 'UTF8'), 'sha256')");
    expect(sql).toContain('published_executable_closures_registry_fkey');
    expect(sql).toContain("registry.dependency_manifest_hash = v_manifest ->> 'manifest_hash'");
    expect(sql).toContain("v_document ->> 'compiled_hash'");
    expect(sql).toContain("v_document ->> 'capability_closure_hash'");
  });

  it('has a cross-tenant-visible non-empty down guard before destructive drops', async () => {
    const sql =
      (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
        ({ id }) => id === '006',
      )?.downSql ?? '';
    expect(sql.indexOf('NO FORCE ROW LEVEL SECURITY')).toBeLessThan(sql.indexOf('IF EXISTS'));
    expect(sql.indexOf('IF EXISTS')).toBeLessThan(sql.indexOf('DROP TABLE'));
  });
});
