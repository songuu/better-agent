import type { Migration } from './types.js';

function formatVersion(version: number): string {
  return version.toString().padStart(3, '0');
}

/**
 * Selects one reviewed migration prefix by its immutable migration ID.
 *
 * Historical integration suites use this boundary so a later migration cannot
 * silently change the schema under test while still allowing the repository to
 * contain newer migrations.
 */
export function selectMigrationMilestone(
  migrations: readonly Migration[],
  throughId: string,
  context: string,
): readonly Migration[] {
  if (!/^\d{3}$/u.test(throughId)) {
    throw new Error(`${context} migration milestone must be a three-digit ID`);
  }

  const matches = migrations.filter((migration) => migration.id === throughId);
  if (matches.length !== 1) {
    throw new Error(
      `${context} expected exactly one migration ${throughId}, found ${String(matches.length)}`,
    );
  }

  const target = matches[0] as Migration;
  const expectedTargetVersion = Number.parseInt(throughId, 10);
  if (target.version !== expectedTargetVersion) {
    throw new Error(
      `${context} migration ${throughId} has numeric version ${String(target.version)}`,
    );
  }

  const selected = migrations.slice(0, target.version + 1);
  for (const [expectedVersion, migration] of selected.entries()) {
    const expectedId = formatVersion(expectedVersion);
    if (migration.version !== expectedVersion || migration.id !== expectedId) {
      throw new Error(
        `${context} migration prefix must be contiguous: expected ${expectedId}, found ${migration.id}`,
      );
    }
  }
  if (selected.at(-1) !== target) {
    throw new Error(`${context} migration ${throughId} is not at its contiguous prefix position`);
  }

  return Object.freeze(selected);
}
