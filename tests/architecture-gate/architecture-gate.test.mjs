import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBoundedOutputCapture,
  installPostgresSignalCleanup,
  runPostgresCommand,
} from '../../infra/test/postgres/harness.mjs';
import {
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
  runDisposableGate,
  sha256Bytes,
  spawnCapture,
  validateInternalGateReport,
  validatePnpmStorePath,
  validateSnapshotRelativePath,
} from '../../scripts/architecture-gate.mjs';
import {
  canonicalSha256,
  validateArchitectureGateManifest,
  validateArchitectureInventory,
  validateGateResults,
} from '../../scripts/architecture-gate-core.mjs';

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));

test('preserves an expected PostgreSQL rejection when the child closes stdin early', async () => {
  const result = await runPostgresCommand(
    process.execPath,
    ['-e', 'process.stderr.write("expected PostgreSQL rejection\\n"); process.exitCode = 7;'],
    { allowFailure: true, input: 'x'.repeat(8 * 1024 * 1024) },
  );
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /expected PostgreSQL rejection/u);
});

test('reports child diagnostics for a failed command with an early stdin close', async () => {
  await assert.rejects(
    runPostgresCommand(
      process.execPath,
      ['-e', 'process.stderr.write("database connection refused\\n"); process.exitCode = 8;'],
      { input: 'x'.repeat(8 * 1024 * 1024) },
    ),
    /failed \(8\): database connection refused/u,
  );
});

test('rejects incomplete stdin delivery even when the child exits zero', async () => {
  await assert.rejects(
    runPostgresCommand(process.execPath, ['-e', 'process.exitCode = 0;'], {
      allowFailure: true,
      input: 'x'.repeat(8 * 1024 * 1024),
    }),
    /stdin delivery failed/u,
  );
});

test('accepts a child that consumes its full stdin and exits zero', async () => {
  const input = 'postgres-batch-字\n'.repeat(512 * 1024);
  const result = await runPostgresCommand(
    process.execPath,
    [
      '-e',
      'const hash = require("node:crypto").createHash("sha256"); let bytes = 0; process.stdin.on("data", (chunk) => { bytes += chunk.length; hash.update(chunk); }); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ bytes, digest: "sha256:" + hash.digest("hex") })));',
    ],
    { input },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    bytes: Buffer.byteLength(input),
    digest: sha256Bytes(Buffer.from(input)),
  });
});

test('rejects a missing PostgreSQL command without an unhandled stdin error', async () => {
  await assert.rejects(
    runPostgresCommand('better-agent-missing-command-for-test', [], { input: 'unconsumed input' }),
    /ENOENT/u,
  );
});

function clone(value) {
  return structuredClone(value);
}

function inventory(overrides = {}) {
  return {
    rootScripts: {
      architectureGate: manifest.scripts.rootArchitectureGate,
      architectureGateTest: manifest.scripts.rootArchitectureGateTest,
      check: manifest.scripts.rootCheck,
      postgres16: manifest.scripts.rootPostgres16,
    },
    dbIntegrationScript: manifest.scripts.dbIntegration,
    migrationFiles: [...manifest.migrationFiles],
    postgresSuiteFiles: manifest.postgresSuites.map(({ file }) => file),
    postgresSuiteSha256: Object.fromEntries(
      manifest.postgresSuites.map(({ file, sha256 }) => [file, sha256]),
    ),
    postgresSupportFiles: manifest.postgresSupportFiles.map(({ file }) => file),
    postgresSupportSha256: Object.fromEntries(
      manifest.postgresSupportFiles.map(({ file, sha256 }) => [file, sha256]),
    ),
    workspaceTests: manifest.workspaceTests.map(({ packageName, script }) => ({
      packageName,
      script,
    })),
    conditionalSkipLocations: [],
    openapi: clone(manifest.openapi),
    ...overrides,
  };
}

function gateResults() {
  return manifest.gates.map((gate) => ({
    id: gate.id,
    exitCode: 0,
    output: gate.successMarkers.join('\n'),
  }));
}

test('accepts the frozen G0-08 manifest and hashes it canonically', () => {
  const validated = validateArchitectureGateManifest(manifest);
  assert.deepEqual(validated.requiredEvidenceDomains, manifest.requiredEvidenceDomains);
  assert.match(canonicalSha256(manifest), /^sha256:[a-f0-9]{64}$/u);
  assert.equal(canonicalSha256(clone(manifest)), canonicalSha256(manifest));
});

test('rejects missing, duplicate, reordered, and non-real PostgreSQL registrations', () => {
  const missing = clone(manifest);
  missing.postgresSuites.pop();
  assert.throws(() => validateArchitectureGateManifest(missing), /evidence domains|suite/u);

  const duplicate = clone(manifest);
  duplicate.postgresSuites[1].id = duplicate.postgresSuites[0].id;
  assert.throws(() => validateArchitectureGateManifest(duplicate), /duplicate/u);

  const reordered = clone(manifest);
  reordered.postgresSuites.reverse();
  assert.throws(() => validateArchitectureGateManifest(reordered), /order/u);

  const mocked = clone(manifest);
  mocked.postgresSuites[0].mode = 'mock';
  assert.throws(() => validateArchitectureGateManifest(mocked), /real/u);

  const weakenedSupport = clone(manifest);
  weakenedSupport.postgresSupportFiles[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateArchitectureGateManifest(weakenedSupport), /support file hash/u);
});

test('rejects migration chain and gate command weakening', () => {
  const missingMigration = clone(manifest);
  missingMigration.migrationFiles.splice(4, 1);
  assert.throws(() => validateArchitectureGateManifest(missingMigration), /migration/u);

  const skippedGate = clone(manifest);
  skippedGate.gates[0].mode = 'skip';
  assert.throws(() => validateArchitectureGateManifest(skippedGate), /real/u);

  const shellGate = clone(manifest);
  shellGate.gates[0].command = 'sh -c';
  assert.throws(() => validateArchitectureGateManifest(shellGate), /command/u);

  const weakenedPostgresMarkers = clone(manifest);
  weakenedPostgresMarkers.gates[2].successMarkers = ['generic passed'];
  assert.throws(
    () => validateArchitectureGateManifest(weakenedPostgresMarkers),
    /postgres16.*markers|PostgreSQL gate success markers/u,
  );
});

test('rejects coordinated manifest, package-script, and marker weakening', () => {
  const weakened = clone(manifest);
  weakened.scripts.rootCheck = 'node -e "console.log(\'fake quality passed\')"';
  weakened.scripts.rootPostgres16 = 'node -e "console.log(\'fake postgres passed\')"';
  weakened.scripts.dbIntegration = 'node -e "console.log(\'fake suite passed\')"';
  weakened.gates[1].successMarkers = ['fake quality passed'];
  weakened.gates[2].successMarkers = ['fake postgres passed'];
  for (const suite of weakened.postgresSuites) suite.successMarker = 'fake postgres passed';

  const weakenedInventory = inventory({
    rootScripts: {
      architectureGate: weakened.scripts.rootArchitectureGate,
      check: weakened.scripts.rootCheck,
      postgres16: weakened.scripts.rootPostgres16,
    },
    dbIntegrationScript: weakened.scripts.dbIntegration,
  });

  assert.throws(
    () => validateArchitectureInventory(weakened, weakenedInventory),
    /trusted|drifted|marker|script/u,
  );
});

test('matches the manifest against bidirectional repository inventory', () => {
  assert.doesNotThrow(() => validateArchitectureInventory(manifest, inventory()));

  assert.throws(
    () => validateArchitectureInventory(manifest, inventory({ migrationFiles: [] })),
    /migration inventory/u,
  );
  assert.throws(
    () =>
      validateArchitectureInventory(
        manifest,
        inventory({ conditionalSkipLocations: ['packages/db/test/example.test.ts:1'] }),
      ),
    /conditional skip/u,
  );
});

test('rejects OpenAPI and package-script drift', () => {
  const changedOpenapi = inventory();
  changedOpenapi.openapi.operationIds.pop();
  assert.throws(
    () => validateArchitectureInventory(manifest, changedOpenapi),
    /OpenAPI operation/u,
  );

  const changedScript = inventory();
  changedScript.dbIntegrationScript = 'pnpm build';
  assert.throws(
    () => validateArchitectureInventory(manifest, changedScript),
    /DB integration script/u,
  );

  const missingWebPackage = inventory();
  missingWebPackage.workspaceTests.pop();
  assert.throws(
    () => validateArchitectureInventory(manifest, missingWebPackage),
    /workspace test package inventory/u,
  );

  const reorderedWorkspacePackages = inventory();
  reorderedWorkspacePackages.workspaceTests.reverse();
  assert.throws(
    () => validateArchitectureInventory(manifest, reorderedWorkspacePackages),
    /workspace test package inventory/u,
  );
});

test('requires one semantic, successful result for every registered gate', () => {
  assert.doesNotThrow(() => validateGateResults(manifest, gateResults()));

  assert.throws(() => validateGateResults(manifest, gateResults().slice(0, 1)), /result set/u);

  const failed = gateResults();
  failed[1].exitCode = 1;
  assert.throws(() => validateGateResults(manifest, failed), /quality.*exit/u);

  const empty = gateResults();
  empty[0].output = '';
  assert.throws(() => validateGateResults(manifest, empty), /output/u);

  const skipped = gateResults();
  skipped[0].output += '\n1 test skipped';
  assert.throws(() => validateGateResults(manifest, skipped), /skipped/u);

  const explicitlyZeroSkipped = gateResults();
  explicitlyZeroSkipped[0].output += '\nℹ skipped 0\nTests 85 passed | 0 skipped';
  assert.doesNotThrow(() => validateGateResults(manifest, explicitlyZeroSkipped));

  const formattedSuccessMarker = gateResults();
  formattedSuccessMarker[1].output = formattedSuccessMarker[1].output.replace(
    '@better-agent/api:test:       Tests  80 passed (80)',
    '\u001b[36m@better-agent/api:test:\u001b[0m\tTests   80 passed (80)',
  );
  assert.doesNotThrow(() => validateGateResults(manifest, formattedSuccessMarker));

  for (const invalidMarker of [
    '@better-agent/wrong-api:test:       Tests  80 passed (80)',
    '@better-agent/api:test:       Tests  81 passed (81)',
    'diagnostic @better-agent/api:test:       Tests  80 passed (80)',
    '@better-agent/api:test:       Tests  80 passed (80)1',
    '@better-agent/api:test:       Tests  80 passed (80), 1 failed',
  ]) {
    const invalidSuccessMarker = gateResults();
    invalidSuccessMarker[1].output = invalidSuccessMarker[1].output.replace(
      '@better-agent/api:test:       Tests  80 passed (80)',
      invalidMarker,
    );
    assert.throws(
      () => validateGateResults(manifest, invalidSuccessMarker),
      /missing semantic marker/u,
      invalidMarker,
    );
  }

  for (const lineTerminator of ['\n', '\r\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029']) {
    const splitSuccessMarker = gateResults();
    splitSuccessMarker[1].output = splitSuccessMarker[1].output.replace(
      '@better-agent/api:test:       Tests  80 passed (80)',
      `@better-agent/api:test:${lineTerminator}Tests  80 passed (80)`,
    );
    assert.throws(
      () => validateGateResults(manifest, splitSuccessMarker),
      /missing semantic marker/u,
      JSON.stringify(lineTerminator),
    );
  }

  const postgresSuccessLines = [
    'architecture-gate-suite/1 migration-lifecycle pass',
    'architecture-gate-suite/1 auth-rls pass',
    'architecture-gate-suite/1 release-deployment pass',
    'architecture-gate-suite/1 run-billing pass',
    'architecture-gate-suite/1 run-conversation-browser pass',
    'architecture-gate-suite/1 runtime-security pass',
  ];
  const structuredPostgres = gateResults();
  structuredPostgres[2].output = postgresSuccessLines.join('\n');
  assert.doesNotThrow(() => validateGateResults(manifest, structuredPostgres));

  for (const [index, successMarker] of manifest.gates[2].successMarkers.entries()) {
    const missingPostgresSuite = gateResults();
    missingPostgresSuite[2].output = postgresSuccessLines
      .filter((_, lineIndex) => lineIndex !== index)
      .join('\n');
    assert.throws(
      () => validateGateResults(manifest, missingPostgresSuite),
      new RegExp(
        `missing semantic marker: ${successMarker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`,
        'u',
      ),
      successMarker,
    );
  }

  const diagnosticPostgres = gateResults();
  diagnosticPostgres[2].output = diagnosticPostgres[2].output.replace(
    'architecture-gate-suite/1 migration-lifecycle pass',
    'diagnostic expected architecture-gate-suite/1 migration-lifecycle pass but suite never ran',
  );
  assert.throws(
    () => validateGateResults(manifest, diagnosticPostgres),
    /missing semantic marker: architecture-gate-suite\/1 migration-lifecycle pass/u,
  );

  for (const passingDiagnostic of [
    'ok 26 - requires the mutation gate to report its exact pass count with zero skip and todo',
    'ok 27 - rejects 1 skipped test summary',
    'ok 28 - handles todo 1 report entries',
    'diagnostic: expected parser to reject 1 file skipped',
    'Tests parser should reject 1 skipped diagnostic fragment',
  ]) {
    const diagnosticResult = gateResults();
    diagnosticResult[0].output += `\n${passingDiagnostic}`;
    assert.doesNotThrow(() => validateGateResults(manifest, diagnosticResult));
  }

  for (const skippedOutput of [
    'ok 1 - platform-only case # SKIP unsupported platform',
    '@better-agent/api-contract:test: ok 1 - platform-only case # SKIP unsupported platform',
    'ok 1 - unfinished case # TODO implement later',
    '1..0 # SKIP no tests available',
    '@better-agent/api-contract:test: 1..0 # SKIP no tests available',
    'Tests 84 passed | 1 skipped (85)',
    'Test Files  1 skipped | 2 passed (3)',
    'Test Suites: 1 skipped, 2 passed, 3 total',
    '# skipped 1',
    '@better-agent/api-contract:test: # todo 1',
    'Skipped Tests 1',
    '1 test todo',
  ]) {
    const reportedSkip = gateResults();
    reportedSkip[0].output += `\n${skippedOutput}`;
    assert.throws(
      () => validateGateResults(manifest, reportedSkip),
      /skipped|todo/u,
      skippedOutput,
    );
  }
});

test('requires the mutation gate to report its exact pass count with zero skip and todo', () => {
  const results = gateResults();
  const mutationResult = results.find(({ id }) => id === 'mutation');
  assert.ok(mutationResult);
  mutationResult.output += '\n# skipped 1';
  assert.throws(() => validateGateResults(manifest, results), /skipped/u);

  mutationResult.output = mutationResult.output.replace('# skipped 1', '# todo 1');
  assert.throws(() => validateGateResults(manifest, results), /todo|marker/u);

  const prefixedCounts = gateResults();
  const prefixedMutationResult = prefixedCounts.find(({ id }) => id === 'mutation');
  assert.ok(prefixedMutationResult);
  prefixedMutationResult.output = prefixedMutationResult.output
    .replace('# tests 31', '# tests 310')
    .replace('# pass 31', '# pass 310')
    .replace('# fail 0', '# fail 01')
    .replace('# skipped 0', '# skipped 00')
    .replace('# todo 0', '# todo 00');
  assert.throws(() => validateGateResults(manifest, prefixedCounts), /marker/u);
});

test('accepts only bounded repository-relative snapshot paths', () => {
  assert.equal(
    validateSnapshotRelativePath('packages/db/package.json'),
    'packages/db/package.json',
  );
  for (const path of ['', '../outside', '/absolute', 'C:/absolute', '.git/config', 'a\\b']) {
    assert.throws(() => validateSnapshotRelativePath(path), /snapshot path/u, path);
  }
});

test('parses a unique NUL-delimited Git path list without empty tail entries', () => {
  assert.deepEqual(
    parseGitPathList(
      Buffer.from(
        'package.json\0docs/00-INDEX.md\0docs/plans/.handoff/active-sprint.json\0docs/plans/example.md.acceptance.json\0',
        'utf8',
      ),
    ),
    ['package.json', 'docs/00-INDEX.md'],
  );
  assert.throws(
    () => parseGitPathList(Buffer.from('package.json\0package.json\0', 'utf8')),
    /duplicate/u,
  );
  assert.equal(isControlPlanePath('docs/plans/example.md.acceptance.json'), true);
  assert.equal(isControlPlanePath('docs/plans/.handoff/active-sprint.json'), true);
  assert.equal(isControlPlanePath('tests/example.acceptance.json'), false);
});

test('creates an order-independent, content-sensitive source manifest', () => {
  const left = createSourceManifest([
    { path: 'b.txt', bytes: Buffer.from('b') },
    { path: 'a.txt', bytes: Buffer.from('a') },
  ]);
  const reordered = createSourceManifest([
    { path: 'a.txt', bytes: Buffer.from('a') },
    { path: 'b.txt', bytes: Buffer.from('b') },
  ]);
  const changed = createSourceManifest([
    { path: 'a.txt', bytes: Buffer.from('changed') },
    { path: 'b.txt', bytes: Buffer.from('b') },
  ]);
  assert.equal(left.digest, reordered.digest);
  assert.notEqual(left.digest, changed.digest);
  assert.deepEqual(left.paths, ['a.txt', 'b.txt']);
});

test('detects any source Git status byte drift', () => {
  const before = Buffer.from(' M package.json\0');
  assert.doesNotThrow(() => assertSourceStatusUnchanged(before, Buffer.from(before)));
  assert.throws(
    () => assertSourceStatusUnchanged(before, Buffer.from(' M package.json\0?? new.txt\0')),
    /source Git status changed/u,
  );
});

test('requires a stable, single-link regular source file identity', async () => {
  const identity = {
    dev: 1,
    ino: 2,
    size: 3,
    mtimeMs: 4,
    ctimeMs: 5,
    nlink: 1,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  assert.doesNotThrow(() => assertStableSnapshotFileIdentity(identity, identity, 'source.txt'));
  assert.throws(
    () => assertStableSnapshotFileIdentity(identity, { ...identity, ino: 9 }, 'source.txt'),
    /changed while reading/u,
  );

  const directory = await mkdtemp(path.join(tmpdir(), 'better-agent-gate-source-'));
  try {
    const source = path.join(directory, 'source.txt');
    await writeFile(source, 'safe\n');
    await link(source, path.join(directory, 'alias.txt'));
    await assert.rejects(
      readStableSnapshotEntry(directory, 'source.txt'),
      /single-link regular file/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects a linked ancestor that resolves outside the repository root', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'better-agent-gate-repository-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'better-agent-gate-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n');
    await symlink(
      outside,
      path.join(repository, 'ancestor'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      readStableSnapshotEntry(repository, 'ancestor/secret.txt'),
      /ancestor|repository root|linked/u,
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test('uses a Node 22-compatible mutation command and hashes raw output bytes', () => {
  assert.deepEqual(architectureMutationTestArguments(), [
    '--test',
    'tests/architecture-gate/architecture-gate.test.mjs',
  ]);
  assert.equal(
    sha256Bytes(Buffer.from('abc', 'utf8')),
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('enforces explicit snapshot file-count and byte budgets before reading bytes', async () => {
  assert.doesNotThrow(() =>
    assertSnapshotBudget({ fileCount: 2, largestFileBytes: 5, totalBytes: 9 }),
  );
  assert.throws(
    () =>
      assertSnapshotBudget(
        { fileCount: 3, largestFileBytes: 5, totalBytes: 10 },
        { maxFiles: 2, maxFileBytes: 6, maxTotalBytes: 12 },
      ),
    /file count/u,
  );
  assert.throws(
    () =>
      assertSnapshotBudget(
        { fileCount: 1, largestFileBytes: 7, totalBytes: 7 },
        { maxFiles: 2, maxFileBytes: 6, maxTotalBytes: 12 },
      ),
    /single file/u,
  );
  assert.throws(
    () =>
      assertSnapshotBudget(
        { fileCount: 2, largestFileBytes: 6, totalBytes: 13 },
        { maxFiles: 2, maxFileBytes: 6, maxTotalBytes: 12 },
      ),
    /total bytes/u,
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'better-agent-gate-budget-'));
  try {
    await writeFile(path.join(directory, 'oversized.txt'), '1234567');
    await assert.rejects(
      readStableSnapshotEntry(directory, 'oversized.txt', {
        limits: { maxFiles: 2, maxFileBytes: 6, maxTotalBytes: 12 },
      }),
      /single file/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('removes credential and runtime-injection variables from gate children', () => {
  const environment = createGateEnvironment({
    PATH: 'safe-path',
    GITHUB_TOKEN: 'secret',
    NODE_OPTIONS: '--require malicious.cjs',
    GIT_DIR: 'outside',
    AWS_SECRET_ACCESS_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    DATABASE_URL: 'postgres://secret@example.invalid/db',
    TURBO_CACHE_DIR: 'outside',
    NPM_EXECPATH: 'C:\\malicious\\pnpm.cjs',
    COMSPEC: 'C:\\malicious\\cmd.exe',
  });
  assert.equal(environment.PATH, 'safe-path');
  for (const key of [
    'GITHUB_TOKEN',
    'NODE_OPTIONS',
    'GIT_DIR',
    'AWS_SECRET_ACCESS_KEY',
    'OPENAI_API_KEY',
    'DATABASE_URL',
    'TURBO_CACHE_DIR',
    'NPM_EXECPATH',
    'COMSPEC',
  ]) {
    assert.equal(environment[key], undefined, key);
  }
  assert.equal(environment.TURBO_TELEMETRY_DISABLED, '1');
});

test('launches pnpm with the sanitized cross-platform gate environment', async () => {
  const environment = createGateEnvironment(process.env);
  const invocation = pnpmCommand(['--version'], environment);
  const result = await spawnCapture(invocation.command, invocation.args, {
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0, result.output.toString('utf8'));
  assert.match(result.stdout.toString('utf8').trim(), /^\d+\.\d+\.\d+$/u);
  const storeRoot = await resolvePnpmStoreRoot(process.cwd(), environment);
  assert.equal(path.isAbsolute(storeRoot), true);
  assert.doesNotMatch(path.basename(storeRoot), /^v\d+$/u);
  assert.equal(parsePnpmStoreRoot('/var/cache/pnpm/v10'), '/var/cache/pnpm');
  assert.equal(parsePnpmStoreRoot('C:\\pnpm-store\\v10'), 'C:\\pnpm-store');
  for (const invalid of ['', 'relative/v10', '/var/cache/pnpm/current', 'C:\\store\\current']) {
    assert.throws(() => parsePnpmStoreRoot(invalid), /invalid versioned store path/u);
  }
  await assert.rejects(
    validatePnpmStorePath('/var/cache/pnpm/v10', async () => ({
      isDirectory: () => false,
    })),
    /not a directory/u,
  );
  if (process.platform === 'win32') {
    assert.throws(
      () => pnpmCommand(['install', '--store-dir', 'C:\\trusted&unexpected']),
      /Windows command metacharacter/u,
    );
  }
});

test('bounds PostgreSQL child output before buffering can exhaust memory', () => {
  const output = createBoundedOutputCapture(5);
  assert.equal(output.append('stdout', Buffer.from('abc')), true);
  assert.equal(output.append('stderr', Buffer.from('def')), false);
  assert.equal(output.exceeded, true);
  assert.equal(output.totalBytes, 6);
  assert.equal(output.buffer('stdout').toString('utf8'), 'abc');
  assert.equal(output.buffer('stderr').length, 0);
});

test('runs PostgreSQL signal cleanup once and preserves the signal exit code', async () => {
  const createProcessTarget = () => {
    const processTarget = new EventEmitter();
    processTarget.exitCodes = [];
    processTarget.stderrText = '';
    processTarget.exit = (exitCode) => processTarget.exitCodes.push(exitCode);
    processTarget.stderr = {
      write: (value) => {
        processTarget.stderrText += value;
      },
    };
    return processTarget;
  };

  const successfulTarget = createProcessTarget();
  let stopCount = 0;
  const disposeSuccessful = installPostgresSignalCleanup(
    async () => {
      stopCount += 1;
    },
    { deadlineMs: 1_000, processTarget: successfulTarget },
  );
  successfulTarget.emit('SIGTERM');
  successfulTarget.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  disposeSuccessful();
  assert.equal(stopCount, 1);
  assert.deepEqual(successfulTarget.exitCodes, [143]);

  const failingTarget = createProcessTarget();
  const disposeFailing = installPostgresSignalCleanup(
    async () => {
      throw new Error('PGPASSWORD=supersecret');
    },
    { deadlineMs: 1_000, processTarget: failingTarget },
  );
  failingTarget.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  disposeFailing();
  assert.deepEqual(failingTarget.exitCodes, [143]);
  assert.match(failingTarget.stderrText, /\[REDACTED\]/u);
  assert.doesNotMatch(failingTarget.stderrText, /supersecret/u);
});

test('cleans only exact PostgreSQL projects from the bounded outer registry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'better-agent-gate-pg-cleanup-'));
  const registryPath = path.join(directory, 'better-agent-g0-08-pg-regression.txt');
  const expectedProjects = [
    'better-agent-g0-auth-rls-100-a1b2c3d4',
    'better-agent-runtime-security-101-e5f6a7b8',
  ];
  try {
    await writeFile(registryPath, `${expectedProjects.join('\n')}\n`);
    const cleanedProjects = [];
    await cleanupPostgresProjects(directory, registryPath, {
      runCompose: async (projectName) => cleanedProjects.push(projectName),
    });
    assert.deepEqual(cleanedProjects, expectedProjects);
    await assert.rejects(lstat(registryPath), /ENOENT/u);

    await writeFile(registryPath, `${expectedProjects.join('\n')}\n`);
    const attemptedProjects = [];
    await assert.rejects(
      cleanupPostgresProjects(directory, registryPath, {
        runCompose: async (projectName) => {
          attemptedProjects.push(projectName);
          if (projectName === expectedProjects[0]) throw new Error('first cleanup failed');
        },
      }),
      /first cleanup failed/u,
    );
    assert.deepEqual(attemptedProjects.sort(), [...expectedProjects].sort());
    assert.equal((await lstat(registryPath)).isFile(), true);
    await cleanupPostgresProjects(directory, registryPath, { runCompose: async () => {} });
    await assert.rejects(lstat(registryPath), /ENOENT/u);

    await writeFile(
      registryPath,
      `${expectedProjects[0]}\n${expectedProjects[0]}\ninvalid/project\n`,
    );
    const validAttempts = [];
    await assert.rejects(
      cleanupPostgresProjects(directory, registryPath, {
        runCompose: async (projectName) => validAttempts.push(projectName),
      }),
      (error) =>
        error instanceof AggregateError &&
        [...error.errors].some(({ message }) => /duplicates/u.test(message)) &&
        [...error.errors].some(({ message }) => /invalid identity/u.test(message)),
    );
    assert.deepEqual(validAttempts, [expectedProjects[0]]);
    assert.equal((await lstat(registryPath)).isFile(), true);

    await writeFile(registryPath, 'better-agent-production-100-a1b2c3d4\n');
    const productionAttempts = [];
    await assert.rejects(
      cleanupPostgresProjects(directory, registryPath, {
        runCompose: async (projectName) => productionAttempts.push(projectName),
      }),
      /invalid identity/u,
    );
    assert.deepEqual(productionAttempts, []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('bounds a hanging child process tree with a deterministic timeout', async () => {
  const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)";
  const parent = [
    "const { spawn } = require('node:child_process')",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] })`,
    "process.on('SIGTERM', () => process.exit(0))",
    'setInterval(() => {}, 1_000)',
  ].join(';');
  await assert.rejects(
    spawnCapture(process.execPath, ['-e', parent], {
      killGraceMs: 100,
      timeoutMs: 100,
    }),
    /timed out/u,
  );
});

test('cleans a disposable snapshot and preserves dirty source identity after child timeout', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'better-agent-gate-dirty-source-'));
  let disposableDirectory;
  const cleanedProjects = [];
  try {
    await mkdir(path.join(repository, 'tests', 'architecture-gate'), { recursive: true });
    await writeFile(
      path.join(repository, 'tests', 'architecture-gate', 'manifest.json'),
      `${JSON.stringify(manifest)}\n`,
    );
    const trackedFile = path.join(repository, 'tracked.txt');
    await writeFile(trackedFile, 'committed\n');
    for (const args of [
      ['init', '--quiet'],
      ['add', '--all'],
      [
        '-c',
        'user.name=architecture gate test',
        '-c',
        'user.email=architecture-gate-test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'test fixture',
      ],
    ]) {
      const result = await spawnCapture('git', args, { cwd: repository });
      assert.equal(result.exitCode, 0, result.output.toString('utf8'));
    }
    await writeFile(trackedFile, 'dirty but stable\n');
    const snapshots = await collectSnapshotManifests(repository);
    const identity = await captureRepositoryIdentity(
      repository,
      snapshots.productManifest,
      snapshots.controlPlaneManifest,
    );

    await assert.rejects(
      runDisposableGate(repository, snapshots, identity, {
        installDependencies: async () => {},
        makeTemporaryDirectory: async (prefix) => {
          disposableDirectory = await mkdtemp(prefix);
          return disposableDirectory;
        },
        cleanupPostgresProjects: (root, registryPath) =>
          cleanupPostgresProjects(root, registryPath, {
            runCompose: async (projectName) => cleanedProjects.push(projectName),
          }),
        runInternalChild: async (temporaryDirectory, _attestation, registryPath) => {
          await writeFile(registryPath, 'better-agent-g0-db-123-a1b2c3d4\n');
          return spawnCapture(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
            cwd: temporaryDirectory,
            killGraceMs: 100,
            timeoutMs: 100,
          });
        },
        silent: true,
      }),
      /timed out/u,
    );
    assert.ok(disposableDirectory);
    assert.deepEqual(cleanedProjects, ['better-agent-g0-db-123-a1b2c3d4']);
    await assert.rejects(lstat(disposableDirectory), /ENOENT/u);
    const snapshotsAfter = await collectSnapshotManifests(repository);
    const identityAfter = await captureRepositoryIdentity(
      repository,
      snapshotsAfter.productManifest,
      snapshotsAfter.controlPlaneManifest,
    );
    assert.doesNotThrow(() => assertRepositoryIdentityUnchanged(identity, identityAfter));
  } finally {
    await rm(repository, { force: true, recursive: true });
    if (disposableDirectory !== undefined) {
      await rm(disposableDirectory, { force: true, recursive: true });
    }
  }
});

test('preserves primary, integrity, and cleanup failures', () => {
  const combined = combineGateErrors([
    new Error('primary failed'),
    new Error('integrity failed'),
    new Error('cleanup failed'),
  ]);
  assert.ok(combined instanceof AggregateError);
  assert.match(combined.message, /3 failures/u);
  assert.deepEqual(
    [...combined.errors].map(({ message }) => message),
    ['primary failed', 'integrity failed', 'cleanup failed'],
  );
});

test('compares branch, commit, tree, index, status, and source manifest identities', () => {
  const identity = {
    branch: 'refs/heads/main',
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    indexSha256: `sha256:${'c'.repeat(64)}`,
    statusSha256: `sha256:${'d'.repeat(64)}`,
    sourceManifest: {
      digest: `sha256:${'e'.repeat(64)}`,
      fileCount: 2,
      totalBytes: 10,
    },
    controlPlaneManifest: {
      digest: `sha256:${'f'.repeat(64)}`,
      fileCount: 1,
      totalBytes: 5,
    },
  };
  assert.doesNotThrow(() => assertRepositoryIdentityUnchanged(identity, structuredClone(identity)));
  assert.throws(
    () => assertRepositoryIdentityUnchanged(identity, { ...identity, branch: 'refs/heads/other' }),
    /branch|identity/u,
  );
  assert.throws(
    () =>
      assertRepositoryIdentityUnchanged(identity, {
        ...identity,
        controlPlaneManifest: { ...identity.controlPlaneManifest, totalBytes: 6 },
      }),
    /control-plane/u,
  );
});

test('requires one well-formed passing internal report bound to the expected manifests', () => {
  const expected = {
    sourceManifest: {
      digest: `sha256:${'a'.repeat(64)}`,
      fileCount: 2,
      totalBytes: 10,
    },
    controlPlaneManifest: {
      digest: `sha256:${'b'.repeat(64)}`,
      fileCount: 1,
      totalBytes: 5,
    },
    gateManifest: `sha256:${'c'.repeat(64)}`,
  };
  const passingGate = (id) => ({
    id,
    status: 'pass',
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdoutBytes: 1,
    stdoutSha256: `sha256:${'d'.repeat(64)}`,
    stderrBytes: 0,
    stderrSha256: `sha256:${'e'.repeat(64)}`,
    error: null,
  });
  const report = {
    schemaVersion: 'architecture-gate-report/2',
    sourceManifest: expected.sourceManifest,
    controlPlaneManifest: expected.controlPlaneManifest,
    gateManifest: expected.gateManifest,
    gates: ['mutation', 'quality', 'postgres16'].map(passingGate),
    cleanBefore: true,
    cleanAfter: true,
    result: 'pass',
    error: null,
  };
  const output = Buffer.from(`Architecture gate report: ${JSON.stringify(report)}\n`);
  assert.deepEqual(validateInternalGateReport(output, expected), report);
  assert.throws(() => validateInternalGateReport(Buffer.from('missing\n'), expected), /report/u);
  const drifted = structuredClone(report);
  drifted.sourceManifest.digest = `sha256:${'d'.repeat(64)}`;
  assert.throws(
    () =>
      validateInternalGateReport(
        Buffer.from(`Architecture gate report: ${JSON.stringify(drifted)}\n`),
        expected,
      ),
    /source manifest/u,
  );
  const missingGate = structuredClone(report);
  missingGate.gates.pop();
  assert.throws(
    () =>
      validateInternalGateReport(
        Buffer.from(`Architecture gate report: ${JSON.stringify(missingGate)}\n`),
        expected,
      ),
    /gate set/u,
  );
  const missingManifest = structuredClone(report);
  missingManifest.gateManifest = null;
  assert.throws(
    () =>
      validateInternalGateReport(
        Buffer.from(`Architecture gate report: ${JSON.stringify(missingManifest)}\n`),
        expected,
      ),
    /clean pass/u,
  );
});
