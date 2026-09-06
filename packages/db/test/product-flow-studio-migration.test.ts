import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');
const up = fs.readFileSync(path.join(migrationDirectory, '022_product_flow_studio.up.sql'), 'utf8');
const down = fs.readFileSync(
  path.join(migrationDirectory, '022_product_flow_studio.down.sql'),
  'utf8',
);

describe('product Flow Studio migration', () => {
  it('stores Draft, immutable Release, environment Deployment and debug facts', () => {
    for (const table of [
      'product_flow_drafts',
      'product_flow_releases',
      'product_flow_deployments',
      'product_flow_debug_runs',
    ]) {
      expect(up).toContain(`CREATE TABLE public.${table}`);
      expect(up).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(up).toContain('product_flow_releases_immutable');
    expect(up).toContain('product_flow_debug_runs_immutable');
    expect(up).toContain("environment IN ('development', 'staging', 'production')");
  });

  it('exposes only bounded security-definer operations to the runtime', () => {
    for (const name of [
      'list_product_flow_drafts',
      'create_product_flow_draft',
      'update_product_flow_draft',
      'publish_product_flow',
      'prepare_product_flow_debug',
      'record_product_flow_debug',
      'list_product_flow_debug_runs',
    ]) {
      expect(up).toContain(`CREATE FUNCTION app.${name}`);
      expect(up).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION app\\.${name}\\([^;]+ TO ba_runtime;`, 'u'),
      );
    }
    expect(up).toContain('LIMIT 200;');
    expect(up).toContain('LIMIT 100;');
    expect(up).toContain('octet_length(graph::text) <= 262144');
    expect(up).toContain('octet_length(logs::text) <= 65536');
    expect(up).toContain('FROM ba_runtime;');
  });

  it('uses revision CAS for update, publish and debug recording', () => {
    expect(up).toContain('AND revision = p_expected_revision;');
    expect(up).toContain('AND draft.revision = p_expected_revision;');
    expect(up).toContain('Flow draft changed during debug');
    expect(up).toContain("USING ERRCODE = '40001'");
  });

  it('guards data-bearing rollback and removes every function and table', () => {
    expect(down).toContain('cannot remove product Flow Studio while Flow facts exist');
    expect(down).toContain('DROP FUNCTION app.publish_product_flow');
    expect(down).toContain('DROP TABLE public.product_flow_drafts;');
    expect(down).toContain('DROP FUNCTION app.reject_product_flow_immutable_mutation();');
  });
});
