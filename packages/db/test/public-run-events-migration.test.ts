import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '017',
  );
  expect(migration).toMatchObject({ id: '017', name: 'g1_public_run_events' });
  return migration?.[direction] ?? '';
}

describe('017 G1 public Run events migration', () => {
  it('stores an immutable event-bound public projection behind FORCE RLS', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.public_run_event_projections');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('public_run_event_projections_immutable');
    expect(sql).toContain('FOREIGN KEY (workspace_id, event_id)');
  });

  it('validates the closed public discriminator and blocks internal authority keys', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.validate_public_run_event_projection');
    expect(sql).toContain(
      "'run.accepted','run.started','node.started','task.delta','task.completed'",
    );
    expect(sql).toContain(
      "p_projection ?| ARRAY['workspace_id','plan_hash','closure_hash','credential_id'",
    );
  });

  it('reads only authorized same-Run events after a canonical bounded cursor', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.read_public_run_events');
    expect(sql).toContain(
      "app.require_original_run_authorization(p_run_id,'run:events:read',p_auth)",
    );
    expect(sql).toContain('projection.sequence>p_cursor');
    expect(sql).toContain('LIMIT 1000');
  });

  it('keeps projection writes owner-only and readback on the runtime facade', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION app.append_public_run_event_projection');
    expect(sql).toContain('TO ba_run_owner');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION app.read_public_run_events');
    expect(sql).toContain('TO ba_runtime');
  });

  it('refuses downgrade when public projection facts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('public Run event projection facts exist; downgrade rejected');
    expect(sql).toContain('DROP TABLE public.public_run_event_projections');
  });
});
