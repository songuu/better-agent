import {
  type PublishedResourcePinV1,
  PublishedResourcePinV1Schema,
  Sha256HexV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';

export interface PublishedResourceOwnerIdentityV1 {
  readonly workspace_id: string;
  readonly published_resource_kind: PublishedResourcePinV1['published_resource_kind'];
  readonly resource_id: string;
  readonly resource_version_id: string;
}

export interface DerivedDependencyManifestV1 {
  readonly schema_version: 'published-resource-dependency-manifest/1';
  readonly owner: PublishedResourceOwnerIdentityV1;
  readonly dependencies: readonly PublishedResourcePinV1[];
  readonly manifest_hash: `sha256:${string}`;
}

function fail(
  code: 'RELEASE_INPUT_INVALID' | 'RELEASE_DEPENDENCY_INVALID' | 'RELEASE_WORKSPACE_MISMATCH',
  path: string,
  reason: string,
): never {
  throw new ReleaseCoreError(code, path, reason);
}

export function assertUuid(value: string, path: string): void {
  if (!UuidV1Schema.safeParse(value).success) {
    fail('RELEASE_INPUT_INVALID', path, 'published identities must be UUID values');
  }
}

export function assertSha256(value: string, path: string): void {
  if (!Sha256HexV1Schema.safeParse(value).success) {
    fail('RELEASE_INPUT_INVALID', path, 'published hashes must use sha256:<64 lowercase hex>');
  }
}

export function parseStrictPublishedResourcePin(
  value: unknown,
  path: string,
): PublishedResourcePinV1 {
  const parsed = PublishedResourcePinV1Schema.safeParse(value);
  if (!parsed.success) {
    fail('RELEASE_DEPENDENCY_INVALID', path, 'dependency is not a closed published resource pin');
  }
  assertUuid(parsed.data.workspace_id, `${path}.workspace_id`);
  assertUuid(parsed.data.resource_id, `${path}.resource_id`);
  assertUuid(parsed.data.resource_version_id, `${path}.resource_version_id`);
  assertSha256(parsed.data.contract_hash, `${path}.contract_hash`);
  return parsed.data;
}

export function publishedResourcePinKey(pin: PublishedResourcePinV1): string {
  return [
    pin.workspace_id,
    pin.published_resource_kind,
    pin.resource_id,
    pin.resource_version_id,
    pin.contract_hash,
    pin.binding_mode,
  ].join('\u0000');
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publishedResourceVersionKey(pin: PublishedResourcePinV1): string {
  return [
    pin.workspace_id,
    pin.published_resource_kind,
    pin.resource_id,
    pin.resource_version_id,
  ].join('\u0000');
}

export function normalizeDependencyPins(
  workspaceId: string,
  pins: readonly unknown[],
): readonly PublishedResourcePinV1[] {
  const byFullIdentity = new Map<string, PublishedResourcePinV1>();
  const hashesByVersion = new Map<string, string>();

  for (const [index, value] of pins.entries()) {
    const pin = parseStrictPublishedResourcePin(value, `$.dependencies[${index}]`);
    if (pin.workspace_id !== workspaceId) {
      fail(
        'RELEASE_WORKSPACE_MISMATCH',
        `$.dependencies[${index}].workspace_id`,
        'a published resource cannot depend on another Workspace',
      );
    }
    const versionKey = publishedResourceVersionKey(pin);
    const existingHash = hashesByVersion.get(versionKey);
    if (existingHash !== undefined && existingHash !== pin.contract_hash) {
      fail(
        'RELEASE_DEPENDENCY_INVALID',
        `$.dependencies[${index}].contract_hash`,
        'one resource version cannot resolve to multiple contract hashes',
      );
    }
    hashesByVersion.set(versionKey, pin.contract_hash);
    byFullIdentity.set(publishedResourcePinKey(pin), pin);
  }

  return [...byFullIdentity.values()].sort((left, right) =>
    compareCanonicalStrings(publishedResourcePinKey(left), publishedResourcePinKey(right)),
  );
}

export function deriveDependencyManifest(
  owner: PublishedResourceOwnerIdentityV1,
  dependencies: readonly unknown[],
): DerivedDependencyManifestV1 {
  assertUuid(owner.workspace_id, '$.owner.workspace_id');
  assertUuid(owner.resource_id, '$.owner.resource_id');
  assertUuid(owner.resource_version_id, '$.owner.resource_version_id');
  const normalizedDependencies = normalizeDependencyPins(owner.workspace_id, dependencies);
  const content = {
    schema_version: 'published-resource-dependency-manifest/1',
    owner: { ...owner },
    dependencies: normalizedDependencies.map((pin) => ({ ...pin })),
  } as const;

  return deepFreezeJson({
    ...content,
    manifest_hash: canonicalSha256(content),
  });
}

export function deepFreezeJson<const Value>(value: Value): Readonly<Value> {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Object.values(candidate)) visit(child);
    Object.freeze(candidate);
  };
  visit(value);
  return value;
}
