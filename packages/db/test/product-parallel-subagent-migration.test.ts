import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = async (name: string): Promise<string> =>
  await readFile(resolve(import.meta.dirname, '..', 'migrations', name), 'utf8');

describe('045 product parallel SubAgent migration', () => {
  it('pins at most three root branches and seals branch-aware usage receipts', async () => {
    const up = await migration('045_product_parallel_subagent.up.sql');

    expect(up).toContain('agent_product_parallel_subagent_bindings');
    expect(up).toContain('agent_product_release_parallel_subagent_bindings');
    expect(up).toContain('cardinality(p_child_agent_ids) BETWEEN 0 AND 3');
    expect(up).toContain('read_agent_product_run_subagent_chains');
    expect(up).toContain('record_agent_product_run_subagent_invocation_v2');
    expect(up).toContain('PRIMARY KEY (workspace_id,run_id,parent_iteration,branch,depth)');
    expect(up).toContain('sum(invocation.aggregate_input_tokens)');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('FROM PUBLIC,ba_runtime');
  });

  it('refuses rollback after parallel release or invocation evidence exists', async () => {
    const down = await migration('045_product_parallel_subagent.down.sql');

    expect(down).toContain('cannot remove parallel SubAgent evidence');
    expect(down).toContain('DROP TABLE public.agent_product_release_parallel_subagent_bindings');
    expect(down).toContain('DROP COLUMN branch');
  });
});
