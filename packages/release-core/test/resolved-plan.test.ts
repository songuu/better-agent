import { describe, expect, it } from 'vitest';
import { AgentDeploymentCredentialMappingV1Schema } from '@better-agent/domain-contracts';

import {
  calculateCredentialMappingSetHash,
  calculateCredentialMappingHash,
  canonicalBindingPath,
  canonicalResourceNodeId,
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  deriveDependencyManifest,
  deriveExecutableCompiledHash,
  prepareExecutableSource,
  resolveExecutionPlan,
  verifyResolvedExecutionPlan,
} from '../src/index.js';
import {
  credentialId,
  agentDeploymentId,
  agentDeploymentRevisionId,
  agentId,
  emptyCapabilityRequirementExpression,
  emptyCapabilityRequirements,
  flowDeploymentId,
  flowDeploymentRevisionId,
  flowId,
  hashA,
  hashB,
  makeFlowIr,
  makeExperiencePin,
  makePolicyPin,
  makeCredentialRequirement,
  makeServiceMapping,
  principalId,
  workspaceId,
} from './fixtures.js';
import { richAgentSource } from './executable-source-fixtures.js';

const entryGrantId = '018f47f2-c541-7cc6-9292-4a2c35303e18';

function compareEpochSource(
  left: { source_kind: string; source_id: string; source_subkey: string },
  right: { source_kind: string; source_id: string; source_subkey: string },
): number {
  const leftKey = JSON.stringify([left.source_kind, left.source_id, left.source_subkey]);
  const rightKey = JSON.stringify([right.source_kind, right.source_id, right.source_subkey]);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function fixture() {
  const flow = makeFlowIr();
  const executableSource = {
    schema_version: 'executable-source-candidate/1',
    workspace_id: workspaceId,
    document: flow,
  };
  const flowPin = {
    ...prepareExecutableSource(executableSource).root.pin,
    published_resource_kind: 'FLOW_VERSION',
  } as const;
  const manifest = deriveDependencyManifest(
    {
      workspace_id: workspaceId,
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: flowDeploymentId,
      resource_version_id: flowDeploymentRevisionId,
    },
    [flowPin],
  );
  const revisionCandidate = {
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
    credential_mapping_hash: calculateCredentialMappingSetHash('flow', []),
    dependency_manifest_hash: manifest.manifest_hash,
    change_set_hash: hashA,
    revision_contract_hash: hashA,
  } as const;
  const revision = {
    ...revisionCandidate,
    revision_contract_hash: canonicalSha256ExcludingRootKeys(revisionCandidate, [
      'revision_contract_hash',
    ]),
  };
  const emptyPolicy = {
    credential_requirements: [],
    principal_modes: ['none'],
    egress: [],
    readable_data_classification_ceiling: 'public',
    output_data_classification: 'public',
    side_effect: { maximum_class: 'safe', approval: 'none' },
    operation_contract_hashes: [],
    max_calls: 0,
    max_depth: 0,
    max_parallelism: 0,
    budget: {
      schema_version: 'capability-budget/1',
      amount_credits: '0',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
    },
  } as const;
  const target = {
    workspace_id: workspaceId,
    published_resource_kind: 'KNOWLEDGE_INDEX_GENERATION',
    resource_id: 'knowledge-1',
    resource_version_id: 'generation-1',
    contract_hash: hashA,
    binding_mode: 'pinned',
  } as const;
  const bindingSegments = [
    { segment_kind: 'root', pin: flowPin },
    {
      segment_kind: 'binding',
      owner: { owner_kind: 'root', pin: flowPin },
      binding_kind: 'knowledge',
      local_binding_id: 'knowledge-1',
    },
  ] as const;
  const bindingPath = canonicalBindingPath(bindingSegments);
  const dependencyNodeId = canonicalResourceNodeId(target);
  const closureCandidate = {
    schema_version: 'compiled-capability-closure/1',
    root: { pin: flowPin, semantic_seed_hash: flowPin.contract_hash },
    assembly_pins: [],
    bindings: [
      {
        binding_path_encoding_version: 'binding-path-lp-utf8/1',
        binding_path: bindingPath,
        binding_path_segments: bindingSegments,
        binding_id: 'knowledge-1',
        binding_kind: 'knowledge',
        admission_requirement: 'optional',
        target,
        config_schema_version: 'knowledge-binding/1',
        config_hash: hashA,
        source_contract_hash: hashA,
        requirement_expression: emptyCapabilityRequirementExpression,
        effective_policy: emptyPolicy,
        operation_contracts: [],
        dependency_node_ids: [dependencyNodeId],
      },
    ],
    gate_specs: [],
    resource_nodes: [
      {
        node_id: canonicalResourceNodeId(flowPin),
        intrinsic_policy: emptyCapabilityRequirementExpression,
        dependency_manifest_hash: hashA,
        node_role: 'root',
        pin: flowPin,
      },
      {
        node_id: dependencyNodeId,
        intrinsic_policy: emptyCapabilityRequirementExpression,
        dependency_manifest_hash: hashA,
        node_role: 'dependency',
        pin: target,
      },
    ],
    dependency_edges: [
      {
        from_node_id: canonicalResourceNodeId(flowPin),
        to_node_id: dependencyNodeId,
        relation: 'binding_target',
        source_path: bindingPath,
      },
    ],
    disabled_binding_paths: [],
    aggregate_limits: emptyPolicy,
    closure_hash: hashA,
  } as const;
  const closure = {
    ...closureCandidate,
    closure_hash: canonicalSha256ExcludingRootKeys(closureCandidate, ['closure_hash']),
  };
  const snapshotCandidate = {
    schema_version: 'flow-deployment-entry-admission-snapshot/1',
    deployment_kind: 'flow',
    entry_source_kind: 'service_credential',
    workspace_id: workspaceId,
    flow_deployment_id: flowDeploymentId,
    flow_deployment_revision_id: flowDeploymentRevisionId,
    flow_deployment_revision_contract_hash: revision.revision_contract_hash,
    flow_version: flowPin,
    environment: 'staging',
    ingress_channel: 'service_api',
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
    authenticated_principal: {
      schema_version: 'caller-principal/1',
      kind: 'credential',
      credential_id: credentialId,
    },
    credential_id: credentialId,
    credential_authorization_epoch: 5,
    workspace_authorization_epoch: 9,
    entry_grant_id: entryGrantId,
    entry_grant_authorization_epoch: 4,
    entry_credential_kind: 'service_api',
    entry_principal_mode: 'credential_service_principal',
    entry_audience: 'flow_runtime_api',
    entry_channel: 'service_api',
    entry_scope: 'flow:run:create',
    entry_target_cardinality: 'exactly_one_flow_deployment',
    policy_profile_contract_hash: hashA,
    entry_scope_policy_contract_hash: hashA,
    credential_mapping_hash: revision.credential_mapping_hash,
    dependency_manifest_hash: revision.dependency_manifest_hash,
    snapshot_hash: hashA,
  } as const;
  const snapshot = {
    ...snapshotCandidate,
    snapshot_hash: canonicalSha256ExcludingRootKeys(snapshotCandidate, ['snapshot_hash']),
  };
  const decisionCandidate = {
    schema_version: 'admission-authorization-decision/1',
    decision_id: 'decision-1',
    expires_at: '2026-09-04T00:00:00+00:00',
    workspace_id: workspaceId,
    deployment_kind: 'flow',
    deployment_id: flowDeploymentId,
    deployment_revision_id: flowDeploymentRevisionId,
    deployment_revision_contract_hash: revision.revision_contract_hash,
    capability_closure_hash: closure.closure_hash,
    admission_snapshot_hash: snapshot.snapshot_hash,
    admission_activation_epoch: 3,
    epoch_sources: [
      { source_kind: 'credential', source_id: credentialId, source_subkey: '', observed_epoch: 5 },
      {
        source_kind: 'flow_deployment_security',
        source_id: flowDeploymentId,
        source_subkey: '',
        observed_epoch: 7,
      },
      {
        source_kind: 'flow_entry_grant',
        source_id: entryGrantId,
        source_subkey: '',
        observed_epoch: 4,
      },
      {
        source_kind: 'permission_policy',
        source_id: makePolicyPin('deployment_profile').policy_id,
        source_subkey: 'deployment_profile',
        observed_epoch: 1,
      },
      {
        source_kind: 'permission_policy',
        source_id: makePolicyPin('entry_grant').policy_id,
        source_subkey: 'entry_grant',
        observed_epoch: 1,
      },
      {
        source_kind: 'permission_policy',
        source_id: makePolicyPin('entry_scope').policy_id,
        source_subkey: 'entry_scope',
        observed_epoch: 1,
      },
      {
        source_kind: 'published_release_grant',
        source_id: 'flow-root-grant',
        source_subkey: flowPin.resource_version_id,
        observed_epoch: 1,
      },
      {
        source_kind: 'published_release_state',
        source_id: flowPin.resource_version_id,
        source_subkey: 'FLOW_VERSION',
        observed_epoch: 1,
      },
      {
        source_kind: 'workspace_authorization',
        source_id: workspaceId,
        source_subkey: '',
        observed_epoch: 9,
      },
    ],
    allowed_bindings: [],
    decision_hash: hashA,
  } as const;
  const decision = {
    ...decisionCandidate,
    decision_hash: canonicalSha256ExcludingRootKeys(decisionCandidate, ['decision_hash']),
  };
  return sealPublishedFixture({
    executableSource,
    closure,
    revision,
    snapshot,
    decision,
    bindingPath,
  });
}

function agentFixture() {
  const document = richAgentSource();
  document.capability_bindings = [];
  document.instruction_skill_bindings = [];
  document.public_capability_handles = [];
  document.gate_specs = [];
  document.strategy.allowed_capability_binding_ids = [];
  document.strategy.allowed_gate_spec_ids = [];
  const executableSource = {
    schema_version: 'executable-source-candidate/1',
    workspace_id: workspaceId,
    document,
  };
  const agentPin = {
    ...prepareExecutableSource(executableSource).root.pin,
    published_resource_kind: 'AGENT_RELEASE' as const,
  };
  const experiencePin = makeExperiencePin();
  const mappings = [makeServiceMapping()];
  const manifest = deriveDependencyManifest(
    {
      workspace_id: workspaceId,
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: agentDeploymentId,
      resource_version_id: agentDeploymentRevisionId,
    },
    [agentPin, experiencePin],
  );
  const revisionCandidate = {
    schema_version: 'agent-deployment/1',
    deployment_kind: 'agent',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentDeploymentRevisionId,
    agent_id: agentId,
    environment: 'development',
    ingress_channel: 'service_api',
    agent_release: agentPin,
    experience_release: experiencePin,
    policy_profile: makePolicyPin('deployment_profile'),
    entry_grant_policy: makePolicyPin('entry_grant'),
    entry_scope_policy: makePolicyPin('entry_scope'),
    credential_mappings: mappings,
    credential_mapping_hash: calculateCredentialMappingSetHash('agent', mappings),
    conversation_contract_hash: hashA,
    dependency_manifest_hash: manifest.manifest_hash,
    change_set_hash: hashA,
    revision_contract_hash: hashA,
  } as const;
  const revision = {
    ...revisionCandidate,
    revision_contract_hash: canonicalSha256ExcludingRootKeys(revisionCandidate, [
      'revision_contract_hash',
    ]),
  };
  const emptyPolicy = {
    credential_requirements: [],
    principal_modes: ['none'],
    egress: [],
    readable_data_classification_ceiling: 'public',
    output_data_classification: 'public',
    side_effect: { maximum_class: 'safe', approval: 'none' },
    operation_contract_hashes: [],
    max_calls: 0,
    max_depth: 0,
    max_parallelism: 0,
    budget: {
      schema_version: 'capability-budget/1',
      amount_credits: '0',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
    },
  } as const;
  const closureCandidate = {
    schema_version: 'compiled-capability-closure/1',
    root: { pin: agentPin, semantic_seed_hash: agentPin.contract_hash },
    assembly_pins: [],
    bindings: [],
    gate_specs: [],
    resource_nodes: [
      {
        node_id: canonicalResourceNodeId(agentPin),
        intrinsic_policy: emptyCapabilityRequirementExpression,
        dependency_manifest_hash: hashA,
        node_role: 'root',
        pin: agentPin,
      },
    ],
    dependency_edges: [],
    disabled_binding_paths: [],
    aggregate_limits: emptyPolicy,
    closure_hash: hashA,
  } as const;
  const closure = {
    ...closureCandidate,
    closure_hash: canonicalSha256ExcludingRootKeys(closureCandidate, ['closure_hash']),
  };
  const snapshotCandidate = {
    schema_version: 'agent-deployment-entry-admission-snapshot/1',
    deployment_kind: 'agent',
    entry_source_kind: 'service_credential',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentDeploymentRevisionId,
    agent_deployment_revision_contract_hash: revision.revision_contract_hash,
    agent_release: agentPin,
    experience_release: experiencePin,
    environment: 'development',
    ingress_channel: 'service_api',
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
    authenticated_principal: {
      schema_version: 'caller-principal/1',
      kind: 'credential',
      credential_id: credentialId,
    },
    credential_id: credentialId,
    credential_authorization_epoch: 5,
    workspace_authorization_epoch: 9,
    entry_grant_id: entryGrantId,
    entry_grant_authorization_epoch: 4,
    entry_credential_kind: 'service_api',
    entry_principal_mode: 'credential_service_principal',
    entry_audience: 'agent_runtime_api',
    entry_channel: 'service_api',
    entry_scope: 'agent:run:create',
    entry_target_cardinality: 'exactly_one_agent_deployment',
    policy_profile_contract_hash: hashA,
    entry_scope_policy_contract_hash: hashA,
    credential_mapping_hash: revision.credential_mapping_hash,
    dependency_manifest_hash: revision.dependency_manifest_hash,
    snapshot_hash: hashA,
  } as const;
  const snapshot = {
    ...snapshotCandidate,
    snapshot_hash: canonicalSha256ExcludingRootKeys(snapshotCandidate, ['snapshot_hash']),
  };
  const decisionCandidate = {
    schema_version: 'admission-authorization-decision/1',
    decision_id: 'agent-decision-1',
    workspace_id: workspaceId,
    deployment_kind: 'agent',
    deployment_id: agentDeploymentId,
    deployment_revision_id: agentDeploymentRevisionId,
    deployment_revision_contract_hash: revision.revision_contract_hash,
    capability_closure_hash: closure.closure_hash,
    admission_snapshot_hash: snapshot.snapshot_hash,
    admission_activation_epoch: 3,
    expires_at: '2026-09-04T00:00:00+00:00',
    epoch_sources: [
      {
        source_kind: 'agent_deployment_security',
        source_id: agentDeploymentId,
        source_subkey: '',
        observed_epoch: 7,
      },
      {
        source_kind: 'agent_entry_grant',
        source_id: entryGrantId,
        source_subkey: '',
        observed_epoch: 4,
      },
      { source_kind: 'credential', source_id: credentialId, source_subkey: '', observed_epoch: 5 },
      {
        source_kind: 'permission_policy',
        source_id: makePolicyPin('deployment_profile').policy_id,
        source_subkey: 'deployment_profile',
        observed_epoch: 1,
      },
      {
        source_kind: 'permission_policy',
        source_id: makePolicyPin('entry_grant').policy_id,
        source_subkey: 'entry_grant',
        observed_epoch: 1,
      },
      {
        source_kind: 'permission_policy',
        source_id: makePolicyPin('entry_scope').policy_id,
        source_subkey: 'entry_scope',
        observed_epoch: 1,
      },
      {
        source_kind: 'published_release_grant',
        source_id: 'agent-root-grant',
        source_subkey: agentPin.resource_version_id,
        observed_epoch: 1,
      },
      {
        source_kind: 'published_release_grant',
        source_id: 'experience-root-grant',
        source_subkey: experiencePin.resource_version_id,
        observed_epoch: 1,
      },
      {
        source_kind: 'published_release_state',
        source_id: agentPin.resource_version_id,
        source_subkey: 'AGENT_RELEASE',
        observed_epoch: 1,
      },
      {
        source_kind: 'published_release_state',
        source_id: experiencePin.resource_version_id,
        source_subkey: 'EXPERIENCE_RELEASE',
        observed_epoch: 1,
      },
      {
        source_kind: 'workspace_authorization',
        source_id: workspaceId,
        source_subkey: '',
        observed_epoch: 9,
      },
    ],
    allowed_bindings: [],
    decision_hash: hashA,
  } as const;
  const decision = {
    ...decisionCandidate,
    decision_hash: canonicalSha256ExcludingRootKeys(decisionCandidate, ['decision_hash']),
  };
  return sealPublishedFixture({ executableSource, revision, closure, snapshot, decision });
}

/** Publish test artifacts only before mutation; negative tests never repair their own evidence. */
function sealPublishedFixture<
  T extends {
    executableSource: unknown;
    closure: {
      closure_hash: string;
      assembly_pins: readonly unknown[];
      bindings: readonly { binding_path: string; target: unknown }[];
    };
    revision: object;
    snapshot: object;
    decision: object;
  },
>(value: T): T {
  const revision = structuredClone(value.revision) as Record<string, unknown>;
  const snapshot = structuredClone(value.snapshot) as Record<string, unknown>;
  const decision = structuredClone(value.decision) as Record<string, unknown>;
  const agent = revision.deployment_kind === 'agent';
  const pinKey = agent ? 'agent_release' : 'flow_version';
  const pin = {
    ...prepareExecutableSource(value.executableSource).root.pin,
    contract_hash: deriveExecutableCompiledHash(value.executableSource, value.closure.closure_hash),
  };
  revision[pinKey] = pin;
  revision.dependency_manifest_hash = deriveDependencyManifest(
    {
      workspace_id: String(revision.workspace_id),
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: String(revision[agent ? 'agent_deployment_id' : 'flow_deployment_id']),
      resource_version_id: String(
        revision[agent ? 'agent_deployment_revision_id' : 'flow_deployment_revision_id'],
      ),
    },
    [pin, ...(agent ? [revision.experience_release] : [])],
  ).manifest_hash;
  revision.revision_contract_hash = canonicalSha256ExcludingRootKeys(revision, [
    'revision_contract_hash',
  ]);
  snapshot[pinKey] = pin;
  snapshot[
    agent ? 'agent_deployment_revision_contract_hash' : 'flow_deployment_revision_contract_hash'
  ] = revision.revision_contract_hash;
  snapshot.dependency_manifest_hash = revision.dependency_manifest_hash;
  snapshot.snapshot_hash = canonicalSha256ExcludingRootKeys(snapshot, ['snapshot_hash']);
  decision.deployment_revision_contract_hash = revision.revision_contract_hash;
  decision.capability_closure_hash = value.closure.closure_hash;
  decision.admission_snapshot_hash = snapshot.snapshot_hash;
  const allowed = new Set(
    (decision.allowed_bindings as { binding_path: string }[]).map(
      (binding) => binding.binding_path,
    ),
  );
  const rootAssemblyPins = prepareExecutableSource(
    value.executableSource,
  ).dependency_manifest.dependencies.filter((dependency) =>
    ['AGENT_STRATEGY_RELEASE', 'INSTRUCTION_SKILL_RELEASE'].includes(
      dependency.published_resource_kind,
    ),
  );
  const targets = [
    ...[
      pin,
      ...value.closure.assembly_pins,
      ...rootAssemblyPins,
      ...(agent ? [revision.experience_release] : []),
    ].map((target) => ({ kind: 'published_release_grant', target })),
    ...value.closure.bindings
      .filter((binding) => allowed.has(binding.binding_path))
      .map((binding) => ({ kind: 'capability_release_grant', target: binding.target })),
  ];
  const grants = new Map(
    targets.map(({ kind, target }) => {
      const identity = canonicalSha256({
        schema_version: 'release-grant-identity/1',
        workspace_id: revision.workspace_id,
        authenticated_principal: snapshot.authenticated_principal,
        target,
      });
      return [
        JSON.stringify([kind, identity]),
        {
          source_kind: kind,
          source_id: `grant:${identity}`,
          source_subkey: identity,
          observed_epoch: 1,
        },
      ];
    }),
  );
  const epochCandidates = [
    ...(
      decision.epoch_sources as {
        source_kind: string;
        source_id: string;
        source_subkey: string;
        observed_epoch: number;
      }[]
    ).filter(
      (source) =>
        source.source_kind !== 'published_release_grant' &&
        source.source_kind !== 'capability_release_grant',
    ),
    ...grants.values(),
    ...rootAssemblyPins.map((dependency) => ({
      source_kind: 'published_release_state',
      source_id: dependency.resource_version_id,
      source_subkey: dependency.published_resource_kind,
      observed_epoch: 1,
    })),
  ];
  decision.epoch_sources = [
    ...new Map(
      epochCandidates.map((source) => [
        JSON.stringify([source.source_kind, source.source_id, source.source_subkey]),
        source,
      ]),
    ).values(),
  ].sort(compareEpochSource);
  decision.decision_hash = canonicalSha256ExcludingRootKeys(decision, ['decision_hash']);
  return { ...value, revision, snapshot, decision } as T;
}

describe('typed ResolvedPlan admission', () => {
  const expected_admission_epochs = {
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
  } as const;
  const admission_clock = {
    source: 'database_transaction_clock',
    observed_at: '2026-09-03T00:00:00.000Z',
  } as const;
  const common = <
    T extends {
      decision: { epoch_sources: unknown; deployment_kind?: string };
      executableSource?: unknown;
    },
  >(
    value: T,
  ) => ({
    executable_source:
      value.executableSource ??
      (value.decision.deployment_kind === 'agent' ? agentFixture() : fixture()).executableSource,
    expected_admission_epochs,
    admission_clock,
    expected_authorization_epoch_sources: value.decision.epoch_sources,
  });

  it('binds a Flow profile, verified closure and epoch decision into an immutable plan', () => {
    const value = fixture();
    const plan = resolveExecutionPlan({
      closure: value.closure,
      deployment_revision: value.revision,
      admission_snapshot: value.snapshot,
      authorization_decision: value.decision,
      entry_purpose: 'flow_run',
      ...common(value),
    });
    expect(plan.plan_kind).toBe('flow');
    expect(plan.capability_closure_hash).toBe(value.closure.closure_hash);
    expect(plan.observed_revoke_epoch).toBe(7);
    expect(Object.isFrozen(plan.enabled_bindings)).toBe(true);
  });

  it('resolves capability-bearing Flow root credentials into explicit root authority', () => {
    const base = fixture();
    const requirement = makeCredentialRequirement();
    const mapping = makeServiceMapping('flow');
    const revisionCandidate = {
      ...base.revision,
      credential_mappings: [mapping],
      credential_mapping_hash: calculateCredentialMappingSetHash('flow', [mapping]),
      revision_contract_hash: hashA,
    };
    const revision = {
      ...revisionCandidate,
      revision_contract_hash: canonicalSha256ExcludingRootKeys(revisionCandidate, [
        'revision_contract_hash',
      ]),
    };
    const snapshotCandidate = {
      ...base.snapshot,
      flow_deployment_revision_contract_hash: revision.revision_contract_hash,
      credential_mapping_hash: revision.credential_mapping_hash,
      snapshot_hash: hashA,
    };
    const snapshot = {
      ...snapshotCandidate,
      snapshot_hash: canonicalSha256ExcludingRootKeys(snapshotCandidate, ['snapshot_hash']),
    };
    const requirements = {
      ...emptyCapabilityRequirements,
      credential_requirements: [requirement],
      principal_modes: ['service_principal'],
      minimum_limits: {
        ...emptyCapabilityRequirements.minimum_limits,
        calls: 1,
        parallelism: 1,
        budget: {
          schema_version: 'capability-budget/1' as const,
          amount_credits: '1000',
          input_tokens: 4096,
          output_tokens: 512,
          total_tokens: 4608,
          duration_ms: 45_000,
        },
      },
    } as const;
    const expression = {
      schema_version: 'capability-requirement-expression/1',
      expression_kind: 'leaf',
      requirements,
    } as const;
    const effectivePolicy = {
      ...base.closure.aggregate_limits,
      credential_requirements: [requirement],
      principal_modes: ['service_principal'],
      max_calls: 1,
      max_parallelism: 1,
      budget: requirements.minimum_limits.budget,
    } as const;
    const closureCandidate = {
      ...base.closure,
      resource_nodes: base.closure.resource_nodes.map((node) =>
        node.node_role === 'root' ? { ...node, intrinsic_policy: expression } : node,
      ),
      aggregate_limits: effectivePolicy,
      closure_hash: hashA,
    };
    const closure = {
      ...closureCandidate,
      closure_hash: canonicalSha256ExcludingRootKeys(closureCandidate, ['closure_hash']),
    };
    const { credential_requirements: _requirements, ...limits } = effectivePolicy;
    const policyCeiling = {
      schema_version: 'capability-policy-ceiling/1',
      credential_allowances: [
        {
          provider_id: requirement.provider_id,
          audience: requirement.audience,
          allowed_scopes: requirement.required_scopes,
          principal_modes: requirement.allowed_principal_modes,
        },
      ],
      ...limits,
    } as const;
    const credentialMaterial = {
      credential_id: 'root-model-credential-1',
      credential_version_id: 'material-version-1',
      provider_id: requirement.provider_id,
      audience: requirement.audience,
      granted_scopes: [...requirement.required_scopes],
      principal_mode: 'service_principal' as const,
      credential_subject_id: principalId,
      credential_handle_hash: hashA,
      material_fingerprint_hash: hashB,
    };
    const credentialEpoch = {
      source_kind: 'credential' as const,
      source_id: credentialMaterial.credential_id,
      source_subkey: canonicalSha256({
        schema_version: 'credential-material-identity/1',
        ...credentialMaterial,
      }),
      observed_epoch: 3,
    };
    const epochSources = [
      ...base.decision.epoch_sources,
      {
        source_kind: 'credential_policy' as const,
        source_id: makePolicyPin('service_principal').policy_id,
        source_subkey: requirement.requirement_id,
        observed_epoch: 1,
      },
      {
        source_kind: 'service_principal' as const,
        source_id: principalId,
        source_subkey: requirement.requirement_id,
        observed_epoch: 2,
      },
      credentialEpoch,
    ].sort(compareEpochSource);
    const decisionCandidate = {
      ...base.decision,
      deployment_revision_contract_hash: revision.revision_contract_hash,
      capability_closure_hash: closure.closure_hash,
      admission_snapshot_hash: snapshot.snapshot_hash,
      epoch_sources: epochSources,
      root_authority: {
        policy_ceiling: policyCeiling,
        credential_bindings: [
          {
            requirement_id: requirement.requirement_id,
            mapping_hash: mapping.mapping_hash,
            ...credentialMaterial,
            epoch_source: credentialEpoch,
          },
        ],
      },
      decision_hash: hashA,
    };
    const decision = {
      ...decisionCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(decisionCandidate, ['decision_hash']),
    };
    const published = sealPublishedFixture({ ...base, closure, revision, snapshot, decision });
    const plan = resolveExecutionPlan({
      closure: published.closure,
      deployment_revision: published.revision,
      admission_snapshot: published.snapshot,
      authorization_decision: published.decision,
      entry_purpose: 'flow_run',
      ...common(published),
    });
    expect(plan.root_authority?.credential_bindings[0]).toMatchObject({
      requirement_id: requirement.requirement_id,
      credential_subject_id: principalId,
      material_fingerprint_hash: hashB,
    });
    expect(plan.root_authority?.effective_policy_hash).toBe(
      canonicalSha256(plan.root_authority?.effective_policy),
    );
  });

  it('uses the separate Agent deployment profile without Flow field borrowing', () => {
    const value = agentFixture();
    const plan = resolveExecutionPlan({
      closure: value.closure,
      deployment_revision: value.revision,
      admission_snapshot: value.snapshot,
      authorization_decision: value.decision,
      entry_purpose: 'agent_run',
      ...common(value),
    });
    expect(plan.plan_kind).toBe('agent');
    if (plan.plan_kind === 'agent')
      expect(plan.agent_release_id).toBe(value.revision.agent_release.resource_version_id);
    expect(plan).not.toHaveProperty('flow_deployment_id');
  });

  it('binds Agent browser origin, channel, audience and both session epochs', () => {
    const base = agentFixture();
    const revisionCandidate = {
      ...base.revision,
      ingress_channel: 'browser',
      allowed_origins: ['https://app.example.com'],
      browser_client_channels: ['WEB_SDK'],
      session_token_audience: 'agent_browser_api',
      revision_contract_hash: hashA,
    } as const;
    const revision = {
      ...revisionCandidate,
      revision_contract_hash: canonicalSha256ExcludingRootKeys(revisionCandidate, [
        'revision_contract_hash',
      ]),
    };
    const browserSessionId = '018f47f2-c541-7cc6-9292-4a2c35303e19';
    const endUserId = '018f47f2-c541-7cc6-9292-4a2c35303e20';
    const snapshotCandidate = {
      schema_version: 'agent-deployment-entry-admission-snapshot/1',
      deployment_kind: 'agent',
      entry_source_kind: 'browser_session',
      workspace_id: workspaceId,
      agent_deployment_id: agentDeploymentId,
      agent_deployment_revision_id: agentDeploymentRevisionId,
      agent_deployment_revision_contract_hash: revision.revision_contract_hash,
      agent_release: revision.agent_release,
      experience_release: revision.experience_release,
      environment: 'development',
      ingress_channel: 'browser',
      admission_activation_epoch: 3,
      observed_revoke_epoch: 7,
      workspace_authorization_epoch: 9,
      authenticated_principal: {
        schema_version: 'caller-principal/1',
        kind: 'end_user',
        end_user_principal_id: endUserId,
      },
      browser_session_id: browserSessionId,
      client_channel: 'WEB_SDK',
      canonical_origin: 'https://app.example.com',
      token_audience: 'agent_browser_api',
      session_epoch: 6,
      observed_principal_session_epoch: 8,
      policy_profile_contract_hash: hashA,
      entry_scope_policy_contract_hash: hashA,
      credential_mapping_hash: revision.credential_mapping_hash,
      dependency_manifest_hash: revision.dependency_manifest_hash,
      snapshot_hash: hashA,
    } as const;
    const snapshot = {
      ...snapshotCandidate,
      snapshot_hash: canonicalSha256ExcludingRootKeys(snapshotCandidate, ['snapshot_hash']),
    };
    const epochSources = [
      ...base.decision.epoch_sources.filter(
        (source) =>
          source.source_kind !== 'credential' && source.source_kind !== 'agent_entry_grant',
      ),
      {
        source_kind: 'browser_session' as const,
        source_id: browserSessionId,
        source_subkey: '',
        observed_epoch: 6,
      },
      {
        source_kind: 'principal_session' as const,
        source_id: endUserId,
        source_subkey: '',
        observed_epoch: 8,
      },
    ].sort(compareEpochSource);
    const decisionCandidate = {
      ...base.decision,
      deployment_revision_contract_hash: revision.revision_contract_hash,
      admission_snapshot_hash: snapshot.snapshot_hash,
      epoch_sources: epochSources,
      decision_hash: hashA,
    };
    const decision = {
      ...decisionCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(decisionCandidate, ['decision_hash']),
    };
    const published = sealPublishedFixture({ ...base, revision, snapshot, decision });
    const plan = resolveExecutionPlan({
      closure: published.closure,
      deployment_revision: published.revision,
      admission_snapshot: published.snapshot,
      authorization_decision: published.decision,
      entry_purpose: 'agent_conversation',
      ...common(published),
    });
    expect(plan.plan_kind).toBe('agent');
    const mismatchedSnapshotCandidate = {
      ...snapshot,
      canonical_origin: 'https://evil.example.com',
      snapshot_hash: hashA,
    };
    const mismatchedSnapshot = {
      ...mismatchedSnapshotCandidate,
      snapshot_hash: canonicalSha256ExcludingRootKeys(mismatchedSnapshotCandidate, [
        'snapshot_hash',
      ]),
    };
    const mismatchedDecisionCandidate = {
      ...decision,
      admission_snapshot_hash: mismatchedSnapshot.snapshot_hash,
      decision_hash: hashA,
    };
    const mismatchedDecision = {
      ...mismatchedDecisionCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(mismatchedDecisionCandidate, [
        'decision_hash',
      ]),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: base.closure,
        deployment_revision: revision,
        admission_snapshot: mismatchedSnapshot,
        authorization_decision: mismatchedDecision,
        entry_purpose: 'agent_conversation',
        executable_source: base.executableSource,
        expected_admission_epochs,
        admission_clock,
        expected_authorization_epoch_sources: epochSources,
      }),
    ).toThrowError(/outside the revision profile/);
    for (const mutation of [{ client_channel: 'API' }, { token_audience: 'wrong-audience' }]) {
      const changedSnapshot = { ...published.snapshot, ...mutation, snapshot_hash: hashA };
      changedSnapshot.snapshot_hash = canonicalSha256ExcludingRootKeys(changedSnapshot, [
        'snapshot_hash',
      ]);
      const changedDecision = {
        ...published.decision,
        admission_snapshot_hash: changedSnapshot.snapshot_hash,
        decision_hash: hashA,
      };
      changedDecision.decision_hash = canonicalSha256ExcludingRootKeys(changedDecision, [
        'decision_hash',
      ]);
      expect(() =>
        resolveExecutionPlan({
          closure: published.closure,
          deployment_revision: published.revision,
          admission_snapshot: changedSnapshot,
          authorization_decision: changedDecision,
          entry_purpose: 'agent_conversation',
          ...common(published),
        }),
      ).toThrow();
    }
    for (const kind of ['browser_session', 'principal_session']) {
      const sources = published.decision.epoch_sources.filter(
        (source) => source.source_kind !== kind,
      );
      const changed = { ...published.decision, epoch_sources: sources, decision_hash: hashA };
      changed.decision_hash = canonicalSha256ExcludingRootKeys(changed, ['decision_hash']);
      expect(() =>
        resolveExecutionPlan({
          closure: published.closure,
          deployment_revision: published.revision,
          admission_snapshot: published.snapshot,
          authorization_decision: changed,
          entry_purpose: 'agent_conversation',
          ...common(published),
          expected_authorization_epoch_sources: sources,
        }),
      ).toThrow(/omits or changes an admission epoch source/);
    }
  });

  it('keeps an embedded Flow inside its parent Agent plan and rejects a top-level Flow profile', () => {
    const agent = agentFixture();
    const flow = fixture();
    const target = flow.revision.flow_version;
    const segments = [
      { segment_kind: 'root' as const, pin: agent.closure.root.pin },
      {
        segment_kind: 'binding' as const,
        owner: { owner_kind: 'root' as const, pin: agent.closure.root.pin },
        binding_kind: 'flow' as const,
        local_binding_id: 'embedded-flow',
      },
    ];
    const path = canonicalBindingPath(segments);
    const dependencyNodeId = canonicalResourceNodeId(target);
    const requirement = makeCredentialRequirement();
    const mapping = AgentDeploymentCredentialMappingV1Schema.parse(
      agent.revision.credential_mappings[0],
    );
    const effectivePolicy = {
      ...agent.closure.aggregate_limits,
      credential_requirements: [requirement],
      principal_modes: ['service_principal'] as const,
    };
    const expression = {
      ...emptyCapabilityRequirementExpression,
      requirements: {
        ...emptyCapabilityRequirements,
        credential_requirements: [requirement],
        principal_modes: ['service_principal'] as const,
      },
    };
    const material = {
      credential_id: 'parent-owned-flow-credential',
      credential_version_id: 'v1',
      provider_id: requirement.provider_id,
      audience: requirement.audience,
      granted_scopes: requirement.required_scopes,
      principal_mode: 'service_principal' as const,
      credential_subject_id: principalId,
      credential_handle_hash: hashA,
      material_fingerprint_hash: hashB,
    };
    const credentialEpoch = {
      source_kind: 'credential' as const,
      source_id: material.credential_id,
      source_subkey: canonicalSha256({
        schema_version: 'credential-material-identity/1',
        ...material,
      }),
      observed_epoch: 1,
    };
    const closureCandidate = {
      ...agent.closure,
      aggregate_limits: effectivePolicy,
      bindings: [
        {
          binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
          binding_path: path,
          binding_path_segments: segments,
          binding_id: 'embedded-flow',
          binding_kind: 'flow' as const,
          admission_requirement: 'optional' as const,
          target,
          config_schema_version: 'flow-binding/1' as const,
          config_hash: hashA,
          source_contract_hash: target.contract_hash,
          requirement_expression: expression,
          effective_policy: effectivePolicy,
          operation_contracts: [],
          dependency_node_ids: [dependencyNodeId],
        },
      ],
      resource_nodes: [
        ...agent.closure.resource_nodes,
        {
          node_id: dependencyNodeId,
          intrinsic_policy: emptyCapabilityRequirementExpression,
          dependency_manifest_hash: hashA,
          nested_closure_hash: flow.closure.closure_hash,
          node_role: 'dependency' as const,
          pin: target,
        },
      ].sort((left, right) =>
        left.node_id < right.node_id ? -1 : left.node_id > right.node_id ? 1 : 0,
      ),
      dependency_edges: [
        {
          from_node_id: agent.closure.resource_nodes[0]?.node_id ?? 'missing-root-node',
          to_node_id: dependencyNodeId,
          relation: 'binding_target' as const,
          source_path: path,
        },
      ],
      closure_hash: hashA,
    };
    const closure = {
      ...closureCandidate,
      closure_hash: canonicalSha256ExcludingRootKeys(closureCandidate, ['closure_hash']),
    };
    const { credential_requirements: _requirements, ...limits } = closure.aggregate_limits;
    const epochSources = [
      ...agent.decision.epoch_sources,
      credentialEpoch,
      {
        source_kind: 'credential_policy' as const,
        source_id: mapping.credential_policy.policy_id,
        source_subkey: requirement.requirement_id,
        observed_epoch: 1,
      },
      {
        source_kind: 'service_principal' as const,
        source_id: principalId,
        source_subkey: requirement.requirement_id,
        observed_epoch: 1,
      },
      {
        source_kind: 'capability_release_grant' as const,
        source_id: 'embedded-flow-grant',
        source_subkey: target.resource_version_id,
        observed_epoch: 1,
      },
      {
        source_kind: 'capability_release_state' as const,
        source_id: target.resource_version_id,
        source_subkey: 'FLOW_VERSION',
        observed_epoch: 1,
      },
    ].sort(compareEpochSource);
    const decisionCandidate = {
      ...agent.decision,
      capability_closure_hash: closure.closure_hash,
      epoch_sources: epochSources,
      allowed_bindings: [
        {
          binding_path: path,
          policy_ceiling: {
            schema_version: 'capability-policy-ceiling/1',
            credential_allowances: [
              {
                provider_id: requirement.provider_id,
                audience: requirement.audience,
                allowed_scopes: requirement.required_scopes,
                principal_modes: requirement.allowed_principal_modes,
              },
            ],
            ...limits,
          },
          credential_bindings: [
            {
              ...material,
              requirement_id: requirement.requirement_id,
              mapping_hash: mapping.mapping_hash,
              epoch_source: credentialEpoch,
            },
          ],
        },
      ],
      decision_hash: hashA,
    };
    const decision = {
      ...decisionCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(decisionCandidate, ['decision_hash']),
    };
    const published = sealPublishedFixture({ ...agent, closure, decision });
    const plan = resolveExecutionPlan({
      closure: published.closure,
      deployment_revision: published.revision,
      admission_snapshot: published.snapshot,
      authorization_decision: published.decision,
      entry_purpose: 'agent_run',
      ...common(published),
    });
    expect(plan.plan_kind).toBe('agent');
    expect(plan.enabled_bindings[0]?.target.published_resource_kind).toBe('FLOW_VERSION');
    expect(plan.enabled_bindings[0]?.credential_bindings[0]?.mapping_hash).toBe(
      mapping.mapping_hash,
    );
    const missingMappingRevision = {
      ...published.revision,
      credential_mappings: [],
      credential_mapping_hash: calculateCredentialMappingSetHash('agent', []),
    };
    missingMappingRevision.revision_contract_hash = canonicalSha256ExcludingRootKeys(
      missingMappingRevision,
      ['revision_contract_hash'],
    );
    const missingMappingSnapshot = {
      ...published.snapshot,
      agent_deployment_revision_contract_hash: missingMappingRevision.revision_contract_hash,
      credential_mapping_hash: missingMappingRevision.credential_mapping_hash,
    };
    missingMappingSnapshot.snapshot_hash = canonicalSha256ExcludingRootKeys(
      missingMappingSnapshot,
      ['snapshot_hash'],
    );
    const missingMappingDecision = {
      ...published.decision,
      deployment_revision_contract_hash: missingMappingRevision.revision_contract_hash,
      admission_snapshot_hash: missingMappingSnapshot.snapshot_hash,
    };
    missingMappingDecision.decision_hash = canonicalSha256ExcludingRootKeys(
      missingMappingDecision,
      ['decision_hash'],
    );
    const missingParent = {
      ...common(published),
      closure,
      deployment_revision: missingMappingRevision,
      admission_snapshot: missingMappingSnapshot,
      authorization_decision: missingMappingDecision,
      entry_purpose: 'agent_run' as const,
    };
    expect(() => resolveExecutionPlan(missingParent)).toThrow(/exact mapping/);
    expect(() =>
      resolveExecutionPlan({
        ...missingParent,
        workspace_default_credential_mappings: [mapping],
      } as typeof missingParent),
    ).toThrow(/closed bounded v1 contract/);
    expect(() =>
      resolveExecutionPlan({
        closure,
        deployment_revision: flow.revision,
        admission_snapshot: flow.snapshot,
        authorization_decision: flow.decision,
        entry_purpose: 'flow_run',
        ...common(flow),
      }),
    ).toThrowError(/closure root does not equal/);
  });

  it('seals the exact credential mapping, subject, handle, fingerprint and epoch into an enabled binding', () => {
    const base = fixture();
    const requirement = makeCredentialRequirement();
    const preparedMapping = makeServiceMapping('flow');
    const mapping = {
      schema_version: 'flow-deployment-credential-mapping/1',
      requirement_id: requirement.requirement_id,
      provider_id: requirement.provider_id,
      audience: requirement.audience,
      allowed_scopes: requirement.required_scopes,
      credential_policy: makePolicyPin('service_principal'),
      principal_mode: 'service_principal',
      credential_source_kind: 'service_principal_policy',
      service_principal_id: principalId,
      mapping_hash: preparedMapping.mapping_hash,
    } as const;
    const revisionCandidate = {
      ...base.revision,
      credential_mappings: [mapping],
      credential_mapping_hash: calculateCredentialMappingSetHash('flow', [mapping]),
      revision_contract_hash: hashA,
    };
    const revision = {
      ...revisionCandidate,
      revision_contract_hash: canonicalSha256ExcludingRootKeys(revisionCandidate, [
        'revision_contract_hash',
      ]),
    };
    const snapshotCandidate = {
      ...base.snapshot,
      flow_deployment_revision_contract_hash: revision.revision_contract_hash,
      credential_mapping_hash: revision.credential_mapping_hash,
      snapshot_hash: hashA,
    };
    const snapshot = {
      ...snapshotCandidate,
      snapshot_hash: canonicalSha256ExcludingRootKeys(snapshotCandidate, ['snapshot_hash']),
    };
    const requirements = {
      ...emptyCapabilityRequirements,
      credential_requirements: [requirement],
      principal_modes: ['service_principal'],
    } as const;
    const expression = {
      schema_version: 'capability-requirement-expression/1',
      expression_kind: 'leaf',
      requirements,
    } as const;
    const effectivePolicy = {
      ...base.closure.aggregate_limits,
      credential_requirements: [requirement],
      principal_modes: ['service_principal'],
    } as const;
    const closureCandidate = {
      ...base.closure,
      bindings: base.closure.bindings.map((binding) => ({
        ...binding,
        requirement_expression: expression,
        effective_policy: effectivePolicy,
      })),
      resource_nodes: base.closure.resource_nodes.map((node) =>
        node.node_role === 'dependency' ? { ...node, intrinsic_policy: expression } : node,
      ),
      aggregate_limits: effectivePolicy,
      closure_hash: hashA,
    };
    const closure = {
      ...closureCandidate,
      closure_hash: canonicalSha256ExcludingRootKeys(closureCandidate, ['closure_hash']),
    };
    const { credential_requirements: _requirements, ...limits } = effectivePolicy;
    const policyCeiling = {
      schema_version: 'capability-policy-ceiling/1',
      credential_allowances: [
        {
          provider_id: requirement.provider_id,
          audience: requirement.audience,
          allowed_scopes: requirement.required_scopes,
          principal_modes: requirement.allowed_principal_modes,
        },
      ],
      ...limits,
    } as const;
    const credentialMaterial = {
      credential_id: 'outgoing-credential-1',
      credential_version_id: 'material-version-1',
      provider_id: requirement.provider_id,
      audience: requirement.audience,
      granted_scopes: [...requirement.required_scopes].sort(),
      principal_mode: 'service_principal' as const,
      credential_subject_id: principalId,
      credential_handle_hash: hashA,
      material_fingerprint_hash: hashB,
    };
    const credentialEpoch = {
      source_kind: 'credential' as const,
      source_id: credentialMaterial.credential_id,
      source_subkey: canonicalSha256({
        schema_version: 'credential-material-identity/1',
        ...credentialMaterial,
      }),
      observed_epoch: 3,
    };
    const principalEpoch = {
      source_kind: 'service_principal' as const,
      source_id: principalId,
      source_subkey: requirement.requirement_id,
      observed_epoch: 2,
    };
    const epochSources = [
      ...base.decision.epoch_sources,
      {
        source_kind: 'capability_release_grant' as const,
        source_id: 'knowledge-grant',
        source_subkey: 'generation-1',
        observed_epoch: 1,
      },
      {
        source_kind: 'capability_release_state' as const,
        source_id: 'generation-1',
        source_subkey: 'KNOWLEDGE_INDEX_GENERATION',
        observed_epoch: 1,
      },
      {
        source_kind: 'credential_policy' as const,
        source_id: mapping.credential_policy.policy_id,
        source_subkey: requirement.requirement_id,
        observed_epoch: 1,
      },
      credentialEpoch,
      principalEpoch,
    ].sort(compareEpochSource);
    const credentialBinding = {
      requirement_id: requirement.requirement_id,
      mapping_hash: mapping.mapping_hash,
      ...credentialMaterial,
      epoch_source: credentialEpoch,
    };
    const decisionCandidate = {
      ...base.decision,
      deployment_revision_contract_hash: revision.revision_contract_hash,
      capability_closure_hash: closure.closure_hash,
      admission_snapshot_hash: snapshot.snapshot_hash,
      epoch_sources: epochSources,
      allowed_bindings: [
        {
          binding_path: base.bindingPath,
          policy_ceiling: policyCeiling,
          credential_bindings: [credentialBinding],
        },
      ],
      decision_hash: hashA,
    };
    const decision = {
      ...decisionCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(decisionCandidate, ['decision_hash']),
    };
    const published = sealPublishedFixture({ ...base, closure, revision, snapshot, decision });
    const plan = resolveExecutionPlan({
      closure: published.closure,
      deployment_revision: published.revision,
      admission_snapshot: published.snapshot,
      authorization_decision: published.decision,
      entry_purpose: 'flow_run',
      ...common(published),
    });
    expect(plan.enabled_bindings[0]?.credential_bindings[0]).toMatchObject({
      credential_subject_id: principalId,
      material_fingerprint_hash: hashB,
    });
    expect(plan.enabled_bindings[0]?.effective_policy_hash).toBe(
      canonicalSha256(plan.enabled_bindings[0]?.effective_policy),
    );
    const secondRequirement = {
      ...requirement,
      requirement_id: `${requirement.requirement_id}-second`,
    };
    const secondMappingDraft = { ...mapping, requirement_id: secondRequirement.requirement_id };
    const secondMapping = {
      ...secondMappingDraft,
      mapping_hash: calculateCredentialMappingHash(secondMappingDraft),
    };
    const bothRequirements = [requirement, secondRequirement];
    const bothMappings = [mapping, secondMapping];
    const bothPolicy = { ...effectivePolicy, credential_requirements: bothRequirements };
    const bothExpression = {
      ...expression,
      requirements: { ...requirements, credential_requirements: bothRequirements },
    };
    const bothClosureDraft = {
      ...closure,
      aggregate_limits: bothPolicy,
      bindings: closure.bindings.map((binding) => ({
        ...binding,
        requirement_expression: bothExpression,
        effective_policy: bothPolicy,
      })),
    };
    const bothClosure = {
      ...bothClosureDraft,
      closure_hash: canonicalSha256ExcludingRootKeys(bothClosureDraft, ['closure_hash']),
    };
    const bothMappingHash = calculateCredentialMappingSetHash('flow', bothMappings);
    const bothEpochs = [
      ...epochSources,
      {
        source_kind: 'credential_policy' as const,
        source_id: mapping.credential_policy.policy_id,
        source_subkey: secondRequirement.requirement_id,
        observed_epoch: 1,
      },
      { ...principalEpoch, source_subkey: secondRequirement.requirement_id },
    ].sort(compareEpochSource);
    const both = sealPublishedFixture({
      ...base,
      closure: bothClosure,
      revision: {
        ...revision,
        credential_mappings: bothMappings,
        credential_mapping_hash: bothMappingHash,
      },
      snapshot: { ...snapshot, credential_mapping_hash: bothMappingHash },
      decision: {
        ...decision,
        epoch_sources: bothEpochs,
        allowed_bindings: [
          {
            ...decision.allowed_bindings[0],
            credential_bindings: [
              credentialBinding,
              {
                ...credentialBinding,
                requirement_id: secondRequirement.requirement_id,
                mapping_hash: secondMapping.mapping_hash,
              },
            ],
          },
        ],
      },
    });
    const bothPlan = resolveExecutionPlan({
      ...common(both),
      closure: both.closure,
      deployment_revision: both.revision,
      admission_snapshot: both.snapshot,
      authorization_decision: both.decision,
      entry_purpose: 'flow_run',
    });
    expect(bothPlan.enabled_bindings[0]?.credential_bindings).toHaveLength(2);
    expect(verifyResolvedExecutionPlan(bothPlan, bothPlan.plan_hash)).toEqual(bothPlan);
    for (const mutation of [
      { epoch_source: principalEpoch },
      { credential_id: 'different-credential' },
      { credential_version_id: 'rotated-material' },
      { material_fingerprint_hash: hashA },
      { provider_id: 'wrong-provider' },
      { audience: 'wrong-audience' },
      { granted_scopes: [] },
      { epoch_source: { ...credentialEpoch, observed_epoch: 4 } },
    ]) {
      const candidate = {
        ...published.decision,
        allowed_bindings: [
          {
            ...published.decision.allowed_bindings[0],
            credential_bindings: [{ ...credentialBinding, ...mutation }],
          },
        ],
        decision_hash: hashA,
      };
      expect(() =>
        resolveExecutionPlan({
          ...common(published),
          closure,
          deployment_revision: published.revision,
          admission_snapshot: published.snapshot,
          entry_purpose: 'flow_run',
          authorization_decision: {
            ...candidate,
            decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
          },
        }),
      ).toThrowError();
    }
    const allowedBinding = published.decision.allowed_bindings[0];
    if (allowedBinding === undefined) throw new Error('fixture must contain an allowed binding');
    const missingCredentialCandidate = {
      ...published.decision,
      allowed_bindings: [{ ...allowedBinding, credential_bindings: [] }],
      decision_hash: hashA,
    };
    const missingCredential = {
      ...missingCredentialCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(missingCredentialCandidate, [
        'decision_hash',
      ]),
    };
    expect(() =>
      resolveExecutionPlan({
        closure,
        deployment_revision: published.revision,
        admission_snapshot: published.snapshot,
        authorization_decision: missingCredential,
        entry_purpose: 'flow_run',
        ...common(published),
      }),
    ).toThrowError(/every and only credential requirement/);
  });

  it('fails closed when a forced binding is omitted and retains its ordered required call when admitted', () => {
    const value = fixture();
    const requiredCall = {
      order: 2,
      output_injection: 'before_current_user_input',
      on_empty: 'fail_closed',
      on_timeout: 'fail_closed',
      on_authorization_denied: 'fail_closed',
    } as const;
    const closureCandidate = {
      ...value.closure,
      bindings: value.closure.bindings.map((binding) => ({
        ...binding,
        admission_requirement: 'forced' as const,
        required_call: requiredCall,
      })),
      closure_hash: hashA,
    };
    const closure = {
      ...closureCandidate,
      closure_hash: canonicalSha256ExcludingRootKeys(closureCandidate, ['closure_hash']),
    };
    const omittedCandidate = {
      ...value.decision,
      capability_closure_hash: closure.closure_hash,
      decision_hash: hashA,
    };
    const omitted = {
      ...omittedCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(omittedCandidate, ['decision_hash']),
    };
    const publishedOmitted = sealPublishedFixture({ ...value, closure, decision: omitted });
    expect(() =>
      resolveExecutionPlan({
        closure,
        deployment_revision: publishedOmitted.revision,
        admission_snapshot: publishedOmitted.snapshot,
        authorization_decision: publishedOmitted.decision,
        entry_purpose: 'flow_run',
        ...common(publishedOmitted),
      }),
    ).toThrowError(/forced binding .* is unavailable/);
    const deniedClosureDraft = { ...closure, disabled_binding_paths: [value.bindingPath] };
    const deniedClosure = {
      ...deniedClosureDraft,
      closure_hash: canonicalSha256ExcludingRootKeys(deniedClosureDraft, ['closure_hash']),
    };
    const denied = sealPublishedFixture({ ...value, closure: deniedClosure, decision: omitted });
    expect(() =>
      resolveExecutionPlan({
        ...common(denied),
        closure: denied.closure,
        deployment_revision: denied.revision,
        admission_snapshot: denied.snapshot,
        authorization_decision: denied.decision,
        entry_purpose: 'flow_run',
      }),
    ).toThrow(/forced binding .* is unavailable/);
    const { credential_requirements: _requirements, ...limits } = closure.aggregate_limits;
    const epochSources = [
      ...value.decision.epoch_sources,
      {
        source_kind: 'capability_release_grant' as const,
        source_id: 'knowledge-grant',
        source_subkey: 'generation-1',
        observed_epoch: 1,
      },
      {
        source_kind: 'capability_release_state' as const,
        source_id: 'generation-1',
        source_subkey: 'KNOWLEDGE_INDEX_GENERATION',
        observed_epoch: 1,
      },
    ].sort(compareEpochSource);
    const admittedCandidate = {
      ...omitted,
      epoch_sources: epochSources,
      allowed_bindings: [
        {
          binding_path: value.bindingPath,
          policy_ceiling: {
            schema_version: 'capability-policy-ceiling/1',
            credential_allowances: [],
            ...limits,
          },
          credential_bindings: [],
        },
      ],
      decision_hash: hashA,
    };
    const admitted = {
      ...admittedCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(admittedCandidate, ['decision_hash']),
    };
    const published = sealPublishedFixture({ ...value, closure, decision: admitted });
    const plan = resolveExecutionPlan({
      closure,
      deployment_revision: published.revision,
      admission_snapshot: published.snapshot,
      authorization_decision: published.decision,
      entry_purpose: 'flow_run',
      ...common(published),
    });
    expect(plan.required_calls).toEqual([
      {
        binding_path: value.bindingPath,
        execution_scope_path: canonicalBindingPath([
          value.closure.bindings[0]?.binding_path_segments[0],
        ]),
        source_node_id: canonicalResourceNodeId(value.closure.root.pin),
        ...requiredCall,
      },
    ]);
  });

  it('rejects a runtime-added binding path even with a self-consistent decision hash', () => {
    const value = fixture();
    const { credential_requirements: _requirements, ...limits } = value.closure.aggregate_limits;
    const candidate = {
      ...value.decision,
      allowed_bindings: [
        {
          binding_path: `bp1.${'a'.repeat(43)}`,
          policy_ceiling: {
            schema_version: 'capability-policy-ceiling/1',
            credential_allowances: [],
            ...limits,
          },
          credential_bindings: [],
        },
      ],
      decision_hash: hashA,
    };
    const decision = {
      ...candidate,
      decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: decision,
        entry_purpose: 'flow_run',
        ...common({ decision }),
      }),
    ).toThrowError(/unknown or disabled binding path/);
  });

  it('rejects kind/profile substitution before producing a plan', () => {
    const value = fixture();
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: { ...value.revision, deployment_kind: 'agent' },
        admission_snapshot: value.snapshot,
        authorization_decision: value.decision,
        entry_purpose: 'flow_run',
        ...common(value),
      }),
    ).toThrowError(/closed bounded v1 contract/);
  });

  it('rejects authorization epoch evidence that does not preserve the admission snapshot', () => {
    const value = fixture();
    const candidate = {
      ...value.decision,
      epoch_sources: value.decision.epoch_sources.map((source) =>
        source.source_kind === 'flow_deployment_security'
          ? { ...source, observed_epoch: 8 }
          : source,
      ),
      decision_hash: hashA,
    };
    const decision = {
      ...candidate,
      decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: decision,
        entry_purpose: 'flow_run',
        expected_admission_epochs,
        admission_clock,
        expected_authorization_epoch_sources: value.decision.epoch_sources,
        executable_source: value.executableSource,
      }),
    ).toThrowError(/independently read current source set/);
  });

  it('rejects a hash-valid snapshot when the independently locked revoke epoch differs', () => {
    const value = fixture();
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: value.decision,
        entry_purpose: 'flow_run',
        ...common(value),
        expected_admission_epochs: { admission_activation_epoch: 3, observed_revoke_epoch: 8 },
      }),
    ).toThrowError(/RELEASE_ADMISSION_SNAPSHOT_INVALID/);
  });

  it('rejects an authorization ceiling that tries to add an operation to a known path', () => {
    const value = fixture();
    const { credential_requirements: _requirements, ...limits } = value.closure.aggregate_limits;
    const candidate = {
      ...value.decision,
      allowed_bindings: [
        {
          binding_path: value.bindingPath,
          policy_ceiling: {
            schema_version: 'capability-policy-ceiling/1',
            credential_allowances: [],
            ...limits,
            operation_contract_hashes: [hashA],
          },
          credential_bindings: [],
        },
      ],
      decision_hash: hashA,
    };
    const decision = {
      ...candidate,
      decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: decision,
        entry_purpose: 'flow_run',
        ...common({ decision }),
      }),
    ).toThrowError(/attempts to expand the verified closure/);
  });

  it.each([
    ['principal mode', { principal_modes: ['service_principal'] }],
    ['read classification', { readable_data_classification_ceiling: 'internal' }],
    ['side effect', { side_effect: { maximum_class: 'requires_key', approval: 'none' } }],
    ['calls', { max_calls: 1 }],
    ['depth', { max_depth: 1 }],
    ['parallelism', { max_parallelism: 1 }],
    [
      'egress',
      {
        egress: [
          {
            schema_version: 'canonical-egress-rule/1',
            network_policy: {
              policy_id: 'network',
              policy_hash: hashA,
              address_class: 'public_only',
            },
            scheme: 'https',
            host: { match: 'exact', name: 'example.com' },
            port: 443,
            path: { match: 'subtree', value: '/' },
            methods: ['GET'],
            dns_resolution: 'revalidate_each_connection',
            redirects: { mode: 'deny', max_hops: 0, strip_cross_origin_credentials: true },
          },
        ],
      },
    ],
    [
      'token budget',
      {
        budget: {
          schema_version: 'capability-budget/1',
          amount_credits: '0',
          input_tokens: 1,
          output_tokens: 0,
          total_tokens: 1,
          duration_ms: 0,
        },
      },
    ],
    [
      'duration budget',
      {
        budget: {
          schema_version: 'capability-budget/1',
          amount_credits: '0',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          duration_ms: 1,
        },
      },
    ],
    [
      'credit budget',
      {
        budget: {
          schema_version: 'capability-budget/1',
          amount_credits: '1',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          duration_ms: 0,
        },
      },
    ],
  ] as const)('rejects %s authority beyond the closure', (_label, override) => {
    const value = fixture();
    const { credential_requirements: _requirements, ...limits } = value.closure.aggregate_limits;
    const candidate = {
      ...value.decision,
      allowed_bindings: [
        {
          binding_path: value.bindingPath,
          policy_ceiling: {
            schema_version: 'capability-policy-ceiling/1',
            credential_allowances: [],
            ...limits,
            ...override,
          },
          credential_bindings: [],
        },
      ],
      decision_hash: hashA,
    };
    const decision = {
      ...candidate,
      decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: decision,
        entry_purpose: 'flow_run',
        ...common({ decision }),
      }),
    ).toThrowError(/attempts to expand the verified closure/);
  });

  it('derives the target from the closure and never accepts a target from authorization input', () => {
    const value = fixture();
    const { credential_requirements: _requirements, ...limits } = value.closure.aggregate_limits;
    const epochSources = [
      ...value.decision.epoch_sources,
      {
        source_kind: 'capability_release_grant' as const,
        source_id: 'knowledge-grant',
        source_subkey: 'generation-1',
        observed_epoch: 1,
      },
      {
        source_kind: 'capability_release_state' as const,
        source_id: 'generation-1',
        source_subkey: 'KNOWLEDGE_INDEX_GENERATION',
        observed_epoch: 1,
      },
    ].sort(compareEpochSource);
    const candidate = {
      ...value.decision,
      epoch_sources: epochSources,
      allowed_bindings: [
        {
          binding_path: value.bindingPath,
          policy_ceiling: {
            schema_version: 'capability-policy-ceiling/1',
            credential_allowances: [],
            ...limits,
          },
          credential_bindings: [],
        },
      ],
      decision_hash: hashA,
    };
    const decision = {
      ...candidate,
      decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
    };
    const published = sealPublishedFixture({ ...value, decision });
    const plan = resolveExecutionPlan({
      closure: published.closure,
      deployment_revision: published.revision,
      admission_snapshot: published.snapshot,
      authorization_decision: published.decision,
      entry_purpose: 'flow_run',
      ...common(published),
    });
    expect(plan.enabled_bindings).toHaveLength(1);
    expect(plan.enabled_bindings[0]?.target.published_resource_kind).toBe(
      'KNOWLEDGE_INDEX_GENERATION',
    );
    expect(plan.disabled_binding_paths).toEqual([]);
    expect(verifyResolvedExecutionPlan(plan, plan.plan_hash).plan_hash).toBe(plan.plan_hash);
    expect(() =>
      verifyResolvedExecutionPlan({ ...plan, plan_hash: hashA }, plan.plan_hash),
    ).toThrowError(/RELEASE_HASH_MISMATCH/);
    const binding = plan.enabled_bindings[0];
    if (binding === undefined) throw new Error('missing resolved Binding');
    for (const mutation of [
      { operation_contract_hashes: [hashB] },
      { credential_mapping_hashes: [hashA] },
      { target: { ...binding.target, workspace_id: '00000000-0000-7000-8000-000000000999' } },
    ]) {
      const candidate = {
        ...plan,
        enabled_bindings: [{ ...binding, ...mutation }],
        plan_hash: hashA,
      };
      const resealed = {
        ...candidate,
        plan_hash: canonicalSha256ExcludingRootKeys(candidate, ['plan_hash']),
      };
      expect(() => verifyResolvedExecutionPlan(resealed, resealed.plan_hash)).toThrowError();
    }
    const targetDrift = {
      ...plan,
      enabled_bindings: [
        { ...binding, target: { ...binding.target, resource_version_id: 'another-version' } },
      ],
      plan_hash: hashA,
    };
    const resealedTarget = {
      ...targetDrift,
      plan_hash: canonicalSha256ExcludingRootKeys(targetDrift, ['plan_hash']),
    };
    expect(() => verifyResolvedExecutionPlan(resealedTarget, plan.plan_hash)).toThrowError(
      /trusted admission receipt/,
    );
    const paths = Array.from({ length: 8_193 }, (_, index) =>
      canonicalBindingPath([
        { segment_kind: 'root', pin: value.closure.root.pin },
        {
          segment_kind: 'binding',
          owner: { owner_kind: 'root', pin: value.closure.root.pin },
          binding_kind: 'knowledge',
          local_binding_id: `budget-${index}`,
        },
      ]),
    ).sort();
    const atLimit = {
      ...plan,
      enabled_bindings: [],
      disabled_binding_paths: paths.slice(0, 8_192),
      plan_hash: hashA,
    };
    const sealedLimit = {
      ...atLimit,
      plan_hash: canonicalSha256ExcludingRootKeys(atLimit, ['plan_hash']),
    };
    expect(
      verifyResolvedExecutionPlan(sealedLimit, sealedLimit.plan_hash).disabled_binding_paths,
    ).toHaveLength(8_192);
    const overLimit = { ...atLimit, disabled_binding_paths: paths };
    expect(() =>
      verifyResolvedExecutionPlan(
        overLimit,
        canonicalSha256ExcludingRootKeys(overLimit, ['plan_hash']),
      ),
    ).toThrowError();
  });

  it('supports nonzero narrowing while preserving output taint, intrinsic minima and compiled approval', () => {
    const value = fixture();
    const expression = {
      ...emptyCapabilityRequirementExpression,
      requirements: {
        ...emptyCapabilityRequirements,
        output_data_classification: 'restricted' as const,
        minimum_limits: { ...emptyCapabilityRequirements.minimum_limits, calls: 1 },
      },
    };
    const policy = {
      ...value.closure.aggregate_limits,
      output_data_classification: 'restricted' as const,
      max_calls: 10,
      max_depth: 4,
      max_parallelism: 2,
      budget: {
        schema_version: 'capability-budget/1' as const,
        amount_credits: '10',
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 15,
        duration_ms: 50,
      },
    };
    const draft = {
      ...value.closure,
      aggregate_limits: policy,
      bindings: value.closure.bindings.map((binding) => ({
        ...binding,
        effective_policy: policy,
        requirement_expression: expression,
      })),
      resource_nodes: value.closure.resource_nodes.map((node) => ({
        ...node,
        intrinsic_policy: expression,
      })),
      closure_hash: hashA,
    };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    const { credential_requirements: _credentials, ...axes } = policy;
    const ceiling = {
      schema_version: 'capability-policy-ceiling/1',
      credential_allowances: [],
      ...axes,
      max_calls: 5,
      budget: {
        ...policy.budget,
        amount_credits: '5',
        input_tokens: 5,
        output_tokens: 5,
        total_tokens: 8,
        duration_ms: 25,
      },
    };
    const decision = {
      ...value.decision,
      epoch_sources: [
        ...value.decision.epoch_sources,
        {
          source_kind: 'capability_release_state' as const,
          source_id: 'generation-1',
          source_subkey: 'KNOWLEDGE_INDEX_GENERATION',
          observed_epoch: 1,
        },
      ].sort(compareEpochSource),
      root_authority: { policy_ceiling: ceiling, credential_bindings: [] },
      allowed_bindings: [
        { binding_path: value.bindingPath, policy_ceiling: ceiling, credential_bindings: [] },
      ],
    };
    const published = sealPublishedFixture({ ...value, closure, decision });
    const input = {
      closure,
      deployment_revision: published.revision,
      admission_snapshot: published.snapshot,
      authorization_decision: published.decision,
      entry_purpose: 'flow_run' as const,
      ...common(published),
    };
    expect(resolveExecutionPlan(input).enabled_bindings[0]?.effective_policy.max_calls).toBe(5);
    for (const override of [
      { output_data_classification: 'public' },
      { max_calls: 0 },
      { side_effect: { maximum_class: 'safe', approval: 'required' } },
    ]) {
      const changed = {
        ...published.decision,
        allowed_bindings: [
          {
            binding_path: value.bindingPath,
            policy_ceiling: { ...ceiling, ...override },
            credential_bindings: [],
          },
        ],
        decision_hash: hashA,
      };
      changed.decision_hash = canonicalSha256ExcludingRootKeys(changed, ['decision_hash']);
      expect(() => resolveExecutionPlan({ ...input, authorization_decision: changed })).toThrow();
    }
  });

  it('requires credential and entry-grant epochs even when caller expected facts omit them', () => {
    const value = fixture();
    for (const kind of [
      'credential',
      'flow_entry_grant',
      'workspace_authorization',
      'flow_deployment_security',
      'permission_policy',
      'published_release_state',
      'published_release_grant',
    ]) {
      const epochSources = value.decision.epoch_sources.filter(
        (source) => source.source_kind !== kind,
      );
      const candidate = { ...value.decision, epoch_sources: epochSources, decision_hash: hashA };
      const decision = {
        ...candidate,
        decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
      };
      expect(() =>
        resolveExecutionPlan({
          closure: value.closure,
          deployment_revision: value.revision,
          admission_snapshot: value.snapshot,
          authorization_decision: decision,
          entry_purpose: 'flow_run',
          expected_admission_epochs,
          admission_clock,
          expected_authorization_epoch_sources: epochSources,
          executable_source: value.executableSource,
        }),
      ).toThrowError(/omits|changes/);
    }
  });

  it('cannot substitute another subject grant for the same release version', () => {
    const value = fixture();
    const sources = value.decision.epoch_sources
      .map((source) =>
        source.source_kind === 'published_release_grant'
          ? {
              ...source,
              source_subkey: canonicalSha256({
                schema_version: 'release-grant-identity/1',
                workspace_id: workspaceId,
                authenticated_principal: {
                  schema_version: 'caller-principal/1',
                  kind: 'credential',
                  credential_id: 'another-credential',
                },
                target: value.revision.flow_version,
              }),
            }
          : source,
      )
      .sort(compareEpochSource);
    const candidate = { ...value.decision, epoch_sources: sources, decision_hash: hashA };
    const decision = {
      ...candidate,
      decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: decision,
        entry_purpose: 'flow_run',
        ...common(value),
        expected_authorization_epoch_sources: sources,
      }),
    ).toThrow(/exact subject and published pin/);
  });

  it('rejects an expired decision against the injected database transaction clock', () => {
    const value = fixture();
    const candidate = {
      ...value.decision,
      expires_at: '2026-09-02T00:00:00+00:00',
      decision_hash: hashA,
    };
    const decision = {
      ...candidate,
      decision_hash: canonicalSha256ExcludingRootKeys(candidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: decision,
        entry_purpose: 'flow_run',
        ...common({ decision }),
      }),
    ).toThrowError(/expired at admission time/);
  });

  it('rejects read-only entry scope and noncanonical epoch ordering for execution admission', () => {
    const value = fixture();
    const snapshotCandidate = { ...value.snapshot, entry_scope: 'run:read', snapshot_hash: hashA };
    const snapshot = {
      ...snapshotCandidate,
      snapshot_hash: canonicalSha256ExcludingRootKeys(snapshotCandidate, ['snapshot_hash']),
    };
    const decisionCandidate = {
      ...value.decision,
      admission_snapshot_hash: snapshot.snapshot_hash,
      decision_hash: hashA,
    };
    const decision = {
      ...decisionCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(decisionCandidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: snapshot,
        authorization_decision: decision,
        entry_purpose: 'flow_run',
        ...common({ decision }),
      }),
    ).toThrowError(/flow:run:create/);
    const reversedCandidate = {
      ...value.decision,
      epoch_sources: [...value.decision.epoch_sources].reverse(),
      decision_hash: hashA,
    };
    const reversed = {
      ...reversedCandidate,
      decision_hash: canonicalSha256ExcludingRootKeys(reversedCandidate, ['decision_hash']),
    };
    expect(() =>
      resolveExecutionPlan({
        closure: value.closure,
        deployment_revision: value.revision,
        admission_snapshot: value.snapshot,
        authorization_decision: reversed,
        entry_purpose: 'flow_run',
        expected_admission_epochs,
        admission_clock,
        expected_authorization_epoch_sources: reversed.epoch_sources,
        executable_source: value.executableSource,
      }),
    ).toThrowError(/closed bounded v1 contract/);
  });

  it('rejects hostile Proxy and accessor input before invoking user code', () => {
    let touched = false;
    const proxy = new Proxy(
      {},
      {
        get() {
          touched = true;
          throw new Error('trap');
        },
      },
    );
    expect(() => resolveExecutionPlan(proxy as never)).toThrowError(
      /COMPILED_CAPABILITY_CLOSURE_INVALID/,
    );
    expect(() => verifyResolvedExecutionPlan(proxy, hashA)).toThrowError(
      /COMPILED_CAPABILITY_CLOSURE_INVALID/,
    );
    const accessor = {};
    Object.defineProperty(accessor, 'closure', {
      enumerable: true,
      get() {
        touched = true;
        return {};
      },
    });
    expect(() => resolveExecutionPlan(accessor as never)).toThrowError(
      /COMPILED_CAPABILITY_CLOSURE_INVALID/,
    );
    expect(touched).toBe(false);
  });
});
