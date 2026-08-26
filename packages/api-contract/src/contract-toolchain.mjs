import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle, lint, loadConfig } from '@redocly/openapi-core';
import openapiTS, { astToString } from 'openapi-typescript';
import ts from 'typescript';
import { parseDocument } from 'yaml';

const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PUBLIC_REDACTED_PAYLOAD_PATH = '#/components/schemas/PublicRedactedPayload';
const PUBLIC_REDACTED_PAYLOAD_ALIAS = `export type PublicRedactedPayloadValue =
  | string
  | number
  | boolean
  | null
  | PublicRedactedPayloadValue[]
  | { [key: string]: PublicRedactedPayloadValue };`;

export const DEFAULT_CONTRACT_PATH = join(REPOSITORY_ROOT, 'docs', 'api', 'openapi.yaml');
export const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, 'redocly.yaml');
export const DEFAULT_OUTPUT_DIR = join(PACKAGE_ROOT, 'generated');
export const DEFAULT_RESPONSE_BASELINE_PATH = join(
  PACKAGE_ROOT,
  'baseline',
  'response-compatibility.json',
);
export const DEFAULT_CREDENTIAL_OPERATION_POLICY_BASELINE_PATH = join(
  PACKAGE_ROOT,
  'baseline',
  'credential-operation-policy.json',
);

const CREDENTIAL_OPERATION_POLICY_SCHEMA_VERSION = 'credential-operation-policy/1';
const SUBJECT_ASSERTION_REQUIRED_CLAIMS = [
  'version',
  'issuer_config_id',
  'iss',
  'sub',
  'aud',
  'nonce',
  'iat',
  'exp',
  'origin',
  'key_version',
];
const SERVICE_API_SCOPES = new Set([
  'agent:conversation:write',
  'agent:conversation:read',
  'agent:run:create',
  'flow:run:create',
  'run:read',
  'run:cancel',
  'run:resume',
  'run:events:read',
]);
const ORIGINAL_RUN_POLICY = new Map([
  ['run_read', 'run:read'],
  ['run_cancel', 'run:cancel'],
  ['run_resume', 'run:resume'],
  ['run_events_read', 'run:events:read'],
]);

const NON_STRUCTURAL_RESPONSE_KEYS = new Set([
  'description',
  'example',
  'examples',
  'externalDocs',
  'summary',
  'title',
  'xml',
]);

function asAbsolutePath(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function decodePointerToken(token, reference) {
  try {
    return decodeURIComponent(token).replaceAll('~1', '/').replaceAll('~0', '~');
  } catch (error) {
    throw new Error(`Invalid URI encoding in local reference ${reference}`, { cause: error });
  }
}

function resolveLocalReference(document, reference, anchors) {
  if (reference === '#') {
    return document;
  }

  if (!reference.startsWith('#/')) {
    let anchor;
    try {
      anchor = decodeURIComponent(reference.slice(1));
    } catch (error) {
      throw new Error(`Invalid URI encoding in local reference ${reference}`, { cause: error });
    }
    const anchoredValue = anchors.get(anchor);
    if (anchoredValue === undefined) {
      throw new Error(`Unresolved local anchor reference: ${reference}`);
    }
    return anchoredValue.value;
  }

  let current = document;
  for (const rawToken of reference.slice(2).split('/')) {
    const token = decodePointerToken(rawToken, reference);
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      throw new Error(`Unresolved local reference: ${reference}`);
    }
    current = current[token];
  }

  return current;
}

function walkDocument(value, visitor, path = [], active = new WeakSet(), visited = new WeakSet()) {
  if (value === null || typeof value !== 'object') return;
  if (active.has(value)) {
    throw new Error('OpenAPI YAML aliases must not form a cyclic object graph');
  }
  if (visited.has(value)) return;

  active.add(value);
  visitor(value, path);
  for (const [key, child] of Object.entries(value)) {
    walkDocument(child, visitor, [...path, key], active, visited);
  }
  active.delete(value);
  visited.add(value);
}

function collectAnchors(document) {
  const anchors = new Map();
  walkDocument(document, (value, path) => {
    if (Array.isArray(value) || value.$anchor === undefined) return;
    if (typeof value.$anchor !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(value.$anchor)) {
      throw new Error(`Invalid OpenAPI JSON Schema anchor: ${String(value.$anchor)}`);
    }
    if (anchors.has(value.$anchor)) {
      throw new Error(`Duplicate OpenAPI JSON Schema anchor: ${value.$anchor}`);
    }
    const pointer =
      path.length === 0
        ? '#'
        : `#/${path
            .map((token) => encodeURIComponent(token.replaceAll('~', '~0').replaceAll('/', '~1')))
            .join('/')}`;
    anchors.set(value.$anchor, { pointer, value });
  });
  return anchors;
}

function collectLocalReferences(document) {
  const references = [];
  walkDocument(document, (value) => {
    if (Array.isArray(value)) return;
    for (const keyword of ['$ref', '$dynamicRef']) {
      const reference = value[keyword];
      if (reference === undefined) continue;
      if (typeof reference !== 'string') {
        throw new Error(`${keyword} must be a string`);
      }
      if (!reference.startsWith('#')) {
        throw new Error(`External OpenAPI references are not allowed: ${keyword}=${reference}`);
      }
      references.push(reference);
    }
  });
  return references;
}

function normalizeLocalAnchorReferences(document) {
  const normalized = structuredClone(document);
  const anchors = collectAnchors(normalized);
  walkDocument(normalized, (value) => {
    if (Array.isArray(value)) return;
    for (const keyword of ['$ref', '$dynamicRef']) {
      const reference = value[keyword];
      if (typeof reference !== 'string' || reference === '#' || reference.startsWith('#/')) {
        continue;
      }
      const anchor = decodeURIComponent(reference.slice(1));
      const target = anchors.get(anchor);
      if (target === undefined) {
        throw new Error(`Unresolved local anchor reference: ${reference}`);
      }
      value[keyword] = target.pointer;
    }
  });
  return normalized;
}

function collectOperationIds(document) {
  const seen = new Map();
  const operationIds = [];

  for (const [pathName, pathItem] of Object.entries(document.paths ?? {})) {
    if (pathItem === null || typeof pathItem !== 'object') {
      continue;
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }
      if (operation === null || typeof operation !== 'object') {
        continue;
      }

      const operationId = operation.operationId;
      if (typeof operationId !== 'string' || operationId.length === 0) {
        throw new Error(`Missing operationId for ${method.toUpperCase()} ${pathName}`);
      }

      const previous = seen.get(operationId);
      if (previous !== undefined) {
        throw new Error(
          `Duplicate operationId ${operationId}: ${previous} and ${method.toUpperCase()} ${pathName}`,
        );
      }

      seen.set(operationId, `${method.toUpperCase()} ${pathName}`);
      operationIds.push(operationId);
    }
  }

  return operationIds.sort();
}

function operationEntries(document) {
  const entries = [];
  for (const [pathName, pathItem] of Object.entries(document.paths ?? {})) {
    if (pathItem === null || typeof pathItem !== 'object' || Array.isArray(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        !HTTP_METHODS.has(method.toLowerCase()) ||
        operation === null ||
        typeof operation !== 'object' ||
        Array.isArray(operation)
      ) {
        continue;
      }
      entries.push({ method: method.toUpperCase(), operation, path: pathName });
    }
  }
  return entries;
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(requireObject(value, label)).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.join('\0') !== expected.join('\0')) {
    throw new Error(
      `${label} must contain exactly [${expected.join(', ')}]; found [${actualKeys.join(', ')}]`,
    );
  }
}

function assertExactArray(value, expected, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicate values`);
  }
  if (value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} must equal [${expected.join(', ')}]`);
  }
}

function hasSecurityScheme(operation, scheme) {
  if (!Array.isArray(operation.security)) {
    throw new Error(`operation ${String(operation.operationId)} must define explicit security`);
  }
  return operation.security.some(
    (alternative) =>
      alternative !== null &&
      typeof alternative === 'object' &&
      !Array.isArray(alternative) &&
      Object.hasOwn(alternative, scheme),
  );
}

function isBrowserSessionOnly(operation) {
  if (!Array.isArray(operation.security) || operation.security.length !== 1) return false;
  const alternative = operation.security[0];
  if (alternative === null || typeof alternative !== 'object' || Array.isArray(alternative)) {
    return false;
  }
  const keys = Object.keys(alternative);
  return (
    keys.length === 1 &&
    keys[0] === 'browserSessionBearer' &&
    Array.isArray(alternative.browserSessionBearer) &&
    alternative.browserSessionBearer.length === 0
  );
}

function validateSubjectAssertionProfile(document) {
  const profile = requireObject(
    document['x-subject-assertion-contract'],
    'x-subject-assertion-contract',
  );
  const requiredKeys = [
    'version',
    'serialization',
    'alg',
    'typ',
    'claim_version',
    'key_selection',
    'kid_format',
    'max_ttl_seconds',
    'max_clock_skew_seconds',
    'required_claims',
    'raw_assertion_persistence',
  ];
  const allowedKeys = new Set([...requiredKeys, 'description']);
  const unknownKeys = Object.keys(profile).filter((key) => !allowedKeys.has(key));
  const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(profile, key));
  if (unknownKeys.length > 0 || missingKeys.length > 0) {
    throw new Error(
      'x-subject-assertion-contract has an invalid closed profile shape: ' +
        `missing=[${missingKeys.join(', ')}] unknown=[${unknownKeys.join(', ')}]`,
    );
  }
  const expectedScalars = {
    alg: 'EdDSA',
    claim_version: 'subject-assertion/1',
    kid_format: '{issuer_config_id}.v{key_version}',
    key_selection: 'pinned_local_key_version',
    max_clock_skew_seconds: 30,
    max_ttl_seconds: 300,
    raw_assertion_persistence: 'forbidden',
    serialization: 'compact_jws',
    typ: 'ba-subject-assertion+jwt',
    version: 'subject-assertion-jws-eddsa/1',
  };
  for (const [key, expected] of Object.entries(expectedScalars)) {
    if (profile[key] !== expected) {
      throw new Error(`x-subject-assertion-contract.${key} must equal ${String(expected)}`);
    }
  }
  assertExactArray(
    profile.required_claims,
    SUBJECT_ASSERTION_REQUIRED_CLAIMS,
    'x-subject-assertion-contract.required_claims',
  );
  return profile.version;
}

function validateBrowserOnlyOperation(operation, operationId) {
  if (operationId !== 'createBrowserRunEventSession') {
    throw new Error(`unexpected browser-only operation ${operationId}`);
  }
  if (operation['x-service-credential-policy'] !== undefined) {
    throw new Error(
      `${operationId} is browser-only and must not define a service credential policy`,
    );
  }
  const originPolicy = operation['x-browser-origin-policy'];
  const keys = [
    'security_scheme',
    'origin_parameter',
    'canonicalization',
    'compare_with',
    'cross_origin_header_required',
    'allow_null_origin',
    'cors_allow_origin',
    'cors_vary_origin',
    'cors_wildcard_with_credentials',
  ];
  assertExactKeys(originPolicy, keys, `${operationId}.x-browser-origin-policy`);
  const expectedScalars = {
    allow_null_origin: false,
    canonicalization: 'rfc6454_ascii_serialization',
    cors_allow_origin: 'exact_echo',
    cors_vary_origin: true,
    cors_wildcard_with_credentials: false,
    cross_origin_header_required: true,
    origin_parameter: 'BrowserOriginRequired',
    security_scheme: 'browserSessionBearer',
  };
  for (const [key, expected] of Object.entries(expectedScalars)) {
    if (originPolicy[key] !== expected) {
      throw new Error(
        `${operationId}.x-browser-origin-policy.${key} must equal ${String(expected)}`,
      );
    }
  }
  assertExactArray(
    originPolicy.compare_with,
    ['session_origin', 'current_deployment_exact_allowlist'],
    `${operationId}.x-browser-origin-policy.compare_with`,
  );
}

function validateServiceCredentialPolicy(policyValue, operationId) {
  const policy = requireObject(policyValue, `${operationId}.x-service-credential-policy`);
  const originalRunPolicy = ORIGINAL_RUN_POLICY.has(policy.operation_purpose);
  const keys = [
    'schema_version',
    'operation_purpose',
    'allowed_kinds',
    'required_scopes',
    'typed_grant_family',
    ...(originalRunPolicy ? ['allowed_original_run_target_kinds'] : []),
    'target_cardinality',
  ];
  assertExactKeys(policy, keys, `${operationId}.x-service-credential-policy`);
  if (policy.schema_version !== CREDENTIAL_OPERATION_POLICY_SCHEMA_VERSION) {
    throw new Error(
      `${operationId} credential operation policy schema_version must equal ` +
        CREDENTIAL_OPERATION_POLICY_SCHEMA_VERSION,
    );
  }

  if (policy.operation_purpose === 'deployment_publish') {
    assertExactArray(policy.allowed_kinds, ['publish'], `${operationId}.allowed_kinds`);
    assertExactArray(
      policy.required_scopes,
      ['browser-session:exchange'],
      `${operationId}.required_scopes`,
    );
    if (
      policy.typed_grant_family !== 'agent_deployment_entry_grants' ||
      policy.target_cardinality !== 'exactly_one_deployment'
    ) {
      throw new Error(`${operationId} publish exchange must resolve exactly one Agent Deployment`);
    }
    return policy;
  }

  assertExactArray(policy.allowed_kinds, ['service_api'], `${operationId}.allowed_kinds`);
  if (!Array.isArray(policy.required_scopes) || policy.required_scopes.length !== 1) {
    throw new Error(`${operationId}.required_scopes must contain exactly one scope`);
  }
  const [scope] = policy.required_scopes;
  if (new Set(policy.required_scopes).size !== policy.required_scopes.length) {
    throw new Error(`${operationId}.required_scopes must not contain duplicate values`);
  }
  if (!SERVICE_API_SCOPES.has(scope) || scope === 'browser-session:exchange') {
    throw new Error(
      `${operationId} has an unknown or forbidden service_api scope ${String(scope)}`,
    );
  }

  if (policy.operation_purpose === 'agent_invoke') {
    if (
      !new Set(['agent:conversation:write', 'agent:conversation:read', 'agent:run:create']).has(
        scope,
      ) ||
      policy.typed_grant_family !== 'agent_deployment_entry_grants' ||
      policy.target_cardinality !== 'exactly_one_deployment'
    ) {
      throw new Error(`${operationId} has an invalid agent_invoke credential operation policy`);
    }
    return policy;
  }

  if (policy.operation_purpose === 'flow_invoke') {
    if (
      scope !== 'flow:run:create' ||
      policy.typed_grant_family !== 'flow_deployment_entry_grants' ||
      policy.target_cardinality !== 'exactly_one_flow'
    ) {
      throw new Error(`${operationId} has an invalid flow_invoke credential operation policy`);
    }
    return policy;
  }

  const expectedScope = ORIGINAL_RUN_POLICY.get(policy.operation_purpose);
  if (
    expectedScope === undefined ||
    scope !== expectedScope ||
    policy.typed_grant_family !== 'original_run_entry_grant' ||
    policy.target_cardinality !== 'original_run_only'
  ) {
    throw new Error(`${operationId} has an invalid original-Run credential operation policy`);
  }
  assertExactArray(
    policy.allowed_original_run_target_kinds,
    ['agent', 'flow'],
    `${operationId}.allowed_original_run_target_kinds`,
  );
  return policy;
}

export function validateCredentialOperationPolicies(document) {
  const contract = document['x-credential-operation-policy-contract'];
  if (contract === undefined) {
    return {
      browserOnlyOperationIds: [],
      credentialPolicyContractPresent: false,
      serviceOperationCount: 0,
      subjectAssertionProfileVersion: undefined,
    };
  }
  const contractObject = requireObject(contract, 'x-credential-operation-policy-contract');
  if (
    contractObject.version !== 'CredentialOperationPolicyV1' ||
    contractObject.persistence !== 'derived_only'
  ) {
    throw new Error(
      'x-credential-operation-policy-contract must be CredentialOperationPolicyV1 derived_only',
    );
  }

  const subjectAssertionProfileVersion = validateSubjectAssertionProfile(document);
  let serviceOperationCount = 0;
  const browserOnlyOperationIds = [];
  for (const { operation } of operationEntries(document)) {
    const operationId = operation.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) continue;
    const acceptsWorkspaceAccessKey = hasSecurityScheme(operation, 'workspaceAccessKey');
    if (acceptsWorkspaceAccessKey) {
      validateServiceCredentialPolicy(operation['x-service-credential-policy'], operationId);
      serviceOperationCount += 1;
      continue;
    }
    if (!isBrowserSessionOnly(operation)) {
      throw new Error(
        `${operationId} must use workspaceAccessKey or the frozen browserSessionBearer-only shape`,
      );
    }
    validateBrowserOnlyOperation(operation, operationId);
    browserOnlyOperationIds.push(operationId);
  }

  browserOnlyOperationIds.sort();
  if (serviceOperationCount !== 10 || browserOnlyOperationIds.length !== 1) {
    throw new Error(
      'Credential operation policy inventory must contain exactly 10 service operations and ' +
        `one browser-only operation; found service=${serviceOperationCount}, ` +
        `browserOnly=${browserOnlyOperationIds.length}`,
    );
  }
  return {
    browserOnlyOperationIds,
    credentialPolicyContractPresent: true,
    serviceOperationCount,
    subjectAssertionProfileVersion,
  };
}

export function createCredentialOperationPolicySnapshot(document) {
  const validation = validateCredentialOperationPolicies(document);
  if (!validation.credentialPolicyContractPresent) {
    throw new Error('Cannot snapshot a document without x-credential-operation-policy-contract');
  }
  const browserOnlyOperations = {};
  const serviceOperations = {};
  const subjectAssertionContract = structuredClone(document['x-subject-assertion-contract']);
  delete subjectAssertionContract.description;
  for (const { method, operation, path } of operationEntries(document)) {
    const operationId = operation.operationId;
    if (hasSecurityScheme(operation, 'workspaceAccessKey')) {
      serviceOperations[operationId] = {
        method,
        path,
        policy: canonicalJson(operation['x-service-credential-policy']),
      };
    } else {
      browserOnlyOperations[operationId] = {
        browserOriginPolicy: canonicalJson(operation['x-browser-origin-policy']),
        method,
        path,
        security: canonicalJson(operation.security),
      };
    }
  }
  return {
    browserOnlyOperations,
    schemaVersion: 'openapi-credential-operation-policy/1',
    serviceOperations,
    subjectAssertionContract: canonicalJson(subjectAssertionContract),
  };
}

function credentialOperationPolicySnapshotText(snapshot) {
  return `${JSON.stringify(canonicalJson(snapshot), null, 2)}\n`;
}

export function assertCredentialOperationPolicySnapshot(baseline, current) {
  const baselineText = credentialOperationPolicySnapshotText(baseline);
  const currentText = credentialOperationPolicySnapshotText(current);
  if (baselineText !== currentText) {
    throw new Error(
      'Credential operation policy differs from the reviewed baseline ' +
        `(baseline=${digest(baselineText)}, current=${digest(currentText)}). ` +
        'Review kind/scope/grant/browser-origin changes before accepting a new policy baseline.',
    );
  }
  return {
    credentialOperationPolicyBaselineSha256: digest(currentText),
    credentialOperationPolicyBaselineText: currentText,
  };
}

function canonicalizeResponseValue(value, document, anchors, referenceStack = []) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeResponseValue(item, document, anchors, referenceStack));
  }
  if (value === null || typeof value !== 'object') return value;

  const result = {};
  const reference = value.$ref;
  if (typeof reference === 'string') {
    if (referenceStack.includes(reference)) {
      result.$recursiveRef = reference;
    } else {
      result.$resolvedRef = reference;
      result.schema = canonicalizeResponseValue(
        resolveLocalReference(document, reference, anchors),
        document,
        anchors,
        [...referenceStack, reference],
      );
    }
  }

  for (const key of Object.keys(value).sort()) {
    if (key === '$ref' || NON_STRUCTURAL_RESPONSE_KEYS.has(key)) continue;
    result[key] = canonicalizeResponseValue(value[key], document, anchors, referenceStack);
  }
  return result;
}

export function createResponseCompatibilitySnapshot(document) {
  const anchors = collectAnchors(document);
  const operations = {};

  for (const pathName of Object.keys(document.paths ?? {}).sort()) {
    const pathItem = document.paths[pathName];
    if (pathItem === null || typeof pathItem !== 'object') continue;
    for (const method of [...HTTP_METHODS].sort()) {
      const operation = pathItem[method];
      if (operation === null || typeof operation !== 'object') continue;
      const operationId = operation.operationId;
      if (typeof operationId !== 'string' || operationId.length === 0) continue;
      const responses = canonicalizeResponseValue(operation.responses ?? {}, document, anchors);
      operations[operationId] = {
        method: method.toUpperCase(),
        path: pathName,
        responseContractSha256: digest(JSON.stringify(canonicalJson(responses))),
        responseStatusCodes: Object.keys(operation.responses ?? {}).sort(),
      };
    }
  }

  return {
    schemaVersion: 'openapi-response-compatibility/1',
    operations,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function responseSnapshotText(snapshot) {
  return `${JSON.stringify(canonicalJson(snapshot), null, 2)}\n`;
}

export function assertResponseCompatibilitySnapshot(baseline, current) {
  const baselineText = responseSnapshotText(baseline);
  const currentText = responseSnapshotText(current);
  if (baselineText !== currentText) {
    throw new Error(
      'Potential breaking OpenAPI response change detected: response contracts differ from ' +
        `the reviewed baseline (baseline=${digest(baselineText)}, current=${digest(currentText)}). ` +
        'Review the response diff before running ' +
        '`pnpm --filter @better-agent/api-contract accept-response-baseline`.',
    );
  }
  return { responseBaselineSha256: digest(currentText), responseBaselineText: currentText };
}

function isSelfReference(value) {
  return value !== null && typeof value === 'object' && value.$ref === PUBLIC_REDACTED_PAYLOAD_PATH;
}

function hasRecursivePublicPayload(document) {
  const schema = document.components?.schemas?.PublicRedactedPayload;
  if (schema === undefined) {
    return false;
  }
  if (schema === null || typeof schema !== 'object' || !Array.isArray(schema.oneOf)) {
    throw new Error('PublicRedactedPayload must be the recursive public JSON-value schema');
  }

  const primitiveTypes = new Set();
  let hasArray = false;
  let hasObject = false;
  for (const variant of schema.oneOf) {
    if (variant === null || typeof variant !== 'object') {
      continue;
    }
    if (['string', 'number', 'boolean', 'null'].includes(variant.type)) {
      primitiveTypes.add(variant.type);
    } else if (variant.type === 'array' && isSelfReference(variant.items)) {
      hasArray = true;
    } else if (variant.type === 'object' && isSelfReference(variant.additionalProperties)) {
      hasObject = true;
    }
  }

  const expectedPrimitives = ['boolean', 'null', 'number', 'string'];
  const actualPrimitives = [...primitiveTypes].sort();
  if (
    schema.oneOf.length !== 6 ||
    actualPrimitives.join(',') !== expectedPrimitives.join(',') ||
    !hasArray ||
    !hasObject
  ) {
    throw new Error(
      'PublicRedactedPayload changed shape; update its guarded recursive TypeScript mapping',
    );
  }
  return true;
}

function formatYamlErrors(sourcePath, errors) {
  const details = errors.map((error) => error.message).join('; ');
  return new Error(`OpenAPI YAML parse failed for ${sourcePath}: ${details}`);
}

function formatProblem(problem) {
  const rule = problem.ruleId === undefined ? 'unknown-rule' : problem.ruleId;
  const location = problem.location?.[0];
  const start = location?.start;
  const suffix = start === undefined ? '' : ` at ${start.line}:${start.col}`;
  return `[${rule}] ${problem.message}${suffix}`;
}

function throwForProblems(stage, sourcePath, problems) {
  const errors = problems.filter((problem) => problem.severity === 'error');
  if (errors.length === 0) {
    return;
  }

  throw new Error(
    `${stage} failed for ${sourcePath} with ${errors.length} error(s):\n${errors
      .map(formatProblem)
      .join('\n')}`,
  );
}

function withGeneratedBanner(typescriptText) {
  return [
    '// Generated from docs/api/openapi.yaml by @better-agent/api-contract.',
    '// DO NOT EDIT: run `pnpm --filter @better-agent/api-contract generate`.',
    '',
    typescriptText.trimEnd(),
    '',
  ].join('\n');
}

function credentialOperationPolicyRuntimeSnapshot(document, credentialPolicyContractPresent) {
  if (!credentialPolicyContractPresent) {
    return {
      schemaVersion: 'openapi-credential-operation-policy/1',
      serviceOperations: {},
    };
  }

  const snapshot = createCredentialOperationPolicySnapshot(document);
  return {
    schemaVersion: snapshot.schemaVersion,
    serviceOperations: snapshot.serviceOperations,
  };
}

function credentialOperationPolicyRegistryModuleText(snapshot) {
  const serviceOperationsLiteral = JSON.stringify(
    canonicalJson(snapshot.serviceOperations),
    null,
    2,
  )
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

  return withGeneratedBanner(`function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

const reviewedServiceCredentialOperations = deepFreeze(${serviceOperationsLiteral});

export const credentialOperationPolicyRegistrySchemaVersion = ${JSON.stringify(
    snapshot.schemaVersion,
  )};

export const serviceCredentialOperationIds = Object.freeze(
  Object.keys(reviewedServiceCredentialOperations),
);

export function getReviewedServiceCredentialOperation(operationId) {
  return Object.hasOwn(reviewedServiceCredentialOperations, operationId)
    ? reviewedServiceCredentialOperations[operationId]
    : undefined;
}`);
}

function renderCredentialOperationPolicyRegistryTypescript(snapshot) {
  const serviceOperationIds = Object.keys(snapshot.serviceOperations).sort();
  const operationIdType =
    serviceOperationIds.length === 0
      ? 'never'
      : serviceOperationIds.map((operationId) => JSON.stringify(operationId)).join(' | ');
  const methods = [
    ...new Set(Object.values(snapshot.serviceOperations).map((operation) => operation.method)),
  ].sort();
  const methodType =
    methods.length === 0 ? 'string' : methods.map((method) => JSON.stringify(method)).join(' | ');

  return withGeneratedBanner(`export type ServiceCredentialOperationId = ${operationIdType};

export interface ReviewedServiceCredentialOperation {
  readonly method: ${methodType};
  readonly path: string;
  readonly policy: Readonly<Record<string, unknown>>;
}

export declare const credentialOperationPolicyRegistrySchemaVersion: ${JSON.stringify(
    snapshot.schemaVersion,
  )};

export declare const serviceCredentialOperationIds: readonly ServiceCredentialOperationId[];

export declare function getReviewedServiceCredentialOperation(
  operationId: string,
): Readonly<ReviewedServiceCredentialOperation> | undefined;`);
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function parseContract(sourcePath) {
  const absoluteSourcePath = asAbsolutePath(sourcePath);
  const source = readFileSync(absoluteSourcePath, 'utf8');
  const parsed = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });

  if (parsed.errors.length > 0) {
    throw formatYamlErrors(absoluteSourcePath, parsed.errors);
  }

  const document = parsed.toJS({ mapAsMap: false });
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`OpenAPI root must be a mapping: ${absoluteSourcePath}`);
  }
  return document;
}

export function preflightContract(sourcePath) {
  const absoluteSourcePath = asAbsolutePath(sourcePath);
  const document = parseContract(absoluteSourcePath);

  if (typeof document.openapi !== 'string' || !/^3\.1\.\d+$/.test(document.openapi)) {
    throw new Error(
      `Expected an OpenAPI 3.1 document at ${absoluteSourcePath}; found ${String(document.openapi)}`,
    );
  }

  if (
    document.paths === null ||
    typeof document.paths !== 'object' ||
    Array.isArray(document.paths)
  ) {
    throw new Error(`OpenAPI paths must be a mapping: ${absoluteSourcePath}`);
  }

  const operationIds = collectOperationIds(document);
  const anchors = collectAnchors(document);
  const localReferences = collectLocalReferences(document);
  for (const reference of localReferences) {
    resolveLocalReference(document, reference, anchors);
  }
  const credentialOperationPolicies = validateCredentialOperationPolicies(document);

  return {
    ...credentialOperationPolicies,
    document,
    hasRecursivePublicPayload: hasRecursivePublicPayload(document),
    localReferenceCount: localReferences.length,
    operationIds,
  };
}

export async function validateContract(sourcePath, options = {}) {
  const absoluteSourcePath = asAbsolutePath(sourcePath);
  const configPath = asAbsolutePath(options.configPath ?? DEFAULT_CONFIG_PATH);
  const preflight = await preflightContract(absoluteSourcePath);
  const config = await loadConfig({ configPath });

  const lintProblems = await lint({ ref: absoluteSourcePath, config });
  throwForProblems('OpenAPI semantic lint', absoluteSourcePath, lintProblems);

  const bundleResult = await bundle({ ref: absoluteSourcePath, config });
  throwForProblems('OpenAPI bundle', absoluteSourcePath, bundleResult.problems);

  const normalizedBundle = normalizeLocalAnchorReferences(bundleResult.bundle.parsed);
  const bundleText = `${JSON.stringify(normalizedBundle, null, 2)}\n`;
  const typescriptOptions = {
    alphabetize: true,
    exportType: true,
  };
  if (preflight.hasRecursivePublicPayload) {
    typescriptOptions.inject = PUBLIC_REDACTED_PAYLOAD_ALIAS;
    typescriptOptions.transform = (_schema, options) =>
      options.path === PUBLIC_REDACTED_PAYLOAD_PATH
        ? ts.factory.createTypeReferenceNode('PublicRedactedPayloadValue')
        : undefined;
  }
  const typescriptAst = await openapiTS(normalizedBundle, typescriptOptions);
  const typescriptText = withGeneratedBanner(astToString(typescriptAst));
  const credentialOperationPolicyRuntime = credentialOperationPolicyRuntimeSnapshot(
    preflight.document,
    preflight.credentialPolicyContractPresent,
  );
  const credentialOperationPolicyRegistryText = credentialOperationPolicyRegistryModuleText(
    credentialOperationPolicyRuntime,
  );
  const credentialOperationPolicyRegistryTypescriptText =
    renderCredentialOperationPolicyRegistryTypescript(credentialOperationPolicyRuntime);

  return {
    browserOnlyOperationIds: preflight.browserOnlyOperationIds,
    bundleText,
    bundleSha256: digest(bundleText),
    credentialPolicyContractPresent: preflight.credentialPolicyContractPresent,
    credentialOperationPolicyRegistrySha256: digest(credentialOperationPolicyRegistryText),
    credentialOperationPolicyRegistryText,
    credentialOperationPolicyRegistryTypescriptSha256: digest(
      credentialOperationPolicyRegistryTypescriptText,
    ),
    credentialOperationPolicyRegistryTypescriptText,
    lintProblems,
    localReferenceCount: preflight.localReferenceCount,
    operationIds: preflight.operationIds,
    serviceOperationCount: preflight.serviceOperationCount,
    subjectAssertionProfileVersion: preflight.subjectAssertionProfileVersion,
    typescriptText,
    typescriptSha256: digest(typescriptText),
  };
}

export async function generateContract(options = {}) {
  const sourcePath = options.sourcePath ?? DEFAULT_CONTRACT_PATH;
  const outputDir = asAbsolutePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const result = await validateContract(sourcePath, options);
  const bundlePath = join(outputDir, 'openapi.bundle.json');
  const typescriptPath = join(outputDir, 'openapi.d.ts');
  const credentialOperationPolicyRegistryPath = join(
    outputDir,
    'credential-operation-policy-registry.js',
  );
  const credentialOperationPolicyRegistryTypescriptPath = join(
    outputDir,
    'credential-operation-policy-registry.d.ts',
  );

  await mkdir(outputDir, { recursive: true });
  if (options.allowExternalOutputDir !== true) {
    const [realPackageRoot, realOutputDir] = await Promise.all([
      realpath(PACKAGE_ROOT),
      realpath(outputDir),
    ]);
    const pathFromPackage = relative(realPackageRoot, realOutputDir);
    if (pathFromPackage.startsWith('..') || isAbsolute(pathFromPackage)) {
      throw new Error(`Contract output directory must stay inside ${realPackageRoot}`);
    }
  }
  for (const outputPath of [
    bundlePath,
    typescriptPath,
    credentialOperationPolicyRegistryPath,
    credentialOperationPolicyRegistryTypescriptPath,
  ]) {
    try {
      if ((await lstat(outputPath)).isSymbolicLink()) {
        throw new Error(`Generated contract artifact must not be a symlink: ${outputPath}`);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  await Promise.all([
    writeFile(bundlePath, result.bundleText, 'utf8'),
    writeFile(typescriptPath, result.typescriptText, 'utf8'),
    writeFile(
      credentialOperationPolicyRegistryPath,
      result.credentialOperationPolicyRegistryText,
      'utf8',
    ),
    writeFile(
      credentialOperationPolicyRegistryTypescriptPath,
      result.credentialOperationPolicyRegistryTypescriptText,
      'utf8',
    ),
  ]);

  return {
    ...result,
    bundlePath,
    credentialOperationPolicyRegistryPath,
    credentialOperationPolicyRegistryTypescriptPath,
    typescriptPath,
  };
}

async function readGenerated(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`Generated contract artifact is missing: ${path}`, { cause: error });
    }
    throw error;
  }
}

export async function checkResponseCompatibility(options = {}) {
  const sourcePath = options.sourcePath ?? DEFAULT_CONTRACT_PATH;
  const baselinePath = asAbsolutePath(
    options.responseBaselinePath ?? DEFAULT_RESPONSE_BASELINE_PATH,
  );
  const document = preflightContract(sourcePath).document;
  const baselineText = await readGenerated(baselinePath);
  let baseline;
  try {
    baseline = JSON.parse(baselineText);
  } catch (error) {
    throw new Error(`Response compatibility baseline is invalid JSON: ${baselinePath}`, {
      cause: error,
    });
  }
  return assertResponseCompatibilitySnapshot(
    baseline,
    createResponseCompatibilitySnapshot(document),
  );
}

export async function checkCredentialOperationPolicyCompatibility(options = {}) {
  const sourcePath = options.sourcePath ?? DEFAULT_CONTRACT_PATH;
  const baselinePath = asAbsolutePath(
    options.credentialOperationPolicyBaselinePath ??
      DEFAULT_CREDENTIAL_OPERATION_POLICY_BASELINE_PATH,
  );
  const document = preflightContract(sourcePath).document;
  const baselineText = await readGenerated(baselinePath);
  let baseline;
  try {
    baseline = JSON.parse(baselineText);
  } catch (error) {
    throw new Error(`Credential operation policy baseline is invalid JSON: ${baselinePath}`, {
      cause: error,
    });
  }
  return assertCredentialOperationPolicySnapshot(
    baseline,
    createCredentialOperationPolicySnapshot(document),
  );
}

export async function acceptCredentialOperationPolicyBaseline(options = {}) {
  const sourcePath = options.sourcePath ?? DEFAULT_CONTRACT_PATH;
  const baselinePath = asAbsolutePath(
    options.credentialOperationPolicyBaselinePath ??
      DEFAULT_CREDENTIAL_OPERATION_POLICY_BASELINE_PATH,
  );
  const baselineDirectory = dirname(baselinePath);
  await mkdir(baselineDirectory, { recursive: true });
  if (options.allowExternalBaselinePath !== true) {
    const [realPackageRoot, realBaselineDirectory] = await Promise.all([
      realpath(PACKAGE_ROOT),
      realpath(baselineDirectory),
    ]);
    const pathFromPackage = relative(realPackageRoot, realBaselineDirectory);
    if (pathFromPackage.startsWith('..') || isAbsolute(pathFromPackage)) {
      throw new Error(`Credential operation policy baseline must stay inside ${realPackageRoot}`);
    }
  }
  try {
    if ((await lstat(baselinePath)).isSymbolicLink()) {
      throw new Error(
        `Credential operation policy baseline must not be a symlink: ${baselinePath}`,
      );
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const snapshotText = credentialOperationPolicySnapshotText(
    createCredentialOperationPolicySnapshot(preflightContract(sourcePath).document),
  );
  await writeFile(baselinePath, snapshotText, 'utf8');
  return {
    baselinePath,
    credentialOperationPolicyBaselineSha256: digest(snapshotText),
  };
}

export async function acceptResponseCompatibilityBaseline(options = {}) {
  const sourcePath = options.sourcePath ?? DEFAULT_CONTRACT_PATH;
  const baselinePath = asAbsolutePath(
    options.responseBaselinePath ?? DEFAULT_RESPONSE_BASELINE_PATH,
  );
  const baselineDirectory = dirname(baselinePath);
  await mkdir(baselineDirectory, { recursive: true });
  if (options.allowExternalBaselinePath !== true) {
    const [realPackageRoot, realBaselineDirectory] = await Promise.all([
      realpath(PACKAGE_ROOT),
      realpath(baselineDirectory),
    ]);
    const pathFromPackage = relative(realPackageRoot, realBaselineDirectory);
    if (pathFromPackage.startsWith('..') || isAbsolute(pathFromPackage)) {
      throw new Error(`Response baseline must stay inside ${realPackageRoot}`);
    }
  }
  try {
    if ((await lstat(baselinePath)).isSymbolicLink()) {
      throw new Error(`Response baseline must not be a symlink: ${baselinePath}`);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const snapshotText = responseSnapshotText(
    createResponseCompatibilitySnapshot(preflightContract(sourcePath).document),
  );
  await writeFile(baselinePath, snapshotText, 'utf8');
  return { baselinePath, responseBaselineSha256: digest(snapshotText) };
}

export async function checkGeneratedContract(options = {}) {
  const sourcePath = options.sourcePath ?? DEFAULT_CONTRACT_PATH;
  const outputDir = asAbsolutePath(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const result = await validateContract(sourcePath, options);
  const bundlePath = join(outputDir, 'openapi.bundle.json');
  const typescriptPath = join(outputDir, 'openapi.d.ts');
  const credentialOperationPolicyRegistryPath = join(
    outputDir,
    'credential-operation-policy-registry.js',
  );
  const credentialOperationPolicyRegistryTypescriptPath = join(
    outputDir,
    'credential-operation-policy-registry.d.ts',
  );
  const [
    actualBundle,
    actualTypescript,
    actualCredentialOperationPolicyRegistry,
    actualCredentialOperationPolicyRegistryTypescript,
  ] = await Promise.all([
    readGenerated(bundlePath),
    readGenerated(typescriptPath),
    readGenerated(credentialOperationPolicyRegistryPath),
    readGenerated(credentialOperationPolicyRegistryTypescriptPath),
  ]);
  const drifted = [];

  if (actualBundle !== result.bundleText) {
    drifted.push(bundlePath);
  }
  if (actualTypescript !== result.typescriptText) {
    drifted.push(typescriptPath);
  }
  if (actualCredentialOperationPolicyRegistry !== result.credentialOperationPolicyRegistryText) {
    drifted.push(credentialOperationPolicyRegistryPath);
  }
  if (
    actualCredentialOperationPolicyRegistryTypescript !==
    result.credentialOperationPolicyRegistryTypescriptText
  ) {
    drifted.push(credentialOperationPolicyRegistryTypescriptPath);
  }
  if (drifted.length > 0) {
    throw new Error(
      `Generated OpenAPI artifacts are stale: ${drifted.join(', ')}. Run ` +
        '`pnpm --filter @better-agent/api-contract generate`.',
    );
  }

  const compatibility =
    options.checkResponseCompatibility === false
      ? {}
      : await checkResponseCompatibility({
          responseBaselinePath: options.responseBaselinePath,
          sourcePath,
        });

  const credentialOperationPolicyCompatibility =
    options.checkCredentialOperationPolicy === false || !result.credentialPolicyContractPresent
      ? {}
      : await checkCredentialOperationPolicyCompatibility({
          credentialOperationPolicyBaselinePath: options.credentialOperationPolicyBaselinePath,
          sourcePath,
        });

  return {
    ...result,
    ...compatibility,
    ...credentialOperationPolicyCompatibility,
    bundlePath,
    credentialOperationPolicyRegistryPath,
    credentialOperationPolicyRegistryTypescriptPath,
    typescriptPath,
  };
}
