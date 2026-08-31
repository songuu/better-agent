import { createHash } from 'node:crypto';

const REQUIRED_EVIDENCE_DOMAINS = Object.freeze([
  'migration-lifecycle',
  'auth-rls',
  'release-deployment',
  'run-billing',
  'run-conversation-browser',
  'runtime-security',
]);

const EXPECTED_GATE_COMMANDS = Object.freeze([
  Object.freeze({ id: 'quality', args: Object.freeze(['check']) }),
  Object.freeze({ id: 'postgres16', args: Object.freeze(['db:test:postgres16']) }),
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
      ['id', 'file', 'mode', 'successMarker'],
      `postgresSuites[${index}]`,
    );
    const id = requireNonemptyString(entry.id, `postgresSuites[${index}].id`);
    const file = requireNonemptyString(entry.file, `postgresSuites[${index}].file`);
    const successMarker = requireNonemptyString(
      entry.successMarker,
      `postgresSuites[${index}].successMarker`,
    );
    if (entry.mode !== 'real') fail(`PostgreSQL suite ${id} must use real mode`);
    if (!/^infra\/test\/postgres\/run(?:-[a-z0-9]+)*-integration\.mjs$/u.test(file)) {
      fail(`PostgreSQL suite ${id} has an invalid runner path`);
    }
    return { id, file, mode: 'real', successMarker };
  });
  const ids = suites.map(({ id }) => id);
  const files = suites.map(({ file }) => file);
  if (new Set(ids).size !== ids.length || new Set(files).size !== files.length) {
    fail('PostgreSQL suite registration contains duplicate ids or files');
  }
  assertExactArray(ids, REQUIRED_EVIDENCE_DOMAINS, 'PostgreSQL suite evidence domain order');
  return suites;
}

function validateScripts(value) {
  const scripts = assertExactKeys(
    value,
    ['rootArchitectureGate', 'rootCheck', 'rootPostgres16', 'dbIntegration'],
    'scripts',
  );
  for (const field of Object.keys(scripts))
    requireNonemptyString(scripts[field], `scripts.${field}`);
  if (scripts.rootArchitectureGate !== 'node scripts/architecture-gate.mjs') {
    fail('root architecture gate script drifted');
  }
  return scripts;
}

function validateGates(value) {
  if (!Array.isArray(value)) fail('gates must be an array');
  const gates = value.map((gate, index) => {
    const entry = assertExactKeys(
      gate,
      ['id', 'command', 'args', 'mode', 'successMarkers', 'forbidSkippedOutput'],
      `gates[${index}]`,
    );
    const id = requireNonemptyString(entry.id, `gates[${index}].id`);
    if (entry.command !== 'pnpm') fail(`gate ${id} command must be the pnpm executable`);
    const args = requireUniqueStrings(entry.args, `gate ${id} args`);
    const successMarkers = requireUniqueStrings(entry.successMarkers, `gate ${id} successMarkers`);
    if (entry.mode !== 'real') fail(`gate ${id} must use real mode`);
    if (entry.forbidSkippedOutput !== true) fail(`gate ${id} must forbid skipped output`);
    return { id, command: 'pnpm', args, mode: 'real', successMarkers, forbidSkippedOutput: true };
  });
  const ids = gates.map(({ id }) => id);
  assertExactArray(
    ids,
    EXPECTED_GATE_COMMANDS.map(({ id }) => id),
    'gate order',
  );
  gates.forEach((gate, index) => {
    assertExactArray(gate.args, EXPECTED_GATE_COMMANDS[index].args, `gate ${gate.id} arguments`);
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
  const gates = validateGates(manifest.gates);
  assertExactArray(
    gates[1].successMarkers,
    postgresSuites.map(({ successMarker }) => successMarker),
    'PostgreSQL gate success markers',
  );
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    requiredEvidenceDomains: Object.freeze([...domains]),
    openapi: Object.freeze({ ...validateOpenapi(manifest.openapi) }),
    migrationFiles: Object.freeze([...validateMigrationFiles(manifest.migrationFiles)]),
    postgresSuites: Object.freeze(postgresSuites),
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
      'conditionalSkipLocations',
      'openapi',
    ],
    'repository inventory',
  );
  const rootScripts = assertExactKeys(
    inventory.rootScripts,
    ['architectureGate', 'check', 'postgres16'],
    'repository root scripts',
  );
  const scriptComparisons = [
    ['architectureGate', 'rootArchitectureGate'],
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
      if (!result.output.includes(marker)) {
        fail(`gate ${gate.id} output is missing semantic marker: ${marker}`);
      }
    }
    const outputWithoutZeroSkipSummaries = result.output
      .replace(/\bskipped\s+0\b/giu, '')
      .replace(/\b0\s+(?:tests?\s+)?skipped\b/giu, '');
    if (
      gate.forbidSkippedOutput &&
      /\bskip(?:ped|ping)?\b/iu.test(outputWithoutZeroSkipSummaries)
    ) {
      fail(`gate ${gate.id} reported skipped work`);
    }
  }
  return Object.freeze({
    gateIds: Object.freeze(manifest.gates.map(({ id }) => id)),
    manifestHash: canonicalSha256(manifest),
    ok: true,
  });
}
