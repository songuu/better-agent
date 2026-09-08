import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');

function readMigration(name: string): { readonly downSql: string; readonly upSql: string } {
  return {
    downSql: fs.readFileSync(path.join(migrationDirectory, `${name}.down.sql`), 'utf8'),
    upSql: fs.readFileSync(path.join(migrationDirectory, `${name}.up.sql`), 'utf8'),
  };
}

describe('product custom API migration', () => {
  it('stores mutable resource heads and immutable exact revisions behind owner-only RLS', () => {
    const migration = readMigration('038_product_custom_api');
    expect(migration.upSql).toContain('CREATE TABLE public.product_custom_api_resources');
    expect(migration.upSql).toContain('CREATE TABLE public.product_custom_api_releases');
    expect(migration.upSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration.upSql).toContain('product_custom_api_releases_immutable');
    expect(migration.upSql).toContain('REVOKE ALL ON public.product_custom_api_resources');
  });

  it('exposes bounded list/create/update functions and pins Flow API snapshots', () => {
    const migration = readMigration('038_product_custom_api');
    for (const functionName of [
      'app.list_product_custom_apis',
      'app.create_product_custom_api',
      'app.update_product_custom_api',
      'app.assert_product_flow_apis_pinned',
    ]) {
      expect(migration.upSql).toContain(functionName);
    }
    expect(migration.upSql).toContain("node ->> 'type' = 'api'");
    expect(migration.upSql).toContain('Flow API resource snapshot is not pinned');
    expect(migration.upSql).toContain('LIMIT 100');
    expect(migration.upSql).toContain(
      'GRANT EXECUTE ON FUNCTION app.list_product_custom_apis(uuid) TO ba_runtime',
    );
  });

  it('restores plugin-only Flow guards and refuses destructive rollback with API facts', () => {
    const migration = readMigration('038_product_custom_api');
    expect(migration.downSql).toContain('cannot remove product custom APIs while resources exist');
    expect(migration.downSql).toContain('app.assert_product_flow_plugins_installed');
    expect(migration.downSql).toContain('DROP TABLE public.product_custom_api_releases');
  });
});
