#!/usr/bin/env node

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
import {
  cleanupPostgresProjects,
  createPostgresProjectRegistry,
  postgresProjectRegistryForGate,
} from './architecture-gate-postgres.mjs';
import {
  architectureGateError,
  assertCleanStatus,
  assertRepositoryIdentityUnchanged,
  COMMAND_KILL_GRACE_MS,
  captureRepositoryIdentity,
  combineGateErrors,
  createGateEnvironment,
  createGitEnvironment,
  errorSummary,
  GIT_NULL_DEVICE,
  gitStatus,
  manifestSummary,
  parsePnpmStoreRoot,
  pnpmCommand,
  resolvePnpmStoreRoot,
  runPnpm,
  runRequired,
  sha256Bytes,
  spawnCapture,
  validatePnpmStorePath,
} from './architecture-gate-runtime.mjs';
import {
  architectureMutationTestArguments,
  assertDisposableDirectory,
  assertSnapshotBudget,
  assertSourceStatusUnchanged,
  assertStableSnapshotFileIdentity,
  attestationFor,
  collectSnapshotManifests,
  copyEntries,
  createSourceManifest,
  isControlPlanePath,
  parseGitPathList,
  readStableSnapshotEntry,
  SNAPSHOT_PREFIX,
  sourceEntries,
  validateSnapshotRelativePath,
} from './architecture-gate-snapshot.mjs';

export {
  architectureMutationTestArguments,
  assertRepositoryIdentityUnchanged,
  assertSnapshotBudget,
  assertSourceStatusUnchanged,
  assertStableSnapshotFileIdentity,
  captureRepositoryIdentity,
  cleanupPostgresProjects,
  collectSnapshotManifests,
  combineGateErrors,
  createGateEnvironment,
  createSourceManifest,
  isControlPlanePath,
  parseGitPathList,
  parsePnpmStoreRoot,
  pnpmCommand,
  readStableSnapshotEntry,
  resolvePnpmStoreRoot,
  sha256Bytes,
  spawnCapture,
  validatePnpmStorePath,
  validateSnapshotRelativePath,
};

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REPORT_GATE_IDS = Object.freeze(['mutation', 'quality', 'postgres16']);
const TEST_SOURCE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const CONDITIONAL_TEST_PATTERN = /\b(?:describe|it|test)\.(?:only|runIf|skip|skipIf|todo)\b/gu;

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

async function listRelativeFiles(directory, prefix) {
  const files = [];
  const visit = async (current, relativeDirectory) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push(`${prefix}/${relative}`);
      }
    }
  };
  await visit(directory, '');
  return files.sort();
}

async function findConditionalTestLocations(root) {
  const roots = ['apps', 'packages', 'infra/test/postgres', 'tests/architecture-gate'];
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

async function collectWorkspaceTests(root) {
  const workspaceTests = [];
  for (const relativeRoot of ['apps', 'packages']) {
    const absoluteRoot = path.join(root, relativeRoot);
    for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = await readJson(
        path.join(absoluteRoot, entry.name, 'package.json'),
        `${relativeRoot}/${entry.name}/package.json`,
      );
      workspaceTests.push({
        packageName: manifest.name,
        script: manifest.scripts?.test,
      });
    }
  }
  return workspaceTests.sort((left, right) => left.packageName.localeCompare(right.packageName));
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
  const postgresFiles = await listRelativeFiles(
    path.join(root, 'infra', 'test', 'postgres'),
    'infra/test/postgres',
  );
  const postgresSuiteFiles = postgresFiles.filter((file) =>
    /^infra\/test\/postgres\/run(?:-[a-z0-9]+)*-integration\.mjs$/u.test(file),
  );
  const postgresSupportFiles = postgresFiles.filter((file) => !postgresSuiteFiles.includes(file));
  const hashFiles = async (files) =>
    Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          sha256Bytes(await readFile(path.join(root, ...file.split('/')))).slice('sha256:'.length),
        ]),
      ),
    );
  const postgresSuiteSha256 = await hashFiles(postgresSuiteFiles);
  const postgresSupportSha256 = await hashFiles(postgresSupportFiles);
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
      architectureGateTest: rootPackage.scripts?.['architecture:gate:test'],
      check: rootPackage.scripts?.check,
      postgres16: rootPackage.scripts?.['db:test:postgres16'],
    },
    dbIntegrationScript: dbPackage.scripts?.['test:integration'],
    migrationFiles,
    postgresSuiteFiles,
    postgresSuiteSha256,
    postgresSupportFiles,
    postgresSupportSha256,
    workspaceTests: await collectWorkspaceTests(root),
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

function gateInvocation(gate, environment) {
  if (gate.command === 'node') {
    return { command: process.execPath, args: gate.args };
  }
  return pnpmCommand(gate.args, environment);
}

function sameManifest(left, right) {
  return ['digest', 'fileCount', 'totalBytes'].every((field) => left[field] === right[field]);
}

function assertExpectedManifest(actual, expected, context) {
  if (!sameManifest(manifestSummary(actual), expected)) {
    throw architectureGateError(`${context} source manifest does not match the attested input`);
  }
}

function gateReportResult(result, semanticPass) {
  return {
    id: result.id,
    status: result.exitCode === 0 && result.error === null && semanticPass ? 'pass' : 'fail',
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    stdoutBytes: result.stdout.length,
    stdoutSha256: sha256Bytes(result.stdout),
    stderrBytes: result.stderr.length,
    stderrSha256: sha256Bytes(result.stderr),
    error: result.error,
  };
}

async function runInternalGate(root, attestation, options = {}) {
  const statusBefore = await gitStatus(root);
  assertCleanStatus(statusBefore, 'architecture gate execution root');
  const snapshotsBefore = await collectSnapshotManifests(root);
  assertExpectedManifest(
    snapshotsBefore.productManifest,
    attestation.sourceManifest,
    'architecture gate execution root',
  );
  assertExpectedManifest(
    snapshotsBefore.controlPlaneManifest,
    attestation.controlPlaneManifest,
    'architecture gate execution root control-plane',
  );
  const identityBefore = await captureRepositoryIdentity(
    root,
    snapshotsBefore.productManifest,
    snapshotsBefore.controlPlaneManifest,
  );
  const results = [];
  let inventoryResult;
  let semanticPass = false;
  let executionError;
  let integrityError;
  let cleanAfter = false;
  try {
    const manifest = await readManifest(root);
    const manifestHash = canonicalSha256(manifest);
    if (manifestHash !== attestation.gateManifest) {
      throw architectureGateError('gate manifest does not match the attested input');
    }
    const inventory = await collectRepositoryInventory(root);
    inventoryResult = validateArchitectureInventory(manifest, inventory);
    const environment = createGateEnvironment();
    for (const gate of manifest.gates) {
      const startedAt = Date.now();
      const postgresRegistry =
        gate.id === 'postgres16'
          ? await postgresProjectRegistryForGate({
              acceptInherited: options.acceptInheritedPostgresRegistry === true,
            })
          : undefined;
      const gateEnvironment =
        postgresRegistry === undefined
          ? environment
          : { ...environment, BA_POSTGRES_PROJECT_REGISTRY: postgresRegistry };
      const invocation = gateInvocation(gate, gateEnvironment);
      let result;
      let commandError;
      let cleanupError;
      try {
        result = await spawnCapture(invocation.command, invocation.args, {
          cwd: root,
          env: gateEnvironment,
          killGraceMs: gate.id === 'postgres16' ? 30_000 : COMMAND_KILL_GRACE_MS,
          streamOutput: true,
          timeoutMs: gate.timeoutMs,
        });
      } catch (error) {
        commandError = error;
      }
      if (postgresRegistry !== undefined) {
        try {
          await cleanupPostgresProjects(root, postgresRegistry);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (result !== undefined && result.exitCode !== 0) {
        commandError = architectureGateError(
          `gate ${gate.id} failed with exit code ${String(result.exitCode)}`,
        );
      }
      const gateError = combineGateErrors([commandError, cleanupError]);
      const stdout = result?.stdout ?? Buffer.alloc(0);
      const stderr =
        result?.stderr ??
        (gateError === undefined ? Buffer.alloc(0) : Buffer.from(errorSummary(gateError), 'utf8'));
      results.push({
        id: gate.id,
        exitCode: result?.exitCode ?? -1,
        output: result?.output.toString('utf8') ?? errorSummary(gateError),
        stdout,
        stderr,
        signal: result?.signal ?? null,
        durationMs: Date.now() - startedAt,
        error: gateError === undefined ? null : errorSummary(gateError),
      });
      if (gateError !== undefined) throw gateError;
    }
    validateGateResults(manifest, results);
    semanticPass = true;
  } catch (error) {
    executionError = error;
  }
  try {
    const statusAfter = await gitStatus(root);
    assertCleanStatus(statusAfter, 'architecture gate execution root after all gates');
    const snapshotsAfter = await collectSnapshotManifests(root);
    assertExpectedManifest(
      snapshotsAfter.productManifest,
      attestation.sourceManifest,
      'architecture gate execution root after all gates',
    );
    assertExpectedManifest(
      snapshotsAfter.controlPlaneManifest,
      attestation.controlPlaneManifest,
      'architecture gate execution root control-plane after all gates',
    );
    const identityAfter = await captureRepositoryIdentity(
      root,
      snapshotsAfter.productManifest,
      snapshotsAfter.controlPlaneManifest,
    );
    assertRepositoryIdentityUnchanged(identityBefore, identityAfter);
    cleanAfter = true;
  } catch (error) {
    integrityError = error;
  }
  const combinedError = combineGateErrors([executionError, integrityError]);
  const report = {
    schemaVersion: 'architecture-gate-report/2',
    sourceManifest: attestation.sourceManifest,
    controlPlaneManifest: attestation.controlPlaneManifest,
    gateManifest: inventoryResult?.manifestHash ?? null,
    gates: results.map((result) => gateReportResult(result, semanticPass)),
    cleanBefore: true,
    cleanAfter,
    result: combinedError === undefined ? 'pass' : 'fail',
    error: combinedError === undefined ? null : errorSummary(combinedError),
  };
  process.stdout.write(`Architecture gate report: ${JSON.stringify(report)}\n`);
  if (combinedError !== undefined) throw combinedError;
  return report;
}

export function validateInternalGateReport(output, expectedAttestation) {
  if (!Buffer.isBuffer(output)) throw architectureGateError('internal report output must be bytes');
  const prefix = 'Architecture gate report: ';
  const lines = output
    .toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) {
    throw architectureGateError(
      `expected exactly one internal architecture gate report, received ${String(lines.length)}`,
    );
  }
  let report;
  try {
    report = JSON.parse(lines[0].slice(prefix.length));
  } catch (error) {
    throw architectureGateError(
      `internal architecture gate report is invalid JSON: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw architectureGateError('internal architecture gate report must be an object');
  }
  const reportKeys = [
    'cleanAfter',
    'cleanBefore',
    'controlPlaneManifest',
    'error',
    'gateManifest',
    'gates',
    'result',
    'schemaVersion',
    'sourceManifest',
  ];
  if (Object.keys(report).sort().join('\0') !== reportKeys.sort().join('\0')) {
    throw architectureGateError('internal architecture gate report keys drifted');
  }
  if (
    report.schemaVersion !== 'architecture-gate-report/2' ||
    report.result !== 'pass' ||
    report.error !== null ||
    report.cleanBefore !== true ||
    report.cleanAfter !== true ||
    report.gateManifest !== expectedAttestation.gateManifest ||
    !Array.isArray(report.gates)
  ) {
    throw architectureGateError('internal architecture gate report did not attest a clean pass');
  }
  const gateIds = report.gates.map((gate) => gate?.id);
  if (gateIds.join('\0') !== EXPECTED_REPORT_GATE_IDS.join('\0')) {
    throw architectureGateError('internal architecture gate report gate set drifted');
  }
  const gateKeys = [
    'durationMs',
    'error',
    'exitCode',
    'id',
    'signal',
    'status',
    'stderrBytes',
    'stderrSha256',
    'stdoutBytes',
    'stdoutSha256',
  ];
  for (const gate of report.gates) {
    if (
      gate === null ||
      typeof gate !== 'object' ||
      Array.isArray(gate) ||
      Object.keys(gate).sort().join('\0') !== gateKeys.sort().join('\0') ||
      gate.status !== 'pass' ||
      gate.exitCode !== 0 ||
      gate.signal !== null ||
      gate.error !== null ||
      !Number.isSafeInteger(gate.durationMs) ||
      gate.durationMs < 0 ||
      !Number.isSafeInteger(gate.stdoutBytes) ||
      gate.stdoutBytes < 0 ||
      !Number.isSafeInteger(gate.stderrBytes) ||
      gate.stderrBytes < 0 ||
      !/^sha256:[a-f0-9]{64}$/u.test(gate.stdoutSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(gate.stderrSha256)
    ) {
      throw architectureGateError(`internal architecture gate report ${String(gate?.id)} failed`);
    }
  }
  if (!sameManifest(report.sourceManifest, expectedAttestation.sourceManifest)) {
    throw architectureGateError('internal architecture gate report source manifest drifted');
  }
  if (!sameManifest(report.controlPlaneManifest, expectedAttestation.controlPlaneManifest)) {
    throw architectureGateError('internal architecture gate report control-plane manifest drifted');
  }
  return report;
}

function encodeAttestation(attestation) {
  return Buffer.from(JSON.stringify(attestation), 'utf8').toString('base64url');
}

function requireManifestSummary(value, context) {
  if (
    value === null ||
    typeof value !== 'object' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0
  ) {
    throw architectureGateError(`${context} is not a valid manifest summary`);
  }
  return Object.freeze({
    digest: value.digest,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
  });
}

function decodeAttestation(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Object.keys(parsed).sort().join('\0') !==
        ['controlPlaneManifest', 'gateManifest', 'sourceManifest'].sort().join('\0')
    ) {
      throw new Error('attestation keys drifted');
    }
    return Object.freeze({
      sourceManifest: requireManifestSummary(parsed.sourceManifest, 'source manifest'),
      controlPlaneManifest: requireManifestSummary(
        parsed.controlPlaneManifest,
        'control-plane manifest',
      ),
      gateManifest: /^sha256:[a-f0-9]{64}$/u.test(parsed.gateManifest)
        ? parsed.gateManifest
        : (() => {
            throw new Error('gate manifest digest is invalid');
          })(),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('architecture gate:')) throw error;
    throw architectureGateError(`internal attestation is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

export async function runDisposableGate(
  sourceRoot,
  sourceSnapshots,
  sourceIdentityBefore,
  options = {},
) {
  const attestation = attestationFor(sourceSnapshots);
  const temporaryDirectory = await (options.makeTemporaryDirectory ?? mkdtemp)(
    path.join(tmpdir(), SNAPSHOT_PREFIX),
  );
  assertDisposableDirectory(temporaryDirectory, tmpdir());

  const failures = [];
  let postgresRegistry;
  try {
    await copyEntries(temporaryDirectory, sourceSnapshots.productEntries);
    const copiedEntries = await sourceEntries(
      temporaryDirectory,
      sourceSnapshots.productManifest.paths,
    );
    assertExpectedManifest(
      createSourceManifest(copiedEntries),
      attestation.sourceManifest,
      'copied disposable architecture snapshot',
    );
    const gitEnvironment = createGitEnvironment();
    await runRequired('git', ['init', '--quiet', '--template='], {
      cwd: temporaryDirectory,
      context: 'temporary git init',
      env: gitEnvironment,
    });
    await runRequired('git', ['-c', 'core.fsmonitor=false', 'add', '--all'], {
      cwd: temporaryDirectory,
      context: 'temporary git add',
      env: gitEnvironment,
    });
    await runRequired(
      'git',
      [
        '-c',
        'user.name=better-agent architecture gate',
        '-c',
        'user.email=architecture-gate@example.invalid',
        '-c',
        'commit.gpgSign=false',
        '-c',
        `core.hooksPath=${GIT_NULL_DEVICE}`,
        'commit',
        '--quiet',
        '-m',
        'test: materialize disposable architecture gate snapshot',
      ],
      {
        cwd: temporaryDirectory,
        context: 'temporary git commit',
        env: gitEnvironment,
      },
    );
    assertCleanStatus(await gitStatus(temporaryDirectory), 'materialized architecture snapshot');
    const temporarySnapshotsBefore = await collectSnapshotManifests(temporaryDirectory);
    assertExpectedManifest(
      temporarySnapshotsBefore.productManifest,
      attestation.sourceManifest,
      'materialized architecture snapshot',
    );
    const temporaryIdentityBefore = await captureRepositoryIdentity(
      temporaryDirectory,
      temporarySnapshotsBefore.productManifest,
      temporarySnapshotsBefore.controlPlaneManifest,
    );
    const internalAttestation = Object.freeze({
      ...attestation,
      controlPlaneManifest: manifestSummary(temporarySnapshotsBefore.controlPlaneManifest),
    });
    if (options.installDependencies === undefined) {
      const storeRoot = await resolvePnpmStoreRoot(sourceRoot, createGateEnvironment());
      await runPnpm(['install', '--offline', '--frozen-lockfile', '--store-dir', storeRoot], {
        cwd: temporaryDirectory,
        context: 'offline dependency materialization',
        env: createGateEnvironment(),
        streamOutput: true,
        timeoutMs: 300_000,
      });
    } else {
      await options.installDependencies(temporaryDirectory);
    }
    assertCleanStatus(
      await gitStatus(temporaryDirectory),
      'materialized architecture snapshot after dependency installation',
    );
    const temporarySnapshotsAfterInstall = await collectSnapshotManifests(temporaryDirectory);
    const temporaryIdentityAfterInstall = await captureRepositoryIdentity(
      temporaryDirectory,
      temporarySnapshotsAfterInstall.productManifest,
      temporarySnapshotsAfterInstall.controlPlaneManifest,
    );
    assertRepositoryIdentityUnchanged(temporaryIdentityBefore, temporaryIdentityAfterInstall);
    postgresRegistry = await createPostgresProjectRegistry();
    const internalEnvironment = {
      ...createGateEnvironment(),
      BA_POSTGRES_PROJECT_REGISTRY: postgresRegistry,
    };
    const childResult =
      options.runInternalChild === undefined
        ? await runRequired(
            process.execPath,
            ['scripts/architecture-gate.mjs', '--internal', encodeAttestation(internalAttestation)],
            {
              cwd: temporaryDirectory,
              context: 'disposable clean-checkout architecture gate',
              env: internalEnvironment,
              streamOutput: true,
              timeoutMs: 1_500_000,
            },
          )
        : await options.runInternalChild(temporaryDirectory, internalAttestation, postgresRegistry);
    validateInternalGateReport(childResult.output, internalAttestation);
    const temporarySnapshotsAfterGate = await collectSnapshotManifests(temporaryDirectory);
    const temporaryIdentityAfterGate = await captureRepositoryIdentity(
      temporaryDirectory,
      temporarySnapshotsAfterGate.productManifest,
      temporarySnapshotsAfterGate.controlPlaneManifest,
    );
    assertRepositoryIdentityUnchanged(temporaryIdentityBefore, temporaryIdentityAfterGate);
  } catch (error) {
    failures.push(error);
  } finally {
    if (postgresRegistry !== undefined) {
      try {
        await (options.cleanupPostgresProjects ?? cleanupPostgresProjects)(
          sourceRoot,
          postgresRegistry,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      const sourceSnapshotsAfter = await collectSnapshotManifests(sourceRoot);
      const sourceIdentityAfter = await captureRepositoryIdentity(
        sourceRoot,
        sourceSnapshotsAfter.productManifest,
        sourceSnapshotsAfter.controlPlaneManifest,
      );
      assertRepositoryIdentityUnchanged(sourceIdentityBefore, sourceIdentityAfter);
    } catch (error) {
      failures.push(error);
    }
    try {
      assertDisposableDirectory(temporaryDirectory, tmpdir());
      await (options.removeTemporaryDirectory ?? rm)(temporaryDirectory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 200,
      });
    } catch (error) {
      failures.push(
        architectureGateError(
          `failed to remove disposable snapshot ${temporaryDirectory}: ${error.message}`,
          { cause: error },
        ),
      );
    }
  }
  const combinedError = combineGateErrors(failures);
  if (combinedError !== undefined) throw combinedError;
  if (options.silent !== true) {
    process.stdout.write(
      `Disposable clean checkout passed: ${attestation.sourceManifest.fileCount} files, ` +
        `${String(attestation.sourceManifest.totalBytes)} bytes, source ${attestation.sourceManifest.digest}; ` +
        `excluded control-plane ${attestation.controlPlaneManifest.fileCount} files, ` +
        `${String(attestation.controlPlaneManifest.totalBytes)} bytes, ${attestation.controlPlaneManifest.digest}.\n`,
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  const internal = argv[0] === '--internal';
  if ((!internal && argv.length !== 0) || (internal && argv.length !== 2)) {
    throw architectureGateError(
      'usage: node scripts/architecture-gate.mjs [--internal <base64url-attestation>]',
    );
  }
  if (internal) {
    const sourceStatus = await gitStatus(REPOSITORY_ROOT);
    assertCleanStatus(sourceStatus, 'internal architecture gate root');
    await runInternalGate(REPOSITORY_ROOT, decodeAttestation(argv[1]), {
      acceptInheritedPostgresRegistry: true,
    });
    return;
  }
  const sourceSnapshots = await collectSnapshotManifests(REPOSITORY_ROOT);
  const sourceIdentity = await captureRepositoryIdentity(
    REPOSITORY_ROOT,
    sourceSnapshots.productManifest,
    sourceSnapshots.controlPlaneManifest,
  );
  const sourceStatus = await gitStatus(REPOSITORY_ROOT);
  if (sourceStatus.length === 0) {
    await runInternalGate(REPOSITORY_ROOT, attestationFor(sourceSnapshots));
    return;
  }
  await runDisposableGate(REPOSITORY_ROOT, sourceSnapshots, sourceIdentity);
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${errorSummary(error)}\n`);
    process.exitCode = 1;
  });
}
