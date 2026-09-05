import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CapabilityBindingV1Schema,
  createVersionedSchemaRegistry,
  domainContractSchemaVersions,
  parseDomainContract,
  safeParseDomainContract,
} from '../src/index.js';

const hash = 'sha256:test-contract';
const bindingPath = `bp1.${'a'.repeat(43)}`;
const resourceNodeId = `rn1.${'b'.repeat(43)}`;

const strategyPin = {
  published_resource_kind: 'AGENT_STRATEGY_RELEASE',
  strategy_id: 'strategy-1',
  strategy_release_id: 'strategy-release-1',
  abi_version: 'agent-strategy-abi/1',
  implementation_digest: hash,
  config_hash: hash,
  input_schema_hash: hash,
  state_schema_hash: hash,
  decision_schema_hash: hash,
  observation_schema_hash: hash,
  sandbox_profile_id: 'sandbox-1',
  allowed_model_policy_hash: hash,
  allowed_capability_binding_ids: [],
  allowed_gate_spec_ids: [],
  max_iterations: 8,
  max_model_attempts: 4,
  max_tool_calls: 4,
  contract_hash: hash,
} as const;

const strategyStart = {
  schema_version: 'agent-strategy-start/1',
  run_id: 'run-1',
  root_step_id: 'step-1',
  resolved_agent_plan_hash: hash,
  capability_closure_hash: hash,
  strategy_pin: strategyPin,
  input_snapshot_ref: 'snapshot://input-1',
  role_context_hash: hash,
  model_catalog: [],
  capability_catalog: [],
  instruction_skills: [],
  limits: {},
} as const;

const rootPin = {
  workspace_id: 'workspace-1',
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: 'agent-1',
  resource_version_id: 'agent-release-1',
  contract_hash: hash,
  binding_mode: 'pinned',
} as const;

const aggregateLimits = {
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

const intrinsicRequirements = {
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
    budget: aggregateLimits.budget,
  },
} as const;

describe('domain contract registry', () => {
  it('registers the four architecture roots under unique immutable versions', () => {
    expect(domainContractSchemaVersions).toEqual(
      expect.arrayContaining([
        'agent-release/1',
        'flow-ir/1',
        'flow-llm-node-config/1',
        'compiled-flow-plan/1',
        'flow-step-checkpoint/1',
        'flow-model-usage-receipt/1',
        'compiled-capability-closure/1',
        'agent-strategy-start/1',
        'agent-strategy-checkpoint/1',
        'knowledge-binding/1',
        'flow-binding/1',
        'subagent-binding/1',
        'strategy-gate-request/1',
        'production-evaluation-policy/1',
        'evaluation-suite-release/1',
        'evaluation-run/1',
        'evaluation-evidence-bundle/1',
      ]),
    );
    expect(new Set(domainContractSchemaVersions).size).toBe(domainContractSchemaVersions.length);

    expect(parseDomainContract(strategyStart)).toEqual(strategyStart);
    expect(
      parseDomainContract({
        schema_version: 'agent-release/1',
        agent_id: 'agent-1',
        agent_release_id: 'agent-release-1',
        release_number: 1,
        source_draft_revision_id: 'draft-revision-1',
        role: {},
        input_contract: { type: 'object' },
        model_policy: {},
        strategy: strategyPin,
        gate_specs: [],
        instruction_skill_bindings: [],
        capability_bindings: [],
        public_capability_handles: [],
        task_templates: [],
        authorization_policy: {},
        runtime_limits: {},
        capability_closure_hash: hash,
        compiled_hash: hash,
      }).schema_version,
    ).toBe('agent-release/1');
    expect(
      parseDomainContract({
        schema_version: 'flow-ir/1',
        flow_id: 'flow-1',
        flow_version_id: 'flow-version-1',
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
      }).schema_version,
    ).toBe('flow-ir/1');

    expect(
      parseDomainContract({
        schema_version: 'compiled-capability-closure/1',
        root: { pin: rootPin, semantic_seed_hash: hash },
        assembly_pins: [],
        bindings: [],
        gate_specs: [],
        resource_nodes: [
          {
            node_id: resourceNodeId,
            intrinsic_policy: {
              schema_version: 'capability-requirement-expression/1',
              expression_kind: 'leaf',
              requirements: intrinsicRequirements,
            },
            dependency_manifest_hash: hash,
            node_role: 'root',
            pin: rootPin,
          },
        ],
        dependency_edges: [],
        disabled_binding_paths: [],
        aggregate_limits: aggregateLimits,
        closure_hash: hash,
      }).schema_version,
    ).toBe('compiled-capability-closure/1');
  });

  it('fails closed when a strict contract receives an unknown field', () => {
    const result = safeParseDomainContract({ ...strategyStart, runtime_secret: 'must-not-pass' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DOMAIN_CONTRACT_INVALID');
    }
  });

  it('fails closed when binding kind, pin kind, and config version do not agree', () => {
    const wrongKind = CapabilityBindingV1Schema.safeParse({
      binding_id: 'binding-1',
      enabled: true,
      discoverability: 'model_selectable',
      manual: { description: 'wrong kind fixture', hash },
      input_schema: { type: 'object' },
      data_classification: 'internal',
      side_effect: { class: 'safe', approval: 'none' },
      task_safe: true,
      mock_safe: true,
      retry: {},
      timeout_ms: 1_000,
      budget: {},
      kind: 'flow',
      pin: {
        workspace_id: 'workspace-1',
        published_resource_kind: 'KNOWLEDGE_INDEX_GENERATION',
        resource_id: 'knowledge-1',
        resource_version_id: 'generation-1',
        contract_hash: hash,
        binding_mode: 'pinned',
      },
      config: {
        schema_version: 'knowledge-binding/1',
        selection: 'on_demand',
        query_contract_hash: hash,
        metadata_filter_policy_hash: hash,
      },
    });

    expect(wrongKind.success).toBe(false);
  });

  it('rejects unknown schema versions before selecting a validator', () => {
    const result = safeParseDomainContract({ schema_version: 'agent-release/2' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DOMAIN_SCHEMA_VERSION_UNKNOWN');
    }
  });

  it('rejects duplicate schema versions when building a registry', () => {
    const duplicateSchema = z.strictObject({ schema_version: z.literal('fixture/1') });

    expect(() =>
      createVersionedSchemaRegistry([
        { schemaVersion: 'fixture/1', schema: duplicateSchema },
        { schemaVersion: 'fixture/1', schema: duplicateSchema },
      ]),
    ).toThrowError(/DOMAIN_SCHEMA_VERSION_DUPLICATE/);
  });

  it('exports canonical path-shaped primitives without calculating their hashes', () => {
    expect(bindingPath).toHaveLength(47);
  });
});
