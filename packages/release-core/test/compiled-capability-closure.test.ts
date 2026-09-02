import { describe, expect, it } from 'vitest';

import { canonicalBindingPath, canonicalResourceNodeId } from '../src/closure-identity.js';
import { normalizeCapabilityRequirementExpression } from '../src/capability-policy.js';
import {
  prepareCompiledCapabilityClosure,
  prepareNestedCapabilityDependency,
  prepareNestedCapabilityClosure,
} from '../src/compiled-capability-closure.js';
import { ReleaseCoreError } from '../src/errors.js';
import { canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import { emptyCapabilityRequirementExpression } from './fixtures.js';

const hashA = `sha256:${'a'.repeat(64)}` as const;
const hashB = `sha256:${'b'.repeat(64)}` as const;

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

function closureInput(
  kind: 'AGENT_RELEASE' | 'FLOW_VERSION' = 'AGENT_RELEASE',
  contractHash: string = hashB,
) {
  const pin = {
    workspace_id: 'workspace-1',
    published_resource_kind: kind,
    resource_id: kind === 'AGENT_RELEASE' ? 'agent-1' : 'flow-1',
    resource_version_id: kind === 'AGENT_RELEASE' ? 'agent-release-1' : 'flow-version-1',
    contract_hash: contractHash,
    binding_mode: 'pinned',
  } as const;
  const candidate = {
    schema_version: 'compiled-capability-closure/1',
    root: { pin, semantic_seed_hash: contractHash },
    assembly_pins: [],
    bindings: [],
    gate_specs: [],
    resource_nodes: [
      {
        node_id: canonicalResourceNodeId(pin),
        intrinsic_policy: emptyCapabilityRequirementExpression,
        dependency_manifest_hash: hashA,
        node_role: 'root',
        pin,
      },
    ],
    dependency_edges: [],
    disabled_binding_paths: [],
    aggregate_limits: emptyPolicy,
    closure_hash: hashA,
  } as const;
  return {
    ...candidate,
    closure_hash: canonicalSha256ExcludingRootKeys(candidate, ['closure_hash']),
  };
}

function dependencyNode(closure: ReturnType<typeof closureInput>, contractHash = hashA) {
  const pin = { ...closure.root.pin, contract_hash: contractHash };
  return {
    node_id: canonicalResourceNodeId(pin),
    dependency_manifest_hash: hashA,
    pin,
    nested_closure_hash: closure.closure_hash,
  } as const;
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrowError(ReleaseCoreError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('compiled capability closure verification', () => {
  it('verifies the complete canonical artifact and deeply freezes it', () => {
    const result = prepareCompiledCapabilityClosure(closureInput());
    expect(result.closure_hash).toBe(canonicalSha256ExcludingRootKeys(result, ['closure_hash']));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.root.pin)).toBe(true);
    expect(Object.isFrozen(result.resource_nodes)).toBe(true);
  });

  it('rejects a self-reported closure hash that does not match its content', () => {
    expectCode(
      () => prepareCompiledCapabilityClosure({ ...closureInput(), closure_hash: hashA }),
      'COMPILED_CAPABILITY_CLOSURE_HASH_MISMATCH',
    );
  });

  it('rejects unknown fields and future schema versions', () => {
    expectCode(
      () => prepareCompiledCapabilityClosure({ ...closureInput(), trusted: true }),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
    expectCode(
      () =>
        prepareCompiledCapabilityClosure({
          ...closureInput(),
          schema_version: 'compiled-capability-closure/2',
        }),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
  });

  it('recomputes every resource node identity instead of trusting its spelling', () => {
    const valid = closureInput();
    const input = {
      ...valid,
      resource_nodes: [
        {
          ...valid.resource_nodes[0],
          node_id: canonicalResourceNodeId({ ...valid.root.pin, resource_id: 'agent-2' }),
        },
      ],
    };
    expectCode(() => prepareCompiledCapabilityClosure(input), 'CLOSURE_IDENTITY_MISMATCH');
  });

  it('recomputes every Binding path from its complete segment sequence', () => {
    const valid = closureInput();
    const target = {
      workspace_id: valid.root.pin.workspace_id,
      published_resource_kind: 'KNOWLEDGE_INDEX_GENERATION',
      resource_id: 'knowledge-1',
      resource_version_id: 'generation-1',
      contract_hash: hashA,
      binding_mode: 'pinned',
    } as const;
    const segments = [
      { segment_kind: 'root', pin: valid.root.pin },
      {
        segment_kind: 'binding',
        owner: { owner_kind: 'root', pin: valid.root.pin },
        binding_kind: 'knowledge',
        local_binding_id: 'knowledge-1',
      },
    ] as const;
    const dependencyNodeId = canonicalResourceNodeId(target);
    const candidate = {
      ...valid,
      bindings: [
        {
          binding_path_encoding_version: 'binding-path-lp-utf8/1',
          binding_path: canonicalBindingPath([
            segments[0],
            { ...segments[1], local_binding_id: 'different-binding' },
          ]),
          binding_path_segments: segments,
          binding_id: 'knowledge-1',
          binding_kind: 'knowledge',
          target,
          config_schema_version: 'knowledge-binding/1',
          config_hash: hashA,
          source_contract_hash: hashA,
          effective_policy: emptyPolicy,
          operation_contracts: [],
          dependency_node_ids: [dependencyNodeId],
        },
      ],
      resource_nodes: [
        ...valid.resource_nodes,
        {
          node_id: dependencyNodeId,
          intrinsic_policy: emptyCapabilityRequirementExpression,
          dependency_manifest_hash: hashA,
          node_role: 'dependency',
          pin: target,
        },
      ],
      closure_hash: hashA,
    } as const;
    const input = {
      ...candidate,
      closure_hash: canonicalSha256ExcludingRootKeys(candidate, ['closure_hash']),
    };
    expectCode(() => prepareCompiledCapabilityClosure(input), 'CLOSURE_IDENTITY_MISMATCH');
  });

  it('rejects alternate ordering and duplicates for canonical closure sets', () => {
    const valid = closureInput();
    const first = {
      ...valid.root.pin,
      published_resource_kind: 'PLUGIN_TOOL_RELEASE',
      resource_id: 'plugin-a',
      resource_version_id: 'plugin-release-a',
      contract_hash: hashA,
    } as const;
    const second = { ...first, resource_id: 'plugin-z' };
    const reversed = {
      ...valid,
      assembly_pins: [second, first],
      closure_hash: hashA,
    };
    expectCode(
      () =>
        prepareCompiledCapabilityClosure({
          ...reversed,
          closure_hash: canonicalSha256ExcludingRootKeys(reversed, ['closure_hash']),
        }),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
    const duplicated = { ...valid, assembly_pins: [first, first], closure_hash: hashA };
    expectCode(
      () =>
        prepareCompiledCapabilityClosure({
          ...duplicated,
          closure_hash: canonicalSha256ExcludingRootKeys(duplicated, ['closure_hash']),
        }),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
  });

  it('rejects noncanonical intrinsic branch order even when the closure hash matches it', () => {
    const valid = closureInput();
    const serviceLeaf = {
      ...emptyCapabilityRequirementExpression,
      requirements: {
        ...emptyCapabilityRequirementExpression.requirements,
        principal_modes: ['service_principal'],
      },
    } as const;
    const canonical = normalizeCapabilityRequirementExpression({
      schema_version: 'capability-requirement-expression/1',
      expression_kind: 'alternative',
      children: [emptyCapabilityRequirementExpression, serviceLeaf],
    });
    if (canonical.expression_kind !== 'alternative') throw new Error('expected alternative');
    const candidate = {
      ...valid,
      resource_nodes: [
        {
          ...valid.resource_nodes[0],
          intrinsic_policy: { ...canonical, children: [...canonical.children].reverse() },
        },
      ],
      closure_hash: hashA,
    };
    expectCode(
      () =>
        prepareCompiledCapabilityClosure({
          ...candidate,
          closure_hash: canonicalSha256ExcludingRootKeys(candidate, ['closure_hash']),
        }),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
  });

  it('rejects accessor and proxy input before schema parsing', () => {
    const accessor = closureInput() as Record<string, unknown>;
    Object.defineProperty(accessor, 'closure_hash', {
      enumerable: true,
      get: () => hashA,
    });
    expectCode(
      () => prepareCompiledCapabilityClosure(accessor),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
    expectCode(
      () => prepareCompiledCapabilityClosure(new Proxy(closureInput(), {})),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
  });

  it('bounds closure collection sizes before contract validation', () => {
    const input = structuredClone(closureInput()) as Record<string, unknown>;
    input.disabled_binding_paths = Array.from({ length: 8_193 }, () => `bp1.${'a'.repeat(43)}`);
    expectCode(() => prepareCompiledCapabilityClosure(input), 'CAPABILITY_CLOSURE_LIMIT_EXCEEDED');
  });

  it('joins nested Agent identity without equating published and semantic hashes', () => {
    const closure = closureInput();
    const result = prepareNestedCapabilityClosure(dependencyNode(closure), closure);
    expect(result.root.pin.contract_hash).toBe(hashB);
    expect(result.root.pin.contract_hash).not.toBe(dependencyNode(closure).pin.contract_hash);
  });

  it('projects typed child-root intrinsic requirements through the graph commitment', () => {
    const closure = closureInput();
    const result = prepareNestedCapabilityDependency(dependencyNode(closure), closure);
    expect(result.closure).toEqual(closure);
    expect(result.resource_node).toEqual({
      ...dependencyNode(closure),
      intrinsic_policy: emptyCapabilityRequirementExpression,
      node_role: 'dependency',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.resource_node.intrinsic_policy)).toBe(true);
  });

  it('rejects graph and child-root dependency manifest drift', () => {
    const closure = closureInput();
    expectCode(
      () =>
        prepareNestedCapabilityDependency(
          { ...dependencyNode(closure), dependency_manifest_hash: hashB },
          closure,
        ),
      'NESTED_CAPABILITY_CLOSURE_MISMATCH',
    );
  });

  it('accepts the corresponding Flow nested closure', () => {
    const closure = closureInput('FLOW_VERSION');
    expect(prepareNestedCapabilityClosure(dependencyNode(closure), closure)).toEqual(closure);
  });

  it('rejects a nested closure hash not committed by the dependency node', () => {
    const closure = closureInput();
    expectCode(
      () =>
        prepareNestedCapabilityClosure(
          { ...dependencyNode(closure), nested_closure_hash: hashA },
          closure,
        ),
      'NESTED_CAPABILITY_CLOSURE_MISMATCH',
    );
  });

  it.each([
    ['workspace_id', 'workspace-2'],
    ['resource_id', 'agent-2'],
    ['resource_version_id', 'agent-release-2'],
  ] as const)('rejects nested version identity drift in %s', (field, value) => {
    const closure = closureInput();
    const node = dependencyNode(closure);
    const pin = { ...node.pin, [field]: value };
    expectCode(
      () =>
        prepareNestedCapabilityClosure(
          { ...node, node_id: canonicalResourceNodeId(pin), pin },
          closure,
        ),
      'NESTED_CAPABILITY_CLOSURE_MISMATCH',
    );
  });

  it('rejects root and leaf nodes as nested closure owners', () => {
    const closure = closureInput();
    expectCode(
      () => prepareNestedCapabilityClosure(closure.resource_nodes[0], closure),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
    const leaf = {
      ...dependencyNode(closure),
      pin: {
        ...dependencyNode(closure).pin,
        published_resource_kind: 'PLUGIN_TOOL_RELEASE',
      },
    };
    delete (leaf as { nested_closure_hash?: string }).nested_closure_hash;
    expectCode(
      () => prepareNestedCapabilityClosure(leaf, closure),
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
    );
  });
});
