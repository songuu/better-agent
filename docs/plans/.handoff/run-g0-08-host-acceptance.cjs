'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROVIDER_ROOT = 'E:\\project\\ai\\better-agent';
const TECH_PERSISTENCE_ROOT = 'E:\\project\\ai\\tech-persistence';
const CONTROL_ROOT = 'C:\\Users\\Administrator\\.tech-persistence\\acceptance-control';
const REVIEW_BROKER =
  'C:\\Users\\Administrator\\.tech-persistence\\acceptance-brokers\\g0-08-reviewer-v1.cjs';
const POSTGRES_ENV = path.join(
  TECH_PERSISTENCE_ROOT,
  'deploy',
  'postgres',
  '.env.transcripts',
);
const POSTGRES_BROKER = path.join(
  TECH_PERSISTENCE_ROOT,
  'scripts',
  'acceptance-postgres-authority.js',
);
const CONTRACT_SOURCE = path.join(
  PROVIDER_ROOT,
  'docs',
  'plans',
  '2026-08-31-g0-08-executable-architecture-gate.md.acceptance.json',
);
const LOCAL_GATE_EVIDENCE = path.join(
  PROVIDER_ROOT,
  'docs',
  'plans',
  '.handoff',
  'g0-08-final-local-gate.json',
);
const SPRINT_INSTANCE = '62634dc7b762a608f58cfb2d4f5ec4a2';
const OUTPUT_DIRECTORY = path.join(
  PROVIDER_ROOT,
  'docs',
  'plans',
  '.handoff',
  'sprint-acceptance',
  '5a5a8c1e45d792ea6c94ae3e6e7277f8ca4b4c292448eb2393413cc8357dafa7',
  SPRINT_INSTANCE,
);
const RESULT_FILE = path.join(OUTPUT_DIRECTORY, 'host-generation-000003.json');

const {
  canonicalize,
  stableHash,
} = require(path.join(
  TECH_PERSISTENCE_ROOT,
  'scripts',
  'lib',
  'self-learning-canonical.js',
));
const {
  appendPostgresAuthorityRecordSync,
} = require(path.join(
  TECH_PERSISTENCE_ROOT,
  'scripts',
  'lib',
  'acceptance-postgres-authority-client.js',
));
const {
  normalizeAuthorityRecord,
} = require(path.join(
  TECH_PERSISTENCE_ROOT,
  'scripts',
  'lib',
  'acceptance-postgres-authority.js',
));

function minimalBrokerEnvironment() {
  const allowed = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'];
  return Object.fromEntries(
    allowed.filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]]),
  );
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function exactKeys(value, expected, label) {
  const actual = value && typeof value === 'object' ? Object.keys(value).sort() : [];
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
      || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function assertRegularExternalFile(file, label) {
  const resolved = fs.realpathSync.native(file);
  const stat = fs.lstatSync(resolved);
  const provider = fs.realpathSync.native(PROVIDER_ROOT);
  const relative = path.relative(provider, resolved);
  const outside = relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  if (!stat.isFile() || stat.isSymbolicLink() || !outside) {
    throw new Error(`${label} must be a regular non-link file outside the provider root`);
  }
  return { resolved, stat, digest: sha256File(resolved) };
}

function assertStableFile(snapshot, label) {
  const stat = fs.statSync(snapshot.resolved);
  if (stat.dev !== snapshot.stat.dev || stat.ino !== snapshot.stat.ino
      || stat.size !== snapshot.stat.size || stat.mtimeMs !== snapshot.stat.mtimeMs
      || sha256File(snapshot.resolved) !== snapshot.digest) {
    throw new Error(`${label} changed during review`);
  }
}

function reviewCriterion(broker, runLocator, contract, subjectHash, criterion) {
  const request = canonicalize({
    schemaVersion: 'acceptance-independent-review-request-v1',
    runLocator,
    binding: {
      contractHash: contract.contractHash,
      subjectHash,
      criterionId: criterion.id,
      oracleHash: stableHash(criterion.oracle),
    },
    oracle: criterion.oracle,
  });
  const result = spawnSync(process.execPath, [broker.resolved], {
    cwd: path.dirname(broker.resolved),
    encoding: 'utf8',
    input: JSON.stringify(request),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 120_000,
    windowsHide: true,
    env: minimalBrokerEnvironment(),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`independent reviewer failed for ${criterion.id}`);
  }
  const response = JSON.parse(String(result.stdout || '').trim());
  exactKeys(response, [
    'schemaVersion', 'runLocator', 'binding', 'reviewerRef', 'writerRef',
    'criterionDecision', 'resultDigest',
  ], 'independent review response');
  if (response.schemaVersion !== 'acceptance-independent-review-response-v1'
      || response.runLocator !== runLocator
      || stableHash(response.binding) !== stableHash(request.binding)
      || response.reviewerRef === response.writerRef
      || !['passed', 'failed', 'unknown'].includes(response.criterionDecision)
      || !/^sha256:[0-9a-f]{64}$/u.test(response.resultDigest)) {
    throw new Error(`independent reviewer binding failed for ${criterion.id}`);
  }
  return response;
}

function claimJson(file, value) {
  const content = `${JSON.stringify(value)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== content) {
      throw new Error(`immutable authority projection conflicts: ${file}`);
    }
    return;
  }
  fs.writeFileSync(file, content, { flag: 'wx' });
}

function main() {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_SOURCE, 'utf8'));
  const { contractHash, ...contractPayload } = contract;
  if (contract.schemaVersion !== 'acceptance-contract-v1'
      || contractHash !== stableHash(contractPayload)
      || !Array.isArray(contract.criteria) || contract.criteria.length !== 5) {
    throw new Error('frozen extended acceptance contract is invalid');
  }
  const evidence = JSON.parse(fs.readFileSync(LOCAL_GATE_EVIDENCE, 'utf8'));
  const sourceManifest = evidence?.report?.sourceManifest;
  if (!sourceManifest || typeof sourceManifest.digest !== 'string') {
    throw new Error('current local gate source manifest is unavailable');
  }
  const subject = canonicalize({
    schemaVersion: 'g0-08-host-acceptance-subject-v1',
    ref: `g0-08-source:${sourceManifest.digest}`,
    contractHash,
    sourceManifest,
    localGateEvidenceHash: stableHash(evidence),
    localGateEvidenceRef: 'docs/plans/.handoff/g0-08-final-local-gate.json',
    reviewGeneration: 3,
  });
  const subjectHash = stableHash(subject);
  const runLocator = `sprint:${SPRINT_INSTANCE}/contract:${contractHash}/subject:${subjectHash}`;
  const broker = assertRegularExternalFile(REVIEW_BROKER, 'independent reviewer broker');
  const responses = contract.criteria.map((criterion) => (
    reviewCriterion(broker, runLocator, contract, subjectHash, criterion)
  ));
  assertStableFile(broker, 'independent reviewer broker');

  const reviewSealPayload = canonicalize({
    schemaVersion: 'acceptance-independent-review-seal-v1',
    runLocator,
    contractHash,
    subjectHash,
    brokerDigest: broker.digest,
    entries: responses.map((response, index) => ({
      index,
      criterionId: response.binding.criterionId,
      oracleHash: response.binding.oracleHash,
      reviewerRef: response.reviewerRef,
      writerRef: response.writerRef,
      criterionDecision: response.criterionDecision,
      resultDigest: response.resultDigest,
    })),
  });
  const reviewSeal = canonicalize({
    ...reviewSealPayload,
    sealHash: stableHash(reviewSealPayload),
  });
  const evidenceManifestPayload = canonicalize({
    schemaVersion: 'g0-08-host-evidence-manifest-v1',
    contractHash,
    subjectHash,
    sourceManifest: sourceManifest.digest,
    localGateEvidenceHash: subject.localGateEvidenceHash,
    independentReviewSealHash: reviewSeal.sealHash,
  });
  const evidenceManifest = canonicalize({
    ...evidenceManifestPayload,
    evidenceManifestHash: stableHash(evidenceManifestPayload),
  });
  const results = contract.criteria.map((criterion, index) => {
    const response = responses[index];
    return canonicalize({
      criterionId: criterion.id,
      evaluatorRef: response.reviewerRef,
      evidenceRefs: response.criterionDecision === 'unknown'
        ? []
        : [`authority:independent-review/${reviewSeal.sealHash}#entries/${index}`],
      observed: response.criterionDecision === 'passed'
        ? 'Host reviewer independently recomputed the bound source and verified the criterion.'
        : (response.criterionDecision === 'failed'
          ? 'Host reviewer independently found a bound criterion violation.'
          : 'Host reviewer could not establish a bound criterion decision.'),
      oracleHash: stableHash(criterion.oracle),
      oracleResolutionHash: stableHash(criterion.oracleResolution),
      status: response.criterionDecision,
    });
  });
  const overallStatus = results.some(({ status }) => status === 'failed')
    ? 'failed'
    : (results.some(({ status }) => status === 'unknown') ? 'unknown' : 'passed');
  const receiptPayload = canonicalize({
    schemaVersion: 'acceptance-receipt-v1',
    contractHash,
    subjectRef: subject.ref,
    subjectHash,
    evidenceManifestHash: evidenceManifest.evidenceManifestHash,
    results,
    overallStatus,
  });
  const receipt = canonicalize({
    ...receiptPayload,
    receiptHash: stableHash(receiptPayload),
  });
  const authorityScope = stableHash({
    schemaVersion: 'g0-08-host-authority-scope-v1',
    contractHash,
    sprintInstance: SPRINT_INSTANCE,
  });
  const authorityPayload = canonicalize({
    schemaVersion: 'codex-sprint-host-attested-acceptance-v1',
    sprintId: `sprint-instance:${SPRINT_INSTANCE}`,
    runLocator,
    subject,
    evidenceManifest,
    independentReviewSeal: reviewSeal,
    receipt,
  });
  const record = normalizeAuthorityRecord({
    authorityScope,
    recordKind: 'acceptance-receipt',
    recordKey: receipt.receiptHash,
    contractHash,
    subjectHash,
    payload: authorityPayload,
  });
  const postgres = appendPostgresAuthorityRecordSync(record, {
    providerRoot: PROVIDER_ROOT,
    postgresEnvFile: POSTGRES_ENV,
    postgresBrokerPath: POSTGRES_BROKER,
    postgresTimeoutMs: 60_000,
  });
  if (!postgres || postgres.verified !== true || postgres.recordHash !== record.recordHash) {
    throw new Error('PostgreSQL authority independent readback failed');
  }
  const hostRecord = canonicalize({
    schemaVersion: 'codex-sprint-host-attested-record-v1',
    recordedAt: new Date().toISOString(),
    authorityScope,
    authorityRecordHash: record.recordHash,
    postgresVerified: true,
    postgresRecordHash: postgres.recordHash,
    ...authorityPayload,
  });
  const externalFile = path.join(
    CONTROL_ROOT,
    'g0-08',
    `${record.recordHash.slice('sha256:'.length)}.json`,
  );
  claimJson(externalFile, hostRecord);
  claimJson(RESULT_FILE, hostRecord);
  process.stdout.write(`${JSON.stringify({
    overallStatus,
    receiptHash: receipt.receiptHash,
    subjectHash,
    independentReviewSealHash: reviewSeal.sealHash,
    postgresRecordHash: postgres.recordHash,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`g0-08 host acceptance failed: ${error.message}\n`);
  process.exitCode = 1;
}
