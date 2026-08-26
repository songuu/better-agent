import { z } from 'zod';

import {
  BindingKindV1Schema,
  CredentialRequirementV1Schema,
  PublishedResourcePinV1Schema,
} from './agent-release-v1.js';
import {
  addCustomIssue,
  CanonicalBindingPathV1Schema,
  ClosureResourceNodeIdV1Schema,
  ContractHashSchema,
  hasUniqueBy,
  hasUniqueStrings,
  JsonObjectSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from './primitives.js';

export const ClosureRootPinV1Schema = z.strictObject({
  workspace_id: NonEmptyStringSchema,
  published_resource_kind: z.enum(['AGENT_RELEASE', 'FLOW_VERSION']),
  resource_id: NonEmptyStringSchema,
  resource_version_id: NonEmptyStringSchema,
  contract_hash: ContractHashSchema,
  binding_mode: z.literal('pinned'),
});

const FlowClosureRootPinV1Schema = ClosureRootPinV1Schema.extend({
  published_resource_kind: z.literal('FLOW_VERSION'),
});

export const ClosureRootV1Schema = z
  .strictObject({
    pin: ClosureRootPinV1Schema,
    semantic_seed_hash: ContractHashSchema,
  })
  .superRefine((root, ctx) => {
    if (root.pin.contract_hash !== root.semantic_seed_hash) {
      addCustomIssue(
        ctx,
        ['semantic_seed_hash'],
        'root pin contract hash must equal semantic seed hash',
      );
    }
  });

export const BindingOwnerIdentityV1Schema = z.union([
  z.strictObject({
    owner_kind: z.literal('root'),
    pin: ClosureRootPinV1Schema,
  }),
  z.strictObject({
    owner_kind: z.literal('published_dependency'),
    pin: PublishedResourcePinV1Schema.extend({
      published_resource_kind: z.enum(['AGENT_RELEASE', 'FLOW_VERSION', 'SKILL_PACK_RELEASE']),
    }),
  }),
]);

export const FlowOwnerIdentityV1Schema = z.union([
  z.strictObject({
    owner_kind: z.literal('root'),
    pin: FlowClosureRootPinV1Schema,
  }),
  z.strictObject({
    owner_kind: z.literal('published_dependency'),
    pin: PublishedResourcePinV1Schema.extend({
      published_resource_kind: z.literal('FLOW_VERSION'),
    }),
  }),
]);

export const BindingPathSegmentV1Schema = z.union([
  z.strictObject({
    segment_kind: z.literal('root'),
    pin: ClosureRootPinV1Schema,
  }),
  z.strictObject({
    segment_kind: z.literal('binding'),
    owner: BindingOwnerIdentityV1Schema,
    binding_kind: BindingKindV1Schema,
    local_binding_id: NonEmptyStringSchema,
  }),
  z.strictObject({
    segment_kind: z.literal('flow_node'),
    owner: FlowOwnerIdentityV1Schema,
    node_id: NonEmptyStringSchema,
  }),
  z.strictObject({
    segment_kind: z.literal('skill_pack_member'),
    owner_pin: PublishedResourcePinV1Schema.extend({
      published_resource_kind: z.literal('SKILL_PACK_RELEASE'),
    }),
    local_member_binding_id: NonEmptyStringSchema,
  }),
  z.strictObject({
    segment_kind: z.literal('subagent_target'),
    target_pin: PublishedResourcePinV1Schema.extend({
      published_resource_kind: z.enum(['AGENT_RELEASE', 'A2A_AGENT_RELEASE']),
    }),
  }),
]);

export const EffectiveCapabilityPolicyV1Schema = z.strictObject({
  credential_requirements: z.array(CredentialRequirementV1Schema),
  principal_modes: z
    .array(z.enum(['caller_delegated', 'service_principal', 'team_shared', 'none']))
    .refine(hasUniqueStrings, 'principal modes must be unique'),
  // Egress and budget own separate versioned vocabularies; this contract only embeds JSON values.
  egress: z.array(JsonObjectSchema),
  readable_data_classification_ceiling: z.enum([
    'public',
    'internal',
    'confidential',
    'restricted',
  ]),
  output_data_classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  side_effect: z.strictObject({
    maximum_class: z.enum(['safe', 'requires_key', 'unsafe']),
    approval: z.enum(['none', 'required']),
  }),
  operation_contract_hashes: z
    .array(ContractHashSchema)
    .refine(hasUniqueStrings, 'operation contract hashes must be unique'),
  max_calls: NonNegativeIntegerSchema,
  max_depth: NonNegativeIntegerSchema,
  max_parallelism: NonNegativeIntegerSchema,
  budget: JsonObjectSchema,
});

export const OperationContractPinV1Schema = z.strictObject({
  operation_kind: z.enum([
    'knowledge_query',
    'database_operation',
    'flow_call',
    'plugin_tool',
    'subagent_call',
  ]),
  operation_id: NonEmptyStringSchema,
  input_schema_hash: ContractHashSchema,
  output_schema_hash: ContractHashSchema.optional(),
  side_effect_class: z.enum(['safe', 'requires_key', 'unsafe']),
  operation_key_required: z.boolean(),
  approval_required: z.boolean(),
  contract_hash: ContractHashSchema,
});

export const SkillPackOperationRouteV1Schema = z.strictObject({
  pack_binding_path: CanonicalBindingPathV1Schema,
  exposed_operation_id: NonEmptyStringSchema,
  exposed_operation_contract_hash: ContractHashSchema,
  member_binding_path: CanonicalBindingPathV1Schema,
  member_target: PublishedResourcePinV1Schema,
  member_operation_contract_hash: ContractHashSchema,
  route_hash: ContractHashSchema,
});

export const CompiledBindingEntryV1Schema = z
  .strictObject({
    binding_path_encoding_version: z.literal('binding-path-lp-utf8/1'),
    binding_path: CanonicalBindingPathV1Schema,
    binding_path_segments: z.array(BindingPathSegmentV1Schema).min(1),
    binding_id: NonEmptyStringSchema,
    binding_kind: BindingKindV1Schema,
    target: PublishedResourcePinV1Schema,
    config_schema_version: z.enum([
      'knowledge-binding/1',
      'database-binding/1',
      'flow-binding/1',
      'plugin-binding/1',
      'skill-pack-binding/1',
      'subagent-binding/1',
    ]),
    config_hash: ContractHashSchema,
    source_contract_hash: ContractHashSchema,
    effective_policy: EffectiveCapabilityPolicyV1Schema,
    operation_contracts: z.array(OperationContractPinV1Schema),
    dependency_node_ids: z
      .array(ClosureResourceNodeIdV1Schema)
      .refine(hasUniqueStrings, 'dependency node ids must be unique'),
    approval_gate_spec: z
      .strictObject({
        gate_spec_id: NonEmptyStringSchema,
        gate_spec_hash: ContractHashSchema,
      })
      .optional(),
    async_child_policy_hash: ContractHashSchema.optional(),
    skill_pack_operation_routes: z.array(SkillPackOperationRouteV1Schema).optional(),
  })
  .superRefine((binding, ctx) => {
    if (binding.binding_path_segments[0]?.segment_kind !== 'root') {
      addCustomIssue(
        ctx,
        ['binding_path_segments'],
        'a canonical binding path must start with a root segment',
      );
    }

    const expectedKinds: Record<typeof binding.binding_kind, readonly string[]> = {
      knowledge: ['KNOWLEDGE_INDEX_GENERATION'],
      database: ['DATABASE_OPERATION_RELEASE'],
      flow: ['FLOW_VERSION'],
      plugin: ['PLUGIN_TOOL_RELEASE'],
      skill_pack: ['SKILL_PACK_RELEASE'],
      subagent: ['AGENT_RELEASE', 'A2A_AGENT_RELEASE'],
    };
    if (!expectedKinds[binding.binding_kind].includes(binding.target.published_resource_kind)) {
      addCustomIssue(
        ctx,
        ['target', 'published_resource_kind'],
        `target kind does not match ${binding.binding_kind} binding`,
      );
    }

    if (
      binding.binding_kind === 'skill_pack' &&
      binding.skill_pack_operation_routes === undefined
    ) {
      addCustomIssue(
        ctx,
        ['skill_pack_operation_routes'],
        'skill pack bindings require sealed operation routes',
      );
    }
    if (
      binding.binding_kind !== 'skill_pack' &&
      binding.skill_pack_operation_routes !== undefined
    ) {
      addCustomIssue(
        ctx,
        ['skill_pack_operation_routes'],
        'only skill pack bindings can contain operation routes',
      );
    }
  });

const compiledGateSpecBaseShape = {
  schema_version: z.literal('compiled-gate-spec/1'),
  gate_spec_id: NonEmptyStringSchema,
  gate_spec_hash: ContractHashSchema,
  kind: z.enum(['input', 'approval']),
  decision_schema_hash: ContractHashSchema,
  approver_policy_ref: NonEmptyStringSchema,
  approver_policy_hash: ContractHashSchema,
  notification_profile_hash: ContractHashSchema.optional(),
  on_reject: z.enum(['fail_run', 'cancel_run']),
  on_expire: z.enum(['fail_run', 'cancel_run']),
  protected_operation_contract_hashes: z
    .array(ContractHashSchema)
    .refine(hasUniqueStrings, 'protected operation hashes must be unique'),
};

export const CompiledGateSpecEntryV1Schema = z
  .union([
    z.strictObject({
      ...compiledGateSpecBaseShape,
      source_kind: z.literal('agent_release'),
      source_node_id: ClosureResourceNodeIdV1Schema,
    }),
    z.strictObject({
      ...compiledGateSpecBaseShape,
      source_kind: z.literal('flow_node'),
      source_node_id: ClosureResourceNodeIdV1Schema,
      source_binding_path: CanonicalBindingPathV1Schema,
      source_flow_node_id: NonEmptyStringSchema,
    }),
  ])
  .superRefine((gate, ctx) => {
    if (gate.kind === 'input' && gate.protected_operation_contract_hashes.length !== 0) {
      addCustomIssue(ctx, ['protected_operation_contract_hashes'], 'input gate set must be empty');
    }
    if (gate.kind === 'approval' && gate.protected_operation_contract_hashes.length === 0) {
      addCustomIssue(
        ctx,
        ['protected_operation_contract_hashes'],
        'approval gate set must be non-empty',
      );
    }
  });

export const ClosureResourceNodeV1Schema = z
  .union([
    z.strictObject({
      node_id: ClosureResourceNodeIdV1Schema,
      intrinsic_policy: JsonObjectSchema,
      dependency_manifest_hash: ContractHashSchema,
      node_role: z.literal('root'),
      pin: ClosureRootPinV1Schema,
    }),
    z.strictObject({
      node_id: ClosureResourceNodeIdV1Schema,
      intrinsic_policy: JsonObjectSchema,
      dependency_manifest_hash: ContractHashSchema,
      node_role: z.literal('dependency'),
      pin: PublishedResourcePinV1Schema,
      nested_closure_hash: ContractHashSchema.optional(),
    }),
  ])
  .superRefine((node, ctx) => {
    if (node.node_role !== 'dependency') {
      return;
    }
    const needsNestedClosure =
      node.pin.published_resource_kind === 'AGENT_RELEASE' ||
      node.pin.published_resource_kind === 'FLOW_VERSION';
    if (needsNestedClosure !== (node.nested_closure_hash !== undefined)) {
      addCustomIssue(
        ctx,
        ['nested_closure_hash'],
        'Agent/Flow dependencies require a nested closure hash and leaf dependencies forbid it',
      );
    }
  });

export const ClosureDependencyEdgeV1Schema = z.strictObject({
  from_node_id: ClosureResourceNodeIdV1Schema,
  to_node_id: ClosureResourceNodeIdV1Schema,
  relation: z.enum([
    'binding_target',
    'flow_node',
    'subflow',
    'skill_pack_member',
    'subagent_target',
    'typed_internal_dependency',
  ]),
  source_path: CanonicalBindingPathV1Schema,
});

export const ProductionPromotionGateKeyV1Schema = z.strictObject({
  schema_version: z.literal('production-promotion-gate-key/1'),
  workspace_id: NonEmptyStringSchema,
  deployment_kind: z.enum(['agent', 'flow']),
  deployment_id: NonEmptyStringSchema,
  candidate_deployment_revision_id: NonEmptyStringSchema,
  candidate_revision_contract_hash: ContractHashSchema,
  executable_target: PublishedResourcePinV1Schema.extend({
    published_resource_kind: z.enum(['AGENT_RELEASE', 'FLOW_VERSION']),
  }),
  dependency_manifest_hash: ContractHashSchema,
  capability_closure_hash: ContractHashSchema,
  evaluation_suite_release_id: NonEmptyStringSchema,
  evaluation_policy_hash: ContractHashSchema,
  evaluation_run_ids: z
    .array(NonEmptyStringSchema)
    .refine(hasUniqueStrings, 'evaluation run ids must be unique'),
  evidence_bundle_hash: ContractHashSchema,
  observed_evidence_epoch_hash: ContractHashSchema,
  expected_activation_epoch: NonNegativeIntegerSchema,
});

export const ProductionPromotionGateDecisionV1Schema = z
  .strictObject({
    schema_version: z.literal('production-promotion-gate-decision/1'),
    decision_id: NonEmptyStringSchema,
    key: ProductionPromotionGateKeyV1Schema,
    key_hash: ContractHashSchema,
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED', 'CONSUMED']),
    decision_version: PositiveIntegerSchema,
    expires_at: z.iso.datetime({ offset: true }),
    decided_by: NonEmptyStringSchema.optional(),
    decided_at: z.iso.datetime({ offset: true }).optional(),
    invalidated_at: z.iso.datetime({ offset: true }).optional(),
    invalidation_reason: NonEmptyStringSchema.optional(),
    consumed_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((decision, ctx) => {
    const hasDecision = decision.decided_by !== undefined && decision.decided_at !== undefined;
    const hasAnyDecisionField =
      decision.decided_by !== undefined || decision.decided_at !== undefined;
    const hasInvalidation =
      decision.invalidated_at !== undefined && decision.invalidation_reason !== undefined;
    const hasAnyInvalidationField =
      decision.invalidated_at !== undefined || decision.invalidation_reason !== undefined;

    if (
      decision.status === 'PENDING' &&
      (hasAnyDecisionField || hasAnyInvalidationField || decision.consumed_at !== undefined)
    ) {
      addCustomIssue(ctx, ['status'], 'pending decisions cannot carry terminal transition fields');
    }
    if (
      (decision.status === 'APPROVED' || decision.status === 'REJECTED') &&
      (!hasDecision || hasAnyInvalidationField || decision.consumed_at !== undefined)
    ) {
      addCustomIssue(
        ctx,
        ['status'],
        'approved/rejected decisions require decision actor/time and no later transition fields',
      );
    }
    if (
      decision.status === 'INVALIDATED' &&
      (!hasInvalidation ||
        decision.consumed_at !== undefined ||
        (hasAnyDecisionField && !hasDecision))
    ) {
      addCustomIssue(
        ctx,
        ['status'],
        'invalidated decisions require invalidation time/reason and complete optional decision fields',
      );
    }
    if (
      decision.status === 'CONSUMED' &&
      (!hasDecision || decision.consumed_at === undefined || hasAnyInvalidationField)
    ) {
      addCustomIssue(
        ctx,
        ['status'],
        'consumed decisions require approval actor/time and consumed time without invalidation fields',
      );
    }
  });

function sameRootPin(
  left: z.infer<typeof ClosureRootPinV1Schema>,
  right: z.infer<typeof ClosureRootPinV1Schema>,
): boolean {
  return (
    left.workspace_id === right.workspace_id &&
    left.published_resource_kind === right.published_resource_kind &&
    left.resource_id === right.resource_id &&
    left.resource_version_id === right.resource_version_id &&
    left.contract_hash === right.contract_hash &&
    left.binding_mode === right.binding_mode
  );
}

export const CompiledCapabilityClosureV1Schema = z
  .strictObject({
    schema_version: z.literal('compiled-capability-closure/1'),
    root: ClosureRootV1Schema,
    assembly_pins: z.array(PublishedResourcePinV1Schema),
    bindings: z.array(CompiledBindingEntryV1Schema),
    gate_specs: z.array(CompiledGateSpecEntryV1Schema),
    resource_nodes: z.array(ClosureResourceNodeV1Schema).min(1),
    dependency_edges: z.array(ClosureDependencyEdgeV1Schema),
    disabled_binding_paths: z
      .array(CanonicalBindingPathV1Schema)
      .refine(hasUniqueStrings, 'disabled binding paths must be unique'),
    aggregate_limits: EffectiveCapabilityPolicyV1Schema,
    closure_hash: ContractHashSchema,
  })
  .superRefine((closure, ctx) => {
    if (!hasUniqueBy(closure.bindings, (binding) => binding.binding_path)) {
      addCustomIssue(ctx, ['bindings'], 'binding paths must be unique within a closure');
    }
    if (!hasUniqueBy(closure.resource_nodes, (node) => node.node_id)) {
      addCustomIssue(ctx, ['resource_nodes'], 'resource node ids must be unique');
    }
    if (
      !hasUniqueBy(closure.gate_specs, (gate) => `${gate.source_node_id}\u0000${gate.gate_spec_id}`)
    ) {
      addCustomIssue(ctx, ['gate_specs'], 'gate spec source identities must be unique');
    }

    const rootNodes = closure.resource_nodes.filter((node) => node.node_role === 'root');
    if (
      rootNodes.length !== 1 ||
      !sameRootPin(rootNodes[0]?.pin ?? closure.root.pin, closure.root.pin)
    ) {
      addCustomIssue(
        ctx,
        ['resource_nodes'],
        'closure must contain exactly one resource root matching the closure root pin',
      );
    }

    const nodeIds = new Set(closure.resource_nodes.map((node) => node.node_id));
    for (const binding of closure.bindings) {
      for (const dependencyNodeId of binding.dependency_node_ids) {
        if (!nodeIds.has(dependencyNodeId)) {
          addCustomIssue(
            ctx,
            ['bindings'],
            `binding ${binding.binding_path} references unknown dependency node ${dependencyNodeId}`,
          );
        }
      }
    }
    for (const gate of closure.gate_specs) {
      if (!nodeIds.has(gate.source_node_id)) {
        addCustomIssue(
          ctx,
          ['gate_specs'],
          `gate ${gate.gate_spec_id} references an unknown source node`,
        );
      }
    }
    for (const edge of closure.dependency_edges) {
      if (!nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id)) {
        addCustomIssue(
          ctx,
          ['dependency_edges'],
          'dependency edges must reference resource nodes in the same closure',
        );
      }
    }
  });

export type CompiledCapabilityClosureV1 = z.infer<typeof CompiledCapabilityClosureV1Schema>;
