import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AuthenticationInputError,
  deriveCredentialVerifier,
  formatAccessKey,
  parseAccessKey,
} from '../src/index.js';

describe('Access-Key v1', () => {
  it('round-trips a UUID selector and exactly 32 bytes of secret material', () => {
    const keyId = randomUUID();
    const secret = randomBytes(32);
    const serialized = formatAccessKey({ keyId, secret });

    expect(serialized).toMatch(/^ba1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
    const parsed = parseAccessKey(serialized);
    expect(parsed.keyId).toBe(keyId);
    expect(parsed.secret.equals(secret)).toBe(true);
    parsed.secret.fill(0);
  });

  it.each([
    '',
    'ba1.not-a-uuid.invalid',
    `ba2.${randomUUID()}.${randomBytes(32).toString('base64url')}`,
    `ba1.${randomUUID()}.${randomBytes(31).toString('base64url')}`,
    `ba1.${randomUUID()}.${randomBytes(32).toString('base64url')}=`,
  ])('fails closed without echoing malformed input: %s', (input) => {
    expect(() => parseAccessKey(input)).toThrow(AuthenticationInputError);
    try {
      parseAccessKey(input);
    } catch (error) {
      expect(String(error)).not.toContain(input || 'raw-access-key');
    }
  });

  it('derives a fixed 32-byte HMAC verifier and rejects weak peppers', () => {
    const secret = Buffer.alloc(32, 7);
    const pepper = Buffer.alloc(32, 9);
    const first = deriveCredentialVerifier(secret, pepper);
    const second = deriveCredentialVerifier(secret, pepper);

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
    expect(() => deriveCredentialVerifier(secret, Buffer.alloc(16))).toThrow(
      AuthenticationInputError,
    );
  });
});
