import { describe, expect, it } from 'vitest';

import {
  deriveRunEventSessionVerifier,
  formatRunEventSessionToken,
  parseRunEventSessionToken,
  withRunEventSessionVerifier,
} from '../src/index.js';

const id = '01900000-0000-7000-8000-000000000001';

describe('Run event-session token', () => {
  it('round-trips a canonical opaque token', () => {
    const secret = Buffer.alloc(32, 7);
    const token = formatRunEventSessionToken({ eventSessionId: id, secret });
    expect(token).toMatch(/^res1\./u);
    expect(parseRunEventSessionToken(token)).toEqual({ eventSessionId: id, secret });
  });

  it('uses a domain-separated verifier', () => {
    const secret = Buffer.alloc(32, 7);
    const pepper = Buffer.alloc(32, 8);
    expect(deriveRunEventSessionVerifier(secret, pepper)).not.toEqual(
      deriveRunEventSessionVerifier(Buffer.alloc(32, 9), pepper),
    );
  });

  it.each(['', `res1.${id}.bad`, `bs1.${id}.${Buffer.alloc(32).toString('base64url')}`])(
    'rejects malformed or cross-protocol token %s',
    (token) => expect(() => parseRunEventSessionToken(token)).toThrow(),
  );

  it('clears parsed secret and verifier after scoped use', async () => {
    const token = formatRunEventSessionToken({ eventSessionId: id, secret: Buffer.alloc(32, 3) });
    let verifier: Buffer | undefined;
    await withRunEventSessionVerifier(token, Buffer.alloc(32, 4), async (proof) => {
      verifier = proof.verifier;
      expect(proof.eventSessionId).toBe(id);
      expect(proof.verifier.equals(Buffer.alloc(32))).toBe(false);
    });
    expect(verifier).toEqual(Buffer.alloc(32));
  });
});
