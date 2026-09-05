import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '009',
  );
  expect(migration).toMatchObject({ id: '009', name: 'g1_source_publication_attestation' });
  return migration?.[direction] ?? '';
}

describe('009 G1 source publication attestation migration', () => {
  it('separates reviewer issuance from fixed-kind control consumption', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('auth.issue_g1_source_publication_attestation');
    expect(sql).toContain('auth.consume_g1_source_publication_attestation');
    expect(sql).toContain('isolated management issuer login');
    expect(sql).toContain('isolated control executor login');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION auth\.issue_g1_source_publication_attestation[\s\S]*TO ba_management_attestation_issuer;/u,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*app\.publish_attested_agent_strategy_source[\s\S]*app\.publish_attested_skill_pack_release[\s\S]*TO ba_control_executor;/u,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE[^;]*register_prepared_g1_published_source[^;]*ba_control_executor/u,
    );
  });

  it('binds a short-lived one-use proof to exact source storage and publisher login', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('auth.g1_source_publication_attestations');
    expect(sql).toContain("digest(convert_to(p_storage::text, 'UTF8'), 'sha256')");
    expect(sql).toContain('bound_session_user IS DISTINCT FROM session_user::name');
    expect(sql).toContain('consumed_at IS NULL');
    expect(sql).toContain("p_expires_at > v_now + interval '15 minutes'");
    expect(sql).toContain('auth.constant_time_equal_32');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION auth\.constant_time_equal_32\(bytea, bytea\)[\s\S]*TO ba_authorization_owner;/u,
    );
    expect(sql).toContain('FOR UPDATE OF attestation');
  });

  it('keeps tables and raw publishers inaccessible to executable roles', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE auth\.g1_source_publication_attestations FROM PUBLIC/u,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE auth\.g1_source_publication_attestations[\s\S]*FROM ba_runtime, ba_control_executor/u,
    );
    expect(sql).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*g1_source_publication/u);
  });

  it('guards downgrade once an attestation exists and removes only the new surface', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('G1 source publication attestations exist; downgrade rejected');
    expect(sql).toContain('DROP FUNCTION app.publish_attested_agent_strategy_source');
    expect(sql).toContain('DROP FUNCTION auth.issue_g1_source_publication_attestation');
    expect(sql).toContain('DROP TABLE auth.g1_source_publication_attestations');
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION auth\.constant_time_equal_32\(bytea, bytea\)[\s\S]*FROM ba_authorization_owner;/u,
    );
    expect(sql).not.toContain('DROP TABLE public.published_g1_resource_sources');
  });
});
