import { describe, expect, it } from 'vitest';

import {
  canonicalBindingPath,
  compareCanonicalStrings,
  prepareExecutableSource,
  prepareLeafResourceSource,
  prepareSkillPackSource,
  ReleaseCoreError,
} from '../src/index.js';
import {
  prepareAgentFlowDependencyPaths,
  prepareAgentExternalSubagentDependencyPaths,
  prepareAgentInternalSubagentDependencyPaths,
  prepareAgentSkillPackDependencyPaths,
  prepareFlowNodePaths,
  prepareRootBindingPaths,
} from '../src/root-binding-paths.js';
import {
  deeplyNestedFlowSource,
  maximumNodeFlowSource,
  nestedFlowSource,
  richAgentSource,
} from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import { leafCandidate, record } from './leaf-resource-source-fixtures.js';
import { skillPackSource } from './skill-pack-source-fixtures.js';

function candidate(document: unknown = richAgentSource()) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function requiredBinding(source: ReturnType<typeof richAgentSource>, index: number) {
  const binding = source.capability_bindings[index];
  if (binding === undefined) throw new Error(`fixture is missing Binding ${index}`);
  return binding;
}

function compile(document: unknown = richAgentSource()) {
  return prepareRootBindingPaths(candidate(document));
}

describe('root Binding path compilation', () => {
  it('compiles every Agent capability Binding into a canonical typed path', () => {
    const source = richAgentSource();
    const prepared = prepareExecutableSource(candidate(source));
    const result = prepareRootBindingPaths(candidate(source));
    expect(result.bindings).toHaveLength(richAgentSource().capability_bindings.length);
    for (const binding of result.bindings) {
      const declared = source.capability_bindings.find(
        (candidateBinding) => candidateBinding.binding_id === binding.binding_id,
      );
      if (declared === undefined) throw new Error('compiled Binding is absent from fixture source');
      const expectedSegments = [
        { segment_kind: 'root' as const, pin: prepared.root.pin },
        {
          segment_kind: 'binding' as const,
          owner: { owner_kind: 'root' as const, pin: prepared.root.pin },
          binding_kind: declared.kind,
          local_binding_id: declared.binding_id,
        },
      ];
      expect(binding.binding_path_segments).toEqual(expectedSegments);
      expect(binding.binding_path).toBe(canonicalBindingPath(expectedSegments));
    }
  });

  it('preserves exact local IDs without exposing them in the opaque path', () => {
    const source = richAgentSource();
    const target = requiredBinding(source, 0);
    const previous = target.binding_id;
    target.binding_id = '含/冒号:prefix';
    source.strategy.allowed_capability_binding_ids =
      source.strategy.allowed_capability_binding_ids.map((value) =>
        value === previous ? '含/冒号:prefix' : value,
      );
    for (const skill of source.instruction_skill_bindings)
      skill.allowed_capability_binding_ids = skill.allowed_capability_binding_ids.map((value) =>
        value === previous ? '含/冒号:prefix' : value,
      );
    for (const handle of source.public_capability_handles)
      if (handle.binding_id === previous) handle.binding_id = '含/冒号:prefix';
    const [binding] = compile(source).bindings.filter(
      (item) => item.binding_id === '含/冒号:prefix',
    );
    expect(binding?.binding_path).toMatch(/^bp1\.[A-Za-z0-9_-]{43}$/u);
    expect(binding?.binding_path).not.toContain('含');
  });

  it('separates identical local IDs under different root identities', () => {
    const first = compile();
    const changed = richAgentSource();
    changed.agent_release_id = '00000000-0000-7000-8000-000000000099';
    const second = compile(changed);
    expect(second.bindings[0]?.binding_path).not.toBe(first.bindings[0]?.binding_path);
  });

  it('is stable under source Binding permutation', () => {
    const source = richAgentSource();
    source.capability_bindings.reverse();
    expect(compile(source)).toEqual(compile());
  });

  it('sorts by canonical opaque path rather than local declaration order', () => {
    const result = compile();
    expect(result.bindings.map((binding) => binding.binding_path)).toEqual(
      result.bindings
        .map((binding) => binding.binding_path)
        .sort((left, right) => compareCanonicalStrings(left, right)),
    );
  });

  it('records disabled paths and only disabled paths', () => {
    const source = richAgentSource();
    requiredBinding(source, 1).enabled = false;
    const result = compile(source);
    const disabledDeclaration = requiredBinding(source, 1);
    const prepared = prepareExecutableSource(candidate(source));
    const disabledPath = canonicalBindingPath([
      { segment_kind: 'root', pin: prepared.root.pin },
      {
        segment_kind: 'binding',
        owner: { owner_kind: 'root', pin: prepared.root.pin },
        binding_kind: disabledDeclaration.kind,
        local_binding_id: disabledDeclaration.binding_id,
      },
    ]);
    expect(result.source_disabled_binding_paths).toEqual([disabledPath]);
    for (const binding of result.bindings)
      expect(binding.enabled).toBe(binding.binding_id !== disabledDeclaration.binding_id);
  });

  it('does not treat disabled Bindings as absent from the immutable namespace', () => {
    const source = richAgentSource();
    requiredBinding(source, 1).enabled = false;
    expect(compile(source).bindings).toHaveLength(source.capability_bindings.length);
  });

  it('does not expose a standalone hash that could be mistaken for closure authority', () => {
    expect(compile()).not.toHaveProperty('index_hash');
  });

  it('returns a deeply immutable snapshot', () => {
    const result = compile();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bindings)).toBe(true);
    expect(Object.isFrozen(result.bindings[0]?.binding_path_segments)).toBe(true);
    expect(Object.isFrozen(result.bindings[0])).toBe(true);
    expect(Object.isFrozen(result.bindings[0]?.binding_path_segments[0])).toBe(true);
    expect(Object.isFrozen(result.root.pin)).toBe(true);
  });

  it('rejects Flow roots because their Binding namespace is node-scoped', () => {
    try {
      compile(nestedFlowSource());
      throw new Error('expected Flow rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseCoreError);
      expect(error).toMatchObject({ code: 'CLOSURE_SOURCE_INVALID', path: '$.document' });
    }
  });

  it('supports an Agent with an empty capability namespace', () => {
    const source = richAgentSource();
    source.capability_bindings = [];
    source.strategy.allowed_capability_binding_ids = [];
    source.instruction_skill_bindings = [];
    source.public_capability_handles = [];
    expect(compile(source)).toMatchObject({ bindings: [], source_disabled_binding_paths: [] });
  });

  it('rejects duplicate local IDs through the closed Agent source contract', () => {
    const source = richAgentSource();
    source.capability_bindings.push(structuredClone(requiredBinding(source, 0)));
    expect(() => compile(source)).toThrow('CLOSURE_SOURCE_INVALID');
  });
});

function compileFlow(document: unknown = nestedFlowSource()) {
  return prepareFlowNodePaths(candidate(document));
}

describe('recursive Flow node path compilation', () => {
  it('compiles every node across root, branch, else and loop-body graphs', () => {
    const result = compileFlow();
    expect(result.nodes).toHaveLength(12);
    expect(new Set(result.nodes.map((node) => node.graph_id))).toEqual(
      new Set(['root', 'z', 'a', 'loop-graph', 'body']),
    );
  });

  it('constructs an independent canonical path for a root graph node', () => {
    const prepared = prepareExecutableSource(candidate(nestedFlowSource()));
    const result = prepareFlowNodePaths(candidate(nestedFlowSource()));
    const node = result.nodes.find(
      (item) => item.graph_id === 'root' && item.node_id === 'start-1',
    );
    const segments = [
      { segment_kind: 'root' as const, pin: prepared.root.pin },
      {
        segment_kind: 'flow_node' as const,
        owner: { owner_kind: 'root' as const, pin: prepared.root.pin },
        graph_id: 'root',
        node_id: 'start-1',
      },
    ];
    expect(node?.source_path_segments).toEqual(segments);
    expect(node?.source_path).toBe(canonicalBindingPath(segments));
  });

  it('retains parent Flow node ancestry for nested graphs', () => {
    const nested = compileFlow().nodes.find(
      (node) => node.graph_id === 'z' && node.node_id === 'prelude',
    );
    expect(nested?.source_path_segments.map((segment) => segment.segment_kind)).toEqual([
      'root',
      'flow_node',
      'flow_node',
    ]);
    expect(nested?.source_path_segments[1]).toMatchObject({
      graph_id: 'root',
      node_id: 'output-1',
    });
  });

  it('separates sibling graph nodes that reuse the same local node ID', () => {
    const result = compileFlow();
    const first = result.nodes.find((node) => node.graph_id === 'z' && node.node_id === 'middle');
    const second = result.nodes.find((node) => node.graph_id === 'a' && node.node_id === 'middle');
    expect(first?.source_path).not.toBe(second?.source_path);
  });

  it('retains both loop node and loop-body node ancestry', () => {
    const nested = compileFlow().nodes.find(
      (node) => node.graph_id === 'body' && node.node_id === 'leaf',
    );
    expect(nested?.source_path_segments.slice(1)).toMatchObject([
      { graph_id: 'root', node_id: 'output-1' },
      { graph_id: 'loop-graph', node_id: 'loop' },
      { graph_id: 'body', node_id: 'leaf' },
    ]);
  });

  it('retains the complete deep ancestry without shallow truncation', () => {
    const source = deeplyNestedFlowSource();
    const prepared = prepareExecutableSource(candidate(source));
    const result = prepareFlowNodePaths(candidate(source));
    const leaf = result.nodes.find((node) => node.graph_id === 'deep-8');
    const nodeSegments = leaf?.source_path_segments.slice(1);
    expect(
      nodeSegments?.map((segment) =>
        segment.segment_kind === 'flow_node' ? `${segment.graph_id}/${segment.node_id}` : 'invalid',
      ),
    ).toEqual([
      'root/outer-loop',
      'deep-0/loop-0',
      'deep-1/loop-1',
      'deep-2/loop-2',
      'deep-3/loop-3',
      'deep-4/loop-4',
      'deep-5/loop-5',
      'deep-6/loop-6',
      'deep-7/loop-7',
      'deep-8/leaf',
    ]);
    expect(leaf?.source_path).toBe(
      canonicalBindingPath([
        { segment_kind: 'root', pin: prepared.root.pin },
        ...(nodeSegments ?? []),
      ]),
    );
  });

  it('emits globally unique source paths', () => {
    const paths = compileFlow().nodes.map((node) => node.source_path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('sorts the semantic node set by canonical opaque path', () => {
    const paths = compileFlow().nodes.map((node) => node.source_path);
    expect(paths).toEqual([...paths].sort(compareCanonicalStrings));
  });

  it('is stable when node declaration sets are permuted', () => {
    const source = nestedFlowSource();
    source.entry_graph.nodes.reverse();
    expect(compileFlow(source)).toEqual(compileFlow());
  });

  it('returns a deeply immutable non-authoritative intermediate result', () => {
    const result = compileFlow();
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nodes)).toBe(true);
    expect(Object.isFrozen(result.nodes[0]?.source_path_segments[0])).toBe(true);
  });

  it('rejects Agent roots at the Flow-only compiler boundary', () => {
    expect(() => prepareFlowNodePaths(candidate(richAgentSource()))).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
  });

  it('accepts the exact 4096-node source boundary without exhausting identity entries', () => {
    expect(prepareFlowNodePaths(candidate(maximumNodeFlowSource())).nodes).toHaveLength(4096);
  });

  it.each([
    [
      'empty nodes',
      () => ({
        ...nestedFlowSource(),
        entry_graph: { ...nestedFlowSource().entry_graph, nodes: [] },
      }),
      'CLOSURE_SOURCE_INVALID',
    ],
    [
      'empty graph id',
      () => ({
        ...nestedFlowSource(),
        entry_graph: { ...nestedFlowSource().entry_graph, graph_id: '' },
      }),
      'CLOSURE_SOURCE_INVALID',
    ],
    ['extra field', () => ({ ...nestedFlowSource(), extra: true }), 'CLOSURE_SOURCE_INVALID'],
    ['4097 nodes', () => maximumNodeFlowSource(true), 'CLOSURE_SOURCE_LIMIT_EXCEEDED'],
  ])('revalidates raw Flow input and rejects %s', (_name, makeSource, code) => {
    let thrown: unknown;
    try {
      prepareFlowNodePaths(candidate(makeSource()));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReleaseCoreError);
    expect(thrown).toMatchObject({ code, path: '$.document' });
  });
});

function matchingAgentFlowSources() {
  const flow = nestedFlowSource();
  const flowPin = {
    ...prepareExecutableSource(candidate(flow)).root.pin,
    published_resource_kind: 'FLOW_VERSION' as const,
  };
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find((item) => item.kind === 'flow');
  if (binding === undefined) throw new Error('fixture is missing its Flow Binding');
  binding.pin = flowPin;
  return { agent, flow, binding };
}

describe('Agent-owned Flow dependency paths', () => {
  it('prefixes nested Flow nodes with the exact root Binding path', () => {
    const { agent, flow, binding } = matchingAgentFlowSources();
    const result = prepareAgentFlowDependencyPaths(candidate(agent), candidate(flow));
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    const node = compiled?.nodes.find(
      (candidateNode) => candidateNode.graph_id === 'root' && candidateNode.node_id === 'start-1',
    );
    expect(compiled?.binding_id).toBe(binding.binding_id);
    expect(node?.source_path_segments.map((segment) => segment.segment_kind)).toEqual([
      'root',
      'binding',
      'flow_node',
    ]);
    expect(node?.source_path_segments[1]).toMatchObject({
      binding_kind: 'flow',
      local_binding_id: binding.binding_id,
    });
    expect(node?.source_path_segments[2]).toMatchObject({
      owner: { owner_kind: 'published_dependency', pin: result.dependency.pin },
      graph_id: 'root',
      node_id: 'start-1',
    });
    expect(node?.source_path).toBe(canonicalBindingPath(node?.source_path_segments));
  });

  it('registers the complete root Binding namespace before expanding one dependency', () => {
    const { agent, flow } = matchingAgentFlowSources();
    const result = prepareAgentFlowDependencyPaths(candidate(agent), candidate(flow));
    expect(result.bindings).toHaveLength(agent.capability_bindings.length);
    expect(result.bindings.filter((binding) => binding.nodes.length > 0)).toHaveLength(1);
    expect(result.bindings.filter((binding) => binding.nodes.length === 0)).toHaveLength(
      agent.capability_bindings.length - 1,
    );
  });

  it('retains the root Binding plus every recursive Flow ancestor', () => {
    const { agent, flow } = matchingAgentFlowSources();
    const compiled = prepareAgentFlowDependencyPaths(
      candidate(agent),
      candidate(flow),
    ).bindings.find((binding) => binding.binding_kind === 'flow' && binding.nodes.length > 0);
    const leaf = compiled?.nodes.find(
      (node) => node.graph_id === 'body' && node.node_id === 'leaf',
    );
    expect(leaf?.source_path_segments.map((segment) => segment.segment_kind)).toEqual([
      'root',
      'binding',
      'flow_node',
      'flow_node',
      'flow_node',
    ]);
  });

  it('creates distinct namespaces for two root Bindings to the same Flow pin', () => {
    const { agent, flow, binding } = matchingAgentFlowSources();
    const second = structuredClone(binding);
    second.binding_id = 'flow-second';
    agent.capability_bindings.push(second);
    agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
    const result = prepareAgentFlowDependencyPaths(candidate(agent), candidate(flow));
    const expanded = result.bindings.filter((item) => item.nodes.length > 0);
    expect(expanded).toHaveLength(2);
    const firstNode = expanded[0]?.nodes.find((node) => node.node_id === 'start-1');
    const secondNode = expanded[1]?.nodes.find((node) => node.node_id === 'start-1');
    expect(firstNode?.source_path).not.toBe(secondNode?.source_path);
  });

  it('keeps disabled dependency Bindings addressable and projects their root path only', () => {
    const { agent, flow, binding } = matchingAgentFlowSources();
    binding.enabled = false;
    const result = prepareAgentFlowDependencyPaths(candidate(agent), candidate(flow));
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(compiled?.nodes).toHaveLength(12);
    expect(result.source_disabled_binding_paths).toEqual([compiled?.binding_path]);
  });

  it('admits the exact 4096-node Flow after adding root, dependency and Binding identities', () => {
    const flow = maximumNodeFlowSource();
    const flowPin = {
      ...prepareExecutableSource(candidate(flow)).root.pin,
      published_resource_kind: 'FLOW_VERSION' as const,
    };
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find((item) => item.kind === 'flow');
    if (binding === undefined) throw new Error('fixture is missing its Flow Binding');
    binding.pin = flowPin;
    const result = prepareAgentFlowDependencyPaths(candidate(agent), candidate(flow));
    expect(
      result.bindings.find((item) => item.binding_id === binding.binding_id)?.nodes,
    ).toHaveLength(4096);
  });

  it('rejects a self-consistent Flow source that is not the root Binding exact pin', () => {
    const { agent, flow } = matchingAgentFlowSources();
    (flow as unknown as { flow_version_id: string }).flow_version_id =
      '00000000-0000-7000-8000-000000000099';
    expect(() => prepareAgentFlowDependencyPaths(candidate(agent), candidate(flow))).toThrow(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
    );
  });

  it('revalidates both raw sources and rejects reversed root/dependency roles', () => {
    const { agent, flow } = matchingAgentFlowSources();
    expect(() => prepareAgentFlowDependencyPaths(candidate(flow), candidate(agent))).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
  });

  it('returns one deeply frozen closure-local snapshot without an authority hash', () => {
    const { agent, flow } = matchingAgentFlowSources();
    const result = prepareAgentFlowDependencyPaths(candidate(agent), candidate(flow));
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    const expanded = result.bindings.find((binding) => binding.nodes.length > 0);
    expect(Object.isFrozen(expanded?.nodes)).toBe(true);
    expect(Object.isFrozen(expanded?.nodes[0]?.source_path_segments)).toBe(true);
  });
});

function matchingAgentSkillPackSources() {
  const packInput = skillPackSource();
  const pack = prepareSkillPackSource(packInput);
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find((item) => item.kind === 'skill_pack');
  if (binding === undefined) throw new Error('fixture is missing its Skill Pack Binding');
  binding.pin = pack.full_pin;
  binding.manual = { ...pack.document.manual, hash: pack.component_hashes.manual };
  binding.input_schema = pack.document.input_schema;
  binding.output_schema = pack.document.output_schema;
  binding.config = {
    schema_version: 'skill-pack-binding/1',
    member_projection_hash: pack.member_projection_hash,
    exposed_operations: pack.exposed_operations.map((operation) => ({
      exposed_operation_id: operation.exposed_operation_id,
      exposed_operation_contract_hash: operation.exposed_operation_contract_hash,
    })),
  };
  return { agent, packInput, binding };
}

describe('Agent-owned Skill Pack member paths', () => {
  it('registers the complete root namespace and expands every member under the exact Pack Binding', () => {
    const { agent, packInput, binding } = matchingAgentSkillPackSources();
    const result = prepareAgentSkillPackDependencyPaths(candidate(agent), packInput);
    expect(result.bindings).toHaveLength(agent.capability_bindings.length);
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(compiled?.members).toHaveLength(packInput.document.member_bindings.length);
    expect(result.bindings.filter((item) => item.members.length > 0)).toHaveLength(1);
  });

  it('constructs root, Binding and typed Skill Pack member segments', () => {
    const { agent, packInput, binding } = matchingAgentSkillPackSources();
    const result = prepareAgentSkillPackDependencyPaths(candidate(agent), packInput);
    const member = result.bindings.find((item) => item.binding_id === binding.binding_id)
      ?.members[0];
    expect(member?.member_binding_path_segments.map((segment) => segment.segment_kind)).toEqual([
      'root',
      'binding',
      'skill_pack_member',
    ]);
    expect(member?.member_binding_path_segments[2]).toEqual({
      segment_kind: 'skill_pack_member',
      owner_pin: result.dependency,
      local_member_binding_id: packInput.document.member_bindings[0]?.binding_id,
    });
    expect(member?.member_binding_path).toBe(
      canonicalBindingPath(member?.member_binding_path_segments),
    );
  });

  it('admits the exact 128-member Pack boundary after registering the root namespace', () => {
    const packInput = skillPackSource();
    const template = packInput.document.member_bindings[0];
    if (template === undefined) throw new Error('fixture is missing its member Binding');
    for (let index = 1; index < 128; index += 1) {
      const member = structuredClone(template);
      member.binding_id = `member-${index.toString().padStart(3, '0')}`;
      packInput.document.member_bindings.push(member);
    }
    const pack = prepareSkillPackSource(packInput);
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find((item) => item.kind === 'skill_pack');
    if (binding === undefined) throw new Error('fixture is missing its Skill Pack Binding');
    binding.pin = pack.full_pin;
    binding.manual = { ...pack.document.manual, hash: pack.component_hashes.manual };
    binding.input_schema = pack.document.input_schema;
    binding.output_schema = pack.document.output_schema;
    binding.config = {
      schema_version: 'skill-pack-binding/1',
      member_projection_hash: pack.member_projection_hash,
      exposed_operations: pack.exposed_operations.map((operation) => ({
        exposed_operation_id: operation.exposed_operation_id,
        exposed_operation_contract_hash: operation.exposed_operation_contract_hash,
      })),
    };
    const result = prepareAgentSkillPackDependencyPaths(candidate(agent), packInput);
    expect(
      result.bindings.find((item) => item.binding_id === binding.binding_id)?.members,
    ).toHaveLength(128);
  });

  it('keeps an unexposed disabled member addressable and marks only its exact path disabled', () => {
    const packInput = skillPackSource();
    const second = structuredClone(packInput.document.member_bindings[0]);
    if (second === undefined) throw new Error('fixture is missing its member Binding');
    second.binding_id = 'disabled-member';
    second.enabled = false;
    packInput.document.member_bindings.push(second);
    const pack = prepareSkillPackSource(packInput);
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find((item) => item.kind === 'skill_pack');
    if (binding === undefined) throw new Error('fixture is missing its Skill Pack Binding');
    binding.pin = pack.full_pin;
    binding.manual = { ...pack.document.manual, hash: pack.component_hashes.manual };
    binding.input_schema = pack.document.input_schema;
    binding.output_schema = pack.document.output_schema;
    binding.config = {
      schema_version: 'skill-pack-binding/1',
      member_projection_hash: pack.member_projection_hash,
      exposed_operations: pack.exposed_operations.map((operation) => ({
        exposed_operation_id: operation.exposed_operation_id,
        exposed_operation_contract_hash: operation.exposed_operation_contract_hash,
      })),
    };
    const result = prepareAgentSkillPackDependencyPaths(candidate(agent), packInput);
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    const disabled = compiled?.members.find(
      (member) => member.member_binding_id === second.binding_id,
    );
    expect(disabled?.enabled).toBe(false);
    expect(result.source_disabled_binding_paths).toEqual([disabled?.member_binding_path]);
  });

  it('isolates the same Pack members under two different root Bindings', () => {
    const { agent, packInput, binding } = matchingAgentSkillPackSources();
    const second = structuredClone(binding);
    second.binding_id = 'pack-second';
    agent.capability_bindings.push(second);
    agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
    const expanded = prepareAgentSkillPackDependencyPaths(
      candidate(agent),
      packInput,
    ).bindings.filter((item) => item.members.length > 0);
    expect(expanded).toHaveLength(2);
    expect(expanded[0]?.members[0]?.member_binding_path).not.toBe(
      expanded[1]?.members[0]?.member_binding_path,
    );
  });

  it('rejects exact-pin matches whose selected exposure projection is stale', () => {
    const { agent, packInput, binding } = matchingAgentSkillPackSources();
    binding.config.member_projection_hash =
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(() => prepareAgentSkillPackDependencyPaths(candidate(agent), packInput)).toThrow(
      'CLOSURE_SOURCE_MISMATCH',
    );
  });

  it('rejects a Pack source that is not an exact root dependency', () => {
    const { agent, packInput } = matchingAgentSkillPackSources();
    packInput.document.resource_version_id = '00000000-0000-7000-8000-000000000099';
    expect(() => prepareAgentSkillPackDependencyPaths(candidate(agent), packInput)).toThrow(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
    );
  });

  it('returns deeply frozen paths without prematurely emitting sealed routes or hashes', () => {
    const { agent, packInput, binding } = matchingAgentSkillPackSources();
    const result = prepareAgentSkillPackDependencyPaths(candidate(agent), packInput);
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(result).not.toHaveProperty('closure_hash');
    expect(compiled).not.toHaveProperty('skill_pack_operation_routes');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(compiled?.members[0]?.member_binding_path_segments)).toBe(true);
  });
});

function matchingInternalSubagentSources() {
  const target = richAgentSource();
  (target as unknown as { agent_id: string }).agent_id = '00000000-0000-7000-8000-000000000098';
  (target as unknown as { agent_release_id: string }).agent_release_id =
    '00000000-0000-7000-8000-000000000099';
  const targetPin = {
    ...prepareExecutableSource(candidate(target)).root.pin,
    published_resource_kind: 'AGENT_RELEASE' as const,
  };
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find(
    (item) => item.kind === 'subagent' && item.target_kind === 'internal_agent',
  );
  if (binding === undefined) throw new Error('fixture is missing its internal SubAgent Binding');
  binding.pin = targetPin;
  return { agent, target, binding };
}

describe('Agent-owned internal SubAgent target paths', () => {
  it('registers the complete parent namespace and expands the target Agent namespace', () => {
    const { agent, target, binding } = matchingInternalSubagentSources();
    const result = prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(target));
    expect(result.bindings).toHaveLength(agent.capability_bindings.length);
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(compiled?.subagent_target?.bindings).toHaveLength(target.capability_bindings.length);
    expect(result.bindings.filter((item) => item.subagent_target !== undefined)).toHaveLength(1);
  });

  it('constructs root, parent Binding, target and dependency-owned Binding segments', () => {
    const { agent, target, binding } = matchingInternalSubagentSources();
    const result = prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(target));
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    const targetPath = compiled?.subagent_target;
    const targetBinding = targetPath?.bindings[0];
    expect(targetPath?.target_path_segments.map((segment) => segment.segment_kind)).toEqual([
      'root',
      'binding',
      'subagent_target',
    ]);
    expect(targetPath?.target_path_segments[2]).toEqual({
      segment_kind: 'subagent_target',
      target_pin: result.dependency.pin,
    });
    expect(targetBinding?.binding_path_segments.map((segment) => segment.segment_kind)).toEqual([
      'root',
      'binding',
      'subagent_target',
      'binding',
    ]);
    expect(targetBinding?.binding_path_segments[3]).toMatchObject({
      owner: { owner_kind: 'published_dependency', pin: result.dependency.pin },
    });
    expect(targetBinding?.binding_path).toBe(
      canonicalBindingPath(targetBinding?.binding_path_segments),
    );
  });

  it('separates identical local Binding IDs in parent and target Agent namespaces', () => {
    const { agent, target } = matchingInternalSubagentSources();
    const result = prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(target));
    const parent = result.bindings.find((binding) => binding.binding_id === 'plugin');
    const nested = result.bindings
      .find((binding) => binding.subagent_target !== undefined)
      ?.subagent_target?.bindings.find((binding) => binding.binding_id === 'plugin');
    expect(parent?.binding_path).not.toBe(nested?.binding_path);
  });

  it('isolates one target Agent under two parent SubAgent Bindings', () => {
    const { agent, target, binding } = matchingInternalSubagentSources();
    const second = structuredClone(binding);
    second.binding_id = 'subagent-second';
    agent.capability_bindings.push(second);
    agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
    const expanded = prepareAgentInternalSubagentDependencyPaths(
      candidate(agent),
      candidate(target),
    ).bindings.filter((item) => item.subagent_target !== undefined);
    expect(expanded).toHaveLength(2);
    expect(expanded[0]?.subagent_target?.target_path).not.toBe(
      expanded[1]?.subagent_target?.target_path,
    );
  });

  it('keeps disabled target Bindings addressable and records their exact nested path', () => {
    const { agent, target, binding } = matchingInternalSubagentSources();
    const disabled = target.capability_bindings.find((item) => item.binding_id === 'knowledge');
    if (disabled === undefined) throw new Error('fixture is missing the target Binding');
    disabled.enabled = false;
    const refreshedPin = {
      ...prepareExecutableSource(candidate(target)).root.pin,
      published_resource_kind: 'AGENT_RELEASE' as const,
    };
    binding.pin = refreshedPin;
    const result = prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(target));
    const nested = result.bindings
      .find((item) => item.binding_id === binding.binding_id)
      ?.subagent_target?.bindings.find((item) => item.binding_id === disabled.binding_id);
    expect(nested?.enabled).toBe(false);
    expect(result.source_disabled_binding_paths).toEqual([nested?.binding_path]);
  });

  it('rejects a self-consistent Agent source that is not the parent exact target pin', () => {
    const { agent, target } = matchingInternalSubagentSources();
    (target as unknown as { agent_release_id: string }).agent_release_id =
      '00000000-0000-7000-8000-000000000097';
    expect(() =>
      prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(target)),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects a direct same-version SubAgent cycle before path expansion', () => {
    const target = richAgentSource();
    const targetPin = {
      ...prepareExecutableSource(candidate(target)).root.pin,
      published_resource_kind: 'AGENT_RELEASE' as const,
    };
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find(
      (item) => item.kind === 'subagent' && item.target_kind === 'internal_agent',
    );
    if (binding === undefined) throw new Error('fixture is missing its internal SubAgent Binding');
    binding.pin = targetPin;
    expect(() =>
      prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(target)),
    ).toThrow('CAPABILITY_DEPENDENCY_CYCLE');
  });

  it('rejects non-Agent dependencies at the internal target boundary', () => {
    const { agent } = matchingInternalSubagentSources();
    expect(() =>
      prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(nestedFlowSource())),
    ).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('returns deeply frozen paths without inventing a nested closure seal', () => {
    const { agent, target, binding } = matchingInternalSubagentSources();
    const result = prepareAgentInternalSubagentDependencyPaths(candidate(agent), candidate(target));
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(result).not.toHaveProperty('closure_hash');
    expect(compiled?.subagent_target).not.toHaveProperty('nested_closure_hash');
    expect(Object.isFrozen(compiled?.subagent_target?.bindings)).toBe(true);
    expect(Object.isFrozen(compiled?.subagent_target?.bindings[0]?.binding_path_segments)).toBe(
      true,
    );
  });
});

function matchingExternalSubagentSources() {
  const target = leafCandidate('A2A_AGENT_RELEASE');
  const prepared = prepareLeafResourceSource(target);
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find((item) => item.kind === 'subagent');
  if (binding === undefined) throw new Error('fixture is missing its SubAgent Binding');
  const mutable = record(binding);
  mutable.target_kind = 'external_a2a';
  mutable.pin = prepared.full_pin;
  mutable.manual = {
    ...record(target.document.manual),
    hash: record(prepared.component_hashes).manual,
  };
  mutable.input_schema = structuredClone(record(target.document.operation).input_schema);
  mutable.output_schema = structuredClone(record(target.document.operation).output_schema);
  mutable.data_classification = 'internal';
  const requirements = record(target.document.requirements).credential_requirements as unknown[];
  mutable.credential_requirement = structuredClone(requirements[0]);
  return { agent, target, binding };
}

describe('Agent-owned external A2A SubAgent target paths', () => {
  it('registers the complete root namespace and compiles a terminal external target path', () => {
    const { agent, target, binding } = matchingExternalSubagentSources();
    const result = prepareAgentExternalSubagentDependencyPaths(candidate(agent), target);
    expect(result.bindings).toHaveLength(agent.capability_bindings.length);
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(
      compiled?.subagent_target?.target_path_segments.map((segment) => segment.segment_kind),
    ).toEqual(['root', 'binding', 'subagent_target']);
    expect(compiled?.subagent_target?.target_path_segments[2]).toEqual({
      segment_kind: 'subagent_target',
      target_pin: result.dependency,
    });
    expect(compiled?.subagent_target?.target_path).toBe(
      canonicalBindingPath(compiled?.subagent_target?.target_path_segments),
    );
  });

  it('isolates the same external target under different parent Agent identities', () => {
    const first = matchingExternalSubagentSources();
    const firstPath = prepareAgentExternalSubagentDependencyPaths(
      candidate(first.agent),
      first.target,
    ).bindings.find((item) => item.binding_id === first.binding.binding_id)?.subagent_target
      ?.target_path;
    const second = matchingExternalSubagentSources();
    (second.agent as unknown as { agent_id: string }).agent_id =
      '00000000-0000-7000-8000-000000000097';
    const secondPath = prepareAgentExternalSubagentDependencyPaths(
      candidate(second.agent),
      second.target,
    ).bindings.find((item) => item.binding_id === second.binding.binding_id)?.subagent_target
      ?.target_path;
    expect(firstPath).not.toBe(secondPath);
  });

  it('keeps a disabled external Binding addressable and records only its root path', () => {
    const { agent, target, binding } = matchingExternalSubagentSources();
    binding.enabled = false;
    const result = prepareAgentExternalSubagentDependencyPaths(candidate(agent), target);
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(compiled?.subagent_target).toBeDefined();
    expect(result.source_disabled_binding_paths).toEqual([compiled?.binding_path]);
  });

  it('rejects an external source that is not the root exact target pin', () => {
    const { agent, target } = matchingExternalSubagentSources();
    target.document.resource_version_id = '00000000-0000-7000-8000-000000000099';
    expect(() => prepareAgentExternalSubagentDependencyPaths(candidate(agent), target)).toThrow(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
    );
  });

  it('rejects stale external Binding evidence after the exact pin match', () => {
    const { agent, target, binding } = matchingExternalSubagentSources();
    binding.manual.description = 'stale description';
    expect(() => prepareAgentExternalSubagentDependencyPaths(candidate(agent), target)).toThrow(
      'CLOSURE_SOURCE_MISMATCH',
    );
  });

  it('rejects non-A2A leaf dependencies at the external target boundary', () => {
    const { agent } = matchingExternalSubagentSources();
    expect(() =>
      prepareAgentExternalSubagentDependencyPaths(
        candidate(agent),
        leafCandidate('PLUGIN_TOOL_RELEASE'),
      ),
    ).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('returns a deeply frozen terminal path without inventing nested Agent bindings or seals', () => {
    const { agent, target, binding } = matchingExternalSubagentSources();
    const result = prepareAgentExternalSubagentDependencyPaths(candidate(agent), target);
    const compiled = result.bindings.find((item) => item.binding_id === binding.binding_id);
    expect(result).not.toHaveProperty('closure_hash');
    expect(compiled?.subagent_target).not.toHaveProperty('bindings');
    expect(compiled?.subagent_target).not.toHaveProperty('nested_closure_hash');
    expect(Object.isFrozen(compiled?.subagent_target?.target_path_segments)).toBe(true);
  });
});
