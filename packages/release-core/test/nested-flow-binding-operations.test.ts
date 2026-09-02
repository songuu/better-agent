import { describe, expect, it } from 'vitest';

import type { PublishedResourcePinV1 } from '@better-agent/domain-contracts';
import { canonicalResourceNodeId, createClosureIdentityRegistry } from '../src/closure-identity.js';
import {
  compareCanonicalStrings,
  deriveDependencyManifest,
  normalizeDependencyPins,
} from '../src/dependency-manifest.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import { prepareGraphBoundNestedFlowBindingOperations } from '../src/nested-flow-binding-operations.js';
import { prepareOperationContractSource } from '../src/operation-contract-source.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { prepareFlowNodePaths } from '../src/root-binding-paths.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { hashA, hashB, makeFlowIr, makePluginPin, workspaceId } from './fixtures.js';

function executable(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

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

function sources(secondMount = false) {
  const pluginPin = makePluginPin();
  const flow = { ...makeFlowIr(), resources: [pluginPin] };
  const flowRoot = prepareExecutableSource(executable(flow)).root;
  const flowPin = { ...flowRoot.pin, published_resource_kind: 'FLOW_VERSION' as const };
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find((item) => item.kind === 'flow');
  if (binding === undefined) throw new Error('fixture Flow Binding is missing');
  binding.pin = flowPin;
  if (secondMount) {
    const second = structuredClone(binding);
    second.binding_id = 'flow-second';
    agent.capability_bindings.push(second);
    agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
  }
  return { agent, flow, flowPin, pluginPin };
}

function compiledClosure(flow: ReturnType<typeof sources>['flow']) {
  const prepared = prepareExecutableSource(executable(flow));
  const paths = prepareFlowNodePaths(executable(flow));
  const sourcePath = paths.nodes.find((node) => node.node_id === 'output-1');
  if (sourcePath === undefined) throw new Error('fixture output node is missing');
  const target = flow.resources[0];
  if (target === undefined) throw new Error('fixture target is missing');
  const operation = prepareOperationContractSource({
    schema_version: 'operation-contract-source/1',
    operation_kind: 'plugin_tool',
    operation_id: 'flow-output',
    input_schema: {},
    output_schema: {},
    side_effect_class: 'safe',
    operation_key_required: false,
    approval_required: false,
  }).pin;
  const assemblyPins = normalizeDependencyPins(workspaceId, flow.resources);
  const binding = {
    binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
    binding_path: sourcePath.source_path,
    binding_path_segments: sourcePath.source_path_segments,
    binding_id: 'flow-output-operation',
    binding_kind: 'plugin' as const,
    target,
    config_schema_version: 'plugin-binding/1' as const,
    config_hash: canonicalSha256({ schema_version: 'plugin-binding/1' }),
    source_contract_hash: canonicalSha256({ node_id: sourcePath.node_id }),
    effective_policy: { ...emptyPolicy, operation_contract_hashes: [operation.contract_hash] },
    operation_contracts: [operation],
    dependency_node_ids: [canonicalResourceNodeId(target)],
  };
  const resourceNodes = [
    {
      node_id: canonicalResourceNodeId(paths.root.pin),
      intrinsic_policy: {},
      dependency_manifest_hash: prepared.dependency_manifest.manifest_hash,
      node_role: 'root' as const,
      pin: paths.root.pin,
    },
    {
      node_id: canonicalResourceNodeId(target),
      intrinsic_policy: {},
      dependency_manifest_hash: hashA,
      node_role: 'dependency' as const,
      pin: target,
    },
  ].sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id));
  const draft = {
    schema_version: 'compiled-capability-closure/1' as const,
    root: paths.root,
    assembly_pins: assemblyPins,
    bindings: [binding],
    gate_specs: [],
    resource_nodes: resourceNodes,
    dependency_edges: [],
    disabled_binding_paths: [],
    aggregate_limits: emptyPolicy,
    closure_hash: hashA,
  };
  return {
    ...draft,
    closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
  };
}

function graph(
  root: { pin: PublishedResourcePinV1; semantic_seed_hash: string },
  flowPin: PublishedResourcePinV1,
  nestedClosureHash: string,
  pluginPin: PublishedResourcePinV1,
  omitFlowDependency = false,
) {
  const owner = (pin: PublishedResourcePinV1) => ({
    workspace_id: pin.workspace_id,
    published_resource_kind: pin.published_resource_kind,
    resource_id: pin.resource_id,
    resource_version_id: pin.resource_version_id,
  });
  const candidateGraph = {
    schema_version: 'pinned-dependency-graph-candidate/1',
    root,
    root_dependencies: [flowPin],
    resources: [
      {
        schema_version: 'pinned-dependency-record/1',
        pin: flowPin,
        publication_state: 'sealed',
        dependency_manifest: deriveDependencyManifest(
          owner(flowPin),
          omitFlowDependency ? [] : [pluginPin],
        ),
        nested_closure_hash: nestedClosureHash,
      },
      ...(omitFlowDependency
        ? []
        : [
            {
              schema_version: 'pinned-dependency-record/1' as const,
              pin: pluginPin,
              publication_state: 'sealed' as const,
              dependency_manifest: deriveDependencyManifest(owner(pluginPin), []),
            },
          ]),
    ],
  };
  return { candidateGraph, expectedGraph: preparePinnedDependencyGraph(candidateGraph) };
}

function prepared(secondMount = false) {
  const value = sources(secondMount);
  const closure = compiledClosure(value.flow);
  const root = prepareExecutableSource(executable(value.agent)).root;
  const evidence = graph(root, value.flowPin, closure.closure_hash, value.pluginPin);
  return { ...value, closure, ...evidence };
}

describe('nested Flow Binding operation projection', () => {
  it('projects a verified Flow-node operation under its parent Flow Binding prefix', () => {
    const value = prepared();
    const result = prepareGraphBoundNestedFlowBindingOperations(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
    );
    const projected = result.binding_operations.find(
      (entry) => entry.operation_contracts.length === 1,
    );
    expect(projected?.operation_contracts[0]?.operation_id).toBe('flow-output');
    expect(projected?.binding_path).not.toBe(value.closure.bindings[0]?.binding_path);
  });

  it('isolates one verified node operation under two Flow mounts', () => {
    const value = prepared(true);
    const result = prepareGraphBoundNestedFlowBindingOperations(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
    );
    const projected = result.binding_operations.filter(
      (entry) => entry.operation_contracts.length === 1,
    );
    expect(projected).toHaveLength(2);
    expect(projected[0]?.binding_path).not.toBe(projected[1]?.binding_path);
  });

  it('keeps parent sibling paths but does not copy Flow operations onto them', () => {
    const value = prepared();
    const result = prepareGraphBoundNestedFlowBindingOperations(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
    );
    expect(
      result.binding_operations.find((entry) => entry.binding_id === 'plugin')?.operation_contracts,
    ).toEqual([]);
  });

  it('rejects a resealed closure Binding that is not an exact Flow-node path', () => {
    const value = prepared();
    const identity = createClosureIdentityRegistry();
    const segments = [
      { segment_kind: 'root' as const, pin: value.closure.root.pin },
      {
        segment_kind: 'binding' as const,
        owner: { owner_kind: 'root' as const, pin: value.closure.root.pin },
        binding_kind: 'plugin' as const,
        local_binding_id: 'not-a-flow-node',
      },
    ];
    const bindings = structuredClone(value.closure.bindings);
    const binding = bindings[0];
    if (binding === undefined) throw new Error('fixture closure Binding is missing');
    binding.binding_path_segments = segments;
    binding.binding_path = identity.registerBindingPath(segments);
    const draft = { ...value.closure, bindings, closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    const evidence = graph(
      prepareExecutableSource(executable(value.agent)).root,
      value.flowPin,
      closure.closure_hash,
      value.pluginPin,
    );
    expect(() =>
      prepareGraphBoundNestedFlowBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        executable(value.agent),
        executable(value.flow),
        closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('rejects closure bytes not committed by the graph', () => {
    const value = prepared();
    const evidence = graph(
      prepareExecutableSource(executable(value.agent)).root,
      value.flowPin,
      hashB,
      value.pluginPin,
    );
    expect(() =>
      prepareGraphBoundNestedFlowBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        executable(value.agent),
        executable(value.flow),
        value.closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('rejects a graph manifest that omits the Flow source dependency', () => {
    const value = prepared();
    const evidence = graph(
      prepareExecutableSource(executable(value.agent)).root,
      value.flowPin,
      value.closure.closure_hash,
      value.pluginPin,
      true,
    );
    expect(() =>
      prepareGraphBoundNestedFlowBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        executable(value.agent),
        executable(value.flow),
        value.closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('rejects a resealed closure assembly that differs from the Flow source', () => {
    const value = prepared();
    const draft = { ...value.closure, assembly_pins: [], closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    const evidence = graph(
      prepareExecutableSource(executable(value.agent)).root,
      value.flowPin,
      closure.closure_hash,
      value.pluginPin,
    );
    expect(() =>
      prepareGraphBoundNestedFlowBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        executable(value.agent),
        executable(value.flow),
        closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('returns canonical path order and deeply frozen operation sets', () => {
    const value = prepared(true);
    const result = prepareGraphBoundNestedFlowBindingOperations(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
    );
    expect(result.binding_operations.map((entry) => entry.binding_path)).toEqual(
      [...result.binding_operations.map((entry) => entry.binding_path)].sort(
        compareCanonicalStrings,
      ),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.binding_operations)).toBe(true);
    expect(Object.isFrozen(result.binding_operations[0]?.operation_contracts)).toBe(true);
  });
});
