import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeBrowserOrigin,
  inspectSubjectAssertionSelector,
  SubjectAssertionError,
  verifySubjectAssertion,
} from '../src/index.js';

const now = new Date('2026-08-26T03:00:00.000Z');
const issuerConfigId = '018f47f2-c541-7cc6-9292-4a2c35303ee1';
const issuer = 'https://host.example/identity';
const audience = 'better-agent:browser-exchange';
const origin = 'https://app.example';
const keyVersion = 3;
const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303ee2';

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function createAssertion(
  privateKey: KeyObject,
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = {
    alg: 'EdDSA',
    kid: `${issuerConfigId}.v${keyVersion}`,
    typ: 'ba-subject-assertion+jwt',
    ...headerOverrides,
  };
  const payload = {
    aud: audience,
    exp: Math.floor(now.getTime() / 1000) + 240,
    iat: Math.floor(now.getTime() / 1000),
    iss: issuer,
    issuer_config_id: issuerConfigId,
    key_version: keyVersion,
    nonce: randomBytes(24).toString('base64url'),
    origin,
    sub: 'host-user-42',
    version: 'subject-assertion/1',
    ...overrides,
  };
  const protectedSegment = Buffer.from(canonicalJson(header)).toString('base64url');
  const payloadSegment = Buffer.from(canonicalJson(payload)).toString('base64url');
  const signingInput = Buffer.from(`${protectedSegment}.${payloadSegment}`, 'ascii');
  const signature = sign(null, signingInput, privateKey).toString('base64url');
  return `${protectedSegment}.${payloadSegment}.${signature}`;
}

function trust(
  publicKey: KeyObject,
  overrides: { issuerConfigId?: string; keyVersion?: number } = {},
) {
  return {
    audience,
    clockSkewSeconds: 30,
    issuer,
    issuerConfigId,
    keyVersion,
    maxTtlSeconds: 300,
    publicKey,
    status: 'active' as const,
    workspaceId,
    ...overrides,
  };
}

describe('subject assertion EdDSA v1', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  it('verifies the closed profile and returns hashes instead of replayable claims', () => {
    const assertion = createAssertion(privateKey);
    expect(inspectSubjectAssertionSelector(assertion)).toEqual({ issuerConfigId, keyVersion });

    const verified = verifySubjectAssertion(assertion, trust(publicKey), {
      expectedOrigin: origin,
      workspaceIdentityHashKey: Buffer.alloc(32, 5),
      now,
    });

    expect(verified).toMatchObject({
      audience,
      canonical_origin: origin,
      issuer,
      issuer_config_id: issuerConfigId,
      key_version: keyVersion,
      schema_version: 'verified-subject-assertion/1',
      signature_profile: 'jws-eddsa/1',
    });
    expect(verified.subject_hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(verified.nonce_hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(verified)).not.toContain('host-user-42');
    expect(JSON.stringify(verified)).not.toContain(assertion);
  });

  it.each([
    ['issuer', { iss: 'https://evil.example' }, {}],
    ['audience', { aud: 'wrong-audience' }, {}],
    ['origin', { origin: 'https://evil.example' }, {}],
    ['algorithm', {}, { alg: 'none' }],
    ['key version', { key_version: 4 }, {}],
    ['expired', { exp: Math.floor(now.getTime() / 1000) - 31 }, {}],
    ['future issued-at', { iat: Math.floor(now.getTime() / 1000) + 31 }, {}],
    ['overlong lifetime', { exp: Math.floor(now.getTime() / 1000) + 301 }, {}],
    ['unknown claim', { principal_id: randomUUID() }, {}],
  ])('rejects invalid %s without echoing the assertion', (_name, payload, header) => {
    const assertion = createAssertion(privateKey, payload, header);
    try {
      verifySubjectAssertion(assertion, trust(publicKey), {
        expectedOrigin: origin,
        workspaceIdentityHashKey: Buffer.alloc(32, 5),
        now,
      });
      expect.unreachable('verification should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SubjectAssertionError);
      expect(String(error)).not.toContain(assertion);
      expect(String(error)).not.toContain('host-user-42');
    }
  });

  it('rejects a valid signature made by a different key and inactive trust config', () => {
    const other = generateKeyPairSync('ed25519');
    const assertion = createAssertion(other.privateKey);
    expect(() =>
      verifySubjectAssertion(assertion, trust(publicKey), {
        expectedOrigin: origin,
        workspaceIdentityHashKey: Buffer.alloc(32, 5),
        now,
      }),
    ).toThrow(SubjectAssertionError);
    expect(() =>
      verifySubjectAssertion(
        assertion,
        { ...trust(other.publicKey), status: 'revoked' },
        {
          expectedOrigin: origin,
          workspaceIdentityHashKey: Buffer.alloc(32, 5),
          now,
        },
      ),
    ).toThrow(SubjectAssertionError);
  });

  it('keeps the subject identity stable across issuer key/config rotation', () => {
    const rotatedIssuerConfigId = '018f47f2-c541-7cc6-9292-4a2c35303ee8';
    const first = verifySubjectAssertion(
      createAssertion(privateKey, { nonce: 'A'.repeat(24), sub: 'stable-subject' }),
      trust(publicKey),
      { expectedOrigin: origin, workspaceIdentityHashKey: Buffer.alloc(32, 5), now },
    );
    const rotated = verifySubjectAssertion(
      createAssertion(
        privateKey,
        {
          issuer_config_id: rotatedIssuerConfigId,
          key_version: 4,
          nonce: 'B'.repeat(24),
          sub: 'stable-subject',
        },
        { kid: `${rotatedIssuerConfigId}.v4` },
      ),
      trust(publicKey, { issuerConfigId: rotatedIssuerConfigId, keyVersion: 4 }),
      { expectedOrigin: origin, workspaceIdentityHashKey: Buffer.alloc(32, 5), now },
    );

    expect(rotated.subject_hash).toBe(first.subject_hash);
    expect(rotated.nonce_hash).not.toBe(first.nonce_hash);
  });
});

describe('browser origin canonicalization', () => {
  it.each([
    ['https://EXAMPLE.com', 'https://example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['https://例子.测试', 'https://xn--fsqu00a.xn--0zwm56d'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(canonicalizeBrowserOrigin(input)).toBe(expected);
  });

  it.each([
    'null',
    'http://example.com',
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com/#fragment',
    'https://example.com.',
  ])('rejects unsafe origin %s', (input) => {
    expect(() => canonicalizeBrowserOrigin(input)).toThrow(SubjectAssertionError);
  });
});
