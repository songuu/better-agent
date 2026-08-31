#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkGeneratedContract } from '../packages/api-contract/src/contract-toolchain.mjs';
import {
  canonicalSha256,
  validateArchitectureGateManifest,
  validateArchitectureInventory,
  validateGateResults,
} from './architecture-gate-core.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_PREFIX = 'better-agent-g0-08-';
const TEST_SOURCE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const CONDITIONAL_TEST_PATTERN = /\b(?:describe|it|test)\.(?:only|runIf|skip|skipIf|todo)\b/gu;

function architectureGateError(message, options) {
  return new Error(`architecture gate: ${message}`, options);
}

export function validateSnapshotRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\\') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    throw architectureGateError(
      `snapshot path is not a safe repository-relative path: ${String(value)}`,
    );
  }
  const segments = value.split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    segments[0]?.toLowerCase() === '.git'
  ) {
    throw architectureGateError(`snapshot path escapes or targets Git metadata: ${value}`);
  }
  return value;
}

export function parseGitPathList(bytes) {
  if (!Buffer.isBuffer(bytes)) throw architectureGateError('Git path list must be a Buffer');
  const paths = bytes
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0)
    .map(validateSnapshotRelativePath)
    .filter((value) => {
      const normalized = value.toLowerCase();
      return (
        normalized !== 'docs/plans/.handoff' &&
        !normalized.startsWith('docs/plans/.handoff/') &&
        !normalized.endsWith('.acceptance.json')
      );
    });
  if (new Set(paths).size !== paths.length) {
    throw architectureGateError('Git path list contains duplicate entries');
  }
  return paths;
}

export function createSourceManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw architectureGateError('source manifest requires at least one file');
  }
  const normalized = entries
    .map((entry) => {
      if (entry === null || typeof entry !== 'object' || !Buffer.isBuffer(entry.bytes)) {
        throw architectureGateError('source manifest entries require path and Buffer bytes');
      }
      return { path: validateSnapshotRelativePath(entry.path), bytes: entry.bytes };
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (
    new Set(normalized.map(({ path: relativePath }) => relativePath)).size !== normalized.length
  ) {
    throw architectureGateError('source manifest contains duplicate paths');
  }
  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const entry of normalized) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    hash.update(Buffer.from(`${pathBytes.length}:`, 'ascii'));
    hash.update(pathBytes);
    hash.update(Buffer.from(`${entry.bytes.length}:`, 'ascii'));
    hash.update(entry.bytes);
    totalBytes += entry.bytes.length;
  }
  return Object.freeze({
    digest: `sha256:${hash.digest('hex')}`,
    fileCount: normalized.length,
    paths: Object.freeze(normalized.map(({ path: relativePath }) => relativePath)),
    totalBytes,
  });
}

export function assertSourceStatusUnchanged(before, after) {
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after) || !before.equals(after)) {
    throw architectureGateError('source Git status changed while the disposable gate was running');
  }
}

export function assertStableSnapshotFileIdentity(before, after, relativePath) {
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.nlink !== 1
  ) {
    throw architectureGateError(
      `source snapshot requires a single-link regular file: ${relativePath}`,
    );
  }
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
    if (String(before[field]) !== String(after[field])) {
      throw architectureGateError(`source file changed while reading: ${relativePath}`);
    }
  }
}

function resolveInside(root, relativePath) {
  const safePath = validateSnapshotRelativePath(relativePath);
  const absolute = path.resolve(root, ...safePath.split('/'));
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw architectureGateError(`snapshot path escaped repository root: ${safePath}`);
  }
  return absolute;
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let outputBytes = 0;
    const consume = (stream, destination) => {
      stream.on('data', (chunk) => {
        const bytes = Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill();
          return;
        }
        chunks.push(bytes);
        if (options.streamOutput === true) destination.write(bytes);
      });
    };
    consume(child.stdout, process.stdout);
    consume(child.stderr, process.stderr);
    child.once('error', (error) => {
      reject(architectureGateError(`cannot start ${command}: ${error.message}`, { cause: error }));
    });
    child.once('close', (exitCode, signal) => {
      const output = Buffer.concat(chunks);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        reject(architectureGateError(`${command} exceeded the 64 MiB output boundary`));
        return;
      }
      resolve({
        exitCode: exitCode ?? -1,
        output,
        signal: signal ?? null,
      });
    });
  });
}

async function runRequired(command, args, options = {}) {
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

function pnpmCommand(args, env = process.env) {
  const npmExecPath = env.npm_execpath;
  if (
    typeof npmExecPath === 'string' &&
    npmExecPath.length > 0 &&
    existsSync(npmExecPath) &&
    /pnpm(?:\.c?js)?$/iu.test(npmExecPath)
  ) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}

async function runPnpm(args, options = {}) {
  const invocation = pnpmCommand(args, options.env);
  return runRequired(invocation.command, invocation.args, options);
}

async function gitBytes(root, args) {
  return (await runRequired('git', args, { cwd: root, context: `git ${args.join(' ')}` })).output;
}

async function gitStatus(root) {
  return gitBytes(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
}

async function gitHead(root) {
  return (await gitBytes(root, ['rev-parse', 'HEAD'])).toString('utf8').trim();
}

async function gitIndexDiff(root) {
  return gitBytes(root, ['diff', '--cached', '--binary', '--no-ext-diff']);
}

function assertCleanStatus(status, context) {
  if (status.length !== 0) {
    throw architectureGateError(`${context} is not a clean checkout`);
  }
}

async function readJson(file, context) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw architectureGateError(`${context} is not valid JSON: ${error.message}`, { cause: error });
  }
}

async function listTestSources(directory) {
  const sources = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.turbo', 'coverage'].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && TEST_SOURCE_PATTERN.test(entry.name)) {
        sources.push(absolute);
      }
    }
  };
  await visit(directory);
  return sources.sort();
}

async function findConditionalTestLocations(root) {
  const roots = ['apps', 'packages', 'infra/test/postgres'];
  const locations = [];
  for (const relativeRoot of roots) {
    const absoluteRoot = path.join(root, ...relativeRoot.split('/'));
    for (const file of await listTestSources(absoluteRoot)) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(CONDITIONAL_TEST_PATTERN)) {
        const line = source.slice(0, match.index).split(/\r?\n/u).length;
        locations.push(`${path.relative(root, file).replaceAll('\\', '/')}:${String(line)}`);
      }
    }
  }
  return locations.sort();
}

async function collectRepositoryInventory(root) {
  const rootPackage = await readJson(path.join(root, 'package.json'), 'root package.json');
  const dbPackage = await readJson(
    path.join(root, 'packages', 'db', 'package.json'),
    'DB package.json',
  );
  const migrationFiles = (
    await readdir(path.join(root, 'packages', 'db', 'migrations'), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map(({ name }) => name)
    .sort();
  const postgresSuiteFiles = (
    await readdir(path.join(root, 'infra', 'test', 'postgres'), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && /^run(?:-[a-z0-9]+)*-integration\.mjs$/u.test(entry.name))
    .map(({ name }) => `infra/test/postgres/${name}`)
    .sort();
  const contract = await checkGeneratedContract({
    outputDir: path.join(root, 'packages', 'api-contract', 'generated'),
    sourcePath: path.join(root, 'docs', 'api', 'openapi.yaml'),
  });
  const openapi = {
    operationIds: contract.operationIds,
    localReferenceCount: contract.localReferenceCount,
    bundleSha256: contract.bundleSha256,
    typescriptSha256: contract.typescriptSha256,
    responseBaselineSha256: contract.responseBaselineSha256,
    credentialOperationPolicyBaselineSha256: contract.credentialOperationPolicyBaselineSha256,
  };
  return {
    rootScripts: {
      architectureGate: rootPackage.scripts?.['architecture:gate'],
      check: rootPackage.scripts?.check,
      postgres16: rootPackage.scripts?.['db:test:postgres16'],
    },
    dbIntegrationScript: dbPackage.scripts?.['test:integration'],
    migrationFiles,
    postgresSuiteFiles,
    conditionalSkipLocations: await findConditionalTestLocations(root),
    openapi,
  };
}

async function readManifest(root) {
  const manifestPath = path.join(root, 'tests', 'architecture-gate', 'manifest.json');
  return validateArchitectureGateManifest(
    await readJson(manifestPath, 'architecture gate manifest'),
  );
}

async function runInternalGate(root, sourceManifest = 'sha256:clean-checkout') {
  const statusBefore = await gitStatus(root);
  assertCleanStatus(statusBefore, 'architecture gate execution root');
  const manifest = await readManifest(root);
  const inventory = await collectRepositoryInventory(root);
  const inventoryResult = validateArchitectureInventory(manifest, inventory);

  await runRequired(
    process.execPath,
    ['--test', '--test-isolation=none', 'tests/architecture-gate/architecture-gate.test.mjs'],
    { cwd: root, context: 'architecture gate mutation tests', streamOutput: true },
  );

  const results = [];
  for (const gate of manifest.gates) {
    const startedAt = Date.now();
    const invocation = pnpmCommand(gate.args);
    const result = await spawnCapture(invocation.command, invocation.args, {
      cwd: root,
      streamOutput: true,
    });
    results.push({
      id: gate.id,
      exitCode: result.exitCode,
      output: result.output.toString('utf8'),
      durationMs: Date.now() - startedAt,
    });
    if (result.exitCode !== 0) {
      throw architectureGateError(
        `gate ${gate.id} failed with exit code ${String(result.exitCode)}`,
      );
    }
  }
  const resultSummary = validateGateResults(manifest, results);
  const statusAfter = await gitStatus(root);
  assertCleanStatus(statusAfter, 'architecture gate execution root after all gates');
  const report = {
    schemaVersion: 'architecture-gate-report/1',
    sourceManifest,
    gateManifest: inventoryResult.manifestHash,
    gates: results.map(({ id, exitCode, output, durationMs }) => ({
      id,
      exitCode,
      durationMs,
      outputSha256: canonicalSha256(output),
    })),
    cleanBefore: true,
    cleanAfter: true,
    result: resultSummary.ok ? 'pass' : 'fail',
  };
  process.stdout.write(`Architecture gate report: ${JSON.stringify(report)}\n`);
  return report;
}

async function sourceEntries(root, paths) {
  const entries = [];
  for (const relativePath of paths) {
    const entry = await readStableSnapshotEntry(root, relativePath);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

export async function readStableSnapshotEntry(root, relativePath) {
  const absolute = resolveInside(root, relativePath);
  let before;
  try {
    before = await lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw architectureGateError(`cannot inspect source file ${relativePath}: ${error.message}`, {
      cause: error,
    });
  }
  assertStableSnapshotFileIdentity(before, before, relativePath);
  let handle;
  try {
    handle = await open(absolute, 'r');
    const opened = await handle.stat();
    assertStableSnapshotFileIdentity(before, opened, relativePath);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertStableSnapshotFileIdentity(opened, after, relativePath);
    return { path: relativePath, bytes };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('architecture gate:')) throw error;
    throw architectureGateError(
      `cannot read stable source file ${relativePath}: ${error.message}`,
      {
        cause: error,
      },
    );
  } finally {
    await handle?.close();
  }
}

async function copyEntries(destinationRoot, entries) {
  for (const entry of entries) {
    const destination = resolveInside(destinationRoot, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes, { flag: 'wx' });
  }
}

function assertDisposableDirectory(directory) {
  const temporaryRoot = path.resolve(tmpdir());
  const resolved = path.resolve(directory);
  const relative = path.relative(temporaryRoot, resolved);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== '.' ||
    !path.basename(resolved).startsWith(SNAPSHOT_PREFIX)
  ) {
    throw architectureGateError(`refusing to clean an unverified temporary directory: ${resolved}`);
  }
}

async function runDisposableGate(sourceRoot, sourceStatusBefore) {
  const sourceHeadBefore = await gitHead(sourceRoot);
  const sourceIndexBefore = await gitIndexDiff(sourceRoot);
  const fileList = parseGitPathList(
    await gitBytes(sourceRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
  );
  const entries = await sourceEntries(sourceRoot, fileList);
  const sourceManifest = createSourceManifest(entries);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), SNAPSHOT_PREFIX));
  assertDisposableDirectory(temporaryDirectory);

  let primaryError;
  try {
    await copyEntries(temporaryDirectory, entries);
    await runRequired('git', ['init', '--quiet'], {
      cwd: temporaryDirectory,
      context: 'temporary git init',
    });
    await runRequired('git', ['add', '--all'], {
      cwd: temporaryDirectory,
      context: 'temporary git add',
    });
    await runRequired(
      'git',
      [
        '-c',
        'user.name=better-agent architecture gate',
        '-c',
        'user.email=architecture-gate@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'test: materialize disposable architecture gate snapshot',
      ],
      { cwd: temporaryDirectory, context: 'temporary git commit' },
    );
    assertCleanStatus(await gitStatus(temporaryDirectory), 'materialized architecture snapshot');
    await runPnpm(['install', '--offline', '--frozen-lockfile'], {
      cwd: temporaryDirectory,
      context: 'offline dependency materialization',
      streamOutput: true,
    });
    assertCleanStatus(
      await gitStatus(temporaryDirectory),
      'materialized architecture snapshot after dependency installation',
    );
    await runRequired(
      process.execPath,
      ['scripts/architecture-gate.mjs', '--internal', sourceManifest.digest],
      {
        cwd: temporaryDirectory,
        context: 'disposable clean-checkout architecture gate',
        streamOutput: true,
      },
    );
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      const sourceStatusAfter = await gitStatus(sourceRoot);
      const sourceHeadAfter = await gitHead(sourceRoot);
      const sourceIndexAfter = await gitIndexDiff(sourceRoot);
      assertSourceStatusUnchanged(sourceStatusBefore, sourceStatusAfter);
      if (sourceHeadAfter !== sourceHeadBefore || !sourceIndexAfter.equals(sourceIndexBefore)) {
        primaryError ??= architectureGateError(
          'source HEAD or index changed while the disposable gate was running',
        );
      }
    } catch (error) {
      primaryError ??= error;
    }
    try {
      assertDisposableDirectory(temporaryDirectory);
      await rm(temporaryDirectory, { force: true, recursive: true });
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  process.stdout.write(
    `Disposable clean checkout passed: ${sourceManifest.fileCount} files, ` +
      `${String(sourceManifest.totalBytes)} bytes, source ${sourceManifest.digest}.\n`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const internal = argv[0] === '--internal';
  const sourceManifest = argv[1] ?? 'sha256:clean-checkout';
  if (
    (!internal && argv.length !== 0) ||
    (internal && argv.length > 2) ||
    !/^sha256:(?:[a-f0-9]{64}|clean-checkout)$/u.test(sourceManifest)
  ) {
    throw architectureGateError(
      'usage: node scripts/architecture-gate.mjs [--internal [sha256:<digest>]]',
    );
  }
  const sourceStatus = await gitStatus(REPOSITORY_ROOT);
  if (internal) {
    assertCleanStatus(sourceStatus, 'internal architecture gate root');
    await runInternalGate(REPOSITORY_ROOT, sourceManifest);
    return;
  }
  if (sourceStatus.length === 0) {
    await runInternalGate(REPOSITORY_ROOT);
    return;
  }
  await runDisposableGate(REPOSITORY_ROOT, sourceStatus);
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
