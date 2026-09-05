import {
  CompiledAgentPlanV1Schema,
  StrategyModelPolicyV1Schema,
  type AgentExecutableSourceV1,
  type AgentReleaseV1,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { canonicalResourceNodeId } from './closure-identity.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';
import { verifyInstructionSkillAssembly } from './instruction-skill-source.js';
import { prepareCompiledCapabilityClosure } from './compiled-capability-closure.js';
import { verifyAgentStrategyAssembly } from './agent-strategy-source.js';
import { verifyResolvedExecutionPlan } from './resolved-plan.js';

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_RESOLVED_PLAN_INVALID', path, reason);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(path, 'object fields do not match the closed AgentPlan compiler input');
}

function samePin(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return [
    'workspace_id',
    'published_resource_kind',
    'resource_id',
    'resource_version_id',
    'contract_hash',
    'binding_mode',
  ].every((key) => left[key] === right[key]);
}

export interface PrepareCompiledAgentPlanInput {
  readonly executable_source: unknown;
  readonly closure: unknown;
  readonly resolved_execution_plan: unknown;
  readonly expected_resolved_execution_plan_hash: string;
  readonly strategy_source: unknown;
  readonly instruction_skills: readonly {
    readonly binding_id: string;
    readonly source: unknown;
    readonly trusted_signers: unknown;
  }[];
}

/** Compile only catalogs already proven by the Agent source, closure and admitted Plan. */
export function prepareCompiledAgentPlan(input: PrepareCompiledAgentPlanInput) {
  const safe = boundedDataSnapshot(input, 'closure');
  if (!record(safe)) fail('$', 'expected a closed AgentPlan compiler input');
  exactKeys(
    safe,
    [
      'closure',
      'executable_source',
      'expected_resolved_execution_plan_hash',
      'instruction_skills',
      'resolved_execution_plan',
      'strategy_source',
    ],
    '$',
  );
  if (!Array.isArray(safe.instruction_skills)) fail('$.instruction_skills', 'expected an array');

  const source = prepareExecutableSource(safe.executable_source);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    fail('$.executable_source', 'compiled AgentPlan requires an Agent source');
  const strategy = verifyAgentStrategyAssembly(safe.executable_source, safe.strategy_source);
  const closure = prepareCompiledCapabilityClosure(safe.closure);
  const resolved = verifyResolvedExecutionPlan(
    safe.resolved_execution_plan,
    safe.expected_resolved_execution_plan_hash,
  );
  if (
    resolved.plan_kind !== 'agent' ||
    !samePin(resolved.root_release, source.root.pin) ||
    resolved.capability_closure_hash !== closure.closure_hash ||
    !samePin(closure.root.pin, source.root.pin)
  )
    fail('$.resolved_execution_plan', 'AgentPlan inputs do not bind one Agent and closure');

  if (
    source.preimage.document.schema_version !== 'agent-executable-source/1' &&
    source.preimage.document.schema_version !== 'agent-release/1'
  )
    fail('$.executable_source', 'expected an Agent executable source');
  // prepareExecutableSource already performed the lossless closed-schema parse.
  const document = source.preimage.document as AgentExecutableSourceV1 | AgentReleaseV1;
  const modelPolicy = StrategyModelPolicyV1Schema.safeParse(document.model_policy);
  if (!modelPolicy.success)
    fail('$.executable_source.document.model_policy', 'invalid model policy');

  const rootBindings = new Map<string, (typeof closure.bindings)[number]>();
  const sourceBindings = new Map(
    document.capability_bindings.map((binding) => [binding.binding_id, binding]),
  );
  for (const binding of closure.bindings) {
    const segment = binding.binding_path_segments[1];
    if (
      binding.binding_path_segments.length === 2 &&
      segment?.segment_kind === 'binding' &&
      segment.owner.owner_kind === 'root'
    ) {
      if (rootBindings.has(segment.local_binding_id))
        fail('$.closure.bindings', 'root binding identity is ambiguous');
      rootBindings.set(segment.local_binding_id, binding);
    }
  }
  const enabled = new Map(
    resolved.enabled_bindings.map((binding) => [binding.binding_path, binding]),
  );
  const capabilityCatalog = strategy.document.allowed_capability_binding_ids.flatMap(
    (bindingId) => {
      const binding = rootBindings.get(bindingId);
      if (binding === undefined)
        return fail(
          '$.strategy_source',
          `strategy binding ${bindingId} is absent from the closure`,
        );
      const admitted = enabled.get(binding.binding_path);
      if (admitted === undefined) return [];
      const sourceBinding = sourceBindings.get(bindingId);
      if (sourceBinding === undefined)
        return fail('$.executable_source', `source binding ${bindingId} is absent`);
      const inputSchemaHash = canonicalSha256(sourceBinding.input_schema);
      if (
        admitted.target.contract_hash !== binding.target.contract_hash ||
        admitted.operation_contract_hashes.length !== binding.operation_contracts.length ||
        admitted.operation_contract_hashes.some(
          (hash, index) => hash !== binding.operation_contracts[index]?.contract_hash,
        ) ||
        binding.operation_contracts.some(
          (operation) => operation.input_schema_hash !== inputSchemaHash,
        )
      )
        return fail(
          '$.resolved_execution_plan.enabled_bindings',
          'admitted operation catalog drifted',
        );
      const joinChildCeiling = (() => {
        if (sourceBinding.kind !== 'subagent' || sourceBinding.config.invocation !== 'async')
          return undefined;
        if (sourceBinding.config.authorization_delegation.mode !== 'bounded_delegation')
          return fail(
            '$.executable_source',
            'an async G1 SubAgent requires a bounded delegation policy',
          );
        const policy = sourceBinding.config.authorization_delegation.policy;
        return {
          schema_version: 'g1-join-child-ceiling/1' as const,
          target_ref: `agent-release:${binding.target.resource_id}:${binding.target.resource_version_id}`,
          max_calls: Math.min(
            sourceBinding.config.max_calls,
            policy.max_calls,
            admitted.effective_policy.max_calls,
          ),
          max_depth: Math.min(
            sourceBinding.config.max_depth,
            policy.max_depth,
            admitted.effective_policy.max_depth,
          ),
          max_ttl_seconds: policy.max_ttl_seconds,
          max_budget_credits: admitted.effective_policy.budget.amount_credits,
          delegation_policy_hash: canonicalSha256(policy),
        };
      })();
      return [
        {
          schema_version: 'agent-capability-catalog-entry/1' as const,
          local_binding_id: bindingId,
          binding_path: binding.binding_path,
          binding_kind: binding.binding_kind,
          target: binding.target,
          operations: binding.operation_contracts.map((operation) => ({
            ...operation,
            input_schema: sourceBinding.input_schema,
          })),
          effective_policy_hash: admitted.effective_policy_hash,
          ...(binding.async_child_policy_hash === undefined
            ? {}
            : { async_child_policy_hash: binding.async_child_policy_hash }),
          ...(joinChildCeiling === undefined ? {} : { join_child_ceiling: joinChildCeiling }),
          ...(admitted.approval_gate_spec === undefined
            ? {}
            : { approval_gate_spec: admitted.approval_gate_spec }),
        },
      ];
    },
  );

  const skillInputs = new Map<string, Record<string, unknown>>();
  safe.instruction_skills.forEach((value, index) => {
    if (!record(value)) fail(`$.instruction_skills[${index}]`, 'expected an object');
    exactKeys(value, ['binding_id', 'source', 'trusted_signers'], `$.instruction_skills[${index}]`);
    if (typeof value.binding_id !== 'string' || value.binding_id.length === 0)
      fail(`$.instruction_skills[${index}].binding_id`, 'expected a non-empty binding id');
    if (skillInputs.has(value.binding_id))
      fail('$.instruction_skills', 'Skill Binding inputs must be unique');
    skillInputs.set(value.binding_id, value);
  });
  const skills = document.instruction_skill_bindings.map((binding) => {
    const supplied = skillInputs.get(binding.binding_id);
    if (supplied === undefined)
      return fail('$.instruction_skills', `missing Skill source for ${binding.binding_id}`);
    const prepared = verifyInstructionSkillAssembly(
      safe.executable_source,
      binding.binding_id,
      supplied.source,
      supplied.trusted_signers,
    );
    return {
      schema_version: 'agent-instruction-skill-catalog-entry/1' as const,
      binding_id: binding.binding_id,
      skill_pin: prepared.full_pin,
      content_hash: prepared.content_hash,
      entry_content_hash: prepared.inert_content.entry_content_hash,
      activation: binding.activation,
      script_mode: 'inert' as const,
      context_budget_tokens: Math.min(
        binding.context_budget_tokens,
        prepared.inert_content.context_budget_tokens,
      ),
      allowed_capability_paths: binding.allowed_capability_binding_ids.flatMap((bindingId) => {
        const target = rootBindings.get(bindingId);
        if (target === undefined)
          return fail(
            '$.instruction_skills',
            `Skill capability ${bindingId} is absent from closure`,
          );
        return enabled.has(target.binding_path) ? [target.binding_path] : [];
      }),
    };
  });
  if (skillInputs.size !== skills.length)
    fail('$.instruction_skills', 'unexpected Skill source input');

  const publicHandles = document.public_capability_handles.map((handle) => {
    const binding = rootBindings.get(handle.binding_id);
    if (binding === undefined)
      return fail(
        '$.executable_source.document.public_capability_handles',
        'handle target missing',
      );
    const operation = binding.operation_contracts.find(
      (candidate) => candidate.contract_hash === handle.operation_contract_hash,
    );
    if (operation === undefined || operation.input_schema_hash !== handle.input_schema_hash)
      return fail(
        '$.executable_source.document.public_capability_handles',
        'handle operation or input schema does not match the closure',
      );
    return {
      ...handle,
      binding_path: binding.binding_path,
      enabled: enabled.has(binding.binding_path),
    };
  });

  const gates = strategy.document.allowed_gate_spec_ids.map((gateId) => {
    const rootNodeId = canonicalResourceNodeId(closure.root.pin);
    const matches = closure.gate_specs.filter(
      (gate) =>
        gate.gate_spec_id === gateId &&
        gate.source_kind === 'agent_release' &&
        gate.source_node_id === rootNodeId,
    );
    if (matches.length !== 1) fail('$.closure.gate_specs', `strategy gate ${gateId} is not unique`);
    return matches[0];
  });
  const candidate = {
    schema_version: 'compiled-agent-plan/1' as const,
    agent_release: resolved.root_release,
    source_semantic_hash: source.root.semantic_seed_hash,
    capability_closure_hash: closure.closure_hash,
    resolved_execution_plan_hash: resolved.plan_hash,
    strategy: {
      full_pin: strategy.full_pin,
      strategy_pin: strategy.strategy_pin,
      component_hashes: strategy.component_hashes,
      config: strategy.document.config,
      schemas: {
        config: strategy.document.config_schema,
        input: strategy.document.input_schema,
        state: strategy.document.state_schema,
        decision: strategy.document.decision_schema,
        observation: strategy.document.observation_schema,
      },
    },
    role_context_hash: canonicalSha256(document.role),
    input_schema_hash: canonicalSha256(document.input_contract),
    ...(document.output_contract === undefined
      ? {}
      : {
          output_schema: document.output_contract,
          output_schema_hash: canonicalSha256(document.output_contract),
        }),
    model_catalog: modelPolicy.data.models,
    model_limits: {
      maximum_input_tokens: modelPolicy.data.maximum_input_tokens,
      maximum_output_tokens: modelPolicy.data.maximum_output_tokens,
    },
    capability_catalog: capabilityCatalog,
    instruction_skills: skills,
    gates,
    public_capability_handles: publicHandles,
    runtime_limits: document.runtime_limits,
    strategy_limits: {
      max_iterations: strategy.document.max_iterations,
      max_model_attempts: strategy.document.max_model_attempts,
      max_tool_calls: strategy.document.max_tool_calls,
    },
    checkpoint_contract_version: 'agent-strategy-checkpoint/1' as const,
  };
  const planHash = canonicalSha256(candidate);
  return verifyCompiledAgentPlan({ ...candidate, plan_hash: planHash }, planHash);
}

export function verifyCompiledAgentPlan(input: unknown, expectedPlanHash: unknown) {
  const safe = boundedDataSnapshot(input, 'closure');
  const parsed = CompiledAgentPlanV1Schema.safeParse(safe);
  if (!parsed.success)
    fail(
      '$.agent_plan',
      `compiled AgentPlan failed its versioned contract (${parsed.error.issues[0]?.path.join('.') ?? 'schema'}: ${parsed.error.issues[0]?.message ?? 'invalid'})`,
    );
  const actual = canonicalSha256ExcludingRootKeys(parsed.data, ['plan_hash']);
  if (parsed.data.plan_hash !== actual || expectedPlanHash !== actual)
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.agent_plan.plan_hash',
      'compiled AgentPlan differs from its trusted hash',
    );
  // Re-encode before returning so callers cannot retain exotic object identity.
  canonicalJsonBytes(parsed.data);
  return deepFreezeJson(parsed.data);
}
