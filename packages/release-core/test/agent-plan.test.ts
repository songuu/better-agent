import { describe, expect, it } from 'vitest';

import {
  canonicalSha256ExcludingRootKeys,
  prepareAgentStrategySource,
  prepareCompiledAgentPlan,
  prepareExecutableSource,
  preparePinnedDependencyGraph,
  prepareLeafResourceSource,
  canonicalSha256,
  verifyCompiledAgentPlan,
} from '../src/index.js';
import { richAgentSource } from './executable-source-fixtures.js';
import {
  agentDeploymentId,
  agentDeploymentRevisionId,
  experienceReleaseId,
  hashA,
  workspaceId,
} from './fixtures.js';
import { prepareAgentCapabilityClosure } from '../src/agent-capability-closure.js';
import { prepareGraphBoundAgentLeafBindingEntrySet } from '../src/agent-leaf-binding-entries.js';
import { prepareAgentRootBindingEntrySet } from '../src/agent-root-binding-entry-set.js';
import { prepareRootBindingPaths } from '../src/root-binding-paths.js';
import { leafCandidate, record } from './leaf-resource-source-fixtures.js';

const ceiling = {
  schema_version: 'capability-policy-ceiling/1',
  credential_allowances: [],
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

function fixture(withCapability = false) {
  const strategySource = {
    schema_version: 'agent-strategy-source-candidate/1' as const,
    workspace_id: workspaceId,
    document: {
      schema_version: 'agent-strategy-source/1' as const,
      strategy_id: '018f47f2-c541-7cc6-9292-4a2c35303e03',
      strategy_release_id: '018f47f2-c541-7cc6-9292-4a2c35303e04',
      abi_version: 'agent-strategy-abi/1' as const,
      implementation_digest: hashA,
      config: {},
      config_schema: { type: 'object' },
      input_schema: { type: 'object' },
      state_schema: { type: 'object' },
      decision_schema: { type: 'object' },
      observation_schema: { type: 'object' },
      sandbox_profile: {
        schema_version: 'strategy-sandbox-profile/1' as const,
        profile_id: 'sandbox-deny-all',
        host_abi: 'agent-strategy-abi/1' as const,
        network: 'deny' as const,
        filesystem: 'deny' as const,
        database: 'deny' as const,
        secrets: 'deny' as const,
        maximum_memory_bytes: 1_048_576,
        maximum_instruction_count: 100_000,
      },
      allowed_model_policy: {
        schema_version: 'strategy-model-policy/1' as const,
        models: [
          {
            descriptor_id: 'model-primary',
            provider_id: 'provider-1',
            model_id: 'model-1',
            model_revision: '2026-09-01',
            model_contract_hash: hashA,
          },
        ],
        maximum_input_tokens: 1024,
        maximum_output_tokens: 256,
      },
      allowed_capability_binding_ids: withCapability ? ['database'] : [],
      allowed_gate_spec_ids: [],
      max_iterations: 8,
      max_model_attempts: 4,
      max_tool_calls: withCapability ? 4 : 0,
    },
  };
  const preparedStrategy = prepareAgentStrategySource(strategySource);
  const agent = richAgentSource();
  const pluginSource = withCapability ? leafCandidate('DATABASE_OPERATION_RELEASE') : undefined;
  const preparedPlugin =
    pluginSource === undefined ? undefined : prepareLeafResourceSource(pluginSource);
  if (!withCapability) agent.capability_bindings = [];
  else {
    const binding = record(agent.capability_bindings.find((item) => item.kind === 'database'));
    agent.capability_bindings = agent.capability_bindings.filter(
      (item) => item.kind === 'database',
    );
    const pluginDocument = record(pluginSource?.document);
    binding.pin = preparedPlugin?.full_pin;
    binding.manual = {
      ...record(pluginDocument.manual),
      hash: preparedPlugin?.component_hashes.manual,
    };
    binding.input_schema = structuredClone(record(pluginDocument.operation).input_schema);
    binding.output_schema = structuredClone(record(pluginDocument.operation).output_schema);
    delete binding.credential_requirement;
    const config = record(binding.config);
    config.operation_contract_hash = preparedPlugin?.operation_contract.contract_hash;
    config.table_revision_ids = [record(pluginDocument.table).table_revision_id];
    config.allowed_tables = [
      { table_revision_id: record(pluginDocument.table).table_revision_id, columns: ['title'] },
    ];
    config.max_rows = 20;
    agent.public_capability_handles = [
      {
        schema_version: 'public-capability-handle/1',
        public_handle: 'database-shortcut',
        binding_id: String(binding.binding_id),
        operation_contract_hash: preparedPlugin?.operation_contract.contract_hash ?? hashA,
        input_schema_hash: canonicalSha256(binding.input_schema),
        allowed_entry_modes: ['experience_shortcut'],
      },
    ];
  }
  agent.instruction_skill_bindings = [];
  if (!withCapability) agent.public_capability_handles = [];
  agent.gate_specs = [];
  agent.strategy = structuredClone(preparedStrategy.strategy_pin);
  agent.model_policy = structuredClone(strategySource.document.allowed_model_policy);
  const executableSource = {
    schema_version: 'executable-source-candidate/1' as const,
    workspace_id: workspaceId,
    document: agent,
  };
  const source = prepareExecutableSource(executableSource);
  const graphInput = {
    schema_version: 'pinned-dependency-graph-candidate/1' as const,
    root: source.root,
    root_dependencies: source.dependency_manifest.dependencies,
    resources: [
      {
        schema_version: 'pinned-dependency-record/1' as const,
        pin: preparedStrategy.full_pin,
        publication_state: 'sealed' as const,
        dependency_manifest: preparedStrategy.dependency_manifest,
      },
      ...(preparedPlugin === undefined
        ? []
        : [
            {
              schema_version: 'pinned-dependency-record/1' as const,
              pin: preparedPlugin.full_pin,
              publication_state: 'sealed' as const,
              dependency_manifest: preparedPlugin.dependency_manifest,
            },
          ]),
    ],
  };
  const graph = preparePinnedDependencyGraph(graphInput);
  const activeCeiling =
    preparedPlugin === undefined
      ? ceiling
      : ({
          schema_version: 'capability-policy-ceiling/1',
          credential_allowances: preparedPlugin.intrinsic_policy.credential_requirements.map(
            (requirement) => ({
              provider_id: requirement.provider_id,
              audience: requirement.audience,
              allowed_scopes: [...requirement.required_scopes],
              principal_modes: [...requirement.allowed_principal_modes],
            }),
          ),
          principal_modes: [...preparedPlugin.intrinsic_policy.principal_modes],
          egress: [...preparedPlugin.intrinsic_policy.egress],
          readable_data_classification_ceiling: 'restricted',
          output_data_classification: 'public',
          side_effect: { maximum_class: 'unsafe', approval: 'none' },
          operation_contract_hashes: [preparedPlugin.operation_contract.contract_hash],
          max_calls: 100,
          max_depth: 100,
          max_parallelism: 100,
          budget: {
            schema_version: 'capability-budget/1',
            amount_credits: '1000000',
            input_tokens: 1000000,
            output_tokens: 1000000,
            total_tokens: 2000000,
            duration_ms: 1000000,
          },
        } as const);
  const path =
    preparedPlugin === undefined
      ? undefined
      : prepareRootBindingPaths(executableSource).bindings.find(
          (binding) => binding.binding_id === 'database',
        );
  const leafPolicy = {
    schema_version: 'agent-leaf-binding-policy-input/1' as const,
    workspace_ceiling: activeCeiling,
    root_ceiling: activeCeiling,
    binding_ceilings:
      path === undefined ? [] : [{ binding_path: path.binding_path, ceiling: activeCeiling }],
  };
  const slice = prepareGraphBoundAgentLeafBindingEntrySet(
    graph,
    graphInput,
    executableSource,
    pluginSource === undefined ? [] : [pluginSource],
    leafPolicy,
  );
  const entries = prepareAgentRootBindingEntrySet(executableSource, graph.graph_hash, [slice], {
    ...leafPolicy,
    schema_version: 'agent-root-binding-policy-input/1' as const,
  });
  const closure = prepareAgentCapabilityClosure(executableSource, graph, entries);
  const compiledBinding = closure.bindings[0];
  const resolvedCandidate = {
    schema_version: 'resolved-execution-plan/1' as const,
    plan_kind: 'agent' as const,
    workspace_id: workspaceId,
    deployment_revision_id: agentDeploymentRevisionId,
    deployment_revision_contract_hash: hashA,
    root_release: closure.root.pin,
    capability_closure_hash: closure.closure_hash,
    admission_snapshot_hash: hashA,
    admission_activation_epoch: 1,
    observed_revoke_epoch: 1,
    authorization_decision_id: 'decision-1',
    authorization_decision_hash: hashA,
    authorization_epoch_vector_hash: hashA,
    authorization_expires_at: '2026-09-04T12:00:00+00:00',
    enabled_bindings:
      compiledBinding === undefined
        ? []
        : [
            {
              binding_path: compiledBinding.binding_path,
              target: compiledBinding.target,
              operation_contract_hashes: compiledBinding.operation_contracts.map(
                (operation) => operation.contract_hash,
              ),
              effective_policy: compiledBinding.effective_policy,
              effective_policy_hash: canonicalSha256(compiledBinding.effective_policy),
              ...(compiledBinding.approval_gate_spec === undefined
                ? {}
                : { approval_gate_spec: compiledBinding.approval_gate_spec }),
              credential_mapping_hashes: [],
              credential_bindings: [],
            },
          ],
    disabled_binding_paths: [],
    required_binding_paths: [],
    required_calls: [],
    agent_deployment_id: agentDeploymentId,
    agent_release_id: agent.agent_release_id,
    experience_release_id: experienceReleaseId,
  };
  const resolved = {
    ...resolvedCandidate,
    plan_hash: canonicalSha256ExcludingRootKeys(resolvedCandidate, ['plan_hash']),
  };
  return { executableSource, strategySource, closure, resolved };
}

describe('compiled AgentPlan', () => {
  it('binds exact Agent, closure, admission and Strategy catalogs into a frozen plan', () => {
    const value = fixture();
    const plan = prepareCompiledAgentPlan({
      executable_source: value.executableSource,
      closure: value.closure,
      resolved_execution_plan: value.resolved,
      expected_resolved_execution_plan_hash: value.resolved.plan_hash,
      strategy_source: value.strategySource,
      instruction_skills: [],
    });
    expect(plan).toMatchObject({
      schema_version: 'compiled-agent-plan/1',
      capability_closure_hash: value.closure.closure_hash,
      resolved_execution_plan_hash: value.resolved.plan_hash,
      model_catalog: [{ descriptor_id: 'model-primary' }],
      capability_catalog: [],
      instruction_skills: [],
      checkpoint_contract_version: 'agent-strategy-checkpoint/1',
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(verifyCompiledAgentPlan(plan, plan.plan_hash)).toEqual(plan);
  });

  it('rejects closure/admission drift, Strategy drift and unexpected Skill sources', () => {
    const value = fixture();
    const driftedPlan = structuredClone(value.resolved);
    driftedPlan.capability_closure_hash = hashA;
    driftedPlan.plan_hash = canonicalSha256ExcludingRootKeys(driftedPlan, ['plan_hash']);
    expect(() =>
      prepareCompiledAgentPlan({
        executable_source: value.executableSource,
        closure: value.closure,
        resolved_execution_plan: driftedPlan,
        expected_resolved_execution_plan_hash: driftedPlan.plan_hash,
        strategy_source: value.strategySource,
        instruction_skills: [],
      }),
    ).toThrow('AgentPlan inputs do not bind');

    const driftedStrategy = structuredClone(value.strategySource);
    driftedStrategy.document.max_iterations += 1;
    expect(() =>
      prepareCompiledAgentPlan({
        executable_source: value.executableSource,
        closure: value.closure,
        resolved_execution_plan: value.resolved,
        expected_resolved_execution_plan_hash: value.resolved.plan_hash,
        strategy_source: driftedStrategy,
        instruction_skills: [],
      }),
    ).toThrow();

    expect(() =>
      prepareCompiledAgentPlan({
        executable_source: value.executableSource,
        closure: value.closure,
        resolved_execution_plan: value.resolved,
        expected_resolved_execution_plan_hash: value.resolved.plan_hash,
        strategy_source: value.strategySource,
        instruction_skills: [{ binding_id: 'extra', source: {}, trusted_signers: {} }],
      }),
    ).toThrow('unexpected Skill source input');
  });

  it('rejects a tampered compiled plan hash', () => {
    const value = fixture();
    const plan = prepareCompiledAgentPlan({
      executable_source: value.executableSource,
      closure: value.closure,
      resolved_execution_plan: value.resolved,
      expected_resolved_execution_plan_hash: value.resolved.plan_hash,
      strategy_source: value.strategySource,
      instruction_skills: [],
    });
    const tampered = { ...plan, role_context_hash: hashA };
    expect(() => verifyCompiledAgentPlan(tampered, plan.plan_hash)).toThrow(
      'RELEASE_HASH_MISMATCH',
    );
  });

  it('resolves Strategy IDs and public handles only to the enabled root closure path', () => {
    const value = fixture(true);
    const plan = prepareCompiledAgentPlan({
      executable_source: value.executableSource,
      closure: value.closure,
      resolved_execution_plan: value.resolved,
      expected_resolved_execution_plan_hash: value.resolved.plan_hash,
      strategy_source: value.strategySource,
      instruction_skills: [],
    });
    expect(plan.capability_catalog).toHaveLength(1);
    expect(plan.capability_catalog[0]).toMatchObject({
      local_binding_id: 'database',
      binding_path: value.closure.bindings[0]?.binding_path,
    });
    expect(plan.public_capability_handles).toEqual([
      expect.objectContaining({
        public_handle: 'database-shortcut',
        binding_path: value.closure.bindings[0]?.binding_path,
        enabled: true,
      }),
    ]);
  });
});
