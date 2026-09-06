import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');
const up = fs.readFileSync(
  path.join(migrationDirectory, '024_product_release_evaluation_overview.up.sql'),
  'utf8',
);
const down = fs.readFileSync(
  path.join(migrationDirectory, '024_product_release_evaluation_overview.down.sql'),
  'utf8',
);

describe('product release evaluation overview migration', () => {
  it('projects immutable Agent and Flow releases instead of mutable draft status', () => {
    expect(up).toContain('CREATE FUNCTION app.list_product_release_evaluation_targets');
    expect(up).toContain('FROM public.agent_product_releases');
    expect(up).toContain('FROM public.product_flow_releases');
    expect(up).toContain(
      'ORDER BY published_at DESC, target_kind, target_id, release_version DESC',
    );
  });

  it('binds Agent evidence to the exact release and Flow deployments to the exact version', () => {
    expect(up).toContain('conversation.release_version = release.version');
    expect(up).toContain('deployment.release_version = release.version');
    expect(up).toContain("run.status = 'completed'");
    expect(up).toContain("run.status = 'failed'");
  });

  it('keeps readback bounded and available only through the definer function', () => {
    expect(up).toContain('LIMIT 400');
    expect(up).toContain('SECURITY DEFINER');
    expect(up).toContain(
      'GRANT EXECUTE ON FUNCTION app.list_product_release_evaluation_targets(uuid) TO ba_runtime;',
    );
    expect(up).toContain(
      'REVOKE ALL ON FUNCTION app.list_product_release_evaluation_targets(uuid) FROM PUBLIC;',
    );
  });

  it('provides a reversible read-only migration', () => {
    expect(down).toContain('DROP FUNCTION app.list_product_release_evaluation_targets(uuid);');
    expect(down).not.toContain('DROP TABLE');
  });
});
