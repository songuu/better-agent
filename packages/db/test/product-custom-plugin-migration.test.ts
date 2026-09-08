import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const directory = path.resolve(import.meta.dirname, '..', 'migrations');
const read = (suffix: 'up' | 'down') =>
  fs.readFileSync(path.join(directory, `041_product_custom_plugin.${suffix}.sql`), 'utf8');

describe('product custom Plugin migration', () => {
  it('stores owner-scoped mutable heads and immutable releases', () => {
    const up = read('up');
    expect(up).toContain('CREATE TABLE public.product_custom_plugin_resources');
    expect(up).toContain('CREATE TABLE public.product_custom_plugin_releases');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('product_custom_plugin_releases_immutable');
    expect(up).toContain('REVOKE ALL ON public.product_custom_plugin_resources');
  });

  it('publishes private HTTPS manifests and verifies exact installed Flow snapshots', () => {
    const up = read('up');
    expect(up).toContain('owner_workspace_id');
    expect(up).toContain('app.create_product_custom_plugin');
    expect(up).toContain('app.update_product_custom_plugin');
    expect(up).toContain("'runtime','https'");
    expect(up).toContain('custom Plugin snapshot does not match installed release');
    expect(up).toContain("v_node#>>'{config,endpointUrl}'");
  });

  it('refuses destructive rollback and restores the builtin catalog contract', () => {
    const down = read('down');
    expect(down).toContain('cannot remove custom Plugin storage while resources exist');
    expect(down).toContain(
      'ALTER TABLE public.product_plugin_releases DROP COLUMN owner_workspace_id',
    );
    expect(down).toContain('app.assert_product_flow_plugins_installed');
  });
});
