import { describe, expect, it } from 'vitest';

import {
  AgentDeploymentCredentialMappingV1Schema,
  AgentDeploymentEntryAdmissionSnapshotV1Schema,
  AgentDeploymentEntryGrantV1Schema,
  AgentDeploymentRevisionV1Schema,
  AgentReleaseV1Schema,
  BrowserSessionMetadataV1Schema,
  ExperienceReleaseV1Schema,
  FlowDeploymentEntryGrantV1Schema,
  FlowDeploymentRevisionV1Schema,
  parseDomainContract,
} from '../src/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const agentId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const agentDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const agentRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e04';
const experienceId = '018f47f2-c541-7cc6-9292-4a2c35303e05';
const experienceReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
const flowId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
const flowDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e08';
const flowRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e09';
const flowVersionId = '018f47f2-c541-7cc6-9292-4a2c35303e0a';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303e0b';
const principalId = '018f47f2-c541-7cc6-9292-4a2c35303e0c';
const sessionId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;

function pluginBinding(bindingId: string) {
  return {
    binding_id: bindingId,
    enabled: true,
    discoverability: 'model_selectable',
    manual: { description: 'Summarize text', hash: hashA },
    input_schema: { type: 'object' },
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
    pin: {
      workspace_id: workspaceId,
      published_resource_kind: 'PLUGIN_TOOL_RELEASE',
      resource_id: '018f47f2-c541-7cc6-9292-4a2c35303e20',
      resource_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e21',
      contract_hash: hashA,
      binding_mode: 'pinned',
    },
    config: {
      schema_version: 'plugin-binding/1',
      operation_contract_hash: hashA,
      provider_tool_name: 'summarize',
      transport_contract_hash: hashA,
      default_parameters: {},
    },
  } as const;
}

function policyPin(
  policyKind: 'deployment_profile' | 'entry_grant' | 'entry_scope' | 'service_principal',
) {
  return {
    schema_version: 'deployment-policy-pin/1',
    workspace_id: workspaceId,
    policy_kind: policyKind,
    policy_id: '018f47f2-c541-7cc6-9292-4a2c35303e10',
    policy_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e11',
    contract_hash: hashA,
  } as const;
}

const serviceMapping = {
  schema_version: 'agent-deployment-credential-mapping/1',
  requirement_id: 'model-provider',
  provider_id: 'model-provider',
  audience: 'model-runtime',
  allowed_scopes: ['model:invoke'],
  credential_policy: policyPin('service_principal'),
  principal_mode: 'service_principal',
  credential_source_kind: 'service_principal_policy',
  service_principal_id: principalId,
  mapping_hash: hashA,
} as const;

const agentReleasePin = {
  workspace_id: workspaceId,
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: agentId,
  resource_version_id: agentReleaseId,
  contract_hash: hashA,
  binding_mode: 'pinned',
} as const;

const experienceReleasePin = {
  workspace_id: workspaceId,
  published_resource_kind: 'EXPERIENCE_RELEASE',
  resource_id: experienceId,
  resource_version_id: experienceReleaseId,
  contract_hash: hashA,
  binding_mode: 'pinned',
} as const;

const flowVersionPin = {
  workspace_id: workspaceId,
  published_resource_kind: 'FLOW_VERSION',
  resource_id: flowId,
  resource_version_id: flowVersionId,
  contract_hash: hashA,
  binding_mode: 'pinned',
} as const;

const browserAgentRevision = {
  schema_version: 'agent-deployment/1',
  deployment_kind: 'agent',
  workspace_id: workspaceId,
  agent_deployment_id: agentDeploymentId,
  agent_deployment_revision_id: agentRevisionId,
  agent_id: agentId,
  environment: 'development',
  ingress_channel: 'browser',
  agent_release: agentReleasePin,
  experience_release: experienceReleasePin,
  policy_profile: policyPin('deployment_profile'),
  entry_grant_policy: policyPin('entry_grant'),
  entry_scope_policy: policyPin('entry_scope'),
  credential_mappings: [serviceMapping],
  credential_mapping_hash: hashA,
  allowed_origins: ['https://app.example'],
  browser_client_channels: ['WEB_SDK'],
  session_token_audience: 'agent_browser_api',
  conversation_contract_hash: hashA,
  dependency_manifest_hash: hashA,
  change_set_hash: hashA,
  revision_contract_hash: hashA,
} as const;

describe('G0-05 Experience and Deployment contracts', () => {
  it('rejects duplicate credential requirement ids across Agent capability bindings', () => {
    const release = {
      schema_version: 'agent-release/1',
      agent_id: agentId,
      agent_release_id: agentReleaseId,
      release_number: 1,
      source_draft_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e22',
      role: {},
      input_contract: { type: 'object' },
      model_policy: {},
      strategy: {
        published_resource_kind: 'AGENT_STRATEGY_RELEASE',
        strategy_id: '018f47f2-c541-7cc6-9292-4a2c35303e23',
        strategy_release_id: '018f47f2-c541-7cc6-9292-4a2c35303e24',
        abi_version: 'agent-strategy-abi/1',
        implementation_digest: hashA,
        config_hash: hashA,
        input_schema_hash: hashA,
        state_schema_hash: hashA,
        decision_schema_hash: hashA,
        observation_schema_hash: hashA,
        sandbox_profile_id: 'sandbox-default',
        allowed_model_policy_hash: hashA,
        allowed_capability_binding_ids: ['binding-a', 'binding-b'],
        allowed_gate_spec_ids: [],
        max_iterations: 8,
        max_model_attempts: 4,
        max_tool_calls: 4,
        contract_hash: hashA,
      },
      gate_specs: [],
      instruction_skill_bindings: [],
      capability_bindings: [pluginBinding('binding-a'), pluginBinding('binding-b')],
      public_capability_handles: [],
      task_templates: [],
      authorization_policy: {},
      runtime_limits: {},
      capability_closure_hash: hashA,
      compiled_hash: hashB,
    } as const;

    expect(AgentReleaseV1Schema.safeParse(release).success).toBe(false);
  });

  it('registers a strict Experience Release with unique public handles', () => {
    const experience = {
      schema_version: 'experience-release/1',
      experience_id: experienceId,
      experience_release_id: experienceReleaseId,
      compatible_agent_id: agentId,
      source_draft_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e12',
      opening_message: 'How can I help?',
      recommended_questions: ['Summarize this'],
      quick_entries: [
        {
          quick_entry_id: 'summary',
          label: 'Summary',
          public_handle: 'summarize',
          operation_contract_hash: hashA,
          input_schema_hash: hashB,
          default_inputs: {},
        },
      ],
      content_hash: hashA,
    } as const;

    expect(ExperienceReleaseV1Schema.safeParse(experience).success).toBe(true);
    expect(parseDomainContract(experience)).toEqual(experience);
    expect(
      ExperienceReleaseV1Schema.safeParse({
        ...experience,
        quick_entries: [experience.quick_entries[0], experience.quick_entries[0]],
      }).success,
    ).toBe(false);
    expect(ExperienceReleaseV1Schema.safeParse({ ...experience, secret: 'nope' }).success).toBe(
      false,
    );
  });

  it('keeps credential mapping branches closed', () => {
    expect(AgentDeploymentCredentialMappingV1Schema.safeParse(serviceMapping).success).toBe(true);
    expect(
      AgentDeploymentCredentialMappingV1Schema.safeParse({
        ...serviceMapping,
        principal_source: 'authenticated_end_user',
      }).success,
    ).toBe(false);
    expect(
      AgentDeploymentCredentialMappingV1Schema.safeParse({
        ...serviceMapping,
        credential_policy: policyPin('entry_scope'),
      }).success,
    ).toBe(false);
  });

  it('requires browser-only origin, client-channel and token-audience facts', () => {
    expect(AgentDeploymentRevisionV1Schema.safeParse(browserAgentRevision).success).toBe(true);
    expect(
      AgentDeploymentRevisionV1Schema.safeParse({
        ...browserAgentRevision,
        allowed_origins: ['https://app.example/path'],
      }).success,
    ).toBe(false);
    expect(
      AgentDeploymentRevisionV1Schema.safeParse({
        ...browserAgentRevision,
        ingress_channel: 'service_api',
      }).success,
    ).toBe(false);
    expect(
      AgentDeploymentRevisionV1Schema.safeParse({
        ...browserAgentRevision,
        agent_release: { ...agentReleasePin, contract_hash: 'sha256:not-a-digest' },
      }).success,
    ).toBe(false);
  });

  it('keeps Agent and Flow entry grant tuples disjoint', () => {
    const agentGrant = {
      schema_version: 'agent-deployment-entry-grant/1',
      entry_grant_id: '018f47f2-c541-7cc6-9292-4a2c35303e13',
      workspace_id: workspaceId,
      credential_id: credentialId,
      agent_deployment_id: agentDeploymentId,
      credential_kind: 'publish',
      principal_mode: 'issuer_asserted_end_user',
      entry_audience: 'browser_session_exchange',
      ingress_channel: 'browser',
      scope: 'browser-session:exchange',
      target_cardinality: 'exactly_one_agent_deployment',
      status: 'ACTIVE',
      authorization_epoch: 0,
    } as const;
    const flowGrant = {
      schema_version: 'flow-deployment-entry-grant/1',
      entry_grant_id: '018f47f2-c541-7cc6-9292-4a2c35303e14',
      workspace_id: workspaceId,
      credential_id: credentialId,
      flow_deployment_id: flowDeploymentId,
      credential_kind: 'service_api',
      principal_mode: 'credential_service_principal',
      entry_audience: 'flow_runtime_api',
      ingress_channel: 'service_api',
      scope: 'run:read',
      target_cardinality: 'exactly_one_flow_deployment',
      status: 'ACTIVE',
      authorization_epoch: 2,
    } as const;

    expect(AgentDeploymentEntryGrantV1Schema.safeParse(agentGrant).success).toBe(true);
    expect(FlowDeploymentEntryGrantV1Schema.safeParse(flowGrant).success).toBe(true);
    expect(AgentDeploymentEntryGrantV1Schema.safeParse(flowGrant).success).toBe(false);
    expect(
      FlowDeploymentEntryGrantV1Schema.safeParse({ ...flowGrant, scope: 'agent:run:create' })
        .success,
    ).toBe(false);
  });

  it('keeps G0 snapshots free of Run and effective-plan facts', () => {
    const snapshot = {
      schema_version: 'agent-deployment-entry-admission-snapshot/1',
      deployment_kind: 'agent',
      entry_source_kind: 'service_credential',
      workspace_id: workspaceId,
      agent_deployment_id: agentDeploymentId,
      agent_deployment_revision_id: agentRevisionId,
      agent_deployment_revision_contract_hash: hashA,
      agent_release: agentReleasePin,
      experience_release: experienceReleasePin,
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
      entry_grant_id: '018f47f2-c541-7cc6-9292-4a2c35303e15',
      entry_grant_authorization_epoch: 4,
      entry_credential_kind: 'service_api',
      entry_principal_mode: 'credential_service_principal',
      entry_audience: 'agent_runtime_api',
      entry_channel: 'service_api',
      entry_scope: 'agent:run:create',
      entry_target_cardinality: 'exactly_one_agent_deployment',
      policy_profile_contract_hash: hashA,
      entry_scope_policy_contract_hash: hashA,
      credential_mapping_hash: hashA,
      dependency_manifest_hash: hashA,
      snapshot_hash: hashB,
    } as const;

    expect(AgentDeploymentEntryAdmissionSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(
      AgentDeploymentEntryAdmissionSnapshotV1Schema.safeParse({
        ...snapshot,
        run_id: '018f47f2-c541-7cc6-9292-4a2c35303e16',
      }).success,
    ).toBe(false);
    expect(
      AgentDeploymentEntryAdmissionSnapshotV1Schema.safeParse({
        ...snapshot,
        effective_policy_hash: hashA,
      }).success,
    ).toBe(false);
    expect(
      AgentDeploymentEntryAdmissionSnapshotV1Schema.safeParse({
        ...snapshot,
        authenticated_principal: {
          ...snapshot.authenticated_principal,
          credential_id: '018f47f2-c541-7cc6-9292-4a2c35303e18',
        },
      }).success,
    ).toBe(false);
  });

  it('binds browser session metadata to principal and Deployment epochs', () => {
    const session = {
      schema_version: 'browser-session-metadata/1',
      browser_session_id: sessionId,
      workspace_id: workspaceId,
      agent_deployment_id: agentDeploymentId,
      principal_id: principalId,
      assertion_use_id: '018f47f2-c541-7cc6-9292-4a2c35303e17',
      client_channel: 'DINGTALK_WEB',
      canonical_origin: 'https://app.example',
      token_audience: 'agent_browser_api',
      observed_principal_session_epoch: 4,
      observed_deployment_revoke_epoch: 8,
      session_epoch: 1,
      status: 'ACTIVE',
      issued_at: '2026-08-26T00:00:00Z',
      expires_at: '2026-08-26T00:15:00Z',
    } as const;

    expect(BrowserSessionMetadataV1Schema.safeParse(session).success).toBe(true);
    expect(
      BrowserSessionMetadataV1Schema.safeParse({
        ...session,
        expires_at: '2026-08-26T00:15:01Z',
      }).success,
    ).toBe(false);
    expect(
      BrowserSessionMetadataV1Schema.safeParse({ ...session, session_verifier_hmac: hashA })
        .success,
    ).toBe(false);
  });
});

describe('G0-05 Flow Deployment revision', () => {
  it('does not accept browser-only fields', () => {
    const flowRevision = {
      schema_version: 'flow-deployment/1',
      deployment_kind: 'flow',
      workspace_id: workspaceId,
      flow_deployment_id: flowDeploymentId,
      flow_deployment_revision_id: flowRevisionId,
      flow_id: flowId,
      environment: 'staging',
      ingress_channel: 'service_api',
      flow_version: flowVersionPin,
      policy_profile: policyPin('deployment_profile'),
      entry_grant_policy: policyPin('entry_grant'),
      entry_scope_policy: policyPin('entry_scope'),
      credential_mappings: [],
      credential_mapping_hash: hashA,
      dependency_manifest_hash: hashA,
      change_set_hash: hashA,
      revision_contract_hash: hashA,
    } as const;

    expect(FlowDeploymentRevisionV1Schema.safeParse(flowRevision).success).toBe(true);
    expect(
      FlowDeploymentRevisionV1Schema.safeParse({
        ...flowRevision,
        allowed_origins: ['https://app.example'],
      }).success,
    ).toBe(false);
  });
});
