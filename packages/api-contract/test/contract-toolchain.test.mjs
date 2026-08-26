import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertCredentialOperationPolicySnapshot,
  assertResponseCompatibilitySnapshot,
  checkGeneratedContract,
  createCredentialOperationPolicySnapshot,
  createResponseCompatibilitySnapshot,
  generateContract,
  preflightContract,
  validateContract,
  validateCredentialOperationPolicies,
} from '../src/contract-toolchain.mjs';

const fixture = (name) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

test('exports only the generated credential operation registry, not its mutable baseline', async () => {
  const packageManifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageManifest.exports['./credential-operation-policy-registry.json'], undefined);
  assert.deepEqual(packageManifest.exports['./credential-operation-policy-registry.js'], {
    types: './generated/credential-operation-policy-registry.d.ts',
    import: './generated/credential-operation-policy-registry.js',
  });
  assert.equal(packageManifest.files.includes('baseline/credential-operation-policy.json'), false);
});

test('validates, bundles, and generates TypeScript from a valid OpenAPI 3.1 contract', async () => {
  const result = await validateContract(fixture('valid.yaml'));

  assert.deepEqual(result.operationIds, ['getWidget']);
  assert.match(result.bundleText, /"openapi": "3\.1\.0"/);
  assert.match(result.typescriptText, /export (?:interface|type) paths/);
  assert.match(result.typescriptText, /export type PublicRedactedPayloadValue/);
  assert.match(
    result.credentialOperationPolicyRegistryText,
    /export function getReviewedServiceCredentialOperation/,
  );
  assert.match(
    result.credentialOperationPolicyRegistryTypescriptText,
    /export type ServiceCredentialOperationId = never/,
  );
});

test('rejects an unresolved local reference', () => {
  assert.throws(() => preflightContract(fixture('broken-ref.yaml')), /unresolved.*reference/i);
});

test('rejects duplicate operationIds', () => {
  assert.throws(
    () => preflightContract(fixture('duplicate-operation-id.yaml')),
    /duplicate operationId.*listWidgets/i,
  );
});

test('rejects a media-type example that violates its schema', async () => {
  await assert.rejects(
    () => validateContract(fixture('invalid-example.yaml')),
    /invalid.*example|example.*invalid/i,
  );
});

test('rejects duplicate YAML mapping keys', () => {
  assert.throws(() => preflightContract(fixture('duplicate-key.yaml')), /duplicate|unique/i);
});

test('detects drift in generated contract artifacts', async (context) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'better-agent-api-contract-'));
  context.after(() => rm(outputDir, { force: true, recursive: true }));

  await generateContract({
    allowExternalOutputDir: true,
    outputDir,
    sourcePath: fixture('valid.yaml'),
  });
  await appendFile(join(outputDir, 'openapi.d.ts'), '// stale\n', 'utf8');

  await assert.rejects(
    () =>
      checkGeneratedContract({
        checkResponseCompatibility: false,
        outputDir,
        sourcePath: fixture('valid.yaml'),
      }),
    /generated OpenAPI artifacts are stale/i,
  );
});

test('detects drift in the generated credential operation policy registry', async (context) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'better-agent-policy-registry-drift-'));
  context.after(() => rm(outputDir, { force: true, recursive: true }));

  await generateContract({
    allowExternalOutputDir: true,
    outputDir,
    sourcePath: fixture('credential-operation-policies.yaml'),
  });
  await appendFile(
    join(outputDir, 'credential-operation-policy-registry.js'),
    '// stale\n',
    'utf8',
  );

  await assert.rejects(
    () =>
      checkGeneratedContract({
        checkCredentialOperationPolicy: false,
        checkResponseCompatibility: false,
        outputDir,
        sourcePath: fixture('credential-operation-policies.yaml'),
      }),
    /generated OpenAPI artifacts are stale/i,
  );
});

test('generates a private recursively frozen credential operation policy registry', async (context) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'better-agent-policy-registry-'));
  context.after(() => rm(outputDir, { force: true, recursive: true }));

  const result = await generateContract({
    allowExternalOutputDir: true,
    outputDir,
    sourcePath: fixture('credential-operation-policies.yaml'),
  });
  const registrySource = await readFile(result.credentialOperationPolicyRegistryPath, 'utf8');
  const registry = await import(
    `data:text/javascript;base64,${Buffer.from(registrySource).toString('base64')}`
  );

  assert.deepEqual(Object.keys(registry).sort(), [
    'credentialOperationPolicyRegistrySchemaVersion',
    'getReviewedServiceCredentialOperation',
    'serviceCredentialOperationIds',
  ]);
  assert.equal(
    registry.credentialOperationPolicyRegistrySchemaVersion,
    'openapi-credential-operation-policy/1',
  );
  assert.deepEqual(registry.serviceCredentialOperationIds, [
    'createAgentChatRun',
    'createAgentConversation',
    'createFlowRun',
    'exchangeBrowserSession',
    'getRun',
    'listAgentConversationMessages',
    'listAgentConversations',
    'requestRunCancellation',
    'resumeHumanGate',
    'streamRunEvents',
  ]);
  assert.ok(Object.isFrozen(registry.serviceCredentialOperationIds));

  const reviewedOperation = registry.getReviewedServiceCredentialOperation('createAgentChatRun');
  assert.deepEqual(reviewedOperation, {
    method: 'POST',
    path: '/chat',
    policy: {
      allowed_kinds: ['service_api'],
      operation_purpose: 'agent_invoke',
      required_scopes: ['agent:run:create'],
      schema_version: 'credential-operation-policy/1',
      target_cardinality: 'exactly_one_deployment',
      typed_grant_family: 'agent_deployment_entry_grants',
    },
  });
  assert.ok(Object.isFrozen(reviewedOperation));
  assert.ok(Object.isFrozen(reviewedOperation.policy));
  assert.ok(Object.isFrozen(reviewedOperation.policy.required_scopes));
  assert.throws(() => {
    reviewedOperation.policy.required_scopes[0] = 'run:read';
  }, TypeError);
  assert.equal(
    registry.getReviewedServiceCredentialOperation('createAgentChatRun').policy.required_scopes[0],
    'agent:run:create',
  );
  assert.equal(registry.getReviewedServiceCredentialOperation('unknownOperation'), undefined);
});

test('rejects a response contract that differs from the reviewed baseline', () => {
  const baseline = createResponseCompatibilitySnapshot(
    preflightContract(fixture('valid.yaml')).document,
  );
  const breaking = createResponseCompatibilitySnapshot(
    preflightContract(fixture('breaking-response.yaml')).document,
  );

  assert.throws(
    () => assertResponseCompatibilitySnapshot(baseline, breaking),
    /potential breaking OpenAPI response change/i,
  );
});

test('accepts local JSON Schema anchors and rejects external references', async () => {
  await assert.doesNotReject(() => validateContract(fixture('local-anchor.yaml')));
  await assert.rejects(
    () => validateContract(fixture('external-ref.yaml')),
    /external OpenAPI references are not allowed/i,
  );
});

test('rejects cyclic YAML aliases with a bounded contract error', () => {
  assert.throws(
    () => preflightContract(fixture('cyclic-alias.yaml')),
    /aliases must not form a cyclic object graph/i,
  );
});

test('validates ten service policies and the single browser-only operation', () => {
  const document = preflightContract(fixture('credential-operation-policies.yaml')).document;
  const result = validateCredentialOperationPolicies(document);

  assert.equal(result.serviceOperationCount, 10);
  assert.deepEqual(result.browserOnlyOperationIds, ['createBrowserRunEventSession']);
  assert.equal(result.subjectAssertionProfileVersion, 'subject-assertion-jws-eddsa/1');
});

test('fails closed for unknown, duplicate, empty, and crossed credential scopes', () => {
  const source = preflightContract(fixture('credential-operation-policies.yaml')).document;
  const variants = [
    ['unknown scope', ['unknown:scope']],
    ['duplicate scope', ['agent:run:create', 'agent:run:create']],
    ['empty scope', []],
  ];

  for (const [label, requiredScopes] of variants) {
    const document = structuredClone(source);
    document.paths['/chat'].post['x-service-credential-policy'].required_scopes = requiredScopes;
    assert.throws(
      () => validateCredentialOperationPolicies(document),
      /credential operation policy|required_scopes|scope/i,
      label,
    );
  }

  const crossed = structuredClone(source);
  crossed.paths['/exchange'].post['x-service-credential-policy'].allowed_kinds = ['service_api'];
  assert.throws(
    () => validateCredentialOperationPolicies(crossed),
    /publish|exchange|service_api/i,
  );
});

test('rejects assertion-profile weakening and service policy on the browser-only operation', () => {
  const source = preflightContract(fixture('credential-operation-policies.yaml')).document;

  const weakenedAssertion = structuredClone(source);
  weakenedAssertion['x-subject-assertion-contract'].max_ttl_seconds = 301;
  assert.throws(
    () => validateCredentialOperationPolicies(weakenedAssertion),
    /max_ttl_seconds.*300/i,
  );

  const browserWithServicePolicy = structuredClone(source);
  browserWithServicePolicy.paths['/run/events/session'].post['x-service-credential-policy'] =
    structuredClone(source.paths['/chat'].post['x-service-credential-policy']);
  assert.throws(
    () => validateCredentialOperationPolicies(browserWithServicePolicy),
    /browser-only.*must not define.*service credential policy/i,
  );
});

test('detects explicit credential operation policy baseline drift', () => {
  const source = preflightContract(fixture('credential-operation-policies.yaml')).document;
  const baseline = createCredentialOperationPolicySnapshot(source);
  const changed = structuredClone(source);
  changed.paths['/chat'].post['x-service-credential-policy'].required_scopes = [
    'agent:conversation:read',
  ];

  assert.throws(
    () =>
      assertCredentialOperationPolicySnapshot(
        baseline,
        createCredentialOperationPolicySnapshot(changed),
      ),
    /credential operation policy.*baseline/i,
  );
});
