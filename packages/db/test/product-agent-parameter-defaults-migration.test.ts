import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('031 product Agent parameter defaults migration', () => {
  it('versions closed defaults and records database-authored effective Run parameters', async () => {
    const up = await migration('031_product_agent_parameter_defaults.up.sql');

    expect(up).toContain('product-agent-strategy/2');
    expect(up).toContain('parameter_defaults');
    expect(up).toContain('CREATE FUNCTION app.resolve_agent_product_run_parameters');
    expect(up).toContain('effective_parameters');
    expect(up).toContain("parameter_source IN ('defaults','extracted')");
    expect(up).toContain('product Run parameter resolution conflict');
    expect(up).toContain('REVOKE EXECUTE ON FUNCTION app.record_agent_product_run_parameters');
    expect(up).toContain('GRANT EXECUTE ON FUNCTION app.resolve_agent_product_run_parameters');
  });

  it('guards downgrade when v2 or default-resolution evidence is retained', async () => {
    const down = await migration('031_product_agent_parameter_defaults.down.sql');

    expect(down).toContain('cannot remove product Agent parameter defaults with retained evidence');
    expect(down).toContain("strategy_profile ->> 'schema_version' = 'product-agent-strategy/2'");
    expect(down).toContain("parameter_source = 'defaults'");
    expect(down).toContain('DROP FUNCTION app.resolve_agent_product_run_parameters');
    expect(down).toContain('GRANT EXECUTE ON FUNCTION app.record_agent_product_run_parameters');
  });
});
