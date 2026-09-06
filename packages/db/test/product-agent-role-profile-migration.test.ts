import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '../migrations');
const upPath = path.join(migrationDirectory, '028_product_agent_role_profile.up.sql');
const downPath = path.join(migrationDirectory, '028_product_agent_role_profile.down.sql');

describe('028 product Agent role profile migration', () => {
  it('stores a closed structured profile on drafts and immutable releases', async () => {
    const up = await readFile(upPath, 'utf8');

    expect(up).toContain('CREATE FUNCTION app.is_valid_product_agent_role_profile');
    expect(up).toContain('CREATE FUNCTION app.render_product_agent_role_instructions');
    expect(up).toContain("role_mode text NOT NULL DEFAULT 'text'");
    expect(up).toContain('role_profile jsonb');
    expect(up).toContain('CREATE FUNCTION app.list_agent_drafts_with_role_capabilities');
    expect(up).toContain('CREATE FUNCTION app.create_agent_draft_with_role_capabilities');
    expect(up).toContain('CREATE FUNCTION app.update_agent_draft_with_role_capabilities');
    expect(up).toContain('CREATE TRIGGER agent_product_releases_immutable');
    expect(up).toContain('v_row.role_profile');
    expect(up).not.toMatch(/EXECUTE\s+format|dblink|postgres_fdw/iu);
  });

  it('guards removal when structured role data is retained', async () => {
    const down = await readFile(downPath, 'utf8');

    expect(down).toContain(
      'cannot remove product Agent role profiles with retained structured data',
    );
    expect(down).toContain('DROP FUNCTION app.is_valid_product_agent_role_profile(jsonb)');
    expect(down).toContain('DROP FUNCTION app.render_product_agent_role_instructions(jsonb)');
  });
});
