import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('034 product Agent SubAgent binding migration', () => {
  it('pins an exact child release and seals child usage evidence', async () => {
    const up = await migration('034_product_agent_subagent_binding.up.sql');
    expect(up).toContain('product-agent-strategy/5');
    expect(up).toContain('agent_product_release_subagent_bindings');
    expect(up).toContain('target_release_version');
    expect(up).toContain('app.read_agent_product_run_subagent');
    expect(up).toContain('app.record_agent_product_run_decision_v5');
    expect(up).toContain('tool_input_tokens');
    expect(up).toContain('target_agent_id');
  });

  it('refuses downgrade while v5 policy or pinned evidence exists', async () => {
    const down = await migration('034_product_agent_subagent_binding.down.sql');
    expect(down).toContain('cannot remove product Agent SubAgent evidence');
    expect(down).toContain("strategy_profile->>'schema_version'='product-agent-strategy/5'");
    expect(down).toContain('DROP TABLE public.agent_product_release_subagent_bindings');
  });
});
