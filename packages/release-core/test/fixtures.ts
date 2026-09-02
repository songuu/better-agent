import { canonicalSha256, canonicalSha256ExcludingRootKeys } from '../src/index.js';

export const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
export const otherWorkspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eef';
export const agentId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
export const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
export const strategyId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
export const strategyReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e04';
export const flowId = '018f47f2-c541-7cc6-9292-4a2c35303e05';
export const flowVersionId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
export const experienceId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
export const experienceReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e08';
export const pluginId = '018f47f2-c541-7cc6-9292-4a2c35303e0c';
export const pluginReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
export const agentDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e10';
export const agentDeploymentRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e11';
export const flowDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e12';
export const flowDeploymentRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e13';
export const principalId = '018f47f2-c541-7cc6-9292-4a2c35303e14';
export const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303e15';

export const hashA = `sha256:${'a'.repeat(64)}` as const;
export const hashB = `sha256:${'b'.repeat(64)}` as const;
export const hashC = `sha256:${'c'.repeat(64)}` as const;

export const emptyCapabilityRequirements = {
  schema_version: 'capability-requirements/1',
  credential_requirements: [],
  principal_modes: ['none'],
  egress: [],
  readable_data_classification: 'public',
  output_data_classification: 'public',
  side_effect_class: 'safe',
  approval_required: false,
  operation_contract_hashes: [],
  minimum_limits: {
    calls: 0,
    depth: 0,
    parallelism: 0,
    budget: {
      schema_version: 'capability-budget/1',
      amount_credits: '0',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
    },
  },
} as const;

export const emptyCapabilityRequirementExpression = {
  schema_version: 'capability-requirement-expression/1',
  expression_kind: 'leaf',
  requirements: emptyCapabilityRequirements,
} as const;

export function makeStrategyRelease() {
  const candidate = {
    schema_version: 'agent-strategy-release/1',
    strategy_id: strategyId,
    strategy_release_id: strategyReleaseId,
    source_draft_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e09',
    abi_version: 'agent-strategy-abi/1',
    implementation_digest: hashA,
    config_hash: hashA,
    input_schema_hash: hashA,
    state_schema_hash: hashA,
    decision_schema_hash: hashA,
    observation_schema_hash: hashA,
    sandbox_profile_id: 'sandbox-default',
    allowed_model_policy_hash: hashA,
    allowed_capability_binding_ids: ['summarize-binding'],
    allowed_gate_spec_ids: [],
    max_iterations: 8,
    max_model_attempts: 4,
    max_tool_calls: 4,
    contract_hash: hashA,
  } as const;

  return {
    ...candidate,
    contract_hash: canonicalSha256ExcludingRootKeys(candidate, ['contract_hash']),
  } as const;
}

export function makeStrategyPin(workspace = workspaceId) {
  const strategy = makeStrategyRelease();
  return {
    workspace_id: workspace,
    published_resource_kind: 'AGENT_STRATEGY_RELEASE',
    resource_id: strategy.strategy_id,
    resource_version_id: strategy.strategy_release_id,
    contract_hash: strategy.contract_hash,
    binding_mode: 'pinned',
  } as const;
}

export function makeFlowPin(workspace = workspaceId) {
  return {
    workspace_id: workspace,
    published_resource_kind: 'FLOW_VERSION',
    resource_id: flowId,
    resource_version_id: flowVersionId,
    contract_hash: hashB,
    binding_mode: 'pinned',
  } as const;
}

export function makePluginPin(workspace = workspaceId) {
  return {
    workspace_id: workspace,
    published_resource_kind: 'PLUGIN_TOOL_RELEASE',
    resource_id: pluginId,
    resource_version_id: pluginReleaseId,
    contract_hash: hashB,
    binding_mode: 'pinned',
  } as const;
}

export function makeAgentRelease(options: { enabled?: boolean; pinWorkspace?: string } = {}) {
  const strategy = makeStrategyRelease();
  const pluginPin = makePluginPin(options.pinWorkspace);
  const inputSchema = { type: 'object' } as const;
  return {
    schema_version: 'agent-release/1',
    agent_id: agentId,
    agent_release_id: agentReleaseId,
    release_number: 1,
    source_draft_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e0a',
    role: { title: 'Assistant' },
    input_contract: { type: 'object' },
    model_policy: {},
    strategy: {
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      strategy_id: strategy.strategy_id,
      strategy_release_id: strategy.strategy_release_id,
      abi_version: strategy.abi_version,
      implementation_digest: strategy.implementation_digest,
      config_hash: strategy.config_hash,
      input_schema_hash: strategy.input_schema_hash,
      state_schema_hash: strategy.state_schema_hash,
      decision_schema_hash: strategy.decision_schema_hash,
      observation_schema_hash: strategy.observation_schema_hash,
      sandbox_profile_id: strategy.sandbox_profile_id,
      allowed_model_policy_hash: strategy.allowed_model_policy_hash,
      allowed_capability_binding_ids: strategy.allowed_capability_binding_ids,
      allowed_gate_spec_ids: strategy.allowed_gate_spec_ids,
      max_iterations: strategy.max_iterations,
      max_model_attempts: strategy.max_model_attempts,
      max_tool_calls: strategy.max_tool_calls,
      contract_hash: strategy.contract_hash,
    },
    gate_specs: [],
    instruction_skill_bindings: [],
    capability_bindings: [
      {
        binding_id: 'summarize-binding',
        enabled: options.enabled ?? true,
        discoverability: 'model_selectable',
        manual: { description: 'Summarize text', hash: hashA },
        input_schema: inputSchema,
        data_classification: 'internal',
        side_effect: { class: 'safe', approval: 'none' },
        task_safe: true,
        mock_safe: true,
        retry: {},
        timeout_ms: 1_000,
        budget: {},
        credential_requirement: {
          schema_version: 'credential-requirement/1',
          requirement_id: 'model-provider',
          provider_id: 'model-provider',
          audience: 'model-runtime',
          required_scopes: ['model:invoke'],
          allowed_principal_modes: ['service_principal'],
        },
        kind: 'plugin',
        pin: pluginPin,
        config: {
          schema_version: 'plugin-binding/1',
          operation_contract_hash: hashA,
          provider_tool_name: 'summarize',
          transport_contract_hash: hashA,
          default_parameters: {},
        },
      },
    ],
    public_capability_handles: [
      {
        schema_version: 'public-capability-handle/1',
        public_handle: 'summarize',
        binding_id: 'summarize-binding',
        operation_contract_hash: hashA,
        input_schema_hash: canonicalSha256(inputSchema),
        allowed_entry_modes: ['experience_shortcut'],
      },
    ],
    task_templates: [],
    authorization_policy: {},
    runtime_limits: {},
    capability_closure_hash: hashA,
    compiled_hash: hashC,
  } as const;
}

export function makeAgentReleasePin(workspace = workspaceId) {
  const release = makeAgentRelease();
  return {
    workspace_id: workspace,
    published_resource_kind: 'AGENT_RELEASE',
    resource_id: release.agent_id,
    resource_version_id: release.agent_release_id,
    contract_hash: canonicalSha256(release),
    binding_mode: 'pinned',
  } as const;
}

export function makeExperienceRelease() {
  const candidate = {
    schema_version: 'experience-release/1',
    experience_id: experienceId,
    experience_release_id: experienceReleaseId,
    compatible_agent_id: agentId,
    source_draft_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e0b',
    opening_message: 'How can I help?',
    recommended_questions: ['Summarize this'],
    quick_entries: [
      {
        quick_entry_id: 'summary',
        label: 'Summary',
        public_handle: 'summarize',
        operation_contract_hash: hashA,
        input_schema_hash: canonicalSha256({ type: 'object' }),
        default_inputs: {},
      },
    ],
    content_hash: hashA,
  } as const;

  return {
    ...candidate,
    content_hash: canonicalSha256ExcludingRootKeys(candidate, ['content_hash']),
  } as const;
}

export function makeExperiencePin(workspace = workspaceId) {
  const experience = makeExperienceRelease();
  return {
    workspace_id: workspace,
    published_resource_kind: 'EXPERIENCE_RELEASE',
    resource_id: experience.experience_id,
    resource_version_id: experience.experience_release_id,
    contract_hash: experience.content_hash,
    binding_mode: 'pinned',
  } as const;
}

export function makeFlowIr() {
  return {
    schema_version: 'flow-ir/1',
    flow_id: flowId,
    flow_version_id: flowVersionId,
    title: 'Minimal flow',
    entry_graph: {
      graph_id: 'root',
      entry_node_id: 'start-1',
      exit_node_ids: ['output-1'],
      nodes: [
        {
          node_id: 'start-1',
          key: 'start',
          type: 'start',
          config: {},
          inputs: {},
          output_schema: { type: 'object' },
        },
        {
          node_id: 'output-1',
          key: 'output',
          type: 'output',
          config: {},
          inputs: {},
          output_schema: { type: 'object' },
        },
      ],
      edges: [
        {
          edge_id: 'edge-1',
          from: { node_id: 'start-1', port: 'control' },
          to: { node_id: 'output-1', port: 'control' },
          kind: 'control',
        },
      ],
    },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    resources: [],
    credential_requirements: [],
    execution_defaults: {},
  } as const;
}

export function makePolicyPin(
  policyKind:
    | 'deployment_profile'
    | 'entry_grant'
    | 'entry_scope'
    | 'oauth_delegation'
    | 'service_principal'
    | 'team_credential',
  workspace = workspaceId,
) {
  return {
    schema_version: 'deployment-policy-pin/1',
    workspace_id: workspace,
    policy_kind: policyKind,
    policy_id: '018f47f2-c541-7cc6-9292-4a2c35303e16',
    policy_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e17',
    contract_hash: hashA,
  } as const;
}

export function makeCredentialRequirement() {
  return {
    schema_version: 'credential-requirement/1',
    requirement_id: 'model-provider',
    provider_id: 'model-provider',
    audience: 'model-runtime',
    required_scopes: ['model:invoke'],
    allowed_principal_modes: ['service_principal'],
  } as const;
}

export function makeServiceMapping(
  deploymentKind: 'agent' | 'flow' = 'agent',
  overrides: Record<string, unknown> = {},
) {
  const candidate = {
    schema_version:
      deploymentKind === 'agent'
        ? 'agent-deployment-credential-mapping/1'
        : 'flow-deployment-credential-mapping/1',
    requirement_id: 'model-provider',
    provider_id: 'model-provider',
    audience: 'model-runtime',
    allowed_scopes: ['model:invoke'],
    credential_policy: makePolicyPin('service_principal'),
    principal_mode: 'service_principal',
    credential_source_kind: 'service_principal_policy',
    service_principal_id: principalId,
    mapping_hash: hashA,
    ...overrides,
  } as Record<string, unknown>;
  for (const [key, value] of Object.entries(candidate)) {
    if (value === undefined) delete candidate[key];
  }
  return {
    ...candidate,
    mapping_hash: canonicalSha256ExcludingRootKeys(candidate, ['mapping_hash']),
  };
}

export function credentialMappingSetHash(
  deploymentKind: 'agent' | 'flow',
  mappings: readonly unknown[],
) {
  return canonicalSha256({
    schema_version: 'deployment-credential-mapping-set/1',
    deployment_kind: deploymentKind,
    mappings,
  });
}

export function makeAgentStable(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'agent-deployment-stable/1',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_id: agentId,
    public_selector: 'assistant',
    environment: 'development',
    ingress_channel: 'service_api',
    ...overrides,
  };
}

export function makeFlowStable(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'flow-deployment-stable/1',
    workspace_id: workspaceId,
    flow_deployment_id: flowDeploymentId,
    flow_id: flowId,
    public_selector: 'flow',
    environment: 'staging',
    ingress_channel: 'service_api',
    ...overrides,
  };
}
