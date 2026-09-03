import { describe, expect, it, vi } from 'vitest';

import type { PublishedResourcePinV1 } from '@better-agent/domain-contracts';
import { boundedDataSnapshot } from '../src/bounded-data-snapshot.js';
import {
  canonicalResourceNodeId,
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  deriveDependencyManifest,
  preparePinnedDependencyGraph,
  verifyPinnedDependencyGraph,
} from '../src/index.js';
import { hashA, hashB, otherWorkspaceId, workspaceId } from './fixtures.js';

function uuid(value: number) {
  return `00000000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
}
function pin(
  index: number,
  kind: PublishedResourcePinV1['published_resource_kind'] = 'PLUGIN_TOOL_RELEASE',
): PublishedResourcePinV1 {
  return {
    workspace_id: workspaceId,
    published_resource_kind: kind,
    resource_id: uuid(index * 2 + 1),
    resource_version_id: uuid(index * 2 + 2),
    contract_hash: hashA,
    binding_mode: 'pinned',
  };
}
function record(resource: PublishedResourcePinV1, dependencies: PublishedResourcePinV1[] = []) {
  const { contract_hash: _hash, binding_mode: _mode, ...owner } = resource;
  return {
    schema_version: 'pinned-dependency-record/1',
    pin: resource,
    publication_state: 'sealed',
    dependency_manifest: structuredClone(deriveDependencyManifest(owner, dependencies)),
    ...(resource.published_resource_kind === 'AGENT_RELEASE' ||
    resource.published_resource_kind === 'FLOW_VERSION'
      ? { nested_closure_hash: hashB }
      : {}),
  };
}
function candidate(
  dependencies: PublishedResourcePinV1[] = [pin(1)],
  records = dependencies.map((dependency) => record(dependency)),
) {
  return {
    schema_version: 'pinned-dependency-graph-candidate/1',
    root: { pin: pin(0, 'AGENT_RELEASE'), semantic_seed_hash: hashA },
    root_dependencies: dependencies,
    resources: records,
  };
}
function graphNodeIds(graph: ReturnType<typeof preparePinnedDependencyGraph>) {
  return graph.nodes.map((node) => node.node_id);
}

function requiredPin(pins: readonly PublishedResourcePinV1[], index: number) {
  const value = pins[index];
  if (value === undefined) throw new Error(`fixture is missing pin ${index}`);
  return value;
}

describe('pinned dependency graph preparation', () => {
  it('produces a canonical immutable graph with the complete root and dependency identities', () => {
    const input = candidate();
    const graph = preparePinnedDependencyGraph(input);
    expect(graph.schema_version).toBe('pinned-dependency-graph/1');
    expect(graph.root).toEqual(input.root);
    expect(graph.root_node_id).toBe(canonicalResourceNodeId(input.root.pin));
    expect(graphNodeIds(graph)).toEqual(
      [canonicalResourceNodeId(input.root.pin), canonicalResourceNodeId(pin(1))].sort(),
    );
    const dependency = input.resources[0];
    if (dependency === undefined) throw new Error('fixture needs resource');
    expect(
      graph.nodes.find((node) => node.node_id === canonicalResourceNodeId(dependency.pin))
        ?.dependency_manifest_hash,
    ).toBe(dependency.dependency_manifest.manifest_hash);
    const { contract_hash: _rootHash, binding_mode: _rootMode, ...rootOwner } = input.root.pin;
    expect(
      graph.nodes.find((node) => node.node_id === graph.root_node_id)?.dependency_manifest_hash,
    ).toBe(deriveDependencyManifest(rootOwner, input.root_dependencies).manifest_hash);
    expect(graph.edges).toEqual([
      { from_node_id: graph.root_node_id, to_node_id: canonicalResourceNodeId(pin(1)) },
    ]);
    expect(graph.dependency_order).toEqual([canonicalResourceNodeId(pin(1)), graph.root_node_id]);
    expect(graph.graph_hash).toBe(canonicalSha256ExcludingRootKeys(graph, ['graph_hash']));
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes[0]?.pin)).toBe(true);
    input.root.pin.resource_id = uuid(700);
    expect(graph.root.pin.resource_id).toBe(uuid(1));
  });

  it('supports an empty Agent or Flow root without inventing a dependency', () => {
    const input = candidate([], []);
    expect(preparePinnedDependencyGraph(input).nodes).toHaveLength(1);
    input.root.pin.published_resource_kind = 'FLOW_VERSION';
    expect(preparePinnedDependencyGraph(input).edges).toEqual([]);
  });

  it('deduplicates shared dependencies, preserving both edges and child-first ordering', () => {
    const a = pin(1, 'FLOW_VERSION');
    const b = pin(2, 'SKILL_PACK_RELEASE');
    const leaf = pin(3);
    const input = candidate([a, b], [record(a, [leaf]), record(b, [leaf]), record(leaf)]);
    const graph = preparePinnedDependencyGraph(input);
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(4);
    for (const edge of graph.edges)
      expect(graph.dependency_order.indexOf(edge.to_node_id)).toBeLessThan(
        graph.dependency_order.indexOf(edge.from_node_id),
      );
    expect(
      graph.nodes.find((node) => node.pin.published_resource_kind === 'FLOW_VERSION')
        ?.nested_closure_hash,
    ).toBe(hashB);
  });

  it('is stable under record/dependency permutations and identical dependency repetitions', () => {
    const a = pin(1);
    const b = pin(2);
    const c = pin(3);
    const input = candidate([a, b], [record(a, [c]), record(b, [c]), record(c)]);
    const reordered = structuredClone(input);
    reordered.root_dependencies = [b, a, b];
    reordered.resources.reverse();
    expect(preparePinnedDependencyGraph(reordered)).toEqual(preparePinnedDependencyGraph(input));
    const multi = candidate([a], [record(a, [b, c]), record(b), record(c)]);
    const manifest = multi.resources[0]?.dependency_manifest;
    if (manifest === undefined) throw new Error('fixture needs manifest');
    const changed = {
      ...multi,
      resources: multi.resources.map((value, index) =>
        index
          ? value
          : {
              ...value,
              dependency_manifest: {
                ...manifest,
                dependencies: [...manifest.dependencies].reverse(),
              },
            },
      ),
    };
    expect(preparePinnedDependencyGraph(changed)).toEqual(preparePinnedDependencyGraph(multi));
  });

  it('distinguishes the same version UUID across resource identities and kinds', () => {
    const a = pin(1);
    const b = { ...pin(2), resource_version_id: a.resource_version_id };
    const c = { ...a, published_resource_kind: 'KNOWLEDGE_INDEX_GENERATION' as const };
    const graph = preparePinnedDependencyGraph(candidate([a, b, c]));
    expect(new Set(graphNodeIds(graph)).size).toBe(4);
  });

  it('binds the graph digest to nested closure metadata and exact dependency manifest', () => {
    const flow = pin(1, 'FLOW_VERSION');
    const input = candidate([flow]);
    const graph = preparePinnedDependencyGraph(input);
    const changed = candidate([flow], [{ ...record(flow), nested_closure_hash: hashA }]);
    expect(preparePinnedDependencyGraph(changed).graph_hash).not.toBe(graph.graph_hash);
  });
});

describe('manifest and typed registry boundaries', () => {
  it.each([
    'workspace_id',
    'published_resource_kind',
    'resource_id',
    'resource_version_id',
  ] as const)('rejects a manifest with a different %s owner even when rehashed', (field) => {
    const input = candidate();
    const entry = input.resources[0];
    if (entry === undefined) throw new Error('fixture needs resource');
    const owner = {
      ...entry.dependency_manifest.owner,
      [field]: field === 'published_resource_kind' ? 'FLOW_VERSION' : uuid(999),
    };
    const manifest = { ...entry.dependency_manifest, owner };
    expect(() =>
      preparePinnedDependencyGraph({
        ...input,
        resources: [
          {
            ...entry,
            dependency_manifest: {
              ...manifest,
              manifest_hash: canonicalSha256ExcludingRootKeys(manifest, ['manifest_hash']),
            },
          },
        ],
      }),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects a forged manifest digest and missing transitive dependencies', () => {
    const entry = record(pin(1), [pin(2)]);
    expect(() => preparePinnedDependencyGraph(candidate([pin(1)], [entry]))).toThrow(
      'CAPABILITY_DEPENDENCY_UNRESOLVED',
    );
    const input = candidate(
      [pin(1)],
      [
        { ...entry, dependency_manifest: { ...entry.dependency_manifest, manifest_hash: hashB } },
        record(pin(2)),
      ],
    );
    expect(() => preparePinnedDependencyGraph(input)).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects replacing a referenced full pin with another hash of the same version', () => {
    expect(() =>
      preparePinnedDependencyGraph(
        candidate([pin(1)], [record({ ...pin(1), contract_hash: hashB })]),
      ),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects conflicting version hashes even on distinct dependency paths', () => {
    const left = pin(1);
    const right = pin(2);
    const shared = pin(3);
    const drift = { ...shared, contract_hash: hashB };
    expect(() =>
      preparePinnedDependencyGraph(
        candidate(
          [left, right],
          [record(left, [shared]), record(right, [drift]), record(shared), record(drift)],
        ),
      ),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects duplicate records and unrelated snapshot records', () => {
    expect(() =>
      preparePinnedDependencyGraph(candidate([pin(1)], [record(pin(1)), record(pin(1))])),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
    expect(() =>
      preparePinnedDependencyGraph(candidate([pin(1)], [record(pin(1)), record(pin(2))])),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it('rejects cross-workspace records and dependencies without a typed global provenance', () => {
    const foreign = { ...pin(2), workspace_id: otherWorkspaceId };
    expect(() =>
      preparePinnedDependencyGraph(candidate([foreign], [{ ...record(pin(2)), pin: foreign }])),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
    const base = record(pin(1));
    const manifest = { ...base.dependency_manifest, dependencies: [foreign] };
    expect(() =>
      preparePinnedDependencyGraph(
        candidate(
          [pin(1)],
          [
            {
              ...base,
              dependency_manifest: {
                ...manifest,
                manifest_hash: canonicalSha256ExcludingRootKeys(manifest, ['manifest_hash']),
              },
            },
          ],
        ),
      ),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it.each(['AGENT_RELEASE', 'FLOW_VERSION'] as const)(
    'requires a canonical nested closure hash for %s',
    (kind) => {
      const entry = record(pin(1, kind));
      const { nested_closure_hash: _hash, ...missing } = entry;
      for (const resource of [missing, { ...entry, nested_closure_hash: 'sha256:short' }])
        expect(() =>
          preparePinnedDependencyGraph({ ...candidate([entry.pin]), resources: [resource] }),
        ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
    },
  );

  it.each([
    'PLUGIN_TOOL_RELEASE',
    'KNOWLEDGE_INDEX_GENERATION',
    'DATABASE_OPERATION_RELEASE',
    'SKILL_PACK_RELEASE',
    'A2A_AGENT_RELEASE',
    'AGENT_STRATEGY_RELEASE',
    'INSTRUCTION_SKILL_RELEASE',
    'EXPERIENCE_RELEASE',
    'DEPLOYMENT_REVISION',
    'SYSTEM_RELEASE',
  ] as const)('forbids nested closure metadata on %s', (kind) => {
    const resource = pin(1, kind);
    expect(() =>
      preparePinnedDependencyGraph(
        candidate([resource], [{ ...record(resource), nested_closure_hash: hashA }]),
      ),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });

  it.each(['draft', 'pending', 'revoked', 'SEALED'])(
    'rejects publication state %s without promoting it',
    (publication_state) => {
      expect(() =>
        preparePinnedDependencyGraph(
          candidate([pin(1)], [{ ...record(pin(1)), publication_state }]),
        ),
      ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
    },
  );
});

describe('resource cycle and absolute expansion limits', () => {
  it('rejects direct root recursion without needing a second registry row', () => {
    const input = candidate([], []);
    input.root_dependencies = [input.root.pin];
    expect(() => preparePinnedDependencyGraph(input)).toThrow('CAPABILITY_DEPENDENCY_CYCLE');
  });
  it('rejects indirect Agent/Flow/Pack recursion', () => {
    const a = pin(1, 'AGENT_RELEASE');
    const b = pin(2, 'FLOW_VERSION');
    const c = pin(3, 'SKILL_PACK_RELEASE');
    expect(() =>
      preparePinnedDependencyGraph(
        candidate([a], [record(a, [b]), record(b, [c]), record(c, [a])]),
      ),
    ).toThrow('CAPABILITY_DEPENDENCY_CYCLE');
  });
  it('rejects a root version reached under a final hash instead of the closure seed', () => {
    const input = candidate();
    const entry = record(pin(1), [{ ...input.root.pin, contract_hash: hashB }]);
    expect(() => preparePinnedDependencyGraph({ ...input, resources: [entry] })).toThrow(
      'CAPABILITY_DEPENDENCY_CYCLE',
    );
  });
  it('accepts 256 total nodes and rejects 257 without truncation', () => {
    const resources = Array.from({ length: 255 }, (_, index) => pin(index + 1));
    expect(preparePinnedDependencyGraph(candidate(resources)).nodes).toHaveLength(256);
    expect(() => preparePinnedDependencyGraph(candidate([...resources, pin(256)]))).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });
  it('accepts 1024 edges and rejects the next edge without discarding a manifest', () => {
    const parents = Array.from({ length: 31 }, (_, index) => pin(index + 1));
    const leaves = Array.from({ length: 32 }, (_, index) => pin(index + 50));
    const entries = [
      ...parents.map((parent) => record(parent, leaves)),
      ...leaves.map((leaf) => record(leaf)),
    ];
    const input = candidate([...parents, leaves[0] as PublishedResourcePinV1], entries);
    expect(preparePinnedDependencyGraph(input).edges).toHaveLength(1024);
    expect(() =>
      preparePinnedDependencyGraph({
        ...input,
        root_dependencies: [...input.root_dependencies, leaves[1]],
      }),
    ).toThrow('CAPABILITY_CLOSURE_LIMIT_EXCEEDED');
  });
  it('uses the longest root path even when a shared node is first visited by a shorter path', () => {
    const chain = Array.from({ length: 33 }, (_, index) => pin(index + 1));
    const entries = chain.map((resource, index) =>
      record(resource, chain.slice(index + 1, index + 2)),
    );
    expect(
      preparePinnedDependencyGraph(
        candidate([chain[1] as PublishedResourcePinV1], entries.slice(1)),
      ).nodes,
    ).toHaveLength(33);
    const deep = candidate(
      [chain[32] as PublishedResourcePinV1, chain[0] as PublishedResourcePinV1],
      entries,
    );
    expect(() => preparePinnedDependencyGraph(deep)).toThrow('CAPABILITY_CLOSURE_LIMIT_EXCEEDED');
    expect(() =>
      preparePinnedDependencyGraph({
        ...deep,
        root_dependencies: [...deep.root_dependencies].reverse(),
      }),
    ).toThrow('CAPABILITY_CLOSURE_LIMIT_EXCEEDED');
  });
  it('retains the cached non-leaf subtree height when a later path reaches the same node', () => {
    function sharedSubtree(count: number) {
      const chain = Array.from({ length: count }, (_, index) => pin(index + 1));
      const head = requiredPin(chain, 0);
      const middle = requiredPin(chain, 5);
      // Freeze the traversal premise: the direct middle edge is visited before the chain head.
      expect(canonicalResourceNodeId(middle) < canonicalResourceNodeId(head)).toBe(true);
      return candidate(
        [head, middle],
        chain.map((resource, index) => record(resource, chain.slice(index + 1, index + 2))),
      );
    }
    expect(preparePinnedDependencyGraph(sharedSubtree(32)).nodes).toHaveLength(33);
    expect(() => preparePinnedDependencyGraph(sharedSubtree(33))).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });
});

describe('untrusted graph input and load verification', () => {
  it.each([
    ['extra candidate field', { ...candidate(), trusted: 'yes' }],
    ['bad version', { ...candidate(), schema_version: 'pinned-dependency-graph-candidate/2' }],
    ['wrong root kind', { ...candidate(), root: { ...candidate().root, pin: pin(0) } }],
    ['wrong seed', { ...candidate(), root: { ...candidate().root, semantic_seed_hash: hashB } }],
    [
      'invalid UUID',
      {
        ...candidate(),
        root: { ...candidate().root, pin: { ...candidate().root.pin, resource_id: 'bare-id' } },
      },
    ],
    [
      'UUID alias',
      {
        ...candidate(),
        root: {
          ...candidate().root,
          pin: { ...candidate().root.pin, workspace_id: workspaceId.toUpperCase() },
        },
      },
    ],
    [
      'hash newline',
      {
        ...candidate(),
        root: {
          ...candidate().root,
          pin: { ...candidate().root.pin, contract_hash: `${hashA}\n` },
        },
      },
    ],
    ['unbounded field', { ...candidate(), schema_version: 'x'.repeat(4097) }],
    [
      'floating pin',
      { ...candidate(), root_dependencies: [{ ...pin(1), binding_mode: 'latest' }] },
    ],
  ])('rejects %s with a graph-scoped error', (_label, input) => {
    expect(() => preparePinnedDependencyGraph(input)).toThrow(
      /CAPABILITY_(GRAPH_INPUT_INVALID|DEPENDENCY_UNRESOLVED|CLOSURE_LIMIT_EXCEEDED)/u,
    );
  });
  it('rejects Proxies/getters before invoking traps and remains reusable after failure', () => {
    const trap = vi.fn(() => {
      throw new Error('must not execute');
    });
    const input = candidate();
    Object.defineProperty(input, 'resources', { enumerable: true, get: trap });
    const nested = {
      ...candidate(),
      resources: [new Proxy(record(pin(1)), { ownKeys: trap, get: trap })],
    };
    for (const value of [input, nested, new Proxy(candidate(), { get: trap, ownKeys: trap })])
      expect(() => preparePinnedDependencyGraph(value)).toThrow('CAPABILITY_GRAPH_INPUT_INVALID');
    expect(trap).not.toHaveBeenCalled();
    expect(preparePinnedDependencyGraph(candidate()).nodes).toHaveLength(2);
  });
  it('verifies all canonical bytes against the candidate, not only a self-reported hash', () => {
    const input = candidate();
    const graph = preparePinnedDependencyGraph(input);
    expect(verifyPinnedDependencyGraph(graph, input)).toEqual(graph);
    const { graph_hash: _hash, ...content } = graph;
    const changed = { ...content, edges: [] };
    expect(() =>
      verifyPinnedDependencyGraph({ ...changed, graph_hash: canonicalSha256(changed) }, input),
    ).toThrow('CAPABILITY_GRAPH_HASH_MISMATCH');
    const changedManifest = {
      ...content,
      nodes: content.nodes.map((node) => ({ ...node, dependency_manifest_hash: hashB })),
    };
    expect(() =>
      verifyPinnedDependencyGraph(
        { ...changedManifest, graph_hash: canonicalSha256(changedManifest) },
        input,
      ),
    ).toThrow('CAPABILITY_GRAPH_HASH_MISMATCH');
    expect(() => verifyPinnedDependencyGraph({ ...graph, graph_hash: hashB }, input)).toThrow(
      'CAPABILITY_GRAPH_HASH_MISMATCH',
    );
    expect(() =>
      verifyPinnedDependencyGraph({ ...graph, nodes: [...graph.nodes].reverse() }, input),
    ).toThrow('CAPABILITY_GRAPH_HASH_MISMATCH');
    expect(() => verifyPinnedDependencyGraph({ ...graph, trusted: 'yes' }, input)).toThrow(
      'CAPABILITY_GRAPH_HASH_MISMATCH',
    );
  });
});

describe('graph snapshot profile budgets', () => {
  it('accepts 1024 array entries and 12 object fields, rejecting either next entry', () => {
    expect(boundedDataSnapshot(Array(1024).fill(''), 'graph')).toHaveLength(1024);
    expect(() => boundedDataSnapshot(Array(1025).fill(''), 'graph')).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
    const fields = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index, '']));
    expect(Object.keys(boundedDataSnapshot(fields, 'graph') as object)).toHaveLength(12);
    expect(() => boundedDataSnapshot({ ...fields, extra: '' }, 'graph')).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });

  it('counts structural depth through both arrays and objects', () => {
    let value: unknown = '';
    for (let index = 0; index < 12; index += 1)
      value = index % 2 === 0 ? [value] : { child: value };
    expect(boundedDataSnapshot(value, 'graph')).toEqual(value);
    expect(() => boundedDataSnapshot({ child: value }, 'graph')).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });

  it('counts exactly 131072 values, including containers and repeated shared references', () => {
    const entries = Array.from({ length: 128 }, (_, index) =>
      Array(index === 127 ? 1022 : 1023).fill(''),
    );
    expect(boundedDataSnapshot(entries, 'graph')).toEqual(entries);
    expect(() => boundedDataSnapshot(Array(128).fill(Array(1023).fill('')), 'graph')).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });

  it('counts 8 MiB of aggregate UTF-8 strings and rejects the next byte', () => {
    const block = Array(1024).fill('😀'.repeat(1024));
    expect(boundedDataSnapshot([block, block], 'graph')).toEqual([block, block]);
    expect(() => boundedDataSnapshot([block, block, 'x'], 'graph')).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });

  it('bounds UTF-8 field bytes rather than just JavaScript code units', () => {
    expect(boundedDataSnapshot('😀'.repeat(1024), 'graph')).toHaveLength(2048);
    expect(() => boundedDataSnapshot(`${'😀'.repeat(1024)}x`, 'graph')).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });

  it('also limits encoded JCS bytes before attempting the graph schema', () => {
    // Escaping consumes six JCS bytes per control character, despite one raw UTF-8 byte.
    const block = Array(100).fill('\u0001'.repeat(4096));
    const input = [block, block, block, block];
    expect(boundedDataSnapshot(input, 'graph')).toEqual(input);
    expect(() => preparePinnedDependencyGraph(input)).toThrow('CAPABILITY_CLOSURE_LIMIT_EXCEEDED');
    expect(() => verifyPinnedDependencyGraph(input, candidate())).toThrow(
      'CAPABILITY_CLOSURE_LIMIT_EXCEEDED',
    );
  });

  it.each([
    ['sparse array', () => new Array(1)],
    ['array alias index', () => Object.assign([''], { '00': '' })],
    ['array named property', () => Object.assign([''], { extra: '' })],
    ['hidden data', () => Object.defineProperty({}, 'hidden', { value: '' })],
    ['symbol key', () => ({ [Symbol('data')]: '' })],
    ['custom prototype', () => Object.create({ inherited: '' })],
    ['Date object', () => new Date(0)],
    ['null', () => null],
    ['number', () => 0],
    ['boolean', () => true],
    ['NUL text', () => '\u0000'],
    ['lone surrogate', () => '\ud800'],
    [
      'cyclic object',
      () => {
        const value: { cycle?: unknown } = {};
        value.cycle = value;
        return value;
      },
    ],
    [
      'revoked Proxy',
      () => {
        const value = Proxy.revocable({}, {});
        value.revoke();
        return value.proxy;
      },
    ],
  ])('rejects %s without falling through to an unsafe parser', (_label, makeInput) => {
    expect(() => preparePinnedDependencyGraph(makeInput())).toThrow(
      'CAPABILITY_GRAPH_INPUT_INVALID',
    );
    expect(() => verifyPinnedDependencyGraph(makeInput(), candidate())).toThrow(
      'CAPABILITY_GRAPH_INPUT_INVALID',
    );
  });
});

describe('independent deterministic DAG model', () => {
  it.each([1, 2, 7, 42, 71, 99, 123, 255, 1024, 4096, 17001, 99991])(
    'preserves the complete edge set and dependency precedence for seed %i',
    (seed) => {
      let randomState = seed;
      function random() {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState / 4294967296;
      }
      const resources = Array.from({ length: 24 }, (_, index) => pin(index + 1));
      const root = pin(0, 'AGENT_RELEASE');
      const expectedPairs = resources.map((resource) => [root, resource]);
      const records = resources.map((resource, index) => {
        const children = resources.filter((_, childIndex) => childIndex > index && random() < 0.2);
        expectedPairs.push(...children.map((child) => [resource, child]));
        return record(resource, children);
      });
      const input = candidate(resources, records);
      const graph = preparePinnedDependencyGraph(input);
      const pinByNode = new Map(graph.nodes.map((node) => [node.node_id, node.pin.resource_id]));
      const actual = graph.edges.map(
        (edge) => `${pinByNode.get(edge.from_node_id)}>${pinByNode.get(edge.to_node_id)}`,
      );
      const expected = expectedPairs.map(
        (pair) => `${requiredPin(pair, 0).resource_id}>${requiredPin(pair, 1).resource_id}`,
      );
      expect(actual.sort()).toEqual(expected.sort());
      expect(new Set(graph.dependency_order)).toEqual(new Set(graphNodeIds(graph)));
      for (const edge of graph.edges)
        expect(graph.dependency_order.indexOf(edge.to_node_id)).toBeLessThan(
          graph.dependency_order.indexOf(edge.from_node_id),
        );
      const permuted = {
        ...input,
        root_dependencies: [...resources].reverse(),
        resources: [...records].reverse(),
      };
      expect(preparePinnedDependencyGraph(permuted)).toEqual(graph);
      // A root-return edge must fail regardless of unrelated DAG topology or traversal order.
      const cyclic = {
        ...input,
        resources: [...records.slice(0, -1), record(requiredPin(resources, 23), [root])],
      };
      expect(() => preparePinnedDependencyGraph(cyclic)).toThrow('CAPABILITY_DEPENDENCY_CYCLE');
    },
  );
});
