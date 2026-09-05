import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes } from '../src/canonical-json.js';
import { canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import {
  prepareExecutableClosureStorage,
  verifyExecutableClosureStorage,
} from '../src/executable-closure-storage.js';
import { hashA, otherWorkspaceId } from './fixtures.js';
import { executableStorageFixture } from './executable-closure-storage-fixtures.js';

describe('source-backed executable closure storage', () => {
  it.each(['AGENT_RELEASE', 'FLOW_VERSION'] as const)(
    'round-trips %s from exact canonical stored bytes',
    (kind) => {
      const value = executableStorageFixture(kind);
      const storage = prepareExecutableClosureStorage(value.sourceInput, value.closure);
      expect(storage.prepared_resource.full_pin.contract_hash).not.toBe(
        value.source.root.semantic_seed_hash,
      );
      const verified = verifyExecutableClosureStorage(storage.prepared_resource.full_pin, storage);
      expect(verified.closure).toEqual(value.closure);
      expect(verified.source).toEqual(value.source);
      expect(Object.isFrozen(verified.closure)).toBe(true);
      expect(JSON.parse(storage.canonical_closure_preimage)).not.toHaveProperty('closure_hash');
    },
  );

  it.each([
    'missing',
    'unknown',
    'document',
    'compiled',
    'closure',
    'manifest',
    'legacy',
    'self-hash',
  ] as const)('rejects independently corrupted %s readback', (mutation) => {
    const value = executableStorageFixture('AGENT_RELEASE');
    const storage = prepareExecutableClosureStorage(value.sourceInput, value.closure);
    const changed = structuredClone(storage) as Record<string, unknown>;
    const prepared = changed.prepared_resource as Record<string, unknown>;
    if (mutation === 'missing') delete changed.canonical_closure_preimage;
    if (mutation === 'unknown') changed.extra = true;
    if (mutation === 'document') {
      const document = JSON.parse(String(prepared.canonical_document));
      document.runtime_limits = { max_steps: 2 };
      prepared.canonical_document = canonicalJsonBytes(document).toString('utf8');
    }
    if (mutation === 'compiled')
      changed.canonical_compiled_preimage = `${storage.canonical_compiled_preimage} `;
    if (mutation === 'closure')
      changed.canonical_closure_preimage = `${storage.canonical_closure_preimage} `;
    if (mutation === 'manifest')
      (prepared.dependency_manifest as Record<string, unknown>).dependencies = [];
    if (mutation === 'legacy') {
      const document = JSON.parse(String(prepared.canonical_document));
      document.compiled_hash = value.source.root.semantic_seed_hash;
      prepared.canonical_document = canonicalJsonBytes(document).toString('utf8');
    }
    if (mutation === 'self-hash')
      changed.canonical_closure_preimage = canonicalJsonBytes(value.closure).toString('utf8');
    expect(() =>
      verifyExecutableClosureStorage(storage.prepared_resource.full_pin, changed),
    ).toThrow();
  });

  it.each([
    'workspace_id',
    'resource_id',
    'resource_version_id',
    'contract_hash',
    'published_resource_kind',
    'binding_mode',
  ] as const)('requires the independently expected %s', (field) => {
    const value = executableStorageFixture('AGENT_RELEASE');
    const storage = prepareExecutableClosureStorage(value.sourceInput, value.closure);
    const expected = {
      ...storage.prepared_resource.full_pin,
      [field]:
        field === 'contract_hash'
          ? hashA
          : field === 'published_resource_kind'
            ? 'FLOW_VERSION'
            : field === 'binding_mode'
              ? 'latest'
              : otherWorkspaceId,
    };
    expect(() => verifyExecutableClosureStorage(expected, storage)).toThrow();
  });

  it('rejects a resealed closure with a source manifest omission', () => {
    const value = executableStorageFixture('AGENT_RELEASE');
    const changed = { ...structuredClone(value.closure), assembly_pins: [] };
    changed.closure_hash = canonicalSha256ExcludingRootKeys(changed, ['closure_hash']);
    expect(() => prepareExecutableClosureStorage(value.sourceInput, changed)).toThrow();
  });
});
