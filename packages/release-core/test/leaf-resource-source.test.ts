import { describe, expect, it, vi } from 'vitest';
import { safeParseDomainContract } from '@better-agent/domain-contracts';
import {
  prepareLeafResourceSource as prepare,
  verifyLeafResourceSource as verify,
  verifyLeafResourceBinding,
  canonicalJsonBytes,
  canonicalSha256,
  canonicalResourceNodeId,
  deriveDependencyManifest,
  prepareOperationContractSource,
  preparePinnedDependencyGraph,
} from '../src/index.js';
import {
  leafCandidate,
  leafKinds,
  put,
  record,
  type LeafKind,
} from './leaf-resource-source-fixtures.js';
import { richAgentSource } from './executable-source-fixtures.js';
import {
  hashA,
  hashB,
  otherWorkspaceId,
  workspaceId,
  agentId,
  agentReleaseId,
} from './fixtures.js';

function bindingFor(candidate: ReturnType<typeof leafCandidate>) {
  const prepared = prepare(candidate);
  const kind = {
    KNOWLEDGE_INDEX_GENERATION: 'knowledge',
    DATABASE_OPERATION_RELEASE: 'database',
    PLUGIN_TOOL_RELEASE: 'plugin',
    A2A_AGENT_RELEASE: 'subagent',
  }[prepared.full_pin.published_resource_kind];
  const binding = record(
    structuredClone(richAgentSource().capability_bindings.find((item) => item.kind === kind)),
  );
  const document = candidate.document;
  binding.pin = prepared.full_pin;
  binding.manual = { ...record(document.manual), hash: prepared.component_hashes.manual };
  binding.input_schema = structuredClone(record(document.operation).input_schema);
  binding.output_schema = structuredClone(record(document.operation).output_schema);
  binding.data_classification = 'internal';
  const credentials = record(document.requirements).credential_requirements as unknown[];
  if (credentials.length) binding.credential_requirement = structuredClone(credentials[0]);
  else delete binding.credential_requirement;
  const config = record(binding.config);
  if (kind === 'knowledge') {
    config.query_contract_hash = prepared.operation_contract.contract_hash;
    config.metadata_filter_policy_hash = prepared.component_hashes.metadata_filter_policy;
  }
  if (kind === 'plugin') {
    config.operation_contract_hash = prepared.operation_contract.contract_hash;
    config.provider_tool_name = document.provider_tool_name;
    config.transport_contract_hash = prepared.component_hashes.transport;
  }
  if (kind === 'database') {
    config.operation_contract_hash = prepared.operation_contract.contract_hash;
    config.table_revision_ids = [record(document.table).table_revision_id];
    config.allowed_tables = [
      { table_revision_id: record(document.table).table_revision_id, columns: ['title'] },
    ];
    config.max_rows = 20;
  }
  if (kind === 'subagent') binding.target_kind = 'external_a2a';
  return binding;
}

describe('typed leaf resource sources', () => {
  it.each(leafKinds)('binds complete %s contents, policies and component hashes', (kind) => {
    const input = leafCandidate(kind);
    const result = prepare(input);
    expect(safeParseDomainContract(input.document).success).toBe(true);
    expect(result.full_pin).toEqual({
      workspace_id: workspaceId,
      published_resource_kind: kind,
      resource_id: input.document.resource_id,
      resource_version_id: input.document.resource_version_id,
      contract_hash: canonicalSha256(result.preimage),
      binding_mode: 'pinned',
    });
    expect(result.preimage).toEqual({
      schema_version: 'leaf-resource-preimage/1',
      compiler_version: 'capability-compiler/1',
      canonicalizer_version: 'rfc8785/1',
      workspace_id: workspaceId,
      published_resource_kind: kind,
      document: result.document,
    });
    const { contract_hash: _hash, binding_mode: _mode, ...owner } = result.full_pin;
    expect(result.dependency_manifest).toEqual(deriveDependencyManifest(owner, []));
    expect(result.operation_contract).toEqual(
      prepareOperationContractSource(input.document.operation).pin,
    );
    expect(result.intrinsic_policy.operation_contract_hashes).toEqual([
      result.operation_contract.contract_hash,
    ]);
    expect(result.intrinsic_policy.side_effect_class).toBe('safe');
    expect(result.component_hashes.manual).toBe(canonicalSha256(input.document.manual));
    expect(verify(result, input)).toEqual(result);
    expect(verifyLeafResourceBinding(bindingFor(input), input)).toEqual(result);
    expect(Object.isFrozen(result.document)).toBe(true);
    expect(Object.isFrozen(result.intrinsic_policy)).toBe(true);
  });

  it.each(leafKinds)('rejects a changed %s source behind an existing full pin', (kind) => {
    const input = leafCandidate(kind);
    const binding = bindingFor(input);
    const result = prepare(input);
    put(input, ['document', 'manual', 'description'], 'Changed content');
    expect(prepare(input).full_pin.contract_hash).not.toBe(result.full_pin.contract_hash);
    expect(() => verify(result, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it.each(leafKinds)(
    'preserves the %s source document and rejects complete artifact field forgery',
    (kind) => {
      const input = leafCandidate(kind);
      const result = prepare(input);
      for (const patch of [
        { component_hashes: {} },
        { intrinsic_policy: {} },
        { dependency_manifest: {} },
        { operation_contract: { ...result.operation_contract, operation_id: 'other' } },
        { extra: true },
      ])
        expect(() => verify({ ...result, ...patch }, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
      put(input, ['document', 'operation', 'input_schema', 'title'], 'new semantic annotation');
      if (kind === 'PLUGIN_TOOL_RELEASE')
        put(
          input,
          ['document', 'tool_list', 'operations', '0'],
          structuredClone(input.document.operation),
        );
      if (kind === 'A2A_AGENT_RELEASE')
        put(
          input,
          ['document', 'agent_card', 'skills', '0', 'operation'],
          structuredClone(input.document.operation),
        );
      expect(prepare(input).operation_contract.input_schema_hash).not.toBe(
        result.operation_contract.input_schema_hash,
      );
    },
  );

  it('supplies exact empty leaf manifests to the bounded pinned graph without claiming publication', () => {
    const leaf = prepare(leafCandidate());
    const root = {
      pin: {
        workspace_id: workspaceId,
        published_resource_kind: 'AGENT_RELEASE',
        resource_id: agentId,
        resource_version_id: agentReleaseId,
        contract_hash: hashA,
        binding_mode: 'pinned',
      },
      semantic_seed_hash: hashA,
    };
    const graph = preparePinnedDependencyGraph({
      schema_version: 'pinned-dependency-graph-candidate/1',
      root,
      root_dependencies: [leaf.full_pin],
      resources: [
        {
          schema_version: 'pinned-dependency-record/1',
          pin: leaf.full_pin,
          publication_state: 'sealed',
          dependency_manifest: leaf.dependency_manifest,
        },
      ],
    });
    expect(graph.nodes.map((node) => node.node_id)).toContain(
      canonicalResourceNodeId(leaf.full_pin),
    );
    expect(graph.nodes).toHaveLength(2);
  });

  it.each([
    ['candidate version', ['schema_version'], 'leaf-resource-source-candidate/2'],
    ['workspace alias', ['workspace_id'], workspaceId.toUpperCase()],
    ['resource alias', ['document', 'resource_id'], agentId.toUpperCase()],
    ['extra secret', ['document', 'secret_ref'], 'not-to-be-echoed'],
    ['precomputed hash', ['document', 'contract_hash'], hashA],
    ['operation hashes', ['document', 'requirements', 'operation_contract_hashes'], [hashA]],
    ['caller effect', ['document', 'requirements', 'side_effect_class'], 'safe'],
    ['caller approval', ['document', 'requirements', 'approval_required'], false],
    ['floating version', ['document', 'transport', 'remote_identity', 'revision'], 'latest'],
    ['implementation hash', ['document', 'implementation_digest'], 'sha256:short'],
  ])('rejects %s in the closed source', (_label, path, value) => {
    const input = leafCandidate();
    put(input, path as string[], value);
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('rejects getters/proxies without traps and own map keys that parsing would lose', () => {
    const input = leafCandidate();
    const trap = vi.fn();
    Object.defineProperty(input.document, 'operation', { get: trap, enumerable: true });
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() => prepare(new Proxy(leafCandidate(), { get: trap, ownKeys: trap }))).toThrow(
      'CLOSURE_SOURCE_INVALID',
    );
    expect(trap).not.toHaveBeenCalled();
    const lost = leafCandidate();
    put(lost, ['document', 'operation', 'input_schema'], JSON.parse('{"__proto__":{"lost":true}}'));
    expect(() => prepare(lost)).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('canonicalizes explicit knowledge and requirement sets but preserves query result order', () => {
    const input = leafCandidate('KNOWLEDGE_INDEX_GENERATION');
    const original = prepare(input);
    record(input.document.index_manifest).shard_hashes = [hashA, hashB];
    expect(prepare(input)).toEqual(original);
    const db = leafCandidate('DATABASE_OPERATION_RELEASE');
    record(db.document.query).select_columns = ['title', 'score'];
    const result = prepare(db);
    record(db.document.table).columns = [
      ...(record(db.document.table).columns as unknown[]),
    ].reverse();
    expect(prepare(db)).toEqual(result);
    record(db.document.query).select_columns = ['score', 'title'];
    expect(prepare(db).full_pin.contract_hash).not.toBe(result.full_pin.contract_hash);
  });

  it.each([
    ['workspace filter off', ['metadata_filter_policy', 'enforce_workspace'], false],
    ['ACL filter off', ['metadata_filter_policy', 'enforce_document_acl'], false],
    ['overlapping chunk', ['ingestion', 'chunk_overlap'], 500],
    ['floating embedding', ['embedding', 'model_revision'], 'latest'],
    ['unknown exposed metadata', ['retrieval', 'include_metadata_fields'], ['unlisted']],
    [
      'rerank overflow',
      ['rerank'],
      { mode: 'model', provider_id: 'provider', model_id: 'rank', model_revision: 'v1', top_n: 11 },
    ],
    ['wrong operation', ['operation', 'operation_kind'], 'plugin_tool'],
  ])('rejects knowledge %s', (_label, path, value) => {
    const input = leafCandidate('KNOWLEDGE_INDEX_GENERATION');
    put(input.document, path as string[], value);
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it.each([
    ['raw SQL', ['query', 'sql'], 'DELETE FROM records'],
    ['unknown selected column', ['query', 'select_columns'], ['unknown']],
    ['unknown predicate column', ['query', 'predicates', '0', 'column'], 'unknown'],
    ['undeclared parameter', ['query', 'predicates', '0', 'parameter'], 'missing'],
    ['table drift', ['query', 'table_revision_id'], agentReleaseId],
    ['workspace filter off', ['row_policy', 'enforce_workspace'], false],
    ['nullable tenant', ['table', 'columns', '0', 'nullable'], true],
    ['unsafe operation', ['operation', 'side_effect_class'], 'unsafe'],
    ['row limit', ['query', 'max_rows'], 501],
    ['SQL identifier', ['table', 'table_name'], 'records;drop table x'],
    ['classification downgrade', ['requirements', 'output_data_classification'], 'public'],
  ])('rejects database %s', (_label, path, value) => {
    const input = leafCandidate('DATABASE_OPERATION_RELEASE');
    put(input.document, path as string[], value);
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it.each(['PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE'] as const)(
    'requires exact transport/authentication requirements for %s',
    (kind) => {
      for (const [path, value] of [
        [['requirements', 'egress'], []],
        [['transport', 'request', 'host', 'match'], 'subdomains'],
        [['transport', 'request', 'path', 'match'], 'subtree'],
        [
          ['transport', 'request', 'methods'],
          ['GET', 'POST'],
        ],
        [['requirements', 'credential_requirements'], []],
        [['transport', 'authentication', 'provider_id'], 'other'],
        [['transport', 'authentication', 'audience'], 'other'],
        [['requirements', 'principal_modes'], ['none']],
      ] as [string[], unknown][]) {
        const input = leafCandidate(kind);
        put(input.document, path, value);
        expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
      }
    },
  );

  it('requires the selected plugin operation or A2A skill to match the published manifest body', () => {
    for (const [kind, path, value] of [
      ['PLUGIN_TOOL_RELEASE', ['tool_list', 'operations', '0', 'operation_id'], 'other'],
      [
        'PLUGIN_TOOL_RELEASE',
        ['tool_list', 'operations', '0', 'output_schema'],
        { type: 'integer' },
      ],
      ['PLUGIN_TOOL_RELEASE', ['provider_tool_name'], 'other'],
      ['A2A_AGENT_RELEASE', ['remote_skill_id'], 'other'],
      ['A2A_AGENT_RELEASE', ['agent_card', 'skills', '0', 'operation', 'output_schema'], {}],
    ] as [LeafKind, string[], unknown][]) {
      const input = leafCandidate(kind);
      put(input.document, path, value);
      expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
    }
  });

  it.each(leafKinds)(
    'checks all %s target pin fields, manual bytes and credential demands',
    (kind) => {
      const input = leafCandidate(kind);
      const binding = bindingFor(input);
      for (const patch of [
        { workspace_id: otherWorkspaceId },
        { resource_id: agentId },
        { resource_version_id: agentReleaseId },
        { contract_hash: hashB },
      ])
        expect(() =>
          verifyLeafResourceBinding(
            { ...binding, pin: { ...record(binding.pin), ...patch } },
            input,
          ),
        ).toThrow('CLOSURE_SOURCE_MISMATCH');
      put(binding, ['manual', 'description'], 'different body');
      expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    },
  );

  it('rejects plugin transport substitution and omitted required scopes', () => {
    const input = leafCandidate();
    const binding = bindingFor(input);
    put(binding, ['config', 'transport_contract_hash'], hashA);
    expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    const credential = bindingFor(input);
    put(credential, ['credential_requirement', 'required_scopes'], ['unrelated']);
    expect(() => verifyLeafResourceBinding(credential, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    put(credential, ['credential_requirement', 'required_scopes'], ['invoke', 'extra']);
    expect(verifyLeafResourceBinding(credential, input).full_pin).toEqual(prepare(input).full_pin);
  });

  it('rejects knowledge filter replacement and output classification downgrade', () => {
    const input = leafCandidate('KNOWLEDGE_INDEX_GENERATION');
    const binding = bindingFor(input);
    put(binding, ['config', 'metadata_filter_policy_hash'], hashA);
    expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    const taint = bindingFor(input);
    taint.data_classification = 'public';
    expect(() => verifyLeafResourceBinding(taint, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('allows only closed database column, row-filter and execution-limit narrowing', () => {
    const input = leafCandidate('DATABASE_OPERATION_RELEASE');
    for (const [path, value] of [
      [['config', 'table_revision_ids'], [agentReleaseId]],
      [['config', 'max_rows'], 51],
      [['config', 'allowed_tables', '0', 'columns'], ['score']],
      [
        ['config', 'allowed_tables', '0', 'columns'],
        ['title', 'unknown'],
      ],
      [['config', 'row_filter_template'], { sql: 'true' }],
      [['timeout_ms'], 1001],
    ] as [string[], unknown][]) {
      const binding = bindingFor(input);
      put(binding, path, value);
      expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    }
    const valid = bindingFor(input);
    put(valid, ['config', 'row_filter_template'], {
      schema_version: 'database-additional-filter/1',
      predicates: [{ column: 'title', operator: 'eq', parameter: 'query' }],
    });
    expect(verifyLeafResourceBinding(valid, input).full_pin).toEqual(prepare(input).full_pin);
  });

  it('rejects database implicit-flow downgrades and additional-filter clearance expansion', () => {
    const input = leafCandidate('DATABASE_OPERATION_RELEASE');
    put(input.document, ['table', 'columns', '2', 'data_classification'], 'restricted');
    for (const [readable, output] of [
      ['internal', 'restricted'],
      ['restricted', 'internal'],
    ] as const) {
      const demand = structuredClone(input);
      put(demand.document, ['requirements', 'readable_data_classification'], readable);
      put(demand.document, ['requirements', 'output_data_classification'], output);
      const binding = bindingFor(demand);
      binding.data_classification = output;
      put(binding, ['config', 'allowed_tables', '0', 'columns'], ['title', 'score']);
      put(binding, ['config', 'row_filter_template'], {
        schema_version: 'database-additional-filter/1',
        predicates: [{ column: 'score', operator: 'eq', parameter: 'query' }],
      });
      expect(() => verifyLeafResourceBinding(binding, demand)).toThrow('CLOSURE_SOURCE_MISMATCH');
    }
    record(input.document.query).order_by = [{ column: 'score', direction: 'asc' }];
    put(input.document, ['requirements', 'readable_data_classification'], 'restricted');
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
    put(input.document, ['requirements', 'output_data_classification'], 'restricted');
    expect(prepare(input).intrinsic_policy.output_data_classification).toBe('restricted');
  });

  it('bounds aggregate encoded output and permits verification of a legal large artifact', () => {
    const input = leafCandidate('KNOWLEDGE_INDEX_GENERATION');
    put(
      input.document,
      ['operation', 'input_schema', 'examples'],
      Array(70).fill('\n'.repeat(32_768)),
    );
    expect(canonicalJsonBytes(input).length).toBeLessThan(8_388_608);
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    put(
      input.document,
      ['operation', 'input_schema', 'examples'],
      Array(50).fill('\n'.repeat(32_768)),
    );
    const prepared = prepare(input);
    expect(canonicalJsonBytes(prepared).length).toBeLessThan(8_388_608);
    expect(verify(prepared, input)).toEqual(prepared);
  });

  it('bounds depth, key, string, array and schema widths before parsing and can retry', () => {
    let nested: unknown = {};
    for (let i = 0; i < 65; i += 1) nested = { nested };
    for (const schema of [
      nested,
      { title: 'é'.repeat(32_769) },
      { examples: Array(1_025).fill('x') },
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, true])),
    ]) {
      const input = leafCandidate();
      put(input.document, ['operation', 'input_schema'], schema);
      expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    }
    const longKey = leafCandidate();
    put(longKey.document, ['operation', 'input_schema'], { ['x'.repeat(257)]: true });
    expect(() => prepare(longKey)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(prepare(leafCandidate()).operation_contract.operation_id).toBe('lookup');
  });

  it('covers user predicate, ordering and additional-filter columns with the Binding allowlist', () => {
    for (const queryPatch of [
      { predicates: [{ column: 'score', operator: 'eq', parameter: 'query' }] },
      { order_by: [{ column: 'score', direction: 'asc' }] },
    ]) {
      const input = leafCandidate('DATABASE_OPERATION_RELEASE');
      Object.assign(record(input.document.query), queryPatch);
      const binding = bindingFor(input);
      expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
      put(binding, ['config', 'allowed_tables', '0', 'columns'], ['title', 'score']);
      expect(verifyLeafResourceBinding(binding, input).full_pin).toEqual(prepare(input).full_pin);
    }
    const input = leafCandidate('DATABASE_OPERATION_RELEASE');
    const binding = bindingFor(input);
    put(binding, ['config', 'row_filter_template'], {
      schema_version: 'database-additional-filter/1',
      predicates: [{ column: 'score', operator: 'eq', parameter: 'query' }],
    });
    expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    put(binding, ['config', 'allowed_tables', '0', 'columns'], ['title', 'score']);
    expect(verifyLeafResourceBinding(binding, input).full_pin).toEqual(prepare(input).full_pin);
  });

  it.each(['PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE'] as const)(
    'binds %s no-auth transport explicitly and rejects redirect or protocol substitution',
    (kind) => {
      const input = leafCandidate(kind);
      put(input.document, ['transport', 'authentication'], { mode: 'none' });
      put(input.document, ['requirements', 'credential_requirements'], []);
      put(input.document, ['requirements', 'principal_modes'], ['none']);
      expect(
        verifyLeafResourceBinding(bindingFor(input), input).intrinsic_policy
          .credential_requirements,
      ).toEqual([]);
      const original = prepare(input);
      put(input.document, ['transport', 'remote_identity', 'identity_hash'], hashB);
      expect(prepare(input).full_pin.contract_hash).not.toBe(original.full_pin.contract_hash);
      put(
        input.document,
        ['transport', 'protocol'],
        kind === 'PLUGIN_TOOL_RELEASE' ? 'a2a_jsonrpc' : 'http_json',
      );
      expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
      const redirect = leafCandidate(kind);
      put(redirect.document, ['transport', 'request', 'redirects'], {
        mode: 'same_origin',
        max_hops: 1,
        strip_cross_origin_credentials: true,
      });
      expect(() => prepare(redirect)).toThrow('CLOSURE_SOURCE_INVALID');
    },
  );

  it.each(leafKinds)(
    'preserves %s full intrinsic demands, freezes detached inputs and checks schema drift',
    (kind) => {
      const input = leafCandidate(kind);
      const original = structuredClone(input);
      const prepared = prepare(input);
      expect(input).toEqual(original);
      const { schema_version: _version, ...requirements } = record(input.document.requirements);
      expect(prepared.intrinsic_policy).toEqual({
        ...requirements,
        schema_version: 'capability-requirements/1',
        operation_contract_hashes: [prepared.operation_contract.contract_hash],
        side_effect_class: 'safe',
        approval_required: false,
      });
      const binding = bindingFor(input);
      binding.input_schema = { type: 'null' };
      expect(() => verifyLeafResourceBinding(binding, input)).toThrow(
        'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
      );
      put(input.document, ['manual', 'description'], 'mutated later');
      expect(prepared.document.manual.description).toBe('Look up a record');
      expect(Object.isFrozen(prepared.preimage.document.operation.input_schema)).toBe(true);
    },
  );

  it('canonicalizes credential sets, keeps required scopes and rejects duplicate manifest identities', () => {
    const input = leafCandidate();
    put(
      input.document,
      ['requirements', 'credential_requirements', '0', 'required_scopes'],
      ['z', 'a'],
    );
    const first = prepare(input);
    put(
      input.document,
      ['requirements', 'credential_requirements', '0', 'required_scopes'],
      ['a', 'z'],
    );
    expect(prepare(input)).toEqual(first);
    put(
      input.document,
      ['tool_list', 'operations'],
      [input.document.operation, input.document.operation],
    );
    expect(() => prepare(input)).toThrow('CLOSURE_SOURCE_INVALID');
    const knowledge = leafCandidate('KNOWLEDGE_INDEX_GENERATION');
    put(knowledge.document, ['index_manifest', 'shard_hashes'], [hashA, hashA]);
    expect(() => prepare(knowledge)).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it.each(['requirement_id', 'provider_id', 'audience'] as const)(
    'rejects Binding credential %s drift independently of scopes',
    (field) => {
      const input = leafCandidate();
      const binding = bindingFor(input);
      put(binding, ['credential_requirement', field], 'different');
      expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    },
  );

  it('preserves credential demands while permitting only a nonempty narrower principal mode set', () => {
    const input = leafCandidate();
    const binding = bindingFor(input);
    put(
      binding,
      ['credential_requirement', 'allowed_principal_modes'],
      ['service_principal', 'team_shared'],
    );
    expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
    put(binding, ['credential_requirement', 'allowed_principal_modes'], []);
    expect(() => verifyLeafResourceBinding(binding, input)).toThrow('CLOSURE_SOURCE_INVALID');
    put(
      input.document,
      ['requirements', 'principal_modes'],
      ['service_principal', 'caller_delegated'],
    );
    put(
      input.document,
      ['requirements', 'credential_requirements', '0', 'allowed_principal_modes'],
      ['service_principal', 'caller_delegated'],
    );
    const narrower = bindingFor(input);
    put(narrower, ['credential_requirement', 'allowed_principal_modes'], ['caller_delegated']);
    expect(verifyLeafResourceBinding(narrower, input).intrinsic_policy.principal_modes).toEqual([
      'caller_delegated',
      'service_principal',
    ]);
    delete narrower.credential_requirement;
    expect(() => verifyLeafResourceBinding(narrower, input)).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it.each(['PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE'] as const)(
    'derives non-default %s effects/approval and checks the Binding declaration',
    (kind) => {
      const input = leafCandidate(kind);
      Object.assign(record(input.document.operation), {
        side_effect_class: 'requires_key',
        operation_key_required: true,
        approval_required: true,
      });
      if (kind === 'PLUGIN_TOOL_RELEASE')
        put(
          input.document,
          ['tool_list', 'operations', '0'],
          structuredClone(input.document.operation),
        );
      else
        put(
          input.document,
          ['agent_card', 'skills', '0', 'operation'],
          structuredClone(input.document.operation),
        );
      const result = prepare(input);
      expect(result.intrinsic_policy.side_effect_class).toBe('requires_key');
      expect(result.intrinsic_policy.approval_required).toBe(true);
      const binding = bindingFor(input);
      expect(() => verifyLeafResourceBinding(binding, input)).toThrow(
        'CAPABILITY_OPERATION_CONTRACT_MISMATCH',
      );
      binding.side_effect = {
        class: 'requires_key',
        operation_key_source: 'generated',
        approval: 'required',
        approval_gate_spec_id: 'published-gate',
      };
      expect(verifyLeafResourceBinding(binding, input)).toEqual(result);
    },
  );

  it('permits a parameter-free SELECT with an empty object input schema', () => {
    const input = leafCandidate('DATABASE_OPERATION_RELEASE');
    put(input.document, ['operation', 'input_schema'], {
      type: 'object',
      additionalProperties: false,
    });
    put(input.document, ['query', 'predicates'], []);
    expect(verifyLeafResourceBinding(bindingFor(input), input).full_pin).toEqual(
      prepare(input).full_pin,
    );
  });
});
