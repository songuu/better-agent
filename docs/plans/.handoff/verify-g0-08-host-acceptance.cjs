'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'E:\\project\\ai\\better-agent';
const TECH_ROOT = 'E:\\project\\ai\\tech-persistence';
const RESULT = path.join(
  ROOT,
  'docs/plans/.handoff/sprint-acceptance',
  '5a5a8c1e45d792ea6c94ae3e6e7277f8ca4b4c292448eb2393413cc8357dafa7',
  '62634dc7b762a608f58cfb2d4f5ec4a2',
  'host-generation-000003.json',
);
const ENV_FILE = path.join(TECH_ROOT, 'deploy/postgres/.env.transcripts');

const { stableHash } = require(path.join(
  TECH_ROOT,
  'scripts/lib/self-learning-canonical.js',
));
const { readPrivateEnvFile } = require(path.join(
  TECH_ROOT,
  'scripts/lib/acceptance-postgres-env.js',
));
const {
  normalizeAuthorityRecord,
  openAcceptancePostgres,
  verifyAcceptanceAuthorityReadback,
} = require(path.join(
  TECH_ROOT,
  'scripts/lib/acceptance-postgres-authority.js',
));

async function main() {
  const host = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(path.join(
    ROOT,
    'docs/plans/2026-08-31-g0-08-executable-architecture-gate.md.acceptance.json',
  ), 'utf8'));
  const { contractHash, ...contractPayload } = contract;
  assert.equal(stableHash(contractPayload), contractHash);
  assert.equal(host.receipt.contractHash, contractHash);
  assert.equal(host.receipt.overallStatus, 'passed');
  assert.equal(host.receipt.results.length, 5);
  assert(host.receipt.results.every(({ status, evidenceRefs }) => (
    status === 'passed' && Array.isArray(evidenceRefs) && evidenceRefs.length === 1
  )));
  assert.equal(stableHash(host.subject), host.receipt.subjectHash);
  const { sealHash, ...sealPayload } = host.independentReviewSeal;
  assert.equal(stableHash(sealPayload), sealHash);
  assert.equal(host.independentReviewSeal.entries.length, 5);
  assert(host.independentReviewSeal.entries.every(({ criterionDecision }) => (
    criterionDecision === 'passed'
  )));
  const { evidenceManifestHash, ...evidenceManifestPayload } = host.evidenceManifest;
  assert.equal(stableHash(evidenceManifestPayload), evidenceManifestHash);
  assert.equal(host.receipt.evidenceManifestHash, evidenceManifestHash);
  const { receiptHash, ...receiptPayload } = host.receipt;
  assert.equal(stableHash(receiptPayload), receiptHash);

  const authorityPayload = {
    schemaVersion: 'codex-sprint-host-attested-acceptance-v1',
    sprintId: host.sprintId,
    runLocator: host.runLocator,
    subject: host.subject,
    evidenceManifest: host.evidenceManifest,
    independentReviewSeal: host.independentReviewSeal,
    receipt: host.receipt,
  };
  const record = normalizeAuthorityRecord({
    authorityScope: host.authorityScope,
    recordKind: 'acceptance-receipt',
    recordKey: receiptHash,
    contractHash,
    subjectHash: host.receipt.subjectHash,
    payload: authorityPayload,
  });
  assert.equal(record.recordHash, host.authorityRecordHash);
  assert.equal(record.recordHash, host.postgresRecordHash);
  assert.equal(host.postgresVerified, true);

  const external = path.join(
    'C:\\Users\\Administrator\\.tech-persistence\\acceptance-control\\g0-08',
    `${record.recordHash.slice('sha256:'.length)}.json`,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(external, 'utf8')), host);

  const opened = await openAcceptancePostgres({ env: readPrivateEnvFile(ENV_FILE) });
  try {
    const readback = await verifyAcceptanceAuthorityReadback(opened.reader, record);
    assert.equal(readback.verified, true);
    assert.equal(readback.recordHash, record.recordHash);
  } finally {
    await Promise.allSettled([opened.reader.end(), opened.writer.end()]);
  }

  process.stdout.write(`${JSON.stringify({
    verified: true,
    overallStatus: host.receipt.overallStatus,
    receiptHash,
    subjectHash: host.receipt.subjectHash,
    postgresRecordHash: record.recordHash,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`g0-08 host acceptance verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
