import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMigrations } from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function migrationSql(direction: 'upSql' | 'downSql'): Promise<string> {
  const migration = (await loadMigrations(path.join(packageDirectory, 'migrations'))).find(
    ({ id }) => id === '007',
  );
  expect(migration).toMatchObject({ id: '007', name: 'g1_published_source_registry' });
  return migration?.[direction] ?? '';
}

describe('007 G1 published source registry migration', () => {
  it('adds seven typed owner-only publication wrappers', async () => {
    const sql = await migrationSql('upSql');
    for (const name of [
      'publish_agent_strategy_source',
      'publish_instruction_skill_release',
      'publish_knowledge_index_generation',
      'publish_database_operation_release',
      'publish_plugin_tool_release',
      'publish_a2a_agent_release',
      'publish_skill_pack_release',
    ])
      expect(sql).toContain(name);
    expect(sql).toContain('register_prepared_g1_published_source');
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO ba_(?:runtime|control_executor)/u);
  });

  it('binds exact kinds, schemas, raw UTF-8 source hash and full registry identity', async () => {
    const sql = await migrationSql('upSql');
    for (const [kind, schema] of [
      ['AGENT_STRATEGY_RELEASE', 'agent-strategy-source/1'],
      ['INSTRUCTION_SKILL_RELEASE', 'instruction-skill-source/1'],
      ['KNOWLEDGE_INDEX_GENERATION', 'knowledge-index-generation-source/1'],
      ['DATABASE_OPERATION_RELEASE', 'database-operation-source/1'],
      ['PLUGIN_TOOL_RELEASE', 'plugin-tool-source/1'],
      ['A2A_AGENT_RELEASE', 'a2a-agent-source/1'],
      ['SKILL_PACK_RELEASE', 'skill-pack-source/1'],
    ]) {
      expect(sql).toContain(kind);
      expect(sql).toContain(schema);
    }
    expect(sql).toContain("public.digest(convert_to(v_preimage_text, 'UTF8'), 'sha256')");
    expect(sql).toContain('published_g1_resource_sources_registry_fkey');
    expect(sql).toContain('prepared-g1-published-source-storage/1');
  });

  it('forces tenant isolation and immutable storage while denying executable roles', async () => {
    const sql = await migrationSql('upSql');
    expect(sql).toMatch(
      /ALTER TABLE public\.published_g1_resource_sources FORCE ROW LEVEL SECURITY/u,
    );
    expect(sql).toContain('reject_immutable_release_fact_change');
    expect(sql).toMatch(/FROM ba_runtime, ba_control_executor,[\s\S]*ba_auth_owner;/u);
  });

  it('guards downgrade before dropping typed source storage or narrowing constraints', async () => {
    const sql = await migrationSql('downSql');
    expect(sql).toContain('cannot remove G1 published source registry after publication');
    expect(sql.indexOf('NO FORCE ROW LEVEL SECURITY')).toBeLessThan(sql.indexOf('IF EXISTS'));
    expect(sql.indexOf('IF EXISTS')).toBeLessThan(sql.indexOf('DROP TABLE'));
    expect(sql.indexOf('DROP TABLE')).toBeLessThan(
      sql.indexOf('published_resource_versions_kind_schema_check'),
    );
  });
});
