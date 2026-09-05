import { createHmac } from 'node:crypto';

import { RunEventSessionTokenError } from './errors.js';

const tokenPattern =
  /^res1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export interface RunEventSessionTokenMaterial {
  readonly eventSessionId: string;
  readonly secret: Buffer;
}

export interface RunEventSessionVerifierProof {
  readonly eventSessionId: string;
  readonly verifier: Buffer;
}

export function formatRunEventSessionToken(material: RunEventSessionTokenMaterial): string {
  if (material.secret.byteLength !== 32) throw new RunEventSessionTokenError();
  const token = `res1.${material.eventSessionId}.${material.secret.toString('base64url')}`;
  if (!tokenPattern.test(token)) throw new RunEventSessionTokenError();
  return token;
}

export function parseRunEventSessionToken(value: string): RunEventSessionTokenMaterial {
  const match = tokenPattern.exec(value);
  const eventSessionId = match?.[1];
  const encodedSecret = match?.[2];
  if (eventSessionId === undefined || encodedSecret === undefined) {
    throw new RunEventSessionTokenError();
  }
  const secret = Buffer.from(encodedSecret, 'base64url');
  if (secret.byteLength !== 32 || secret.toString('base64url') !== encodedSecret) {
    secret.fill(0);
    throw new RunEventSessionTokenError();
  }
  return { eventSessionId, secret };
}

export function deriveRunEventSessionVerifier(secret: Uint8Array, pepper: Uint8Array): Buffer {
  if (secret.byteLength !== 32 || pepper.byteLength < 32) {
    throw new RunEventSessionTokenError();
  }
  return createHmac('sha256', pepper)
    .update('better-agent/run-event-session-verifier/1\0')
    .update(secret)
    .digest();
}

export async function withRunEventSessionVerifier<Result>(
  token: string,
  pepper: Uint8Array,
  use: (proof: RunEventSessionVerifierProof) => Promise<Result>,
): Promise<Result> {
  const material = parseRunEventSessionToken(token);
  let verifier: Buffer | undefined;
  try {
    verifier = deriveRunEventSessionVerifier(material.secret, pepper);
    return await use({ eventSessionId: material.eventSessionId, verifier });
  } finally {
    material.secret.fill(0);
    verifier?.fill(0);
  }
}
