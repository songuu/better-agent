import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('047 product DeepSeek model migration', () => {
  it('extends every persisted model boundary and JSON validator', async () => {
    const up = await migration('047_product_deepseek_models.up.sql');

    expect(up).toContain("'deepseek-v4-flash','deepseek-v4-pro'");
    expect(up).toContain('agent_drafts_model_check');
    expect(up).toContain('agent_product_runs_model_check');
    expect(up).toContain('agent_product_run_subagent_invocations_model_check');
    expect(up).toContain('agent_product_async_subagent_invocations_model_check');
    expect(up).toContain('app.is_valid_product_agent_strategy_profile');
    expect(up).toContain('app.is_valid_product_agent_iteration_trace');
  });

  it('refuses downgrade while DeepSeek model facts exist', async () => {
    const down = await migration('047_product_deepseek_models.down.sql');

    expect(down).toContain('cannot remove DeepSeek model support while model facts exist');
    expect(down).toContain('agent_drafts_model_check');
    expect(down).toContain('app.is_valid_product_agent_strategy_profile');
    expect(down).toContain('app.is_valid_product_agent_iteration_trace');
  });
});
