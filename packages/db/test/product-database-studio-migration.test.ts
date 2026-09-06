import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '../migrations');
const upPath = path.join(migrationDirectory, '026_product_database_studio.up.sql');
const downPath = path.join(migrationDirectory, '026_product_database_studio.down.sql');

describe('026 product Database Studio migration', () => {
  it('creates owner-separated append-only tables and bounded parameterized functions', async () => {
    const up = await readFile(upPath, 'utf8');

    expect(up).toContain('CREATE TABLE public.product_database_tables');
    expect(up).toContain('CREATE TABLE public.product_database_rows');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('CREATE TRIGGER product_database_rows_immutable');
    expect(up).toContain('pg_advisory_xact_lock');
    expect(up).toContain('jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500');
    expect(up).toContain('p_limit NOT BETWEEN 1 AND 100');
    expect(up).toContain("NOT (btrim(v_column #>> '{}') ~ '^[A-Za-z][A-Za-z0-9_]*$')");
    expect(up).toContain('REVOKE ALL ON public.product_database_tables');
    expect(up).toContain(
      'GRANT EXECUTE ON FUNCTION app.query_product_database_table(uuid, uuid, text, text, integer) TO ba_runtime;',
    );
    expect(up).not.toMatch(/EXECUTE\s+format|EXECUTE\s+p_|dblink|postgres_fdw/iu);
  });

  it('drops every Database Studio object in dependency order', async () => {
    const down = await readFile(downPath, 'utf8');

    expect(down.indexOf('DROP FUNCTION IF EXISTS app.query_product_database_table')).toBeLessThan(
      down.indexOf('DROP TABLE IF EXISTS public.product_database_rows'),
    );
    expect(down).toContain('DROP TABLE IF EXISTS public.product_database_tables;');
  });
});
