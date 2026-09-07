import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');
const up = fs.readFileSync(
  path.join(migrationDirectory, '036_product_agent_flow_binding.up.sql'),
  'utf8',
);
const down = fs.readFileSync(
  path.join(migrationDirectory, '036_product_agent_flow_binding.down.sql'),
  'utf8',
);

describe('product Agent Flow release binding migration', () => {
  it('separates mutable Draft binding from immutable Release evidence', () => {
    expect(up).toContain('CREATE TABLE public.agent_product_flow_bindings');
    expect(up).toContain('CREATE TABLE public.agent_product_release_flow_bindings');
    expect(up).toContain('agent_product_release_flow_bindings_immutable');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('FROM PUBLIC,ba_runtime');
  });

  it('pins the exact published Flow version when an Agent is published', () => {
    expect(up).toContain('snapshot_agent_product_release_flow');
    expect(up).toContain('SELECT max(version) INTO v_version');
    expect(up).toContain('bound Flow has no published release');
    expect(up).toContain('flow_release_version');
  });

  it('allows runtime to read only the current actor Run pinned Flow', () => {
    expect(up).toContain('read_agent_product_run_flow');
    expect(up).toContain("r.status='pending'");
    expect(up).toContain('c.actor_id=p_actor_id');
    expect(up).toContain('app.read_agent_product_run_flow(uuid,uuid,uuid) TO ba_runtime');
    expect(down).toContain('cannot roll back migration 036');
  });
});
