import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '../migrations');
const read = (direction: 'down' | 'up') =>
  readFile(
    path.join(migrationDirectory, `043_product_database_operation.${direction}.sql`),
    'utf8',
  );

describe('043 product Database Operation migration', () => {
  it('stores immutable operation releases behind owner-only FORCE RLS', async () => {
    const up = await read('up');
    expect(up).toContain('CREATE TABLE public.product_database_operations');
    expect(up).toContain('CREATE TABLE public.product_database_operation_releases');
    expect(up).toContain('FORCE ROW LEVEL SECURITY');
    expect(up).toContain('product_database_operation_releases_immutable');
    expect(up).toContain('Database Operation revision conflict');
    expect(up).toContain('REVOKE ALL ON public.product_database_operations');
  });

  it('pins Flow and Agent bindings to exact operation revisions without arbitrary SQL', async () => {
    const up = await read('up');
    expect(up).toContain('assert_product_flow_database_operations_pinned');
    expect(up).toContain('operation_revision');
    expect(up).toContain('snapshot_agent_product_release_database');
    expect(up).toContain('read_agent_product_conversation_database');
    expect(up).not.toMatch(/EXECUTE\s+format|EXECUTE\s+p_|dblink|postgres_fdw/iu);
  });

  it('refuses rollback after immutable operation evidence exists', async () => {
    const down = await read('down');
    expect(down).toContain('cannot roll back migration 043');
    expect(down).toContain('DROP TABLE public.product_database_operation_releases');
    expect(down).toContain('DROP TABLE public.product_database_operations');
  });
});
