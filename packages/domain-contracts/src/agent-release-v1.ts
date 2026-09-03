import { z } from 'zod';

import {
  addCustomIssue,
  ContractHashSchema,
  hasUniqueBy,
  hasUniqueStrings,
  JsonObjectSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveMillisecondsSchema,
} from './primitives.js';

export const BindingKindV1Schema = z.enum([
  'knowledge',
  'database',
  'flow',
  'plugin',
  'skill_pack',
  'subagent',
]);

export const PublishedResourceKindV1Schema = z.enum([
  'AGENT_RELEASE',
  'FLOW_VERSION',
  'SYSTEM_RELEASE',
  'KNOWLEDGE_INDEX_GENERATION',
  'DATABASE_OPERATION_RELEASE',
  'PLUGIN_TOOL_RELEASE',
  'SKILL_PACK_RELEASE',
  'A2A_AGENT_RELEASE',
  'INSTRUCTION_SKILL_RELEASE',
  'AGENT_STRATEGY_RELEASE',
  'EXPERIENCE_RELEASE',
  'DEPLOYMENT_REVISION',
]);

const publishedResourcePinShape = {
  workspace_id: NonEmptyStringSchema,
  published_resource_kind: PublishedResourceKindV1Schema,
  resource_id: NonEmptyStringSchema,
  resource_version_id: NonEmptyStringSchema,
  contract_hash: ContractHashSchema,
  binding_mode: z.literal('pinned'),
};

export const PublishedResourcePinV1Schema = z.strictObject(publishedResourcePinShape);

export const AgentReleasePinV1Schema = PublishedResourcePinV1Schema.extend({
  published_resource_kind: z.literal('AGENT_RELEASE'),
});

export const FlowVersionPinV1Schema = PublishedResourcePinV1Schema.extend({
  published_resource_kind: z.literal('FLOW_VERSION'),
});

export const SkillPackReleasePinV1Schema = PublishedResourcePinV1Schema.extend({
  published_resource_kind: z.literal('SKILL_PACK_RELEASE'),
});

export const InstructionSkillReleasePinV1Schema = PublishedResourcePinV1Schema.extend({
  published_resource_kind: z.literal('INSTRUCTION_SKILL_RELEASE'),
});

export const SideEffectPolicyV1Schema = z.union([
  z.strictObject({
    class: z.enum(['safe', 'requires_key', 'unsafe']),
    approval: z.literal('none'),
    operation_key_source: z.enum(['request', 'generated']).optional(),
    compensation_contract_hash: ContractHashSchema.optional(),
  }),
  z.strictObject({
    class: z.enum(['safe', 'requires_key', 'unsafe']),
    approval: z.literal('required'),
    approval_gate_spec_id: NonEmptyStringSchema,
    operation_key_source: z.enum(['request', 'generated']).optional(),
    compensation_contract_hash: ContractHashSchema.optional(),
  }),
]);

const gateSpecBaseShape = {
  schema_version: z.literal('agent-human-gate/1'),
  gate_spec_id: NonEmptyStringSchema,
  prompt_template_ref: NonEmptyStringSchema,
  prompt_template_hash: ContractHashSchema,
  decision_schema: JsonObjectSchema,
  decision_schema_hash: ContractHashSchema,
  approver_policy_ref: NonEmptyStringSchema,
  approver_policy_hash: ContractHashSchema,
  expires_after_seconds: PositiveIntegerSchema,
  notification_profile_ref: NonEmptyStringSchema.optional(),
  notification_profile_hash: ContractHashSchema.optional(),
  on_reject: z.enum(['fail_run', 'cancel_run']),
  on_expire: z.enum(['fail_run', 'cancel_run']),
  gate_spec_hash: ContractHashSchema,
};

export const AgentGateSpecV1Schema = z
  .union([
    z.strictObject({
      ...gateSpecBaseShape,
      kind: z.literal('input'),
      protected_operation_contract_hashes: z.tuple([]),
    }),
    z.strictObject({
      ...gateSpecBaseShape,
      kind: z.literal('approval'),
      protected_operation_contract_hashes: z
        .array(ContractHashSchema)
        .min(1)
        .refine(hasUniqueStrings, 'operation contract hashes must be unique'),
    }),
  ])
  .superRefine((gate, ctx) => {
    if (
      (gate.notification_profile_ref === undefined) !==
      (gate.notification_profile_hash === undefined)
    ) {
      addCustomIssue(
        ctx,
        ['notification_profile_ref'],
        'notification profile ref and hash must be present or absent together',
      );
    }
  });

export const AgentStrategyPinV1Schema = z.strictObject({
  published_resource_kind: z.literal('AGENT_STRATEGY_RELEASE'),
  strategy_id: NonEmptyStringSchema,
  strategy_release_id: NonEmptyStringSchema,
  abi_version: z.literal('agent-strategy-abi/1'),
  implementation_digest: ContractHashSchema,
  config_hash: ContractHashSchema,
  input_schema_hash: ContractHashSchema,
  state_schema_hash: ContractHashSchema,
  decision_schema_hash: ContractHashSchema,
  observation_schema_hash: ContractHashSchema,
  sandbox_profile_id: NonEmptyStringSchema,
  allowed_model_policy_hash: ContractHashSchema,
  allowed_capability_binding_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed capability binding ids must be unique'),
  allowed_gate_spec_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed gate spec ids must be unique'),
  max_iterations: PositiveIntegerSchema,
  max_model_attempts: NonNegativeIntegerSchema,
  max_tool_calls: NonNegativeIntegerSchema,
  contract_hash: ContractHashSchema,
});

export const CredentialRequirementV1Schema = z.strictObject({
  schema_version: z.literal('credential-requirement/1'),
  requirement_id: NonEmptyStringSchema,
  provider_id: NonEmptyStringSchema,
  audience: NonEmptyStringSchema,
  required_scopes: z
    .array(NonEmptyStringSchema)
    .min(1)
    .refine(hasUniqueStrings, 'required scopes must be unique'),
  allowed_principal_modes: z
    .array(z.enum(['caller_delegated', 'service_principal', 'team_shared']))
    .min(1)
    .refine(hasUniqueStrings, 'allowed principal modes must be unique'),
});

export const G1JoinChildTerminalOutcomeMapV1Schema = z.strictObject({
  schema_version: z.literal('g1-join-child-terminal-map/1'),
  SUCCEEDED: z.literal('PARENT_CALL_SUCCEEDED_CONTINUE'),
  FAILED: z.literal('PARENT_CALL_FAILED_PARENT_FAILED'),
  CANCELLED: z.literal('PARENT_CALL_CANCELLED_PARENT_CANCELLED'),
  TIMED_OUT: z.literal('PARENT_CALL_FAILED_CHILD_TIMED_OUT_PARENT_FAILED'),
  NEEDS_ATTENTION: z.literal('PARENT_CALL_AND_RUN_NEEDS_ATTENTION'),
});

export const AsyncChildPolicyV1Schema = z.strictObject({
  schema_version: z.literal('async-child-policy/1'),
  invocation: z.literal('async'),
  completion_policy: z.literal('join'),
  cancel_propagation: z.literal('cascade'),
  result_projection: z.literal('safe_summary'),
  parent_terminal_policy: z.literal('wait_for_settlement'),
  terminal_outcome_map: G1JoinChildTerminalOutcomeMapV1Schema,
});

export const ForcedExecutionV1Schema = z
  .strictObject({
    order: NonNegativeIntegerSchema,
    output_injection: z.enum(['before_role_context', 'before_current_user_input']),
    on_empty: z.enum(['fail_closed', 'continue_without_context', 'ask_user']),
    on_timeout: z.enum(['fail_closed', 'continue_without_context', 'ask_user']),
    on_authorization_denied: z.literal('fail_closed'),
    on_empty_gate_spec: z
      .strictObject({ gate_spec_id: NonEmptyStringSchema, gate_spec_hash: ContractHashSchema })
      .optional(),
    on_timeout_gate_spec: z
      .strictObject({ gate_spec_id: NonEmptyStringSchema, gate_spec_hash: ContractHashSchema })
      .optional(),
  })
  .superRefine((call, ctx) => {
    for (const branch of ['on_empty', 'on_timeout'] as const) {
      if ((call[branch] === 'ask_user') !== (call[`${branch}_gate_spec`] !== undefined))
        addCustomIssue(
          ctx,
          [`${branch}_gate_spec`],
          'ask_user requires an exact GateSpec pin; other dispositions forbid it',
        );
    }
  });

export const KnowledgeBindingConfigV1Schema = z.union([
  z.strictObject({
    schema_version: z.literal('knowledge-binding/1'),
    selection: z.literal('on_demand'),
    query_contract_hash: ContractHashSchema,
    metadata_filter_policy_hash: ContractHashSchema,
  }),
  z.strictObject({
    schema_version: z.literal('knowledge-binding/1'),
    selection: z.literal('force'),
    query_contract_hash: ContractHashSchema,
    metadata_filter_policy_hash: ContractHashSchema,
    forced_execution: ForcedExecutionV1Schema,
  }),
]);

export const DatabaseBindingConfigV1Schema = z.strictObject({
  schema_version: z.literal('database-binding/1'),
  operation_contract_hash: ContractHashSchema,
  table_revision_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'table revision ids must be unique'),
  allowed_tables: z.array(JsonObjectSchema),
  row_filter_template: JsonObjectSchema.optional(),
  max_rows: PositiveIntegerSchema,
  transaction_mode: z.enum(['read_only', 'single_write']),
  approval: z.enum(['none', 'required']),
  idempotency_requirement: z.enum(['none', 'operation_key_required']),
});

export const FlowBindingConfigV1Schema = z.union([
  z.strictObject({
    schema_version: z.literal('flow-binding/1'),
    invocation: z.literal('sync'),
  }),
  z.strictObject({
    schema_version: z.literal('flow-binding/1'),
    invocation: z.literal('async'),
    async_child: AsyncChildPolicyV1Schema,
  }),
]);

export const PluginBindingConfigV1Schema = z.strictObject({
  schema_version: z.literal('plugin-binding/1'),
  operation_contract_hash: ContractHashSchema,
  provider_tool_name: NonEmptyStringSchema,
  transport_contract_hash: ContractHashSchema,
  default_parameters: JsonObjectSchema,
});

export const SkillPackBindingConfigV1Schema = z.strictObject({
  schema_version: z.literal('skill-pack-binding/1'),
  exposed_operations: z
    .array(
      z.strictObject({
        exposed_operation_id: NonEmptyStringSchema,
        exposed_operation_contract_hash: ContractHashSchema,
      }),
    )
    .refine(
      (operations) => hasUniqueBy(operations, (operation) => operation.exposed_operation_id),
      'exposed operation ids must be unique',
    ),
  member_projection_hash: ContractHashSchema,
});

const serializerPinSchema = z.strictObject({
  serializer_id: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  implementation_digest: ContractHashSchema,
});

const tokenizerPinSchema = z.strictObject({
  tokenizer_id: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  vocabulary_hash: ContractHashSchema,
  implementation_digest: ContractHashSchema,
});

const truncationPolicySchema = z.strictObject({
  algorithm: z.enum(['newest_complete_turns', 'oldest_complete_turns']),
  tie_breaker: z.literal('message_sequence_then_id'),
  preserve_current_user_message: z.boolean(),
  policy_hash: ContractHashSchema,
});

const summaryPolicySchema = z.strictObject({
  model_pin: JsonObjectSchema,
  prompt_template_pin: z.strictObject({
    prompt_template_id: NonEmptyStringSchema,
    prompt_template_version: NonEmptyStringSchema,
    content_hash: ContractHashSchema,
  }),
  output_schema_hash: ContractHashSchema,
  max_attempts: PositiveIntegerSchema,
});

const subagentContextProjectionBaseShape = {
  schema_version: z.literal('subagent-context-projection/1'),
  allowed_message_kinds: z
    .array(z.enum(['user', 'assistant']))
    .refine(hasUniqueStrings, 'allowed message kinds must be unique'),
  allowed_field_paths: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed field paths must be unique'),
  max_data_classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  redaction_policy_id: NonEmptyStringSchema,
  max_turns: NonNegativeIntegerSchema,
  max_tokens: NonNegativeIntegerSchema,
  serializer_pin: serializerPinSchema,
  tokenizer_pin: tokenizerPinSchema,
  truncation_policy: truncationPolicySchema,
  projection_contract_hash: ContractHashSchema,
};

export const SubagentContextProjectionV1Schema = z.union([
  z.strictObject({
    ...subagentContextProjectionBaseShape,
    mode: z.literal('eligible_history'),
  }),
  z.strictObject({
    ...subagentContextProjectionBaseShape,
    mode: z.literal('user_question_only'),
  }),
  z.strictObject({
    ...subagentContextProjectionBaseShape,
    mode: z.literal('summary'),
    summary_policy: summaryPolicySchema,
  }),
]);

export const BoundedDelegationPolicyV1Schema = z.strictObject({
  target_capability_binding_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'target capability binding ids must be unique'),
  allowed_audiences: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed audiences must be unique'),
  allowed_scopes: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed scopes must be unique'),
  allowed_resource_pins: z.array(PublishedResourcePinV1Schema),
  allowed_egress: z.array(JsonObjectSchema),
  max_data_classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  max_side_effect_class: z.enum(['safe', 'requires_key', 'unsafe']),
  allowed_operation_contract_hashes: z
    .array(ContractHashSchema)
    .refine(hasUniqueStrings, 'allowed operation contract hashes must be unique'),
  allowed_credential_modes: z
    .array(z.enum(['caller_delegated', 'service_principal', 'team_shared']))
    .refine(hasUniqueStrings, 'allowed credential modes must be unique'),
  max_ttl_seconds: PositiveIntegerSchema,
  max_calls: NonNegativeIntegerSchema,
  max_depth: NonNegativeIntegerSchema,
  max_budget: JsonObjectSchema,
});

const authorizationDelegationSchema = z.union([
  z.strictObject({ mode: z.literal('recheck_target_policy') }),
  z.strictObject({
    mode: z.literal('bounded_delegation'),
    policy: BoundedDelegationPolicyV1Schema,
  }),
]);

const subagentBindingConfigBaseShape = {
  schema_version: z.literal('subagent-binding/1'),
  routing_priority_weight: z.number().int().min(0).max(100),
  context_projection: SubagentContextProjectionV1Schema,
  input_allowlist: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'input allowlist paths must be unique'),
  max_depth: NonNegativeIntegerSchema,
  max_calls: NonNegativeIntegerSchema,
  budget_share: JsonObjectSchema,
  authorization_delegation: authorizationDelegationSchema,
};

export const SubagentBindingConfigV1Schema = z.union([
  z.strictObject({ ...subagentBindingConfigBaseShape, invocation: z.literal('sync') }),
  z.strictObject({
    ...subagentBindingConfigBaseShape,
    invocation: z.literal('async'),
    async_child: AsyncChildPolicyV1Schema,
  }),
]);

const manualSchema = z.strictObject({
  description: NonEmptyStringSchema,
  input_description: NonEmptyStringSchema.optional(),
  hash: ContractHashSchema,
});

const capabilityBindingBaseShape = {
  binding_id: NonEmptyStringSchema,
  enabled: z.boolean(),
  discoverability: z.enum(['model_selectable', 'forced', 'hidden']),
  manual: manualSchema,
  input_schema: JsonObjectSchema,
  output_schema: JsonObjectSchema.optional(),
  input_interaction_mode: z.enum(['auto', 'form']).optional(),
  output_handling_mode: z.enum(['model_summarize', 'raw', 'structured']).optional(),
  data_classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  side_effect: SideEffectPolicyV1Schema,
  task_safe: z.boolean(),
  mock_safe: z.boolean(),
  retry: JsonObjectSchema,
  timeout_ms: PositiveMillisecondsSchema,
  budget: JsonObjectSchema,
  credential_requirement: CredentialRequirementV1Schema.optional(),
};

const knowledgeBindingSchema = z.strictObject({
  ...capabilityBindingBaseShape,
  kind: z.literal('knowledge'),
  pin: PublishedResourcePinV1Schema.extend({
    published_resource_kind: z.literal('KNOWLEDGE_INDEX_GENERATION'),
  }),
  config: KnowledgeBindingConfigV1Schema,
});

const databaseBindingSchema = z.strictObject({
  ...capabilityBindingBaseShape,
  kind: z.literal('database'),
  pin: PublishedResourcePinV1Schema.extend({
    published_resource_kind: z.literal('DATABASE_OPERATION_RELEASE'),
  }),
  config: DatabaseBindingConfigV1Schema,
});

const flowBindingSchema = z.strictObject({
  ...capabilityBindingBaseShape,
  kind: z.literal('flow'),
  pin: FlowVersionPinV1Schema,
  config: FlowBindingConfigV1Schema,
});

const pluginBindingSchema = z.strictObject({
  ...capabilityBindingBaseShape,
  kind: z.literal('plugin'),
  pin: PublishedResourcePinV1Schema.extend({
    published_resource_kind: z.literal('PLUGIN_TOOL_RELEASE'),
  }),
  config: PluginBindingConfigV1Schema,
});

const skillPackBindingSchema = z.strictObject({
  ...capabilityBindingBaseShape,
  kind: z.literal('skill_pack'),
  pin: SkillPackReleasePinV1Schema,
  config: SkillPackBindingConfigV1Schema,
});

const internalSubagentBindingSchema = z.strictObject({
  ...capabilityBindingBaseShape,
  kind: z.literal('subagent'),
  target_kind: z.literal('internal_agent'),
  pin: AgentReleasePinV1Schema,
  config: SubagentBindingConfigV1Schema,
});

const externalSubagentBindingSchema = z.strictObject({
  ...capabilityBindingBaseShape,
  kind: z.literal('subagent'),
  target_kind: z.literal('external_a2a'),
  pin: PublishedResourcePinV1Schema.extend({
    published_resource_kind: z.literal('A2A_AGENT_RELEASE'),
  }),
  config: SubagentBindingConfigV1Schema,
});

export const CapabilityBindingV1Schema = z
  .union([
    knowledgeBindingSchema,
    databaseBindingSchema,
    flowBindingSchema,
    pluginBindingSchema,
    skillPackBindingSchema,
    internalSubagentBindingSchema,
    externalSubagentBindingSchema,
  ])
  .superRefine((binding, ctx) => {
    if (binding.kind === 'knowledge') {
      const forced = binding.config.selection === 'force';
      if (forced !== (binding.discoverability === 'forced')) {
        addCustomIssue(
          ctx,
          ['discoverability'],
          'forced knowledge selection and discoverability must agree',
        );
      }
    }

    if (binding.task_safe && binding.kind !== 'flow' && binding.kind !== 'plugin') {
      addCustomIssue(ctx, ['task_safe'], 'only flow and plugin bindings can be task-safe');
    }

    if (
      binding.mock_safe &&
      (binding.kind === 'database' || binding.side_effect.class !== 'safe')
    ) {
      addCustomIssue(
        ctx,
        ['mock_safe'],
        'mock-safe bindings must be non-database and side-effect safe',
      );
    }

    if (binding.kind === 'database' && binding.config.approval !== binding.side_effect.approval) {
      addCustomIssue(
        ctx,
        ['config', 'approval'],
        'database config approval must match the binding side-effect policy',
      );
    }
  });

export const PublicCapabilityHandleV1Schema = z.strictObject({
  schema_version: z.literal('public-capability-handle/1'),
  public_handle: NonEmptyStringSchema,
  binding_id: NonEmptyStringSchema,
  operation_contract_hash: ContractHashSchema,
  input_schema_hash: ContractHashSchema,
  allowed_entry_modes: z.array(z.literal('experience_shortcut')).min(1).max(1),
});

export const InstructionSkillBindingV1Schema = z.strictObject({
  binding_id: NonEmptyStringSchema,
  skill_pin: InstructionSkillReleasePinV1Schema,
  content_hash: ContractHashSchema,
  activation: z.enum(['always', 'model_selected', 'explicit']),
  allowed_capability_binding_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'allowed capability binding ids must be unique'),
  context_budget_tokens: NonNegativeIntegerSchema,
  priority: NonNegativeIntegerSchema,
  script_mode: z.literal('inert'),
});

const AgentExecutableBodySchema = z.strictObject({
  agent_id: NonEmptyStringSchema,
  agent_release_id: NonEmptyStringSchema,
  release_number: PositiveIntegerSchema,
  source_draft_revision_id: NonEmptyStringSchema,
  role: JsonObjectSchema,
  input_contract: JsonObjectSchema,
  output_contract: JsonObjectSchema.optional(),
  model_policy: JsonObjectSchema,
  strategy: AgentStrategyPinV1Schema,
  gate_specs: z.array(AgentGateSpecV1Schema),
  instruction_skill_bindings: z.array(InstructionSkillBindingV1Schema),
  capability_bindings: z.array(CapabilityBindingV1Schema),
  public_capability_handles: z.array(PublicCapabilityHandleV1Schema),
  task_templates: z.array(JsonObjectSchema),
  authorization_policy: JsonObjectSchema,
  runtime_limits: JsonObjectSchema,
});

function validateAgentExecutableBody(
  release: z.infer<typeof AgentExecutableBodySchema>,
  ctx: z.RefinementCtx,
): void {
  if (!hasUniqueBy(release.gate_specs, (gate) => gate.gate_spec_id)) {
    addCustomIssue(ctx, ['gate_specs'], 'gate spec ids must be unique within a release');
  }
  if (!hasUniqueBy(release.capability_bindings, (binding) => binding.binding_id)) {
    addCustomIssue(
      ctx,
      ['capability_bindings'],
      'capability binding ids must be unique within a release',
    );
  }
  const credentialRequirementIds = release.capability_bindings.flatMap((binding) =>
    binding.credential_requirement === undefined
      ? []
      : [binding.credential_requirement.requirement_id],
  );
  if (!hasUniqueStrings(credentialRequirementIds)) {
    addCustomIssue(
      ctx,
      ['capability_bindings'],
      'credential requirement ids must be unique across capability bindings',
    );
  }
  if (!hasUniqueBy(release.instruction_skill_bindings, (binding) => binding.binding_id)) {
    addCustomIssue(
      ctx,
      ['instruction_skill_bindings'],
      'instruction skill binding ids must be unique within a release',
    );
  }
  if (!hasUniqueBy(release.public_capability_handles, (handle) => handle.public_handle)) {
    addCustomIssue(
      ctx,
      ['public_capability_handles'],
      'public capability handles must be unique within a release',
    );
  }

  const gateIds = new Set(release.gate_specs.map((gate) => gate.gate_spec_id));
  for (const gateId of release.strategy.allowed_gate_spec_ids) {
    if (!gateIds.has(gateId)) {
      addCustomIssue(
        ctx,
        ['strategy', 'allowed_gate_spec_ids'],
        `strategy references unknown gate spec ${gateId}`,
      );
    }
  }

  const capabilityIds = new Set(release.capability_bindings.map((binding) => binding.binding_id));
  for (const bindingId of release.strategy.allowed_capability_binding_ids) {
    if (!capabilityIds.has(bindingId)) {
      addCustomIssue(
        ctx,
        ['strategy', 'allowed_capability_binding_ids'],
        `strategy references unknown capability binding ${bindingId}`,
      );
    }
  }
  for (const skill of release.instruction_skill_bindings) {
    for (const bindingId of skill.allowed_capability_binding_ids) {
      if (!capabilityIds.has(bindingId)) {
        addCustomIssue(
          ctx,
          ['instruction_skill_bindings'],
          `instruction skill references unknown capability binding ${bindingId}`,
        );
      }
    }
  }
  for (const handle of release.public_capability_handles) {
    if (!capabilityIds.has(handle.binding_id)) {
      addCustomIssue(
        ctx,
        ['public_capability_handles'],
        `public handle references unknown capability binding ${handle.binding_id}`,
      );
    }
  }

  const approvalGates = new Set(
    release.gate_specs.filter((gate) => gate.kind === 'approval').map((gate) => gate.gate_spec_id),
  );
  for (const binding of release.capability_bindings) {
    if (binding.kind === 'knowledge' && binding.config.selection === 'force') {
      for (const branch of ['on_empty_gate_spec', 'on_timeout_gate_spec'] as const) {
        const pin = binding.config.forced_execution[branch];
        if (
          pin !== undefined &&
          !release.gate_specs.some(
            (gate) =>
              gate.kind === 'input' &&
              gate.gate_spec_id === pin.gate_spec_id &&
              gate.gate_spec_hash === pin.gate_spec_hash,
          )
        )
          addCustomIssue(
            ctx,
            ['capability_bindings'],
            'forced ask_user branch requires an exact same-release input GateSpec',
          );
      }
    }
    if (
      binding.side_effect.approval === 'required' &&
      !approvalGates.has(binding.side_effect.approval_gate_spec_id)
    ) {
      addCustomIssue(
        ctx,
        ['capability_bindings'],
        `binding ${binding.binding_id} references a missing or non-approval gate`,
      );
    }
  }

  const forcedOrders = release.capability_bindings
    .filter((binding) => binding.kind === 'knowledge' && binding.config.selection === 'force')
    .map((binding) =>
      binding.kind === 'knowledge' && binding.config.selection === 'force'
        ? binding.config.forced_execution.order.toString()
        : '',
    );
  if (!hasUniqueStrings(forcedOrders)) {
    addCustomIssue(
      ctx,
      ['capability_bindings'],
      'forced knowledge execution order must be unique within a release',
    );
  }
}

export const AgentExecutableSourceV1Schema = AgentExecutableBodySchema.extend({
  schema_version: z.literal('agent-executable-source/1'),
}).superRefine(validateAgentExecutableBody);

export const AgentReleaseV1Schema = AgentExecutableBodySchema.extend({
  schema_version: z.literal('agent-release/1'),
  capability_closure_hash: ContractHashSchema,
  compiled_hash: ContractHashSchema,
}).superRefine(validateAgentExecutableBody);

export type BindingKindV1 = z.infer<typeof BindingKindV1Schema>;
export type PublishedResourceKindV1 = z.infer<typeof PublishedResourceKindV1Schema>;
export type PublishedResourcePinV1 = z.infer<typeof PublishedResourcePinV1Schema>;
export type AgentStrategyPinV1 = z.infer<typeof AgentStrategyPinV1Schema>;
export type CredentialRequirementV1 = z.infer<typeof CredentialRequirementV1Schema>;
export type CapabilityBindingV1 = z.infer<typeof CapabilityBindingV1Schema>;
export type AgentReleaseV1 = z.infer<typeof AgentReleaseV1Schema>;
export type AgentExecutableSourceV1 = z.infer<typeof AgentExecutableSourceV1Schema>;
