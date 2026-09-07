import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('032 product Agent iteration trace migration', () => {
  it('versions bounded iteration policy and seals every model result before completion', async () => {
    const up = await migration('032_product_agent_iteration_trace.up.sql');

    expect(up).toContain('product-agent-strategy/3');
    expect(up).toContain('CREATE FUNCTION app.record_agent_product_run_iteration');
    expect(up).toContain('iteration_trace');
    expect(up).toContain('jsonb_array_length(v_run.iteration_trace) + 1');
    expect(up).toContain('product Run iteration or aggregate budget conflict');
    expect(up).toContain("v_strategy ->> 'max_iterations'");
    expect(up).toContain('GRANT EXECUTE ON FUNCTION app.record_agent_product_run_iteration');
  });

  it('guards downgrade while v3 policy or iteration evidence is retained', async () => {
    const down = await migration('032_product_agent_iteration_trace.down.sql');

    expect(down).toContain('cannot remove product Agent iteration evidence');
    expect(down).toContain("strategy_profile ->> 'schema_version' = 'product-agent-strategy/3'");
    expect(down).toContain('iteration_count > 0');
    expect(down).toContain('DROP FUNCTION app.record_agent_product_run_iteration');
    expect(down).toContain('product-agent-strategy/2');
  });
});
