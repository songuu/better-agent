import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/migrations/load.js';

const temporaryDirectories: string[] = [];

async function createMigrationDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'better-agent-db-loader-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('loadMigrations', () => {
  it('loads contiguous migrations in numeric order and pairs an optional down file', async () => {
    const directory = await createMigrationDirectory();
    await writeFile(path.join(directory, '001_tenant.up.sql'), 'SELECT 1;\n');
    await writeFile(path.join(directory, '000_platform.up.sql'), 'SELECT 0;\n');
    await writeFile(path.join(directory, '001_tenant.down.sql'), 'SELECT -1;\n');

    const migrations = await loadMigrations(directory);

    expect(migrations.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: '000', name: 'platform' },
      { id: '001', name: 'tenant' },
    ]);
    expect(migrations[0]?.downSql).toBeUndefined();
    expect(migrations[1]?.downSql).toBe('SELECT -1;\n');
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects a missing version instead of silently changing migration order', async () => {
    const directory = await createMigrationDirectory();
    await writeFile(path.join(directory, '000_platform.up.sql'), 'SELECT 0;\n');
    await writeFile(path.join(directory, '002_runs.up.sql'), 'SELECT 2;\n');

    await expect(loadMigrations(directory)).rejects.toThrow(
      'migration sequence must be contiguous: expected 001, found 002',
    );
  });

  it('rejects duplicate versions even when their names differ', async () => {
    const directory = await createMigrationDirectory();
    await writeFile(path.join(directory, '000_platform.up.sql'), 'SELECT 0;\n');
    await writeFile(path.join(directory, '000_shadow.up.sql'), 'SELECT 1;\n');

    await expect(loadMigrations(directory)).rejects.toThrow(
      'migration version 000 is declared more than once',
    );
  });

  it('rejects transaction control and psql meta commands inside migration bodies', async () => {
    const transactionDirectory = await createMigrationDirectory();
    await writeFile(path.join(transactionDirectory, '000_platform.up.sql'), 'BEGIN;\nSELECT 1;\n');

    await expect(loadMigrations(transactionDirectory)).rejects.toThrow(
      'must not manage its own transaction',
    );

    const metaDirectory = await createMigrationDirectory();
    await writeFile(path.join(metaDirectory, '000_platform.up.sql'), '\\set unsafe 1\nSELECT 1;\n');

    await expect(loadMigrations(metaDirectory)).rejects.toThrow(
      'must not contain psql meta commands',
    );

    const chainDirectory = await createMigrationDirectory();
    await writeFile(
      path.join(chainDirectory, '000_platform.up.sql'),
      'SELECT 1; /* boundary */ COMMIT AND CHAIN;\n',
    );
    await expect(loadMigrations(chainDirectory)).rejects.toThrow(
      'must not manage its own transaction',
    );

    const blockDirectory = await createMigrationDirectory();
    await writeFile(
      path.join(blockDirectory, '000_platform.up.sql'),
      "DO $body$ BEGIN RAISE NOTICE 'COMMIT;'; END $body$;\n",
    );
    await expect(loadMigrations(blockDirectory)).resolves.toHaveLength(1);
  });

  it('rejects symlinked migration entries on every supported platform', async () => {
    const directory = await createMigrationDirectory();
    const target = path.join(directory, 'target-directory');
    await mkdir(target);
    await symlink(
      target,
      path.join(directory, '000_platform.up.sql'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(loadMigrations(directory)).rejects.toThrow('must be a regular file');
  });
});
