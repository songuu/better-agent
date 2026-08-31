import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalSha256,
  validateArchitectureGateManifest,
  validateArchitectureInventory,
  validateGateResults,
} from '../../scripts/architecture-gate-core.mjs';
import {
  assertSourceStatusUnchanged,
  assertStableSnapshotFileIdentity,
  createSourceManifest,
  parseGitPathList,
  readStableSnapshotEntry,
  validateSnapshotRelativePath,
} from '../../scripts/architecture-gate.mjs';

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));

function clone(value) {
  return structuredClone(value);
}

function inventory(overrides = {}) {
  return {
    rootScripts: {
      architectureGate: manifest.scripts.rootArchitectureGate,
      check: manifest.scripts.rootCheck,
      postgres16: manifest.scripts.rootPostgres16,
    },
    dbIntegrationScript: manifest.scripts.dbIntegration,
    migrationFiles: [...manifest.migrationFiles],
    postgresSuiteFiles: manifest.postgresSuites.map(({ file }) => file),
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
  weakenedPostgresMarkers.gates[1].successMarkers = ['generic passed'];
  assert.throws(
    () => validateArchitectureGateManifest(weakenedPostgresMarkers),
    /PostgreSQL gate success markers/u,
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
});

test('requires one semantic, successful result for every registered gate', () => {
  assert.doesNotThrow(() => validateGateResults(manifest, gateResults()));

  assert.throws(() => validateGateResults(manifest, gateResults().slice(0, 1)), /result set/u);

  const failed = gateResults();
  failed[0].exitCode = 1;
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
