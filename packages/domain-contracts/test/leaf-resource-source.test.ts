import { describe, expect, it } from 'vitest';
import {
  CapabilityNetworkTransportV1Schema,
  DatabaseAdditionalFilterV1Schema,
  DatabaseAllowedTableV1Schema,
  LeafCapabilityRequirementsV1Schema,
  domainContractSchemaRegistry,
} from '../src/index.js';

describe('typed leaf resource structural contracts', () => {
  it.each([
    'knowledge-index-generation-source/1',
    'database-operation-source/1',
    'plugin-tool-source/1',
    'a2a-agent-source/1',
    'leaf-resource-source-candidate/1',
  ])('registers %s under a closed schema', (version) => {
    const schema = domainContractSchemaRegistry.schemaFor(version);
    expect(schema.safeParse({ schema_version: version, secret_ref: 'forbidden' }).success).toBe(
      false,
    );
  });

  it('permits only closed additional predicates and canonical table identities', () => {
    const table = { table_revision_id: '10000000-0000-4000-8000-000000000001', columns: ['title'] };
    expect(DatabaseAllowedTableV1Schema.safeParse(table).success).toBe(true);
    for (const patch of [
      { columns: ['title', 'title'] },
      { columns: ['name;DROP TABLE x'] },
      { extra: true },
    ])
      expect(DatabaseAllowedTableV1Schema.safeParse({ ...table, ...patch }).success).toBe(false);
    const filter = {
      schema_version: 'database-additional-filter/1',
      predicates: [{ column: 'title', operator: 'eq', parameter: 'query' }],
    };
    expect(DatabaseAdditionalFilterV1Schema.safeParse(filter).success).toBe(true);
    expect(DatabaseAdditionalFilterV1Schema.safeParse({ ...filter, sql: 'true' }).success).toBe(
      false,
    );
    expect(
      DatabaseAdditionalFilterV1Schema.safeParse({
        ...filter,
        predicates: [{ column: 'title', operator: 'custom_function', parameter: 'query' }],
      }).success,
    ).toBe(false);
  });

  it('does not accept caller-derived operation/effect claims in intrinsic source requirements', () => {
    const base = {
      schema_version: 'leaf-capability-requirements/1',
      credential_requirements: [],
      principal_modes: ['none'],
      egress: [],
      readable_data_classification: 'public',
      output_data_classification: 'public',
      minimum_limits: {
        calls: 1,
        depth: 0,
        parallelism: 1,
        budget: {
          schema_version: 'capability-budget/1',
          amount_credits: '0',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          duration_ms: 1,
        },
      },
    };
    expect(LeafCapabilityRequirementsV1Schema.safeParse(base).success).toBe(true);
    for (const patch of [
      { operation_contract_hashes: [] },
      { side_effect_class: 'safe' },
      { approval_required: false },
    ])
      expect(LeafCapabilityRequirementsV1Schema.safeParse({ ...base, ...patch }).success).toBe(
        false,
      );
  });

  it('freezes exact endpoints, denied redirects and pinned remote identities', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    const transport = {
      schema_version: 'capability-network-transport/1',
      protocol: 'http_json',
      timeout_ms: 1000,
      max_response_bytes: 1024,
      authentication: { mode: 'none' },
      remote_identity: { identity_id: 'provider', revision: 'v1', identity_hash: hash },
      request: {
        schema_version: 'canonical-egress-rule/1',
        network_policy: { policy_id: 'network', policy_hash: hash, address_class: 'public_only' },
        scheme: 'https',
        host: { match: 'exact', name: 'api.example.com' },
        port: 443,
        path: { match: 'exact', value: '/invoke' },
        methods: ['POST'],
        dns_resolution: 'revalidate_each_connection',
        redirects: { mode: 'deny', max_hops: 0, strip_cross_origin_credentials: true },
      },
    };
    expect(CapabilityNetworkTransportV1Schema.safeParse(transport).success).toBe(true);
    for (const patch of [
      { remote_identity: { ...transport.remote_identity, revision: 'latest' } },
      { request: { ...transport.request, host: { match: 'subdomains', name: 'example.com' } } },
      {
        request: {
          ...transport.request,
          redirects: { mode: 'same_origin', max_hops: 1, strip_cross_origin_credentials: true },
        },
      },
      { authentication: { mode: 'none', token: 'forbidden' } },
      { timeout_ms: 300_001 },
    ])
      expect(CapabilityNetworkTransportV1Schema.safeParse({ ...transport, ...patch }).success).toBe(
        false,
      );
  });
});
