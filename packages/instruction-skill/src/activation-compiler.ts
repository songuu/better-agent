import { InstructionSkillBindingV1Schema } from '@better-agent/domain-contracts';
import {
  canonicalSha256,
  prepareExecutableSource,
  ReleaseCoreError,
  type PreparedInstructionSkillSourceV1,
  verifyInstructionSkillAssembly,
} from '@better-agent/release-core';

export type InstructionSkillActivationErrorCode =
  | 'INPUT_INVALID'
  | 'SOURCE_INVALID'
  | 'ACTIVATION_INVALID';

export class InstructionSkillActivationError extends Error {
  constructor(
    readonly code: InstructionSkillActivationErrorCode,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${code}: ${reason} at ${path}`);
    this.name = 'InstructionSkillActivationError';
  }
}

export interface InertInstructionSkillActivationV1 {
  readonly schema_version: 'inert-instruction-skill-activation/1';
  readonly activation_id: string;
  readonly activation_sequence: number;
  readonly skill_binding_id: string;
  readonly skill_pin: PreparedInstructionSkillSourceV1['full_pin'];
  readonly content_hash: string;
  readonly entry_path: 'SKILL.md';
  readonly entry_content_hash: string;
  readonly trigger: 'automatic' | 'strategy' | 'user';
  readonly script_mode: 'inert';
  readonly allowed_capability_binding_ids: readonly string[];
  readonly context: {
    readonly tokenizer_profile: 'unicode-scalar/1';
    readonly text: string;
    readonly token_count: number;
    readonly source_token_count: number;
    readonly truncated: boolean;
    readonly context_hash: string;
  };
  readonly activation_hash: string;
}

function fail(code: InstructionSkillActivationErrorCode, path: string, reason: string): never {
  throw new InstructionSkillActivationError(code, path, reason);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Examine property descriptors before reading caller data so accessors cannot run. */
function rejectAccessors(root: unknown): void {
  const pending = [root];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (visited > 20_000) fail('INPUT_INVALID', '$', 'input graph exceeds its object budget');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if ('get' in descriptor || 'set' in descriptor)
        fail('INPUT_INVALID', `$.${key}`, 'accessor properties are forbidden');
      if ('value' in descriptor) pending.push(descriptor.value);
    }
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail('INPUT_INVALID', path, 'object fields do not match the closed contract');
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 512)
    fail('INPUT_INVALID', path, 'expected a bounded non-empty string');
  return value;
}

function boundedInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    fail('INPUT_INVALID', path, `expected an integer from 0 through ${maximum}`);
  return value as number;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function compileInertInstructionSkillActivation(
  input: unknown,
): InertInstructionSkillActivationV1 {
  rejectAccessors(input);
  if (!object(input)) fail('INPUT_INVALID', '$', 'expected an object');
  exactKeys(input, ['activation', 'agent_source', 'binding_id', 'source', 'trusted_signers'], '$');
  if (!object(input.activation)) fail('INPUT_INVALID', '$.activation', 'expected an object');
  exactKeys(
    input.activation,
    ['activation_id', 'max_context_tokens', 'sequence', 'trigger'],
    '$.activation',
  );
  const activationId = nonEmpty(input.activation.activation_id, '$.activation.activation_id');
  const bindingId = nonEmpty(input.binding_id, '$.binding_id');
  const sequence = boundedInteger(
    input.activation.sequence,
    '$.activation.sequence',
    1_000_000_000,
  );
  const requestedTokens = boundedInteger(
    input.activation.max_context_tokens,
    '$.activation.max_context_tokens',
    1_048_576,
  );
  const trigger: 'automatic' | 'strategy' | 'user' = (() => {
    const value = input.activation.trigger;
    if (value !== 'automatic' && value !== 'strategy' && value !== 'user')
      return fail('INPUT_INVALID', '$.activation.trigger', 'unknown activation trigger');
    return value;
  })();

  let prepared: ReturnType<typeof verifyInstructionSkillAssembly>;
  let agent: ReturnType<typeof prepareExecutableSource>;
  try {
    prepared = verifyInstructionSkillAssembly(
      input.agent_source,
      bindingId,
      input.source,
      input.trusted_signers,
    );
    agent = prepareExecutableSource(input.agent_source);
  } catch (error) {
    if (error instanceof ReleaseCoreError && error.code === 'SKILL_SCRIPT_EXECUTION_UNSUPPORTED')
      throw error;
    return fail(
      'SOURCE_INVALID',
      '$.source',
      `signed Skill and Agent assembly must replay exactly (${error instanceof Error ? error.message : 'verification failed'})`,
    );
  }
  const document = agent.preimage.document;
  if (
    (document.schema_version !== 'agent-executable-source/1' &&
      document.schema_version !== 'agent-release/1') ||
    !Array.isArray(document.instruction_skill_bindings)
  )
    return fail('SOURCE_INVALID', '$.agent_source', 'expected an Agent executable source');
  const bindings = document.instruction_skill_bindings.map((value, index) => {
    const parsed = InstructionSkillBindingV1Schema.safeParse(value);
    if (!parsed.success)
      return fail(
        'SOURCE_INVALID',
        `$.agent_source.instruction_skill_bindings[${index}]`,
        'Skill Binding did not survive canonical source replay',
      );
    return parsed.data;
  });
  const binding = bindings.find((candidate) => candidate.binding_id === bindingId);
  if (binding === undefined)
    return fail('SOURCE_INVALID', '$.binding_id', 'Skill Binding is absent from the Agent source');
  const expectedTrigger = {
    always: 'automatic',
    model_selected: 'strategy',
    explicit: 'user',
  }[binding.activation];
  if (trigger !== expectedTrigger)
    fail(
      'ACTIVATION_INVALID',
      '$.activation.trigger',
      `trigger must be ${expectedTrigger} for ${binding.activation} activation`,
    );
  const maximumTokens = Math.min(
    binding.context_budget_tokens,
    prepared.inert_content.context_budget_tokens,
  );
  if (requestedTokens > maximumTokens)
    fail(
      'ACTIVATION_INVALID',
      '$.activation.max_context_tokens',
      'requested context exceeds the sealed Agent and Skill budgets',
    );

  // G1 has no tokenizer execution privilege. Its frozen conservative profile treats
  // each Unicode scalar as one context token, making clipping deterministic and safe.
  const sourceTokens = [...prepared.inert_content.entry_text];
  const contextTokens = sourceTokens.slice(0, requestedTokens);
  const contextDraft = {
    schema_version: 'inert-instruction-skill-context/1' as const,
    tokenizer_profile: 'unicode-scalar/1' as const,
    entry_content_hash: prepared.inert_content.entry_content_hash,
    text: contextTokens.join(''),
    token_count: contextTokens.length,
    source_token_count: sourceTokens.length,
    truncated: contextTokens.length < sourceTokens.length,
  };
  const context = { ...contextDraft, context_hash: canonicalSha256(contextDraft) };
  const draft = {
    schema_version: 'inert-instruction-skill-activation/1' as const,
    activation_id: activationId,
    activation_sequence: sequence,
    skill_binding_id: bindingId,
    skill_pin: prepared.full_pin,
    content_hash: prepared.content_hash,
    entry_path: prepared.inert_content.entry_path,
    entry_content_hash: prepared.inert_content.entry_content_hash,
    trigger,
    script_mode: 'inert' as const,
    allowed_capability_binding_ids: [...binding.allowed_capability_binding_ids],
    context,
  };
  return deepFreeze({ ...draft, activation_hash: canonicalSha256(draft) });
}
