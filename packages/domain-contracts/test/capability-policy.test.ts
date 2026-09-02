import { describe, expect, it } from 'vitest';

import {
  CanonicalEgressRuleV1Schema,
  CapabilityBudgetV1Schema,
  parseDomainContract,
} from '../src/index.js';

function rule() {
  return {
    schema_version: 'canonical-egress-rule/1',
    network_policy: {
      policy_id: 'approved-network',
      policy_hash: `sha256:${'a'.repeat(64)}`,
      address_class: 'public_only',
    },
    scheme: 'https',
    host: { match: 'exact', name: 'api.example.com' },
    port: 443,
    path: { match: 'subtree', value: '/v1' },
    methods: ['GET'],
    dns_resolution: 'revalidate_each_connection',
    redirects: { mode: 'deny', max_hops: 0, strip_cross_origin_credentials: true },
  };
}

describe('versioned egress vocabulary', () => {
  it('registers the closed egress and budget contracts', () => {
    expect(parseDomainContract(rule())).toEqual(rule());
    const budget = {
      schema_version: 'capability-budget/1',
      amount_credits: '9223372036854775807',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
    };
    expect(parseDomainContract(budget)).toEqual(budget);
  });

  it.each([
    'API.example.com',
    'api.example.com.',
    '127.0.0.1',
    '2130706433',
    '0x7f000001',
    '[::1]',
    'https://api.example.com',
    'a..example.com',
    'user@api.example.com',
    '*.example.com',
    '例.example.com',
    '-a.example.com',
    'a_.example.com',
  ])('rejects noncanonical host %s', (name) => {
    expect(
      CanonicalEgressRuleV1Schema.safeParse({ ...rule(), host: { match: 'exact', name } }).success,
    ).toBe(false);
  });

  it.each([
    '/v1/../admin',
    '/v1/./chat',
    '//v1',
    '/v1//chat',
    '/v1/',
    '/v1?query=1',
    '/v1#fragment',
    '/v1\\chat',
    '/v1/%2Fadmin',
    '/v1/%5Cadmin',
    '/v1/%2e%2e/admin',
    '/v1/%252fadmin',
    '/v1/%00',
    '/v1/%7F',
    '/v1/%41',
    '/v1/%e4%b8%ad',
    '/v1/%FF',
    '/v1/%ED%A0%80',
    '/v1/%',
    '/v1/中',
    'v1',
    '/v1/white space',
  ])('rejects ambiguous or invalid path %s', (value) => {
    expect(
      CanonicalEgressRuleV1Schema.safeParse({ ...rule(), path: { match: 'exact', value } }).success,
    ).toBe(false);
  });

  it.each(['/', '/v1', '/v1/chat.com', '/v1/%E4%B8%AD', '/v1/a~b', '/v1/a%20b'])(
    'accepts canonical path %s',
    (value) => {
      expect(
        CanonicalEgressRuleV1Schema.safeParse({ ...rule(), path: { match: 'exact', value } })
          .success,
      ).toBe(true);
    },
  );

  it.each([
    { scheme: 'http' },
    { scheme: 'file' },
    { port: 0 },
    { port: 65536 },
    { methods: ['TRACE'] },
    { methods: ['GET', 'GET'] },
    { methods: [] },
    { proxy: 'http://attacker.test' },
    { dns_resolution: 'once' },
    { dns_server: '8.8.8.8' },
    { redirects: {} },
    { redirects: { mode: 'deny', max_hops: 1, strip_cross_origin_credentials: true } },
    { redirects: { mode: 'same_origin', max_hops: 0, strip_cross_origin_credentials: true } },
    { redirects: { mode: 'approved_targets', max_hops: 11, strip_cross_origin_credentials: true } },
    { redirects: { mode: 'approved_targets', max_hops: 1, strip_cross_origin_credentials: false } },
  ])('rejects missing/unknown/weakened network enforcement %j', (changes) => {
    expect(CanonicalEgressRuleV1Schema.safeParse({ ...rule(), ...changes }).success).toBe(false);
  });

  it('supports approved internal HTTP separately without accepting an arbitrary IP policy', () => {
    const internal = {
      ...rule(),
      scheme: 'http',
      host: { match: 'exact', name: 'model-service' },
      port: 8080,
      network_policy: { ...rule().network_policy, address_class: 'approved_internal' },
    };
    expect(CanonicalEgressRuleV1Schema.safeParse(internal).success).toBe(true);
    expect(
      CanonicalEgressRuleV1Schema.safeParse({
        ...internal,
        network_policy: { ...internal.network_policy, cidr: '0.0.0.0/0' },
      }).success,
    ).toBe(false);
  });
});

describe('finite exact budget vocabulary', () => {
  const budget = {
    schema_version: 'capability-budget/1',
    amount_credits: '1',
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    duration_ms: 1,
  };
  it.each(['-1', '01', '+1', '1.0', '1e2', '9223372036854775808', '1\n'])(
    'rejects noncanonical/out-of-range credits %s',
    (amount_credits) => {
      expect(CapabilityBudgetV1Schema.safeParse({ ...budget, amount_credits }).success).toBe(false);
    },
  );
  it.each(['input_tokens', 'output_tokens', 'total_tokens', 'duration_ms'])(
    'requires a finite safe integer for %s',
    (field) => {
      for (const value of [undefined, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
        expect(CapabilityBudgetV1Schema.safeParse({ ...budget, [field]: value }).success).toBe(
          false,
        );
    },
  );
});
