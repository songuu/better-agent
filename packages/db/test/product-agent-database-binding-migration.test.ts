import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '../migrations');
const upPath = path.join(migrationDirectory, '027_product_agent_database_binding.up.sql');
const downPath = path.join(migrationDirectory, '027_product_agent_database_binding.down.sql');

describe('027 product Agent Database binding migration', () => {
  it('pins an immutable row set to each release and reads through the conversation version', async () => {
    const up = await readFile(upPath, 'utf8');

    expect(up).toContain('CREATE TABLE public.agent_product_database_bindings');
    expect(up).toContain('CREATE TABLE public.agent_product_release_database_bindings');
    expect(up).toContain('CREATE TABLE public.agent_product_release_database_rows');
    expect(up).toContain('CREATE TRIGGER agent_product_release_database_snapshot');
    expect(up).toContain('AFTER INSERT ON public.agent_product_releases');
    expect(up).toContain('conversation.release_version');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('REVOKE ALL ON public.agent_product_database_bindings');
    expect(up).toContain('p_limit NOT BETWEEN 1 AND 20');
    expect(up).not.toMatch(/EXECUTE\s+format|dblink|postgres_fdw/iu);
  });

  it('drops the read surface before its immutable storage', async () => {
    const down = await readFile(downPath, 'utf8');

    expect(down.indexOf('DROP FUNCTION app.read_agent_product_conversation_database')).toBeLessThan(
      down.indexOf('DROP TABLE public.agent_product_release_database_rows'),
    );
    expect(down).toContain('DROP TABLE public.agent_product_database_bindings;');
  });
});
