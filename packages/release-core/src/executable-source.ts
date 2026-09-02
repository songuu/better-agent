import {
  AgentExecutableSourceV1Schema,
  FlowIrV1Schema,
  UuidV1Schema,
  type AgentExecutableSourceV1,
  type CapabilityBindingV1,
  type CredentialRequirementV1,
  type FlowGraphV1,
  type JsonObject,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  deriveDependencyManifest,
  normalizeDependencyPins,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';

type ExecutableKind = 'AGENT_RELEASE' | 'FLOW_VERSION';
export interface PreparedExecutableSourceV1 {
  readonly schema_version: 'prepared-executable-source/1';
  readonly preimage: {
    readonly schema_version: 'executable-semantic-preimage/1';
    readonly compiler_version: 'capability-compiler/1';
    readonly canonicalizer_version: 'rfc8785/1';
    readonly workspace_id: string;
    readonly published_resource_kind: ExecutableKind;
    readonly document: JsonObject;
  };
  readonly root: {
    readonly pin: PublishedResourcePinV1 & { published_resource_kind: ExecutableKind };
    readonly semantic_seed_hash: `sha256:${string}`;
  };
  readonly dependency_manifest: ReturnType<typeof deriveDependencyManifest>;
}

function invalid(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_INVALID',
    '$.document',
    'executable source does not satisfy its canonical kind-specific contract',
  );
}
function bounded(input: unknown): unknown {
  const value = boundedDataSnapshot(input, 'source');
  if (canonicalJsonBytes(value).length > 8_388_608)
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
      '$',
      'encoded executable source exceeds its byte budget',
    );
  return value;
}
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}
function uuid(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value !== value.toLowerCase() ||
    !UuidV1Schema.safeParse(value).success
  )
    invalid();
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || value.length !== 71 || !/^sha256:[a-f0-9]{64}$/u.test(value))
    invalid();
}
function hashFields(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const fields = value as Record<string, unknown>;
  for (const key of required) hash(fields[key]);
  for (const key of optional) if (fields[key] !== undefined) hash(fields[key]);
}
function sorted<T>(values: readonly T[], key: (item: T) => string): T[] {
  return [...values].sort((a, b) => compareCanonicalStrings(key(a), key(b)));
}
function strings(values: readonly string[]): string[] {
  return sorted(values, (value) => value);
}
function pins(workspace: string, values: readonly unknown[]): PublishedResourcePinV1[] {
  try {
    const normalized = normalizeDependencyPins(workspace, values);
    for (const pin of normalized) {
      uuid(pin.workspace_id);
      uuid(pin.resource_id);
      uuid(pin.resource_version_id);
      hash(pin.contract_hash);
    }
    return [...normalized];
  } catch {
    invalid();
  }
}
function normalizeRequirement(requirement: CredentialRequirementV1): void {
  requirement.required_scopes = strings(requirement.required_scopes);
  requirement.allowed_principal_modes = sorted(
    requirement.allowed_principal_modes,
    (value) => value,
  );
}
function normalizeGate(gate: {
  protected_operation_contract_hashes: string[];
  decision_schema_hash: string;
  approver_policy_hash: string;
  gate_spec_hash: string;
  notification_profile_hash?: string | undefined;
  prompt_template_hash?: string | undefined;
}): void {
  hashFields(
    gate,
    ['decision_schema_hash', 'approver_policy_hash', 'gate_spec_hash'],
    ['notification_profile_hash', 'prompt_template_hash'],
  );
  for (const value of gate.protected_operation_contract_hashes) hash(value);
  gate.protected_operation_contract_hashes = strings(gate.protected_operation_contract_hashes);
}

function normalizeBinding(binding: CapabilityBindingV1, workspace: string): void {
  pins(workspace, [binding.pin]);
  hash(binding.manual.hash);
  hashFields(binding.side_effect, [], ['compensation_contract_hash']);
  if (binding.credential_requirement !== undefined)
    normalizeRequirement(binding.credential_requirement);
  switch (binding.kind) {
    case 'knowledge':
      hashFields(binding.config, ['query_contract_hash', 'metadata_filter_policy_hash']);
      break;
    case 'database':
      hash(binding.config.operation_contract_hash);
      binding.config.table_revision_ids = strings(binding.config.table_revision_ids);
      break;
    case 'plugin':
      hashFields(binding.config, ['operation_contract_hash', 'transport_contract_hash']);
      break;
    case 'skill_pack':
      hash(binding.config.member_projection_hash);
      for (const operation of binding.config.exposed_operations)
        hash(operation.exposed_operation_contract_hash);
      binding.config.exposed_operations = sorted(
        binding.config.exposed_operations,
        (operation) => operation.exposed_operation_id,
      );
      break;
    case 'subagent': {
      const config = binding.config;
      config.input_allowlist = strings(config.input_allowlist);
      const projection = config.context_projection;
      projection.allowed_message_kinds = sorted(projection.allowed_message_kinds, (kind) => kind);
      projection.allowed_field_paths = strings(projection.allowed_field_paths);
      hash(projection.projection_contract_hash);
      hash(projection.serializer_pin.implementation_digest);
      hashFields(projection.tokenizer_pin, ['vocabulary_hash', 'implementation_digest']);
      hash(projection.truncation_policy.policy_hash);
      if (projection.mode === 'summary') {
        hash(projection.summary_policy.output_schema_hash);
        hash(projection.summary_policy.prompt_template_pin.content_hash);
      }
      if (config.authorization_delegation.mode === 'bounded_delegation') {
        const policy = config.authorization_delegation.policy;
        policy.target_capability_binding_ids = strings(policy.target_capability_binding_ids);
        policy.allowed_audiences = strings(policy.allowed_audiences);
        policy.allowed_scopes = strings(policy.allowed_scopes);
        policy.allowed_resource_pins = pins(workspace, policy.allowed_resource_pins);
        for (const value of policy.allowed_operation_contract_hashes) hash(value);
        policy.allowed_operation_contract_hashes = strings(
          policy.allowed_operation_contract_hashes,
        );
        policy.allowed_credential_modes = sorted(policy.allowed_credential_modes, (mode) => mode);
      }
      break;
    }
    case 'flow':
      break;
  }
}

function normalizeAgent(source: AgentExecutableSourceV1, workspace: string) {
  uuid(source.source_draft_revision_id);
  const strategy = source.strategy;
  hashFields(strategy, [
    'implementation_digest',
    'config_hash',
    'input_schema_hash',
    'state_schema_hash',
    'decision_schema_hash',
    'observation_schema_hash',
    'allowed_model_policy_hash',
    'contract_hash',
  ]);
  strategy.allowed_capability_binding_ids = strings(strategy.allowed_capability_binding_ids);
  strategy.allowed_gate_spec_ids = strings(strategy.allowed_gate_spec_ids);
  source.gate_specs = sorted(source.gate_specs, (gate) => gate.gate_spec_id);
  for (const gate of source.gate_specs) normalizeGate(gate);
  source.capability_bindings = sorted(source.capability_bindings, (binding) => binding.binding_id);
  for (const binding of source.capability_bindings) normalizeBinding(binding, workspace);
  source.instruction_skill_bindings = sorted(
    source.instruction_skill_bindings,
    (binding) => binding.binding_id,
  );
  for (const binding of source.instruction_skill_bindings) {
    hash(binding.content_hash);
    binding.allowed_capability_binding_ids = strings(binding.allowed_capability_binding_ids);
  }
  source.public_capability_handles = sorted(
    source.public_capability_handles,
    (handle) => handle.public_handle,
  );
  for (const handle of source.public_capability_handles)
    hashFields(handle, ['operation_contract_hash', 'input_schema_hash']);
  const dependencies = pins(workspace, [
    {
      workspace_id: workspace,
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      resource_id: strategy.strategy_id,
      resource_version_id: strategy.strategy_release_id,
      contract_hash: strategy.contract_hash,
      binding_mode: 'pinned',
    },
    ...source.instruction_skill_bindings.map((binding) => binding.skill_pin),
    ...source.capability_bindings.map((binding) => binding.pin),
  ]);
  const { release_number: _number, source_draft_revision_id: _draft, ...document } = source;
  // The detached input already passed the JSON-backed schema; absent optional keys are omitted.
  return { document: document as unknown as JsonObject, dependencies };
}

function normalizeFlowGraph(
  graph: FlowGraphV1,
  resources: readonly PublishedResourcePinV1[],
  budget: { nodes: number },
): void {
  budget.nodes += graph.nodes.length;
  if (budget.nodes > 4096)
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_LIMIT_EXCEEDED',
      '$.document',
      'Flow source exceeds its node budget',
    );
  graph.nodes = sorted(graph.nodes, (node) => node.node_id);
  graph.edges = sorted(graph.edges, (edge) => edge.edge_id);
  graph.exit_node_ids = strings(graph.exit_node_ids);
  for (const node of graph.nodes) {
    const config = object(node.config);
    if (node.type === 'subflow') {
      const target = object(config.target);
      uuid(target.flow_id);
      uuid(target.flow_version_id);
      if (
        !resources.some(
          (pin) =>
            pin.published_resource_kind === 'FLOW_VERSION' &&
            pin.resource_id === target.flow_id &&
            pin.resource_version_id === target.flow_version_id,
        )
      )
        invalid();
    } else if (node.type === 'loop') {
      normalizeFlowGraph(config.body as FlowGraphV1, resources, budget);
    } else if (node.type === 'branch') {
      // Cases have first-match semantics; normalize their graphs, never reorder the cases.
      for (const branch of config.cases as { graph: FlowGraphV1 }[])
        normalizeFlowGraph(branch.graph, resources, budget);
      normalizeFlowGraph((config.else_case as { graph: FlowGraphV1 }).graph, resources, budget);
    } else if (node.type === 'human_gate') {
      normalizeGate(config.gate as Parameters<typeof normalizeGate>[0]);
    }
  }
}

/**
 * Compute root semantics and direct pins from closed source bodies, not supplied digest claims.
 * This does not validate resource provenance, opaque action/policy subcontracts or a final closure.
 */
export function prepareExecutableSource(input: unknown): PreparedExecutableSourceV1 {
  const candidate = object(bounded(input));
  if (
    candidate.schema_version !== 'executable-source-candidate/1' ||
    Object.keys(candidate).length !== 3 ||
    !Object.hasOwn(candidate, 'workspace_id') ||
    !Object.hasOwn(candidate, 'document')
  )
    invalid();
  uuid(candidate.workspace_id);
  const workspace = candidate.workspace_id;
  const raw = object(candidate.document);
  let kind: ExecutableKind;
  let resourceId: string;
  let versionId: string;
  let document: JsonObject;
  let dependencies: PublishedResourcePinV1[];
  if (raw.schema_version === 'agent-executable-source/1') {
    const parsed = AgentExecutableSourceV1Schema.safeParse(raw);
    if (!parsed.success) invalid();
    // A validator may strip special map keys; content addressing must never hash altered input.
    if (!canonicalJsonBytes(raw).equals(canonicalJsonBytes(parsed.data))) invalid();
    kind = 'AGENT_RELEASE';
    resourceId = parsed.data.agent_id;
    versionId = parsed.data.agent_release_id;
    ({ document, dependencies } = normalizeAgent(parsed.data, workspace));
  } else if (raw.schema_version === 'flow-ir/1') {
    const parsed = FlowIrV1Schema.safeParse(raw);
    if (!parsed.success) invalid();
    if (!canonicalJsonBytes(raw).equals(canonicalJsonBytes(parsed.data))) invalid();
    kind = 'FLOW_VERSION';
    resourceId = parsed.data.flow_id;
    versionId = parsed.data.flow_version_id;
    dependencies = pins(workspace, parsed.data.resources);
    parsed.data.resources = dependencies;
    parsed.data.credential_requirements = sorted(
      parsed.data.credential_requirements,
      (requirement) => requirement.requirement_id,
    );
    for (const requirement of parsed.data.credential_requirements)
      normalizeRequirement(requirement);
    normalizeFlowGraph(parsed.data.entry_graph, dependencies, { nodes: 0 });
    const { title: _title, ui: _ui, ...semanticDocument } = parsed.data;
    document = semanticDocument as unknown as JsonObject;
  } else invalid();
  uuid(resourceId);
  uuid(versionId);
  for (const pin of dependencies)
    if (
      pin.published_resource_kind === kind &&
      pin.resource_id === resourceId &&
      pin.resource_version_id === versionId
    )
      throw new ReleaseCoreError(
        'CAPABILITY_DEPENDENCY_CYCLE',
        '$.document',
        'source depends on its own executable version',
      );
  const preimage = {
    schema_version: 'executable-semantic-preimage/1' as const,
    compiler_version: 'capability-compiler/1' as const,
    canonicalizer_version: 'rfc8785/1' as const,
    workspace_id: workspace,
    published_resource_kind: kind,
    document,
  };
  const seed = canonicalSha256(preimage);
  const owner = {
    workspace_id: workspace,
    published_resource_kind: kind,
    resource_id: resourceId,
    resource_version_id: versionId,
  };
  const result: PreparedExecutableSourceV1 = {
    schema_version: 'prepared-executable-source/1',
    preimage,
    root: {
      pin: { ...owner, contract_hash: seed, binding_mode: 'pinned' },
      semantic_seed_hash: seed,
    },
    dependency_manifest: deriveDependencyManifest(owner, dependencies),
  };
  bounded(result);
  return deepFreezeJson(result);
}

export function verifyExecutableSource(
  expected: unknown,
  input: unknown,
): PreparedExecutableSourceV1 {
  const snapshot = bounded(expected);
  const actual = prepareExecutableSource(input);
  if (!canonicalJsonBytes(snapshot).equals(canonicalJsonBytes(actual)))
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_MISMATCH',
      '$',
      'prepared semantics differ from the source recomputation',
    );
  return actual;
}

function compiledHash(
  source: PreparedExecutableSourceV1,
  closureHash: unknown,
): `sha256:${string}` {
  hash(closureHash);
  const preimage = bounded({
    ...source.preimage,
    schema_version: 'executable-compiled-preimage/1',
    capability_closure_hash: closureHash,
  });
  return canonicalSha256(preimage);
}

/** A hash binding primitive only: the caller must independently verify the closure body. */
export function deriveExecutableCompiledHash(
  input: unknown,
  closureHash: unknown,
): `sha256:${string}` {
  return compiledHash(prepareExecutableSource(input), closureHash);
}

/** Compare all registry pin fields; successful hash binding is not registry/closure admission. */
export function verifyExecutableCompiledHash(
  expectedPin: unknown,
  input: unknown,
  closureHash: unknown,
): void {
  const source = prepareExecutableSource(input);
  const expected = pins(source.preimage.workspace_id, [bounded(expectedPin)])[0];
  const actual = { ...source.root.pin, contract_hash: compiledHash(source, closureHash) };
  if (!canonicalJsonBytes(expected).equals(canonicalJsonBytes(actual)))
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_MISMATCH',
      '$',
      'compiled hash binding does not match the complete executable pin',
    );
}
