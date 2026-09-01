import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const COMMAND_KILL_GRACE_MS = 5_000;
export const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

export function architectureGateError(message, options) {
  return new Error(`architecture gate: ${message}`, options);
}

export function sha256Bytes(bytes) {
  if (!Buffer.isBuffer(bytes)) throw architectureGateError('SHA-256 input must be a Buffer');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function createGateEnvironment(source = process.env) {
  const environment = {};
  const allowed = new Set([
    'ALLUSERSPROFILE',
    'APPDATA',
    'CI',
    'COLORTERM',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'COMMONPROGRAMW6432',
    'FORCE_COLOR',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOCALAPPDATA',
    'NO_COLOR',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PNPM_HOME',
    'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'SHELL',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TERM',
    'TMP',
    'TMPDIR',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && allowed.has(key.toUpperCase())) environment[key] = value;
  }
  environment.NPM_CONFIG_USERCONFIG = devNull;
  environment.TURBO_TELEMETRY_DISABLED = '1';
  return environment;
}

export function createGitEnvironment(source = process.env) {
  return {
    ...createGateEnvironment(source),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function terminateChildTree(child, force = false) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null) return;
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    const terminator = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      env: createGateEnvironment(),
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    terminator.unref();
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}

export function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env ?? createGateEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let outputBoundaryExceeded = false;
    let timedOut = false;
    let forceKillTimer;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? COMMAND_KILL_GRACE_MS;
    const beginTermination = (force = false) => {
      terminateChildTree(child, force);
      if (!force && forceKillTimer === undefined) {
        forceKillTimer = setTimeout(() => terminateChildTree(child, true), killGraceMs);
        forceKillTimer.unref();
      }
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, timeoutMs);
    timeoutTimer.unref();
    const consume = (stream, destination, chunks) => {
      stream.on('data', (chunk) => {
        const bytes = Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          outputBoundaryExceeded = true;
          beginTermination();
          return;
        }
        chunks.push(bytes);
        if (options.streamOutput === true) destination.write(bytes);
      });
    };
    consume(child.stdout, process.stdout, stdoutChunks);
    consume(child.stderr, process.stderr, stderrChunks);
    child.once('error', (error) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(architectureGateError(`cannot start ${command}: ${error.message}`, { cause: error }));
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const output = Buffer.concat([stdout, stderr]);
      if (timedOut) {
        reject(architectureGateError(`${command} timed out after ${String(timeoutMs)} ms`));
        return;
      }
      if (outputBoundaryExceeded) {
        reject(architectureGateError(`${command} exceeded the 16 MiB output boundary`));
        return;
      }
      resolve({ exitCode: exitCode ?? -1, output, stderr, stdout, signal: signal ?? null });
    });
  });
}

export async function runRequired(command, args, options = {}) {
  const result = await spawnCapture(command, args, options);
  if (result.exitCode !== 0) {
    const output = result.output.toString('utf8').trim();
    const outputTail = output.length > 8192 ? output.slice(-8192) : output;
    throw architectureGateError(
      `${options.context ?? command} failed with exit code ${String(result.exitCode)}${
        result.signal === null ? '' : ` and signal ${result.signal}`
      }${outputTail.length === 0 ? '' : `\n${outputTail}`}`,
    );
  }
  return result;
}

export function pnpmCommand(args) {
  if (process.platform === 'win32') {
    if (args.some((argument) => /[&|<>()^%!"\r\n]/u.test(argument))) {
      throw architectureGateError('pnpm argument contains a Windows command metacharacter');
    }
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    };
  }
  return { command: 'pnpm', args };
}

export async function runPnpm(args, options = {}) {
  const invocation = pnpmCommand(args, options.env);
  return runRequired(invocation.command, invocation.args, options);
}

export function parsePnpmStoreRoot(storePath) {
  if (typeof storePath !== 'string' || storePath.length === 0 || storePath !== storePath.trim()) {
    throw architectureGateError('pnpm returned an invalid versioned store path');
  }
  const pathImplementation = /^(?:[a-z]:[\\/]|\\\\)/iu.test(storePath) ? path.win32 : path.posix;
  if (
    !pathImplementation.isAbsolute(storePath) ||
    !/^v\d+$/u.test(pathImplementation.basename(storePath))
  ) {
    throw architectureGateError('pnpm returned an invalid versioned store path');
  }
  return pathImplementation.dirname(storePath);
}

export async function validatePnpmStorePath(storePath, inspectPath = lstat) {
  const storeRoot = parsePnpmStoreRoot(storePath);
  const storeStat = await inspectPath(storePath);
  if (!storeStat.isDirectory()) {
    throw architectureGateError('pnpm store path is not a directory');
  }
  return storeRoot;
}

export async function resolvePnpmStoreRoot(root, environment = createGateEnvironment()) {
  const result = await runPnpm(['store', 'path', '--silent'], {
    cwd: root,
    context: 'pnpm store path',
    env: environment,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  const storePath = result.stdout.toString('utf8').trim();
  return validatePnpmStorePath(storePath);
}

export async function gitBytes(root, args) {
  const safeArgs = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args];
  return (
    await runRequired('git', safeArgs, {
      cwd: root,
      context: `git ${args.join(' ')}`,
      env: createGitEnvironment(),
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    })
  ).output;
}

export async function gitStatus(root) {
  return gitBytes(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
}

async function gitHead(root) {
  return (await gitBytes(root, ['rev-parse', 'HEAD'])).toString('utf8').trim();
}

async function gitBranch(root) {
  return (await gitBytes(root, ['rev-parse', '--symbolic-full-name', 'HEAD']))
    .toString('utf8')
    .trim();
}

async function gitTree(root) {
  return (await gitBytes(root, ['rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
}

async function gitIndexSha256(root) {
  const indexPathValue = (await gitBytes(root, ['rev-parse', '--git-path', 'index']))
    .toString('utf8')
    .trim();
  const indexPath = path.isAbsolute(indexPathValue)
    ? indexPathValue
    : path.resolve(root, indexPathValue);
  return sha256Bytes(await readFile(indexPath));
}

export function manifestSummary(manifest) {
  return Object.freeze({
    digest: manifest.digest,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
  });
}

export async function captureRepositoryIdentity(root, sourceManifest, controlPlaneManifest) {
  const status = await gitStatus(root);
  return Object.freeze({
    branch: await gitBranch(root),
    head: await gitHead(root),
    tree: await gitTree(root),
    indexSha256: await gitIndexSha256(root),
    statusSha256: sha256Bytes(status),
    sourceManifest: manifestSummary(sourceManifest),
    controlPlaneManifest: manifestSummary(controlPlaneManifest),
  });
}

export function assertRepositoryIdentityUnchanged(before, after) {
  for (const field of ['branch', 'head', 'tree', 'indexSha256', 'statusSha256']) {
    if (before[field] !== after[field]) {
      throw architectureGateError(`repository ${field} identity changed`);
    }
  }
  for (const field of ['digest', 'fileCount', 'totalBytes']) {
    if (before.sourceManifest[field] !== after.sourceManifest[field]) {
      throw architectureGateError(`repository source manifest ${field} changed`);
    }
    if (before.controlPlaneManifest[field] !== after.controlPlaneManifest[field]) {
      throw architectureGateError(`repository control-plane manifest ${field} changed`);
    }
  }
}

export function assertCleanStatus(status, context) {
  if (status.length !== 0) throw architectureGateError(`${context} is not a clean checkout`);
}

export function errorSummary(error) {
  if (error instanceof AggregateError) {
    return `${error.message}: ${[...error.errors].map(errorSummary).join(' | ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function combineGateErrors(errors) {
  const present = errors.filter((error) => error !== undefined && error !== null);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return new AggregateError(
    present,
    `architecture gate: ${String(present.length)} failures occurred`,
  );
}
