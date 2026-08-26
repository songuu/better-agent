import {
  AgentDeploymentRevisionV1Schema,
  AgentReleaseV1Schema,
  AgentStrategyReleaseV1Schema,
  ExperienceReleaseV1Schema,
  FlowDeploymentRevisionV1Schema,
  FlowIrV1Schema,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';

import {
  assertSha256,
  assertUuid,
  deepFreezeJson,
  deriveDependencyManifest,
  normalizeDependencyPins,
  type PublishedResourceOwnerIdentityV1,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { isPreparedDeploymentRevision } from './deployment.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';

export type SupportedPublishedResourceKindV1 =
  | 'AGENT_STRATEGY_RELEASE'
  | 'AGENT_RELEASE'
  | 'FLOW_VERSION'
  | 'EXPERIENCE_RELEASE'
  | 'DEPLOYMENT_REVISION';

export interface PreparedPublishedResourceV1 {
  readonly schema_version: 'prepared-published-resource/1';
  readonly full_pin: PublishedResourcePinV1;
  readonly canonical_document: string;
  readonly dependency_manifest: ReturnType<typeof deriveDependencyManifest>;
}

type ParsedSupportedResource =
  | ReturnType<typeof AgentStrategyReleaseV1Schema.parse>
  | ReturnType<typeof AgentReleaseV1Schema.parse>
  | ReturnType<typeof FlowIrV1Schema.parse>
  | ReturnType<typeof ExperienceReleaseV1Schema.parse>
  | ReturnType<typeof AgentDeploymentRevisionV1Schema.parse>
  | ReturnType<typeof FlowDeploymentRevisionV1Schema.parse>;

const supportedKinds = new Set<SupportedPublishedResourceKindV1>([
  'AGENT_STRATEGY_RELEASE',
  'AGENT_RELEASE',
  'FLOW_VERSION',
  'EXPERIENCE_RELEASE',
  'DEPLOYMENT_REVISION',
]);

const pausedPublisherKinds = new Set<SupportedPublishedResourceKindV1>([
  'AGENT_RELEASE',
  'DEPLOYMENT_REVISION',
]);

function fail(
  code:
    | 'RELEASE_INPUT_INVALID'
    | 'RELEASE_DRAFT_FORBIDDEN'
    | 'RELEASE_KIND_UNSUPPORTED'
    | 'RELEASE_KIND_MISMATCH'
    | 'RELEASE_HASH_MISMATCH'
    | 'RELEASE_DEPENDENCY_UNREGISTERED'
    | 'RELEASE_DEPLOYMENT_INVALID',
  path: string,
  reason: string,
): never {
  throw new ReleaseCoreError(code, path, reason);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('RELEASE_INPUT_INVALID', '$', 'publish candidate must be an object');
  }
  return value as Record<string, unknown>;
}

function assertExactEnvelopeKeys(input: Record<string, unknown>): void {
  const expected = new Set([
    'schema_version',
    'source_kind',
    'workspace_id',
    'declared_kind',
    'document',
    'registered_dependency_pins',
  ]);
  for (const key of Object.keys(input)) {
    if (!expected.has(key)) {
      fail('RELEASE_INPUT_INVALID', `$.${key}`, 'unknown publisher envelope field');
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(input, key)) {
      fail('RELEASE_INPUT_INVALID', `$.${key}`, 'required publisher envelope field is missing');
    }
  }
}

function schemaVersionOf(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document))
    return undefined;
  const value = Reflect.get(document, 'schema_version');
  return typeof value === 'string' ? value : undefined;
}

function parseDeclaredResource(
  kind: SupportedPublishedResourceKindV1,
  document: unknown,
): ParsedSupportedResource {
  const expectedVersions: Record<SupportedPublishedResourceKindV1, readonly string[]> = {
    AGENT_STRATEGY_RELEASE: ['agent-strategy-release/1'],
    AGENT_RELEASE: ['agent-release/1'],
    FLOW_VERSION: ['flow-ir/1'],
    EXPERIENCE_RELEASE: ['experience-release/1'],
    DEPLOYMENT_REVISION: ['agent-deployment/1', 'flow-deployment/1'],
  };
  const schemaVersion = schemaVersionOf(document);
  if (schemaVersion === undefined || !expectedVersions[kind].includes(schemaVersion)) {
    fail(
      'RELEASE_KIND_MISMATCH',
      '$.document.schema_version',
      'declared kind and payload schema differ',
    );
  }

  const result =
    kind === 'AGENT_STRATEGY_RELEASE'
      ? AgentStrategyReleaseV1Schema.safeParse(document)
      : kind === 'AGENT_RELEASE'
        ? AgentReleaseV1Schema.safeParse(document)
        : kind === 'FLOW_VERSION'
          ? FlowIrV1Schema.safeParse(document)
          : kind === 'EXPERIENCE_RELEASE'
            ? ExperienceReleaseV1Schema.safeParse(document)
            : schemaVersion === 'agent-deployment/1'
              ? AgentDeploymentRevisionV1Schema.safeParse(document)
              : FlowDeploymentRevisionV1Schema.safeParse(document);
  if (!result.success) {
    fail('RELEASE_INPUT_INVALID', '$.document', 'payload fails its closed kind-specific schema');
  }
  return result.data as ParsedSupportedResource;
}

function identify(
  kind: SupportedPublishedResourceKindV1,
  workspaceId: string,
  document: ParsedSupportedResource,
): { owner: PublishedResourceOwnerIdentityV1; contractHash: `sha256:${string}` } {
  if (kind === 'AGENT_STRATEGY_RELEASE' && document.schema_version === 'agent-strategy-release/1') {
    const expected = canonicalSha256ExcludingRootKeys(document, ['contract_hash']);
    if (document.contract_hash !== expected) {
      fail('RELEASE_HASH_MISMATCH', '$.document.contract_hash', 'Strategy contract hash is stale');
    }
    return {
      owner: {
        workspace_id: workspaceId,
        published_resource_kind: kind,
        resource_id: document.strategy_id,
        resource_version_id: document.strategy_release_id,
      },
      contractHash: expected,
    };
  }
  if (kind === 'AGENT_RELEASE' && document.schema_version === 'agent-release/1') {
    return {
      owner: {
        workspace_id: workspaceId,
        published_resource_kind: kind,
        resource_id: document.agent_id,
        resource_version_id: document.agent_release_id,
      },
      contractHash: canonicalSha256(document),
    };
  }
  if (kind === 'FLOW_VERSION' && document.schema_version === 'flow-ir/1') {
    return {
      owner: {
        workspace_id: workspaceId,
        published_resource_kind: kind,
        resource_id: document.flow_id,
        resource_version_id: document.flow_version_id,
      },
      contractHash: canonicalSha256(document),
    };
  }
  if (kind === 'EXPERIENCE_RELEASE' && document.schema_version === 'experience-release/1') {
    const expected = canonicalSha256ExcludingRootKeys(document, ['content_hash']);
    if (document.content_hash !== expected) {
      fail('RELEASE_HASH_MISMATCH', '$.document.content_hash', 'Experience content hash is stale');
    }
    return {
      owner: {
        workspace_id: workspaceId,
        published_resource_kind: kind,
        resource_id: document.experience_id,
        resource_version_id: document.experience_release_id,
      },
      contractHash: expected,
    };
  }
  if (kind === 'DEPLOYMENT_REVISION' && document.schema_version === 'agent-deployment/1') {
    const expected = canonicalSha256ExcludingRootKeys(document, ['revision_contract_hash']);
    if (document.revision_contract_hash !== expected) {
      fail(
        'RELEASE_HASH_MISMATCH',
        '$.document.revision_contract_hash',
        'Agent Deployment revision hash is stale',
      );
    }
    return {
      owner: {
        workspace_id: workspaceId,
        published_resource_kind: kind,
        resource_id: document.agent_deployment_id,
        resource_version_id: document.agent_deployment_revision_id,
      },
      contractHash: expected,
    };
  }
  if (kind === 'DEPLOYMENT_REVISION' && document.schema_version === 'flow-deployment/1') {
    const expected = canonicalSha256ExcludingRootKeys(document, ['revision_contract_hash']);
    if (document.revision_contract_hash !== expected) {
      fail(
        'RELEASE_HASH_MISMATCH',
        '$.document.revision_contract_hash',
        'Flow Deployment revision hash is stale',
      );
    }
    return {
      owner: {
        workspace_id: workspaceId,
        published_resource_kind: kind,
        resource_id: document.flow_deployment_id,
        resource_version_id: document.flow_deployment_revision_id,
      },
      contractHash: expected,
    };
  }
  fail('RELEASE_KIND_MISMATCH', '$.document', 'payload did not match its declared parser');
}

function extractDependencies(
  workspaceId: string,
  document: ParsedSupportedResource,
): readonly unknown[] {
  if (document.schema_version === 'agent-release/1') {
    return [
      {
        workspace_id: workspaceId,
        published_resource_kind: 'AGENT_STRATEGY_RELEASE',
        resource_id: document.strategy.strategy_id,
        resource_version_id: document.strategy.strategy_release_id,
        contract_hash: document.strategy.contract_hash,
        binding_mode: 'pinned',
      },
      ...document.instruction_skill_bindings.map((binding) => binding.skill_pin),
      ...document.capability_bindings.map((binding) => binding.pin),
    ];
  }
  if (document.schema_version === 'flow-ir/1') return document.resources;
  if (document.schema_version === 'agent-deployment/1') {
    return [document.agent_release, document.experience_release];
  }
  if (document.schema_version === 'flow-deployment/1') return [document.flow_version];
  return [];
}

export function preparePublishedResource(input: unknown): PreparedPublishedResourceV1 {
  const envelope = readRecord(input);
  assertExactEnvelopeKeys(envelope);
  if (envelope.schema_version !== 'publishable-resource-candidate/1') {
    fail('RELEASE_INPUT_INVALID', '$.schema_version', 'publisher envelope version is unsupported');
  }
  if (envelope.source_kind === 'draft') {
    fail('RELEASE_DRAFT_FORBIDDEN', '$.source_kind', 'Drafts cannot enter the published registry');
  }
  if (envelope.source_kind !== 'sealed_candidate') {
    fail('RELEASE_INPUT_INVALID', '$.source_kind', 'publisher source must be a sealed candidate');
  }
  if (typeof envelope.workspace_id !== 'string') {
    fail('RELEASE_INPUT_INVALID', '$.workspace_id', 'Workspace identity must be a string UUID');
  }
  assertUuid(envelope.workspace_id, '$.workspace_id');
  if (
    typeof envelope.declared_kind !== 'string' ||
    !supportedKinds.has(envelope.declared_kind as SupportedPublishedResourceKindV1)
  ) {
    fail(
      'RELEASE_KIND_UNSUPPORTED',
      '$.declared_kind',
      'no kind-specific publisher is implemented',
    );
  }
  if (!Array.isArray(envelope.registered_dependency_pins)) {
    fail(
      'RELEASE_INPUT_INVALID',
      '$.registered_dependency_pins',
      'registered dependency pins must be an array',
    );
  }

  const kind = envelope.declared_kind as SupportedPublishedResourceKindV1;
  if (pausedPublisherKinds.has(kind)) {
    fail(
      'RELEASE_KIND_UNSUPPORTED',
      '$.declared_kind',
      kind === 'AGENT_RELEASE'
        ? 'Agent Release publication is paused until compiler and capability-closure preimages are authoritative'
        : 'Deployment revision publication is paused until change-set and conversation-contract preimages are authoritative',
    );
  }
  if (kind === 'DEPLOYMENT_REVISION' && !isPreparedDeploymentRevision(envelope.document)) {
    fail(
      'RELEASE_DEPLOYMENT_INVALID',
      '$.document',
      'Deployment revisions must pass stable, release, Experience and mapping assembly first',
    );
  }
  const document = parseDeclaredResource(kind, envelope.document);
  const { owner, contractHash } = identify(kind, envelope.workspace_id, document);
  assertUuid(owner.resource_id, '$.document.resource_id');
  assertUuid(owner.resource_version_id, '$.document.resource_version_id');
  assertSha256(contractHash, '$.document.contract_hash');

  const dependencies = normalizeDependencyPins(
    envelope.workspace_id,
    extractDependencies(envelope.workspace_id, document),
  );
  for (const [index, dependency] of dependencies.entries()) {
    if (
      !supportedKinds.has(dependency.published_resource_kind as SupportedPublishedResourceKindV1)
    ) {
      fail(
        'RELEASE_KIND_UNSUPPORTED',
        `$.dependencies[${index}].published_resource_kind`,
        'dependency kind has no physical published-resource registry writer',
      );
    }
  }
  const registered = normalizeDependencyPins(
    envelope.workspace_id,
    envelope.registered_dependency_pins,
  );
  const registeredKeys = new Set(registered.map(publishedResourcePinKey));
  for (const [index, dependency] of dependencies.entries()) {
    if (!registeredKeys.has(publishedResourcePinKey(dependency))) {
      fail(
        'RELEASE_DEPENDENCY_UNREGISTERED',
        `$.dependencies[${index}]`,
        'derived dependency is not present in the authoritative registry snapshot',
      );
    }
  }

  const dependencyManifest = deriveDependencyManifest(owner, dependencies);
  if (
    (document.schema_version === 'agent-deployment/1' ||
      document.schema_version === 'flow-deployment/1') &&
    document.dependency_manifest_hash !== dependencyManifest.manifest_hash
  ) {
    fail(
      'RELEASE_HASH_MISMATCH',
      '$.document.dependency_manifest_hash',
      'Deployment dependency manifest hash is stale',
    );
  }

  const fullPin: PublishedResourcePinV1 = {
    ...owner,
    contract_hash: contractHash,
    binding_mode: 'pinned',
  };
  return deepFreezeJson({
    schema_version: 'prepared-published-resource/1',
    full_pin: fullPin,
    canonical_document: canonicalJsonBytes(document).toString('utf8'),
    dependency_manifest: dependencyManifest,
  });
}
