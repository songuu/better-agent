import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Migration } from './types.js';

const migrationFilePattern = /^(\d{3})_([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.(up|down)\.sql$/u;
const transactionControlPattern =
  /(?:^|;)\s*(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|COMMIT(?:\s+(?:WORK|TRANSACTION))?|END(?:\s+(?:WORK|TRANSACTION))?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?|ABORT(?:\s+(?:WORK|TRANSACTION))?|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/imu;
const psqlMetaCommandPattern = /^\s*\\/mu;

interface MigrationFiles {
  downPath?: string;
  id: string;
  name: string;
  upPath?: string;
  version: number;
}

function formatVersion(version: number): string {
  return version.toString().padStart(3, '0');
}

function maskSqlLiteralsAndComments(sql: string): string {
  // Keep UTF-16 code-unit offsets aligned with String indexing on Windows/Node.
  const masked = sql.split('');
  let index = 0;

  const blank = (start: number, end: number): void => {
    for (let position = start; position < end; position += 1) {
      if (masked[position] !== '\n' && masked[position] !== '\r') masked[position] = ' ';
    }
  };

  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      const stop = end === -1 ? sql.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sql.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index];
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    if (sql[index] === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(sql.slice(index))?.[0];
      if (tag !== undefined) {
        const closingIndex = sql.indexOf(tag, index + tag.length);
        const stop = closingIndex === -1 ? sql.length : closingIndex + tag.length;
        blank(index, stop);
        index = stop;
        continue;
      }
    }
    index += 1;
  }

  return masked.join('');
}

export function validateMigrationSqlBody(sql: string, context: string): void {
  if (sql.trim().length === 0) {
    throw new Error(`${context} must not be empty`);
  }
  const executableSql = maskSqlLiteralsAndComments(sql);
  if (transactionControlPattern.test(executableSql)) {
    throw new Error(`${context} must not manage its own transaction`);
  }
  if (psqlMetaCommandPattern.test(executableSql)) {
    throw new Error(`${context} must not contain psql meta commands`);
  }
}

async function readSqlFile(filePath: string): Promise<{ checksum: string; sql: string }> {
  const bytes = await readFile(filePath);
  let sql: string;
  try {
    sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `${filePath} must be valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  validateMigrationSqlBody(sql, filePath);
  return {
    checksum: createHash('sha256').update(bytes).digest('hex'),
    sql,
  };
}

/**
 * Loads the repository-owned migration chain without following symlinks.
 * Contiguous numeric versions make an accidentally omitted migration visible
 * before any database connection is opened.
 */
export async function loadMigrations(directory: string): Promise<readonly Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filesByVersion = new Map<number, MigrationFiles>();

  for (const entry of entries) {
    const match = migrationFilePattern.exec(entry.name);
    if (match === null) {
      if (entry.name.toLowerCase().endsWith('.sql')) {
        throw new Error(
          `${entry.name} must match NNN_snake_case.(up|down).sql with a three-digit version`,
        );
      }
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`${entry.name} must be a regular file; migration symlinks are not allowed`);
    }

    const [, id, name, direction] = match;
    if (id === undefined || name === undefined || direction === undefined) {
      throw new Error(`could not parse migration filename ${entry.name}`);
    }
    const version = Number.parseInt(id, 10);
    const existing = filesByVersion.get(version);
    if (existing !== undefined && existing.name !== name) {
      throw new Error(`migration version ${id} is declared more than once`);
    }
    const files = existing ?? { id, name, version };
    const filePath = path.join(directory, entry.name);

    if (direction === 'up') {
      if (files.upPath !== undefined) {
        throw new Error(`migration version ${id} has more than one up file`);
      }
      files.upPath = filePath;
    } else {
      if (files.downPath !== undefined) {
        throw new Error(`migration version ${id} has more than one down file`);
      }
      files.downPath = filePath;
    }
    filesByVersion.set(version, files);
  }

  const orderedFiles = [...filesByVersion.values()].sort(
    (left, right) => left.version - right.version,
  );
  for (const [index, files] of orderedFiles.entries()) {
    const expected = index;
    if (files.version !== expected) {
      throw new Error(
        `migration sequence must be contiguous: expected ${formatVersion(expected)}, found ${files.id}`,
      );
    }
    if (files.upPath === undefined) {
      throw new Error(`migration ${files.id}_${files.name} has a down file but no up file`);
    }
  }

  return Promise.all(
    orderedFiles.map(async (files): Promise<Migration> => {
      const up = await readSqlFile(files.upPath as string);
      const down = files.downPath === undefined ? undefined : await readSqlFile(files.downPath);
      return Object.freeze({
        checksum: up.checksum,
        downChecksum: down?.checksum,
        downSql: down?.sql,
        id: files.id,
        name: files.name,
        upSql: up.sql,
        version: files.version,
      });
    }),
  );
}
