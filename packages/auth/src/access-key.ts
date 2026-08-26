import { createHmac } from 'node:crypto';

import { AuthenticationInputError } from './errors.js';

const accessKeyPattern =
  /^ba1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export interface AccessKeyMaterial {
  keyId: string;
  secret: Buffer;
}

function isCanonicalBase64Url(value: string, bytes: Buffer): boolean {
  return bytes.toString('base64url') === value;
}

export function formatAccessKey(material: AccessKeyMaterial): string {
  if (!accessKeyPattern.test(`ba1.${material.keyId}.${material.secret.toString('base64url')}`)) {
    throw new AuthenticationInputError();
  }
  if (material.secret.byteLength !== 32) throw new AuthenticationInputError();
  return `ba1.${material.keyId}.${material.secret.toString('base64url')}`;
}

export function parseAccessKey(value: string): AccessKeyMaterial {
  const match = accessKeyPattern.exec(value);
  if (match === null) throw new AuthenticationInputError();
  const keyId = match[1];
  const encodedSecret = match[2];
  if (keyId === undefined || encodedSecret === undefined) throw new AuthenticationInputError();

  const secret = Buffer.from(encodedSecret, 'base64url');
  if (secret.byteLength !== 32 || !isCanonicalBase64Url(encodedSecret, secret)) {
    secret.fill(0);
    throw new AuthenticationInputError();
  }
  return { keyId, secret };
}

export function deriveCredentialVerifier(secret: Uint8Array, pepper: Uint8Array): Buffer {
  if (secret.byteLength !== 32 || pepper.byteLength < 32) {
    throw new AuthenticationInputError();
  }
  return createHmac('sha256', pepper)
    .update('better-agent/access-key-verifier/1\0')
    .update(secret)
    .digest();
}
