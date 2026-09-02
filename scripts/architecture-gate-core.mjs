import { createHash } from 'node:crypto';

const ANSI_CSI_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

const REQUIRED_EVIDENCE_DOMAINS = Object.freeze([
  'migration-lifecycle',
  'auth-rls',
  'release-deployment',
  'run-billing',
  'run-conversation-browser',
  'runtime-security',
]);

const EXPECTED_CONTRACT_SUCCESS_MARKER =
  'Contract gate passed: 11 operations, 314 local references, bundle a19ddd228941e51a9658c109c87af7405d3a0c22324c00757cf987549117cf04, TypeScript a92a2c8b4cd61df15626282b64abd5cb3138622ab32e4dca2f16cd39cc5e6d07, response baseline e383d1ce5fe4494056280c1c36fdd19f769ec194dd97ad46678e2ceabd0f5828';

const EXPECTED_SCRIPTS = Object.freeze({
  rootArchitectureGate: 'node scripts/architecture-gate.mjs',
  rootArchitectureGateTest: 'node --test tests/architecture-gate/architecture-gate.test.mjs',
  rootCheck:
    'pnpm format:check && pnpm lint && pnpm workspace:smoke && pnpm contract:check && pnpm typecheck && pnpm test && pnpm build',
  rootPostgres16: 'pnpm --filter @better-agent/db test:integration',
  dbIntegration:
    'pnpm build && node ../../infra/test/postgres/run-integration.mjs && node ../../infra/test/postgres/run-auth-rls-integration.mjs && node ../../infra/test/postgres/run-release-deployment-integration.mjs && node ../../infra/test/postgres/run-run-billing-integration.mjs && node ../../infra/test/postgres/run-run-conversation-browser-integration.mjs && node ../../infra/test/postgres/run-runtime-security-integration.mjs',
});

const EXPECTED_POSTGRES_SUITES = Object.freeze([
  Object.freeze({
    id: 'migration-lifecycle',
    file: 'infra/test/postgres/run-integration.mjs',
    sha256: '94195c4cb926fd45e26ce2d4faab17ccad09d4030727604dfa02cad77954154c',
    successMarker: 'architecture-gate-suite/1 migration-lifecycle pass',
  }),
  Object.freeze({
    id: 'auth-rls',
    file: 'infra/test/postgres/run-auth-rls-integration.mjs',
    sha256: 'd1753f60e08ce9cfa4d3cbab52deecd688996473a16caa09f03b67d614582384',
    successMarker: 'architecture-gate-suite/1 auth-rls pass',
  }),
  Object.freeze({
    id: 'release-deployment',
    file: 'infra/test/postgres/run-release-deployment-integration.mjs',
    sha256: '9058656293483d9cc5f572550944bd476299675c6f17926dac4ca74d87b680e0',
    successMarker: 'architecture-gate-suite/1 release-deployment pass',
  }),
  Object.freeze({
    id: 'run-billing',
    file: 'infra/test/postgres/run-run-billing-integration.mjs',
    sha256: '8af4e842a7371e9920c8e85444b36e395834db101eb70e11895bf5a1a3326e0d',
    successMarker: 'architecture-gate-suite/1 run-billing pass',
  }),
  Object.freeze({
    id: 'run-conversation-browser',
    file: 'infra/test/postgres/run-run-conversation-browser-integration.mjs',
    sha256: 'b03cfaa1f9ba0024bb73714ca3d13f6e1edc36ccbad10db853f093dd25d1c476',
    successMarker: 'architecture-gate-suite/1 run-conversation-browser pass',
  }),
  Object.freeze({
    id: 'runtime-security',
    file: 'infra/test/postgres/run-runtime-security-integration.mjs',
    sha256: 'a7853d2633d27aeed25ef9e4c58d43300bbdefd88e0d2eb81c1e3aac3655e5f1',
    successMarker: 'architecture-gate-suite/1 runtime-security pass',
  }),
]);

const EXPECTED_POSTGRES_SUPPORT_FILES = Object.freeze([
  Object.freeze({
    file: 'infra/test/postgres/README.md',
    sha256: '47bc1673ab3d36fe942d8b26b87152b0973152fe5ba084efedb07e79e427a592',
  }),
  Object.freeze({
    file: 'infra/test/postgres/bootstrap-test.sql',
    sha256: '4b114251ef2a825e14660949dd82d8a50047525634c5ec4fd1752bb51f17ac17',
  }),
  Object.freeze({
    file: 'infra/test/postgres/catalog-fingerprint.mjs',
    sha256: 'a498a696915e402a6eef88a0aa4209fb7c1be6259b33b09851634eed81af2fdb',
  }),
  Object.freeze({
    file: 'infra/test/postgres/compose.yaml',
    sha256: '941d2545f41c8296ae4545f91c996986e0df703facd6e1a05ee3826fd3cd45cd',
  }),
  Object.freeze({
    file: 'infra/test/postgres/fixtures/migrations/001_probe.down.sql',
    sha256: 'b2eb24461466ec0857534ce021b8a3fe221649cea28af2128c89e34994378eac',
  }),
  Object.freeze({
    file: 'infra/test/postgres/fixtures/migrations/001_probe.up.sql',
    sha256: '80642827bb35415f5809d5df75912f4e0420194eb12711853d14bf06ce8d82f0',
  }),
  Object.freeze({
    file: 'infra/test/postgres/harness.mjs',
    sha256: 'eda327cc5f693b22e9fda3b4380b8b707204ef8701f31e510a86768770591f44',
  }),
]);

const EXPECTED_WORKSPACE_TESTS = Object.freeze([
  Object.freeze({
    packageName: '@better-agent/api',
    script: 'vitest run --config vitest.config.ts --configLoader native',
    testCount: 80,
    successMarker: '@better-agent/api:test:       Tests  80 passed (80)',
  }),
  Object.freeze({
    packageName: '@better-agent/api-contract',
    script: 'node test/contract-toolchain.test.mjs',
    testCount: 16,
    successMarker: '@better-agent/api-contract:test: # pass 16',
  }),
  Object.freeze({
    packageName: '@better-agent/auth',
    script: 'vitest run --config vitest.config.ts --configLoader native',
    testCount: 48,
    successMarker: '@better-agent/auth:test:       Tests  48 passed (48)',
  }),
  Object.freeze({
    packageName: '@better-agent/billing-core',
    script: 'vitest run --config vitest.config.ts --configLoader native',
    testCount: 43,
    successMarker: '@better-agent/billing-core:test:       Tests  43 passed (43)',
  }),
  Object.freeze({
    packageName: '@better-agent/db',
    script: 'vitest run --config vitest.config.ts --configLoader native',
    testCount: 85,
    successMarker: '@better-agent/db:test:       Tests  85 passed (85)',
  }),
  Object.freeze({
    packageName: '@better-agent/domain-contracts',
    script: 'vitest run --config vitest.config.ts --configLoader native',
    testCount: 143,
    successMarker: '@better-agent/domain-contracts:test:       Tests  143 passed (143)',
  }),
  Object.freeze({
    packageName: '@better-agent/release-core',
    script: 'vitest run --config vitest.config.ts --configLoader native',
    testCount: 542,
    successMarker: '@better-agent/release-core:test:       Tests  542 passed (542)',
  }),
  Object.freeze({
    packageName: '@better-agent/run-core',
    script: 'vitest run --config vitest.config.ts --configLoader native --passWithNoTests',
    testCount: 103,
    successMarker: '@better-agent/run-core:test:       Tests  103 passed (103)',
  }),
  Object.freeze({
    packageName: '@better-agent/test-support',
    script:
      'vitest run --config vitest.config.ts --configLoader native && node --test ../../tests/deployment/*.test.mjs',
    testCount: 21,
    successMarker: '@better-agent/test-support:test:       Tests  21 passed (21)',
  }),
]);

const EXPECTED_GATE_COMMANDS = Object.freeze([
  Object.freeze({
    id: 'mutation',
    command: 'node',
    args: Object.freeze(['--test', 'tests/architecture-gate/architecture-gate.test.mjs']),
    timeoutMs: 120_000,
    successMarkers: Object.freeze([
      '# tests 31',
      '# pass 31',
      '# fail 0',
      '# skipped 0',
      '# todo 0',
    ]),
  }),
  Object.freeze({
    id: 'quality',
    command: 'pnpm',
    args: Object.freeze(['check']),
    timeoutMs: 300_000,
    successMarkers: Object.freeze([
      'workspace smoke passed for 9 package(s)',
      EXPECTED_CONTRACT_SUCCESS_MARKER,
      ...EXPECTED_WORKSPACE_TESTS.map(({ successMarker }) => successMarker),
    ]),
  }),
  Object.freeze({
    id: 'postgres16',
    command: 'pnpm',
    args: Object.freeze(['db:test:postgres16']),
    timeoutMs: 900_000,
    successMarkers: Object.freeze(
      EXPECTED_POSTGRES_SUITES.map(({ successMarker }) => successMarker),
    ),
  }),
]);

function fail(message) {
  throw new Error(`architecture gate: ${message}`);
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const object = requireObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    fail(`${label} keys must equal [${expected.join(', ')}], received [${actual.join(', ')}]`);
  }
  return object;
}

function requireNonemptyString(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    fail(`${label} must be a trimmed, non-empty string without control characters`);
  }
  return value;
}

function requireUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  const strings = value.map((entry, index) => requireNonemptyString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) fail(`${label} contains duplicate values`);
  return strings;
}

function assertExactArray(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(
      `${label} or order drifted: expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
    );
  }
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function validateOpenapi(value) {
  const openapi = assertExactKeys(
    value,
    [
      'operationIds',
      'localReferenceCount',
      'bundleSha256',
      'typescriptSha256',
      'responseBaselineSha256',
      'credentialOperationPolicyBaselineSha256',
    ],
    'openapi',
  );
  const operationIds = requireUniqueStrings(openapi.operationIds, 'openapi.operationIds');
  assertExactArray(operationIds, [...operationIds].sort(), 'OpenAPI operation IDs');
  if (!Number.isSafeInteger(openapi.localReferenceCount) || openapi.localReferenceCount <= 0) {
    fail('openapi.localReferenceCount must be a positive safe integer');
  }
  for (const field of [
    'bundleSha256',
    'typescriptSha256',
    'responseBaselineSha256',
    'credentialOperationPolicyBaselineSha256',
  ]) {
    requireSha256(openapi[field], `openapi.${field}`);
  }
  return openapi;
}

function validateMigrationFiles(value) {
  const files = requireUniqueStrings(value, 'migrationFiles');
  assertExactArray(files, [...files].sort(), 'migration file inventory');
  const migrations = new Map();
  for (const file of files) {
    const match = /^(\d{3})_([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.(up|down)\.sql$/u.exec(file);
    if (match === null) fail(`migration filename is invalid: ${file}`);
    const [, id, name, direction] = match;
    const current = migrations.get(id) ?? { id, name, directions: new Set() };
    if (current.name !== name) fail(`migration ${id} has conflicting names`);
    current.directions.add(direction);
    migrations.set(id, current);
  }
  const ids = [...migrations.keys()].sort();
  assertExactArray(ids, ['000', '001', '002', '003', '004', '005'], 'migration IDs');
  for (const { id, directions } of migrations.values()) {
    if (!directions.has('up')) fail(`migration ${id} is missing its up file`);
    const expectsDown = Number.parseInt(id, 10) >= 3;
    if (directions.has('down') !== expectsDown) {
      fail(`migration ${id} down-file policy drifted`);
    }
  }
  return files;
}

function validatePostgresSuites(value) {
  if (!Array.isArray(value) || value.length === 0) fail('postgresSuites must be non-empty');
  const suites = value.map((suite, index) => {
    const entry = assertExactKeys(
      suite,
      ['id', 'file', 'sha256', 'mode', 'successMarker'],
      `postgresSuites[${index}]`,
    );
    const id = requireNonemptyString(entry.id, `postgresSuites[${index}].id`);
    const file = requireNonemptyString(entry.file, `postgresSuites[${index}].file`);
    const successMarker = requireNonemptyString(
      entry.successMarker,
      `postgresSuites[${index}].successMarker`,
    );
    const sha256 = requireSha256(entry.sha256, `postgresSuites[${index}].sha256`);
    if (entry.mode !== 'real') fail(`PostgreSQL suite ${id} must use real mode`);
    if (!/^infra\/test\/postgres\/run(?:-[a-z0-9]+)*-integration\.mjs$/u.test(file)) {
      fail(`PostgreSQL suite ${id} has an invalid runner path`);
    }
    return { id, file, sha256, mode: 'real', successMarker };
  });
  const ids = suites.map(({ id }) => id);
  const files = suites.map(({ file }) => file);
  if (new Set(ids).size !== ids.length || new Set(files).size !== files.length) {
    fail('PostgreSQL suite registration contains duplicate ids or files');
  }
  assertExactArray(ids, REQUIRED_EVIDENCE_DOMAINS, 'PostgreSQL suite evidence domain order');
  suites.forEach((suite, index) => {
    const expected = EXPECTED_POSTGRES_SUITES[index];
    for (const field of ['id', 'file', 'sha256', 'successMarker']) {
      if (suite[field] !== expected[field]) {
        fail(`trusted PostgreSQL suite ${String(suite.id)} ${field} drifted`);
      }
    }
  });
  return suites;
}

function validatePostgresSupportFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('postgresSupportFiles must be non-empty');
  }
  const files = value.map((supportFile, index) => {
    const entry = assertExactKeys(
      supportFile,
      ['file', 'sha256'],
      `postgresSupportFiles[${index}]`,
    );
    const file = requireNonemptyString(entry.file, `postgresSupportFiles[${index}].file`);
    const sha256 = requireSha256(entry.sha256, `postgresSupportFiles[${index}].sha256`);
    if (!file.startsWith('infra/test/postgres/')) {
      fail(`PostgreSQL support file has an invalid path: ${file}`);
    }
    return { file, sha256 };
  });
  assertExactArray(
    files.map(({ file }) => file),
    EXPECTED_POSTGRES_SUPPORT_FILES.map(({ file }) => file),
    'PostgreSQL support file order',
  );
  files.forEach((supportFile, index) => {
    const expected = EXPECTED_POSTGRES_SUPPORT_FILES[index];
    if (supportFile.sha256 !== expected.sha256) {
      fail(`trusted PostgreSQL support file hash drifted: ${supportFile.file}`);
    }
  });
  return files;
}

function validateWorkspaceTests(value) {
  if (!Array.isArray(value) || value.length === 0) fail('workspaceTests must be non-empty');
  const tests = value.map((workspaceTest, index) => {
    const entry = assertExactKeys(
      workspaceTest,
      ['packageName', 'script', 'testCount', 'successMarker'],
      `workspaceTests[${index}]`,
    );
    const packageName = requireNonemptyString(
      entry.packageName,
      `workspaceTests[${index}].packageName`,
    );
    const script = requireNonemptyString(entry.script, `workspaceTests[${index}].script`);
    if (!Number.isSafeInteger(entry.testCount) || entry.testCount <= 0) {
      fail(`workspaceTests[${index}].testCount must be a positive safe integer`);
    }
    const successMarker = requireNonemptyString(
      entry.successMarker,
      `workspaceTests[${index}].successMarker`,
    );
    const markerCountMatch = /(?:Tests\s+(\d+)\s+passed\s+\(\1\)|# pass\s+(\d+))$/u.exec(
      successMarker,
    );
    const markerCount = Number(markerCountMatch?.[1] ?? markerCountMatch?.[2]);
    if (!Number.isSafeInteger(markerCount) || markerCount !== entry.testCount) {
      fail(`workspaceTests[${index}] successMarker must encode testCount`);
    }
    return { packageName, script, testCount: entry.testCount, successMarker };
  });
  assertExactArray(
    tests.map(({ packageName }) => packageName),
    EXPECTED_WORKSPACE_TESTS.map(({ packageName }) => packageName),
    'workspace test package order',
  );
  tests.forEach((workspaceTest, index) => {
    const expected = EXPECTED_WORKSPACE_TESTS[index];
    for (const field of ['packageName', 'script', 'testCount', 'successMarker']) {
      if (workspaceTest[field] !== expected[field]) {
        fail(`trusted workspace test ${workspaceTest.packageName} ${field} drifted`);
      }
    }
  });
  return tests;
}

function validateScripts(value) {
  const scripts = assertExactKeys(
    value,
    [
      'rootArchitectureGate',
      'rootArchitectureGateTest',
      'rootCheck',
      'rootPostgres16',
      'dbIntegration',
    ],
    'scripts',
  );
  for (const field of Object.keys(scripts))
    requireNonemptyString(scripts[field], `scripts.${field}`);
  for (const [field, expected] of Object.entries(EXPECTED_SCRIPTS)) {
    if (scripts[field] !== expected) fail(`trusted ${field} script drifted`);
  }
  return scripts;
}

function validateGates(value) {
  if (!Array.isArray(value)) fail('gates must be an array');
  const gates = value.map((gate, index) => {
    const entry = assertExactKeys(
      gate,
      ['id', 'command', 'args', 'mode', 'successMarkers', 'forbidSkippedOutput', 'timeoutMs'],
      `gates[${index}]`,
    );
    const id = requireNonemptyString(entry.id, `gates[${index}].id`);
    if (!['node', 'pnpm'].includes(entry.command)) {
      fail(`gate ${id} command must be the node or pnpm executable`);
    }
    const args = requireUniqueStrings(entry.args, `gate ${id} args`);
    const successMarkers = requireUniqueStrings(entry.successMarkers, `gate ${id} successMarkers`);
    if (entry.mode !== 'real') fail(`gate ${id} must use real mode`);
    if (entry.forbidSkippedOutput !== true) fail(`gate ${id} must forbid skipped output`);
    if (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
      fail(`gate ${id} timeoutMs must be a positive safe integer`);
    }
    return {
      id,
      command: entry.command,
      args,
      mode: 'real',
      successMarkers,
      forbidSkippedOutput: true,
      timeoutMs: entry.timeoutMs,
    };
  });
  const ids = gates.map(({ id }) => id);
  assertExactArray(
    ids,
    EXPECTED_GATE_COMMANDS.map(({ id }) => id),
    'gate order',
  );
  gates.forEach((gate, index) => {
    const expected = EXPECTED_GATE_COMMANDS[index];
    if (gate.command !== expected.command || gate.timeoutMs !== expected.timeoutMs) {
      fail(`trusted gate ${gate.id} command or timeout drifted`);
    }
    assertExactArray(gate.args, expected.args, `gate ${gate.id} arguments`);
    assertExactArray(gate.successMarkers, expected.successMarkers, `gate ${gate.id} markers`);
  });
  return gates;
}

export function validateArchitectureGateManifest(value) {
  const manifest = assertExactKeys(
    value,
    [
      'schemaVersion',
      'requiredEvidenceDomains',
      'openapi',
      'migrationFiles',
      'postgresSuites',
      'postgresSupportFiles',
      'workspaceTests',
      'scripts',
      'gates',
    ],
    'manifest',
  );
  if (manifest.schemaVersion !== 'architecture-gate/1') {
    fail('manifest schemaVersion must equal architecture-gate/1');
  }
  const domains = requireUniqueStrings(manifest.requiredEvidenceDomains, 'requiredEvidenceDomains');
  assertExactArray(domains, REQUIRED_EVIDENCE_DOMAINS, 'required evidence domains');
  const postgresSuites = validatePostgresSuites(manifest.postgresSuites);
  const postgresSupportFiles = validatePostgresSupportFiles(manifest.postgresSupportFiles);
  const workspaceTests = validateWorkspaceTests(manifest.workspaceTests);
  const gates = validateGates(manifest.gates);
  assertExactArray(
    gates[2].successMarkers,
    postgresSuites.map(({ successMarker }) => successMarker),
    'PostgreSQL gate success markers',
  );
  assertExactArray(
    gates[1].successMarkers.slice(2),
    workspaceTests.map(({ successMarker }) => successMarker),
    'quality gate workspace test markers',
  );
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    requiredEvidenceDomains: Object.freeze([...domains]),
    openapi: Object.freeze({ ...validateOpenapi(manifest.openapi) }),
    migrationFiles: Object.freeze([...validateMigrationFiles(manifest.migrationFiles)]),
    postgresSuites: Object.freeze(postgresSuites),
    postgresSupportFiles: Object.freeze(postgresSupportFiles),
    workspaceTests: Object.freeze(workspaceTests),
    scripts: Object.freeze({ ...validateScripts(manifest.scripts) }),
    gates: Object.freeze(gates),
  });
}

export function validateArchitectureInventory(manifestValue, inventoryValue) {
  const manifest = validateArchitectureGateManifest(manifestValue);
  const inventory = assertExactKeys(
    inventoryValue,
    [
      'rootScripts',
      'dbIntegrationScript',
      'migrationFiles',
      'postgresSuiteFiles',
      'postgresSuiteSha256',
      'postgresSupportFiles',
      'postgresSupportSha256',
      'workspaceTests',
      'conditionalSkipLocations',
      'openapi',
    ],
    'repository inventory',
  );
  const rootScripts = assertExactKeys(
    inventory.rootScripts,
    ['architectureGate', 'architectureGateTest', 'check', 'postgres16'],
    'repository root scripts',
  );
  const scriptComparisons = [
    ['architectureGate', 'rootArchitectureGate'],
    ['architectureGateTest', 'rootArchitectureGateTest'],
    ['check', 'rootCheck'],
    ['postgres16', 'rootPostgres16'],
  ];
  for (const [actualField, manifestField] of scriptComparisons) {
    if (rootScripts[actualField] !== manifest.scripts[manifestField]) {
      fail(`repository root ${actualField} script drifted`);
    }
  }
  if (inventory.dbIntegrationScript !== manifest.scripts.dbIntegration) {
    fail('DB integration script drifted');
  }
  const migrationFiles = requireUniqueStrings(
    inventory.migrationFiles,
    'repository migration inventory',
  );
  assertExactArray(migrationFiles, manifest.migrationFiles, 'repository migration inventory');
  const suiteFiles = requireUniqueStrings(
    inventory.postgresSuiteFiles,
    'repository PostgreSQL suite inventory',
  );
  assertExactArray(
    [...suiteFiles].sort(),
    manifest.postgresSuites.map(({ file }) => file).sort(),
    'repository PostgreSQL suite inventory',
  );
  const suiteHashes = assertExactKeys(
    inventory.postgresSuiteSha256,
    manifest.postgresSuites.map(({ file }) => file),
    'repository PostgreSQL suite hashes',
  );
  for (const suite of manifest.postgresSuites) {
    if (suiteHashes[suite.file] !== suite.sha256) {
      fail(`repository PostgreSQL suite hash drifted: ${suite.file}`);
    }
  }
  const supportFiles = requireUniqueStrings(
    inventory.postgresSupportFiles,
    'repository PostgreSQL support inventory',
  );
  assertExactArray(
    supportFiles,
    manifest.postgresSupportFiles.map(({ file }) => file),
    'repository PostgreSQL support inventory',
  );
  const supportHashes = assertExactKeys(
    inventory.postgresSupportSha256,
    manifest.postgresSupportFiles.map(({ file }) => file),
    'repository PostgreSQL support hashes',
  );
  for (const supportFile of manifest.postgresSupportFiles) {
    if (supportHashes[supportFile.file] !== supportFile.sha256) {
      fail(`repository PostgreSQL support hash drifted: ${supportFile.file}`);
    }
  }
  if (!Array.isArray(inventory.workspaceTests)) fail('repository workspaceTests must be an array');
  assertExactArray(
    inventory.workspaceTests.map(({ packageName }) => packageName),
    manifest.workspaceTests.map(({ packageName }) => packageName),
    'repository workspace test package inventory',
  );
  inventory.workspaceTests.forEach((workspaceTest, index) => {
    const expected = manifest.workspaceTests[index];
    if (workspaceTest.script !== expected.script) {
      fail(`repository workspace test script drifted: ${expected.packageName}`);
    }
  });
  if (!Array.isArray(inventory.conditionalSkipLocations)) {
    fail('conditional skip inventory must be an array');
  }
  if (inventory.conditionalSkipLocations.length > 0) {
    fail(`conditional skip is forbidden: ${inventory.conditionalSkipLocations.join(', ')}`);
  }
  const openapi = validateOpenapi(inventory.openapi);
  if (canonicalSha256(openapi) !== canonicalSha256(manifest.openapi)) {
    const operationsMatch =
      canonicalSha256(openapi.operationIds) === canonicalSha256(manifest.openapi.operationIds);
    fail(operationsMatch ? 'OpenAPI metadata drifted' : 'OpenAPI operation inventory drifted');
  }
  return Object.freeze({ manifestHash: canonicalSha256(manifest), ok: true });
}

function plainOutputLines(output) {
  return output.replace(ANSI_CSI_PATTERN, '').split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/gu);
}

function normalizeSemanticLine(line) {
  return line.trim().replace(/[ \t]+/gu, ' ');
}

function reportsSkippedOrTodo(output) {
  return plainOutputLines(output).some((rawLine) => {
    const line = rawLine.replace(/^\s*\S+:test:\s*/u, '').trim();
    const runnerSummary = /^(?:test\s+(?:files|suites)|tests?)\b\s*:?\s*(.*)$/iu.exec(line);
    const runnerSummaryReportsSkippedOrTodo =
      runnerSummary !== null &&
      /^\d+\s+(?:passed|failed|skipped|todo|total)\b/iu.test(runnerSummary[1]) &&
      /\b[1-9]\d*\s+(?:skipped|todo)\b(?=\s*(?:[|,(]|$))/iu.test(runnerSummary[1]);
    return (
      /^(?:not\s+)?ok\b.*#\s*(?:skip|todo)\b/iu.test(line) ||
      /^1\.\.0\b.*#\s*skip\b/iu.test(line) ||
      /^#\s*(?:skipped|todo)\s+[1-9]\d*\s*$/iu.test(line) ||
      runnerSummaryReportsSkippedOrTodo ||
      /^(?:skipped|todo)(?:\s+(?:tests?|files?))?\s+[1-9]\d*\s*$/iu.test(line) ||
      /^[1-9]\d*\s+(?:(?:tests?|files?)\s+)?(?:skipped|todo)\s*$/iu.test(line)
    );
  });
}

function reportsSemanticMarker(output, marker) {
  const normalizedMarker = normalizeSemanticLine(marker.replace(ANSI_CSI_PATTERN, ''));
  const normalizedLines = plainOutputLines(output).map(normalizeSemanticLine);
  return normalizedLines.includes(normalizedMarker);
}

export function validateGateResults(manifestValue, resultsValue) {
  const manifest = validateArchitectureGateManifest(manifestValue);
  if (!Array.isArray(resultsValue)) fail('gate results must be an array');
  const ids = resultsValue.map((result) => result?.id);
  assertExactArray(
    ids,
    manifest.gates.map(({ id }) => id),
    'gate result set',
  );
  for (const [index, gate] of manifest.gates.entries()) {
    const result = requireObject(resultsValue[index], `gate result ${gate.id}`);
    if (result.exitCode !== 0) fail(`gate ${gate.id} exit code was ${String(result.exitCode)}`);
    if (typeof result.output !== 'string' || result.output.trim().length === 0) {
      fail(`gate ${gate.id} output must be non-empty`);
    }
    for (const marker of gate.successMarkers) {
      if (!reportsSemanticMarker(result.output, marker)) {
        fail(`gate ${gate.id} output is missing semantic marker: ${marker}`);
      }
    }
    if (gate.forbidSkippedOutput && reportsSkippedOrTodo(result.output)) {
      fail(`gate ${gate.id} reported skipped or todo work`);
    }
  }
  return Object.freeze({
    gateIds: Object.freeze(manifest.gates.map(({ id }) => id)),
    manifestHash: canonicalSha256(manifest),
    ok: true,
  });
}
