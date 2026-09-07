import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('033 product Agent action decision migration', () => {
  it('seals bound tool and final decisions behind ordered aggregate budgets', async () => {
    const up = await migration('033_product_agent_action_decision.up.sql');

    expect(up).toContain('product-agent-strategy/4');
    expect(up).toContain('CREATE FUNCTION app.read_agent_product_run_capabilities');
    expect(up).toContain('CREATE FUNCTION app.record_agent_product_run_decision');
    expect(up).toContain('agent_product_release_knowledge_bindings');
    expect(up).toContain('agent_product_release_database_bindings');
    expect(up).toContain("p_action IN ('tool','final')");
    expect(up).toContain('model tool decision, binding, order or aggregate budget conflict');
    expect(up).toContain('GRANT EXECUTE ON FUNCTION app.record_agent_product_run_decision');
  });

  it('refuses downgrade while v4 policy or action evidence is retained', async () => {
    const down = await migration('033_product_agent_action_decision.down.sql');

    expect(down).toContain('cannot remove product Agent action decision evidence');
    expect(down).toContain("strategy_profile ->> 'schema_version' = 'product-agent-strategy/4'");
    expect(down).toContain("item ? 'action'");
    expect(down).toContain('DROP FUNCTION app.record_agent_product_run_decision');
    expect(down).toContain('product-agent-strategy/3');
  });
});
