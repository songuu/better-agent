import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BrowserSessionTokenError,
  deriveBrowserSessionVerifier,
  deriveCredentialVerifier,
  formatBrowserSessionToken,
  parseBrowserSessionToken,
  withBrowserSessionVerifier,
} from '../src/index.js';

describe('browser session bearer token v1', () => {
  it('round-trips a UUID selector and exactly 32 secret bytes', () => {
    const browserSessionId = randomUUID();
    const secret = randomBytes(32);
    const token = formatBrowserSessionToken({ browserSessionId, secret });

    expect(token).toMatch(/^bs1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
    const parsed = parseBrowserSessionToken(token);
    expect(parsed.browserSessionId).toBe(browserSessionId);
    expect(parsed.secret.equals(secret)).toBe(true);
    parsed.secret.fill(0);
    secret.fill(0);
  });

  it.each([
    '',
    'bs1.not-a-uuid.invalid',
    `bs2.${randomUUID()}.${randomBytes(32).toString('base64url')}`,
    `bs1.${randomUUID()}.${randomBytes(31).toString('base64url')}`,
    `bs1.${randomUUID()}.${randomBytes(33).toString('base64url')}`,
    `bs1.${randomUUID()}.${randomBytes(32).toString('base64url')}=`,
    `bs1.${randomUUID().toUpperCase()}.${randomBytes(32).toString('base64url')}`,
    `bs1.${randomUUID()}.${`${Buffer.alloc(32).toString('base64url').slice(0, -1)}B`}`,
  ])('fails closed without echoing malformed bearer input: %s', (input) => {
    expect(() => parseBrowserSessionToken(input)).toThrow(BrowserSessionTokenError);
    try {
      parseBrowserSessionToken(input);
    } catch (error) {
      expect(String(error)).not.toContain(input || 'raw-browser-session-token');
    }
  });

  it('uses a fixed domain-separated 32-byte HMAC verifier', () => {
    const secret = Buffer.alloc(32, 7);
    const pepper = Buffer.alloc(32, 9);
    const verifier = deriveBrowserSessionVerifier(secret, pepper);

    expect(verifier).toHaveLength(32);
    expect(verifier.toString('hex')).toBe(
      'cf152fa63c16d3eece9f565f11df0939a08fb1964877ba995fa3de7eb8445dac',
    );
    expect(verifier.equals(deriveCredentialVerifier(secret, pepper))).toBe(false);
    expect(() => deriveBrowserSessionVerifier(Buffer.alloc(31), pepper)).toThrow(
      BrowserSessionTokenError,
    );
    expect(() => deriveBrowserSessionVerifier(secret, Buffer.alloc(31))).toThrow(
      BrowserSessionTokenError,
    );
    secret.fill(0);
    pepper.fill(0);
    verifier.fill(0);
  });

  it('clears parsed secret and derived verifier after async use, including failures', async () => {
    const browserSessionId = randomUUID();
    const secret = Buffer.alloc(32, 3);
    const token = formatBrowserSessionToken({ browserSessionId, secret });
    const pepper = Buffer.alloc(32, 4);
    let verifierAfterSuccess: Buffer | undefined;

    const result = await withBrowserSessionVerifier(token, pepper, async (proof) => {
      verifierAfterSuccess = proof.verifier;
      expect(proof.browserSessionId).toBe(browserSessionId);
      expect(proof.verifier.some((byte) => byte !== 0)).toBe(true);
      return 'persisted';
    });
    expect(result).toBe('persisted');
    expect(verifierAfterSuccess?.every((byte) => byte === 0)).toBe(true);

    let verifierAfterFailure: Buffer | undefined;
    await expect(
      withBrowserSessionVerifier(token, pepper, async (proof) => {
        verifierAfterFailure = proof.verifier;
        throw new Error('database failed');
      }),
    ).rejects.toThrow('database failed');
    expect(verifierAfterFailure?.every((byte) => byte === 0)).toBe(true);
    secret.fill(0);
    pepper.fill(0);
  });
});
