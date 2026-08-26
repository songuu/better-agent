import { createHmac } from 'node:crypto';

import { BrowserSessionTokenError } from './errors.js';

const browserSessionTokenPattern =
  /^bs1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export interface BrowserSessionTokenMaterial {
  readonly browserSessionId: string;
  readonly secret: Buffer;
}

export interface BrowserSessionVerifierProof {
  readonly browserSessionId: string;
  readonly verifier: Buffer;
}

function isCanonicalBase64Url(value: string, bytes: Buffer): boolean {
  return bytes.toString('base64url') === value;
}

export function formatBrowserSessionToken(material: BrowserSessionTokenMaterial): string {
  if (material.secret.byteLength !== 32) throw new BrowserSessionTokenError();
  const encodedSecret = material.secret.toString('base64url');
  const token = `bs1.${material.browserSessionId}.${encodedSecret}`;
  if (!browserSessionTokenPattern.test(token)) throw new BrowserSessionTokenError();
  return token;
}

export function parseBrowserSessionToken(value: string): BrowserSessionTokenMaterial {
  const match = browserSessionTokenPattern.exec(value);
  if (match === null) throw new BrowserSessionTokenError();
  const browserSessionId = match[1];
  const encodedSecret = match[2];
  if (browserSessionId === undefined || encodedSecret === undefined) {
    throw new BrowserSessionTokenError();
  }

  const secret = Buffer.from(encodedSecret, 'base64url');
  if (secret.byteLength !== 32 || !isCanonicalBase64Url(encodedSecret, secret)) {
    secret.fill(0);
    throw new BrowserSessionTokenError();
  }
  return { browserSessionId, secret };
}

export function deriveBrowserSessionVerifier(secret: Uint8Array, pepper: Uint8Array): Buffer {
  if (secret.byteLength !== 32 || pepper.byteLength < 32) {
    throw new BrowserSessionTokenError();
  }
  return createHmac('sha256', pepper)
    .update('better-agent/browser-session-verifier/1\0')
    .update(secret)
    .digest();
}

export async function withBrowserSessionVerifier<Result>(
  token: string,
  pepper: Uint8Array,
  use: (proof: BrowserSessionVerifierProof) => Promise<Result>,
): Promise<Result> {
  const material = parseBrowserSessionToken(token);
  let verifier: Buffer | undefined;
  try {
    verifier = deriveBrowserSessionVerifier(material.secret, pepper);
    return await use({ browserSessionId: material.browserSessionId, verifier });
  } finally {
    material.secret.fill(0);
    verifier?.fill(0);
  }
}
