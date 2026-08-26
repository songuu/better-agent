import { describe, expect, it } from 'vitest';

import {
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  deriveDependencyManifest,
  prepareAgentDeploymentRevision,
  prepareFlowDeploymentRevision,
  preparePublishedResource,
} from '../src/index.js';
import {
  agentDeploymentId,
  agentDeploymentRevisionId,
  agentId,
  credentialMappingSetHash,
  flowDeploymentId,
  flowDeploymentRevisionId,
  flowId,
  hashA,
  hashC,
  makeAgentRelease,
  makeAgentReleasePin,
  makeAgentStable,
  makeExperiencePin,
  makeExperienceRelease,
  makeFlowIr,
  makeFlowStable,
  makePolicyPin,
  makeServiceMapping,
  otherWorkspaceId,
  workspaceId,
} from './fixtures.js';

function makeAgentRevision(
  overrides: Record<string, unknown> = {},
  mappings: readonly unknown[] = [makeServiceMapping()],
) {
  const dependencies = [makeAgentReleasePin(), makeExperiencePin()];
  const dependencyManifest = deriveDependencyManifest(
    {
      workspace_id: workspaceId,
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: agentDeploymentId,
      resource_version_id: agentDeploymentRevisionId,
    },
    dependencies,
  );
  const candidate = {
    schema_version: 'agent-deployment/1',
    deployment_kind: 'agent',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentDeploymentRevisionId,
    agent_id: agentId,
    environment: 'development',
    ingress_channel: 'service_api',
    agent_release: makeAgentReleasePin(),
    experience_release: makeExperiencePin(),
    policy_profile: makePolicyPin('deployment_profile'),
    entry_grant_policy: makePolicyPin('entry_grant'),
    entry_scope_policy: makePolicyPin('entry_scope'),
    credential_mappings: mappings,
    credential_mapping_hash: credentialMappingSetHash('agent', mappings),
    conversation_contract_hash: hashA,
    dependency_manifest_hash: dependencyManifest.manifest_hash,
    change_set_hash: hashA,
    revision_contract_hash: hashA,
    ...overrides,
  };
  return {
    ...candidate,
    revision_contract_hash: canonicalSha256ExcludingRootKeys(candidate, ['revision_contract_hash']),
  };
}

function makeFlowRevision(overrides: Record<string, unknown> = {}) {
  const flow = makeFlowIr();
  const flowPin = {
    workspace_id: workspaceId,
    published_resource_kind: 'FLOW_VERSION',
    resource_id: flow.flow_id,
    resource_version_id: flow.flow_version_id,
    contract_hash: canonicalSha256(flow),
    binding_mode: 'pinned',
  } as const;
  const dependencyManifest = deriveDependencyManifest(
    {
      workspace_id: workspaceId,
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: flowDeploymentId,
      resource_version_id: flowDeploymentRevisionId,
    },
    [flowPin],
  );
  const candidate = {
    schema_version: 'flow-deployment/1',
    deployment_kind: 'flow',
    workspace_id: workspaceId,
    flow_deployment_id: flowDeploymentId,
    flow_deployment_revision_id: flowDeploymentRevisionId,
    flow_id: flowId,
    environment: 'staging',
    ingress_channel: 'service_api',
    flow_version: flowPin,
    policy_profile: makePolicyPin('deployment_profile'),
    entry_grant_policy: makePolicyPin('entry_grant'),
    entry_scope_policy: makePolicyPin('entry_scope'),
    credential_mappings: [],
    credential_mapping_hash: credentialMappingSetHash('flow', []),
    dependency_manifest_hash: dependencyManifest.manifest_hash,
    change_set_hash: hashA,
    revision_contract_hash: hashA,
    ...overrides,
  };
  return {
    ...candidate,
    revision_contract_hash: canonicalSha256ExcludingRootKeys(candidate, ['revision_contract_hash']),
  };
}

describe('Agent Deployment revision assembly', () => {
  it('verifies stable axes, releases, Experience, mappings and all derived hashes', () => {
    const prepared = prepareAgentDeploymentRevision({
      stable: makeAgentStable(),
      revision: makeAgentRevision(),
      agent_release: makeAgentRelease(),
      experience_release: makeExperienceRelease(),
    });

    expect(prepared.revision_contract_hash).toBe(makeAgentRevision().revision_contract_hash);
    expect(Object.isFrozen(prepared.credential_mappings)).toBe(true);
  });

  it('keeps publication paused after assembly until change-set preimages are authoritative', () => {
    const assembled = prepareAgentDeploymentRevision({
      stable: makeAgentStable(),
      revision: makeAgentRevision(),
      agent_release: makeAgentRelease(),
      experience_release: makeExperienceRelease(),
    });
    const envelope = {
      schema_version: 'publishable-resource-candidate/1',
      source_kind: 'sealed_candidate',
      workspace_id: workspaceId,
      declared_kind: 'DEPLOYMENT_REVISION',
      document: assembled,
      registered_dependency_pins: [makeAgentReleasePin(), makeExperiencePin()],
    } as const;

    expect(() => preparePublishedResource(envelope)).toThrowError(/RELEASE_KIND_UNSUPPORTED/);
    expect(() =>
      preparePublishedResource({ ...envelope, document: makeAgentRevision() }),
    ).toThrowError(/RELEASE_KIND_UNSUPPORTED/);
  });

  it('rejects stable environment, channel, Workspace and Agent identity drift', () => {
    for (const stable of [
      makeAgentStable({ environment: 'staging' }),
      makeAgentStable({ ingress_channel: 'browser' }),
      makeAgentStable({ workspace_id: otherWorkspaceId }),
      makeAgentStable({ agent_id: otherWorkspaceId }),
    ]) {
      expect(() =>
        prepareAgentDeploymentRevision({
          stable,
          revision: makeAgentRevision(),
          agent_release: makeAgentRelease(),
          experience_release: makeExperienceRelease(),
        }),
      ).toThrowError(/RELEASE_DEPLOYMENT_INVALID/);
    }
  });

  it('rejects incompatible Experience and tampered mapping/dependency/revision hashes', () => {
    expect(() =>
      prepareAgentDeploymentRevision({
        stable: makeAgentStable(),
        revision: makeAgentRevision(),
        agent_release: makeAgentRelease(),
        experience_release: {
          ...makeExperienceRelease(),
          compatible_agent_id: otherWorkspaceId,
        },
      }),
    ).toThrowError(/RELEASE_EXPERIENCE_INCOMPATIBLE/);

    const tamperedMapping = { ...makeServiceMapping(), mapping_hash: hashC };
    expect(() =>
      prepareAgentDeploymentRevision({
        stable: makeAgentStable(),
        revision: makeAgentRevision({}, [tamperedMapping]),
        agent_release: makeAgentRelease(),
        experience_release: makeExperienceRelease(),
      }),
    ).toThrowError(/RELEASE_HASH_MISMATCH/);

    for (const revision of [
      { ...makeAgentRevision(), dependency_manifest_hash: hashC },
      { ...makeAgentRevision(), revision_contract_hash: hashC },
    ]) {
      expect(() =>
        prepareAgentDeploymentRevision({
          stable: makeAgentStable(),
          revision,
          agent_release: makeAgentRelease(),
          experience_release: makeExperienceRelease(),
        }),
      ).toThrowError(/RELEASE_HASH_MISMATCH/);
    }
  });
});

describe('Flow Deployment revision assembly', () => {
  it('uses the Flow-specific parser and dependency path', () => {
    const flow = makeFlowIr();
    const prepared = prepareFlowDeploymentRevision({
      stable: makeFlowStable(),
      revision: makeFlowRevision(),
      flow_version: flow,
    });

    expect(prepared.deployment_kind).toBe('flow');
    expect(Object.isFrozen(prepared)).toBe(true);
  });
});
