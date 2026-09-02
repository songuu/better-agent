import { z } from 'zod';

import { CredentialRequirementV1Schema, PublishedResourcePinV1Schema } from './agent-release-v1.js';
import {
  addCustomIssue,
  ContractHashSchema,
  hasUniqueBy,
  hasUniqueStrings,
  JsonObjectSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  PositiveMillisecondsSchema,
  type JsonObject,
  type JsonValue,
} from './primitives.js';

const ValueBindingV1Schema = JsonValueSchema;

export const RetryPolicyV1Schema = z.strictObject({
  max_attempts: z.number().int().min(1).max(5),
  backoff: z.enum(['fixed', 'exponential']),
  initial_delay_ms: PositiveMillisecondsSchema.optional(),
  max_delay_ms: PositiveMillisecondsSchema.optional(),
});

export const ErrorPolicyV1Schema = z.union([
  z.strictObject({ mode: z.literal('fail') }),
  z.strictObject({ mode: z.literal('continue_with'), output: JsonValueSchema }),
]);

const flowGateSpecBaseShape = {
  schema_version: z.literal('human-gate/1'),
  gate_spec_id: NonEmptyStringSchema,
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

export const FlowGateSpecV1Schema = z
  .union([
    z.strictObject({
      ...flowGateSpecBaseShape,
      kind: z.literal('input'),
      protected_operation_contract_hashes: z.tuple([]),
    }),
    z.strictObject({
      ...flowGateSpecBaseShape,
      kind: z.literal('approval'),
      protected_operation_contract_hashes: z
        .array(ContractHashSchema)
        .min(1)
        .refine(hasUniqueStrings, 'protected operation contract hashes must be unique'),
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

const edgeEndpointSchema = z.strictObject({
  node_id: NonEmptyStringSchema,
  port: NonEmptyStringSchema,
});

export const FlowEdgeV1Schema = z.strictObject({
  edge_id: NonEmptyStringSchema,
  from: edgeEndpointSchema,
  to: edgeEndpointSchema,
  kind: z.enum(['data', 'control']),
});

export interface FlowNodeV1 {
  node_id: string;
  key: string;
  type: string;
  config: unknown;
  inputs: Record<string, JsonValue>;
  output_schema: JsonObject;
  retry?: unknown;
  error_policy?: unknown;
  timeout_ms?: number | undefined;
}

export interface FlowGraphV1 {
  graph_id: string;
  entry_node_id: string;
  exit_node_ids: string[];
  nodes: FlowNodeV1[];
  edges: z.infer<typeof FlowEdgeV1Schema>[];
}

const flowNodeCommonShape = {
  node_id: NonEmptyStringSchema,
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  inputs: z.record(z.string(), ValueBindingV1Schema),
  output_schema: JsonObjectSchema,
  retry: RetryPolicyV1Schema.optional(),
  error_policy: ErrorPolicyV1Schema.optional(),
  timeout_ms: PositiveMillisecondsSchema.optional(),
};

const actionNodeTypeSchema = z.enum([
  'start',
  'output',
  'llm',
  'api',
  'code',
  'knowledge',
  'text',
  'intent',
  'classifier',
]);

export const FlowGraphV1Schema: z.ZodType<FlowGraphV1> = z.lazy(() =>
  z
    .strictObject({
      graph_id: NonEmptyStringSchema,
      entry_node_id: NonEmptyStringSchema,
      exit_node_ids: z.array(NonEmptyStringSchema).min(1),
      nodes: z.array(FlowNodeV1Schema).min(1),
      edges: z.array(FlowEdgeV1Schema),
    })
    .superRefine((graph, ctx) => {
      if (!hasUniqueBy(graph.nodes, (node) => node.node_id)) {
        addCustomIssue(ctx, ['nodes'], 'node ids must be unique within a graph');
      }
      if (!hasUniqueBy(graph.nodes, (node) => node.key)) {
        addCustomIssue(ctx, ['nodes'], 'node keys must be unique within a graph');
      }
      if (!hasUniqueBy(graph.edges, (edge) => edge.edge_id)) {
        addCustomIssue(ctx, ['edges'], 'edge ids must be unique within a graph');
      }
      if (!hasUniqueStrings(graph.exit_node_ids)) {
        addCustomIssue(ctx, ['exit_node_ids'], 'exit node ids must be unique');
      }

      const nodeIds = new Set(graph.nodes.map((node) => node.node_id));
      if (!nodeIds.has(graph.entry_node_id)) {
        addCustomIssue(ctx, ['entry_node_id'], 'entry node must exist in the graph');
      }
      for (const exitNodeId of graph.exit_node_ids) {
        if (!nodeIds.has(exitNodeId)) {
          addCustomIssue(ctx, ['exit_node_ids'], `exit node ${exitNodeId} does not exist`);
        }
      }
      for (const edge of graph.edges) {
        if (!nodeIds.has(edge.from.node_id) || !nodeIds.has(edge.to.node_id)) {
          addCustomIssue(ctx, ['edges'], `edge ${edge.edge_id} references an unknown node`);
        }
      }

      const controlAdjacency = new Map<string, string[]>(
        graph.nodes.map((node) => [node.node_id, []]),
      );
      for (const edge of graph.edges) {
        if (
          edge.kind === 'control' &&
          nodeIds.has(edge.from.node_id) &&
          nodeIds.has(edge.to.node_id)
        ) {
          controlAdjacency.get(edge.from.node_id)?.push(edge.to.node_id);
        }
      }

      const reachable = new Set<string>();
      const pending = [graph.entry_node_id];
      while (pending.length > 0) {
        const nodeId = pending.pop();
        if (nodeId === undefined || reachable.has(nodeId) || !nodeIds.has(nodeId)) continue;
        reachable.add(nodeId);
        pending.push(...(controlAdjacency.get(nodeId) ?? []));
      }
      for (const node of graph.nodes) {
        if (!reachable.has(node.node_id)) {
          addCustomIssue(ctx, ['nodes'], `node ${node.node_id} is unreachable from the entry node`);
        }
      }

      const indegree = new Map<string, number>(graph.nodes.map((node) => [node.node_id, 0]));
      for (const targets of controlAdjacency.values()) {
        for (const targetId of targets) indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1);
      }
      const ready = [...indegree.entries()]
        .filter(([, count]) => count === 0)
        .map(([nodeId]) => nodeId);
      let visitedCount = 0;
      while (ready.length > 0) {
        const nodeId = ready.pop();
        if (nodeId === undefined) continue;
        visitedCount += 1;
        for (const targetId of controlAdjacency.get(nodeId) ?? []) {
          const nextIndegree = (indegree.get(targetId) ?? 0) - 1;
          indegree.set(targetId, nextIndegree);
          if (nextIndegree === 0) ready.push(targetId);
        }
      }
      if (visitedCount !== graph.nodes.length) {
        addCustomIssue(
          ctx,
          ['edges'],
          'ordinary control edges must be acyclic; use a structured loop node',
        );
      }
    }),
);

const branchCaseSchema = z.strictObject({
  case_id: NonEmptyStringSchema,
  when: NonEmptyStringSchema,
  graph: FlowGraphV1Schema,
  exports: z.record(z.string(), ValueBindingV1Schema),
});

const BranchConfigV1Schema = z.strictObject({
  expression_language: z.literal('js-expression-v1'),
  cases: z
    .array(branchCaseSchema)
    .refine(
      (cases) => hasUniqueBy(cases, (branchCase) => branchCase.case_id),
      'branch case ids must be unique',
    ),
  else_case: z.strictObject({
    graph: FlowGraphV1Schema,
    exports: z.record(z.string(), ValueBindingV1Schema),
  }),
});

const loopConfigCommonShape = {
  max_iterations: z.number().int().min(1).max(10_000),
  body: FlowGraphV1Schema,
  break_when: NonEmptyStringSchema.optional(),
  exports: z.record(z.string(), JsonObjectSchema),
};

// Select the mode before touching recursive bodies; trial unions repeat nested work exponentially.
const LoopConfigV1Schema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...loopConfigCommonShape,
    mode: z.literal('collection'),
    collection: ValueBindingV1Schema,
    item_name: NonEmptyStringSchema.optional(),
    index_name: NonEmptyStringSchema.optional(),
  }),
  z.strictObject({
    ...loopConfigCommonShape,
    mode: z.literal('condition'),
    continue_when: NonEmptyStringSchema,
  }),
]);

const SubflowConfigV1Schema = z.strictObject({
  target: z.strictObject({
    flow_id: NonEmptyStringSchema,
    flow_version_id: NonEmptyStringSchema,
  }),
  inputs: z.record(z.string(), ValueBindingV1Schema),
  output_mapping: z.record(z.string(), NonEmptyStringSchema),
  invocation: z.literal('sync'),
});

const HumanGateNodeConfigV1Schema = z
  .strictObject({
    gate: FlowGateSpecV1Schema,
    prompt: ValueBindingV1Schema,
    operation_intent: ValueBindingV1Schema.optional(),
    exports: z.record(z.string(), NonEmptyStringSchema),
  })
  .superRefine((config, ctx) => {
    if (config.gate.kind === 'approval' && config.operation_intent === undefined) {
      addCustomIssue(
        ctx,
        ['operation_intent'],
        'approval gates require a canonical operation intent binding',
      );
    }
    if (config.gate.kind === 'input' && config.operation_intent !== undefined) {
      addCustomIssue(ctx, ['operation_intent'], 'input gates cannot carry operation intent');
    }
  });

export const FlowNodeV1Schema: z.ZodType<FlowNodeV1> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      ...flowNodeCommonShape,
      type: actionNodeTypeSchema,
      // Action-specific schemas are separate registered contracts; this field remains JSON here.
      config: JsonObjectSchema,
    }),
    z.strictObject({
      ...flowNodeCommonShape,
      type: z.literal('branch'),
      config: BranchConfigV1Schema,
    }),
    z.strictObject({
      ...flowNodeCommonShape,
      type: z.literal('loop'),
      config: LoopConfigV1Schema,
    }),
    z.strictObject({
      ...flowNodeCommonShape,
      type: z.literal('subflow'),
      config: SubflowConfigV1Schema,
    }),
    z.strictObject({
      ...flowNodeCommonShape,
      type: z.literal('human_gate'),
      config: HumanGateNodeConfigV1Schema,
    }),
  ]),
);

export const FlowIrV1Schema = z
  .strictObject({
    schema_version: z.literal('flow-ir/1'),
    flow_id: NonEmptyStringSchema,
    flow_version_id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    entry_graph: FlowGraphV1Schema,
    input_schema: JsonObjectSchema,
    output_schema: JsonObjectSchema,
    resources: z.array(PublishedResourcePinV1Schema),
    credential_requirements: z.array(CredentialRequirementV1Schema),
    execution_defaults: JsonObjectSchema,
    ui: JsonValueSchema.optional(),
  })
  .superRefine((flow, ctx) => {
    const rootStarts = flow.entry_graph.nodes.filter((node) => node.type === 'start');
    if (rootStarts.length !== 1 || rootStarts[0]?.node_id !== flow.entry_graph.entry_node_id) {
      addCustomIssue(
        ctx,
        ['entry_graph'],
        'the root graph must have exactly one start node and it must be the entry node',
      );
    }

    if (
      !hasUniqueBy(
        flow.resources,
        (pin) =>
          `${pin.workspace_id}\u0000${pin.published_resource_kind}\u0000${pin.resource_id}\u0000${pin.resource_version_id}\u0000${pin.contract_hash}`,
      )
    ) {
      addCustomIssue(ctx, ['resources'], 'resource pins must be unique by their full identity');
    }
    if (!hasUniqueBy(flow.credential_requirements, (requirement) => requirement.requirement_id)) {
      addCustomIssue(ctx, ['credential_requirements'], 'credential requirement ids must be unique');
    }
  });

export type FlowIrV1 = z.infer<typeof FlowIrV1Schema>;
