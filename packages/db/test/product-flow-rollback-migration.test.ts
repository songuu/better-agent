import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');
const up = fs.readFileSync(
  path.join(migrationDirectory, '035_product_flow_release_rollback.up.sql'),
  'utf8',
);
const down = fs.readFileSync(
  path.join(migrationDirectory, '035_product_flow_release_rollback.down.sql'),
  'utf8',
);

describe('product Flow release rollback migration', () => {
  it('stores immutable owner-only rollback receipts', () => {
    expect(up).toContain('CREATE TABLE public.product_flow_deployment_rollbacks');
    expect(up).toContain('product_flow_deployment_rollbacks_immutable');
    expect(up).toContain(
      'ALTER TABLE public.product_flow_deployment_rollbacks FORCE ROW LEVEL SECURITY',
    );
    expect(up).toContain('FROM ba_runtime');
  });

  it('exposes bounded release and rollback history plus an atomic CAS operation', () => {
    for (const name of [
      'list_product_flow_releases',
      'list_product_flow_rollbacks',
      'rollback_product_flow_deployment',
    ]) {
      expect(up).toContain(`CREATE FUNCTION app.${name}`);
      expect(up).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION app\\.${name}\\([^;]+ TO ba_runtime;`, 'u'),
      );
    }
    expect(up).toContain('FOR UPDATE;');
    expect(up).toContain('v_current_release IS DISTINCT FROM p_expected_release_version');
    expect(up).toContain("USING ERRCODE = '40001'");
    expect(up).toContain('LIMIT 200;');
    expect(up).toContain('LIMIT 100;');
  });

  it('guards rollback evidence and removes only its own surface', () => {
    expect(down).toContain('cannot remove product Flow rollback while receipts exist');
    expect(down).toContain('DROP FUNCTION app.rollback_product_flow_deployment');
    expect(down).toContain('DROP TABLE public.product_flow_deployment_rollbacks;');
  });
});
