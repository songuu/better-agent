import { describe, expect, it } from 'vitest';

import type { PublishedResourcePinV1 } from '@better-agent/domain-contracts';
import { prepareGraphBoundAgentSubagentCallOperations } from '../src/agent-child-call-operations.js';
import { canonicalResourceNodeId } from '../src/closure-identity.js';
import { compareCanonicalStrings, deriveDependencyManifest } from '../src/dependency-manifest.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import { prepareGraphBoundNestedAgentBindingOperations } from '../src/nested-agent-binding-operations.js';
import { prepareOperationContractSource } from '../src/operation-contract-source.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { prepareRootBindingPaths } from '../src/root-binding-paths.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { hashA, hashB, workspaceId } from './fixtures.js';

function candidate(document: unknown) {
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

function targetSources() {
  const target = richAgentSource();
  target.agent_id = '00000000-0000-7000-8000-000000000098';
  target.agent_release_id = '00000000-0000-7000-8000-000000000099';
  const targetPin = {
    ...prepareExecutableSource(candidate(target)).root.pin,
    published_resource_kind: 'AGENT_RELEASE' as const,
  };
  const agent = richAgentSource();
  const parentBinding = agent.capability_bindings.find(
    (item) => item.kind === 'subagent' && item.target_kind === 'internal_agent',
  );
  if (parentBinding === undefined) throw new Error('fixture internal SubAgent Binding is missing');
  parentBinding.pin = targetPin;
  return { agent, target, targetPin, parentBinding };
}

function compiledClosure(target: ReturnType<typeof richAgentSource>) {
  const prepared = prepareExecutableSource(candidate(target));
  const paths = prepareRootBindingPaths(candidate(target));
  const document = prepared.preimage.document as unknown as {
    capability_bindings: typeof target.capability_bindings;
  };
  const sourceBindings = new Map(
    document.capability_bindings.map((binding) => [binding.binding_id, binding]),
  );
  const plugin = document.capability_bindings.find((binding) => binding.kind === 'plugin');
  if (plugin === undefined || plugin.kind !== 'plugin')
    throw new Error('fixture plugin is missing');
  const pluginOperation = prepareOperationContractSource({
    schema_version: 'operation-contract-source/1',
    operation_kind: 'plugin_tool',
    operation_id: plugin.config.provider_tool_name,
    input_schema: plugin.input_schema,
    ...(plugin.output_schema === undefined ? {} : { output_schema: plugin.output_schema }),
    side_effect_class: plugin.side_effect.class,
    operation_key_required: plugin.side_effect.operation_key_source !== undefined,
    approval_required: plugin.side_effect.approval === 'required',
  }).pin;
  const assemblyPins = prepared.dependency_manifest.dependencies;
  const resourceNodes = [
    {
      node_id: canonicalResourceNodeId(paths.root.pin),
      intrinsic_policy: {},
      dependency_manifest_hash: prepared.dependency_manifest.manifest_hash,
      node_role: 'root' as const,
      pin: paths.root.pin,
    },
    ...assemblyPins.map((pin) => ({
      node_id: canonicalResourceNodeId(pin),
      intrinsic_policy: {},
      dependency_manifest_hash: hashA,
      node_role: 'dependency' as const,
      pin,
      ...(pin.published_resource_kind === 'AGENT_RELEASE' ||
      pin.published_resource_kind === 'FLOW_VERSION'
        ? { nested_closure_hash: hashA }
        : {}),
    })),
  ].sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id));
  const bindings = paths.bindings
    .map((path) => {
      const source = sourceBindings.get(path.binding_id);
      if (source === undefined) throw new Error('fixture Binding source is missing');
      const operations = source.kind === 'plugin' ? [pluginOperation] : [];
      return {
        binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
        binding_path: path.binding_path,
        binding_path_segments: path.binding_path_segments,
        binding_id: path.binding_id,
        binding_kind: path.binding_kind,
        target: source.pin,
        config_schema_version: source.config.schema_version,
        config_hash: canonicalSha256(source.config),
        source_contract_hash: canonicalSha256(source),
        effective_policy: {
          ...emptyPolicy,
          operation_contract_hashes: operations.map((op) => op.contract_hash),
        },
        operation_contracts: operations,
        dependency_node_ids: [canonicalResourceNodeId(source.pin)],
        ...(source.kind === 'skill_pack' ? { skill_pack_operation_routes: [] } : {}),
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const draft = {
    schema_version: 'compiled-capability-closure/1' as const,
    root: paths.root,
    assembly_pins: assemblyPins,
    bindings,
    gate_specs: [],
    resource_nodes: resourceNodes,
    dependency_edges: [],
    disabled_binding_paths: paths.source_disabled_binding_paths,
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
  dependency: PublishedResourcePinV1,
  nestedClosureHash: string,
  dependencies: readonly PublishedResourcePinV1[],
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
    root_dependencies: [dependency],
    resources: [
      {
        schema_version: 'pinned-dependency-record/1',
        pin: dependency,
        publication_state: 'sealed',
        dependency_manifest: deriveDependencyManifest(owner(dependency), dependencies),
        nested_closure_hash: nestedClosureHash,
      },
      ...dependencies.map((pin) => ({
        schema_version: 'pinned-dependency-record/1' as const,
        pin,
        publication_state: 'sealed' as const,
        dependency_manifest: deriveDependencyManifest(owner(pin), []),
        ...(pin.published_resource_kind === 'AGENT_RELEASE' ||
        pin.published_resource_kind === 'FLOW_VERSION'
          ? { nested_closure_hash: hashA }
          : {}),
      })),
    ],
  };
  return { candidateGraph, expectedGraph: preparePinnedDependencyGraph(candidateGraph) };
}

function prepared() {
  const sources = targetSources();
  const closure = compiledClosure(sources.target);
  const root = prepareExecutableSource(candidate(sources.agent)).root;
  const evidence = graph(
    root,
    sources.targetPin,
    closure.closure_hash,
    prepareExecutableSource(candidate(sources.target)).dependency_manifest.dependencies,
  );
  return { ...sources, closure, ...evidence };
}

function subagentCall(agent: ReturnType<typeof richAgentSource>) {
  const binding = agent.capability_bindings.find((item) => item.binding_id === 'subagent');
  if (binding === undefined) throw new Error('fixture SubAgent call Binding is missing');
  return {
    binding_id: binding.binding_id,
    operation: {
      schema_version: 'operation-contract-source/1',
      operation_kind: 'subagent_call',
      operation_id: 'subagent-call',
      input_schema: binding.input_schema,
      ...(binding.output_schema === undefined ? {} : { output_schema: binding.output_schema }),
      side_effect_class: binding.side_effect.class,
      operation_key_required: binding.side_effect.operation_key_source !== undefined,
      approval_required: binding.side_effect.approval === 'required',
    },
  };
}

describe('nested Agent Binding operation projection', () => {
  it('projects child operations onto the parent-prefixed Binding path', () => {
    const value = prepared();
    const result = prepareGraphBoundNestedAgentBindingOperations(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
    );
    const nestedPlugin = result.binding_operations.find(
      (binding) => binding.binding_id === 'plugin' && binding.operation_contracts.length === 1,
    );
    expect(nestedPlugin?.operation_contracts[0]?.operation_kind).toBe('plugin_tool');
    expect(nestedPlugin?.binding_path).not.toBe(
      prepareRootBindingPaths(candidate(value.target)).bindings.find(
        (binding) => binding.binding_id === 'plugin',
      )?.binding_path,
    );
  });

  it('does not leak child operations into the same-ID parent Binding', () => {
    const value = prepared();
    const result = prepareGraphBoundNestedAgentBindingOperations(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
    );
    const plugins = result.binding_operations.filter((binding) => binding.binding_id === 'plugin');
    expect(plugins).toHaveLength(2);
    expect(plugins.map((binding) => binding.operation_contracts.length).sort()).toEqual([0, 1]);
  });

  it('isolates the child operation namespace under two parent mounts', () => {
    const value = targetSources();
    const second = structuredClone(value.parentBinding);
    second.binding_id = 'subagent-second';
    value.agent.capability_bindings.push(second);
    value.agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
    const closure = compiledClosure(value.target);
    const root = prepareExecutableSource(candidate(value.agent)).root;
    const evidence = graph(
      root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    const result = prepareGraphBoundNestedAgentBindingOperations(
      evidence.expectedGraph,
      evidence.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      closure,
    );
    const nestedPlugins = result.binding_operations.filter(
      (binding) => binding.binding_id === 'plugin' && binding.operation_contracts.length === 1,
    );
    expect(nestedPlugins).toHaveLength(2);
    expect(nestedPlugins[0]?.binding_path).not.toBe(nestedPlugins[1]?.binding_path);
  });

  it('rejects a missing direct child Binding even with a recomputed closure hash', () => {
    const value = prepared();
    const draft = {
      ...value.closure,
      bindings: value.closure.bindings.slice(1),
      closure_hash: hashA,
    };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    expect(() =>
      prepareGraphBoundNestedAgentBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('rejects target drift in a direct child Binding after closure resealing', () => {
    const value = prepared();
    const index = value.closure.bindings.findIndex((binding) => binding.binding_id === 'plugin');
    const bindings = structuredClone(value.closure.bindings);
    const binding = bindings[index];
    if (binding === undefined) throw new Error('fixture compiled Binding is missing');
    binding.target.contract_hash = binding.target.contract_hash === hashA ? hashB : hashA;
    const draft = { ...value.closure, bindings, closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    expect(() =>
      prepareGraphBoundNestedAgentBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('rejects a closure not committed by the dependency graph', () => {
    const value = prepared();
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      hashA,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    expect(() =>
      prepareGraphBoundNestedAgentBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        value.closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('rejects a graph manifest that omits child Agent dependencies', () => {
    const value = prepared();
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      value.closure.closure_hash,
      [],
    );
    expect(() =>
      prepareGraphBoundNestedAgentBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        value.closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('rejects a resealed closure assembly that differs from the child Agent source', () => {
    const value = prepared();
    const draft = { ...value.closure, assembly_pins: [], closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    expect(() =>
      prepareGraphBoundNestedAgentBindingOperations(
        evidence.expectedGraph,
        evidence.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        closure,
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

  it('returns path-sorted deeply frozen operation projections', () => {
    const value = prepared();
    const result = prepareGraphBoundNestedAgentBindingOperations(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
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

  it('attaches subagent_call only to the parent path when child reuses the Binding ID', () => {
    const value = prepared();
    const result = prepareGraphBoundAgentSubagentCallOperations(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
      [subagentCall(value.agent)],
    );
    const sameId = result.binding_operations.filter((entry) => entry.binding_id === 'subagent');
    expect(sameId).toHaveLength(2);
    expect(sameId.map((entry) => entry.operation_contracts.length).sort()).toEqual([0, 1]);
    expect(
      sameId.find((entry) => entry.operation_contracts.length === 1)?.operation_contracts[0]
        ?.operation_kind,
    ).toBe('subagent_call');
  });

  it('rejects missing, unknown, and schema-drifted SubAgent call declarations', () => {
    const value = prepared();
    const valid = subagentCall(value.agent);
    const unknown = { ...valid, binding_id: 'unknown' };
    const drifted = structuredClone(valid);
    drifted.operation.input_schema = { type: 'string' };
    for (const declarations of [[], [unknown], [drifted]]) {
      expect(() =>
        prepareGraphBoundAgentSubagentCallOperations(
          value.expectedGraph,
          value.candidateGraph,
          candidate(value.agent),
          candidate(value.target),
          value.closure,
          declarations,
        ),
      ).toThrow('CAPABILITY_OPERATION_CONTRACT_MISMATCH');
    }
  });
});
