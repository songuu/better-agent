import { CompiledBindingEntryV1Schema } from '@better-agent/domain-contracts';
import { describe, expect, it, vi } from 'vitest';

import { normalizeCapabilityRequirementExpression } from '../src/capability-policy.js';
import {
  canonicalJsonBytes,
  meetCapabilityPolicyCeilings,
  normalizeCapabilityPolicyCeiling,
  resolveEffectiveCapabilityPolicy,
} from '../src/index.js';
import { budget, ceiling, egress, hashA, hashB, requirements } from './policy-fixtures.js';

const meet = meetCapabilityPolicyCeilings;
const normalize = normalizeCapabilityPolicyCeiling;
const resolve = resolveEffectiveCapabilityPolicy;

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('policy fixture requires a first entry');
  return value;
}

describe('closed capability policy meet', () => {
  it('intersects every independent upper-bound dimension without rounding credits', () => {
    const narrow = {
      ...ceiling(),
      credential_allowances: [
        {
          ...ceiling().credential_allowances[0],
          allowed_scopes: ['read'],
          principal_modes: ['service_principal'],
        },
      ],
      principal_modes: ['service_principal'],
      operation_contract_hashes: [hashA],
      readable_data_classification_ceiling: 'internal',
      output_data_classification: 'restricted',
      side_effect: { maximum_class: 'requires_key', approval: 'required' },
      max_calls: 2,
      max_depth: 3,
      max_parallelism: 1,
      budget: {
        ...budget(),
        amount_credits: '9007199254740993',
        input_tokens: 20,
        output_tokens: 80,
        total_tokens: 90,
        duration_ms: 1000,
      },
    };
    expect(meet(ceiling(), narrow)).toEqual(normalize(narrow));
    expect(
      meet(narrow, { ...narrow, budget: { ...narrow.budget, amount_credits: '9007199254740992' } })
        .budget.amount_credits,
    ).toBe('9007199254740992');
  });

  it('is idempotent, commutative and associative including opposite taint order', () => {
    const policies = [
      ceiling(),
      {
        ...ceiling(),
        principal_modes: ['service_principal'],
        readable_data_classification_ceiling: 'confidential',
        output_data_classification: 'internal',
        budget: { ...budget(), total_tokens: 70 },
      },
      {
        ...ceiling(),
        credential_allowances: [],
        egress: [],
        operation_contract_hashes: [hashB],
        readable_data_classification_ceiling: 'public',
        output_data_classification: 'restricted',
        max_calls: 0,
      },
    ];
    for (const a of policies) {
      expect(meet(a, a)).toEqual(normalize(a));
      for (const b of policies) {
        expect(meet(a, b)).toEqual(meet(b, a));
        for (const c of policies) expect(meet(meet(a, b), c)).toEqual(meet(a, meet(b, c)));
      }
    }
  });

  it('treats empty sets and zero as bottom, never as unlimited or fallback', () => {
    const bottom = {
      ...ceiling(),
      credential_allowances: [],
      principal_modes: [],
      egress: [],
      operation_contract_hashes: [],
      max_calls: 0,
      max_depth: 0,
      max_parallelism: 0,
      budget: {
        ...budget(),
        amount_credits: '0',
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
      },
    };
    expect(meet(ceiling(), bottom)).toEqual(normalize(bottom));
  });

  it.each(['provider_id', 'audience'] as const)(
    'does not union credential allowances across %s',
    (field) => {
      const other = ceiling();
      first(other.credential_allowances)[field] = 'different';
      expect(meet(ceiling(), other).credential_allowances).toEqual([]);
    },
  );

  it('returns detached deeply immutable canonical data', () => {
    const source = ceiling();
    const result = normalize(source);
    source.budget.input_tokens = 0;
    first(source.credential_allowances).allowed_scopes.push('admin');
    expect(result.budget.input_tokens).toBe(200);
    expect(result.credential_allowances[0]?.allowed_scopes).toEqual(['read', 'write']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.egress[0]?.redirects)).toBe(true);
    expect(Object.isFrozen(result.credential_allowances[0]?.allowed_scopes)).toBe(true);
    expect(canonicalJsonBytes(result)).toEqual(canonicalJsonBytes(normalize(ceiling())));
  });
});

describe('canonical egress intersection', () => {
  function withRules(rules: unknown[]) {
    return { ...ceiling(), egress: rules };
  }

  it('narrows wildcard host, path, method and both redirect constraints', () => {
    const child = {
      ...egress(),
      host: { match: 'exact', name: 'api.example.com' },
      path: { match: 'exact', value: '/v1/chat' },
      methods: ['POST'],
      redirects: { mode: 'same_origin', max_hops: 2, strip_cross_origin_credentials: true },
    };
    expect(meet(ceiling(), withRules([child])).egress).toEqual([child]);
  });

  it.each([
    ['apex', { host: { match: 'exact', name: 'example.com' } }],
    ['suffix confusion', { host: { match: 'exact', name: 'evilexample.com' } }],
    ['descendant confusion', { host: { match: 'exact', name: 'example.com.attacker.test' } }],
    ['path prefix confusion', { path: { match: 'exact', value: '/v10' } }],
    ['port', { port: 8443 }],
    ['method', { methods: ['DELETE'] }],
    ['policy hash', { network_policy: { ...egress().network_policy, policy_hash: hashB } }],
    ['policy id', { network_policy: { ...egress().network_policy, policy_id: 'unapproved' } }],
    [
      'address class',
      { network_policy: { ...egress().network_policy, address_class: 'approved_internal' } },
    ],
  ])('rejects disjoint %s without widening', (_label, changes) => {
    expect(meet(ceiling(), withRules([{ ...egress(), ...changes }])).egress).toEqual([]);
  });

  it('handles nested subdomains, root path and deny redirects', () => {
    const parent = withRules([{ ...egress(), path: { match: 'subtree', value: '/' } }]);
    const child = withRules([
      {
        ...egress(),
        host: { match: 'subdomains', name: 'api.example.com' },
        redirects: { mode: 'deny', max_hops: 0, strip_cross_origin_credentials: true },
      },
    ]);
    expect(meet(parent, child)).toEqual(normalize(child));
  });

  it('normalizes redundant overlapping rules and method permutations deterministically', () => {
    const narrow = { ...egress(), host: { match: 'exact', name: 'api.example.com' } };
    expect(
      normalize(withRules([narrow, egress(), { ...egress(), methods: ['POST', 'GET'] }])),
    ).toEqual(normalize(ceiling()));
    const split = withRules([
      { ...egress(), methods: ['POST'] },
      { ...egress(), methods: ['GET'] },
    ]);
    expect(normalize(split)).toEqual(normalize(ceiling()));
    expect(meet(split, withRules([narrow]))).toEqual(meet(withRules([narrow]), split));
  });

  it('has meet laws on overlapping host/path rectangles and redirect limits', () => {
    const a = withRules([egress(), { ...egress(), path: { match: 'subtree', value: '/v2' } }]);
    const b = withRules([
      {
        ...egress(),
        host: { match: 'subdomains', name: 'api.example.com' },
        path: { match: 'subtree', value: '/' },
        redirects: { mode: 'same_origin', max_hops: 8, strip_cross_origin_credentials: true },
      },
    ]);
    const c = withRules([
      {
        ...egress(),
        host: { match: 'exact', name: 'chat.api.example.com' },
        methods: ['POST'],
        redirects: { mode: 'approved_targets', max_hops: 1, strip_cross_origin_credentials: true },
      },
    ]);
    expect(meet(a, b)).toEqual(meet(b, a));
    expect(meet(meet(a, b), c)).toEqual(meet(a, meet(b, c)));
    expect(meet(meet(a, b), meet(a, b))).toEqual(meet(a, b));
  });

  it.each(['host', 'path', 'scheme'] as const)(
    'keeps distinct exact %s values disjoint in both directions and demand validation',
    (field) => {
      const rule = {
        ...egress(),
        network_policy: { ...egress().network_policy, address_class: 'approved_internal' },
        host: { match: 'exact', name: 'api.example.com' },
        path: { match: 'exact', value: '/v1/chat' },
      };
      const other =
        field === 'host'
          ? { ...rule, host: { match: 'exact', name: 'other.example.com' } }
          : field === 'path'
            ? { ...rule, path: { match: 'exact', value: '/v1/other' } }
            : { ...rule, scheme: 'http' };
      expect(meet(withRules([rule]), withRules([other])).egress).toEqual([]);
      expect(meet(withRules([other]), withRules([rule])).egress).toEqual([]);
      expect(() => resolve(withRules([rule]), { ...requirements(), egress: [other] })).toThrow(
        'CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE',
      );
      expect(() => resolve(withRules([other]), { ...requirements(), egress: [rule] })).toThrow(
        'CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE',
      );
    },
  );
});

describe('requirements are demands, not grants', () => {
  it('validates all demands and retains only requested operations/egress with raised taint', () => {
    const result = resolve(ceiling(), requirements());
    expect(result.principal_modes).toEqual(['service_principal']);
    expect(result.credential_requirements).toEqual(requirements().credential_requirements);
    expect(result.operation_contract_hashes).toEqual([hashA]);
    expect(result.egress).toEqual(requirements().egress);
    expect(result.readable_data_classification_ceiling).toBe('restricted');
    expect(result.output_data_classification).toBe('confidential');
    expect(result.side_effect).toEqual({ maximum_class: 'unsafe', approval: 'required' });
    expect(Object.isFrozen(result.credential_requirements[0]?.required_scopes)).toBe(true);
  });

  it.each<[string, object]>([
    [
      'scope',
      {
        credential_allowances: [
          { ...ceiling().credential_allowances[0], allowed_scopes: ['write'] },
        ],
      },
    ],
    [
      'provider',
      { credential_allowances: [{ ...ceiling().credential_allowances[0], provider_id: 'other' }] },
    ],
    [
      'audience',
      { credential_allowances: [{ ...ceiling().credential_allowances[0], audience: 'other' }] },
    ],
    [
      'credential mode',
      {
        credential_allowances: [
          { ...ceiling().credential_allowances[0], principal_modes: ['caller_delegated'] },
        ],
      },
    ],
    ['global mode', { principal_modes: ['none'] }],
    ['operation', { operation_contract_hashes: [hashB] }],
    ['egress', { egress: [] }],
    ['read clearance', { readable_data_classification_ceiling: 'public' }],
    ['side effect', { side_effect: { maximum_class: 'safe', approval: 'none' } }],
    ['calls', { max_calls: 0 }],
    ['depth', { max_depth: 0 }],
    ['parallelism', { max_parallelism: 0 }],
    ...(
      ['amount_credits', 'input_tokens', 'output_tokens', 'total_tokens', 'duration_ms'] as const
    ).map((key): [string, object] => [
      key,
      { budget: { ...budget(), [key]: key === 'amount_credits' ? '0' : 0 } },
    ]),
  ])('fails closed on unavailable required %s', (_label, changes) => {
    expect(() => resolve({ ...ceiling(), ...changes }, requirements())).toThrow(
      'CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE',
    );
  });

  it('never trims required scopes to make a demand pass', () => {
    const required = requirements();
    first(required.credential_requirements).required_scopes.push('admin');
    expect(() => resolve(ceiling(), required)).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
    expect(required.credential_requirements[0]?.required_scopes).toEqual(['read', 'admin']);
  });

  it('requires one common principal mode across every credential demand', () => {
    const required = {
      ...requirements(),
      principal_modes: ['caller_delegated', 'service_principal'],
      credential_requirements: [
        requirements().credential_requirements[0],
        {
          ...requirements().credential_requirements[0],
          requirement_id: 'second',
          allowed_principal_modes: ['caller_delegated'],
        },
      ],
    };
    expect(() => resolve(ceiling(), required)).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });

  it('accepts no-credential resources only through explicitly allowed none mode', () => {
    const required = { ...requirements(), credential_requirements: [], principal_modes: ['none'] };
    expect(resolve(ceiling(), required).principal_modes).toEqual(['none']);
    expect(() => resolve({ ...ceiling(), principal_modes: [] }, required)).toThrow(
      'CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE',
    );
  });

  it('does not silently narrow a required egress range or redirect capacity', () => {
    const required = requirements();
    expect(() =>
      resolve(
        {
          ...ceiling(),
          egress: [{ ...required.egress[0], path: { match: 'exact', value: '/v1/chat' } }],
        },
        required,
      ),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
    expect(() =>
      resolve(
        {
          ...ceiling(),
          egress: [
            {
              ...required.egress[0],
              redirects: { mode: 'deny', max_hops: 0, strip_cross_origin_credentials: true },
            },
          ],
        },
        required,
      ),
    ).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });

  it('checks simultaneous input/output minima against the shared total token cap', () => {
    const bounds = { ...ceiling(), budget: { ...budget(), total_tokens: 2 } };
    const required = requirements();
    required.minimum_limits.budget.total_tokens = 0;
    expect(resolve(bounds, required).budget.total_tokens).toBe(2);
    required.minimum_limits.budget.output_tokens = 2;
    expect(() => resolve(bounds, required)).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });

  it('does not round an unsafe sum of individually safe token minima', () => {
    const bounds = {
      ...ceiling(),
      budget: {
        ...budget(),
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: Number.MAX_SAFE_INTEGER,
        total_tokens: Number.MAX_SAFE_INTEGER,
      },
    };
    const required = requirements();
    required.minimum_limits.budget.input_tokens = Number.MAX_SAFE_INTEGER;
    required.minimum_limits.budget.output_tokens = 1;
    expect(() => resolve(bounds, required)).toThrow('CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE');
  });
});

describe('hostile policy input boundaries', () => {
  it.each([
    ['missing budget', { ...ceiling(), budget: {} }],
    ['unknown field', { ...ceiling(), fallback_credential: true }],
    ['negative', { ...ceiling(), max_calls: -1 }],
    ['unsafe integer', { ...ceiling(), max_calls: Number.MAX_SAFE_INTEGER + 1 }],
    ['fraction', { ...ceiling(), max_calls: 0.5 }],
    ['infinity', { ...ceiling(), max_calls: Infinity }],
    ['bad hash', { ...ceiling(), operation_contract_hashes: ['sha256:short'] }],
    ['duplicate hash', { ...ceiling(), operation_contract_hashes: [hashA, hashA] }],
    [
      'duplicate credential key',
      {
        ...ceiling(),
        credential_allowances: [
          ...ceiling().credential_allowances,
          ...ceiling().credential_allowances,
        ],
      },
    ],
    ['oversized set', { ...ceiling(), principal_modes: Array(129).fill('none') }],
    ['oversized string', { ...ceiling(), operation_contract_hashes: ['a'.repeat(4097)] }],
    [
      'NUL',
      {
        ...ceiling(),
        credential_allowances: [{ ...ceiling().credential_allowances[0], provider_id: '\0' }],
      },
    ],
    [
      'surrogate',
      {
        ...ceiling(),
        credential_allowances: [{ ...ceiling().credential_allowances[0], provider_id: '\ud800' }],
      },
    ],
  ])('rejects %s explicitly', (_label, value) =>
    expect(() => normalize(value)).toThrow(/CLOSURE_POLICY_(INPUT_INVALID|LIMIT_EXCEEDED)/u),
  );

  it('rejects proxies/getters without invoking traps or leaving shared state', () => {
    const trap = vi.fn(() => {
      throw new Error('must not invoke');
    });
    expect(() =>
      normalize(new Proxy(ceiling(), { ownKeys: trap, get: trap, getPrototypeOf: trap })),
    ).toThrow('CLOSURE_POLICY_INPUT_INVALID');
    const value = ceiling();
    Object.defineProperty(value, 'budget', { get: trap, enumerable: true });
    expect(() => normalize(value)).toThrow('CLOSURE_POLICY_INPUT_INVALID');
    expect(trap).not.toHaveBeenCalled();
    expect(normalize(ceiling()).max_calls).toBe(10);
  });

  it('rejects cycles, sparse arrays, forged indices and extra symbols', () => {
    const cyclic: Record<string, unknown> = ceiling();
    cyclic.budget = cyclic;
    const sparse = ['none'];
    delete sparse[0];
    const forged = ['none'];
    Object.defineProperty(forged, '4294967295', { value: 'none', enumerable: true });
    for (const input of [
      cyclic,
      { ...ceiling(), principal_modes: sparse },
      { ...ceiling(), principal_modes: forged },
      { ...ceiling(), [Symbol('hidden')]: 'hidden' },
    ])
      expect(() => normalize(input)).toThrow('CLOSURE_POLICY_INPUT_INVALID');
  });

  it('enforces the UTF-8 byte boundary before schema parsing', () => {
    const input = ceiling();
    first(input.credential_allowances).provider_id = 'é'.repeat(2_048);
    expect(normalize(input).credential_allowances[0]?.provider_id).toBe('é'.repeat(2_048));
    first(input.credential_allowances).provider_id += 'é';
    expect(() => normalize(input)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
  });

  it('bounds aggregate bytes, structure depth and node count before parsing', () => {
    const input = ceiling();
    first(input.credential_allowances).allowed_scopes = Array.from(
      { length: 128 },
      (_, i) => `${i}:${'x'.repeat(4_080)}`,
    );
    expect(normalize(input).credential_allowances[0]?.allowed_scopes).toHaveLength(128);
    input.credential_allowances = Array.from({ length: 3 }, (_, i) => ({
      ...first(input.credential_allowances),
      audience: String(i),
    }));
    expect(() => normalize(input)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    let deep: unknown = 'leaf';
    for (let i = 0; i < 13; i += 1) deep = { child: deep };
    expect(() => normalize(deep)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    const many = Array.from({ length: 3 }, () =>
      Array.from({ length: 128 }, () => Array(128).fill('')),
    );
    expect(() => normalize(many)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
  });

  it('rejects excessive egress results without truncating or retaining state', () => {
    const left = {
      ...ceiling(),
      egress: Array.from({ length: 32 }, (_, i) => ({
        ...egress(),
        host: { match: 'exact', name: `api${i}.example.com` },
        path: { match: 'subtree', value: '/' },
        methods: ['GET'],
      })),
    };
    const right = {
      ...ceiling(),
      egress: Array.from({ length: 32 }, (_, i) => ({
        ...egress(),
        path: { match: 'subtree', value: `/v${i}` },
        methods: ['GET'],
      })),
    };
    expect(normalize(left).egress).toHaveLength(32);
    expect(normalize(right).egress).toHaveLength(32);
    const started = performance.now();
    expect(() => meet(left, right)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    expect(() => meet(right, left)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    expect(performance.now() - started).toBeLessThan(5_000);
    left.egress = left.egress.map((rule) => ({ ...rule, methods: ['GET', 'POST'] }));
    right.egress = right.egress.map((rule) => ({ ...rule, methods: ['GET', 'POST'] }));
    expect(() => meet(left, right)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    expect(normalize(ceiling()).egress).toHaveLength(1);
  });

  it('bounds total output bytes before returning a composed policy, not on its next use', () => {
    function inputs(scopeCount: number) {
      const common = {
        ...ceiling(),
        credential_allowances: [0, 1].map((index) => ({
          ...first(ceiling().credential_allowances),
          audience: String(index),
          allowed_scopes: Array.from(
            { length: scopeCount },
            (_, scope) => `${'s'.repeat(4_092)}${String(scope).padStart(4, '0')}`,
          ),
        })),
      };
      const network_policy = { ...egress().network_policy, policy_id: 'n'.repeat(4_096) };
      const left = {
        ...common,
        egress: Array.from({ length: 4 }, (_, index) => ({
          ...egress(),
          network_policy,
          methods: ['GET'],
          host: { match: 'exact', name: `api${index}.example.com` },
          path: { match: 'subtree', value: '/' },
        })),
      };
      const right = {
        ...common,
        egress: Array.from({ length: 8 }, (_, index) => ({
          ...egress(),
          network_policy,
          methods: ['GET'],
          path: { match: 'exact', value: `/${'p'.repeat(4_091)}${String(index).padStart(4, '0')}` },
        })),
      };
      return { left, right };
    }
    const { left, right } = inputs(110);
    expect(normalize(left).egress).toHaveLength(4);
    expect(normalize(right).egress).toHaveLength(8);
    expect(() => meet(left, right)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    expect(() => meet(right, left)).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    const smaller = inputs(80);
    const result = meet(smaller.left, smaller.right);
    expect(result.egress).toHaveLength(32);
    expect(normalize(result)).toEqual(result);
    expect(meet(result, result)).toEqual(result);
  });

  it('rejects nested and revoked proxies without traps', () => {
    const trap = vi.fn();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const nested = { ...ceiling(), budget: new Proxy(budget(), { get: trap }) };
    for (const input of [nested, revoked.proxy])
      expect(() => normalize(input)).toThrow('CLOSURE_POLICY_INPUT_INVALID');
    expect(trap).not.toHaveBeenCalled();
  });
});

describe('policy compilation composition', () => {
  it('embeds the effective policy in the actual compiled Binding contract', () => {
    const pin = {
      workspace_id: 'workspace',
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: 'agent',
      resource_version_id: 'version',
      contract_hash: hashA,
      binding_mode: 'pinned',
    };
    const binding = {
      binding_path_encoding_version: 'binding-path-lp-utf8/1',
      binding_path: `bp1.${'a'.repeat(43)}`,
      binding_path_segments: [{ segment_kind: 'root', pin }],
      binding_id: 'tool',
      binding_kind: 'plugin',
      admission_requirement: 'optional',
      target: { ...pin, published_resource_kind: 'PLUGIN_TOOL_RELEASE' },
      config_schema_version: 'plugin-binding/1',
      config_hash: hashA,
      source_contract_hash: hashA,
      requirement_expression: normalizeCapabilityRequirementExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'leaf',
        requirements: requirements(),
      }),
      effective_policy: resolve(meet(ceiling(), ceiling()), requirements()),
      operation_contracts: [
        {
          operation_kind: 'plugin_tool',
          operation_id: 'tool',
          input_schema_hash: hashA,
          side_effect_class: 'requires_key',
          operation_key_required: true,
          approval_required: true,
          contract_hash: hashA,
        },
      ],
      dependency_node_ids: [],
      approval_gate_spec: { gate_spec_id: 'approval', gate_spec_hash: hashA },
    };
    expect(CompiledBindingEntryV1Schema.safeParse(binding).success).toBe(true);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        effective_policy: { ...binding.effective_policy, budget: {} },
      }).success,
    ).toBe(false);
    expect(
      CompiledBindingEntryV1Schema.safeParse({
        ...binding,
        effective_policy: { ...binding.effective_policy, egress: [{}] },
      }).success,
    ).toBe(false);
  });

  it('satisfies meet laws for a deterministic generated policy matrix', () => {
    const classifications = ['public', 'internal', 'confidential', 'restricted'] as const;
    const effects = ['safe', 'requires_key', 'unsafe'] as const;
    const policies = Array.from({ length: 12 }, (_, index) => ({
      ...ceiling(),
      principal_modes: index % 3 === 0 ? ['none'] : ['service_principal'],
      readable_data_classification_ceiling: classifications[index % 4],
      output_data_classification: classifications[(index + 2) % 4],
      side_effect: { maximum_class: effects[index % 3], approval: index % 2 ? 'required' : 'none' },
      budget: {
        ...budget(),
        amount_credits: String(9_007_199_254_740_990n + BigInt(index)),
        total_tokens: index * 10,
      },
      egress: [
        {
          ...egress(),
          host:
            index % 2
              ? { match: 'exact', name: 'api.example.com' }
              : { match: 'subdomains', name: 'example.com' },
          methods: index % 3 === 0 ? ['GET', 'POST'] : ['GET'],
          path: { match: 'subtree', value: index % 2 ? '/v1' : '/' },
        },
      ],
    }));
    for (const [index, a] of policies.entries()) {
      expect(meet(a, a)).toEqual(normalize(a));
      for (const b of policies) {
        const c = policies[(index + 5) % policies.length];
        expect(meet(a, b)).toEqual(meet(b, a));
        expect(meet(meet(a, b), c)).toEqual(meet(a, meet(b, c)));
      }
    }
  });
});
