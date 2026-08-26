import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMigrations } from './migrations/load.js';
import {
  renderDownMigrationSql,
  renderMigrationStatusSql,
  renderUpMigrationSql,
} from './migrations/render.js';
import { executeWithPsql } from './psql.js';

const defaultMigrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

interface ParsedArguments {
  allowDown: boolean;
  command: 'down' | 'status' | 'up';
  migrationDirectory: string;
  targetVersion: number | undefined;
}

function usage(): string {
  return `Usage:
  node dist/cli.js up [--migrations <directory>]
  node dist/cli.js status
  node dist/cli.js down --to <version|-1> --allow-down [--migrations <directory>]

Connection settings are read only from PGHOST, PGPORT, PGDATABASE, PGUSER,
PGPASSWORD and PGSSL* libpq variables. DATABASE_URL is deliberately rejected.`;
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const [command, ...rest] = arguments_;
  if (command !== 'up' && command !== 'down' && command !== 'status') {
    throw new Error(usage());
  }
  let allowDown = false;
  let migrationDirectory = defaultMigrationDirectory;
  let targetVersion: number | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--allow-down') {
      allowDown = true;
      continue;
    }
    if (argument === '--migrations') {
      const value = rest[index + 1];
      if (value === undefined) throw new Error('--migrations requires a directory');
      migrationDirectory = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--to') {
      const value = rest[index + 1];
      if (value === undefined || !/^-?\d+$/u.test(value)) {
        throw new Error('--to requires an integer migration version');
      }
      targetVersion = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${String(argument)}\n${usage()}`);
  }

  if (command === 'down' && targetVersion === undefined) {
    throw new Error('down requires --to <version|-1>');
  }
  if (command !== 'down' && (allowDown || targetVersion !== undefined)) {
    throw new Error('--allow-down and --to are valid only for down');
  }

  return { allowDown, command, migrationDirectory, targetVersion };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  let sql: string;
  if (arguments_.command === 'status') {
    sql = renderMigrationStatusSql();
  } else {
    const migrations = await loadMigrations(arguments_.migrationDirectory);
    sql =
      arguments_.command === 'up'
        ? renderUpMigrationSql(migrations)
        : renderDownMigrationSql(migrations, arguments_.targetVersion as number, {
            allowDown: arguments_.allowDown,
          });
  }
  const output = await executeWithPsql(sql);
  process.stdout.write(output);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`database migration command failed: ${message}\n`);
  process.exitCode = 1;
});
