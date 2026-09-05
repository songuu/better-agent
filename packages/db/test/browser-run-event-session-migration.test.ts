import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '018',
  );
  expect(migration).toMatchObject({ id: '018', name: 'g1_browser_run_event_session' });
  return migration?.[direction] ?? '';
}

describe('018 G1 browser Run-event session migration', () => {
  it('separates safe Run-bound metadata from the private verifier', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('public.run_event_sessions');
    expect(sql).toContain('auth.run_event_session_auth_index');
    expect(sql).toContain('verifier_hmac bytea');
    expect(sql).toContain("expires_at <= issued_at + interval '60 seconds'");
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY run_event_sessions_auth_owner_read');
    expect(sql).not.toMatch(/CREATE POLICY run_event_sessions_auth_owner_[^;]+FOR UPDATE/isu);
    expect(sql).toContain('app.lock_run_event_session');
  });

  it('issues only after original browser Run authorization and current-origin revalidation', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('app.issue_browser_run_event_session');
    expect(sql).toContain(
      "app.require_original_run_authorization(p_run_id,'run:events:read',p_auth)",
    );
    expect(sql).toContain('p_actual_origin = ANY(revision.allowed_origins)');
    expect(sql).toContain('auth.store_run_event_session_verifier');
  });

  it('authenticates the cookie with constant-time comparison and current lifecycle fences', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('auth.authenticate_run_event_session_facts');
    expect(sql).toContain('auth.constant_time_equal_32');
    expect(sql).toMatch(/security_state\.revoke_epoch\s*=\s*v_event_session\.deployment_epoch/u);
    expect(sql).toMatch(/principal\.session_epoch\s*=\s*v_event_session\.principal_epoch/u);
    expect(sql).toMatch(/v_event_session\.canonical_origin\s*<>\s*p_actual_origin/u);
  });

  it('exposes only narrow runtime functions and no private table access', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION app.issue_browser_run_event_session');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION auth.authenticate_run_event_session_facts');
    expect(sql).toContain('TO ba_runtime');
    expect(sql).not.toMatch(/GRANT\s+SELECT[^;]+auth\.run_event_session_auth_index/isu);
  });

  it('refuses downgrade while event-session facts exist', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('browser Run event session facts exist; downgrade rejected');
  });
});
