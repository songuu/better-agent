import {
  CapabilityRequirementExpressionV1Schema,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';
import {
  prepareAgentCapabilityClosure,
  verifyAgentClosureApprovalCoverage,
} from '../src/agent-capability-closure.js';
import { prepareGraphBoundAgentFlowCallOperations } from '../src/agent-child-call-operations.js';
import {
  prepareAgentFlowBindingEntries,
  prepareAgentSubagentBindingEntries,
} from '../src/agent-composite-binding-entries.js';
import { prepareFlowGateSpecs } from '../src/agent-gate-specs.js';
import { prepareAgentRootBindingEntrySet } from '../src/agent-root-binding-entry-set.js';
import { prepareAgentRootResourceGraph } from '../src/agent-root-resource-graph.js';
import {
  canonicalBindingPath,
  canonicalResourceNodeId,
  createClosureIdentityRegistry,
} from '../src/closure-identity.js';
import {
  compareCanonicalStrings,
  deriveDependencyManifest,
  normalizeDependencyPins,
} from '../src/dependency-manifest.js';
import { deriveExecutableCompiledHash, prepareExecutableSource } from '../src/executable-source.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import { prepareCompiledCapabilityClosure } from '../src/compiled-capability-closure.js';
import { prepareGraphBoundNestedFlowBindingOperations } from '../src/nested-flow-binding-operations.js';
import { prepareOperationContractSource } from '../src/operation-contract-source.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { prepareFlowNodePaths, prepareRootBindingPaths } from '../src/root-binding-paths.js';
import { resolveExecutionPlan, verifyResolvedExecutionPlan } from '../src/resolved-plan.js';
import { compiledAgentAdmission } from './resolved-plan-compiler-fixtures.js';
import { richAgentSource } from './executable-source-fixtures.js';
import {
  callCapabilityRequirements,
  emptyCapabilityRequirementExpression,
  emptyCapabilityRequirements,
  hashA,
  hashB,
  makeFlowIr,
  makePluginPin,
  workspaceId,
} from './fixtures.js';
import { ceiling } from './policy-fixtures.js';

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

function sources(secondMount = false, disabled = false) {
  const pluginPin = makePluginPin();
  const flow = structuredClone({ ...makeFlowIr(), resources: [pluginPin] }) as unknown as {
    resources: PublishedResourcePinV1[];
    entry_graph: {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    [key: string]: unknown;
  };
  flow.entry_graph.nodes[1] = {
    node_id: 'output-1',
    key: 'output',
    type: 'human_gate',
    inputs: {},
    output_schema: { type: 'object' },
    config: {
      gate: {
        schema_version: 'human-gate/1',
        gate_spec_id: 'flow-input',
        kind: 'approval',
        decision_schema: { type: 'object' },
        decision_schema_hash: hashA,
        approver_policy_ref: 'flow-policy',
        approver_policy_hash: hashB,
        expires_after_seconds: 30,
        on_reject: 'fail_run',
        on_expire: 'cancel_run',
        gate_spec_hash: hashA,
        protected_operation_contract_hashes: [hashB],
      },
      prompt: {},
      operation_intent: {},
      exports: {},
    },
  };
  const flowRoot = prepareExecutableSource(executable(flow)).root;
  const flowPin = {
    ...flowRoot.pin,
    contract_hash: deriveExecutableCompiledHash(
      executable(flow),
      compiledClosure(flow).closure_hash,
    ),
    published_resource_kind: 'FLOW_VERSION' as const,
  };
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find((item) => item.kind === 'flow');
  if (binding === undefined) throw new Error('fixture Flow Binding is missing');
  binding.pin = flowPin;
  binding.enabled = !disabled;
  if (secondMount) {
    const second = structuredClone(binding);
    second.binding_id = 'flow-second';
    agent.capability_bindings.push(second);
    agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
  }
  return { agent, flow, flowPin, pluginPin };
}

function compiledClosure(flow: { resources: PublishedResourcePinV1[]; [key: string]: unknown }) {
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
  const operationRequirementExpression = {
    ...emptyCapabilityRequirementExpression,
    requirements: {
      ...emptyCapabilityRequirements,
      operation_contract_hashes: [operation.contract_hash],
    },
  };
  const assemblyPins = normalizeDependencyPins(workspaceId, flow.resources);
  const targetOwner = {
    workspace_id: target.workspace_id,
    published_resource_kind: target.published_resource_kind,
    resource_id: target.resource_id,
    resource_version_id: target.resource_version_id,
  };
  const binding = {
    binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
    binding_path: sourcePath.source_path,
    binding_path_segments: sourcePath.source_path_segments,
    binding_id: 'flow',
    binding_kind: 'plugin' as const,
    admission_requirement: 'optional' as const,
    target,
    config_schema_version: 'plugin-binding/1' as const,
    config_hash: canonicalSha256({ schema_version: 'plugin-binding/1' }),
    source_contract_hash: canonicalSha256({ node_id: sourcePath.node_id }),
    requirement_expression: operationRequirementExpression,
    effective_policy: { ...emptyPolicy, operation_contract_hashes: [operation.contract_hash] },
    operation_contracts: [operation],
    dependency_node_ids: [canonicalResourceNodeId(target)],
  };
  const resourceNodes = [
    {
      node_id: canonicalResourceNodeId(paths.root.pin),
      intrinsic_policy: operationRequirementExpression,
      dependency_manifest_hash: prepared.dependency_manifest.manifest_hash,
      node_role: 'root' as const,
      pin: paths.root.pin,
    },
    {
      node_id: canonicalResourceNodeId(target),
      intrinsic_policy: emptyCapabilityRequirementExpression,
      dependency_manifest_hash: deriveDependencyManifest(targetOwner, []).manifest_hash,
      node_role: 'dependency' as const,
      pin: target,
    },
  ].sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id));
  const draft = {
    schema_version: 'compiled-capability-closure/1' as const,
    root: paths.root,
    assembly_pins: assemblyPins,
    bindings: [binding],
    gate_specs: prepareFlowGateSpecs(executable(flow)).gate_specs,
    resource_nodes: resourceNodes,
    dependency_edges: [],
    disabled_binding_paths: [],
    aggregate_limits: { ...emptyPolicy, operation_contract_hashes: [operation.contract_hash] },
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

function repinChild(value: ReturnType<typeof sources>, closureHash: string) {
  value.flowPin = {
    ...value.flowPin,
    contract_hash: deriveExecutableCompiledHash(executable(value.flow), closureHash),
  };
  for (const binding of value.agent.capability_bindings) {
    if (
      binding.kind === 'flow' &&
      binding.pin.resource_version_id === value.flowPin.resource_version_id
    )
      binding.pin = value.flowPin;
  }
}

function prepared(secondMount = false, disabled = false) {
  const value = sources(secondMount, disabled);
  const closure = compiledClosure(value.flow);
  const root = prepareExecutableSource(executable(value.agent)).root;
  const evidence = graph(root, value.flowPin, closure.closure_hash, value.pluginPin);
  return { ...value, closure, ...evidence };
}

function minimalPrepared(disabled = false) {
  const value = sources(false, disabled);
  const binding = value.agent.capability_bindings.find((item) => item.binding_id === 'flow');
  if (binding === undefined) throw new Error('fixture Flow Binding is missing');
  value.agent.capability_bindings = [binding];
  value.agent.strategy.allowed_capability_binding_ids = [binding.binding_id];
  value.agent.strategy.allowed_gate_spec_ids = [];
  value.agent.instruction_skill_bindings = [];
  value.agent.public_capability_handles = [];
  value.agent.gate_specs = [];
  const closure = compiledClosure(value.flow);
  const root = prepareExecutableSource(executable(value.agent)).root;
  const evidence = graph(root, value.flowPin, closure.closure_hash, value.pluginPin);
  return { ...value, closure, ...evidence };
}

function flowCall(agent: ReturnType<typeof richAgentSource>, bindingId = 'flow') {
  const binding = agent.capability_bindings.find((item) => item.binding_id === bindingId);
  if (binding === undefined) throw new Error('fixture Flow call Binding is missing');
  return {
    binding_id: bindingId,
    requirements: callCapabilityRequirements,
    operation: {
      schema_version: 'operation-contract-source/1',
      operation_kind: 'flow_call',
      operation_id: `${bindingId}-call`,
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
  bindingId = 'flow',
  closure?: {
    readonly bindings: readonly {
      readonly operation_contracts: readonly { readonly contract_hash: string }[];
    }[];
  },
) {
  const declaration = flowCall(agent, bindingId);
  const operation = prepareOperationContractSource(declaration.operation).pin;
  const path = prepareRootBindingPaths(executable(agent)).bindings.find(
    (item) => item.binding_id === bindingId,
  );
  if (path === undefined) throw new Error('fixture Flow path is missing');
  const allowed = {
    ...ceiling(),
    operation_contract_hashes: [
      operation.contract_hash,
      ...(closure?.bindings.flatMap((entry) =>
        entry.operation_contracts.map((candidate) => candidate.contract_hash),
      ) ?? []),
    ].sort(),
  };
  return {
    schema_version: 'agent-composite-binding-policy-input/1',
    workspace_ceiling: allowed,
    root_ceiling: allowed,
    binding_ceilings: [{ binding_path: path.binding_path, ceiling: allowed }],
  };
}

describe('nested Flow Binding operation projection', () => {
  it.each(['semantic-seed', 'closure-hash', 'other-closure'] as const)(
    'rejects a self-consistent published Flow graph using %s as its contract hash',
    (substitution) => {
      const value = prepared();
      const wrongPin = {
        ...value.flowPin,
        contract_hash:
          substitution === 'semantic-seed'
            ? value.closure.root.semantic_seed_hash
            : substitution === 'closure-hash'
              ? value.closure.closure_hash
              : deriveExecutableCompiledHash(executable(value.flow), hashB),
      };
      const binding = value.agent.capability_bindings.find((item) => item.kind === 'flow');
      if (binding === undefined) throw new Error('fixture Flow Binding is missing');
      binding.pin = wrongPin;
      const evidence = graph(
        prepareExecutableSource(executable(value.agent)).root,
        wrongPin,
        value.closure.closure_hash,
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
      ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
    },
  );

  it.each([false, true])(
    'seals and admits Agent→Agent→Flow with two mounts per level and disabled=%s',
    (disabled) => {
      const value = minimalPrepared(disabled);
      const first = value.agent.capability_bindings[0];
      if (first === undefined) throw new Error('fixture Flow Binding is missing');
      const second = { ...structuredClone(first), binding_id: 'flow-second' };
      value.agent.capability_bindings.push(second);
      value.agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
      const source = prepareExecutableSource(executable(value.agent));
      const candidateGraph = {
        ...value.candidateGraph,
        root: source.root,
        root_dependencies: source.dependency_manifest.dependencies,
        resources: [
          ...value.candidateGraph.resources,
          ...source.dependency_manifest.dependencies
            .filter(
              (pin) =>
                !value.candidateGraph.resources.some(
                  (node) => node.pin.resource_version_id === pin.resource_version_id,
                ),
            )
            .map((pin) => ({
              schema_version: 'pinned-dependency-record/1',
              pin,
              publication_state: 'sealed',
              dependency_manifest: deriveDependencyManifest(
                {
                  workspace_id: pin.workspace_id,
                  published_resource_kind: pin.published_resource_kind,
                  resource_id: pin.resource_id,
                  resource_version_id: pin.resource_version_id,
                },
                [],
              ),
            })),
        ],
      };
      const expectedGraph = preparePinnedDependencyGraph(candidateGraph);
      const policy = compositePolicy(value.agent, 'flow', value.closure);
      const secondPolicy = compositePolicy(value.agent, second.binding_id, value.closure);
      const sharedCeiling = {
        ...policy.root_ceiling,
        operation_contract_hashes: [
          ...new Set([
            ...policy.root_ceiling.operation_contract_hashes,
            ...secondPolicy.root_ceiling.operation_contract_hashes,
          ]),
        ].sort(),
      };
      const fullPolicy = {
        ...policy,
        workspace_ceiling: sharedCeiling,
        root_ceiling: sharedCeiling,
        binding_ceilings: [...policy.binding_ceilings, ...secondPolicy.binding_ceilings],
      };
      const slice = prepareAgentFlowBindingEntries(
        expectedGraph,
        candidateGraph,
        executable(value.agent),
        executable(value.flow),
        value.closure,
        [flowCall(value.agent), flowCall(value.agent, second.binding_id)],
        fullPolicy,
      );
      const entries = prepareAgentRootBindingEntrySet(
        executable(value.agent),
        expectedGraph.graph_hash,
        [slice],
        { ...fullPolicy, schema_version: 'agent-root-binding-policy-input/1' },
      );
      const closure = prepareAgentCapabilityClosure(
        executable(value.agent),
        expectedGraph,
        entries,
      );
      expect(closure.gate_specs).toHaveLength(2);
      expect(new Set(closure.gate_specs.map((gate) => gate.source_node_id))).toEqual(
        new Set([canonicalResourceNodeId(value.flowPin)]),
      );
      for (const gate of closure.gate_specs) {
        if (gate.source_kind !== 'flow_node') throw new Error('expected Flow gate');
        expect(gate.source_binding_path_segments.at(-1)).toMatchObject({
          owner: { owner_kind: 'published_dependency', pin: value.flowPin },
        });
      }
      const plan = resolveExecutionPlan(compiledAgentAdmission(executable(value.agent), closure));
      expect(verifyResolvedExecutionPlan(plan, plan.plan_hash)).toEqual(plan);
      expect(plan.root_release.contract_hash).not.toBe(closure.root.semantic_seed_hash);
      expect(plan.enabled_bindings.map((binding) => binding.binding_path).sort()).toEqual(
        disabled ? [] : closure.bindings.map((binding) => binding.binding_path).sort(),
      );
      expect(plan.disabled_binding_paths).toEqual(
        disabled ? closure.bindings.map((binding) => binding.binding_path).sort() : [],
      );

      // Compile a real parent of the sealed Agent: the Flow is now a grandchild,
      // so only the Agent's local root owners may be rewritten during projection.
      const parent = richAgentSource();
      parent.agent_id = '00000000-0000-7000-8000-000000000096';
      parent.agent_release_id = '00000000-0000-7000-8000-000000000097';
      const mount = parent.capability_bindings.find(
        (binding) => binding.kind === 'subagent' && binding.target_kind === 'internal_agent',
      );
      if (mount === undefined) throw new Error('fixture Agent mount missing');
      const childPin = {
        ...source.root.pin,
        published_resource_kind: 'AGENT_RELEASE' as const,
        contract_hash: deriveExecutableCompiledHash(executable(value.agent), closure.closure_hash),
      };
      mount.pin = childPin;
      const secondAgent = { ...structuredClone(mount), binding_id: 'subagent-second' };
      parent.capability_bindings = [mount, secondAgent];
      parent.strategy.allowed_capability_binding_ids = [mount.binding_id, secondAgent.binding_id];
      parent.strategy.allowed_gate_spec_ids = [];
      parent.instruction_skill_bindings = [];
      parent.public_capability_handles = [];
      parent.gate_specs = [];
      const parentSource = prepareExecutableSource(executable(parent));
      const parentCandidate = {
        schema_version: 'pinned-dependency-graph-candidate/1',
        root: parentSource.root,
        root_dependencies: parentSource.dependency_manifest.dependencies,
        resources: [
          ...candidateGraph.resources,
          {
            schema_version: 'pinned-dependency-record/1',
            pin: childPin,
            publication_state: 'sealed',
            dependency_manifest: source.dependency_manifest,
            nested_closure_hash: closure.closure_hash,
          },
        ],
      };
      const parentGraph = preparePinnedDependencyGraph(parentCandidate);
      const declarations = parent.capability_bindings.map((binding) => ({
        binding_id: binding.binding_id,
        requirements: callCapabilityRequirements,
        operation: {
          schema_version: 'operation-contract-source/1',
          operation_kind: 'subagent_call',
          operation_id: `${binding.binding_id}-call`,
          input_schema: binding.input_schema,
          ...(binding.output_schema === undefined ? {} : { output_schema: binding.output_schema }),
          side_effect_class: binding.side_effect.class,
          operation_key_required: binding.side_effect.operation_key_source !== undefined,
          approval_required: binding.side_effect.approval === 'required',
        },
      }));
      const parentCeiling = {
        ...ceiling(),
        operation_contract_hashes: [
          ...new Set([
            ...declarations.map(
              (declaration) =>
                prepareOperationContractSource(declaration.operation).pin.contract_hash,
            ),
            ...closure.bindings.flatMap((binding) =>
              binding.operation_contracts.map((operation) => operation.contract_hash),
            ),
          ]),
        ].sort(),
      };
      const parentPolicy = {
        schema_version: 'agent-composite-binding-policy-input/1',
        workspace_ceiling: parentCeiling,
        root_ceiling: parentCeiling,
        binding_ceilings: prepareRootBindingPaths(executable(parent)).bindings.map((binding) => ({
          binding_path: binding.binding_path,
          ceiling: parentCeiling,
        })),
      };
      const parentSlice = prepareAgentSubagentBindingEntries(
        parentGraph,
        parentCandidate,
        executable(parent),
        executable(value.agent),
        closure,
        declarations,
        parentPolicy,
      );
      const parentEntries = prepareAgentRootBindingEntrySet(
        executable(parent),
        parentGraph.graph_hash,
        [parentSlice],
        { ...parentPolicy, schema_version: 'agent-root-binding-policy-input/1' },
      );
      const parentClosure = prepareAgentCapabilityClosure(
        executable(parent),
        parentGraph,
        parentEntries,
      );
      expect(parentClosure.gate_specs).toHaveLength(4);
      for (const gate of parentClosure.gate_specs) {
        if (gate.source_kind !== 'flow_node') throw new Error('expected recursive Flow gate');
        expect(gate.source_node_id).toBe(canonicalResourceNodeId(value.flowPin));
        expect(gate.source_binding_path_segments[2]).toEqual({
          segment_kind: 'subagent_target',
          target_pin: childPin,
        });
        expect(gate.source_binding_path_segments[3]).toMatchObject({
          owner: { owner_kind: 'published_dependency', pin: childPin },
        });
        expect(gate.source_binding_path_segments.at(-1)).toMatchObject({
          owner: { owner_kind: 'published_dependency', pin: value.flowPin },
        });
      }
      const parentPlan = resolveExecutionPlan(
        compiledAgentAdmission(executable(parent), parentClosure),
      );
      expect(verifyResolvedExecutionPlan(parentPlan, parentPlan.plan_hash)).toEqual(parentPlan);
      expect(parentPlan.enabled_bindings).toHaveLength(disabled ? 2 : 10);
      expect(parentPlan.disabled_binding_paths).toHaveLength(disabled ? 8 : 0);
      for (const entry of parentClosure.bindings.filter(
        (binding) => binding.binding_kind === 'flow',
      )) {
        expect(entry.operation_contracts).toHaveLength(1);
        expect(entry.operation_contracts[0]?.operation_kind).toBe('flow_call');
        expect(entry.effective_policy.operation_contract_hashes).toEqual(
          entry.operation_contracts.map((operation) => operation.contract_hash),
        );
      }

      if (!disabled)
        for (const mutation of ['invocation', 'child-demand'] as const) {
          const changed = { ...structuredClone(closure) };
          const entry = changed.bindings.find((binding) => binding.binding_kind === 'flow');
          if (entry?.requirement_expression.expression_kind !== 'nested_call')
            throw new Error('nested-call fixture missing');
          if (mutation === 'invocation')
            entry.requirement_expression.invocation.operation_contract_hashes = [hashB];
          else
            entry.requirement_expression = {
              ...entry.requirement_expression,
              child: CapabilityRequirementExpressionV1Schema.parse(
                emptyCapabilityRequirementExpression,
              ),
            };
          changed.closure_hash = canonicalSha256ExcludingRootKeys(changed, ['closure_hash']);
          prepareCompiledCapabilityClosure(changed);
          const changedPin = {
            ...childPin,
            contract_hash: deriveExecutableCompiledHash(
              executable(value.agent),
              changed.closure_hash,
            ),
          };
          const changedParent = structuredClone(parent);
          for (const binding of changedParent.capability_bindings) binding.pin = changedPin;
          const changedSource = prepareExecutableSource(executable(changedParent));
          const changedCandidate = {
            ...parentCandidate,
            root: changedSource.root,
            root_dependencies: changedSource.dependency_manifest.dependencies,
            resources: parentCandidate.resources.map((node) =>
              node.pin.resource_version_id === childPin.resource_version_id
                ? { ...node, pin: changedPin, nested_closure_hash: changed.closure_hash }
                : node,
            ),
          };
          const changedGraph = preparePinnedDependencyGraph(changedCandidate);
          const changedPolicy = {
            ...parentPolicy,
            binding_ceilings: prepareRootBindingPaths(executable(changedParent)).bindings.map(
              (binding) => ({
                binding_path: binding.binding_path,
                ceiling: parentCeiling,
              }),
            ),
          };
          expect(() =>
            prepareAgentSubagentBindingEntries(
              changedGraph,
              changedCandidate,
              executable(changedParent),
              executable(value.agent),
              changed,
              declarations,
              changedPolicy,
            ),
          ).toThrow(
            mutation === 'invocation'
              ? /descendant requirement expression does not bind/
              : /exact target resource demand/,
          );
        }

      if (disabled) return;
      const forgedEntries = structuredClone(parentEntries);
      const forged = forgedEntries.descendant_binding_entries.find(
        (binding) => binding.binding_kind === 'flow',
      );
      if (forged === undefined) throw new Error('recursive Flow Binding missing');
      const ownerSegment = forged.binding_path_segments[3];
      if (ownerSegment?.segment_kind !== 'binding')
        throw new Error('Agent-owned Binding segment missing');
      ownerSegment.owner.pin = closure.root.pin;
      forged.binding_path = canonicalBindingPath(forged.binding_path_segments);
      const sortedForgery = {
        ...forgedEntries,
        descendant_binding_entries: [...forgedEntries.descendant_binding_entries].sort(
          (left, right) => compareCanonicalStrings(left.binding_path, right.binding_path),
        ),
      };
      expect(() =>
        prepareAgentCapabilityClosure(executable(parent), parentGraph, sortedForgery),
      ).toThrow('descendant Binding shape is unsupported');
    },
  );
  it('joins the actual published compiled Flow pin rather than its semantic seed', () => {
    const value = prepared();
    const publishedPin = {
      ...value.flowPin,
      contract_hash: deriveExecutableCompiledHash(
        executable(value.flow),
        value.closure.closure_hash,
      ),
    };
    expect(publishedPin.contract_hash).not.toBe(value.closure.root.semantic_seed_hash);
    const binding = value.agent.capability_bindings.find((item) => item.kind === 'flow');
    if (binding === undefined) throw new Error('fixture Flow Binding is missing');
    binding.pin = publishedPin;
    const evidence = graph(
      prepareExecutableSource(executable(value.agent)).root,
      publishedPin,
      value.closure.closure_hash,
      value.pluginPin,
    );
    const result = prepareGraphBoundNestedFlowBindingOperations(
      evidence.expectedGraph,
      evidence.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
    );
    expect(result.dependency_resource_node.pin).toEqual(publishedPin);
  });
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
    expect(projected?.requirement_expression).toEqual(
      value.closure.bindings[0]?.requirement_expression,
    );
    expect(Object.isFrozen(projected?.requirement_expression)).toBe(true);
    expect(projected?.binding_path).not.toBe(value.closure.bindings[0]?.binding_path);
    expect(result.dependency_resource_node).toMatchObject({
      node_role: 'dependency',
      pin: value.flowPin,
      intrinsic_policy: value.closure.resource_nodes.find((node) => node.node_role === 'root')
        ?.intrinsic_policy,
    });
    expect(Object.isFrozen(result.dependency_resource_node.intrinsic_policy)).toBe(true);
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
    expect(result.projected_binding_entries).toHaveLength(value.closure.bindings.length * 2);
    expect(new Set(result.projected_binding_entries.map((entry) => entry.binding_path)).size).toBe(
      value.closure.bindings.length * 2,
    );
    expect(result.projected_gate_specs).toHaveLength(2);
    expect(
      new Set(
        result.projected_gate_specs
          .filter((gate) => gate.source_kind === 'flow_node')
          .map((gate) => gate.source_binding_path),
      ).size,
    ).toBe(2);
    const parentPaths = prepareRootBindingPaths(executable(value.agent)).bindings.filter(
      (path) => path.binding_kind === 'flow',
    );
    for (const gate of result.projected_gate_specs) {
      if (gate.source_kind !== 'flow_node') throw new Error('expected projected Flow gate');
      expect(gate.source_node_id).toBe(canonicalResourceNodeId(value.flowPin));
      const parent = parentPaths.find((path) =>
        path.binding_path_segments.every(
          (segment, index) =>
            JSON.stringify(segment) === JSON.stringify(gate.source_binding_path_segments[index]),
        ),
      );
      expect(parent).toBeDefined();
      const boundary =
        gate.source_binding_path_segments[parent?.binding_path_segments.length ?? -1];
      expect(boundary).toMatchObject({
        segment_kind: 'flow_node',
        owner: { owner_kind: 'published_dependency' },
      });
    }
    const binding = structuredClone(result.projected_binding_entries[0]?.entry);
    const operationHash = binding?.operation_contracts[0]?.contract_hash;
    if (binding === undefined || operationHash === undefined) {
      throw new Error('projected Flow operation is missing');
    }
    const wrongMountGate = result.projected_gate_specs.find(
      (gate) =>
        gate.source_kind === 'flow_node' &&
        JSON.stringify(
          gate.source_binding_path_segments.slice(0, parentPaths[0]?.binding_path_segments.length),
        ) !==
          JSON.stringify(
            binding.binding_path_segments.slice(0, parentPaths[0]?.binding_path_segments.length),
          ),
    );
    if (wrongMountGate === undefined) throw new Error('second-mount Gate is missing');
    binding.approval_gate_spec = {
      gate_spec_id: wrongMountGate.gate_spec_id,
      gate_spec_hash: wrongMountGate.gate_spec_hash,
    };
    const gate = { ...wrongMountGate, protected_operation_contract_hashes: [operationHash] };
    const rootSource = prepareExecutableSource(executable(value.agent));
    const resourceNodes = [
      {
        node_id: canonicalResourceNodeId(rootSource.root.pin),
        intrinsic_policy: CapabilityRequirementExpressionV1Schema.parse(
          emptyCapabilityRequirementExpression,
        ),
        dependency_manifest_hash: rootSource.dependency_manifest.manifest_hash,
        node_role: 'root' as const,
        pin: rootSource.root.pin,
      },
      ...result.projected_resource_nodes,
    ].sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id));
    expect(() =>
      verifyAgentClosureApprovalCoverage([binding], [gate], { resource_nodes: resourceNodes }),
    ).toThrow('COMPILED_CAPABILITY_CLOSURE_INVALID');
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
    repinChild(value, closure.closure_hash);
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

  it('rejects a resealed Flow closure that omits source-owned GateSpecs', () => {
    const value = prepared();
    const draft = { ...value.closure, gate_specs: [], closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
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

  it('rejects a resealed Flow closure with altered source-owned GateSpec content', () => {
    const value = prepared();
    const gateSpecs = structuredClone(value.closure.gate_specs);
    const gate = gateSpecs[0];
    if (gate === undefined) throw new Error('fixture Flow GateSpec is missing');
    gate.on_expire = 'fail_run';
    const draft = { ...value.closure, gate_specs: gateSpecs, closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
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

  it('rejects a resealed Flow GateSpec whose digest path disagrees with retained segments', () => {
    const value = prepared();
    const gateSpecs = structuredClone(value.closure.gate_specs);
    const gate = gateSpecs[0];
    if (gate?.source_kind !== 'flow_node') throw new Error('fixture Flow GateSpec is missing');
    gate.source_binding_path = `bp1.${'A'.repeat(43)}`;
    const draft = { ...value.closure, gate_specs: gateSpecs, closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
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
    ).toThrow('CLOSURE_IDENTITY_MISMATCH');
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
    repinChild(value, closure.closure_hash);
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

  it('attaches flow_call only to the parent mount path and preserves same-ID child operations', () => {
    const value = prepared();
    const result = prepareGraphBoundAgentFlowCallOperations(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
      [flowCall(value.agent)],
    );
    const sameId = result.binding_operations.filter((entry) => entry.binding_id === 'flow');
    expect(sameId).toHaveLength(2);
    expect(sameId.map((entry) => entry.operation_contracts[0]?.operation_kind).sort()).toEqual([
      'flow_call',
      'plugin_tool',
    ]);
    const parent = sameId.find(
      (entry) => entry.operation_contracts[0]?.operation_kind === 'flow_call',
    );
    expect(parent?.invocation_requirements?.operation_contract_hashes).toEqual([
      parent?.operation_contracts[0]?.contract_hash,
    ]);
    expect(
      sameId.find((entry) => entry.operation_contracts[0]?.operation_kind === 'plugin_tool'),
    ).not.toHaveProperty('invocation_requirements');
  });

  it('requires one independently verified call declaration for every Flow mount', () => {
    const value = prepared(true);
    expect(() =>
      prepareGraphBoundAgentFlowCallOperations(
        value.expectedGraph,
        value.candidateGraph,
        executable(value.agent),
        executable(value.flow),
        value.closure,
        [flowCall(value.agent)],
      ),
    ).toThrow('CAPABILITY_OPERATION_CONTRACT_MISMATCH');
    const result = prepareGraphBoundAgentFlowCallOperations(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
      [flowCall(value.agent), flowCall(value.agent, 'flow-second')],
    );
    expect(
      result.binding_operations.filter(
        (entry) => entry.operation_contracts[0]?.operation_kind === 'flow_call',
      ),
    ).toHaveLength(2);
  });

  it('rejects a wrong-kind or duplicate Flow call declaration', () => {
    const value = prepared();
    const declaration = flowCall(value.agent);
    const wrong = structuredClone(declaration);
    wrong.operation.operation_kind = 'subagent_call';
    for (const declarations of [[wrong], [declaration, declaration]]) {
      expect(() =>
        prepareGraphBoundAgentFlowCallOperations(
          value.expectedGraph,
          value.candidateGraph,
          executable(value.agent),
          executable(value.flow),
          value.closure,
          declarations,
        ),
      ).toThrow('CAPABILITY_OPERATION_CONTRACT_MISMATCH');
    }
  });

  it('compiles a Flow parent entry without copying child operations onto the mount', () => {
    const value = prepared();
    const declaration = flowCall(value.agent);
    const result = prepareAgentFlowBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
      [declaration],
      compositePolicy(value.agent, 'flow', value.closure),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      binding_kind: 'flow',
      admission_requirement: 'optional',
      operation_contracts: [prepareOperationContractSource(declaration.operation).pin],
      effective_policy: {
        operation_contract_hashes: [
          prepareOperationContractSource(declaration.operation).pin.contract_hash,
        ],
      },
    });
    expect(result.requirement_expressions[0]?.expression.expression_kind).toBe('nested_call');
  });

  it('recompiles every child Flow Binding under the parent-relative namespace', () => {
    const value = prepared();
    const result = prepareAgentFlowBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
      [flowCall(value.agent)],
      compositePolicy(value.agent, 'flow', value.closure),
    );
    expect(result.descendant_binding_entries).toHaveLength(value.closure.bindings.length);
    const descendant = result.descendant_binding_entries[0];
    const source = value.closure.bindings[0];
    expect(descendant?.binding_path).not.toBe(source?.binding_path);
    expect(
      descendant?.binding_path_segments.slice(0, result.entries[0]?.binding_path_segments.length),
    ).toEqual(result.entries[0]?.binding_path_segments);
    expect(descendant?.effective_policy.operation_contract_hashes).toEqual(
      source?.operation_contracts.map((operation) => operation.contract_hash),
    );
  });

  it('fails closed when a Flow parent does not authorize a descendant operation', () => {
    const value = prepared();
    const policy = compositePolicy(value.agent, 'flow', value.closure);
    const callHash = prepareOperationContractSource(flowCall(value.agent).operation).pin
      .contract_hash;
    const parentOnly = (item: (typeof policy)['root_ceiling']) => ({
      ...item,
      operation_contract_hashes: [callHash],
    });
    expect(() =>
      prepareAgentFlowBindingEntries(
        value.expectedGraph,
        value.candidateGraph,
        executable(value.agent),
        executable(value.flow),
        value.closure,
        [flowCall(value.agent)],
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

  it('marks projected Flow descendants unavailable when the parent mount is disabled', () => {
    const value = prepared(false, true);
    const result = prepareAgentFlowBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
      [flowCall(value.agent)],
      compositePolicy(value.agent, 'flow', value.closure),
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

  it('keeps a source-disabled Flow descendant unavailable after projection', () => {
    const value = prepared();
    const disabledPath = value.closure.bindings[0]?.binding_path;
    if (disabledPath === undefined) throw new Error('fixture Flow Binding is missing');
    const draft = { ...value.closure, disabled_binding_paths: [disabledPath], closure_hash: hashA };
    const closure = {
      ...draft,
      closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
    };
    repinChild(value, closure.closure_hash);
    const evidence = graph(
      prepareExecutableSource(executable(value.agent)).root,
      value.flowPin,
      closure.closure_hash,
      value.pluginPin,
    );
    const result = prepareAgentFlowBindingEntries(
      evidence.expectedGraph,
      evidence.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      closure,
      [flowCall(value.agent)],
      compositePolicy(value.agent, 'flow', closure),
    );
    expect(result.descendant_disabled_binding_paths).toEqual([
      result.descendant_binding_entries[0]?.binding_path,
    ]);
    expect(result.descendant_binding_entries[0]?.effective_policy).toMatchObject({
      principal_modes: [],
      max_calls: 0,
    });
  });

  it('retains only parent-owned Flow descendants through the root entry assembler', () => {
    const value = minimalPrepared();
    const policy = compositePolicy(value.agent, 'flow', value.closure);
    const slice = prepareAgentFlowBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
      [flowCall(value.agent)],
      policy,
    );
    const assemble = (candidateSlice: unknown) =>
      prepareAgentRootBindingEntrySet(
        executable(value.agent),
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
          edge.from_node_id === canonicalResourceNodeId(value.flowPin) &&
          edge.to_node_id === projectedTarget?.dependency_node_ids[0] &&
          edge.source_path === projectedTarget.binding_path,
      ),
    ).toBe(true);

    const outsideParent = structuredClone(slice);
    const injected = outsideParent.descendant_binding_entries[0];
    const sourceEntry = value.closure.bindings[0];
    if (injected === undefined || sourceEntry === undefined) {
      throw new Error('fixture descendant Binding is missing');
    }
    injected.binding_path_segments = Array.from(sourceEntry.binding_path_segments);
    injected.binding_path = sourceEntry.binding_path;
    expect(() => assemble(outsideParent)).toThrow('CLOSURE_BINDING_ENTRY_NOT_CLOSED');
  });

  it('retains a disabled Flow parent entry but excludes it from root intrinsic demand', () => {
    const value = prepared(false, true);
    const result = prepareAgentFlowBindingEntries(
      value.expectedGraph,
      value.candidateGraph,
      executable(value.agent),
      executable(value.flow),
      value.closure,
      [flowCall(value.agent)],
      compositePolicy(value.agent, 'flow', value.closure),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.requirement_expressions).toEqual([]);
  });
});
