import {
  AgentDeploymentRevisionV1Schema,
  AgentDeploymentV1Schema,
  AgentReleaseV1Schema,
  ExperienceReleaseV1Schema,
  FlowDeploymentRevisionV1Schema,
  FlowDeploymentV1Schema,
  FlowIrV1Schema,
} from '@better-agent/domain-contracts';

import {
  extractAgentCredentialRequirements,
  prepareCredentialMappings,
} from './credential-mapping.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  deriveDependencyManifest,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { assembleExperienceRelease } from './experience.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_DEPLOYMENT_INVALID', path, reason);
}

function assertEqual(actual: unknown, expected: unknown, path: string, reason: string): void {
  if (actual !== expected) fail(path, reason);
}

function verifyHash(actual: string, expected: string, path: string, reason: string): void {
  if (actual !== expected) throw new ReleaseCoreError('RELEASE_HASH_MISMATCH', path, reason);
}

const preparedDeploymentRevisions = new WeakSet<object>();

export function isPreparedDeploymentRevision(value: unknown): value is object {
  return typeof value === 'object' && value !== null && preparedDeploymentRevisions.has(value);
}

function markPreparedDeploymentRevision<const Revision extends object>(
  revision: Revision,
): Revision {
  preparedDeploymentRevisions.add(revision);
  return revision;
}

function normalizedAgentRevision(
  revision: ReturnType<typeof AgentDeploymentRevisionV1Schema.parse>,
) {
  return {
    ...revision,
    credential_mappings: [...revision.credential_mappings].sort((left, right) =>
      compareCanonicalStrings(left.requirement_id, right.requirement_id),
    ),
    ...(revision.ingress_channel === 'browser'
      ? {
          allowed_origins: [...revision.allowed_origins].sort(),
          browser_client_channels: [...revision.browser_client_channels].sort(),
        }
      : {}),
  };
}

export function prepareAgentDeploymentRevision(input: {
  readonly stable: unknown;
  readonly revision: unknown;
  readonly agent_release: unknown;
  readonly experience_release: unknown;
}) {
  const stableResult = AgentDeploymentV1Schema.safeParse(input.stable);
  if (!stableResult.success) fail('$.stable', 'stable Agent Deployment contract is invalid');
  const revisionResult = AgentDeploymentRevisionV1Schema.safeParse(input.revision);
  if (!revisionResult.success) fail('$.revision', 'Agent Deployment revision contract is invalid');
  const agentResult = AgentReleaseV1Schema.safeParse(input.agent_release);
  if (!agentResult.success) fail('$.agent_release', 'Agent Release contract is invalid');
  const experienceResult = ExperienceReleaseV1Schema.safeParse(input.experience_release);
  if (!experienceResult.success)
    fail('$.experience_release', 'Experience Release contract is invalid');

  const stable = stableResult.data;
  const revision = revisionResult.data;
  const agent = agentResult.data;
  const experience = experienceResult.data;
  assertEqual(
    revision.workspace_id,
    stable.workspace_id,
    '$.revision.workspace_id',
    'stable and revision Workspace differ',
  );
  assertEqual(
    revision.agent_deployment_id,
    stable.agent_deployment_id,
    '$.revision.agent_deployment_id',
    'stable and revision Deployment identity differ',
  );
  assertEqual(
    revision.agent_id,
    stable.agent_id,
    '$.revision.agent_id',
    'stable and revision Agent identity differ',
  );
  assertEqual(
    revision.environment,
    stable.environment,
    '$.revision.environment',
    'stable and revision environment differ',
  );
  assertEqual(
    revision.ingress_channel,
    stable.ingress_channel,
    '$.revision.ingress_channel',
    'stable and revision ingress channel differ',
  );
  assertEqual(
    agent.agent_id,
    stable.agent_id,
    '$.agent_release.agent_id',
    'Agent Release belongs to a different Agent',
  );

  assembleExperienceRelease({
    workspace_id: stable.workspace_id,
    agent_release: agent,
    experience_release: experience,
  });
  assertEqual(
    revision.agent_release.workspace_id,
    stable.workspace_id,
    '$.revision.agent_release.workspace_id',
    'Agent Release pin is cross-Workspace',
  );
  assertEqual(
    revision.agent_release.resource_id,
    agent.agent_id,
    '$.revision.agent_release.resource_id',
    'Agent Release pin has the wrong Agent',
  );
  assertEqual(
    revision.agent_release.resource_version_id,
    agent.agent_release_id,
    '$.revision.agent_release.resource_version_id',
    'Agent Release pin has the wrong version',
  );
  verifyHash(
    revision.agent_release.contract_hash,
    canonicalSha256(agent),
    '$.revision.agent_release.contract_hash',
    'Agent Release pin hash is stale',
  );
  assertEqual(
    revision.experience_release.workspace_id,
    stable.workspace_id,
    '$.revision.experience_release.workspace_id',
    'Experience pin is cross-Workspace',
  );
  assertEqual(
    revision.experience_release.resource_id,
    experience.experience_id,
    '$.revision.experience_release.resource_id',
    'Experience pin has the wrong identity',
  );
  assertEqual(
    revision.experience_release.resource_version_id,
    experience.experience_release_id,
    '$.revision.experience_release.resource_version_id',
    'Experience pin has the wrong version',
  );
  verifyHash(
    revision.experience_release.contract_hash,
    experience.content_hash,
    '$.revision.experience_release.contract_hash',
    'Experience pin hash is stale',
  );

  const preparedMappings = prepareCredentialMappings({
    deployment_kind: 'agent',
    workspace_id: stable.workspace_id,
    requirements: extractAgentCredentialRequirements(agent),
    mappings: revision.credential_mappings,
  });
  verifyHash(
    revision.credential_mapping_hash,
    preparedMappings.credential_mapping_hash,
    '$.revision.credential_mapping_hash',
    'credential mapping set hash is stale',
  );
  const dependencyManifest = deriveDependencyManifest(
    {
      workspace_id: stable.workspace_id,
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: revision.agent_deployment_id,
      resource_version_id: revision.agent_deployment_revision_id,
    },
    [revision.agent_release, revision.experience_release],
  );
  verifyHash(
    revision.dependency_manifest_hash,
    dependencyManifest.manifest_hash,
    '$.revision.dependency_manifest_hash',
    'Deployment dependency manifest hash is stale',
  );

  const normalized = normalizedAgentRevision({
    ...revision,
    credential_mappings: preparedMappings.mappings,
  } as ReturnType<typeof AgentDeploymentRevisionV1Schema.parse>);
  verifyHash(
    revision.revision_contract_hash,
    canonicalSha256ExcludingRootKeys(normalized, ['revision_contract_hash']),
    '$.revision.revision_contract_hash',
    'Agent Deployment revision hash is stale',
  );
  return deepFreezeJson(markPreparedDeploymentRevision(normalized));
}

export function prepareFlowDeploymentRevision(input: {
  readonly stable: unknown;
  readonly revision: unknown;
  readonly flow_version: unknown;
}) {
  const stableResult = FlowDeploymentV1Schema.safeParse(input.stable);
  if (!stableResult.success) fail('$.stable', 'stable Flow Deployment contract is invalid');
  const revisionResult = FlowDeploymentRevisionV1Schema.safeParse(input.revision);
  if (!revisionResult.success) fail('$.revision', 'Flow Deployment revision contract is invalid');
  const flowResult = FlowIrV1Schema.safeParse(input.flow_version);
  if (!flowResult.success) fail('$.flow_version', 'Flow Version contract is invalid');

  const stable = stableResult.data;
  const revision = revisionResult.data;
  const flow = flowResult.data;
  assertEqual(
    revision.workspace_id,
    stable.workspace_id,
    '$.revision.workspace_id',
    'stable and revision Workspace differ',
  );
  assertEqual(
    revision.flow_deployment_id,
    stable.flow_deployment_id,
    '$.revision.flow_deployment_id',
    'stable and revision Deployment identity differ',
  );
  assertEqual(
    revision.flow_id,
    stable.flow_id,
    '$.revision.flow_id',
    'stable and revision Flow identity differ',
  );
  assertEqual(
    revision.environment,
    stable.environment,
    '$.revision.environment',
    'stable and revision environment differ',
  );
  assertEqual(
    revision.ingress_channel,
    stable.ingress_channel,
    '$.revision.ingress_channel',
    'stable and revision ingress channel differ',
  );
  assertEqual(
    flow.flow_id,
    stable.flow_id,
    '$.flow_version.flow_id',
    'Flow Version belongs to a different Flow',
  );
  assertEqual(
    revision.flow_version.workspace_id,
    stable.workspace_id,
    '$.revision.flow_version.workspace_id',
    'Flow Version pin is cross-Workspace',
  );
  assertEqual(
    revision.flow_version.resource_id,
    flow.flow_id,
    '$.revision.flow_version.resource_id',
    'Flow Version pin has the wrong Flow',
  );
  assertEqual(
    revision.flow_version.resource_version_id,
    flow.flow_version_id,
    '$.revision.flow_version.resource_version_id',
    'Flow Version pin has the wrong version',
  );
  verifyHash(
    revision.flow_version.contract_hash,
    canonicalSha256(flow),
    '$.revision.flow_version.contract_hash',
    'Flow Version pin hash is stale',
  );

  const preparedMappings = prepareCredentialMappings({
    deployment_kind: 'flow',
    workspace_id: stable.workspace_id,
    requirements: flow.credential_requirements,
    mappings: revision.credential_mappings,
  });
  verifyHash(
    revision.credential_mapping_hash,
    preparedMappings.credential_mapping_hash,
    '$.revision.credential_mapping_hash',
    'credential mapping set hash is stale',
  );
  const dependencyManifest = deriveDependencyManifest(
    {
      workspace_id: stable.workspace_id,
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: revision.flow_deployment_id,
      resource_version_id: revision.flow_deployment_revision_id,
    },
    [revision.flow_version],
  );
  verifyHash(
    revision.dependency_manifest_hash,
    dependencyManifest.manifest_hash,
    '$.revision.dependency_manifest_hash',
    'Deployment dependency manifest hash is stale',
  );
  const normalized = {
    ...revision,
    credential_mappings: preparedMappings.mappings,
  };
  verifyHash(
    revision.revision_contract_hash,
    canonicalSha256ExcludingRootKeys(normalized, ['revision_contract_hash']),
    '$.revision.revision_contract_hash',
    'Flow Deployment revision hash is stale',
  );
  return deepFreezeJson(markPreparedDeploymentRevision(normalized));
}
