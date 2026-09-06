import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = path.resolve(import.meta.dirname, '../migrations');

describe('029 product Agent strategy profile migration', () => {
  it('pins closed versioned strategy profiles to immutable releases and Runs', async () => {
    const up = await readFile(
      path.join(migrations, '029_product_agent_strategy_profile.up.sql'),
      'utf8',
    );
    expect(up).toContain('CREATE FUNCTION app.is_valid_product_agent_strategy_profile');
    expect(up).toContain('CREATE FUNCTION app.create_agent_draft_with_strategy_capabilities');
    expect(up).toContain('CREATE FUNCTION app.update_agent_draft_with_strategy_capabilities');
    expect(up).toContain('CREATE FUNCTION app.route_agent_product_run');
    expect(up).toContain('v_release.strategy_profile');
    expect(up).toContain('product Run terminal or budget conflict');
    expect(up).not.toMatch(/EXECUTE\s+format|dblink|postgres_fdw/iu);
  });

  it('rejects lossy rollback when product strategy data is retained', async () => {
    const down = await readFile(
      path.join(migrations, '029_product_agent_strategy_profile.down.sql'),
      'utf8',
    );
    expect(down).toContain('cannot remove product Agent strategies with retained product data');
    expect(down).toContain('DROP FUNCTION app.is_valid_product_agent_strategy_profile(jsonb)');
  });
});
