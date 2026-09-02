import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalBindingPath,
  canonicalBindingPathBytes,
  canonicalResourceNodeId,
  createClosureIdentityRegistry,
  verifyCanonicalBindingPath,
  verifyCanonicalResourceNodeId,
} from '../src/index.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

const actualCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
afterEach(() => vi.mocked(createHash).mockImplementation(actualCrypto.createHash));

const pin = {
  workspace_id: 'w',
  published_resource_kind: 'AGENT_RELEASE',
  resource_id: 'a',
  resource_version_id: 'v',
  contract_hash: `sha256:${'a'.repeat(64)}`,
  binding_mode: 'pinned',
} as const;
const root = { segment_kind: 'root', pin } as const;
const binding = {
  segment_kind: 'binding',
  owner: { owner_kind: 'root', pin },
  binding_kind: 'plugin',
  local_binding_id: 'x/:雪',
} as const;
const flowNode = {
  segment_kind: 'flow_node',
  owner: {
    owner_kind: 'published_dependency',
    pin: { ...pin, published_resource_kind: 'FLOW_VERSION', resource_id: 'f' },
  },
  graph_id: 'graph/root',
  node_id: 'n',
} as const;
const packMember = {
  segment_kind: 'skill_pack_member',
  owner_pin: { ...pin, published_resource_kind: 'SKILL_PACK_RELEASE', resource_id: 's' },
  local_member_binding_id: 'm',
} as const;
const subagent = {
  segment_kind: 'subagent_target',
  target_pin: { ...pin, published_resource_kind: 'A2A_AGENT_RELEASE', resource_id: 'remote' },
} as const;

function forceDigestCollision(): void {
  vi.mocked(createHash).mockImplementation(() => {
    const hash = actualCrypto.createHash('sha256').update('forced-collision');
    hash.update = () => hash;
    return hash;
  });
}

describe('closure identity byte profile v1', () => {
  it('matches the independently assembled root byte vector', () => {
    expect(canonicalBindingPathBytes([root]).toString('hex')).toBe(
      '000000010000007c01010000000177020000000d4147454e545f52454c4541534503000000016104000000017605000000477368613235363a61616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161060000000670696e6e6564',
    );
  });

  it.each([
    [[root], 'bp1.-Gnvvgfh1D_HeBYADWBUUXfy7NyGnxZyxKVwWTxG3TU'],
    [[root, binding], 'bp1.FtX6VgF4AA17aTbyIjcjrizShHYUJT17UM6eV_p_C3U'],
    [[root, flowNode], 'bp1.w4zT3q7n6jFzMbHMebXCE3N4Bd1Ji53qxSd7IWs4eCQ'],
    [[root, packMember], 'bp1.NH_zVFNhz5wy0DuNjfjJAlkiYuaIgOHtxZC60LgOdWY'],
    [[root, subagent], 'bp1.J6PlDTXRAvklhCBdNW0Muo_MI0Y4JEXosN3HJsAsWKg'],
  ])('matches independent digest vector %#', (segments, expected) => {
    expect(canonicalBindingPath(segments)).toBe(expected);
    expect(verifyCanonicalBindingPath(expected, segments)).toBe(expected);
  });

  it('hashes the complete JCS pin with an independent resource node vector', () => {
    const expected = 'rn1.As7kbTtWyrS7QBd9aWi0WK5m2l-K10b9eDX6q9ChLwI';
    expect(canonicalResourceNodeId(pin)).toBe(expected);
    expect(verifyCanonicalResourceNodeId(expected, pin)).toBe(expected);
    expect(canonicalResourceNodeId(Object.fromEntries(Object.entries(pin).reverse()))).toBe(
      expected,
    );
  });

  it.each(['workspace_id', 'resource_id', 'resource_version_id', 'contract_hash'] as const)(
    'retains %s in both identities',
    (field) => {
      const changedPin = {
        ...pin,
        [field]: field === 'contract_hash' ? `sha256:${'b'.repeat(64)}` : 'different',
      };
      expect(canonicalResourceNodeId(changedPin)).not.toBe(canonicalResourceNodeId(pin));
      expect(canonicalBindingPath([{ ...root, pin: changedPin }])).not.toBe(
        canonicalBindingPath([root]),
      );
    },
  );

  it('retains pin kind and rejects a non-pinned mode', () => {
    const flowPin = { ...pin, published_resource_kind: 'FLOW_VERSION' };
    expect(canonicalResourceNodeId(flowPin)).not.toBe(canonicalResourceNodeId(pin));
    expect(canonicalBindingPath([{ ...root, pin: flowPin }])).not.toBe(
      canonicalBindingPath([root]),
    );
    expect(() => canonicalResourceNodeId({ ...pin, binding_mode: 'latest' })).toThrow(
      'CLOSURE_IDENTITY_INPUT_INVALID',
    );
  });

  it('ignores object key order, preserves segment order and does not mutate input', () => {
    const frozen = Object.freeze([Object.freeze(root), Object.freeze(binding)]);
    const reordered = frozen.map((segment) =>
      Object.fromEntries(Object.entries(segment).reverse()),
    );
    expect(canonicalBindingPath(frozen)).toBe(canonicalBindingPath(reordered));
    expect(canonicalBindingPath([root, binding, subagent])).not.toBe(
      canonicalBindingPath([root, subagent, binding]),
    );
    expect(frozen).toEqual([root, binding]);
  });

  it('separates delimiter-bearing fields and preserves Unicode normalization differences', () => {
    const left = { ...pin, resource_id: 'a/b', resource_version_id: 'c' };
    const right = { ...pin, resource_id: 'a', resource_version_id: 'b/c' };
    expect(canonicalResourceNodeId(left)).not.toBe(canonicalResourceNodeId(right));
    const path = (id: string) => canonicalBindingPath([root, { ...binding, local_binding_id: id }]);
    expect(path('é')).not.toBe(path('e\u0301'));
    expect(path('bp1.x/:雪')).not.toBe(path('bp1.x/:雪/'));
  });

  it('isolates repeated local IDs under different published owners', () => {
    const owner = { owner_kind: 'published_dependency', pin };
    const first = { ...binding, owner };
    const second = { ...binding, owner: { ...owner, pin: { ...pin, resource_id: 'other' } } };
    expect(canonicalBindingPath([root, first])).not.toBe(canonicalBindingPath([root, second]));
  });

  it('isolates equal Flow node IDs in distinct nested graph namespaces', () => {
    expect(canonicalBindingPath([root, flowNode])).not.toBe(
      canonicalBindingPath([root, { ...flowNode, graph_id: 'graph/other' }]),
    );
  });

  it.each(
    [
      [],
      [binding],
      [root, root],
      [{ ...root, pin: { ...pin, published_resource_kind: 'PLUGIN_TOOL_RELEASE' } }],
      [root, { ...binding, owner: { owner_kind: 'root', pin: { ...pin, resource_id: 'wrong' } } }],
      [root, { ...flowNode, owner: { owner_kind: 'root', pin } }],
      [root, { ...flowNode, graph_id: '' }],
      [root, { ...flowNode, graph_id: undefined }],
      [root, { ...packMember, owner_pin: pin }],
      [root, { ...subagent, target_pin: { ...pin, published_resource_kind: 'FLOW_VERSION' } }],
      [root, { ...binding, binding_kind: 'future' }],
      [root, { ...binding, local_binding_id: '' }],
      [root, { segment_kind: 'future', pin }],
      [{ ...root, unknown: 'field' }],
      [{ ...root, pin: { ...pin, unknown: 'field' } }],
    ].map((segments) => ({ segments })),
  )('rejects invalid closed path input %#', ({ segments }) => {
    expect(() => canonicalBindingPath(segments)).toThrow('CLOSURE_IDENTITY_INPUT_INVALID');
  });

  it.each(['\ud800', '\udfff', 'a\u0000b'])(
    'rejects invalid text before UTF-8 replacement %#',
    (text) => {
      expect(() => canonicalBindingPath([root, { ...binding, local_binding_id: text }])).toThrow(
        'CLOSURE_IDENTITY_INPUT_INVALID',
      );
      expect(() => canonicalResourceNodeId({ ...pin, resource_id: text })).toThrow(
        'CLOSURE_IDENTITY_INPUT_INVALID',
      );
    },
  );

  it('rejects accessors without calling them, cycles, sparse arrays and non-data objects', () => {
    const getter = vi.fn(() => pin);
    const accessor = Object.defineProperty({ segment_kind: 'root' }, 'pin', {
      enumerable: true,
      get: getter,
    });
    expect(() => canonicalBindingPath([accessor])).toThrow('CLOSURE_IDENTITY_INPUT_INVALID');
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [[cycle], Array(1), [new Date()], [{ ...root, [Symbol('x')]: 1 }]]) {
      expect(() => canonicalBindingPath(input)).toThrow('CLOSURE_IDENTITY_INPUT_INVALID');
    }
  });

  it('bounds segments and UTF-8 bytes without truncating valid boundaries', () => {
    expect(canonicalBindingPath([root, ...Array.from({ length: 127 }, () => binding)])).toMatch(
      /^bp1\./,
    );
    expect(() =>
      canonicalBindingPath([root, ...Array.from({ length: 128 }, () => binding)]),
    ).toThrow('CLOSURE_IDENTITY_LIMIT_EXCEEDED');
    expect(
      canonicalBindingPath([root, { ...binding, local_binding_id: '😀'.repeat(1024) }]),
    ).toMatch(/^bp1\./);
    expect(() =>
      canonicalBindingPath([root, { ...binding, local_binding_id: '😀'.repeat(1025) }]),
    ).toThrow('CLOSURE_IDENTITY_LIMIT_EXCEEDED');
  });

  it('rejects a sparse array disguised by a numeric non-index property', () => {
    const disguised: unknown[] = [root];
    disguised.length = 2;
    Object.defineProperty(disguised, '4294967295', { value: binding, enumerable: true });
    expect(() => canonicalBindingPath(disguised)).toThrow('CLOSURE_IDENTITY_INPUT_INVALID');
  });

  it('rejects proxies before any trap or reentrant registry mutation', () => {
    const registry = createClosureIdentityRegistry();
    const getPrototypeOf = vi.fn(() => {
      registry.registerBindingPath([root]);
      throw new Error('reentrant input');
    });
    expect(() => registry.registerResourceNode(new Proxy(pin, { getPrototypeOf }))).toThrow(
      'CLOSURE_IDENTITY_INPUT_INVALID',
    );
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(registry.registerBindingPath([root])).toBe(canonicalBindingPath([root]));
    const get = vi.fn(() => 128);
    const ownKeys = vi.fn(() => ['length', '4294967294']);
    expect(() => canonicalBindingPath(new Proxy([root], { get, ownKeys }))).toThrow(
      'CLOSURE_IDENTITY_INPUT_INVALID',
    );
    expect(get).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
    const revoked = Proxy.revocable(pin, {});
    revoked.revoke();
    expect(() => canonicalResourceNodeId(revoked.proxy)).toThrow('CLOSURE_IDENTITY_INPUT_INVALID');
  });

  it('bounds aggregate path bytes and structural depth', () => {
    const largePin = {
      ...pin,
      workspace_id: 'w'.repeat(4096),
      resource_id: 'r'.repeat(4096),
      resource_version_id: 'v'.repeat(4096),
    };
    const largeBinding = {
      ...binding,
      owner: { owner_kind: 'published_dependency', pin: largePin },
      local_binding_id: 'b'.repeat(4096),
    };
    expect(() =>
      canonicalBindingPath([root, ...Array.from({ length: 127 }, () => largeBinding)]),
    ).toThrow('CLOSURE_IDENTITY_LIMIT_EXCEEDED');
    let nested: unknown = 'leaf';
    for (let index = 0; index < 10; index += 1) nested = { child: nested };
    expect(() => canonicalResourceNodeId(nested)).toThrow('CLOSURE_IDENTITY_LIMIT_EXCEEDED');
  });

  it('enforces the exact final encoded byte limit including field and segment framing', () => {
    const fullPin = {
      ...pin,
      workspace_id: 'w'.repeat(4096),
      resource_id: 'r'.repeat(4096),
      resource_version_id: 'v'.repeat(4096),
    };
    const fullBinding = {
      ...binding,
      owner: { owner_kind: 'published_dependency', pin: fullPin },
      local_binding_id: 'x'.repeat(4096),
    };
    const tailPin = {
      ...pin,
      workspace_id: 'w'.repeat(2000),
      resource_id: 'r',
      resource_version_id: 'v',
    };
    // Independent profile arithmetic: root/count=132, 63 framed bindings=63*16550,
    // final binding fixed bytes=2168, leaving 3626 UTF-8 bytes at exactly 1 MiB.
    const path = (delta: number) => [
      root,
      ...Array.from({ length: 63 }, () => fullBinding),
      {
        ...binding,
        owner: { owner_kind: 'published_dependency', pin: tailPin },
        local_binding_id: 'x'.repeat(3626 + delta),
      },
    ];
    expect(canonicalBindingPathBytes(path(-1))).toHaveLength(1_048_575);
    expect(canonicalBindingPathBytes(path(0))).toHaveLength(1_048_576);
    expect(() => canonicalBindingPathBytes(path(1))).toThrow('encoded path exceeds byte limit');
  });

  it.each([
    'bp1.PKNiig7s0zMD_Iy-MpnLaQGkVG9OpQhy9B1vnjqxVb4=',
    'bp1.PKNiig7s0zMD_Iy-MpnLaQGkVG9OpQhy9B1vnjqxVb5',
    'bp1.PKNiig7s0zMD/Iy+MpnLaQGkVG9OpQhy9B1vnjqxVb4',
    ' bp1.PKNiig7s0zMD_Iy-MpnLaQGkVG9OpQhy9B1vnjqxVb4',
    'bp1.PKNiig7s0zMD_Iy-MpnLaQGkVG9OpQhy9B1vnjqxVb4\n',
    Buffer.from('bp1.PKNiig7s0zMD_Iy-MpnLaQGkVG9OpQhy9B1vnjqxVb4').toString('base64url'),
  ])('rejects noncanonical digest spelling %#', (expected) => {
    expect(() => verifyCanonicalBindingPath(expected, [root])).toThrow(
      'CLOSURE_IDENTITY_INPUT_INVALID',
    );
  });

  it('rejects well-formed but mismatched path and node digests', () => {
    expect(() => verifyCanonicalBindingPath(canonicalBindingPath([root, binding]), [root])).toThrow(
      'CLOSURE_IDENTITY_MISMATCH',
    );
    expect(() =>
      verifyCanonicalResourceNodeId(canonicalResourceNodeId({ ...pin, resource_id: 'other' }), pin),
    ).toThrow('CLOSURE_IDENTITY_MISMATCH');
  });

  it('deduplicates equal nodes but rejects duplicate binding paths', () => {
    const registry = createClosureIdentityRegistry();
    expect(registry.registerResourceNode(pin)).toBe(registry.registerResourceNode({ ...pin }));
    registry.registerBindingPath([root, binding]);
    expect(() => registry.registerBindingPath([root, binding])).toThrow(
      'CLOSURE_BINDING_PATH_DUPLICATE',
    );
  });

  it('fails closed on simulated binding and resource SHA-256 collisions', () => {
    forceDigestCollision();
    const registry = createClosureIdentityRegistry();
    registry.registerBindingPath([root]);
    registry.registerResourceNode(pin);
    expect(() => registry.registerBindingPath([root, binding])).toThrow(
      'BINDING_PATH_DIGEST_COLLISION',
    );
    expect(() => registry.registerResourceNode({ ...pin, resource_id: 'other' })).toThrow(
      'RESOURCE_NODE_ID_COLLISION',
    );
  });

  it('does not expose retained byte buffers or share registry state', () => {
    const bytes = canonicalBindingPathBytes([root]);
    bytes.fill(0);
    expect(canonicalBindingPath([root])).toBe('bp1.-Gnvvgfh1D_HeBYADWBUUXfy7NyGnxZyxKVwWTxG3TU');
    const first = createClosureIdentityRegistry();
    const second = createClosureIdentityRegistry();
    expect(first.registerBindingPath([root])).toBe(second.registerBindingPath([root]));
  });

  it('bounds registry entries while preserving existing nodes after overflow', () => {
    const registry = createClosureIdentityRegistry();
    let first: string | undefined;
    for (let index = 0; index < 8192; index += 1) {
      const id = registry.registerResourceNode({ ...pin, resource_id: String(index) });
      if (index === 0) first = id;
    }
    expect(() => registry.registerResourceNode(pin)).toThrow('CLOSURE_IDENTITY_LIMIT_EXCEEDED');
    expect(() => registry.registerResourceNode(pin)).toThrow('CLOSURE_IDENTITY_LIMIT_EXCEEDED');
    expect(registry.registerResourceNode({ ...pin, resource_id: '0' })).toBe(first);
  });

  it('bounds retained canonical bytes independently of registry entry count', () => {
    const registry = createClosureIdentityRegistry();
    const largePin = {
      ...pin,
      workspace_id: 'w'.repeat(4000),
      resource_id: 'r'.repeat(4000),
      resource_version_id: 'v'.repeat(4000),
    };
    const makePath = (index: number) => [
      root,
      ...Array.from({ length: 60 }, () => ({
        ...binding,
        owner: { owner_kind: 'published_dependency', pin: largePin },
        local_binding_id: `${String(index).padStart(2, '0')}${'x'.repeat(3998)}`,
      })),
    ];
    const byteLength = canonicalBindingPathBytes(makePath(0)).length;
    const fitting = Math.floor(16_777_216 / byteLength);
    expect(fitting).toBeGreaterThan(0);
    expect(fitting).toBeLessThan(30);
    for (let index = 0; index < fitting; index += 1) registry.registerBindingPath(makePath(index));
    expect(() => registry.registerBindingPath(makePath(fitting))).toThrow(
      'CLOSURE_IDENTITY_LIMIT_EXCEEDED',
    );
    expect(() => registry.registerBindingPath(makePath(fitting))).toThrow(
      'CLOSURE_IDENTITY_LIMIT_EXCEEDED',
    );
    expect(registry.registerResourceNode(pin)).toBe(canonicalResourceNodeId(pin));
  });

  it.each([
    'h',
    'sha256:GG',
    `SHA256:${'a'.repeat(64)}`,
    `sha256:${'A'.repeat(64)}`,
    `${pin.contract_hash}\n`,
    `${pin.contract_hash}\r\n`,
    `${pin.contract_hash}=`,
  ])('rejects noncanonical contract hashes in every pin position %#', (contract_hash) => {
    const badPin = { ...pin, contract_hash };
    expect(() => canonicalResourceNodeId(badPin)).toThrow('CLOSURE_IDENTITY_INPUT_INVALID');
    for (const segments of [
      [{ ...root, pin: badPin }],
      [root, { ...binding, owner: { owner_kind: 'published_dependency', pin: badPin } }],
      [
        root,
        {
          ...flowNode,
          owner: { ...flowNode.owner, pin: { ...flowNode.owner.pin, contract_hash } },
        },
      ],
      [root, { ...packMember, owner_pin: { ...packMember.owner_pin, contract_hash } }],
      [root, { ...subagent, target_pin: badPin }],
    ])
      expect(() => canonicalBindingPath(segments)).toThrow('CLOSURE_IDENTITY_INPUT_INVALID');
  });
});
