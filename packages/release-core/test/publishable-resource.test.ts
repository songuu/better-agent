import { describe, expect, it } from 'vitest';

import { preparePublishedResource, ReleaseCoreError } from '../src/index.js';
import {
  makeAgentRelease,
  makeFlowIr,
  makePluginPin,
  makeStrategyPin,
  otherWorkspaceId,
  workspaceId,
} from './fixtures.js';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'publishable-resource-candidate/1',
    source_kind: 'sealed_candidate',
    workspace_id: workspaceId,
    declared_kind: 'FLOW_VERSION',
    document: makeFlowIr(),
    registered_dependency_pins: [],
    ...overrides,
  };
}

describe('kind-safe published resource preparation', () => {
  it('derives a deterministic manifest and returns a deeply frozen DB command', () => {
    const prepared = preparePublishedResource(candidate());
    const repeated = preparePublishedResource(candidate());

    expect(prepared).toEqual(repeated);
    expect(prepared.schema_version).toBe('prepared-published-resource/1');
    expect(prepared.full_pin).toMatchObject({
      workspace_id: workspaceId,
      published_resource_kind: 'FLOW_VERSION',
    });
    expect(prepared.dependency_manifest.dependencies).toEqual([]);
    expect(prepared.canonical_document).toBe(
      Buffer.from(prepared.canonical_document, 'utf8').toString('utf8'),
    );
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.full_pin)).toBe(true);
    expect(Object.isFrozen(prepared.dependency_manifest.dependencies)).toBe(true);
  });

  it('rejects Drafts, free dependency manifests and unimplemented future kinds', () => {
    expect(() => preparePublishedResource(candidate({ source_kind: 'draft' }))).toThrowError(
      ReleaseCoreError,
    );
    expect(() =>
      preparePublishedResource(candidate({ dependency_manifest: { dependencies: [] } })),
    ).toThrowError(ReleaseCoreError);
    expect(() =>
      preparePublishedResource(
        candidate({ declared_kind: 'PLUGIN_TOOL_RELEASE', document: { schema_version: 'x/1' } }),
      ),
    ).toThrowError(/RELEASE_KIND_UNSUPPORTED/);
  });

  it('has no opaque fallback for a declared kind/payload mismatch', () => {
    expect(() =>
      preparePublishedResource(candidate({ declared_kind: 'EXPERIENCE_RELEASE' })),
    ).toThrowError(/RELEASE_KIND_MISMATCH/);
  });

  it('rejects cross-workspace and unregistered derived dependencies', () => {
    const crossWorkspacePin = makeStrategyPin(otherWorkspaceId);
    expect(() =>
      preparePublishedResource(
        candidate({
          document: { ...makeFlowIr(), resources: [crossWorkspacePin] },
          registered_dependency_pins: [crossWorkspacePin],
        }),
      ),
    ).toThrowError(/RELEASE_WORKSPACE_MISMATCH/);
    expect(() =>
      preparePublishedResource(
        candidate({ document: { ...makeFlowIr(), resources: [makeStrategyPin()] } }),
      ),
    ).toThrowError(/RELEASE_DEPENDENCY_UNREGISTERED/);
  });

  it('pauses Agent Release publication until compiler and closure preimages are authoritative', () => {
    expect(() =>
      preparePublishedResource(
        candidate({
          declared_kind: 'AGENT_RELEASE',
          document: makeAgentRelease(),
          registered_dependency_pins: [makeStrategyPin(), makePluginPin()],
        }),
      ),
    ).toThrowError(/RELEASE_KIND_UNSUPPORTED/);
  });

  it('rejects dependency kinds that have no physical published-resource registry writer', () => {
    expect(() =>
      preparePublishedResource(
        candidate({
          document: { ...makeFlowIr(), resources: [makePluginPin()] },
          registered_dependency_pins: [makePluginPin()],
        }),
      ),
    ).toThrowError(/RELEASE_KIND_UNSUPPORTED/);
  });
});
