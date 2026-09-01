import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(harnessDirectory, 'compose.yaml');
const redactedPatterns = [
  /PGPASSWORD=[^\s]+/giu,
  /better-agent-test-[A-Za-z0-9_-]+/gu,
  /ba1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/gu,
];
const defaultPollIntervalMs = 25;
const defaultWaitTimeoutMs = 5_000;
const maxHarnessOutputBytes = 16 * 1024 * 1024;
const postgresRegistryPrefix = 'better-agent-g0-08-pg-';

function redact(value) {
  let redacted = value;
  for (const pattern of redactedPatterns) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted;
}

export function createBoundedOutputCapture(maxBytes = maxHarnessOutputBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('PostgreSQL harness output boundary must be a positive safe integer');
  }
  const chunks = { stderr: [], stdout: [] };
  let exceeded = false;
  let totalBytes = 0;
  return Object.freeze({
    append(channel, chunk) {
      if (!(channel in chunks)) throw new Error(`unknown PostgreSQL output channel: ${channel}`);
      if (exceeded) return false;
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        return false;
      }
      chunks[channel].push(bytes);
      return true;
    },
    buffer(channel) {
      if (!(channel in chunks)) throw new Error(`unknown PostgreSQL output channel: ${channel}`);
      return Buffer.concat(chunks[channel]);
    },
    get exceeded() {
      return exceeded;
    },
    get totalBytes() {
      return totalBytes;
    },
  });
}

function postgresRegistryPath(environment = process.env) {
  const registryValue = environment.BA_POSTGRES_PROJECT_REGISTRY;
  if (registryValue === undefined) return undefined;
  const registryPath = path.resolve(registryValue);
  const temporaryRoot = path.resolve(tmpdir());
  const relative = path.relative(temporaryRoot, registryPath);
  if (
    relative.length === 0 ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !path.basename(registryPath).startsWith(postgresRegistryPrefix) ||
    path.extname(registryPath) !== '.txt'
  ) {
    throw new Error('PostgreSQL project registry must be a dedicated temporary file');
  }
  return registryPath;
}

function registerPostgresProject(projectName, environment = process.env) {
  const registryPath = postgresRegistryPath(environment);
  if (registryPath === undefined) return undefined;
  appendFileSync(registryPath, `${projectName}\n`, { encoding: 'utf8', flag: 'a' });
  return registryPath;
}

function unregisterPostgresProject(registryPath, projectName) {
  if (registryPath === undefined) return;
  const projects = readFileSync(registryPath, 'utf8')
    .split(/\r?\n/u)
    .filter((value) => value.length > 0 && value !== projectName);
  const replacementPath = `${registryPath}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(replacementPath, projects.length === 0 ? '' : `${projects.join('\n')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(replacementPath, registryPath);
  } finally {
    rmSync(replacementPath, { force: true });
  }
}

export function installPostgresSignalCleanup(stop, options = {}) {
  const processTarget = options.processTarget ?? process;
  const deadlineMs = options.deadlineMs ?? 30_000;
  let cleanupStarted = false;
  const cleanupOnSignal = (signal) => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    const deadline = setTimeout(() => processTarget.exit(exitCode), deadlineMs);
    deadline.unref?.();
    void Promise.resolve()
      .then(stop)
      .then(
        () => {
          clearTimeout(deadline);
          processTarget.exit(exitCode);
        },
        (error) => {
          clearTimeout(deadline);
          processTarget.stderr.write(
            `PostgreSQL harness signal cleanup failed: ${redact(String(error))}\n`,
          );
          processTarget.exit(exitCode);
        },
      );
  };
  const onSigint = () => cleanupOnSignal('SIGINT');
  const onSigterm = () => cleanupOnSignal('SIGTERM');
  processTarget.once('SIGINT', onSigint);
  processTarget.once('SIGTERM', onSigterm);
  return () => {
    processTarget.removeListener('SIGINT', onSigint);
    processTarget.removeListener('SIGTERM', onSigterm);
  };
}

function countOccurrences(buffer, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= buffer.length - needle.length) {
    const index = buffer.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function scanRawBuffers(stdout, stderr, scanFor = []) {
  let stdoutCount = 0;
  let stderrCount = 0;
  for (const value of scanFor) {
    const needle = Buffer.isBuffer(value) ? value : Buffer.from(value);
    stdoutCount += countOccurrences(stdout, needle);
    stderrCount += countOccurrences(stderr, needle);
  }
  const count = stdoutCount + stderrCount;
  return Object.freeze({
    count,
    leakDetected: count > 0,
    source:
      stdoutCount > 0 && stderrCount > 0
        ? 'stdout+stderr'
        : stdoutCount > 0
          ? 'stdout'
          : stderrCount > 0
            ? 'stderr'
            : 'none',
  });
}

function waitForDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createPostgresHarness(suiteName) {
  const runId = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const projectName = `better-agent-${suiteName}-${runId}`.toLowerCase();
  const projectRegistry = registerPostgresProject(projectName);
  const composeArguments = ['compose', '--file', composeFile, '--project-name', projectName];
  let stopPromise;

  function run(command, arguments_, options = {}) {
    const { allowFailure = false, input, scanFor = [] } = options;
    return new Promise((resolve, reject) => {
      const child = spawn(command, arguments_, {
        cwd: harnessDirectory,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output = createBoundedOutputCapture();
      const capture = (channel, chunk) => {
        if (!output.append(channel, chunk)) child.kill('SIGKILL');
      };
      child.stdout.on('data', (chunk) => capture('stdout', chunk));
      child.stderr.on('data', (chunk) => capture('stderr', chunk));
      child.on('error', (error) => reject(error));
      child.on('close', (exitCode) => {
        if (output.exceeded) {
          reject(new Error('PostgreSQL harness child exceeded the 16 MiB output boundary'));
          return;
        }
        const rawStdout = output.buffer('stdout');
        const rawStderr = output.buffer('stderr');
        const result = {
          exitCode,
          rawScan: scanRawBuffers(rawStdout, rawStderr, scanFor),
          stderr: redact(rawStderr.toString('utf8')),
          stdout: redact(rawStdout.toString('utf8')),
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

  function stop() {
    stopPromise ??= compose('down', '--remove-orphans', '--volumes').then((result) => {
      unregisterPostgresProject(projectRegistry, projectName);
      return result;
    });
    return stopPromise;
  }
  installPostgresSignalCleanup(stop);

  function psqlArguments(role, options = {}) {
    const { applicationName, echoErrors = false, tuplesOnly = false } = options;
    const database =
      applicationName === undefined
        ? 'better_agent_test'
        : `postgresql:///better_agent_test?application_name=${encodeURIComponent(applicationName)}`;
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
      database,
    ];
    if (echoErrors) arguments_.push('--echo-errors');
    if (tuplesOnly) arguments_.push('--tuples-only', '--no-align');
    return arguments_;
  }

  function psql(role, sql, options = {}) {
    const { allowFailure = false, scanFor = [] } = options;
    return run('docker', psqlArguments(role, options), { allowFailure, input: sql, scanFor });
  }

  async function queryScalar(role, sql) {
    const result = await psql(role, sql, { tuplesOnly: true });
    return result.stdout.trim();
  }

  function openInteractivePsql(role, options = {}) {
    const {
      applicationName = `better-agent-${suiteName}-${randomBytes(4).toString('hex')}`,
      scanFor = [],
    } = options;
    const child = spawn('docker', psqlArguments(role, { applicationName, tuplesOnly: true }), {
      cwd: harnessDirectory,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = createBoundedOutputCapture();
    let stdoutText = '';
    let readOffset = 0;
    let closed = false;
    let exited = false;
    let spawnError;
    let exitCode;
    const waiters = new Set();

    const settleWaiters = () => {
      for (const waiter of waiters) waiter();
    };
    const exceedOutputBoundary = () => {
      spawnError ??= new Error('interactive psql exceeded the 16 MiB output boundary');
      if (!exited) child.kill('SIGKILL');
      settleWaiters();
    };
    child.stdout.on('data', (chunk) => {
      if (!output.append('stdout', chunk)) {
        exceedOutputBoundary();
        return;
      }
      stdoutText += chunk.toString('utf8');
      settleWaiters();
    });
    child.stderr.on('data', (chunk) => {
      if (!output.append('stderr', chunk)) {
        exceedOutputBoundary();
        return;
      }
      settleWaiters();
    });
    child.on('error', (error) => {
      spawnError = error;
      settleWaiters();
    });
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      settleWaiters();
    });
    child.on('close', (code) => {
      exited = true;
      closed = true;
      exitCode = code;
      settleWaiters();
    });

    async function waitUntil(predicate, timeoutMs, context, waitOptions = {}) {
      const { allowExited = false } = waitOptions;
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (spawnError !== undefined) throw spawnError;
        if (closed || (exited && !allowExited)) {
          if (predicate()) break;
          throw new Error(
            `${context}: interactive psql exited (${String(exitCode)}): ${redact(output.buffer('stderr').toString('utf8'))}`,
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          if (predicate()) break;
          throw new Error(`${context}: timed out after ${String(timeoutMs)}ms`);
        }
        await new Promise((resolve) => {
          const onActivity = () => {
            clearTimeout(timeout);
            waiters.delete(onActivity);
            resolve();
          };
          const timeout = setTimeout(onActivity, Math.min(remaining, 100));
          waiters.add(onActivity);
        });
      }
    }

    async function execute(sql, executeOptions = {}) {
      const disconnectOnFailure = executeOptions.disconnectOnFailure ?? true;
      const timeoutMs = executeOptions.timeoutMs ?? defaultWaitTimeoutMs;
      if (exited || closed || child.stdin.destroyed) throw new Error('interactive psql is closed');
      const marker = `ba_marker_${randomBytes(12).toString('hex')}`;
      const startOffset = readOffset;
      child.stdin.write(`${sql.trimEnd()}\n\\echo ${marker}\n`);
      try {
        await waitUntil(
          () => stdoutText.indexOf(marker, startOffset) >= 0,
          timeoutMs,
          'interactive psql marker',
        );
      } catch (error) {
        if (disconnectOnFailure) await abruptDisconnect();
        throw error;
      }
      const markerOffset = stdoutText.indexOf(marker, startOffset);
      const output = stdoutText.slice(startOffset, markerOffset);
      readOffset = markerOffset + marker.length;
      while (stdoutText[readOffset] === '\r' || stdoutText[readOffset] === '\n') readOffset += 1;
      if (readOffset >= 64 * 1024) {
        stdoutText = stdoutText.slice(readOffset);
        readOffset = 0;
      }
      return redact(output.trim());
    }

    async function backendPid() {
      const value = await execute('SELECT pg_backend_pid();');
      const pid = Number.parseInt(value.trim(), 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`interactive psql returned an invalid backend pid: ${redact(value)}`);
      }
      return pid;
    }

    async function waitForExit(timeoutMs = defaultWaitTimeoutMs) {
      await waitUntil(() => exited, timeoutMs, 'interactive psql exit');
      return exitCode;
    }

    async function close() {
      if (!exited && !closed && !child.stdin.destroyed) child.stdin.end('\\quit\n');
      try {
        await waitUntil(() => closed, defaultWaitTimeoutMs, 'interactive psql close', {
          allowExited: true,
        });
      } catch (error) {
        await abruptDisconnect();
        throw error;
      }
      return metadata();
    }

    async function abruptDisconnect() {
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (!exited) child.kill();
      try {
        await waitForExit();
      } catch {
        if (!exited) {
          child.kill('SIGKILL');
          await waitForExit();
        }
      }
      return metadata();
    }

    function metadata() {
      return Object.freeze({
        applicationName,
        exitCode,
        rawScan: scanRawBuffers(output.buffer('stdout'), output.buffer('stderr'), scanFor),
        stderr: redact(output.buffer('stderr').toString('utf8')),
      });
    }

    return Object.freeze({
      abruptDisconnect,
      applicationName,
      backendPid,
      close,
      execute,
      metadata,
      waitForExit,
    });
  }

  async function waitForDatabaseCondition(sql, options = {}) {
    const {
      context = 'database condition',
      intervalMs = defaultPollIntervalMs,
      role = 'ba_bootstrap_test',
      timeoutMs = defaultWaitTimeoutMs,
    } = options;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if ((await queryScalar(role, sql)) === 't') return;
      await waitForDelay(intervalMs);
    }
    throw new Error(`${context}: timed out after ${String(timeoutMs)}ms`);
  }

  async function waitForBlockingEdge(blockedPid, blockingPid, options = {}) {
    if (!Number.isSafeInteger(blockedPid) || blockedPid <= 0) {
      throw new Error('blocked backend pid must be a positive safe integer');
    }
    if (!Number.isSafeInteger(blockingPid) || blockingPid <= 0) {
      throw new Error('blocking backend pid must be a positive safe integer');
    }
    await waitForDatabaseCondition(
      `SELECT ${String(blockingPid)} = ANY (pg_catalog.pg_blocking_pids(${String(blockedPid)}));`,
      { ...options, context: options.context ?? 'PostgreSQL blocking edge' },
    );
  }

  async function waitForBackendExit(backendPid, options = {}) {
    if (!Number.isSafeInteger(backendPid) || backendPid <= 0) {
      throw new Error('backend pid must be a positive safe integer');
    }
    await waitForDatabaseCondition(
      `SELECT NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = ${String(backendPid)}
);`,
      { ...options, context: options.context ?? 'PostgreSQL backend exit' },
    );
  }

  async function terminateBackend(backendPid) {
    if (!Number.isSafeInteger(backendPid) || backendPid <= 0) {
      throw new Error('backend pid must be a positive safe integer');
    }
    return queryScalar(
      'ba_bootstrap_test',
      `SELECT pg_catalog.pg_terminate_backend(${String(backendPid)});`,
    );
  }

  async function cancelBackend(backendPid) {
    if (!Number.isSafeInteger(backendPid) || backendPid <= 0) {
      throw new Error('backend pid must be a positive safe integer');
    }
    return queryScalar(
      'ba_bootstrap_test',
      `SELECT pg_catalog.pg_cancel_backend(${String(backendPid)});`,
    );
  }

  return Object.freeze({
    cancelBackend,
    compose,
    logs: () => compose('logs', '--no-color', 'postgres'),
    openInteractivePsql,
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
    stop,
    terminateBackend,
    waitForBackendExit,
    waitForBlockingEdge,
    waitForDatabaseCondition,
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
