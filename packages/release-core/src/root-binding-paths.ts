import type {
  BindingPathSegmentV1Schema,
  CapabilityBindingV1,
  FlowGraphV1,
} from '@better-agent/domain-contracts';

import { createClosureIdentityRegistry, type ClosureIdentityRegistry } from './closure-identity.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  publishedResourcePinKey,
} from './dependency-manifest.js';
import { prepareExecutableSource, type PreparedExecutableSourceV1 } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';
import { prepareLeafResourceSource, verifyLeafResourceBindings } from './leaf-resource-source.js';
import {
  prepareSkillPackSource,
  type SkillPackExposedOperationV1,
  verifySkillPackBindings,
} from './skill-pack-source.js';

type BindingPathSegmentV1 = ReturnType<typeof BindingPathSegmentV1Schema.parse>;

interface CompiledRootBindingPathV1 {
  readonly binding_id: string;
  readonly binding_kind: CapabilityBindingV1['kind'];
  readonly binding_path: `bp1.${string}`;
  readonly binding_path_segments: readonly BindingPathSegmentV1[];
  readonly enabled: boolean;
}

interface RootBindingPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly bindings: readonly CompiledRootBindingPathV1[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

interface CompiledFlowNodePathV1 {
  readonly graph_id: string;
  readonly node_id: string;
  readonly node_type: string;
  readonly source_path: `bp1.${string}`;
  readonly source_path_segments: readonly BindingPathSegmentV1[];
}

interface FlowNodePaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly nodes: readonly CompiledFlowNodePathV1[];
}

interface AgentFlowDependencyPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly dependency: PreparedExecutableSourceV1['root'];
  readonly bindings: readonly (CompiledRootBindingPathV1 & {
    readonly nodes: readonly CompiledFlowNodePathV1[];
  })[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

interface CompiledSkillPackMemberPathV1 {
  readonly member_binding_id: string;
  readonly member_binding_kind: CapabilityBindingV1['kind'];
  readonly member_binding_path: `bp1.${string}`;
  readonly member_binding_path_segments: readonly BindingPathSegmentV1[];
  readonly enabled: boolean;
  readonly target: CapabilityBindingV1['pin'];
}

interface AgentSkillPackDependencyPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly dependency: ReturnType<typeof prepareSkillPackSource>['full_pin'];
  readonly bindings: readonly (CompiledRootBindingPathV1 & {
    readonly members: readonly CompiledSkillPackMemberPathV1[];
    readonly selected_exposed_operations: readonly {
      readonly exposed_operation_id: string;
      readonly exposed_operation_contract_hash: string;
    }[];
  })[];
  readonly exposed_operations: readonly SkillPackExposedOperationV1[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

interface CompiledSubagentTargetBindingPathV1 {
  readonly binding_id: string;
  readonly binding_kind: CapabilityBindingV1['kind'];
  readonly binding_path: `bp1.${string}`;
  readonly binding_path_segments: readonly BindingPathSegmentV1[];
  readonly enabled: boolean;
  readonly target: CapabilityBindingV1['pin'];
}

interface CompiledInternalSubagentTargetPathV1 {
  readonly target_path: `bp1.${string}`;
  readonly target_path_segments: readonly BindingPathSegmentV1[];
  readonly target_pin: PreparedExecutableSourceV1['root']['pin'];
  readonly bindings: readonly CompiledSubagentTargetBindingPathV1[];
}

interface AgentInternalSubagentDependencyPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly dependency: PreparedExecutableSourceV1['root'];
  readonly bindings: readonly (CompiledRootBindingPathV1 & {
    readonly subagent_target?: CompiledInternalSubagentTargetPathV1;
  })[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

interface CompiledExternalSubagentTargetPathV1 {
  readonly target_path: `bp1.${string}`;
  readonly target_path_segments: readonly BindingPathSegmentV1[];
  readonly target_pin: ReturnType<typeof prepareLeafResourceSource>['full_pin'];
}

interface AgentExternalSubagentDependencyPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly dependency: ReturnType<typeof prepareLeafResourceSource>['full_pin'];
  readonly bindings: readonly (CompiledRootBindingPathV1 & {
    readonly subagent_target?: CompiledExternalSubagentTargetPathV1;
  })[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

interface RegisteredRootBinding {
  readonly binding: CapabilityBindingV1;
  readonly binding_path: `bp1.${string}`;
  readonly binding_path_segments: readonly BindingPathSegmentV1[];
}

function rootBindingSegments(
  root: PreparedExecutableSourceV1['root'],
  binding: CapabilityBindingV1,
): BindingPathSegmentV1[] {
  return [
    { segment_kind: 'root', pin: root.pin },
    {
      segment_kind: 'binding',
      owner: { owner_kind: 'root', pin: root.pin },
      binding_kind: binding.kind,
      local_binding_id: binding.binding_id,
    },
  ];
}

function samePublishedVersion(
  left: PreparedExecutableSourceV1['root']['pin'],
  right: PreparedExecutableSourceV1['root']['pin'],
): boolean {
  return (
    left.workspace_id === right.workspace_id &&
    left.published_resource_kind === right.published_resource_kind &&
    left.resource_id === right.resource_id &&
    left.resource_version_id === right.resource_version_id
  );
}

function registerRootBindingNamespace(
  root: PreparedExecutableSourceV1['root'],
  bindings: readonly CapabilityBindingV1[],
  identity: ClosureIdentityRegistry,
): RegisteredRootBinding[] {
  return bindings
    .map((binding) => {
      const binding_path_segments = rootBindingSegments(root, binding);
      return {
        binding,
        binding_path: identity.registerBindingPath(binding_path_segments),
        binding_path_segments,
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
}

function compileFlowNodes(
  graph: FlowGraphV1,
  owner: Extract<BindingPathSegmentV1, { segment_kind: 'flow_node' }>['owner'],
  prefix: readonly BindingPathSegmentV1[],
  identity: ClosureIdentityRegistry,
): CompiledFlowNodePathV1[] {
  const nodes: CompiledFlowNodePathV1[] = [];
  function walk(current: FlowGraphV1, ancestors: readonly BindingPathSegmentV1[]): void {
    for (const node of current.nodes) {
      const segment: BindingPathSegmentV1 = {
        segment_kind: 'flow_node',
        owner,
        graph_id: current.graph_id,
        node_id: node.node_id,
      };
      const segments = [...prefix, ...ancestors, segment];
      nodes.push({
        graph_id: current.graph_id,
        node_id: node.node_id,
        node_type: node.type,
        source_path: identity.registerBindingPath(segments),
        source_path_segments: segments,
      });
      const config = node.config as Record<string, unknown>;
      if (node.type === 'loop') walk(config.body as FlowGraphV1, [...ancestors, segment]);
      if (node.type === 'branch') {
        for (const item of config.cases as { graph: FlowGraphV1 }[])
          walk(item.graph, [...ancestors, segment]);
        walk((config.else_case as { graph: FlowGraphV1 }).graph, [...ancestors, segment]);
      }
    }
  }
  walk(graph, []);
  return nodes.sort((left, right) => compareCanonicalStrings(left.source_path, right.source_path));
}

/** Compile the root Agent namespace. Nested Flow/Pack/SubAgent segments are appended by later expansion. */
export function prepareRootBindingPaths(input: unknown): RootBindingPaths {
  const source = prepareExecutableSource(input);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.document',
      'root Binding paths require an Agent executable source',
    );

  const document = source.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(source.root.pin);
  const bindings = registerRootBindingNamespace(
    source.root,
    document.capability_bindings,
    identity,
  ).map(
    ({ binding, binding_path, binding_path_segments }): CompiledRootBindingPathV1 => ({
      binding_id: binding.binding_id,
      binding_kind: binding.kind,
      binding_path,
      binding_path_segments,
      enabled: binding.enabled,
    }),
  );
  const source_disabled_binding_paths = bindings
    .filter((binding) => !binding.enabled)
    .map((binding) => binding.binding_path)
    .sort(compareCanonicalStrings);
  return deepFreezeJson({
    root: source.root,
    bindings,
    source_disabled_binding_paths,
  });
}

/** Compile every structured Flow node path, retaining parent-node ancestry across nested graphs. */
export function prepareFlowNodePaths(input: unknown): FlowNodePaths {
  const source = prepareExecutableSource(input);
  if (source.root.pin.published_resource_kind !== 'FLOW_VERSION')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.document',
      'Flow node paths require a Flow executable source',
    );
  const flowPin = { ...source.root.pin, published_resource_kind: 'FLOW_VERSION' as const };
  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(flowPin);
  const rootSegment: BindingPathSegmentV1 = { segment_kind: 'root', pin: flowPin };
  const owner = { owner_kind: 'root' as const, pin: flowPin };
  const document = source.preimage.document as unknown as { entry_graph: FlowGraphV1 };
  const nodes = compileFlowNodes(document.entry_graph, owner, [rootSegment], identity);
  return deepFreezeJson({ root: source.root, nodes });
}

/**
 * Compile every root Agent Binding that targets one exact Flow source using one closure-local
 * identity registry. Registry provenance and transitive dependency records remain later steps.
 */
export function prepareAgentFlowDependencyPaths(
  rootInput: unknown,
  dependencyInput: unknown,
): AgentFlowDependencyPaths {
  const rootSource = prepareExecutableSource(rootInput);
  const dependencySource = prepareExecutableSource(dependencyInput);
  if (rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.root',
      'nested Flow paths require an Agent root source',
    );
  if (dependencySource.root.pin.published_resource_kind !== 'FLOW_VERSION')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.dependency',
      'nested Flow paths require a Flow dependency source',
    );

  const rootDocument = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const flowDocument = dependencySource.preimage.document as unknown as {
    entry_graph: FlowGraphV1;
  };
  const flowPin = {
    ...dependencySource.root.pin,
    published_resource_kind: 'FLOW_VERSION' as const,
  };
  const targetKey = publishedResourcePinKey(flowPin);
  const matching = rootDocument.capability_bindings.filter(
    (binding) => binding.kind === 'flow' && publishedResourcePinKey(binding.pin) === targetKey,
  );
  if (matching.length === 0)
    throw new ReleaseCoreError(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
      '$.dependency',
      'Flow source is not an exact dependency of any root Binding',
    );

  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(rootSource.root.pin);
  identity.registerResourceNode(flowPin);
  const matchingIds = new Set(matching.map((binding) => binding.binding_id));
  const bindings = registerRootBindingNamespace(
    rootSource.root,
    rootDocument.capability_bindings,
    identity,
  ).map(({ binding, binding_path, binding_path_segments }) => {
    const nodes = matchingIds.has(binding.binding_id)
      ? compileFlowNodes(
          flowDocument.entry_graph,
          { owner_kind: 'published_dependency', pin: flowPin },
          binding_path_segments,
          identity,
        )
      : [];
    return {
      binding_id: binding.binding_id,
      binding_kind: binding.kind,
      binding_path,
      binding_path_segments,
      enabled: binding.enabled,
      nodes,
    };
  });
  const source_disabled_binding_paths = bindings
    .filter((binding) => !binding.enabled)
    .map((binding) => binding.binding_path)
    .sort(compareCanonicalStrings);
  return deepFreezeJson({
    root: rootSource.root,
    dependency: dependencySource.root,
    bindings,
    source_disabled_binding_paths,
  });
}

/** Compile one exact Skill Pack dependency under every matching root Binding. */
export function prepareAgentSkillPackDependencyPaths(
  rootInput: unknown,
  dependencyInput: unknown,
): AgentSkillPackDependencyPaths {
  const rootSource = prepareExecutableSource(rootInput);
  if (rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.root',
      'nested Skill Pack paths require an Agent root source',
    );
  const preliminaryPack = prepareSkillPackSource(dependencyInput);
  const rootDocument = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const targetKey = publishedResourcePinKey(preliminaryPack.full_pin);
  const matching = rootDocument.capability_bindings.filter(
    (binding) =>
      binding.kind === 'skill_pack' && publishedResourcePinKey(binding.pin) === targetKey,
  );
  if (matching.length === 0)
    throw new ReleaseCoreError(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
      '$.dependency',
      'Skill Pack source is not an exact dependency of any root Binding',
    );
  const pack = verifySkillPackBindings(matching, dependencyInput);
  const matchingIds = new Set(matching.map((binding) => binding.binding_id));
  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(rootSource.root.pin);
  identity.registerResourceNode(pack.full_pin);
  const disabledPaths: `bp1.${string}`[] = [];
  const bindings = registerRootBindingNamespace(
    rootSource.root,
    rootDocument.capability_bindings,
    identity,
  ).map(({ binding, binding_path, binding_path_segments }) => {
    if (!binding.enabled) disabledPaths.push(binding_path);
    const members = matchingIds.has(binding.binding_id)
      ? pack.document.member_bindings
          .map((member): CompiledSkillPackMemberPathV1 => {
            const memberSegments: BindingPathSegmentV1[] = [
              ...binding_path_segments,
              {
                segment_kind: 'skill_pack_member',
                owner_pin: pack.full_pin,
                local_member_binding_id: member.binding_id,
              },
            ];
            const member_binding_path = identity.registerBindingPath(memberSegments);
            if (!member.enabled) disabledPaths.push(member_binding_path);
            return {
              member_binding_id: member.binding_id,
              member_binding_kind: member.kind,
              member_binding_path,
              member_binding_path_segments: memberSegments,
              enabled: member.enabled,
              target: member.pin,
            };
          })
          .sort((left, right) =>
            compareCanonicalStrings(left.member_binding_path, right.member_binding_path),
          )
      : [];
    const selected_exposed_operations =
      binding.kind === 'skill_pack' && matchingIds.has(binding.binding_id)
        ? binding.config.exposed_operations
        : [];
    return {
      binding_id: binding.binding_id,
      binding_kind: binding.kind,
      binding_path,
      binding_path_segments,
      enabled: binding.enabled,
      members,
      selected_exposed_operations,
    };
  });
  return deepFreezeJson({
    root: rootSource.root,
    dependency: pack.full_pin,
    bindings,
    exposed_operations: pack.exposed_operations,
    source_disabled_binding_paths: disabledPaths.sort(compareCanonicalStrings),
  });
}

/** Compile one exact internal-Agent SubAgent target and its immediate Binding namespace. */
export function prepareAgentInternalSubagentDependencyPaths(
  rootInput: unknown,
  dependencyInput: unknown,
): AgentInternalSubagentDependencyPaths {
  const rootSource = prepareExecutableSource(rootInput);
  const dependencySource = prepareExecutableSource(dependencyInput);
  if (
    rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE' ||
    dependencySource.root.pin.published_resource_kind !== 'AGENT_RELEASE'
  )
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$',
      'internal SubAgent paths require Agent root and dependency sources',
    );
  const rootDocument = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const dependencyDocument = dependencySource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const targetPin = {
    ...dependencySource.root.pin,
    published_resource_kind: 'AGENT_RELEASE' as const,
  };
  const targetKey = publishedResourcePinKey(targetPin);
  const matching = rootDocument.capability_bindings.filter(
    (binding) =>
      binding.kind === 'subagent' &&
      binding.target_kind === 'internal_agent' &&
      publishedResourcePinKey(binding.pin) === targetKey,
  );
  if (matching.length === 0)
    throw new ReleaseCoreError(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
      '$.dependency',
      'Agent source is not an exact internal SubAgent dependency',
    );
  if (samePublishedVersion(rootSource.root.pin, dependencySource.root.pin))
    throw new ReleaseCoreError(
      'CAPABILITY_DEPENDENCY_CYCLE',
      '$.dependency',
      'an Agent cannot target its own resource version',
    );

  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(rootSource.root.pin);
  identity.registerResourceNode(targetPin);
  const rootNamespace = registerRootBindingNamespace(
    rootSource.root,
    rootDocument.capability_bindings,
    identity,
  );
  const matchingIds = new Set(matching.map((binding) => binding.binding_id));
  const disabledPaths: `bp1.${string}`[] = [];
  const bindings = rootNamespace.map(({ binding, binding_path, binding_path_segments }) => {
    if (!binding.enabled) disabledPaths.push(binding_path);
    let subagent_target: CompiledInternalSubagentTargetPathV1 | undefined;
    if (matchingIds.has(binding.binding_id)) {
      const target_path_segments: BindingPathSegmentV1[] = [
        ...binding_path_segments,
        { segment_kind: 'subagent_target', target_pin: targetPin },
      ];
      const target_path = identity.registerBindingPath(target_path_segments);
      const targetBindings = dependencyDocument.capability_bindings
        .map((targetBinding): CompiledSubagentTargetBindingPathV1 => {
          const targetBindingSegments: BindingPathSegmentV1[] = [
            ...target_path_segments,
            {
              segment_kind: 'binding',
              owner: { owner_kind: 'published_dependency', pin: targetPin },
              binding_kind: targetBinding.kind,
              local_binding_id: targetBinding.binding_id,
            },
          ];
          const targetBindingPath = identity.registerBindingPath(targetBindingSegments);
          if (!targetBinding.enabled) disabledPaths.push(targetBindingPath);
          return {
            binding_id: targetBinding.binding_id,
            binding_kind: targetBinding.kind,
            binding_path: targetBindingPath,
            binding_path_segments: targetBindingSegments,
            enabled: targetBinding.enabled,
            target: targetBinding.pin,
          };
        })
        .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
      subagent_target = {
        target_path,
        target_path_segments,
        target_pin: targetPin,
        bindings: targetBindings,
      };
    }
    return {
      binding_id: binding.binding_id,
      binding_kind: binding.kind,
      binding_path,
      binding_path_segments,
      enabled: binding.enabled,
      ...(subagent_target === undefined ? {} : { subagent_target }),
    };
  });
  return deepFreezeJson({
    root: rootSource.root,
    dependency: dependencySource.root,
    bindings,
    source_disabled_binding_paths: disabledPaths.sort(compareCanonicalStrings),
  });
}

/** Compile one exact external A2A SubAgent target after full leaf Binding verification. */
export function prepareAgentExternalSubagentDependencyPaths(
  rootInput: unknown,
  dependencyInput: unknown,
): AgentExternalSubagentDependencyPaths {
  const rootSource = prepareExecutableSource(rootInput);
  if (rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.root',
      'external SubAgent paths require an Agent root source',
    );
  const preliminaryLeaf = prepareLeafResourceSource(dependencyInput);
  if (preliminaryLeaf.full_pin.published_resource_kind !== 'A2A_AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.dependency',
      'external SubAgent paths require an A2A Agent source',
    );
  const rootDocument = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const targetKey = publishedResourcePinKey(preliminaryLeaf.full_pin);
  const matching = rootDocument.capability_bindings.filter(
    (binding) =>
      binding.kind === 'subagent' &&
      binding.target_kind === 'external_a2a' &&
      publishedResourcePinKey(binding.pin) === targetKey,
  );
  if (matching.length === 0)
    throw new ReleaseCoreError(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
      '$.dependency',
      'A2A Agent source is not an exact external SubAgent dependency',
    );
  const leaf = verifyLeafResourceBindings(matching, dependencyInput);
  const targetPin = {
    ...leaf.full_pin,
    published_resource_kind: 'A2A_AGENT_RELEASE' as const,
  };
  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(rootSource.root.pin);
  identity.registerResourceNode(targetPin);
  const matchingIds = new Set(matching.map((binding) => binding.binding_id));
  const disabledPaths: `bp1.${string}`[] = [];
  const bindings = registerRootBindingNamespace(
    rootSource.root,
    rootDocument.capability_bindings,
    identity,
  ).map(({ binding, binding_path, binding_path_segments }) => {
    if (!binding.enabled) disabledPaths.push(binding_path);
    if (!matchingIds.has(binding.binding_id))
      return {
        binding_id: binding.binding_id,
        binding_kind: binding.kind,
        binding_path,
        binding_path_segments,
        enabled: binding.enabled,
      };
    const target_path_segments: BindingPathSegmentV1[] = [
      ...binding_path_segments,
      { segment_kind: 'subagent_target', target_pin: targetPin },
    ];
    return {
      binding_id: binding.binding_id,
      binding_kind: binding.kind,
      binding_path,
      binding_path_segments,
      enabled: binding.enabled,
      subagent_target: {
        target_path: identity.registerBindingPath(target_path_segments),
        target_path_segments,
        target_pin: targetPin,
      },
    };
  });
  return deepFreezeJson({
    root: rootSource.root,
    dependency: targetPin,
    bindings,
    source_disabled_binding_paths: disabledPaths.sort(compareCanonicalStrings),
  });
}
