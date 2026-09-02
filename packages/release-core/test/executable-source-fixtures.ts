import {
  AgentExecutableSourceV1Schema,
  type FlowGraphV1,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';
import {
  agentReleaseId,
  flowId,
  flowVersionId,
  hashA,
  hashB,
  makeAgentRelease,
  makeFlowIr,
  makePluginPin,
} from './fixtures.js';

export function richAgentSource() {
  const {
    compiled_hash: _compiled,
    capability_closure_hash: _closure,
    ...source
  } = makeAgentRelease();
  const { credential_requirement: _credential, ...binding } = source.capability_bindings[0];
  const common = { ...binding, task_safe: false, mock_safe: false };
  const target = (
    kind: PublishedResourcePinV1['published_resource_kind'],
  ): PublishedResourcePinV1 => ({ ...makePluginPin(), published_resource_kind: kind });
  const child = {
    schema_version: 'async-child-policy/1',
    invocation: 'async',
    completion_policy: 'join',
    cancel_propagation: 'cascade',
    result_projection: 'safe_summary',
    parent_terminal_policy: 'wait_for_settlement',
    terminal_outcome_map: {
      schema_version: 'g1-join-child-terminal-map/1',
      SUCCEEDED: 'PARENT_CALL_SUCCEEDED_CONTINUE',
      FAILED: 'PARENT_CALL_FAILED_PARENT_FAILED',
      CANCELLED: 'PARENT_CALL_CANCELLED_PARENT_CANCELLED',
      TIMED_OUT: 'PARENT_CALL_FAILED_CHILD_TIMED_OUT_PARENT_FAILED',
      NEEDS_ATTENTION: 'PARENT_CALL_AND_RUN_NEEDS_ATTENTION',
    },
  };
  const capabilities = [
    { ...common, binding_id: 'plugin' },
    {
      ...common,
      binding_id: 'knowledge',
      kind: 'knowledge',
      discoverability: 'forced',
      pin: target('KNOWLEDGE_INDEX_GENERATION'),
      config: {
        schema_version: 'knowledge-binding/1',
        selection: 'force',
        query_contract_hash: hashA,
        metadata_filter_policy_hash: hashB,
        forced_execution: {
          order: 0,
          output_injection: 'before_role_context',
          on_empty: 'ask_user',
          on_timeout: 'fail_closed',
          on_authorization_denied: 'fail_closed',
        },
      },
    },
    {
      ...common,
      binding_id: 'database',
      kind: 'database',
      pin: target('DATABASE_OPERATION_RELEASE'),
      config: {
        schema_version: 'database-binding/1',
        operation_contract_hash: hashA,
        table_revision_ids: [flowVersionId, agentReleaseId],
        allowed_tables: [{ table: 'z' }, { table: 'a' }],
        max_rows: 10,
        transaction_mode: 'read_only',
        approval: 'none',
        idempotency_requirement: 'none',
      },
    },
    {
      ...common,
      binding_id: 'flow',
      kind: 'flow',
      pin: target('FLOW_VERSION'),
      config: { schema_version: 'flow-binding/1', invocation: 'async', async_child: child },
    },
    {
      ...common,
      binding_id: 'pack',
      kind: 'skill_pack',
      pin: target('SKILL_PACK_RELEASE'),
      config: {
        schema_version: 'skill-pack-binding/1',
        member_projection_hash: hashA,
        exposed_operations: [
          { exposed_operation_id: 'z', exposed_operation_contract_hash: hashA },
          { exposed_operation_id: 'a', exposed_operation_contract_hash: hashB },
        ],
      },
    },
    {
      ...common,
      binding_id: 'subagent',
      kind: 'subagent',
      target_kind: 'internal_agent',
      pin: target('AGENT_RELEASE'),
      config: {
        schema_version: 'subagent-binding/1',
        routing_priority_weight: 50,
        invocation: 'async',
        async_child: child,
        input_allowlist: ['z', 'a'],
        max_depth: 3,
        max_calls: 5,
        budget_share: {},
        context_projection: {
          schema_version: 'subagent-context-projection/1',
          mode: 'summary',
          allowed_message_kinds: ['assistant', 'user'],
          allowed_field_paths: ['z', 'a'],
          max_data_classification: 'internal',
          redaction_policy_id: 'redaction',
          max_turns: 3,
          max_tokens: 200,
          serializer_pin: { serializer_id: 'json', version: '1', implementation_digest: hashA },
          tokenizer_pin: {
            tokenizer_id: 'tokens',
            version: '1',
            vocabulary_hash: hashA,
            implementation_digest: hashB,
          },
          truncation_policy: {
            algorithm: 'newest_complete_turns',
            tie_breaker: 'message_sequence_then_id',
            preserve_current_user_message: true,
            policy_hash: hashA,
          },
          projection_contract_hash: hashA,
          summary_policy: {
            model_pin: {},
            prompt_template_pin: {
              prompt_template_id: 'prompt',
              prompt_template_version: '1',
              content_hash: hashA,
            },
            output_schema_hash: hashB,
            max_attempts: 2,
          },
        },
        authorization_delegation: {
          mode: 'bounded_delegation',
          policy: {
            target_capability_binding_ids: ['z', 'a'],
            allowed_audiences: ['z', 'a'],
            allowed_scopes: ['z', 'a'],
            allowed_resource_pins: [target('PLUGIN_TOOL_RELEASE'), target('FLOW_VERSION')],
            allowed_egress: [],
            max_data_classification: 'internal',
            max_side_effect_class: 'safe',
            allowed_operation_contract_hashes: [hashB, hashA],
            allowed_credential_modes: ['team_shared', 'service_principal'],
            max_ttl_seconds: 30,
            max_calls: 5,
            max_depth: 2,
            max_budget: {},
          },
        },
      },
    },
  ];
  const gate = {
    schema_version: 'agent-human-gate/1',
    gate_spec_id: 'approval',
    kind: 'approval',
    prompt_template_ref: 'prompt',
    prompt_template_hash: hashA,
    decision_schema: { type: 'object' },
    decision_schema_hash: hashA,
    approver_policy_ref: 'policy',
    approver_policy_hash: hashB,
    expires_after_seconds: 30,
    on_reject: 'fail_run',
    on_expire: 'cancel_run',
    gate_spec_hash: hashA,
    protected_operation_contract_hashes: [hashB, hashA],
  };
  return AgentExecutableSourceV1Schema.parse({
    ...source,
    schema_version: 'agent-executable-source/1',
    capability_bindings: capabilities,
    strategy: {
      ...source.strategy,
      allowed_capability_binding_ids: capabilities.map((item) => item.binding_id),
      allowed_gate_spec_ids: ['input', 'approval'],
    },
    gate_specs: [
      gate,
      { ...gate, gate_spec_id: 'input', kind: 'input', protected_operation_contract_hashes: [] },
    ],
    instruction_skill_bindings: [
      {
        binding_id: 'instruction',
        skill_pin: target('INSTRUCTION_SKILL_RELEASE'),
        content_hash: hashB,
        activation: 'always',
        allowed_capability_binding_ids: ['subagent', 'plugin'],
        context_budget_tokens: 50,
        priority: 1,
        script_mode: 'inert',
      },
    ],
    public_capability_handles: [{ ...source.public_capability_handles[0], binding_id: 'plugin' }],
  });
}

export function nestedFlowSource() {
  const flow = makeFlowIr();
  const target = {
    ...makePluginPin(),
    published_resource_kind: 'FLOW_VERSION',
    resource_id: flowId,
    resource_version_id: agentReleaseId,
  };
  const graph = (id: string): FlowGraphV1 => ({
    graph_id: id,
    entry_node_id: 'prelude',
    exit_node_ids: ['leaf'],
    edges: [
      {
        edge_id: 'one',
        kind: 'control',
        from: { node_id: 'prelude', port: 'next' },
        to: { node_id: 'middle', port: 'in' },
      },
      {
        edge_id: 'two',
        kind: 'control',
        from: { node_id: 'middle', port: 'next' },
        to: { node_id: 'leaf', port: 'in' },
      },
    ],
    nodes: [
      {
        node_id: 'prelude',
        key: 'prelude',
        type: 'text',
        config: {},
        inputs: {},
        output_schema: {},
      },
      { node_id: 'middle', key: 'middle', type: 'text', config: {}, inputs: {}, output_schema: {} },
      {
        node_id: 'leaf',
        key: 'leaf',
        type: 'subflow',
        inputs: {},
        output_schema: {},
        config: {
          target: { flow_id: target.resource_id, flow_version_id: target.resource_version_id },
          invocation: 'sync',
          inputs: {},
          output_mapping: {},
        },
      },
    ],
  });
  return {
    ...flow,
    resources: [target],
    entry_graph: {
      ...flow.entry_graph,
      nodes: [
        flow.entry_graph.nodes[0],
        {
          ...flow.entry_graph.nodes[1],
          type: 'branch',
          config: {
            expression_language: 'js-expression-v1',
            cases: [
              { case_id: 'z', when: 'true', graph: graph('z'), exports: {} },
              { case_id: 'a', when: 'false', graph: graph('a'), exports: {} },
            ],
            else_case: {
              graph: {
                graph_id: 'loop-graph',
                entry_node_id: 'loop',
                exit_node_ids: ['loop'],
                edges: [],
                nodes: [
                  {
                    node_id: 'loop',
                    key: 'loop',
                    type: 'loop',
                    inputs: {},
                    output_schema: {},
                    config: {
                      mode: 'condition',
                      max_iterations: 3,
                      continue_when: 'true',
                      exports: {},
                      body: graph('body'),
                    },
                  },
                ],
              },
              exports: {},
            },
          },
        },
      ],
    },
  };
}
