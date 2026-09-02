import {
  CapabilityBindingV1Schema,
  DatabaseAdditionalFilterV1Schema,
  DatabaseAllowedTableV1Schema,
  LeafResourceSourceCandidateV1Schema,
  type A2aAgentSourceV1,
  type CapabilityBindingV1,
  type CapabilityRequirementsV1,
  type DatabaseOperationSourceV1,
  type KnowledgeIndexGenerationSourceV1,
  type LeafResourceDocumentV1,
  type OperationContractPinV1,
  type PluginToolSourceV1,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { normalizeCapabilityRequirements } from './capability-policy.js';
import { deepFreezeJson, deriveDependencyManifest } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';
import {
  prepareOperationContractSource,
  verifyBindingOperationContract,
} from './operation-contract-source.js';

const resourceKinds = {
  'knowledge-index-generation-source/1': 'KNOWLEDGE_INDEX_GENERATION',
  'database-operation-source/1': 'DATABASE_OPERATION_RELEASE',
  'plugin-tool-source/1': 'PLUGIN_TOOL_RELEASE',
  'a2a-agent-source/1': 'A2A_AGENT_RELEASE',
} as const;
const classificationRank = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;
type Kind = (typeof resourceKinds)[keyof typeof resourceKinds];
type Hash = `sha256:${string}`;

export interface PreparedLeafResourceSourceV1 {
  readonly schema_version: 'prepared-leaf-resource-source/1';
  readonly document: LeafResourceDocumentV1;
  readonly preimage: {
    readonly schema_version: 'leaf-resource-preimage/1';
    readonly compiler_version: 'capability-compiler/1';
    readonly canonicalizer_version: 'rfc8785/1';
    readonly workspace_id: string;
    readonly published_resource_kind: Kind;
    readonly document: LeafResourceDocumentV1;
  };
  readonly full_pin: {
    readonly workspace_id: string;
    readonly published_resource_kind: Kind;
    readonly resource_id: string;
    readonly resource_version_id: string;
    readonly contract_hash: Hash;
    readonly binding_mode: 'pinned';
  };
  readonly dependency_manifest: ReturnType<typeof deriveDependencyManifest>;
  readonly operation_contract: OperationContractPinV1;
  readonly intrinsic_policy: Readonly<CapabilityRequirementsV1>;
  readonly component_hashes: Readonly<Record<string, Hash>>;
}

function invalid(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_INVALID',
    '$',
    'leaf source does not satisfy its closed semantic contract',
  );
}
function mismatch(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_MISMATCH',
    '$',
    'leaf source, prepared artifact or Binding does not match',
  );
}
function bounded(input: unknown): unknown {
  const snapshot = boundedDataSnapshot(input, 'source');
  if (canonicalJsonBytes(snapshot).length > 8_388_608)
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
      '$',
      'leaf source exceeds its absolute byte budget',
    );
  return snapshot;
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}
function parseLosslessly<T>(
  input: unknown,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T {
  const result = schema.safeParse(input);
  if (!result.success || !equal(input, result.data)) invalid();
  return result.data;
}
function canonicalSort<T>(values: T[]): T[] {
  return values
    .map((value) => ({ value, bytes: canonicalJsonBytes(value) }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
    .map(({ value }) => value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKnowledge(document: KnowledgeIndexGenerationSourceV1): void {
  if (
    document.operation.operation_kind !== 'knowledge_query' ||
    document.operation.side_effect_class !== 'safe'
  )
    invalid();
  const fields = new Set(document.metadata_filter_policy.allowed_fields.map((field) => field.name));
  if (
    !document.retrieval.include_metadata_fields.every((field) => fields.has(field)) ||
    (document.rerank.mode === 'model' && document.rerank.top_n > document.retrieval.top_k)
  )
    invalid();
  document.source_manifest.sources = canonicalSort(document.source_manifest.sources);
  document.index_manifest.shard_hashes.sort();
  document.retrieval.include_metadata_fields.sort();
  document.metadata_filter_policy.allowed_fields = canonicalSort(
    document.metadata_filter_policy.allowed_fields.map((field) => ({
      ...field,
      operators: field.operators.sort(),
    })),
  );
}

function validPredicates(
  document: DatabaseOperationSourceV1,
  predicates: DatabaseOperationSourceV1['query']['predicates'],
): boolean {
  if (predicates.length === 0) return true;
  const properties = document.operation.input_schema.properties;
  return (
    object(properties) &&
    predicates.every((predicate) => {
      const column = document.table.columns.find((column) => column.name === predicate.column);
      return (
        column !== undefined &&
        classificationRank[column.data_classification] <=
          classificationRank[document.requirements.readable_data_classification] &&
        classificationRank[column.data_classification] <=
          classificationRank[document.requirements.output_data_classification] &&
        Object.hasOwn(properties, predicate.parameter)
      );
    })
  );
}

function queryColumns(document: DatabaseOperationSourceV1): string[] {
  return [
    ...document.query.select_columns,
    ...document.query.predicates.map((item) => item.column),
    ...document.query.order_by.map((item) => item.column),
  ];
}
function validateDatabase(document: DatabaseOperationSourceV1): void {
  if (
    document.operation.operation_kind !== 'database_operation' ||
    document.operation.side_effect_class !== 'safe' ||
    document.query.table_revision_id !== document.table.table_revision_id ||
    document.operation.input_schema.type !== 'object' ||
    !validPredicates(document, document.query.predicates)
  )
    invalid();
  const columns = new Map(document.table.columns.map((column) => [column.name, column]));
  const tenant = columns.get(document.table.tenant_column);
  if (
    tenant?.data_type !== 'uuid' ||
    tenant.nullable ||
    !document.row_policy.principal_filters.every(
      (filter) => columns.get(filter.column)?.data_type === 'uuid',
    )
  )
    invalid();
  const readColumns = [
    ...queryColumns(document),
    document.table.tenant_column,
    ...document.row_policy.principal_filters.map((item) => item.column),
  ];
  if (
    !readColumns.every((name) => {
      const column = columns.get(name);
      return (
        column !== undefined &&
        classificationRank[column.data_classification] <=
          classificationRank[document.requirements.readable_data_classification]
      );
    }) ||
    // Predicate/order/tenant decisions can reveal data through result membership and order.
    !readColumns.every((name) => {
      const column = columns.get(name);
      return (
        column !== undefined &&
        classificationRank[column.data_classification] <=
          classificationRank[document.requirements.output_data_classification]
      );
    })
  )
    invalid();
  document.table.columns = canonicalSort(document.table.columns);
  document.row_policy.principal_filters = canonicalSort(document.row_policy.principal_filters);
}

function validateNetwork(document: PluginToolSourceV1 | A2aAgentSourceV1): void {
  const transport = document.transport;
  const requirements = document.requirements;
  if (!equal(requirements.egress, [transport.request])) invalid();
  const authentication = transport.authentication;
  if (authentication.mode === 'none') {
    if (
      requirements.credential_requirements.length !== 0 ||
      !equal(requirements.principal_modes, ['none'])
    )
      invalid();
  } else {
    const [credential] = requirements.credential_requirements;
    if (
      requirements.credential_requirements.length !== 1 ||
      credential === undefined ||
      authentication.provider_id !== document.provider_id ||
      authentication.requirement_id !== credential.requirement_id ||
      authentication.provider_id !== credential.provider_id ||
      authentication.audience !== credential.audience ||
      requirements.principal_modes.some(
        (mode) => mode === 'none' || !credential.allowed_principal_modes.includes(mode),
      ) ||
      !credential.allowed_principal_modes.every((mode) =>
        requirements.principal_modes.includes(mode),
      )
    )
      invalid();
  }
  if (document.schema_version === 'plugin-tool-source/1') {
    if (transport.protocol === 'a2a_jsonrpc' || document.operation.operation_kind !== 'plugin_tool')
      invalid();
    document.tool_list.operations = canonicalSort(
      document.tool_list.operations.map((operation) => {
        if (operation.operation_kind !== 'plugin_tool') invalid();
        return prepareOperationContractSource(operation).source;
      }),
    );
    const selected = document.tool_list.operations.find(
      (operation) => operation.operation_id === document.provider_tool_name,
    );
    if (selected === undefined || !equal(selected, document.operation)) invalid();
  } else {
    if (
      transport.protocol !== 'a2a_jsonrpc' ||
      document.operation.operation_kind !== 'subagent_call'
    )
      invalid();
    document.agent_card.skills = canonicalSort(
      document.agent_card.skills.map((skill) => {
        if (skill.operation.operation_kind !== 'subagent_call') invalid();
        return { ...skill, operation: prepareOperationContractSource(skill.operation).source };
      }),
    );
    const selected = document.agent_card.skills.find(
      (skill) => skill.skill_id === document.remote_skill_id,
    );
    if (selected === undefined || !equal(selected.operation, document.operation)) invalid();
  }
}

function normalizeRequirements(
  document: LeafResourceDocumentV1,
  operation: OperationContractPinV1,
): Readonly<CapabilityRequirementsV1> {
  let requirements: Readonly<CapabilityRequirementsV1>;
  try {
    requirements = normalizeCapabilityRequirements({
      ...document.requirements,
      schema_version: 'capability-requirements/1',
      operation_contract_hashes: [operation.contract_hash],
      side_effect_class: operation.side_effect_class,
      approval_required: operation.approval_required,
    });
  } catch (error) {
    if (error instanceof ReleaseCoreError && error.code.startsWith('CLOSURE_POLICY_')) invalid();
    throw error;
  }
  const {
    operation_contract_hashes: _hashes,
    side_effect_class: _effect,
    approval_required: _approval,
    ...source
  } = requirements;
  // Use an independent data value: callers cannot mutate a hash's preimage via shared input objects.
  document.requirements = { ...source, schema_version: 'leaf-capability-requirements/1' };
  return requirements;
}

/** Hash typed source bodies. Referenced digests still need trusted catalog/artifact provenance at admission. */
export function prepareLeafResourceSource(input: unknown): PreparedLeafResourceSourceV1 {
  const candidate = parseLosslessly(bounded(input), LeafResourceSourceCandidateV1Schema);
  const document = candidate.document;
  const operation = prepareOperationContractSource(document.operation).pin;
  const requirements = normalizeRequirements(document, operation);
  const components: Record<string, unknown> = { manual: document.manual };
  switch (document.schema_version) {
    case 'knowledge-index-generation-source/1':
      normalizeKnowledge(document);
      for (const key of [
        'source_manifest',
        'ingestion',
        'embedding',
        'retrieval',
        'rerank',
        'metadata_filter_policy',
        'index_manifest',
      ] as const)
        components[key] = document[key];
      break;
    case 'database-operation-source/1':
      validateDatabase(document);
      for (const key of ['connector', 'table', 'query', 'row_policy'] as const)
        components[key] = document[key];
      break;
    case 'plugin-tool-source/1':
      validateNetwork(document);
      components.transport = document.transport;
      components.tool_list = document.tool_list;
      break;
    case 'a2a-agent-source/1':
      validateNetwork(document);
      components.transport = document.transport;
      components.agent_card = document.agent_card;
      break;
  }
  const owner = {
    workspace_id: candidate.workspace_id,
    published_resource_kind: resourceKinds[document.schema_version],
    resource_id: document.resource_id,
    resource_version_id: document.resource_version_id,
  };
  const preimage = {
    schema_version: 'leaf-resource-preimage/1' as const,
    compiler_version: 'capability-compiler/1' as const,
    canonicalizer_version: 'rfc8785/1' as const,
    workspace_id: owner.workspace_id,
    published_resource_kind: owner.published_resource_kind,
    document,
  };
  const result: PreparedLeafResourceSourceV1 = {
    schema_version: 'prepared-leaf-resource-source/1',
    document,
    preimage,
    full_pin: { ...owner, contract_hash: canonicalSha256(preimage), binding_mode: 'pinned' },
    dependency_manifest: deriveDependencyManifest(owner, []),
    operation_contract: operation,
    intrinsic_policy: requirements,
    component_hashes: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, canonicalSha256(value)]),
    ),
  };
  bounded(result);
  return deepFreezeJson(result);
}

export function verifyLeafResourceSource(
  expected: unknown,
  input: unknown,
): PreparedLeafResourceSourceV1 {
  // Each operand has an independent 8 MiB budget, as in executable/operation source verification.
  const snapshot = bounded(expected);
  const actual = prepareLeafResourceSource(input);
  if (!equal(snapshot, actual)) mismatch();
  return actual;
}

function verifyPreparedLeafResourceBinding(
  bindingSnapshot: unknown,
  actual: PreparedLeafResourceSourceV1,
): CapabilityBindingV1 {
  const binding = parseLosslessly(bindingSnapshot, CapabilityBindingV1Schema);
  if (!equal(binding.pin, actual.full_pin)) mismatch();
  verifyBindingOperationContract(binding, actual.document.operation);
  if (
    !equal(binding.manual, { ...actual.document.manual, hash: actual.component_hashes.manual }) ||
    classificationRank[binding.data_classification] <
      classificationRank[actual.intrinsic_policy.output_data_classification]
  )
    mismatch();
  const demands = actual.intrinsic_policy.credential_requirements;
  const supplied = binding.credential_requirement;
  if (demands.length === 0) {
    if (supplied !== undefined) mismatch();
  } else {
    const [demand] = demands;
    if (
      demands.length !== 1 ||
      demand === undefined ||
      supplied === undefined ||
      demand.requirement_id !== supplied.requirement_id ||
      demand.provider_id !== supplied.provider_id ||
      demand.audience !== supplied.audience ||
      !demand.required_scopes.every((scope) => supplied.required_scopes.includes(scope)) ||
      !supplied.allowed_principal_modes.every(
        (mode) =>
          demand.allowed_principal_modes.includes(mode) &&
          actual.intrinsic_policy.principal_modes.includes(mode),
      )
    )
      mismatch();
  }
  const document = actual.document;
  switch (document.schema_version) {
    case 'knowledge-index-generation-source/1':
      if (
        binding.kind !== 'knowledge' ||
        binding.config.metadata_filter_policy_hash !==
          actual.component_hashes.metadata_filter_policy
      )
        mismatch();
      break;
    case 'database-operation-source/1': {
      if (binding.kind !== 'database') mismatch();
      const config = binding.config;
      if (
        !equal(config.table_revision_ids, [document.table.table_revision_id]) ||
        config.allowed_tables.length !== 1 ||
        config.max_rows > document.query.max_rows ||
        binding.timeout_ms > document.query.timeout_ms
      )
        mismatch();
      const allowed = DatabaseAllowedTableV1Schema.safeParse(config.allowed_tables[0]);
      if (
        !allowed.success ||
        !equal(allowed.data, config.allowed_tables[0]) ||
        allowed.data.table_revision_id !== document.table.table_revision_id ||
        !allowed.data.columns.every((name) =>
          document.table.columns.some((column) => column.name === name),
        ) ||
        !queryColumns(document).every((name) => allowed.data.columns.includes(name))
      )
        mismatch();
      if (config.row_filter_template !== undefined) {
        const filter = DatabaseAdditionalFilterV1Schema.safeParse(config.row_filter_template);
        if (
          !filter.success ||
          !equal(filter.data, config.row_filter_template) ||
          !validPredicates(document, filter.data.predicates) ||
          !filter.data.predicates.every((predicate) =>
            allowed.data.columns.includes(predicate.column),
          )
        )
          mismatch();
      }
      break;
    }
    case 'plugin-tool-source/1':
      if (
        binding.kind !== 'plugin' ||
        binding.config.transport_contract_hash !== actual.component_hashes.transport ||
        binding.config.provider_tool_name !== document.provider_tool_name ||
        binding.timeout_ms > document.transport.timeout_ms
      )
        mismatch();
      break;
    case 'a2a-agent-source/1':
      if (
        binding.kind !== 'subagent' ||
        binding.target_kind !== 'external_a2a' ||
        binding.timeout_ms > document.transport.timeout_ms
      )
        mismatch();
      break;
  }
  return binding;
}

/** Check one target binding, not path-policy compilation, registry admission or execution. */
export function verifyLeafResourceBinding(
  bindingInput: unknown,
  input: unknown,
): PreparedLeafResourceSourceV1 {
  const [bindingSnapshot, candidate] = bounded([bindingInput, input]) as unknown[];
  const actual = prepareLeafResourceSource(candidate);
  verifyPreparedLeafResourceBinding(bindingSnapshot, actual);
  return actual;
}

/** Verify a unique bounded Binding set against one prepared leaf source. */
export function verifyLeafResourceBindings(
  bindingInputs: unknown,
  input: unknown,
): PreparedLeafResourceSourceV1 {
  const [bindingSnapshots, candidate] = bounded([bindingInputs, input]) as unknown[];
  if (
    !Array.isArray(bindingSnapshots) ||
    bindingSnapshots.length === 0 ||
    bindingSnapshots.length > 128
  )
    mismatch();
  const actual = prepareLeafResourceSource(candidate);
  const bindingIds = new Set<string>();
  for (const bindingSnapshot of bindingSnapshots) {
    const binding = verifyPreparedLeafResourceBinding(bindingSnapshot, actual);
    if (bindingIds.has(binding.binding_id)) mismatch();
    bindingIds.add(binding.binding_id);
  }
  return actual;
}
