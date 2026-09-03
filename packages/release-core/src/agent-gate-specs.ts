import {
  CompiledGateSpecEntryV1Schema,
  type FlowGraphV1,
  OperationContractPinV1Schema,
} from '@better-agent/domain-contracts';

import { canonicalResourceNodeId } from './closure-identity.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';
import { prepareFlowNodePaths } from './root-binding-paths.js';

type CompiledGateSpecEntryV1 = ReturnType<typeof CompiledGateSpecEntryV1Schema.parse>;

interface PreparedAgentGateSpecsV1 {
  readonly schema_version: 'prepared-agent-gate-specs/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly gate_specs: readonly CompiledGateSpecEntryV1[];
}

interface PreparedFlowGateSpecsV1 {
  readonly schema_version: 'prepared-flow-gate-specs/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly gate_specs: readonly CompiledGateSpecEntryV1[];
}

interface PreparedAgentBindingApprovalGateV1 {
  readonly schema_version: 'prepared-agent-binding-approval-gate/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly binding_id: string;
  readonly operation_contracts: readonly ReturnType<typeof OperationContractPinV1Schema.parse>[];
  readonly approval_gate_spec?: {
    readonly gate_spec_id: string;
    readonly gate_spec_hash: string;
  };
}

function notClosed(): never {
  throw new ReleaseCoreError(
    'GATE_SPEC_NOT_CLOSED',
    '$.gate_specs',
    'Agent GateSpec cannot be compiled into the closed source-bound contract',
  );
}

/** Compile immutable Agent-root gates; Binding operation coverage is joined in a later step. */
export function prepareAgentGateSpecs(rootInput: unknown): PreparedAgentGateSpecsV1 {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed();
  const document = source.preimage.document as unknown as {
    gate_specs: readonly {
      gate_spec_id: string;
      gate_spec_hash: string;
      kind: 'input' | 'approval';
      decision_schema_hash: string;
      approver_policy_ref: string;
      approver_policy_hash: string;
      notification_profile_hash?: string;
      on_reject: 'fail_run' | 'cancel_run';
      on_expire: 'fail_run' | 'cancel_run';
      protected_operation_contract_hashes: readonly string[];
    }[];
  };
  const sourceNodeId = canonicalResourceNodeId(source.root.pin);
  const gates = document.gate_specs
    .map((gate) => {
      const parsed = CompiledGateSpecEntryV1Schema.safeParse({
        schema_version: 'compiled-gate-spec/1',
        gate_spec_id: gate.gate_spec_id,
        gate_spec_hash: gate.gate_spec_hash,
        kind: gate.kind,
        decision_schema_hash: gate.decision_schema_hash,
        approver_policy_ref: gate.approver_policy_ref,
        approver_policy_hash: gate.approver_policy_hash,
        ...(gate.notification_profile_hash === undefined
          ? {}
          : { notification_profile_hash: gate.notification_profile_hash }),
        on_reject: gate.on_reject,
        on_expire: gate.on_expire,
        protected_operation_contract_hashes: gate.protected_operation_contract_hashes,
        source_kind: 'agent_release',
        source_node_id: sourceNodeId,
      });
      if (!parsed.success) notClosed();
      return parsed.data;
    })
    .sort((left, right) => compareCanonicalStrings(left.gate_spec_id, right.gate_spec_id));
  return deepFreezeJson({
    schema_version: 'prepared-agent-gate-specs/1',
    root: source.root,
    gate_specs: gates,
  });
}

interface FlowGateProjectionSource {
  readonly gate_spec_id: string;
  readonly gate_spec_hash: string;
  readonly kind: 'input' | 'approval';
  readonly decision_schema_hash: string;
  readonly approver_policy_ref: string;
  readonly approver_policy_hash: string;
  readonly notification_profile_hash?: string;
  readonly on_reject: 'fail_run' | 'cancel_run';
  readonly on_expire: 'fail_run' | 'cancel_run';
  readonly protected_operation_contract_hashes: readonly string[];
}

function collectFlowGates(graph: FlowGraphV1): readonly {
  graph_id: string;
  node_id: string;
  gate: FlowGateProjectionSource;
}[] {
  return graph.nodes.flatMap((node) => {
    const config = node.config as Record<string, unknown>;
    const nested =
      node.type === 'branch'
        ? [
            ...(config.cases as { graph: FlowGraphV1 }[]).flatMap((item) =>
              collectFlowGates(item.graph),
            ),
            ...collectFlowGates((config.else_case as { graph: FlowGraphV1 }).graph),
          ]
        : node.type === 'loop'
          ? collectFlowGates(config.body as FlowGraphV1)
          : [];
    return [
      ...(node.type === 'human_gate'
        ? [
            {
              graph_id: graph.graph_id,
              node_id: node.node_id,
              gate: config.gate as FlowGateProjectionSource,
            },
          ]
        : []),
      ...nested,
    ];
  });
}

/** Compile Flow human gates under their exact graph-aware source paths. */
export function prepareFlowGateSpecs(rootInput: unknown): PreparedFlowGateSpecsV1 {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'FLOW_VERSION') notClosed();
  const document = source.preimage.document as unknown as { entry_graph: FlowGraphV1 };
  const nodes = prepareFlowNodePaths(rootInput).nodes;
  const sourceNodeId = canonicalResourceNodeId(source.root.pin);
  const seenGateIds = new Set<string>();
  const gates = collectFlowGates(document.entry_graph)
    .map(({ graph_id, node_id, gate }) => {
      if (seenGateIds.has(gate.gate_spec_id)) notClosed();
      seenGateIds.add(gate.gate_spec_id);
      const sourcePath = nodes.find(
        (node) => node.graph_id === graph_id && node.node_id === node_id,
      );
      if (sourcePath === undefined) notClosed();
      const parsed = CompiledGateSpecEntryV1Schema.safeParse({
        schema_version: 'compiled-gate-spec/1',
        gate_spec_id: gate.gate_spec_id,
        gate_spec_hash: gate.gate_spec_hash,
        kind: gate.kind,
        decision_schema_hash: gate.decision_schema_hash,
        approver_policy_ref: gate.approver_policy_ref,
        approver_policy_hash: gate.approver_policy_hash,
        ...(gate.notification_profile_hash === undefined
          ? {}
          : { notification_profile_hash: gate.notification_profile_hash }),
        on_reject: gate.on_reject,
        on_expire: gate.on_expire,
        protected_operation_contract_hashes: gate.protected_operation_contract_hashes,
        source_kind: 'flow_node',
        source_node_id: sourceNodeId,
        source_binding_path: sourcePath.source_path,
        source_binding_path_segments: sourcePath.source_path_segments,
        source_flow_node_id: node_id,
      });
      if (!parsed.success) notClosed();
      return parsed.data;
    })
    .sort((left, right) =>
      compareCanonicalStrings(
        `${left.source_kind === 'flow_node' ? left.source_binding_path : ''}\u0000${left.gate_spec_id}`,
        `${right.source_kind === 'flow_node' ? right.source_binding_path : ''}\u0000${right.gate_spec_id}`,
      ),
    );
  return deepFreezeJson({
    schema_version: 'prepared-flow-gate-specs/1',
    root: source.root,
    gate_specs: gates,
  });
}

/** Join one Agent Binding's approval declaration to exact same-source gate operation coverage. */
export function prepareAgentBindingApprovalGate(
  rootInput: unknown,
  bindingId: string,
  operationContractsInput: unknown,
): PreparedAgentBindingApprovalGateV1 {
  const preparedGates = prepareAgentGateSpecs(rootInput);
  const source = prepareExecutableSource(rootInput);
  const document = source.preimage.document as unknown as {
    capability_bindings: readonly {
      binding_id: string;
      side_effect: {
        approval: 'none' | 'required';
        approval_gate_spec_id?: string;
      };
    }[];
  };
  const binding = document.capability_bindings.find((item) => item.binding_id === bindingId);
  if (binding === undefined || !Array.isArray(operationContractsInput)) notClosed();
  const operationContracts = operationContractsInput.map((value) => {
    const parsed = OperationContractPinV1Schema.safeParse(value);
    if (!parsed.success) notClosed();
    return parsed.data;
  });
  const uniqueHashes = new Set(operationContracts.map((operation) => operation.contract_hash));
  if (uniqueHashes.size !== operationContracts.length) notClosed();
  if (binding.side_effect.approval === 'none') {
    if (operationContracts.some((operation) => operation.approval_required)) notClosed();
    return deepFreezeJson({
      schema_version: 'prepared-agent-binding-approval-gate/1',
      root: source.root,
      binding_id: binding.binding_id,
      operation_contracts: operationContracts,
    });
  }
  if (operationContracts.length === 0) notClosed();
  const matching = preparedGates.gate_specs.filter(
    (gate) => gate.gate_spec_id === binding.side_effect.approval_gate_spec_id,
  );
  if (matching.length !== 1) notClosed();
  const gate = matching[0];
  if (
    gate === undefined ||
    gate.kind !== 'approval' ||
    !operationContracts.every((operation) =>
      gate.protected_operation_contract_hashes.includes(operation.contract_hash),
    )
  )
    notClosed();
  return deepFreezeJson({
    schema_version: 'prepared-agent-binding-approval-gate/1',
    root: source.root,
    binding_id: binding.binding_id,
    operation_contracts: operationContracts,
    approval_gate_spec: {
      gate_spec_id: gate.gate_spec_id,
      gate_spec_hash: gate.gate_spec_hash,
    },
  });
}
