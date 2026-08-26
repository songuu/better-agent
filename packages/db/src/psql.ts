import { spawn } from 'node:child_process';

const requiredConnectionVariables = ['PGHOST', 'PGDATABASE', 'PGUSER'] as const;
const forwardedConnectionVariables = [
  ...requiredConnectionVariables,
  'PGPASSWORD',
  'PGPORT',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGCONNECT_TIMEOUT',
] as const;

type PsqlEnvironment = Record<(typeof forwardedConnectionVariables)[number], string | undefined>;

const requiredProcessVariables = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
] as const;

export function validatePsqlEnvironment(
  environment: Record<string, string | undefined>,
): PsqlEnvironment {
  if (environment.DATABASE_URL !== undefined && environment.DATABASE_URL.length > 0) {
    throw new Error(
      'DATABASE_URL is not accepted because it may expose credentials in process arguments; use discrete PG* variables',
    );
  }
  for (const variable of requiredConnectionVariables) {
    if (environment[variable] === undefined || environment[variable]?.trim().length === 0) {
      throw new Error(`${variable} is required for the migration connection`);
    }
  }
  if (
    environment.PGPORT !== undefined &&
    (!/^\d{1,5}$/u.test(environment.PGPORT) || Number(environment.PGPORT) > 65_535)
  ) {
    throw new Error('PGPORT must be a valid TCP port');
  }

  return Object.fromEntries(
    forwardedConnectionVariables.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ) as PsqlEnvironment;
}

export function redactPsqlError(message: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (redacted, secret) =>
      secret.length === 0 ? redacted : redacted.replaceAll(secret, '[REDACTED]'),
    message,
  );
}

export function createPsqlChildEnvironment(
  environment: Record<string, string | undefined>,
  connectionEnvironment: PsqlEnvironment = validatePsqlEnvironment(environment),
): NodeJS.ProcessEnv {
  const processEnvironment = Object.fromEntries(
    requiredProcessVariables.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return { ...processEnvironment, ...connectionEnvironment };
}

export async function executeWithPsql(
  sql: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const connectionEnvironment = validatePsqlEnvironment(environment);
  const executable = environment.BA_PSQL_BIN?.trim() || 'psql';
  const childEnvironment = createPsqlChildEnvironment(environment, connectionEnvironment);

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ['--no-psqlrc', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose'],
      {
        env: childEnvironment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const standardOutput: Buffer[] = [];
    const standardError: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => standardOutput.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => standardError.push(chunk));
    child.on('error', (error) => {
      reject(new Error(`could not start ${executable}: ${error.message}`));
    });
    child.on('close', (exitCode) => {
      const output = Buffer.concat(standardOutput).toString('utf8');
      if (exitCode === 0) {
        resolve(output);
        return;
      }
      const errorOutput = Buffer.concat(standardError).toString('utf8').trim();
      const secrets = [connectionEnvironment.PGPASSWORD ?? ''];
      reject(
        new Error(
          `psql migration failed with exit code ${String(exitCode)}: ${redactPsqlError(errorOutput, secrets)}`,
        ),
      );
    });
    child.stdin.end(sql, 'utf8');
  });
}
