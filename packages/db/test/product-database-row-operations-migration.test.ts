import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '../migrations');
const read = (direction: 'down' | 'up') =>
  readFile(
    path.join(migrationDirectory, `042_product_database_row_operations.${direction}.sql`),
    'utf8',
  );

describe('042 product Database row operations migration', () => {
  it('keeps base rows immutable and appends owner-only CAS versions', async () => {
    const up = await read('up');
    expect(up).toContain('CREATE TABLE public.product_database_row_versions');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('product_database_row_versions_immutable');
    expect(up).toContain('pg_advisory_xact_lock');
    expect(up).toContain('Database row revision conflict');
    expect(up).toContain('REVOKE ALL ON public.product_database_row_versions');
  });

  it('projects current rows while Agent releases pin an exact row version', async () => {
    const up = await read('up');
    expect(up).toContain('ADD COLUMN row_version bigint NOT NULL DEFAULT 1');
    expect(up).toContain("coalesce(latest.operation, 'update') <> 'delete'");
    expect(up).toContain('coalesce(latest.version, 1)');
    expect(up).toContain('pinned.version = release_row.row_version');
    expect(up).not.toMatch(/EXECUTE\s+format|EXECUTE\s+p_|dblink|postgres_fdw/iu);
  });

  it('blocks rollback after immutable row-version evidence exists', async () => {
    const down = await read('down');
    expect(down).toContain('cannot roll back migration 042');
    expect(down.indexOf('DROP FUNCTION app.mutate_product_database_row')).toBeLessThan(
      down.indexOf('DROP TABLE public.product_database_row_versions'),
    );
    expect(down).toContain(
      'ALTER TABLE public.agent_product_release_database_rows DROP COLUMN row_version',
    );
  });
});
