import { describe, expect, it, vi } from 'vitest';
import {
  AgentExecutableSourceV1Schema,
  AgentReleaseV1Schema,
  domainContractSchemaRegistry,
  type FlowGraphV1,
} from '@better-agent/domain-contracts';
import { boundedDataSnapshot } from '../src/bounded-data-snapshot.js';
import { nestedFlowSource, richAgentSource } from './executable-source-fixtures.js';
import {
  canonicalSha256,
  deriveExecutableCompiledHash,
  prepareExecutableSource,
  preparePinnedDependencyGraph,
  verifyExecutableSource,
  verifyExecutableCompiledHash,
} from '../src/index.js';
import {
  agentId,
  agentReleaseId,
  flowId,
  flowVersionId,
  hashA,
  hashB,
  makeAgentRelease,
  makeFlowIr,
  makeFlowPin,
  makePluginPin,
  makeStrategyPin,
  otherWorkspaceId,
  workspaceId,
} from './fixtures.js';

function agentSource() {
  const {
    compiled_hash: _compiled,
    capability_closure_hash: _closure,
    ...body
  } = makeAgentRelease();
  return { ...body, schema_version: 'agent-executable-source/1' };
}
function candidate(document: unknown = agentSource(), workspace = workspaceId) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspace, document };
}

describe('executable semantic source contract', () => {
  it('registers a hash-free Agent source without relaxing the released Agent contract', () => {
    const source = agentSource();
    expect(AgentExecutableSourceV1Schema.parse(source)).toEqual(source);
    expect(domainContractSchemaRegistry.parse(source)).toEqual(source);
    expect(() =>
      domainContractSchemaRegistry.parse({ ...source, schema_version: 'agent-release/1' }),
    ).toThrow();
    for (const field of ['compiled_hash', 'capability_closure_hash', 'trusted'])
      expect(() => AgentExecutableSourceV1Schema.parse({ ...source, [field]: hashA })).toThrow();
  });
  it('reuses Agent cross-reference validation before projecting semantics', () => {
    const source = agentSource();
    expect(() =>
      prepareExecutableSource(candidate({ ...source, capability_bindings: [] })),
    ).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() =>
      prepareExecutableSource(
        candidate({
          ...source,
          capability_bindings: [...source.capability_bindings, ...source.capability_bindings],
        }),
      ),
    ).toThrow('CLOSURE_SOURCE_INVALID');
  });
  it('derives the Agent root seed and manifest from actual content and complete pins', () => {
    const result = prepareExecutableSource(candidate());
    expect(result.schema_version).toBe('prepared-executable-source/1');
    expect(result.preimage.schema_version).toBe('executable-semantic-preimage/1');
    expect(result.preimage.compiler_version).toBe('capability-compiler/1');
    expect(result.preimage.canonicalizer_version).toBe('rfc8785/1');
    expect(result.root).toEqual({
      pin: {
        workspace_id: workspaceId,
        published_resource_kind: 'AGENT_RELEASE',
        resource_id: agentId,
        resource_version_id: agentReleaseId,
        contract_hash: canonicalSha256(result.preimage),
        binding_mode: 'pinned',
      },
      semantic_seed_hash: canonicalSha256(result.preimage),
    });
    expect(result.dependency_manifest.dependencies).toEqual([makeStrategyPin(), makePluginPin()]);
    expect(result.dependency_manifest.owner).toEqual({
      workspace_id: workspaceId,
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: agentId,
      resource_version_id: agentReleaseId,
    });
    expect(result.preimage.document).not.toHaveProperty('compiled_hash');
    expect(result.preimage.document).not.toHaveProperty('release_number');
    expect(result.preimage.document).not.toHaveProperty('source_draft_revision_id');
    const {
      release_number: _number,
      source_draft_revision_id: _draft,
      ...expectedDocument
    } = agentSource();
    expect(result.preimage.document).toEqual(expectedDocument);
  });
  it('derives a Flow root without title/UI and composes with the pinned graph API', () => {
    const source = prepareExecutableSource(candidate(makeFlowIr()));
    expect(source.root.pin).toMatchObject({
      published_resource_kind: 'FLOW_VERSION',
      resource_id: flowId,
      resource_version_id: flowVersionId,
    });
    expect(source.preimage.document).not.toHaveProperty('title');
    const graph = preparePinnedDependencyGraph({
      schema_version: 'pinned-dependency-graph-candidate/1',
      root: source.root,
      root_dependencies: source.dependency_manifest.dependencies,
      resources: [],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.dependency_manifest_hash).toBe(source.dependency_manifest.manifest_hash);
  });
  it('ignores only explicit metadata and preserves nested title/UI data', () => {
    const flow = makeFlowIr();
    const first = prepareExecutableSource(candidate(flow));
    expect(
      prepareExecutableSource(candidate({ ...flow, title: 'New title', ui: { x: 8 } })),
    ).toEqual(first);
    expect(
      prepareExecutableSource(
        candidate({ ...flow, input_schema: { title: 'Business schema', ui: ['ordered', 'data'] } }),
      ).root.semantic_seed_hash,
    ).not.toBe(first.root.semantic_seed_hash);
    const agent = agentSource();
    expect(
      prepareExecutableSource(
        candidate({ ...agent, release_number: 2, source_draft_revision_id: otherWorkspaceId }),
      ),
    ).toEqual(prepareExecutableSource(candidate(agent)));
    expect(
      prepareExecutableSource(candidate({ ...agent, role: { title: 'Changed role' } })).root
        .semantic_seed_hash,
    ).not.toBe(prepareExecutableSource(candidate(agent)).root.semantic_seed_hash);
  });
  it.each([
    'role',
    'input_contract',
    'output_contract',
    'model_policy',
    'authorization_policy',
    'runtime_limits',
  ])('retains the opaque %s subcontract without silently dropping its semantic fields', (field) => {
    const first = prepareExecutableSource(candidate());
    const changed = prepareExecutableSource(
      candidate({
        ...agentSource(),
        [field]: { data: ['first', 'second'], nested_hash: 'ordinary input' },
      }),
    );
    expect(changed.root.semantic_seed_hash).not.toBe(first.root.semantic_seed_hash);
  });
  it('preserves order in business arrays rather than sorting unknown subcontracts', () => {
    const agent = agentSource();
    const first = prepareExecutableSource(
      candidate({
        ...agent,
        role: { sequence: ['a', 'b'] },
        task_templates: [{ id: 'a' }, { id: 'b' }],
      }),
    );
    expect(
      prepareExecutableSource(
        candidate({
          ...agent,
          role: { sequence: ['b', 'a'] },
          task_templates: [{ id: 'a' }, { id: 'b' }],
        }),
      ).root.semantic_seed_hash,
    ).not.toBe(first.root.semantic_seed_hash);
    expect(
      prepareExecutableSource(
        candidate({
          ...agent,
          role: { sequence: ['a', 'b'] },
          task_templates: [{ id: 'b' }, { id: 'a' }],
        }),
      ).root.semantic_seed_hash,
    ).not.toBe(first.root.semantic_seed_hash);
  });
  it('detaches and deeply freezes a prepared result', () => {
    const source = { ...agentSource(), role: { content: 'before' } };
    const result = prepareExecutableSource(candidate(source));
    source.role.content = 'after';
    expect(result.preimage.document.role).toEqual({ content: 'before' });
    expect(Object.isFrozen(result.preimage.document.role)).toBe(true);
    expect(Object.isFrozen(result.dependency_manifest.dependencies)).toBe(true);
  });
});

describe('source semantic sets and fixed resource references', () => {
  it('retains every nonempty typed Agent assembly field and canonicalizes its declared sets', () => {
    const source = richAgentSource();
    const output = prepareExecutableSource(candidate(source));
    expect(Object.keys(output.preimage.document).sort()).toEqual(
      Object.keys(source)
        .filter((key) => !['source_draft_revision_id', 'release_number'].includes(key))
        .sort(),
    );
    for (const key of [
      'capability_bindings',
      'gate_specs',
      'instruction_skill_bindings',
      'public_capability_handles',
    ])
      expect(output.preimage.document[key]).toHaveLength(
        (source[key as keyof typeof source] as unknown[]).length,
      );
    expect(output.dependency_manifest.dependencies).toHaveLength(8);
    const permuted = structuredClone(source);
    permuted.capability_bindings.reverse();
    permuted.gate_specs.reverse();
    for (const gate of permuted.gate_specs) gate.protected_operation_contract_hashes.reverse();
    permuted.strategy.allowed_gate_spec_ids.reverse();
    permuted.strategy.allowed_capability_binding_ids.reverse();
    for (const skill of permuted.instruction_skill_bindings)
      skill.allowed_capability_binding_ids.reverse();
    for (const binding of permuted.capability_bindings) {
      if (binding.kind === 'database') binding.config.table_revision_ids.reverse();
      if (binding.kind === 'skill_pack') binding.config.exposed_operations.reverse();
      if (binding.kind === 'subagent') {
        binding.config.input_allowlist.reverse();
        binding.config.context_projection.allowed_message_kinds.reverse();
        binding.config.context_projection.allowed_field_paths.reverse();
        if (binding.config.authorization_delegation.mode === 'bounded_delegation') {
          const policy = binding.config.authorization_delegation.policy;
          policy.allowed_audiences.reverse();
          policy.allowed_scopes.reverse();
          policy.allowed_operation_contract_hashes.reverse();
          policy.allowed_credential_modes.reverse();
          policy.allowed_resource_pins.reverse();
          policy.target_capability_binding_ids.reverse();
        }
      }
    }
    expect(prepareExecutableSource(candidate(permuted))).toEqual(output);
  });
  it.each(['knowledge', 'database', 'plugin', 'flow', 'skill_pack', 'subagent'] as const)(
    'binds %s kind-specific config content and rejects malformed typed hashes',
    (kind) => {
      const source = richAgentSource();
      const binding = source.capability_bindings.find((item) => item.kind === kind);
      if (binding === undefined) throw new Error('missing fixture Binding');
      const before = prepareExecutableSource(candidate(source)).root.semantic_seed_hash;
      switch (binding.kind) {
        case 'knowledge':
          binding.config.metadata_filter_policy_hash = hashA;
          break;
        case 'database':
          binding.config.max_rows += 1;
          break;
        case 'plugin':
          binding.config.default_parameters = { title: 'business data' };
          break;
        case 'flow':
          binding.config = { schema_version: 'flow-binding/1', invocation: 'sync' };
          break;
        case 'skill_pack':
          binding.config.member_projection_hash = hashB;
          break;
        case 'subagent':
          binding.config.max_calls += 1;
          break;
      }
      expect(prepareExecutableSource(candidate(source)).root.semantic_seed_hash).not.toBe(before);
      binding.manual.hash = `${hashA}\n`;
      expect(() => prepareExecutableSource(candidate(source))).toThrow('CLOSURE_SOURCE_INVALID');
    },
  );
  it.each(['gate', 'instruction', 'public_handle', 'strategy'])(
    'binds nonempty %s content to the root semantics',
    (field) => {
      const source = richAgentSource();
      const original = prepareExecutableSource(candidate(source)).root.semantic_seed_hash;
      if (field === 'gate') {
        const gate = source.gate_specs[0];
        if (gate === undefined) throw new Error('missing gate');
        gate.expires_after_seconds += 1;
      } else if (field === 'instruction') {
        const skill = source.instruction_skill_bindings[0];
        if (skill === undefined) throw new Error('missing skill');
        skill.context_budget_tokens += 1;
      } else if (field === 'public_handle') {
        const handle = source.public_capability_handles[0];
        if (handle === undefined) throw new Error('missing handle');
        handle.public_handle = 'changed';
      } else source.strategy.max_iterations += 1;
      expect(prepareExecutableSource(candidate(source)).root.semantic_seed_hash).not.toBe(original);
    },
  );
  it('keeps source and released Agent gate-reference validation identical', () => {
    const source = richAgentSource();
    const released = (body: typeof source) => ({
      ...body,
      schema_version: 'agent-release/1',
      compiled_hash: hashA,
      capability_closure_hash: hashB,
    });
    expect(AgentExecutableSourceV1Schema.safeParse(source).success).toBe(true);
    expect(AgentReleaseV1Schema.safeParse(released(source)).success).toBe(true);
    source.strategy.allowed_gate_spec_ids = ['missing'];
    expect(AgentExecutableSourceV1Schema.safeParse(source).success).toBe(false);
    expect(AgentReleaseV1Schema.safeParse(released(source)).success).toBe(false);
    expect(() => prepareExecutableSource(candidate(source))).toThrow('CLOSURE_SOURCE_INVALID');
  });
  it('normalizes nested graphs but preserves first-match branch case order', () => {
    const flow = nestedFlowSource();
    const first = prepareExecutableSource(candidate(flow));
    const branch = flow.entry_graph.nodes.find((node) => node.type === 'branch');
    if (branch === undefined || !('cases' in branch.config)) throw new Error('missing branch');
    branch.config.cases.reverse();
    expect(prepareExecutableSource(candidate(flow)).root.semantic_seed_hash).not.toBe(
      first.root.semantic_seed_hash,
    );
    branch.config.cases.reverse();
    const loop = branch.config.else_case.graph.nodes[0];
    if (loop === undefined) throw new Error('missing loop');
    for (const graph of [...branch.config.cases.map((item) => item.graph), loop.config.body]) {
      graph.nodes.reverse();
      graph.edges.reverse();
    }
    flow.entry_graph.nodes.reverse();
    expect(prepareExecutableSource(candidate(flow))).toEqual(first);
    expect(() => prepareExecutableSource(candidate({ ...flow, resources: [] }))).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
  });
  it.each(['second_case', 'loop_body', 'else_direct'])(
    'checks isolated subflow drift in %s while sibling references remain valid',
    (location) => {
      const source = nestedFlowSource();
      const branch = source.entry_graph.nodes.find((node) => node.type === 'branch');
      if (branch === undefined || !('cases' in branch.config)) throw new Error('missing branch');
      const loop = branch.config.else_case.graph.nodes[0];
      const secondCase = branch.config.cases[1];
      if (loop === undefined || secondCase === undefined) throw new Error('missing fixture child');
      const graph: FlowGraphV1 = location === 'second_case' ? secondCase.graph : loop.config.body;
      const leaf = graph.nodes.find((node) => node.type === 'subflow');
      if (leaf === undefined) throw new Error('missing nested subflow');
      const config = leaf.config as { target: { flow_version_id: string } };
      config.target.flow_version_id = flowVersionId;
      const branchConfig = branch.config;
      const input =
        location === 'else_direct'
          ? {
              ...source,
              entry_graph: {
                ...source.entry_graph,
                nodes: source.entry_graph.nodes.map((node) =>
                  node === branch
                    ? {
                        ...branch,
                        config: {
                          ...branchConfig,
                          else_case: { ...branchConfig.else_case, graph },
                        },
                      }
                    : node,
                ),
              },
            }
          : source;
      expect(() => prepareExecutableSource(candidate(input))).toThrow('CLOSURE_SOURCE_INVALID');
    },
  );
  it('normalizes binding and requirement sets without changing semantic seed', () => {
    const source = agentSource();
    const binding = source.capability_bindings[0];
    const left = {
      ...binding,
      binding_id: 'a',
      credential_requirement: {
        ...binding.credential_requirement,
        requirement_id: 'a',
        required_scopes: ['z', 'a'],
        allowed_principal_modes: ['team_shared', 'service_principal'],
      },
    };
    const right = {
      ...binding,
      binding_id: 'b',
      credential_requirement: { ...binding.credential_requirement, requirement_id: 'b' },
    };
    const input = {
      ...source,
      capability_bindings: [left, right],
      public_capability_handles: [],
      strategy: { ...source.strategy, allowed_capability_binding_ids: ['a', 'b'] },
    };
    const permuted = {
      ...input,
      capability_bindings: [
        right,
        {
          ...left,
          credential_requirement: {
            ...left.credential_requirement,
            required_scopes: ['a', 'z'],
            allowed_principal_modes: ['service_principal', 'team_shared'],
          },
        },
      ],
      strategy: { ...input.strategy, allowed_capability_binding_ids: ['b', 'a'] },
    };
    expect(prepareExecutableSource(candidate(permuted))).toEqual(
      prepareExecutableSource(candidate(input)),
    );
    expect(prepareExecutableSource(candidate(input)).dependency_manifest.dependencies).toHaveLength(
      2,
    );
  });
  it('canonicalizes Flow node/edge/resource sets but preserves action arrays', () => {
    const flow = makeFlowIr();
    const input = { ...flow, resources: [makePluginPin(), makeStrategyPin()] };
    const reordered = {
      ...input,
      resources: [...input.resources].reverse(),
      entry_graph: {
        ...flow.entry_graph,
        nodes: [...flow.entry_graph.nodes].reverse(),
        edges: [...flow.entry_graph.edges].reverse(),
      },
    };
    expect(prepareExecutableSource(candidate(reordered))).toEqual(
      prepareExecutableSource(candidate(input)),
    );
    const changed = { ...input, execution_defaults: { sequence: ['a', 'b'] } };
    expect(prepareExecutableSource(candidate(changed)).root.semantic_seed_hash).not.toBe(
      prepareExecutableSource(
        candidate({ ...changed, execution_defaults: { sequence: ['b', 'a'] } }),
      ).root.semantic_seed_hash,
    );
  });
  it('requires subflow targets to resolve to an exact Flow resource pin', () => {
    const flow = makeFlowIr();
    const target = { ...makeFlowPin(), resource_id: agentId, resource_version_id: agentReleaseId };
    const node = {
      ...flow.entry_graph.nodes[1],
      type: 'subflow',
      config: {
        target: { flow_id: target.resource_id, flow_version_id: target.resource_version_id },
        inputs: {},
        output_mapping: {},
        invocation: 'sync',
      },
    };
    const input = {
      ...flow,
      entry_graph: { ...flow.entry_graph, nodes: [flow.entry_graph.nodes[0], node] },
      resources: [target],
    };
    expect(prepareExecutableSource(candidate(input)).dependency_manifest.dependencies).toEqual([
      target,
    ]);
    expect(() => prepareExecutableSource(candidate({ ...input, resources: [] }))).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
    expect(() =>
      prepareExecutableSource(
        candidate({
          ...input,
          resources: [{ ...target, published_resource_kind: 'AGENT_RELEASE' }],
        }),
      ),
    ).toThrow('CLOSURE_SOURCE_INVALID');
  });
  it('retains disabled bindings as fixed dependencies rather than hiding their resources', () => {
    const {
      compiled_hash: _compiled,
      capability_closure_hash: _closure,
      ...body
    } = makeAgentRelease({ enabled: false });
    expect(
      prepareExecutableSource(candidate({ ...body, schema_version: 'agent-executable-source/1' }))
        .dependency_manifest.dependencies,
    ).toHaveLength(2);
  });
  it.each(['enabled', 'timeout_ms', 'default_parameters'])(
    'binds non-pin Binding semantic change %s to the seed',
    (field) => {
      const input = agentSource();
      const binding = input.capability_bindings[0];
      const changed =
        field === 'default_parameters'
          ? { ...binding, config: { ...binding.config, default_parameters: { input: 'changed' } } }
          : { ...binding, [field]: field === 'enabled' ? false : 2000 };
      expect(
        prepareExecutableSource(candidate({ ...input, capability_bindings: [changed] })).root
          .semantic_seed_hash,
      ).not.toBe(prepareExecutableSource(candidate(input)).root.semantic_seed_hash);
    },
  );
  it('rejects cross-workspace and conflicting full pins', () => {
    expect(() =>
      prepareExecutableSource(
        candidate({ ...makeFlowIr(), resources: [makePluginPin(otherWorkspaceId)] }),
      ),
    ).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() =>
      prepareExecutableSource(
        candidate({
          ...makeFlowIr(),
          resources: [makePluginPin(), { ...makePluginPin(), contract_hash: hashA }],
        }),
      ),
    ).toThrow('CLOSURE_SOURCE_INVALID');
  });
  it.each(['workspace', 'resource', 'version'])('rejects noncanonical %s UUID aliases', (field) => {
    const document = agentSource();
    const input =
      field === 'workspace'
        ? candidate(document, workspaceId.toUpperCase())
        : candidate({
            ...document,
            [field === 'resource' ? 'agent_id' : 'agent_release_id']: 'not-a-uuid',
          });
    expect(() => prepareExecutableSource(input)).toThrow('CLOSURE_SOURCE_INVALID');
  });
  it('rejects root version self-dependencies even when the eventual hash differs from the seed', () => {
    expect(() =>
      prepareExecutableSource(candidate({ ...makeFlowIr(), resources: [makeFlowPin()] })),
    ).toThrow('CAPABILITY_DEPENDENCY_CYCLE');
  });
});

describe('executable source absolute budgets', () => {
  it('enforces 4096 aggregate Flow nodes across sibling loop bodies, not just each local graph', () => {
    function source(extra: boolean) {
      const flow = makeFlowIr();
      const bodies = [1023, 1023, 1023, extra ? 1023 : 1022].map((count, bodyIndex) => {
        const nodes = Array.from({ length: count }, (_, index) => ({
          node_id: `n${index}`,
          key: `n${index}`,
          type: 'output',
          config: {},
          inputs: {},
          output_schema: {},
        }));
        return {
          graph_id: `body-${bodyIndex}`,
          entry_node_id: 'n0',
          exit_node_ids: [`n${count - 1}`],
          nodes,
          edges: Array.from({ length: count - 1 }, (_, index) => ({
            edge_id: `e${index}`,
            kind: 'control',
            from: { node_id: `n${index}`, port: 'next' },
            to: { node_id: `n${index + 1}`, port: 'in' },
          })),
        };
      });
      const nodes = [
        flow.entry_graph.nodes[0],
        ...bodies.map((body, index) => ({
          node_id: `loop${index}`,
          key: `loop${index}`,
          type: 'loop',
          inputs: {},
          output_schema: {},
          config: {
            mode: 'condition',
            continue_when: 'true',
            max_iterations: 1,
            body,
            exports: {},
          },
        })),
      ];
      return candidate({
        ...flow,
        entry_graph: {
          graph_id: 'root',
          entry_node_id: 'start-1',
          exit_node_ids: ['loop3'],
          nodes,
          edges: bodies.map((_, index) => ({
            edge_id: `root${index}`,
            kind: 'control',
            from: { node_id: index === 0 ? 'start-1' : `loop${index - 1}`, port: 'next' },
            to: { node_id: `loop${index}`, port: 'in' },
          })),
        },
      });
    }
    expect(() => prepareExecutableSource(source(false))).not.toThrow();
    expect(() => prepareExecutableSource(source(true))).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
  });
  it('supports full JSON scalars and exact field/key UTF-8 limits', () => {
    const value = {
      values: [null, false, 1.25, -0],
      prompt: '😀'.repeat(16384),
      ['😀'.repeat(64)]: 'value',
    };
    expect(boundedDataSnapshot(value, 'source')).toEqual({
      ...value,
      values: [null, false, 1.25, 0],
    });
    expect(() => boundedDataSnapshot({ ...value, prompt: `${value.prompt}x` }, 'source')).toThrow(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    );
    expect(() => boundedDataSnapshot({ [`${'😀'.repeat(64)}x`]: '' }, 'source')).toThrow(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    );
  });
  it('counts key bytes toward the exact 8 MiB source budget', () => {
    const keysSize = Array.from({ length: 128 }, (_, index) =>
      Buffer.byteLength(String(index)),
    ).reduce((sum, length) => sum + length, 0);
    const values = Array.from({ length: 128 }, (_, index) =>
      'x'.repeat(index === 127 ? 65536 - keysSize : 65536),
    );
    expect(boundedDataSnapshot(values, 'source')).toEqual(values);
    values[127] += 'x';
    expect(() => boundedDataSnapshot(values, 'source')).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
  });
  it('accepts 64 nesting levels, 128 object fields and 1024 array entries but rejects +1', () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 64; depth += 1) nested = { child: nested };
    expect(boundedDataSnapshot(nested, 'source')).toEqual(nested);
    expect(() => boundedDataSnapshot({ child: nested }, 'source')).toThrow(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    );
    const fields = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [index, null]));
    expect(boundedDataSnapshot(fields, 'source')).toEqual(fields);
    expect(() => boundedDataSnapshot({ ...fields, extra: null }, 'source')).toThrow(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    );
    expect(boundedDataSnapshot(Array(1024).fill(null), 'source')).toHaveLength(1024);
    expect(() => boundedDataSnapshot(Array(1025).fill(null), 'source')).toThrow(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    );
  });
  it('counts containers and repeated shared input references in the value budget', () => {
    const exact = Array.from({ length: 128 }, (_, index) =>
      Array(index === 127 ? 1022 : 1023).fill(null),
    );
    expect(boundedDataSnapshot(exact, 'source')).toEqual(exact);
    expect(() => boundedDataSnapshot(Array(128).fill(Array(1023).fill(null)), 'source')).toThrow(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    );
  });
});

describe('typed source hash spellings', () => {
  it.each(['knowledge', 'database', 'plugin', 'skill_pack', 'subagent'] as const)(
    'validates the nested %s hash, not only its resource pin',
    (kind) => {
      const source = richAgentSource();
      const binding = source.capability_bindings.find((item) => item.kind === kind);
      if (binding === undefined) throw new Error('missing Binding');
      switch (binding.kind) {
        case 'knowledge':
          binding.config.query_contract_hash = 'invalid';
          break;
        case 'database':
          binding.config.operation_contract_hash = 'invalid';
          break;
        case 'plugin':
          binding.config.transport_contract_hash = 'invalid';
          break;
        case 'skill_pack': {
          const operation = binding.config.exposed_operations[0];
          if (operation === undefined) throw new Error('missing operation');
          operation.exposed_operation_contract_hash = 'invalid';
          break;
        }
        case 'subagent':
          binding.config.context_projection.serializer_pin.implementation_digest = 'invalid';
          break;
      }
      expect(() => prepareExecutableSource(candidate(source))).toThrow('CLOSURE_SOURCE_INVALID');
    },
  );
  it.each(['gate', 'instruction', 'public_handle'])('validates typed %s digest fields', (field) => {
    const source = richAgentSource();
    if (field === 'gate') {
      const gate = source.gate_specs[0];
      if (gate === undefined) throw new Error('missing gate');
      gate.decision_schema_hash = `${hashA}\n`;
    } else if (field === 'instruction') {
      const skill = source.instruction_skill_bindings[0];
      if (skill === undefined) throw new Error('missing skill');
      skill.content_hash = 'invalid';
    } else {
      const handle = source.public_capability_handles[0];
      if (handle === undefined) throw new Error('missing handle');
      handle.input_schema_hash = 'invalid';
    }
    expect(() => prepareExecutableSource(candidate(source))).toThrow('CLOSURE_SOURCE_INVALID');
  });
});

describe('source boundary and verification', () => {
  it('rejects schema parsing that would silently discard an own __proto__ data key', () => {
    const role = JSON.parse('{"__proto__":{"semantic":"must not disappear"},"content":"visible"}');
    expect(() => prepareExecutableSource(candidate({ ...agentSource(), role }))).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
    expect(Object.prototype).not.toHaveProperty('semantic');
  });
  it.each(['input_schema', 'execution_defaults', 'node_inputs', 'nested_agent_role'])(
    'rejects silent special-key removal in %s',
    (location) => {
      const hidden = JSON.parse('{"__proto__":{"data":"must remain bound"}}');
      const flow = makeFlowIr();
      const input =
        location === 'nested_agent_role'
          ? { ...agentSource(), role: { child: { list: [hidden] } } }
          : location === 'node_inputs'
            ? {
                ...flow,
                entry_graph: {
                  ...flow.entry_graph,
                  nodes: flow.entry_graph.nodes.map((node) => ({ ...node, inputs: hidden })),
                },
              }
            : { ...flow, [location]: hidden };
      expect(() => prepareExecutableSource(candidate(input))).toThrow('CLOSURE_SOURCE_INVALID');
    },
  );
  it.each([
    ['unknown envelope field', { ...candidate(), trusted: true }],
    [
      'wrong candidate version',
      { ...candidate(), schema_version: 'executable-source-candidate/2' },
    ],
    ['released document as source', candidate(makeAgentRelease())],
    ['unknown document field', candidate({ ...agentSource(), hidden: true })],
    [
      'wrong strategy hash',
      candidate({
        ...agentSource(),
        strategy: { ...agentSource().strategy, config_hash: 'sha256:wrong' },
      }),
    ],
    [
      'newline strategy hash',
      candidate({
        ...agentSource(),
        strategy: { ...agentSource().strategy, implementation_digest: `${hashA}\n` },
      }),
    ],
    [
      'invalid pin hash',
      candidate({
        ...makeFlowIr(),
        resources: [{ ...makePluginPin(), contract_hash: 'sha256:wrong' }],
      }),
    ],
  ])('rejects %s', (_label, input) =>
    expect(() => prepareExecutableSource(input)).toThrow('CLOSURE_SOURCE_INVALID'),
  );
  it('does not run source Proxy or accessor code', () => {
    const trap = vi.fn(() => {
      throw new Error('must not execute');
    });
    const getter = candidate();
    Object.defineProperty(getter, 'document', { get: trap, enumerable: true });
    for (const input of [
      getter,
      new Proxy(candidate(), { get: trap, ownKeys: trap }),
      candidate({ ...agentSource(), role: new Proxy({}, { ownKeys: trap }) }),
    ])
      expect(() => prepareExecutableSource(input)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(trap).not.toHaveBeenCalled();
  });
  it('bounds source strings before schema or JCS expansion', () => {
    expect(() =>
      prepareExecutableSource(candidate({ ...agentSource(), role: { prompt: 'x'.repeat(65537) } })),
    ).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    expect(() =>
      prepareExecutableSource(
        candidate({
          ...agentSource(),
          role: { prompt: '\u0001'.repeat(65536), data: Array(24).fill('\u0001'.repeat(65536)) },
        }),
      ),
    ).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
  });
  it('verifies the entire prepared artifact against the source, never its self-reported hash', () => {
    const input = candidate();
    const result = prepareExecutableSource(input);
    expect(verifyExecutableSource(result, input)).toEqual(result);
    expect(() =>
      verifyExecutableSource(
        { ...result, root: { ...result.root, semantic_seed_hash: hashB } },
        input,
      ),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
    expect(() =>
      verifyExecutableSource(
        { ...result, dependency_manifest: { ...result.dependency_manifest, dependencies: [] } },
        input,
      ),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
    expect(() =>
      verifyExecutableSource(
        { ...result, preimage: { ...result.preimage, compiler_version: 'capability-compiler/2' } },
        input,
      ),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
  });
});

describe('executable compiled hash binding', () => {
  it.each([
    ['Agent', agentSource()],
    ['Flow', makeFlowIr()],
  ])(
    'derives and verifies %s compiled hashes from source, versions and a separate closure hash',
    (_label, document) => {
      const input = candidate(document);
      const source = prepareExecutableSource(input);
      const digest = deriveExecutableCompiledHash(input, hashA);
      expect(digest).toBe(
        canonicalSha256({
          ...source.preimage,
          schema_version: 'executable-compiled-preimage/1',
          capability_closure_hash: hashA,
        }),
      );
      expect(digest).not.toBe(source.root.semantic_seed_hash);
      const finalPin = { ...source.root.pin, contract_hash: digest };
      expect(() => verifyExecutableCompiledHash(finalPin, input, hashA)).not.toThrow();
      expect(() => verifyExecutableCompiledHash(finalPin, input, hashB)).toThrow(
        'CLOSURE_SOURCE_MISMATCH',
      );
      expect(() => verifyExecutableCompiledHash(source.root.pin, input, hashA)).toThrow(
        'CLOSURE_SOURCE_MISMATCH',
      );
    },
  );
  it.each(['published_resource_kind', 'resource_id', 'resource_version_id', 'contract_hash'])(
    'verifies compiled pin %s, not only one hash',
    (field) => {
      const input = candidate();
      const pin = {
        ...prepareExecutableSource(input).root.pin,
        contract_hash: deriveExecutableCompiledHash(input, hashA),
      };
      const wrong =
        field === 'published_resource_kind'
          ? 'FLOW_VERSION'
          : field === 'contract_hash'
            ? hashB
            : flowId;
      expect(() => verifyExecutableCompiledHash({ ...pin, [field]: wrong }, input, hashA)).toThrow(
        'CLOSURE_SOURCE_MISMATCH',
      );
    },
  );
  it.each(['sha256:bad', `${hashA}\n`, hashA.toUpperCase(), '', null])(
    'rejects noncanonical closure digest %s',
    (digest) => {
      expect(() => deriveExecutableCompiledHash(candidate(), digest)).toThrow(
        'CLOSURE_SOURCE_INVALID',
      );
    },
  );
  it('rejects compiled hash reuse after source semantics or Workspace changes', () => {
    const input = candidate();
    const digest = deriveExecutableCompiledHash(input, hashA);
    const finalPin = { ...prepareExecutableSource(input).root.pin, contract_hash: digest };
    const changed = candidate({ ...agentSource(), role: { content: 'new semantics' } });
    expect(() => verifyExecutableCompiledHash(finalPin, changed, hashA)).toThrow(
      'CLOSURE_SOURCE_MISMATCH',
    );
    expect(() =>
      verifyExecutableCompiledHash({ ...finalPin, workspace_id: otherWorkspaceId }, input, hashA),
    ).toThrow('CLOSURE_SOURCE_INVALID');
  });
});
