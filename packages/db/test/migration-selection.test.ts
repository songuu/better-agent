import { describe, expect, it } from 'vitest';

import { type Migration, selectMigrationMilestone } from '../src/index.js';

function migration(version: number): Migration {
  return {
    checksum: String(version).repeat(64),
    downChecksum: undefined,
    downSql: undefined,
    id: version.toString().padStart(3, '0'),
    name: `migration_${String(version)}`,
    upSql: `SELECT ${String(version)};`,
    version,
  };
}

describe('selectMigrationMilestone', () => {
  it('returns and freezes the exact reviewed prefix without consuming a newer head', () => {
    const migrations = [migration(0), migration(1), migration(2)];

    const selected = selectMigrationMilestone(migrations, '001', 'historical suite');

    expect(selected.map(({ id }) => id)).toEqual(['000', '001']);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it('fails closed for a missing, duplicated or non-contiguous milestone', () => {
    expect(() => selectMigrationMilestone([migration(0)], '001', 'missing suite')).toThrow(
      'missing suite expected exactly one migration 001, found 0',
    );
    expect(() =>
      selectMigrationMilestone(
        [migration(0), migration(1), migration(1)],
        '001',
        'duplicate suite',
      ),
    ).toThrow('duplicate suite expected exactly one migration 001, found 2');
    expect(() =>
      selectMigrationMilestone([migration(1), migration(0)], '001', 'unordered suite'),
    ).toThrow('unordered suite migration prefix must be contiguous: expected 000, found 001');
  });

  it('rejects an ambiguous non-three-digit milestone before selecting', () => {
    expect(() => selectMigrationMilestone([migration(0)], '0', 'unsafe suite')).toThrow(
      'unsafe suite migration milestone must be a three-digit ID',
    );
  });
});
