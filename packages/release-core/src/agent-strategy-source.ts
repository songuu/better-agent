import {
  AgentStrategySourceCandidateV1Schema,
  StrategyModelPolicyV1Schema,
  type AgentStrategyPinV1,
  type AgentStrategySourceV1,
} from '@better-agent/domain-contracts';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  deriveDependencyManifest,
} from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256 } from './hash.js';
import {
  canonicalSourceSet,
  mismatchedSource,
  parseSourceLosslessly,
  snapshotSource,
  sourceEqual,
} from './source-contract-data.js';

export interface PreparedAgentStrategySourceV1 {
  readonly schema_version: 'prepared-agent-strategy-source/1';
  readonly document: AgentStrategySourceV1;
  readonly preimage: {
    readonly schema_version: 'agent-strategy-source-preimage/1';
    readonly compiler_version: 'capability-compiler/1';
    readonly canonicalizer_version: 'rfc8785/1';
    readonly workspace_id: string;
    readonly published_resource_kind: 'AGENT_STRATEGY_RELEASE';
    readonly document: AgentStrategySourceV1;
  };
  readonly full_pin: {
    readonly workspace_id: string;
    readonly published_resource_kind: 'AGENT_STRATEGY_RELEASE';
    readonly resource_id: string;
    readonly resource_version_id: string;
    readonly contract_hash: `sha256:${string}`;
    readonly binding_mode: 'pinned';
  };
  readonly strategy_pin: AgentStrategyPinV1;
  readonly component_hashes: Readonly<Record<string, `sha256:${string}`>>;
  readonly dependency_manifest: ReturnType<typeof deriveDependencyManifest>;
}

/** Declare immutable control-plane contents; implementation and sandbox enforcement need trusted host admission. */
export function prepareAgentStrategySource(input: unknown): PreparedAgentStrategySourceV1 {
  const candidate = parseSourceLosslessly(
    snapshotSource(input),
    AgentStrategySourceCandidateV1Schema,
  );
  const document = candidate.document;
  document.allowed_capability_binding_ids.sort(compareCanonicalStrings);
  document.allowed_gate_spec_ids.sort(compareCanonicalStrings);
  document.allowed_model_policy.models = canonicalSourceSet(document.allowed_model_policy.models);
  const hashes = {
    config: canonicalSha256(document.config),
    config_schema: canonicalSha256(document.config_schema),
    input_schema: canonicalSha256(document.input_schema),
    state_schema: canonicalSha256(document.state_schema),
    decision_schema: canonicalSha256(document.decision_schema),
    observation_schema: canonicalSha256(document.observation_schema),
    sandbox_profile: canonicalSha256(document.sandbox_profile),
    allowed_model_policy: canonicalSha256(document.allowed_model_policy),
  };
  const owner = {
    workspace_id: candidate.workspace_id,
    published_resource_kind: 'AGENT_STRATEGY_RELEASE' as const,
    resource_id: document.strategy_id,
    resource_version_id: document.strategy_release_id,
  };
  const preimage = {
    schema_version: 'agent-strategy-source-preimage/1' as const,
    compiler_version: 'capability-compiler/1' as const,
    canonicalizer_version: 'rfc8785/1' as const,
    workspace_id: owner.workspace_id,
    published_resource_kind: owner.published_resource_kind,
    document,
  };
  const contract_hash = canonicalSha256(preimage);
  const result: PreparedAgentStrategySourceV1 = {
    schema_version: 'prepared-agent-strategy-source/1',
    document,
    preimage,
    full_pin: { ...owner, contract_hash, binding_mode: 'pinned' },
    strategy_pin: {
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      strategy_id: document.strategy_id,
      strategy_release_id: document.strategy_release_id,
      abi_version: document.abi_version,
      implementation_digest: document.implementation_digest,
      config_hash: hashes.config,
      input_schema_hash: hashes.input_schema,
      state_schema_hash: hashes.state_schema,
      decision_schema_hash: hashes.decision_schema,
      observation_schema_hash: hashes.observation_schema,
      sandbox_profile_id: document.sandbox_profile.profile_id,
      allowed_model_policy_hash: hashes.allowed_model_policy,
      allowed_capability_binding_ids: document.allowed_capability_binding_ids,
      allowed_gate_spec_ids: document.allowed_gate_spec_ids,
      max_iterations: document.max_iterations,
      max_model_attempts: document.max_model_attempts,
      max_tool_calls: document.max_tool_calls,
      contract_hash,
    },
    component_hashes: hashes,
    dependency_manifest: deriveDependencyManifest(owner, []),
  };
  snapshotSource(result);
  return deepFreezeJson(result);
}

export function verifyAgentStrategySource(
  expected: unknown,
  input: unknown,
): PreparedAgentStrategySourceV1 {
  const snapshot = snapshotSource(expected);
  const actual = prepareAgentStrategySource(input);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
}

/** Verify a real Agent source's exact strategy pin and model narrowing; not registry provenance or a runtime Plan. */
export function verifyAgentStrategyAssembly(
  agentInput: unknown,
  strategyInput: unknown,
): PreparedAgentStrategySourceV1 {
  const agent = prepareExecutableSource(agentInput);
  const strategy = prepareAgentStrategySource(strategyInput);
  if (
    agent.root.pin.published_resource_kind !== 'AGENT_RELEASE' ||
    agent.root.pin.workspace_id !== strategy.full_pin.workspace_id ||
    !sourceEqual(agent.preimage.document.strategy, strategy.strategy_pin)
  )
    mismatchedSource();
  const policy = parseSourceLosslessly(
    agent.preimage.document.model_policy,
    StrategyModelPolicyV1Schema,
  );
  const ceiling = strategy.document.allowed_model_policy;
  const allowed = new Map(ceiling.models.map((model) => [model.descriptor_id, model]));
  if (
    policy.maximum_input_tokens > ceiling.maximum_input_tokens ||
    policy.maximum_output_tokens > ceiling.maximum_output_tokens ||
    !policy.models.every((model) => {
      const target = allowed.get(model.descriptor_id);
      return target !== undefined && sourceEqual(model, target);
    })
  )
    mismatchedSource();
  return strategy;
}
