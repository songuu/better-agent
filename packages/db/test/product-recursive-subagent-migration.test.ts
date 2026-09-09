import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = async (name: string): Promise<string> =>
  await readFile(resolve(import.meta.dirname, '..', 'migrations', name), 'utf8');

describe('044 product recursive SubAgent migration', () => {
  it('bounds immutable release chains and persists exact per-level usage receipts', async () => {
    const up = await migration('044_product_recursive_subagent.up.sql');

    expect(up).toContain('agent_product_run_subagent_invocations');
    expect(up).toContain('recursive SubAgent release chain exceeds depth 3');
    expect(up).toContain('recursive SubAgent release chain contains a cycle');
    expect(up).toContain("strategy_profile->>'schema_version'='product-agent-strategy/5'");
    expect(up).toContain('read_agent_product_run_subagent_chain');
    expect(up).toContain('record_agent_product_run_subagent_invocation');
    expect(up).toContain('agent_product_runs_subagent_receipt_guard');
    expect(up).toContain('aggregate_input_tokens BETWEEN exclusive_input_tokens');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('FROM PUBLIC,ba_runtime');
  });

  it('refuses rollback once recursive invocation evidence exists', async () => {
    const down = await migration('044_product_recursive_subagent.down.sql');

    expect(down).toContain('cannot remove recursive SubAgent invocation evidence');
    expect(down).toContain('DROP TABLE public.agent_product_run_subagent_invocations');
    expect(down).toContain(
      'CREATE OR REPLACE FUNCTION app.snapshot_agent_product_release_subagent',
    );
  });
});
