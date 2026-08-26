import { createHmac, type KeyObject, verify } from 'node:crypto';

import {
  type VerifiedSubjectAssertionV1,
  VerifiedSubjectAssertionV1Schema,
} from '@better-agent/domain-contracts';

import { SubjectAssertionError } from './errors.js';

const assertionHeaderKeys = ['alg', 'kid', 'typ'] as const;
const assertionPayloadKeys = [
  'aud',
  'exp',
  'iat',
  'iss',
  'issuer_config_id',
  'key_version',
  'nonce',
  'origin',
  'sub',
  'version',
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

interface AssertionHeader {
  alg: string;
  kid: string;
  typ: string;
}

interface AssertionPayload {
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  issuer_config_id: string;
  key_version: number;
  nonce: string;
  origin: string;
  sub: string;
  version: string;
}

export interface SubjectAssertionSelector {
  issuerConfigId: string;
  keyVersion: number;
}

export interface SubjectAssertionTrustConfig {
  audience: string;
  clockSkewSeconds: number;
  issuer: string;
  issuerConfigId: string;
  keyVersion: number;
  maxTtlSeconds: number;
  publicKey: KeyObject;
  status: 'active' | 'revoked';
  workspaceId: string;
}

export interface VerifySubjectAssertionOptions {
  expectedOrigin: string;
  now?: Date;
  workspaceIdentityHashKey: Uint8Array;
}

function fail(reason: string): never {
  throw new SubjectAssertionError(reason);
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function decodeCanonicalJson(segment: string, context: string): Record<string, unknown> {
  if (!base64UrlPattern.test(segment)) fail(`${context}_encoding`);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(segment, 'base64url');
  } catch {
    fail(`${context}_encoding`);
  }
  if (bytes.toString('base64url') !== segment) fail(`${context}_encoding`);

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${context}_json`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context}_shape`);
  }
  const object = value as Record<string, unknown>;
  if (Buffer.from(canonicalJson(object)).toString('base64url') !== segment) {
    fail(`${context}_canonical`);
  }
  return object;
}

function parseAssertion(assertion: string): {
  header: AssertionHeader;
  payload: AssertionPayload;
  signature: Buffer;
  signingInput: Buffer;
} {
  const segments = assertion.split('.');
  if (segments.length !== 3) fail('compact_shape');
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    !base64UrlPattern.test(signatureSegment)
  ) {
    fail('compact_shape');
  }

  const header = decodeCanonicalJson(headerSegment, 'header');
  const payload = decodeCanonicalJson(payloadSegment, 'payload');
  if (!hasExactKeys(header, assertionHeaderKeys)) fail('header_fields');
  if (!hasExactKeys(payload, assertionPayloadKeys)) fail('claim_fields');

  const signature = Buffer.from(signatureSegment, 'base64url');
  if (signature.toString('base64url') !== signatureSegment || signature.byteLength !== 64) {
    fail('signature_encoding');
  }
  return {
    header: header as unknown as AssertionHeader,
    payload: payload as unknown as AssertionPayload,
    signature,
    signingInput: Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii'),
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function canonicalizeBrowserOrigin(
  input: string,
  options: { allowInsecureLoopback?: boolean } = {},
): string {
  if (input === 'null' || input.includes(',')) fail('origin');
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    fail('origin');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname.endsWith('.')
  ) {
    fail('origin');
  }
  const secure = parsed.protocol === 'https:';
  const allowedLoopback =
    options.allowInsecureLoopback === true &&
    parsed.protocol === 'http:' &&
    isLoopback(parsed.hostname);
  if (!secure && !allowedLoopback) fail('origin');
  return parsed.origin;
}

export function inspectSubjectAssertionSelector(assertion: string): SubjectAssertionSelector {
  const { header, payload } = parseAssertion(assertion);
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== 'ba-subject-assertion+jwt' ||
    typeof payload.issuer_config_id !== 'string' ||
    !uuidPattern.test(payload.issuer_config_id) ||
    !Number.isSafeInteger(payload.key_version) ||
    payload.key_version < 1 ||
    header.kid !== `${payload.issuer_config_id}.v${payload.key_version}`
  ) {
    fail('selector');
  }
  return { issuerConfigId: payload.issuer_config_id, keyVersion: payload.key_version };
}

function hashIdentity(key: Uint8Array, domain: 'nonce' | 'subject', ...values: string[]): string {
  const hmac = createHmac('sha256', key);
  hmac.update(`better-agent/${domain}-hash/1\0`);
  for (const value of values) hmac.update(value).update('\0');
  return hmac.digest('base64url');
}

export function verifySubjectAssertion(
  assertion: string,
  trust: SubjectAssertionTrustConfig,
  options: VerifySubjectAssertionOptions,
): VerifiedSubjectAssertionV1 {
  if (
    trust.status !== 'active' ||
    !uuidPattern.test(trust.workspaceId) ||
    !uuidPattern.test(trust.issuerConfigId) ||
    !Number.isSafeInteger(trust.keyVersion) ||
    trust.keyVersion < 1 ||
    !Number.isSafeInteger(trust.maxTtlSeconds) ||
    trust.maxTtlSeconds < 1 ||
    trust.maxTtlSeconds > 300 ||
    !Number.isSafeInteger(trust.clockSkewSeconds) ||
    trust.clockSkewSeconds < 0 ||
    trust.clockSkewSeconds > 30 ||
    options.workspaceIdentityHashKey.byteLength < 32
  ) {
    fail('trust_config');
  }

  const { header, payload, signature, signingInput } = parseAssertion(assertion);
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== 'ba-subject-assertion+jwt' ||
    header.kid !== `${trust.issuerConfigId}.v${trust.keyVersion}` ||
    payload.version !== 'subject-assertion/1' ||
    payload.issuer_config_id !== trust.issuerConfigId ||
    payload.key_version !== trust.keyVersion ||
    payload.iss !== trust.issuer ||
    payload.aud !== trust.audience ||
    typeof payload.sub !== 'string' ||
    payload.sub.length < 1 ||
    payload.sub.length > 1024 ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 22 ||
    payload.nonce.length > 256 ||
    !base64UrlPattern.test(payload.nonce) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp)
  ) {
    fail('claims');
  }

  if (!verify(null, signingInput, trust.publicKey, signature)) fail('signature');

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (
    payload.iat > nowSeconds + trust.clockSkewSeconds ||
    payload.exp <= nowSeconds - trust.clockSkewSeconds ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > trust.maxTtlSeconds
  ) {
    fail('time_window');
  }

  const claimOrigin = canonicalizeBrowserOrigin(payload.origin);
  const expectedOrigin = canonicalizeBrowserOrigin(options.expectedOrigin);
  if (payload.origin !== claimOrigin || claimOrigin !== expectedOrigin) fail('origin');

  const verified = {
    audience: payload.aud,
    canonical_origin: claimOrigin,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    issued_at: new Date(payload.iat * 1000).toISOString(),
    issuer: payload.iss,
    issuer_config_id: payload.issuer_config_id,
    key_version: payload.key_version,
    nonce_hash: hashIdentity(
      options.workspaceIdentityHashKey,
      'nonce',
      payload.issuer_config_id,
      payload.nonce,
    ),
    schema_version: 'verified-subject-assertion/1',
    signature_profile: 'jws-eddsa/1',
    // issuer_config_id/key_version rotate with keys. Stable issuer + subject,
    // under a workspace-scoped key, preserves revocation identity without
    // creating a cross-tenant correlation identifier.
    subject_hash: hashIdentity(
      options.workspaceIdentityHashKey,
      'subject',
      payload.iss,
      payload.sub,
    ),
  };
  return VerifiedSubjectAssertionV1Schema.parse(verified);
}
