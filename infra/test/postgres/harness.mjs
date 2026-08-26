import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(harnessDirectory, 'compose.yaml');
const redactedPatterns = [
  /PGPASSWORD=[^\s]+/giu,
  /better-agent-test-[A-Za-z0-9_-]+/gu,
  /ba1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/gu,
];

function redact(value) {
  let redacted = value;
  for (const pattern of redactedPatterns) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted;
}

export function createPostgresHarness(suiteName) {
  const runId = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const projectName = `better-agent-${suiteName}-${runId}`.toLowerCase();
  const composeArguments = ['compose', '--file', composeFile, '--project-name', projectName];

  function run(command, arguments_, options = {}) {
    const { allowFailure = false, input } = options;
    return new Promise((resolve, reject) => {
      const child = spawn(command, arguments_, {
        cwd: harnessDirectory,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (error) => reject(error));
      child.on('close', (exitCode) => {
        const result = {
          exitCode,
          stderr: redact(Buffer.concat(stderr).toString('utf8')),
          stdout: redact(Buffer.concat(stdout).toString('utf8')),
        };
        if (exitCode === 0 || allowFailure) {
          resolve(result);
          return;
        }
        reject(
          new Error(
            `${redact(command)} ${redact(arguments_.join(' '))} failed (${String(exitCode)}): ${result.stderr}`,
          ),
        );
      });
      child.stdin.end(input ?? '');
    });
  }

  function compose(...arguments_) {
    return run('docker', [...composeArguments, ...arguments_]);
  }

  function psql(role, sql, options = {}) {
    const { allowFailure = false, echoErrors = false, tuplesOnly = false } = options;
    const arguments_ = [
      ...composeArguments,
      'exec',
      '--no-TTY',
      'postgres',
      'psql',
      '--no-psqlrc',
      '--quiet',
      '--set=ON_ERROR_STOP=1',
      '--set=VERBOSITY=verbose',
      '--username',
      role,
      '--dbname',
      'better_agent_test',
    ];
    if (echoErrors) arguments_.push('--echo-errors');
    if (tuplesOnly) arguments_.push('--tuples-only', '--no-align');
    return run('docker', arguments_, { allowFailure, input: sql });
  }

  async function queryScalar(role, sql) {
    const result = await psql(role, sql, { tuplesOnly: true });
    return result.stdout.trim();
  }

  return Object.freeze({
    compose,
    logs: () => compose('logs', '--no-color', 'postgres'),
    projectName,
    psql,
    queryScalar,
    start: () =>
      compose(
        'up',
        '--detach',
        '--force-recreate',
        '--renew-anon-volumes',
        '--wait',
        '--wait-timeout',
        '60',
      ),
    stop: () => compose('down', '--remove-orphans', '--volumes'),
  });
}

export function assertEqual(actual, expected, context) {
  if (actual !== expected) {
    throw new Error(`${context}: expected ${expected}, received ${actual}`);
  }
}

export function assertRejected(result, expectedPattern, context) {
  if (result.exitCode === 0 || !expectedPattern.test(result.stderr)) {
    throw new Error(
      `${context}: expected a rejected PostgreSQL operation, received ${result.stderr}`,
    );
  }
}
