import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '021',
  );
  expect(migration).toMatchObject({ id: '021', name: 'product_agent_runtime' });
  return migration?.[direction] ?? '';
}

describe('021 product Agent runtime migration', () => {
  it('binds conversations to immutable Agent releases and persists terminal Runs', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('CREATE TABLE public.agent_product_conversations');
    expect(sql).toContain('CREATE TABLE public.agent_product_runs');
    expect(sql).toContain('REFERENCES public.agent_product_releases');
    expect(sql).toContain("status text NOT NULL DEFAULT 'pending'");
    expect(sql).toContain('UNIQUE (workspace_id, conversation_id, sequence)');
  });

  it('exposes CAS definer functions and denies runtime table DML', async () => {
    const sql = await migrationSql('upSql');
    for (const functionName of [
      'create_agent_product_conversation',
      'begin_agent_product_run',
      'complete_agent_product_run',
      'fail_agent_product_run',
      'list_agent_product_runs',
    ]) {
      expect(sql).toContain(`app.${functionName}`);
    }
    expect(sql).toContain("AND status = 'pending'");
    expect(sql).toContain('conversation.actor_id = p_actor_id');
    expect(sql).toContain('LIMIT 20');
    expect(sql).toContain('LIMIT 200');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]+TO ba_runtime/isu);
  });

  it('refuses destructive downgrade while runtime history remains', async () => {
    expect(await migrationSql('downSql')).toContain(
      'cannot remove product Agent runtime with retained conversations',
    );
  });
});
