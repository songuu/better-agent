import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');
const upPath = path.join(migrationDirectory, '037_product_plugin_catalog.up.sql');
const downPath = path.join(migrationDirectory, '037_product_plugin_catalog.down.sql');

describe('product plugin catalog migration', () => {
  it('stores immutable catalog releases and workspace-scoped installations', () => {
    const up = fs.readFileSync(upPath, 'utf8');

    expect(up).toContain('CREATE TABLE public.product_plugin_releases');
    expect(up).toContain('CREATE TABLE public.product_plugin_installations');
    expect(up).toContain('product_plugin_releases_immutable');
    expect(up).toContain('ALTER TABLE public.product_plugin_releases FORCE ROW LEVEL SECURITY');
    expect(up).toContain(
      'ALTER TABLE public.product_plugin_installations FORCE ROW LEVEL SECURITY',
    );
    expect(up).toContain("'builtin.text', 1");
    expect(up).toContain("'builtin.text.v1'");
  });

  it('exposes bounded catalog/install operations and validates Flow plugin bindings', () => {
    const up = fs.readFileSync(upPath, 'utf8');

    for (const name of [
      'list_product_plugin_catalog',
      'install_product_plugin',
      'assert_product_flow_plugins_installed',
    ]) {
      expect(up).toContain(`CREATE FUNCTION app.${name}`);
      expect(up).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION app\\.${name}\\([^;]+ TO ba_runtime;`, 'u'),
      );
    }
    expect(up).toContain('LIMIT 100;');
    expect(up).toContain('plugin is not installed in this workspace');
    for (const flowOperation of [
      'create_product_flow_draft',
      'update_product_flow_draft',
      'publish_product_flow',
      'prepare_product_flow_debug',
    ]) {
      expect(up).toMatch(
        new RegExp(
          `CREATE OR REPLACE FUNCTION app\\.${flowOperation}[\\s\\S]+?PERFORM app\\.assert_product_flow_plugins_installed`,
          'u',
        ),
      );
    }
  });

  it('backfills existing plugin-bound workspaces and guards rollback', () => {
    const up = fs.readFileSync(upPath, 'utf8');
    const down = fs.readFileSync(downPath, 'utf8');

    expect(up).toContain("node ->> 'type' = 'plugin'");
    expect(up).toContain('ON CONFLICT (workspace_id, plugin_id) DO NOTHING');
    expect(down).toContain('cannot remove product plugin catalog while installations exist');
    expect(down).toContain('DROP TABLE public.product_plugin_installations;');
    expect(down).toContain('DROP TABLE public.product_plugin_releases;');
  });
});
