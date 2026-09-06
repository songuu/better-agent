import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.resolve(import.meta.dirname, '../migrations');

describe('030 product Agent parameter extraction migration', () => {
  it('persists closed extraction evidence before capability dispatch and accounts for its usage', async () => {
    const up = await readFile(
      path.join(migrations, '030_product_agent_parameter_extraction.up.sql'),
      'utf8',
    );
    expect(up).toContain('CREATE FUNCTION app.is_valid_product_agent_extracted_parameters');
    expect(up).toContain('CREATE FUNCTION app.record_agent_product_run_parameters');
    expect(up).toContain('CREATE OR REPLACE FUNCTION app.route_agent_product_run');
    expect(up).toContain("release.strategy_profile->>'parameter_extraction'='true'");
    expect(up).toContain('run.parameter_provider_request_id IS NULL');
    expect(up).toContain('run.parameter_input_tokens');
    expect(up).toContain('run.parameter_output_tokens');
    expect(up).toContain('product Run parameter extraction conflict');
    expect(up).toContain('product Run terminal or aggregate budget conflict');
    expect(up).not.toMatch(/EXECUTE\s+format|dblink|postgres_fdw/iu);
  });

  it('rejects lossy rollback while parameter evidence is retained', async () => {
    const down = await readFile(
      path.join(migrations, '030_product_agent_parameter_extraction.down.sql'),
      'utf8',
    );
    expect(down).toContain(
      'cannot remove product Agent parameter extraction with retained evidence',
    );
    expect(down).toContain('DROP FUNCTION app.record_agent_product_run_parameters');
  });
});
