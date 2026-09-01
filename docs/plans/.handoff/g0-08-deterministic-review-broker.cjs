'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const PROVIDER_ROOT = 'E:\\project\\ai\\better-agent';
const TECH_PERSISTENCE_ROOT = 'E:\\project\\ai\\tech-persistence';
const GIT = 'C:\\App\\Git\\cmd\\git.exe';
const EXPECTED_CONTRACT_HASH =
  'sha256:5a5a8c1e45d792ea6c94ae3e6e7277f8ca4b4c292448eb2393413cc8357dafa7';
const EXPECTED_SOURCE_MANIFEST =
  'sha256:04db7e74dd0e487eda9e577da7a5aa9521f95e4b06f141b89bb80fe071370839';
const CRITERION_IDS = [
  'ac-g0-08-admission',
  'ac-g0-08-aggregate',
  'ac-g0-08-clean-checkout',
  'ac-g0-08-postgres',
  'ac-g0-08-registry',
];
const POSTGRES_SUITE_IDS = [
  'migration-lifecycle',
  'auth-rls',
  'release-deployment',
  'run-billing',
  'run-conversation-browser',
  'runtime-security',
];

const { stableHash } = require(path.join(
  TECH_PERSISTENCE_ROOT,
  'scripts',
  'lib',
  'self-learning-canonical.js',
));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(PROVIDER_ROOT, relativePath), 'utf8'));
}

function assertExtendedAcceptanceContract(contract) {
  if (!contract || contract.schemaVersion !== 'acceptance-contract-v1') {
    throw new Error('extended acceptance contract schema is invalid');
  }
  const { contractHash, ...payload } = contract;
  if (contractHash !== stableHash(payload)) {
    throw new Error('extended acceptance contract hash is invalid');
  }
  if (!Array.isArray(contract.criteria)
      || !sameArray(contract.criteria.map(({ id }) => id), CRITERION_IDS)
      || contract.criteria.some((criterion) => (
        criterion.oracle?.type !== 'independent-review'
          || typeof criterion.oracleResolution !== 'object'
      ))) {
    throw new Error('extended acceptance contract criteria are invalid');
  }
  return contract;
}

function sha256File(relativePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(PROVIDER_ROOT, relativePath)))
    .digest('hex');
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function exactMachineMarker(source, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const occurrences = source.match(new RegExp(escaped, 'gu')) || [];
  return occurrences.length === 1
    && ["'", '"', '`'].some((quote) => (
      source.includes(`process.stdout.write(${quote}${marker}\\n${quote});`)
    ));
}

function gitPathList() {
  const result = spawnSync(
    GIT,
    [
      '-c',
      `safe.directory=${PROVIDER_ROOT.replace(/\\/gu, '/')}`,
      '-C',
      PROVIDER_ROOT,
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ],
    {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = result.error?.message
      || Buffer.from(result.stderr || '').toString('utf8').trim()
      || `exit ${String(result.status)}`;
    throw new Error(`cannot enumerate the current provider source: ${detail}`);
  }
  return result.stdout;
}

async function inspectCurrentState() {
  const snapshot = await import(pathToFileURL(path.join(
    PROVIDER_ROOT,
    'scripts',
    'architecture-gate-snapshot.mjs',
  )).href);
  const core = await import(pathToFileURL(path.join(
    PROVIDER_ROOT,
    'scripts',
    'architecture-gate-core.mjs',
  )).href);
  const paths = snapshot.parseGitPathList(gitPathList(), { excludeControlPlane: false });
  const productPaths = paths.filter((entry) => !snapshot.isControlPlanePath(entry));
  const entries = await snapshot.sourceEntries(PROVIDER_ROOT, productPaths);
  const sourceManifest = snapshot.createSourceManifest(entries);

  const contract = assertExtendedAcceptanceContract(readJson(
    'docs/plans/2026-08-31-g0-08-executable-architecture-gate.md.acceptance.json',
  ));
  const evidence = readJson('docs/plans/.handoff/g0-08-final-local-gate.json');
  const activeSprint = readJson('docs/plans/.handoff/active-sprint.json');
  const manifest = core.validateArchitectureGateManifest(
    readJson('tests/architecture-gate/manifest.json'),
  );
  const rootPackage = readJson('package.json');
  const dbPackage = readJson('packages/db/package.json');
  const plan = fs.readFileSync(path.join(
    PROVIDER_ROOT,
    'docs/plans/2026-08-31-g0-08-executable-architecture-gate.md',
  ), 'utf8');
  const implementationPlan = fs.readFileSync(path.join(
    PROVIDER_ROOT,
    'docs/07-实施计划.md',
  ), 'utf8');
  const workflow = fs.readFileSync(path.join(PROVIDER_ROOT, '.github/workflows/ci.yml'), 'utf8');

  const exactGates = ['mutation', 'quality', 'postgres16'];
  const report = evidence.report || {};
  const reportGates = Array.isArray(report.gates) ? report.gates : [];
  const suiteFiles = fs
    .readdirSync(path.join(PROVIDER_ROOT, 'infra/test/postgres'))
    .filter((name) => /^run-(?:integration|auth-rls-integration|release-deployment-integration|run-billing-integration|run-conversation-browser-integration|runtime-security-integration)\.mjs$/u.test(name))
    .map((name) => `infra/test/postgres/${name}`)
    .sort();
  const manifestSuiteFiles = manifest.postgresSuites.map(({ file }) => file).sort();
  const migrationFiles = fs
    .readdirSync(path.join(PROVIDER_ROOT, 'packages/db/migrations'))
    .filter((name) => /^\d+_.+\.(?:up|down)\.sql$/u.test(name))
    .sort();

  const contractChecks = {
    contractHash: contract.contractHash === EXPECTED_CONTRACT_HASH,
    criterionCoverage: sameArray(contract.criteria.map(({ id }) => id), CRITERION_IDS),
  };
  const sourceChecks = {
    currentDigest: sourceManifest.digest === EXPECTED_SOURCE_MANIFEST,
    evidenceDigest: report.sourceManifest?.digest === sourceManifest.digest,
    fileCount: report.sourceManifest?.fileCount === sourceManifest.fileCount,
    totalBytes: report.sourceManifest?.totalBytes === sourceManifest.totalBytes,
    gateManifest: report.gateManifest === core.canonicalSha256(manifest),
  };
  const admissionChecks = {
    ...contractChecks,
    ...sourceChecks,
    localOnly: evidence.authority === 'local-machine-evidence-only',
    candidateOnly: evidence.admission === 'g1-candidate-only',
    receiptStillFalse: evidence.hostAttestedReceipt === false,
    sprintBlocked: activeSprint.phase === 'review' && activeSprint.status === 'blocked',
    sprintPending: activeSprint.acceptanceStatus === 'pending',
    planPreservesBoundary: /host-attested passed Receipt/iu.test(plan)
      && /进入 G1/iu.test(plan)
      && /host-attested passed Receipt/iu.test(implementationPlan),
    unknownBoundaries: sameArray(evidence.unknownBoundaries, [
      'production', 'cloud', 'driver', 'pooler', 'worker', 'provider', 'client', 'apm',
    ]),
  };
  const aggregateChecks = {
    ...contractChecks,
    ...sourceChecks,
    command: evidence.command === 'pnpm architecture:gate',
    result: evidence.result === 'pass' && report.schemaVersion === 'architecture-gate-report/2',
    exactGates: sameArray(reportGates.map(({ id }) => id), exactGates),
    gatesPassed: reportGates.length === exactGates.length
      && reportGates.every((gate) => gate.status === 'pass'
        && gate.exitCode === 0 && gate.signal === null && gate.error === null),
    scripts: rootPackage.scripts?.['architecture:gate'] === 'node scripts/architecture-gate.mjs'
      && rootPackage.scripts?.['architecture:gate:test']
        === 'node --test tests/architecture-gate/architecture-gate.test.mjs'
      && rootPackage.scripts?.['db:test:postgres16']
        === 'pnpm --filter @better-agent/db test:integration'
      && dbPackage.scripts?.['test:integration'] === manifest.scripts.dbIntegration,
    ci: /^\s*-?\s*run:\s*pnpm architecture:gate\s*$/mu.test(workflow),
  };
  const cleanCheckoutChecks = {
    ...contractChecks,
    ...sourceChecks,
    cleanBefore: report.cleanBefore === true,
    cleanAfter: report.cleanAfter === true,
    sourceIdentity: report.sourceIdentityUnchanged === true,
    noGateError: report.error === null,
  };
  const postgresChecks = {
    ...contractChecks,
    ...sourceChecks,
    postgresGate: reportGates.find(({ id }) => id === 'postgres16')?.status === 'pass',
    exactSuiteIds: sameArray(manifest.postgresSuites.map(({ id }) => id), POSTGRES_SUITE_IDS),
    evidenceSuiteIds: sameArray(evidence.verifiedEvidence?.postgresSuites, POSTGRES_SUITE_IDS),
    exactSuiteInventory: sameArray(suiteFiles, manifestSuiteFiles),
    suiteHashes: manifest.postgresSuites.every(({ file, sha256 }) => sha256File(file) === sha256),
    uniqueMachineMarkers: manifest.postgresSuites.every(({ file, successMarker }) => (
      exactMachineMarker(fs.readFileSync(path.join(PROVIDER_ROOT, file), 'utf8'), successMarker)
    )),
    realMode: manifest.gates.find(({ id }) => id === 'postgres16')?.mode === 'real',
    postgres16: /^PostgreSQL 16\./u.test(evidence.verifiedEvidence?.postgresql || ''),
  };
  const registryChecks = {
    ...contractChecks,
    ...sourceChecks,
    mutationGate: reportGates.find(({ id }) => id === 'mutation')?.status === 'pass',
    mutationEvidence: evidence.verifiedEvidence?.architectureTests
      === '26/26 pass; fail=0; skipped=0; todo=0',
    exactMigrationInventory: sameArray(migrationFiles, [...manifest.migrationFiles].sort()),
    supportHashes: manifest.postgresSupportFiles.every(
      ({ file, sha256 }) => sha256File(file) === sha256,
    ),
    gateModes: manifest.gates.every(({ mode }) => mode === 'real'),
    noSkipAllowance: manifest.gates.every(({ forbidSkippedOutput }) => forbidSkippedOutput === true),
  };

  return {
    contractHash: contract.contractHash,
    sourceManifest: sourceManifest.digest,
    checksByCriterion: {
      'ac-g0-08-admission': admissionChecks,
      'ac-g0-08-aggregate': aggregateChecks,
      'ac-g0-08-clean-checkout': cleanCheckoutChecks,
      'ac-g0-08-postgres': postgresChecks,
      'ac-g0-08-registry': registryChecks,
    },
  };
}

function allChecksPassed(checks) {
  return Object.values(checks).every((value) => value === true);
}

async function main() {
  if (process.argv.includes('--diagnose')) {
    process.stdout.write(`${JSON.stringify(await inspectCurrentState(), null, 2)}\n`);
    return;
  }
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const current = await inspectCurrentState();
  const criterionId = request?.binding?.criterionId;
  const checks = current.checksByCriterion[criterionId];
  const bindingMatches = request?.binding?.contractHash === current.contractHash
    && CRITERION_IDS.includes(criterionId)
    && typeof request?.binding?.subjectHash === 'string'
    && request?.schemaVersion === 'acceptance-independent-review-request-v1';
  const criterionDecision = checks && bindingMatches
    ? (allChecksPassed(checks) ? 'passed' : 'failed')
    : 'unknown';
  const resultDigest = stableHash({
    schemaVersion: 'g0-08-deterministic-review-result-v1',
    runLocator: request.runLocator,
    binding: request.binding,
    currentContractHash: current.contractHash,
    currentSourceManifest: current.sourceManifest,
    checks: checks || null,
    criterionDecision,
  });
  process.stdout.write(JSON.stringify({
    schemaVersion: 'acceptance-independent-review-response-v1',
    runLocator: request.runLocator,
    binding: request.binding,
    reviewerRef: 'host:deterministic-g0-08-reviewer-v1',
    writerRef: 'provider:better-agent-g0-08',
    criterionDecision,
    resultDigest,
  }));
}

main().catch((error) => {
  process.stderr.write(`g0-08 deterministic reviewer failed: ${error.message}\n`);
  process.exitCode = 1;
});
