import { createHash } from 'node:crypto';

import {
  BindingPathSegmentV1Schema,
  PublishedResourcePinV1Schema,
  Sha256HexV1Schema,
} from '@better-agent/domain-contracts';

import { canonicalJsonBytes } from './canonical-json.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { ReleaseCoreError } from './errors.js';

export type CanonicalBindingPathV1 = `bp1.${string}`;
export type ClosureResourceNodeIdV1 = `rn1.${string}`;

type Segment = ReturnType<typeof BindingPathSegmentV1Schema.parse>;
type Pin = ReturnType<typeof PublishedResourcePinV1Schema.parse>;

const maximumPathBytes = 1_048_576;
const maximumRegistryEntries = 8_192;
const maximumRegistryBytes = 16_777_216;

function invalid(path: string, reason: string): never {
  throw new ReleaseCoreError('CLOSURE_IDENTITY_INPUT_INVALID', path, reason);
}

function limit(path: string, reason: string): never {
  throw new ReleaseCoreError('CLOSURE_IDENTITY_LIMIT_EXCEEDED', path, reason);
}

function assertPinHash(pin: Pin): void {
  if (pin.contract_hash.length !== 71 || !Sha256HexV1Schema.safeParse(pin.contract_hash).success) {
    invalid('$.contract_hash', 'pin contract hash must be canonical sha256 lowercase hex');
  }
}

function pinFields(pin: Pin): string[] {
  assertPinHash(pin);
  return [
    pin.workspace_id,
    pin.published_resource_kind,
    pin.resource_id,
    pin.resource_version_id,
    pin.contract_hash,
    pin.binding_mode,
  ];
}

function segmentFields(segment: Segment): { tag: number; fields: string[] } {
  switch (segment.segment_kind) {
    case 'root':
      return { tag: 1, fields: pinFields(segment.pin) };
    case 'binding':
      return {
        tag: 2,
        fields: [
          segment.owner.owner_kind,
          ...pinFields(segment.owner.pin),
          segment.binding_kind,
          segment.local_binding_id,
        ],
      };
    case 'flow_node':
      return {
        tag: 3,
        fields: [
          segment.owner.owner_kind,
          ...pinFields(segment.owner.pin),
          segment.graph_id,
          segment.node_id,
        ],
      };
    case 'skill_pack_member':
      return { tag: 4, fields: [...pinFields(segment.owner_pin), segment.local_member_binding_id] };
    case 'subagent_target':
      return { tag: 5, fields: pinFields(segment.target_pin) };
  }
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function encodeSegment(segment: Segment): Buffer {
  const { tag, fields } = segmentFields(segment);
  return Buffer.concat([
    Buffer.from([tag]),
    ...fields.map((value, index) => {
      const bytes = Buffer.from(value, 'utf8');
      return Buffer.concat([Buffer.from([index + 1]), uint32(bytes.length), bytes]);
    }),
  ]);
}

export function canonicalBindingPathBytes(input: unknown): Buffer {
  const snapshot = boundedDataSnapshot(input, 'identity');
  if (!Array.isArray(snapshot) || snapshot.length === 0) invalid('$', 'path requires segments');
  const segments = snapshot.map((value, index) => {
    const result = BindingPathSegmentV1Schema.safeParse(value);
    if (!result.success) invalid(`$[${index}]`, 'segment does not match the closed contract');
    return result.data;
  });
  const root = segments[0];
  if (root?.segment_kind !== 'root') invalid('$[0]', 'path must start with its root');
  const rootBytes = canonicalJsonBytes(root.pin);
  const chunks: Buffer[] = [uint32(segments.length)];
  let totalBytes = 4;
  for (const [index, segment] of segments.entries()) {
    if (index > 0 && segment.segment_kind === 'root') invalid(`$[${index}]`, 'root cannot recur');
    if (
      (segment.segment_kind === 'binding' || segment.segment_kind === 'flow_node') &&
      segment.owner.owner_kind === 'root' &&
      !canonicalJsonBytes(segment.owner.pin).equals(rootBytes)
    ) {
      invalid(`$[${index}].owner`, 'root owner pin must match the initial root');
    }
    const bytes = encodeSegment(segment);
    totalBytes += 4 + bytes.length;
    if (totalBytes > maximumPathBytes) limit('$', 'encoded path exceeds byte limit');
    chunks.push(uint32(bytes.length), bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

function resourceNodeBytes(input: unknown): Buffer {
  const parsed = PublishedResourcePinV1Schema.safeParse(boundedDataSnapshot(input, 'identity'));
  if (!parsed.success) invalid('$', 'resource pin does not match the closed contract');
  assertPinHash(parsed.data);
  return canonicalJsonBytes(parsed.data);
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

export function canonicalBindingPath(segments: unknown): CanonicalBindingPathV1 {
  return `bp1.${digest(canonicalBindingPathBytes(segments))}`;
}

export function canonicalResourceNodeId(pin: unknown): ClosureResourceNodeIdV1 {
  return `rn1.${digest(resourceNodeBytes(pin))}`;
}

function assertDigestSpelling(
  expected: unknown,
  prefix: 'bp1.' | 'rn1.',
): asserts expected is string {
  if (typeof expected !== 'string' || expected.length !== 47 || !expected.startsWith(prefix)) {
    invalid('$', 'identity must be a canonical prefixed SHA-256 digest');
  }
  const encoded = expected.slice(4);
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(encoded) ||
    Buffer.from(encoded, 'base64url').toString('base64url') !== encoded
  ) {
    invalid('$', 'identity digest is not canonical base64url');
  }
}

export function verifyCanonicalBindingPath(
  expected: unknown,
  segments: unknown,
): CanonicalBindingPathV1 {
  assertDigestSpelling(expected, 'bp1.');
  const computed = canonicalBindingPath(segments);
  if (expected !== computed)
    throw new ReleaseCoreError(
      'CLOSURE_IDENTITY_MISMATCH',
      '$',
      'binding path digest does not match its segments',
    );
  return computed;
}

export function verifyCanonicalResourceNodeId(
  expected: unknown,
  pin: unknown,
): ClosureResourceNodeIdV1 {
  assertDigestSpelling(expected, 'rn1.');
  const computed = canonicalResourceNodeId(pin);
  if (expected !== computed)
    throw new ReleaseCoreError(
      'CLOSURE_IDENTITY_MISMATCH',
      '$',
      'resource node digest does not match its pin',
    );
  return computed;
}

export interface ClosureIdentityRegistry {
  registerBindingPath(segments: unknown): CanonicalBindingPathV1;
  registerResourceNode(pin: unknown): ClosureResourceNodeIdV1;
}

/** One registry per bounded compilation, with no caller-controlled hashing or shared state. */
export function createClosureIdentityRegistry(): ClosureIdentityRegistry {
  const identities = new Map<string, Buffer>();
  let storedBytes = 0;

  function register(prefix: 'bp1.' | 'rn1.', bytes: Buffer): string {
    const identity = `${prefix}${digest(bytes)}`;
    const existing = identities.get(identity);
    if (existing !== undefined) {
      if (!existing.equals(bytes)) {
        throw new ReleaseCoreError(
          prefix === 'bp1.' ? 'BINDING_PATH_DIGEST_COLLISION' : 'RESOURCE_NODE_ID_COLLISION',
          '$',
          'digest is already associated with different canonical data',
        );
      }
      if (prefix === 'bp1.')
        throw new ReleaseCoreError(
          'CLOSURE_BINDING_PATH_DUPLICATE',
          '$',
          'binding path is already registered',
        );
      return identity;
    }
    if (
      identities.size >= maximumRegistryEntries ||
      storedBytes + bytes.length > maximumRegistryBytes
    ) {
      limit('$', 'identity registry exceeds its entry or byte budget');
    }
    identities.set(identity, bytes);
    storedBytes += bytes.length;
    return identity;
  }

  return Object.freeze({
    registerBindingPath: (segments: unknown) =>
      register('bp1.', canonicalBindingPathBytes(segments)) as CanonicalBindingPathV1,
    registerResourceNode: (pin: unknown) =>
      register('rn1.', resourceNodeBytes(pin)) as ClosureResourceNodeIdV1,
  });
}
