import {
  CompiledBindingEntryV1Schema,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';
import { prepareGraphBoundAgentSubagentCallOperations } from '../src/agent-child-call-operations.js';
import { prepareAgentSubagentBindingEntries } from '../src/agent-composite-binding-entries.js';
import { prepareAgentCapabilityClosure } from '../src/agent-capability-closure.js';
import { prepareAgentGateSpecs } from '../src/agent-gate-specs.js';
import { prepareAgentRootBindingEntrySet } from '../src/agent-root-binding-entry-set.js';
import {
  prepareAgentRootResourceGraph,
  withinRecursiveResourceGraphCapacity,
} from '../src/agent-root-resource-graph.js';
import { canonicalBindingPath, canonicalResourceNodeId } from '../src/closure-identity.js';
import { prepareCompiledCapabilityClosure } from '../src/compiled-capability-closure.js';
import { compareCanonicalStrings, deriveDependencyManifest } from '../src/dependency-manifest.js';
import { deriveExecutableCompiledHash, prepareExecutableSource } from '../src/executable-source.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import { prepareGraphBoundNestedAgentBindingOperations } from '../src/nested-agent-binding-operations.js';
import { projectNestedGateSpecs } from '../src/nested-gate-spec-projection.js';
import { prepareOperationContractSource } from '../src/operation-contract-source.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import {
  accumulateProjectedBindingCapacity,
  withinProjectedBindingCapacity,
} from '../src/projection-capacity.js';
import { prepareRootBindingPaths } from '../src/root-binding-paths.js';
import { bindingAdmissionEvidence } from '../src/required-binding-call.js';
import { resolveExecutionPlan, verifyResolvedExecutionPlan } from '../src/resolved-plan.js';
import { compiledAgentAdmission } from './resolved-plan-compiler-fixtures.js';
import { richAgentSource } from './executable-source-fixtures.js';
import {
  callCapabilityRequirements,
  emptyCapabilityRequirementExpression,
  emptyCapabilityRequirements,
  hashA,
  hashB,
  workspaceId,
} from './fixtures.js';
import { ceiling } from './policy-fixtures.js';

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

function targetSources(parentEnabled = true) {
  const target = richAgentSource();
  target.agent_id = '00000000-0000-7000-8000-000000000098';
  target.agent_release_id = '00000000-0000-7000-8000-000000000099';
  const targetPin = {
    ...prepareExecutableSource(candidate(target)).root.pin,
    contract_hash: deriveExecutableCompiledHash(
      candidate(target),
      compiledClosure(target).closure_hash,
    ),
    published_resource_kind: 'AGENT_RELEASE' as const,
  };
  const agent = richAgentSource();
  const parentBinding = agent.capability_bindings.find(
    (item) => item.kind === 'subagent' && item.target_kind === 'internal_agent',
  );
  if (parentBinding === undefined) throw new Error('fixture internal SubAgent Binding is missing');
  parentBinding.pin = targetPin;
  parentBinding.enabled = parentEnabled;
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
  const rootRequirementExpression = plugin.enabled
    ? {
        ...emptyCapabilityRequirementExpression,
        requirements: {
          ...emptyCapabilityRequirements,
          operation_contract_hashes: [pluginOperation.contract_hash],
        },
      }
    : emptyCapabilityRequirementExpression;
  const resourceNodes = [
    {
      node_id: canonicalResourceNodeId(paths.root.pin),
      intrinsic_policy: rootRequirementExpression,
      dependency_manifest_hash: prepared.dependency_manifest.manifest_hash,
      node_role: 'root' as const,
      pin: paths.root.pin,
    },
    ...assemblyPins.map((pin) => ({
      node_id: canonicalResourceNodeId(pin),
      intrinsic_policy: emptyCapabilityRequirementExpression,
      dependency_manifest_hash: deriveDependencyManifest(
        {
          workspace_id: pin.workspace_id,
          published_resource_kind: pin.published_resource_kind,
          resource_id: pin.resource_id,
          resource_version_id: pin.resource_version_id,
        },
        [],
      ).manifest_hash,
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
      const requirementExpression =
        operations.length === 0
          ? emptyCapabilityRequirementExpression
          : {
              ...emptyCapabilityRequirementExpression,
              requirements: {
                ...emptyCapabilityRequirements,
                operation_contract_hashes: operations.map((operation) => operation.contract_hash),
              },
            };
      return {
        binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
        binding_path: path.binding_path,
        binding_path_segments: path.binding_path_segments,
        binding_id: path.binding_id,
        binding_kind: path.binding_kind,
        ...bindingAdmissionEvidence(source),
        target: source.pin,
        config_schema_version: source.config.schema_version,
        config_hash: canonicalSha256(source.config),
        source_contract_hash: canonicalSha256(source),
        requirement_expression: requirementExpression,
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
    gate_specs: prepareAgentGateSpecs(candidate(target)).gate_specs,
    resource_nodes: resourceNodes,
    dependency_edges: [],
    disabled_binding_paths: paths.source_disabled_binding_paths,
    aggregate_limits: {
      ...emptyPolicy,
      operation_contract_hashes: plugin.enabled ? [pluginOperation.contract_hash] : [],
    },
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
  rootDependencies: readonly PublishedResourcePinV1[] = [dependency],
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
    root_dependencies: rootDependencies,
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

function repinChild(value: ReturnType<typeof targetSources>, closureHash: string) {
  value.targetPin = {
    ...value.targetPin,
    contract_hash: deriveExecutableCompiledHash(candidate(value.target), closureHash),
  };
  for (const binding of value.agent.capability_bindings) {
    if (
      binding.kind === 'subagent' &&
      binding.pin.resource_version_id === value.targetPin.resource_version_id
    )
      binding.pin = value.targetPin;
  }
}

function prepared(parentEnabled = true) {
  const sources = targetSources(parentEnabled);
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

function minimalPrepared(parentEnabled = true) {
  const sources = targetSources(parentEnabled);
  sources.agent.capability_bindings = [sources.parentBinding];
  sources.agent.strategy.allowed_capability_binding_ids = [sources.parentBinding.binding_id];
  sources.agent.strategy.allowed_gate_spec_ids = [];
  sources.agent.instruction_skill_bindings = [];
  sources.agent.public_capability_handles = [];
  sources.agent.gate_specs = [];
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
    requirements: callCapabilityRequirements,
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

function compositePolicy(
  agent: ReturnType<typeof richAgentSource>,
  closure?: {
    readonly bindings: readonly {
      readonly operation_contracts: readonly { readonly contract_hash: string }[];
    }[];
  },
) {
  const declaration = subagentCall(agent);
  const operation = prepareOperationContractSource(declaration.operation).pin;
  const path = prepareRootBindingPaths(candidate(agent)).bindings.find(
    (item) => item.binding_id === declaration.binding_id,
  );
  if (path === undefined) throw new Error('fixture SubAgent path is missing');
  const allowed = {
    ...ceiling(),
    operation_contract_hashes: [
      ...new Set([
        operation.contract_hash,
        ...(closure?.bindings.flatMap((binding) =>
          binding.operation_contracts.map((candidate) => candidate.contract_hash),
        ) ?? []),
      ]),
    ].sort(),
  };
  return {
    schema_version: 'agent-composite-binding-policy-input/1',
    workspace_ceiling: allowed,
    root_ceiling: allowed,
    binding_ceilings: [{ binding_path: path.binding_path, ceiling: allowed }],
  };
}

describe('nested Agent Binding operation projection', () => {
  it.each(['semantic-seed', 'closure-hash', 'other-closure'] as const)(
    'rejects a self-consistent published Agent graph using %s as its contract hash',
    (substitution) => {
      const value = prepared();
      const wrongPin = {
        ...value.targetPin,
        contract_hash:
          substitution === 'semantic-seed'
            ? value.closure.root.semantic_seed_hash
            : substitution === 'closure-hash'
              ? value.closure.closure_hash
              : deriveExecutableCompiledHash(candidate(value.target), hashB),
      };
      value.parentBinding.pin = wrongPin;
      const evidence = graph(
        prepareExecutableSource(candidate(value.agent)).root,
        wrongPin,
        value.closure.closure_hash,
        value.closure.assembly_pins,
      );
      expect(() =>
        prepareGraphBoundNestedAgentBindingOperations(
          evidence.expectedGraph,
          evidence.candidateGraph,
          candidate(value.agent),
          candidate(value.target),
          value.closure,
        ),
      ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
    },
  );
  it('joins the actual published compiled Agent pin rather than its semantic seed', () => {
    const value = prepared();
    const publishedPin = {
      ...value.targetPin,
      contract_hash: deriveExecutableCompiledHash(
        candidate(value.target),
        value.closure.closure_hash,
      ),
    };
    expect(publishedPin.contract_hash).not.toBe(value.closure.root.semantic_seed_hash);
    value.parentBinding.pin = publishedPin;
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      publishedPin,
      value.closure.closure_hash,
      value.closure.assembly_pins,
    );
    const result = prepareGraphBoundNestedAgentBindingOperations(
      evidence.expectedGraph,
      evidence.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
    );
    expect(result.dependency_resource_node.pin).toEqual(publishedPin);
  });
  it('bounds recursive graph edge fan-out at the exact closure limit', () => {
    expect(withinRecursiveResourceGraphCapacity(8_190, [1, 1])).toBe(true);
    expect(withinRecursiveResourceGraphCapacity(8_190, [1, 2])).toBe(false);
    expect(withinRecursiveResourceGraphCapacity(0, [Number.MAX_SAFE_INTEGER])).toBe(false);
  });

  it('accepts the exact projection capacity and rejects one entry above it', () => {
    expect(withinProjectedBindingCapacity(128, 64)).toBe(true);
    expect(withinProjectedBindingCapacity(129, 64)).toBe(false);
    const firstChildCount = accumulateProjectedBindingCapacity(0, 64, 64);
    expect(firstChildCount).toBe(4_096);
    expect(accumulateProjectedBindingCapacity(firstChildCount ?? -1, 64, 64)).toBe(8_192);
    expect(accumulateProjectedBindingCapacity(firstChildCount ?? -1, 4_097, 1)).toBeUndefined();
  });

  it('enforces the GateSpec projection bound at 8,192 real projected entries', () => {
    const value = targetSources();
    const closure = prepareCompiledCapabilityClosure(compiledClosure(value.target));
    const targetPath = prepareRootBindingPaths(candidate(value.agent)).bindings.find(
      (path) => path.binding_id === value.parentBinding.binding_id,
    );
    if (targetPath === undefined) throw new Error('fixture parent path is missing');
    const mount = [
      ...targetPath.binding_path_segments,
      { segment_kind: 'subagent_target' as const, target_pin: value.targetPin },
    ];
    expect(closure.gate_specs).toHaveLength(2);
    expect(
      projectNestedGateSpecs(
        closure,
        Array.from({ length: 4_096 }, () => mount),
        { node_id: canonicalResourceNodeId(value.targetPin), pin: value.targetPin },
      ),
    ).toHaveLength(2);
    expect(() =>
      projectNestedGateSpecs(
        closure,
        Array.from({ length: 4_097 }, () => mount),
        { node_id: canonicalResourceNodeId(value.targetPin), pin: value.targetPin },
      ),
    ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
  });

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
    expect(nestedPlugin?.requirement_expression).toEqual(
      value.closure.bindings.find((binding) => binding.binding_id === 'plugin')
        ?.requirement_expression,
    );
    expect(Object.isFrozen(nestedPlugin?.requirement_expression)).toBe(true);
    expect(nestedPlugin?.binding_path).not.toBe(
      prepareRootBindingPaths(candidate(value.target)).bindings.find(
        (binding) => binding.binding_id === 'plugin',
      )?.binding_path,
    );
    expect(result.dependency_resource_node).toMatchObject({
      node_role: 'dependency',
      pin: value.targetPin,
      intrinsic_policy: value.closure.resource_nodes.find((node) => node.node_role === 'root')
        ?.intrinsic_policy,
    });
    expect(Object.isFrozen(result.dependency_resource_node.intrinsic_policy)).toBe(true);
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

  it('carries a non-empty verified child-root policy without caller substitution', () => {
    const value = prepared();
    const resourceNodes = structuredClone(value.closure.resource_nodes) as unknown as Array<
      Record<string, unknown>
    >;
    const rootNode = resourceNodes.find((node) => node.node_role === 'root');
    if (rootNode === undefined) throw new Error('fixture closure root node is missing');
    const intrinsicPolicy = {
      schema_version: 'capability-requirement-expression/1' as const,
      expression_kind: 'leaf' as const,
      requirements: {
        ...emptyCapabilityRequirements,
        readable_data_classification: 'internal' as const,
        minimum_limits: {
          ...emptyCapabilityRequirements.minimum_limits,
          calls: 1,
        },
      },
    };
    rootNode.intrinsic_policy = intrinsicPolicy;
    const draft = {
      ...value.closure,
      resource_nodes: resourceNodes,
      aggregate_limits: { ...value.closure.aggregate_limits, max_calls: 1 },
      closure_hash: hashA,
    };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    const result = prepareGraphBoundNestedAgentBindingOperations(
      evidence.expectedGraph,
      evidence.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      prepareCompiledCapabilityClosure(closure),
    );
    expect(result.dependency_resource_node.intrinsic_policy).toEqual(intrinsicPolicy);
  });

  it('rewrites source-owned GateSpecs to the graph-committed child node identity', () => {
    const value = targetSources();
    const publishedPin = value.targetPin;
    const closure = compiledClosure(value.target);
    const targetPath = prepareRootBindingPaths(candidate(value.agent)).bindings.find(
      (path) => path.binding_id === value.parentBinding.binding_id,
    );
    if (targetPath === undefined) throw new Error('fixture parent path is missing');
    const projected = projectNestedGateSpecs(
      prepareCompiledCapabilityClosure(closure),
      [
        [
          ...targetPath.binding_path_segments,
          { segment_kind: 'subagent_target', target_pin: value.targetPin },
        ],
      ],
      { node_id: canonicalResourceNodeId(publishedPin), pin: publishedPin },
    );
    expect(new Set(projected.map((gate) => gate.source_node_id))).toEqual(
      new Set([canonicalResourceNodeId(publishedPin)]),
    );
  });

  it.each(['enabled', 'source-disabled', 'large-gate-fanout'] as const)(
    'isolates two parent mounts with %s forced knowledge',
    (mode) => {
      const value = targetSources();
      const knowledge = value.target.capability_bindings.find(
        (binding) => binding.kind === 'knowledge',
      );
      if (knowledge?.kind !== 'knowledge' || knowledge.config.selection !== 'force')
        throw new Error('forced knowledge fixture missing');
      if (mode === 'source-disabled') knowledge.enabled = false;
      if (mode === 'large-gate-fanout') {
        const gate = value.target.gate_specs.find((item) => item.gate_spec_id === 'input');
        if (gate === undefined) throw new Error('input gate missing');
        gate.approver_policy_ref = 'x'.repeat(65_536);
        knowledge.config.forced_execution.on_timeout = 'ask_user';
        knowledge.config.forced_execution.on_timeout_gate_spec = {
          gate_spec_id: gate.gate_spec_id,
          gate_spec_hash: gate.gate_spec_hash,
        };
        for (let index = 1; index < 129; index += 1) {
          const copy = structuredClone(knowledge);
          if (copy.config.selection !== 'force') throw new Error('forced configuration missing');
          copy.binding_id = `forced-${index}`;
          copy.config.forced_execution.order = index;
          delete copy.credential_requirement;
          value.target.capability_bindings.push(copy);
        }
      }
      const closure = compiledClosure(value.target);
      value.targetPin = {
        ...prepareExecutableSource(candidate(value.target)).root.pin,
        contract_hash: deriveExecutableCompiledHash(candidate(value.target), closure.closure_hash),
        published_resource_kind: 'AGENT_RELEASE' as const,
      };
      value.parentBinding.pin = value.targetPin;
      const second = structuredClone(value.parentBinding);
      second.binding_id = 'subagent-second';
      value.agent.capability_bindings = [value.parentBinding, second];
      value.agent.strategy.allowed_capability_binding_ids = [
        value.parentBinding.binding_id,
        second.binding_id,
      ];
      value.agent.strategy.allowed_gate_spec_ids = [];
      value.agent.instruction_skill_bindings = [];
      value.agent.public_capability_handles = [];
      value.agent.gate_specs = [];
      const root = prepareExecutableSource(candidate(value.agent)).root;
      const evidence = graph(
        root,
        value.targetPin,
        closure.closure_hash,
        prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
        prepareExecutableSource(candidate(value.agent)).dependency_manifest.dependencies,
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
      expect(result.projected_binding_entries).toHaveLength(closure.bindings.length * 2);
      expect(
        new Set(result.projected_binding_entries.map((entry) => entry.binding_path)).size,
      ).toBe(closure.bindings.length * 2);
      expect(result.projected_gate_specs).toEqual(
        closure.gate_specs.map((gate) => ({
          ...gate,
          source_node_id: canonicalResourceNodeId(value.targetPin),
        })),
      );

      const calls = [
        subagentCall(value.agent),
        { ...subagentCall(value.agent), binding_id: second.binding_id },
      ];
      const firstPolicy = compositePolicy(value.agent, closure);
      const secondPath = prepareRootBindingPaths(candidate(value.agent)).bindings.find(
        (item) => item.binding_id === second.binding_id,
      );
      if (secondPath === undefined) throw new Error('second SubAgent path is missing');
      const policy = {
        ...firstPolicy,
        binding_ceilings: [
          ...firstPolicy.binding_ceilings,
          {
            binding_path: secondPath.binding_path,
            ceiling: firstPolicy.binding_ceilings[0]?.ceiling,
          },
        ].sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path)),
      };
      const slice = prepareAgentSubagentBindingEntries(
        evidence.expectedGraph,
        evidence.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        closure,
        calls,
        policy,
      );
      const alteredSlice = structuredClone(slice);
      const alteredGate = alteredSlice.descendant_gate_specs[0];
      if (alteredGate === undefined) throw new Error('projected GateSpec is missing');
      alteredGate.on_expire = alteredGate.on_expire === 'fail_run' ? 'cancel_run' : 'fail_run';
      expect(() =>
        prepareAgentRootBindingEntrySet(
          candidate(value.agent),
          evidence.expectedGraph.graph_hash,
          [alteredSlice],
          { ...policy, schema_version: 'agent-root-binding-policy-input/1' },
        ),
      ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
      const entrySet = prepareAgentRootBindingEntrySet(
        candidate(value.agent),
        evidence.expectedGraph.graph_hash,
        [slice],
        { ...policy, schema_version: 'agent-root-binding-policy-input/1' },
      );
      const resourceGraph = prepareAgentRootResourceGraph(evidence.expectedGraph, entrySet);
      const sealedClosure = prepareAgentCapabilityClosure(
        candidate(value.agent),
        evidence.expectedGraph,
        entrySet,
      );
      // The Strategy remains reachable through the child, but cannot replace its root edge.
      const missingRootStrategy = preparePinnedDependencyGraph({
        ...evidence.candidateGraph,
        root_dependencies: evidence.candidateGraph.root_dependencies.filter(
          (pin) => pin.published_resource_kind !== 'AGENT_STRATEGY_RELEASE',
        ),
      });
      expect(() =>
        prepareAgentCapabilityClosure(candidate(value.agent), missingRootStrategy, {
          ...entrySet,
          graph_hash: missingRootStrategy.graph_hash,
        }),
      ).toThrow(/root dependency manifest/);
      expect(sealedClosure.gate_specs).toEqual(result.projected_gate_specs);
      expect(sealedClosure.resource_nodes).toEqual(resourceGraph.resource_nodes);
      const admission = compiledAgentAdmission(candidate(value.agent), sealedClosure);
      if (mode === 'large-gate-fanout') {
        expect(() => resolveExecutionPlan(admission)).toThrow(/CAPABILITY_CLOSURE_LIMIT_EXCEEDED/);
        return;
      }
      const plan = resolveExecutionPlan(admission);
      if (mode === 'source-disabled') {
        expect(plan.required_calls).toEqual([]);
        expect(
          sealedClosure.bindings
            .filter((binding) => binding.binding_id === 'knowledge')
            .every(
              (binding) =>
                binding.admission_requirement === 'optional' && binding.required_call === undefined,
            ),
        ).toBe(true);
        return;
      }
      expect(plan.root_release.contract_hash).not.toBe(sealedClosure.root.semantic_seed_hash);
      expect(verifyResolvedExecutionPlan(plan, plan.plan_hash)).toEqual(plan);
      expect(plan.required_calls).toHaveLength(2);
      expect(plan.required_calls.map((call) => call.order)).toEqual([0, 0]);
      expect(new Set(plan.required_calls.map((call) => call.execution_scope_path)).size).toBe(2);
      expect(plan.required_calls.every((call) => call.on_empty_gate?.kind === 'input')).toBe(true);
      const firstMount = slice.entries[0];
      if (firstMount === undefined) throw new Error('first mount missing');
      const oneMountPaths = sealedClosure.bindings
        .filter(
          (binding) =>
            canonicalBindingPath(
              binding.binding_path_segments.slice(0, firstMount.binding_path_segments.length),
            ) === firstMount.binding_path &&
            !sealedClosure.disabled_binding_paths.includes(binding.binding_path),
        )
        .map((binding) => binding.binding_path);
      expect(
        resolveExecutionPlan(
          compiledAgentAdmission(candidate(value.agent), sealedClosure, oneMountPaths),
        ).required_calls,
      ).toHaveLength(1);
      expect(
        resolveExecutionPlan(compiledAgentAdmission(candidate(value.agent), sealedClosure, []))
          .required_calls,
      ).toEqual([]);
      const withoutOptionalAuthority = compiledAgentAdmission(
        candidate(value.agent),
        sealedClosure,
        [],
      );
      const rootAssemblyPins = prepareExecutableSource(
        candidate(value.agent),
      ).dependency_manifest.dependencies.filter((pin) =>
        ['AGENT_STRATEGY_RELEASE', 'INSTRUCTION_SKILL_RELEASE'].includes(
          pin.published_resource_kind,
        ),
      );
      const rootAssemblyNodeIds = new Set<string>(rootAssemblyPins.map(canonicalResourceNodeId));
      const optionalNodes = sealedClosure.resource_nodes.filter(
        (node) => node.node_role !== 'root' && !rootAssemblyNodeIds.has(node.node_id),
      );
      const optionalIds = new Set(optionalNodes.map((node) => node.pin.resource_version_id));
      const optionalGrantKeys = new Set<string>(
        optionalNodes.map((node) =>
          canonicalSha256({
            schema_version: 'release-grant-identity/1',
            workspace_id: workspaceId,
            authenticated_principal:
              withoutOptionalAuthority.admission_snapshot.authenticated_principal,
            target: node.pin,
          }),
        ),
      );
      const minimalEpochs = withoutOptionalAuthority.authorization_decision.epoch_sources.filter(
        (source) =>
          !optionalIds.has(source.source_id) && !optionalGrantKeys.has(source.source_subkey),
      );
      const minimalDecision = {
        ...withoutOptionalAuthority.authorization_decision,
        epoch_sources: minimalEpochs,
      };
      minimalDecision.decision_hash = canonicalSha256ExcludingRootKeys(minimalDecision, [
        'decision_hash',
      ]);
      expect(
        resolveExecutionPlan({
          ...withoutOptionalAuthority,
          authorization_decision: minimalDecision,
          expected_authorization_epoch_sources: minimalEpochs,
        }).enabled_bindings,
      ).toEqual([]);
      for (const pin of rootAssemblyPins) {
        const epochs = minimalEpochs.filter(
          (source) =>
            !(
              source.source_kind === 'published_release_state' &&
              source.source_id === pin.resource_version_id
            ),
        );
        const missingRootAssembly = { ...minimalDecision, epoch_sources: epochs };
        missingRootAssembly.decision_hash = canonicalSha256ExcludingRootKeys(missingRootAssembly, [
          'decision_hash',
        ]);
        expect(() =>
          resolveExecutionPlan({
            ...withoutOptionalAuthority,
            authorization_decision: missingRootAssembly,
            expected_authorization_epoch_sources: epochs,
          }),
        ).toThrow(/published_release_state/);
      }
      for (const node of sealedClosure.resource_nodes.filter((item) =>
        ['INSTRUCTION_SKILL_RELEASE', 'AGENT_STRATEGY_RELEASE'].includes(
          item.pin.published_resource_kind,
        ),
      )) {
        const epochs = admission.authorization_decision.epoch_sources.filter(
          (source) =>
            !(
              source.source_kind === 'published_release_state' &&
              source.source_id === node.pin.resource_version_id
            ),
        );
        const revoked = { ...admission.authorization_decision, epoch_sources: epochs };
        revoked.decision_hash = canonicalSha256ExcludingRootKeys(revoked, ['decision_hash']);
        expect(() =>
          resolveExecutionPlan({
            ...admission,
            authorization_decision: revoked,
            expected_authorization_epoch_sources: epochs,
          }),
        ).toThrow(/published_release_state/);
      }
      const childOnly = sealedClosure.bindings
        .filter((binding) => binding.admission_requirement === 'forced')
        .map((binding) => binding.binding_path);
      expect(() =>
        resolveExecutionPlan(
          compiledAgentAdmission(candidate(value.agent), sealedClosure, childOnly),
        ),
      ).toThrow(/enabled parent mount/);
      const weakenedEntrySet = structuredClone(entrySet) as unknown as {
        descendant_binding_entries: Record<string, unknown>[];
      };
      const forcedEntry = weakenedEntrySet.descendant_binding_entries.find(
        (entry) => entry.admission_requirement === 'forced',
      );
      if (forcedEntry === undefined) throw new Error('missing projected forced Binding');
      forcedEntry.admission_requirement = 'optional';
      delete forcedEntry.required_call;
      expect(() =>
        prepareAgentCapabilityClosure(
          candidate(value.agent),
          evidence.expectedGraph,
          weakenedEntrySet,
        ),
      ).toThrow(/exact committed child evidence/);
      const missingInputGate = structuredClone(entrySet);
      (
        missingInputGate as unknown as {
          descendant_gate_specs: typeof missingInputGate.descendant_gate_specs;
        }
      ).descendant_gate_specs = missingInputGate.descendant_gate_specs.slice(1);
      expect(() =>
        prepareAgentCapabilityClosure(
          candidate(value.agent),
          evidence.expectedGraph,
          missingInputGate,
        ),
      ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
      const missingGateClosure = structuredClone(entrySet);
      (
        missingGateClosure as unknown as {
          nested_gate_closures: typeof missingGateClosure.nested_gate_closures;
        }
      ).nested_gate_closures = [];
      expect(() =>
        prepareAgentCapabilityClosure(
          candidate(value.agent),
          evidence.expectedGraph,
          missingGateClosure,
        ),
      ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
      const internalTargets = new Set<string>(
        evidence.expectedGraph.nodes
          .filter((node) =>
            ['INSTRUCTION_SKILL_RELEASE', 'AGENT_STRATEGY_RELEASE'].includes(
              node.pin.published_resource_kind,
            ),
          )
          .map((node) => node.node_id),
      );
      const typedEdges = resourceGraph.dependency_edges.filter(
        (edge) =>
          edge.from_node_id === canonicalResourceNodeId(value.targetPin) &&
          edge.relation === 'typed_internal_dependency' &&
          internalTargets.has(edge.to_node_id),
      );
      const expectedSourcePaths = new Set(
        slice.entries.map((entry) =>
          canonicalBindingPath([
            ...entry.binding_path_segments,
            { segment_kind: 'subagent_target', target_pin: entry.target },
          ]),
        ),
      );
      expect(typedEdges).toHaveLength(internalTargets.size * 2);
      for (const targetNodeId of internalTargets) {
        expect(
          new Set(
            typedEdges
              .filter((edge) => edge.to_node_id === targetNodeId)
              .map((edge) => edge.source_path),
          ),
        ).toEqual(expectedSourcePaths);
      }
    },
    // This boundary vector compiles and verifies the full fanout repeatedly;
    // the production 32 MiB/8,192-entry limits remain the actual guard under test.
    15_000,
  );

  it('rejects a resealed child closure that omits source-owned GateSpecs', () => {
    const value = prepared();
    const draft = { ...value.closure, gate_specs: [], closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
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
    ).toThrow(/NESTED_CAPABILITY_CLOSURE_MISMATCH|ask_user requires/);
  });

  it('rejects resealed forced-to-optional and local call-policy drift against the true child source', () => {
    const value = prepared();
    for (const change of ['optional', 'order', 'disposition']) {
      const draft = structuredClone(value.closure) as unknown as {
        bindings: Record<string, unknown>[];
        closure_hash: string;
      };
      const entry = draft.bindings.find((binding) => binding.binding_id === 'knowledge');
      if (entry === undefined) throw new Error('missing forced fixture Binding');
      const call = entry.required_call as Record<string, unknown>;
      if (change === 'optional') {
        entry.admission_requirement = 'optional';
        delete entry.required_call;
      }
      if (change === 'order') call.order = 99;
      if (change === 'disposition') call.on_timeout = 'continue_without_context';
      draft.closure_hash = canonicalSha256ExcludingRootKeys(draft, ['closure_hash']);
      repinChild(value, draft.closure_hash);
      const evidence = graph(
        prepareExecutableSource(candidate(value.agent)).root,
        value.targetPin,
        draft.closure_hash,
        prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
      );
      expect(() =>
        prepareGraphBoundNestedAgentBindingOperations(
          evidence.expectedGraph,
          evidence.candidateGraph,
          candidate(value.agent),
          candidate(value.target),
          draft,
        ),
      ).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');
    }
  });

  it('rejects a resealed child closure with altered source-owned GateSpec content', () => {
    const value = prepared();
    const gateSpecs = structuredClone(value.closure.gate_specs);
    const gate = gateSpecs[0];
    if (gate === undefined) throw new Error('fixture GateSpec is missing');
    gate.approver_policy_ref = 'altered-policy';
    const draft = { ...value.closure, gate_specs: gateSpecs, closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
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
    repinChild(value, closure.closure_hash);
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
    repinChild(value, closure.closure_hash);
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
    repinChild(value, closure.closure_hash);
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
    const parent = sameId.find((entry) => entry.operation_contracts.length === 1);
    const parentOperationHash = parent?.operation_contracts[0]?.contract_hash;
    expect(parent?.invocation_requirements).toMatchObject({
      schema_version: 'capability-requirements/1',
      side_effect_class: 'safe',
      approval_required: false,
      operation_contract_hashes: [parentOperationHash],
      minimum_limits: { calls: 1, parallelism: 1 },
    });
    expect(Object.isFrozen(parent?.invocation_requirements)).toBe(true);
    expect(Object.isFrozen(parent?.invocation_requirements?.minimum_limits)).toBe(true);
    expect(sameId.find((entry) => entry.operation_contracts.length === 0)).not.toHaveProperty(
      'invocation_requirements',
    );
    expect(result.dependency_resource_node).toMatchObject({
      pin: value.targetPin,
      intrinsic_policy: value.closure.resource_nodes.find((node) => node.node_role === 'root')
        ?.intrinsic_policy,
    });
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

  it('rejects absent, zero-cost, and self-authorized invocation requirements', () => {
    const value = prepared();
    const valid = subagentCall(value.agent);
    const absent = { binding_id: valid.binding_id, operation: valid.operation };
    const zeroCost = {
      ...valid,
      requirements: {
        ...valid.requirements,
        minimum_limits: { ...valid.requirements.minimum_limits, calls: 0 },
      },
    };
    const selfAuthorized = {
      ...valid,
      requirements: { ...valid.requirements, side_effect_class: 'unsafe' },
    };
    for (const declaration of [absent, zeroCost, selfAuthorized]) {
      expect(() =>
        prepareGraphBoundAgentSubagentCallOperations(
          value.expectedGraph,
          value.candidateGraph,
          candidate(value.agent),
          candidate(value.target),
          value.closure,
          [declaration],
        ),
      ).toThrow('CAPABILITY_OPERATION_CONTRACT_MISMATCH');
    }
  });

  it('compiles a closed SubAgent parent entry from verified invocation and child policy', () => {
    const value = prepared();
    const result = prepareAgentSubagentBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
      [subagentCall(value.agent)],
      compositePolicy(value.agent, value.closure),
    );
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(CompiledBindingEntryV1Schema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({
      binding_kind: 'subagent',
      admission_requirement: 'optional',
      source_contract_hash: value.targetPin.contract_hash,
      dependency_node_ids: [canonicalResourceNodeId(result.dependency_resource_node.pin)],
      effective_policy: {
        operation_contract_hashes: [entry?.operation_contracts[0]?.contract_hash],
        max_calls: 10,
      },
    });
    expect(result.requirement_expressions[0]?.expression).toMatchObject({
      expression_kind: 'nested_call',
      invocation: { minimum_limits: { calls: 1, parallelism: 1 } },
      child: value.closure.resource_nodes.find((node) => node.node_role === 'root')
        ?.intrinsic_policy,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.requirement_expressions[0]?.expression)).toBe(true);
  });

  it('recompiles every verified child Binding under the parent-relative namespace', () => {
    const value = prepared();
    const result = prepareAgentSubagentBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
      [subagentCall(value.agent)],
      compositePolicy(value.agent, value.closure),
    );
    expect(result.descendant_binding_entries).toHaveLength(value.closure.bindings.length);
    expect(
      result.descendant_binding_entries.every(
        (entry) =>
          CompiledBindingEntryV1Schema.safeParse(entry).success &&
          entry.binding_path_segments[0]?.segment_kind === 'root' &&
          entry.binding_path_segments[1]?.segment_kind === 'binding' &&
          entry.binding_path_segments[2]?.segment_kind === 'subagent_target',
      ),
    ).toBe(true);
    const nestedPlugin = result.descendant_binding_entries.find(
      (entry) => entry.binding_id === 'plugin',
    );
    expect(nestedPlugin?.effective_policy.operation_contract_hashes).toEqual(
      nestedPlugin?.operation_contracts.map((operation) => operation.contract_hash),
    );
    expect(Object.isFrozen(result.descendant_binding_entries)).toBe(true);
  });

  it('retains only parent-owned descendants through the root entry assembler', () => {
    const value = minimalPrepared();
    const policy = compositePolicy(value.agent, value.closure);
    const slice = prepareAgentSubagentBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
      [subagentCall(value.agent)],
      policy,
    );
    const assemble = (candidateSlice: unknown) =>
      prepareAgentRootBindingEntrySet(
        candidate(value.agent),
        value.expectedGraph.graph_hash,
        [candidateSlice],
        { ...policy, schema_version: 'agent-root-binding-policy-input/1' },
      );
    const result = assemble(slice);
    expect(result.entries).toEqual(slice.entries);
    expect(result.descendant_binding_entries).toEqual(slice.descendant_binding_entries);
    expect(Object.isFrozen(result.descendant_binding_entries)).toBe(true);
    const resourceGraph = prepareAgentRootResourceGraph(value.expectedGraph, result);
    expect(resourceGraph.resource_nodes).toHaveLength(value.expectedGraph.nodes.length);
    const projectedTarget = result.descendant_binding_entries[0];
    expect(
      resourceGraph.dependency_edges.some(
        (edge) =>
          edge.from_node_id === canonicalResourceNodeId(value.targetPin) &&
          edge.to_node_id === projectedTarget?.dependency_node_ids[0] &&
          edge.source_path === projectedTarget.binding_path,
      ),
    ).toBe(true);

    const strippedNestedCommitment = structuredClone(result);
    const recursiveEvidence = strippedNestedCommitment.dependency_intrinsic_policies.find(
      (evidence) => evidence.node_id === canonicalResourceNodeId(value.targetPin),
    );
    if (recursiveEvidence === undefined) throw new Error('recursive policy evidence is missing');
    delete (recursiveEvidence as unknown as { nested_closure_hash?: string }).nested_closure_hash;
    expect(() =>
      prepareAgentRootResourceGraph(value.expectedGraph, strippedNestedCommitment),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');

    const mismatchedSliceClosureHash = structuredClone(slice);
    (mismatchedSliceClosureHash as unknown as { nested_closure_hash: string }).nested_closure_hash =
      slice.nested_closure_hash === hashA ? hashB : hashA;
    expect(() => assemble(mismatchedSliceClosureHash)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    const invalidSliceClosureHash = structuredClone(slice);
    (invalidSliceClosureHash as unknown as { nested_closure_hash: string }).nested_closure_hash =
      'not-a-hash';
    expect(() => assemble(invalidSliceClosureHash)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
    const missingProjectedRootClosureHash = structuredClone(slice);
    const projectedRoot = missingProjectedRootClosureHash.dependency_resource_nodes.find(
      (node) => node.node_id === canonicalResourceNodeId(value.targetPin),
    );
    if (projectedRoot === undefined) throw new Error('fixture projected root node is missing');
    delete (projectedRoot as unknown as { nested_closure_hash?: string }).nested_closure_hash;
    expect(() => assemble(missingProjectedRootClosureHash)).toThrow(
      'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    );

    const missingProjectedNode = structuredClone(slice);
    (
      missingProjectedNode as unknown as { dependency_resource_nodes: unknown[] }
    ).dependency_resource_nodes = missingProjectedNode.dependency_resource_nodes.slice(0, -1);
    expect(() =>
      prepareAgentRootResourceGraph(value.expectedGraph, assemble(missingProjectedNode)),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');

    const reorderedProjectedNodes = structuredClone(slice);
    (
      reorderedProjectedNodes as unknown as { dependency_resource_nodes: unknown[] }
    ).dependency_resource_nodes = Array.from(
      reorderedProjectedNodes.dependency_resource_nodes,
    ).reverse();
    expect(() => assemble(reorderedProjectedNodes)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');

    const duplicateProjectedNode = structuredClone(slice);
    const duplicateNode = duplicateProjectedNode.dependency_resource_nodes.find(
      (node) => node.node_id !== canonicalResourceNodeId(value.targetPin),
    );
    if (duplicateNode === undefined) throw new Error('fixture non-root resource node is missing');
    (
      duplicateProjectedNode as unknown as { dependency_resource_nodes: unknown[] }
    ).dependency_resource_nodes = [
      ...duplicateProjectedNode.dependency_resource_nodes,
      duplicateNode,
    ].sort((left, right) =>
      compareCanonicalStrings(
        (left as { node_id: string }).node_id,
        (right as { node_id: string }).node_id,
      ),
    );
    expect(() => assemble(duplicateProjectedNode)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');

    const wrongRoleNode = structuredClone(slice);
    (
      wrongRoleNode as unknown as {
        dependency_resource_nodes: typeof wrongRoleNode.dependency_resource_nodes;
      }
    ).dependency_resource_nodes = wrongRoleNode.dependency_resource_nodes.map((node) => ({
      ...node,
    }));
    const wrongRoleDependency = wrongRoleNode.dependency_resource_nodes.find(
      (node) => node.node_id !== canonicalResourceNodeId(value.targetPin),
    );
    if (wrongRoleDependency === undefined)
      throw new Error('fixture non-root resource node is missing');
    (wrongRoleDependency as unknown as { node_role: string }).node_role = 'root';
    expect(() => assemble(wrongRoleNode)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');

    const wrongNodeId = structuredClone(slice);
    (
      wrongNodeId as unknown as {
        dependency_resource_nodes: typeof wrongNodeId.dependency_resource_nodes;
      }
    ).dependency_resource_nodes = wrongNodeId.dependency_resource_nodes.map((node) => ({
      ...node,
    }));
    const wrongIdentityDependency = wrongNodeId.dependency_resource_nodes.find(
      (node) => node.node_id !== canonicalResourceNodeId(value.targetPin),
    );
    if (wrongIdentityDependency === undefined)
      throw new Error('fixture non-root resource node is missing');
    (wrongIdentityDependency as unknown as { node_id: string }).node_id = `rn1.${'A'.repeat(43)}`;
    (
      wrongNodeId as unknown as {
        dependency_resource_nodes: typeof wrongNodeId.dependency_resource_nodes;
      }
    ).dependency_resource_nodes = Array.from(wrongNodeId.dependency_resource_nodes).sort(
      (left, right) => compareCanonicalStrings(left.node_id, right.node_id),
    );
    expect(() => assemble(wrongNodeId)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');

    const wrongRecursiveCommitment = structuredClone(slice);
    (
      wrongRecursiveCommitment as unknown as {
        dependency_resource_nodes: typeof wrongRecursiveCommitment.dependency_resource_nodes;
      }
    ).dependency_resource_nodes = wrongRecursiveCommitment.dependency_resource_nodes.map(
      (node) => ({ ...node }),
    );
    const nonRootDependency = wrongRecursiveCommitment.dependency_resource_nodes.find(
      (node) => node.node_id !== canonicalResourceNodeId(value.targetPin),
    );
    if (nonRootDependency === undefined) {
      throw new Error('fixture non-root dependency resource node is missing');
    }
    (
      nonRootDependency as unknown as { dependency_manifest_hash: string }
    ).dependency_manifest_hash =
      nonRootDependency.dependency_manifest_hash === hashA ? hashB : hashA;
    expect(() =>
      prepareAgentRootResourceGraph(value.expectedGraph, assemble(wrongRecursiveCommitment)),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');

    const wrongDescendantOwner = structuredClone(slice);
    const wrongOwnerEntry = wrongDescendantOwner.descendant_binding_entries[0];
    const wrongOwnerSegment = wrongOwnerEntry?.binding_path_segments.at(-1);
    if (
      wrongOwnerEntry === undefined ||
      wrongOwnerSegment?.segment_kind !== 'binding' ||
      wrongOwnerSegment.owner.owner_kind !== 'published_dependency'
    ) {
      throw new Error('fixture projected descendant owner is missing');
    }
    wrongOwnerSegment.owner.pin.resource_id = 'wrong-descendant-owner';
    wrongOwnerEntry.binding_path = canonicalBindingPath(wrongOwnerEntry.binding_path_segments);
    (
      wrongDescendantOwner as unknown as {
        descendant_binding_entries: typeof wrongDescendantOwner.descendant_binding_entries;
      }
    ).descendant_binding_entries = Array.from(wrongDescendantOwner.descendant_binding_entries).sort(
      (left, right) => compareCanonicalStrings(left.binding_path, right.binding_path),
    );
    expect(() =>
      prepareAgentRootResourceGraph(value.expectedGraph, assemble(wrongDescendantOwner)),
    ).toThrow(/COMPILED_CAPABILITY_CLOSURE_INVALID|CLOSURE_BINDING_ENTRY_NOT_CLOSED/);

    const wrongDigest = structuredClone(slice);
    const wrongDigestEntry = wrongDigest.descendant_binding_entries[0];
    const sourceEntry = value.closure.bindings[0];
    if (wrongDigestEntry === undefined || sourceEntry === undefined) {
      throw new Error('fixture descendant Binding is missing');
    }
    wrongDigestEntry.binding_path = `bp1.${'A'.repeat(43)}`;
    expect(() => assemble(wrongDigest)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');

    const outsideParent = structuredClone(slice);
    const injected = outsideParent.descendant_binding_entries[0];
    if (injected === undefined) throw new Error('fixture projected descendant is missing');
    injected.binding_path_segments = Array.from(sourceEntry.binding_path_segments);
    injected.binding_path = sourceEntry.binding_path;
    expect(() => assemble(outsideParent)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');

    const swappedDependency = structuredClone(slice);
    swappedDependency.dependency_resource_node.pin.resource_id = 'swapped-agent-dependency';
    (swappedDependency.dependency_resource_node as unknown as { node_id: string }).node_id =
      canonicalResourceNodeId(swappedDependency.dependency_resource_node.pin);
    expect(() => assemble(swappedDependency)).toThrow('NESTED_CAPABILITY_CLOSURE_MISMATCH');

    const disabledValue = minimalPrepared(false);
    const disabledPolicy = compositePolicy(disabledValue.agent, disabledValue.closure);
    const disabledSlice = prepareAgentSubagentBindingEntries(
      disabledValue.expectedGraph,
      disabledValue.candidateGraph,
      candidate(disabledValue.agent),
      candidate(disabledValue.target),
      disabledValue.closure,
      [subagentCall(disabledValue.agent)],
      disabledPolicy,
    );
    const missingDisabledEvidence = structuredClone(disabledSlice);
    (
      missingDisabledEvidence as unknown as { descendant_disabled_binding_paths: string[] }
    ).descendant_disabled_binding_paths = [];
    expect(() =>
      prepareAgentRootBindingEntrySet(
        candidate(disabledValue.agent),
        disabledValue.expectedGraph.graph_hash,
        [missingDisabledEvidence],
        { ...disabledPolicy, schema_version: 'agent-root-binding-policy-input/1' },
      ),
    ).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('never lets a descendant retain a wider numeric ceiling than its parent mount', () => {
    const value = prepared();
    const bindings = structuredClone(value.closure.bindings) as unknown as Array<
      ReturnType<typeof CompiledBindingEntryV1Schema.parse>
    >;
    const plugin = bindings.find((entry) => entry.binding_id === 'plugin');
    if (plugin === undefined) throw new Error('fixture compiled plugin Binding is missing');
    plugin.effective_policy.max_calls = 7;
    const draft = { ...value.closure, bindings, closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    const policy = compositePolicy(value.agent, closure);
    const cap = (item: (typeof policy)['root_ceiling']) => ({ ...item, max_calls: 3 });
    const result = prepareAgentSubagentBindingEntries(
      evidence.expectedGraph,
      evidence.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      closure,
      [subagentCall(value.agent)],
      {
        ...policy,
        workspace_ceiling: cap(policy.workspace_ceiling),
        root_ceiling: cap(policy.root_ceiling),
        binding_ceilings: policy.binding_ceilings.map((item) => ({
          ...item,
          ceiling: cap(item.ceiling),
        })),
      },
    );
    expect(
      result.descendant_binding_entries.find((entry) => entry.binding_id === 'plugin')
        ?.effective_policy.max_calls,
    ).toBe(3);
  });

  it('fails closed when a parent mount does not authorize a descendant operation', () => {
    const value = prepared();
    const policy = compositePolicy(value.agent, value.closure);
    const callHash = prepareOperationContractSource(subagentCall(value.agent).operation).pin
      .contract_hash;
    const parentOnly = (item: (typeof policy)['root_ceiling']) => ({
      ...item,
      operation_contract_hashes: [callHash],
    });
    expect(() =>
      prepareAgentSubagentBindingEntries(
        value.expectedGraph,
        value.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        value.closure,
        [subagentCall(value.agent)],
        {
          ...policy,
          workspace_ceiling: parentOnly(policy.workspace_ceiling),
          root_ceiling: parentOnly(policy.root_ceiling),
          binding_ceilings: policy.binding_ceilings.map((item) => ({
            ...item,
            ceiling: parentOnly(item.ceiling),
          })),
        },
      ),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });

  it('marks every projected descendant unavailable when its parent mount is disabled', () => {
    const value = prepared(false);
    const result = prepareAgentSubagentBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      value.closure,
      [subagentCall(value.agent)],
      compositePolicy(value.agent, value.closure),
    );
    expect(result.descendant_disabled_binding_paths).toEqual(
      result.descendant_binding_entries.map((entry) => entry.binding_path),
    );
    expect(
      result.descendant_binding_entries.every(
        (entry) => entry.effective_policy.principal_modes.length === 0,
      ),
    ).toBe(true);
  });

  it('keeps a source-disabled child Binding disabled after parent-relative projection', () => {
    const sources = targetSources();
    const plugin = sources.target.capability_bindings.find((binding) => binding.kind === 'plugin');
    if (plugin === undefined) throw new Error('fixture target plugin Binding is missing');
    plugin.enabled = false;
    const targetPin = {
      ...prepareExecutableSource(candidate(sources.target)).root.pin,
      contract_hash: deriveExecutableCompiledHash(
        candidate(sources.target),
        compiledClosure(sources.target).closure_hash,
      ),
      published_resource_kind: 'AGENT_RELEASE' as const,
    };
    sources.parentBinding.pin = targetPin;
    const closure = compiledClosure(sources.target);
    const evidence = graph(
      prepareExecutableSource(candidate(sources.agent)).root,
      targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(sources.target)).dependency_manifest.dependencies,
    );
    const result = prepareAgentSubagentBindingEntries(
      evidence.expectedGraph,
      evidence.candidateGraph,
      candidate(sources.agent),
      candidate(sources.target),
      closure,
      [subagentCall(sources.agent)],
      compositePolicy(sources.agent, closure),
    );
    const projectedPlugin = result.descendant_binding_entries.find(
      (entry) => entry.binding_id === plugin.binding_id,
    );
    if (projectedPlugin === undefined) throw new Error('projected plugin Binding is missing');
    expect(result.descendant_disabled_binding_paths).toContain(projectedPlugin.binding_path);
    expect(projectedPlugin.effective_policy).toMatchObject({
      principal_modes: [],
      max_calls: 0,
      operation_contract_hashes: projectedPlugin.operation_contracts.map(
        (operation) => operation.contract_hash,
      ),
    });
  });

  it('reprojects Pack routes and propagates a disabled ancestor to its member descendant', () => {
    const value = prepared();
    const bindings = structuredClone(value.closure.bindings) as unknown as Array<
      ReturnType<typeof CompiledBindingEntryV1Schema.parse>
    >;
    const pack = bindings.find((entry) => entry.binding_kind === 'skill_pack');
    const plugin = bindings.find((entry) => entry.binding_kind === 'plugin');
    if (
      pack === undefined ||
      pack.target.published_resource_kind !== 'SKILL_PACK_RELEASE' ||
      plugin === undefined ||
      plugin.operation_contracts[0] === undefined
    ) {
      throw new Error('fixture Pack/plugin Binding is missing');
    }
    const memberSegments = [
      ...pack.binding_path_segments,
      {
        segment_kind: 'skill_pack_member' as const,
        owner_pin: { ...pack.target, published_resource_kind: 'SKILL_PACK_RELEASE' as const },
        local_member_binding_id: 'projected-member',
      },
    ];
    const memberPath = canonicalBindingPath(memberSegments);
    const member = {
      ...plugin,
      binding_id: 'projected-member',
      binding_path: memberPath,
      binding_path_segments: memberSegments,
    };
    const routeContent = {
      pack_binding_path: pack.binding_path,
      exposed_operation_id: 'projected-operation',
      exposed_operation_contract_hash: plugin.operation_contracts[0].contract_hash,
      member_binding_path: memberPath,
      member_target: plugin.target,
      member_operation_contract_hash: plugin.operation_contracts[0].contract_hash,
    };
    pack.requirement_expression = plugin.requirement_expression;
    pack.effective_policy = {
      ...plugin.effective_policy,
      side_effect: { ...plugin.effective_policy.side_effect, approval: 'required' },
    };
    pack.operation_contracts = plugin.operation_contracts;
    pack.approval_gate_spec = { gate_spec_id: 'pack-binding-approval', gate_spec_hash: hashB };
    pack.skill_pack_operation_routes = [
      {
        ...routeContent,
        route_hash: canonicalSha256({
          schema_version: 'skill-pack-operation-route-preimage/1',
          ...routeContent,
        }),
      },
    ];
    bindings.push(member);
    bindings.sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
    const draft = {
      ...value.closure,
      bindings,
      disabled_binding_paths: [pack.binding_path],
      closure_hash: hashA,
    };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    const result = prepareAgentSubagentBindingEntries(
      evidence.expectedGraph,
      evidence.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      closure,
      [subagentCall(value.agent)],
      compositePolicy(value.agent, closure),
    );
    const projectedPack = result.descendant_binding_entries.find(
      (entry) => entry.binding_id === pack.binding_id,
    );
    const projectedMember = result.descendant_binding_entries.find(
      (entry) => entry.binding_id === member.binding_id,
    );
    if (projectedPack === undefined || projectedMember === undefined) {
      throw new Error('projected Pack/member Binding is missing');
    }
    const projectedRoute = projectedPack.skill_pack_operation_routes?.[0];
    if (projectedRoute === undefined) throw new Error('projected Pack route is missing');
    expect(projectedRoute).toMatchObject({
      pack_binding_path: projectedPack.binding_path,
      member_binding_path: projectedMember.binding_path,
    });
    const { route_hash: _routeHash, ...projectedRouteContent } = projectedRoute;
    expect(projectedRoute.route_hash).toBe(
      canonicalSha256({
        schema_version: 'skill-pack-operation-route-preimage/1',
        ...projectedRouteContent,
      }),
    );
    expect(projectedRoute.route_hash).not.toBe(pack.skill_pack_operation_routes[0]?.route_hash);
    expect(projectedPack.effective_policy.side_effect.approval).toBe('required');
    expect(projectedPack.approval_gate_spec).toEqual(pack.approval_gate_spec);
    expect(result.descendant_disabled_binding_paths).toEqual(
      [projectedPack.binding_path, projectedMember.binding_path].sort(compareCanonicalStrings),
    );
    expect(projectedMember.effective_policy.principal_modes).toEqual([]);
    const projectedSibling = result.descendant_binding_entries.find(
      (entry) => entry.binding_id === plugin.binding_id,
    );
    expect(projectedSibling?.effective_policy.principal_modes.length).toBeGreaterThan(0);
    expect(result.descendant_disabled_binding_paths).not.toContain(projectedSibling?.binding_path);
  });

  it('requires the exact composite path ceiling set and sufficient aggregate limits', () => {
    const value = prepared();
    const validPolicy = compositePolicy(value.agent, value.closure);
    const missing = { ...validPolicy, binding_ceilings: [] };
    const duplicate = {
      ...validPolicy,
      binding_ceilings: [...validPolicy.binding_ceilings, ...validPolicy.binding_ceilings],
    };
    const underProvisioned = {
      ...validPolicy,
      binding_ceilings: validPolicy.binding_ceilings.map((item) => ({
        ...item,
        ceiling: { ...item.ceiling, max_depth: 0 },
      })),
    };
    for (const policy of [missing, duplicate, underProvisioned]) {
      expect(() =>
        prepareAgentSubagentBindingEntries(
          value.expectedGraph,
          value.candidateGraph,
          candidate(value.agent),
          candidate(value.target),
          value.closure,
          [subagentCall(value.agent)],
          policy,
        ),
      ).toThrow();
    }
  });

  it('proves child operations against the ceiling without copying them onto the parent entry', () => {
    const value = prepared();
    const resourceNodes = structuredClone(value.closure.resource_nodes) as unknown as Array<
      Record<string, unknown>
    >;
    const rootNode = resourceNodes.find((node) => node.node_role === 'root');
    if (rootNode === undefined) throw new Error('fixture closure root node is missing');
    rootNode.intrinsic_policy = {
      schema_version: 'capability-requirement-expression/1',
      expression_kind: 'leaf',
      requirements: { ...emptyCapabilityRequirements, operation_contract_hashes: [hashB] },
    };
    const draft = { ...value.closure, resource_nodes: resourceNodes, closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
    const evidence = graph(
      prepareExecutableSource(candidate(value.agent)).root,
      value.targetPin,
      closure.closure_hash,
      prepareExecutableSource(candidate(value.target)).dependency_manifest.dependencies,
    );
    const declaration = subagentCall(value.agent);
    const policy = compositePolicy(value.agent, value.closure);
    expect(() =>
      prepareAgentSubagentBindingEntries(
        evidence.expectedGraph,
        evidence.candidateGraph,
        candidate(value.agent),
        candidate(value.target),
        closure,
        [declaration],
        policy,
      ),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
    const allowChild = (candidatePolicy: (typeof policy)['root_ceiling']) => ({
      ...candidatePolicy,
      operation_contract_hashes: [...candidatePolicy.operation_contract_hashes, hashB].sort(),
    });
    const result = prepareAgentSubagentBindingEntries(
      evidence.expectedGraph,
      evidence.candidateGraph,
      candidate(value.agent),
      candidate(value.target),
      closure,
      [declaration],
      {
        ...policy,
        workspace_ceiling: allowChild(policy.workspace_ceiling),
        root_ceiling: allowChild(policy.root_ceiling),
        binding_ceilings: policy.binding_ceilings.map((item) => ({
          ...item,
          ceiling: allowChild(item.ceiling),
        })),
      },
    );
    expect(result.entries[0]?.effective_policy.operation_contract_hashes).toEqual([
      result.entries[0]?.operation_contracts[0]?.contract_hash,
    ]);
    expect(result.requirement_expressions[0]?.expression).toMatchObject({
      child: { requirements: { operation_contract_hashes: [hashB] } },
    });
  });
});
