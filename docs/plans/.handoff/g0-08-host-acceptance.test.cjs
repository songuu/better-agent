'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = 'E:\\project\\ai\\better-agent';
const TECH_ROOT = 'E:\\project\\ai\\tech-persistence';
const BROKER =
  'C:\\Users\\Administrator\\.tech-persistence\\acceptance-brokers\\g0-08-reviewer-v1.cjs';
const CONTRACT_HASH =
  'sha256:5a5a8c1e45d792ea6c94ae3e6e7277f8ca4b4c292448eb2393413cc8357dafa7';
const SUBJECT_HASH = `sha256:${'b'.repeat(64)}`;
const { stableHash } = require(path.join(
  TECH_ROOT,
  'scripts',
  'lib',
  'self-learning-canonical.js',
));
const contract = JSON.parse(fs.readFileSync(path.join(
  ROOT,
  'docs/plans/2026-08-31-g0-08-executable-architecture-gate.md.acceptance.json',
), 'utf8'));

function minimalEnvironment() {
  const names = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'];
  return Object.fromEntries(names.filter((name) => process.env[name]).map((name) => [
    name,
    process.env[name],
  ]));
}

function requestFor(criterion, overrides = {}) {
  return {
    schemaVersion: 'acceptance-independent-review-request-v1',
    runLocator: 'sprint:test/subject:test',
    binding: {
      contractHash: CONTRACT_HASH,
      subjectHash: SUBJECT_HASH,
      criterionId: criterion.id,
      oracleHash: stableHash(criterion.oracle),
      ...(overrides.binding || {}),
    },
    oracle: criterion.oracle,
    ...overrides,
  };
}

function callBroker(request) {
  const result = spawnSync(process.execPath, [BROKER], {
    cwd: path.dirname(BROKER),
    encoding: 'utf8',
    input: JSON.stringify(request),
    env: minimalEnvironment(),
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('frozen contract hash is canonical', () => {
  const { contractHash, ...payload } = contract;
  assert.equal(contractHash, CONTRACT_HASH);
  assert.equal(stableHash(payload), CONTRACT_HASH);
});

test('deployed broker is outside the provider workspace', () => {
  const relative = path.relative(fs.realpathSync.native(ROOT), fs.realpathSync.native(BROKER));
  assert(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
  assert.equal(fs.lstatSync(BROKER).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(BROKER).isFile(), true);
});

test('all five criteria receive passed host decisions', () => {
  assert.equal(contract.criteria.length, 5);
  for (const criterion of contract.criteria) {
    const response = callBroker(requestFor(criterion));
    assert.equal(response.criterionDecision, 'passed', criterion.id);
  }
});

test('broker echoes the exact run locator and binding', () => {
  const request = requestFor(contract.criteria[0]);
  const response = callBroker(request);
  assert.equal(response.runLocator, request.runLocator);
  assert.deepEqual(response.binding, request.binding);
});

test('reviewer and writer identities are distinct', () => {
  const response = callBroker(requestFor(contract.criteria[0]));
  assert.notEqual(response.reviewerRef, response.writerRef);
});

test('result digest is a canonical SHA-256 value', () => {
  const response = callBroker(requestFor(contract.criteria[0]));
  assert.match(response.resultDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('same bound request is deterministic', () => {
  const request = requestFor(contract.criteria[1]);
  assert.deepEqual(callBroker(request), callBroker(request));
});

test('unknown criterion fails closed', () => {
  const request = requestFor(contract.criteria[0], {
    binding: { criterionId: 'ac-g0-08-unknown' },
  });
  assert.equal(callBroker(request).criterionDecision, 'unknown');
});

test('wrong contract hash fails closed', () => {
  const request = requestFor(contract.criteria[0], {
    binding: { contractHash: `sha256:${'c'.repeat(64)}` },
  });
  assert.equal(callBroker(request).criterionDecision, 'unknown');
});

test('review uses only a bounded minimal child environment', () => {
  const environment = minimalEnvironment();
  assert.equal(environment.HOME, undefined);
  assert.equal(environment.CODEX_HOME, undefined);
  assert.equal(environment.ACCEPTANCE_POSTGRES_READ_URL, undefined);
  assert.equal(environment.ACCEPTANCE_POSTGRES_WRITE_URL, undefined);
});
