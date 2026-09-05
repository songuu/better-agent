import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '020',
  );
  expect(migration).toMatchObject({ id: '020', name: 'product_agent_studio' });
  return migration?.[direction] ?? '';
}

describe('020 product Agent Studio migration', () => {
  it('stores mutable drafts and immutable release snapshots by Workspace', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('CREATE TABLE public.agent_drafts');
    expect(sql).toContain('CREATE TABLE public.agent_product_releases');
    expect(sql).toContain('PRIMARY KEY (workspace_id, agent_id, version)');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('exposes bounded definer operations without runtime table DML', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.list_agent_drafts');
    expect(sql).toContain('app.create_agent_draft');
    expect(sql).toContain('app.update_agent_draft');
    expect(sql).toContain('app.publish_agent_draft');
    expect(sql).toContain(
      'REVOKE ALL ON public.agent_drafts, public.agent_product_releases FROM ba_runtime',
    );
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO ba_runtime/isu);
  });

  it('uses optimistic revision CAS and snapshots the published payload', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('revision = p_expected_revision');
    expect(sql).toContain("status = 'published'");
    expect(sql).toContain('INSERT INTO public.agent_product_releases');
    expect(sql).toContain("ERRCODE = '40001'");
  });

  it('refuses destructive downgrade while drafts remain', async () => {
    expect(await migrationSql('downSql')).toContain(
      'cannot remove product Agent Studio with retained drafts',
    );
  });
});
