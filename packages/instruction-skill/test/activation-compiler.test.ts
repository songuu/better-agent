import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentExecutableSourceV1,
  InstructionSkillSourceCandidateV1,
} from '@better-agent/domain-contracts';
import {
  canonicalJsonBytes,
  canonicalSha256,
  prepareInstructionSkillSource,
} from '@better-agent/release-core';
import { compileInertInstructionSkillActivation } from '../src/index.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const agentId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const strategyId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
const strategyReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e04';
const pluginId = '018f47f2-c541-7cc6-9292-4a2c35303e0c';
const pluginReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
const hashA = `sha256:${'a'.repeat(64)}` as const;
const hashB = `sha256:${'b'.repeat(64)}` as const;
const signer = generateKeyPairSync('ed25519');

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function unsignedSource(): InstructionSkillSourceCandidateV1 {
  const entry = Buffer.from('# Procedure\nUse only the allowed lookup capability.\n');
  return {
    schema_version: 'instruction-skill-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'instruction-skill-source/1',
      resource_id: agentId,
      resource_version_id: agentReleaseId,
      name: 'Reviewed procedure',
      description: 'A signed inert procedure',
      parser_version: 'instruction-skill-bundle-parser/1',
      entry_path: 'SKILL.md',
      origin: { publisher_id: 'publisher-1', source_id: 'reviewed-content', revision: '1' },
      manifest: [
        {
          path: 'SKILL.md',
          kind: 'instruction',
          size_bytes: entry.length,
          content_hash: digest(entry),
        },
      ],
      allowed_capability_binding_ids: ['plugin'],
      context_budget_tokens: 2048,
      data_classification: 'internal',
      scripts: { mode: 'inert', requires_execution: false },
      signature: { algorithm: 'ed25519', key_id: 'publisher-key-1', signature_base64: '' },
    },
    files: [{ path: 'SKILL.md', chunks_base64: [entry.toString('base64')] }],
  };
}

function signingPayload(input: InstructionSkillSourceCandidateV1) {
  const { signature, ...document } = input.document;
  return {
    schema_version: 'instruction-skill-signing-payload/1',
    canonicalizer_version: 'rfc8785/1',
    workspace_id: input.workspace_id,
    published_resource_kind: 'INSTRUCTION_SKILL_RELEASE',
    document,
    signer: { algorithm: signature.algorithm, key_id: signature.key_id },
  };
}

function resign(input: InstructionSkillSourceCandidateV1) {
  input.document.signature.signature_base64 = sign(
    null,
    canonicalJsonBytes(signingPayload(input)),
    signer.privateKey,
  ).toString('base64');
  return input;
}

function signedSource() {
  return resign(unsignedSource());
}

function trustedSigners() {
  return {
    schema_version: 'instruction-skill-trusted-signers/1',
    workspace_id: workspaceId,
    signers: [
      {
        key_id: 'publisher-key-1',
        publisher_id: 'publisher-1',
        source_id: 'reviewed-content',
        allowed_resource_ids: [agentId],
        public_key_spki_base64: signer.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64'),
      },
    ],
  };
}

function agentDocument(): AgentExecutableSourceV1 {
  const pluginPin = {
    workspace_id: workspaceId,
    published_resource_kind: 'PLUGIN_TOOL_RELEASE' as const,
    resource_id: pluginId,
    resource_version_id: pluginReleaseId,
    contract_hash: hashB,
    binding_mode: 'pinned' as const,
  };
  return {
    schema_version: 'agent-executable-source/1' as const,
    agent_id: agentId,
    agent_release_id: agentReleaseId,
    release_number: 1,
    source_draft_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e0a',
    role: { title: 'Assistant' },
    input_contract: { type: 'object' },
    model_policy: {},
    strategy: {
      published_resource_kind: 'AGENT_STRATEGY_RELEASE' as const,
      strategy_id: strategyId,
      strategy_release_id: strategyReleaseId,
      abi_version: 'agent-strategy-abi/1' as const,
      implementation_digest: hashA,
      config_hash: hashA,
      input_schema_hash: hashA,
      state_schema_hash: hashA,
      decision_schema_hash: hashA,
      observation_schema_hash: hashA,
      sandbox_profile_id: 'sandbox-default',
      allowed_model_policy_hash: hashA,
      allowed_capability_binding_ids: ['plugin'],
      allowed_gate_spec_ids: [],
      max_iterations: 8,
      max_model_attempts: 4,
      max_tool_calls: 4,
      contract_hash: hashA,
    },
    gate_specs: [],
    instruction_skill_bindings: [],
    capability_bindings: [
      {
        binding_id: 'plugin',
        enabled: true,
        discoverability: 'model_selectable' as const,
        manual: { description: 'Lookup', hash: hashA },
        input_schema: { type: 'object' },
        data_classification: 'internal' as const,
        side_effect: { class: 'safe' as const, approval: 'none' as const },
        task_safe: true,
        mock_safe: true,
        retry: {},
        timeout_ms: 1000,
        budget: {},
        kind: 'plugin' as const,
        pin: pluginPin,
        config: {
          schema_version: 'plugin-binding/1' as const,
          operation_contract_hash: hashA,
          provider_tool_name: 'lookup',
          transport_contract_hash: hashA,
          default_parameters: {},
        },
      },
    ],
    public_capability_handles: [],
    task_templates: [],
    authorization_policy: {},
    runtime_limits: {},
  };
}

function fixture() {
  const source = signedSource();
  const trust = trustedSigners();
  const prepared = prepareInstructionSkillSource(source, trust);
  const document = agentDocument();
  document.instruction_skill_bindings = [
    {
      binding_id: 'procedure',
      skill_pin: structuredClone(prepared.full_pin),
      content_hash: prepared.content_hash,
      activation: 'model_selected',
      allowed_capability_binding_ids: ['plugin'],
      context_budget_tokens: 12,
      priority: 1,
      script_mode: 'inert',
    },
  ];
  const agentSource = {
    schema_version: 'executable-source-candidate/1',
    workspace_id: source.workspace_id,
    document,
  };
  return {
    agent_source: agentSource,
    binding_id: 'procedure',
    source,
    trusted_signers: trust,
    activation: {
      activation_id: 'activation-1',
      trigger: 'strategy',
      max_context_tokens: 8,
      sequence: 0,
    },
  };
}

function firstBinding(input: ReturnType<typeof fixture>) {
  const binding = input.agent_source.document.instruction_skill_bindings[0];
  if (binding === undefined) throw new Error('fixture Skill Binding missing');
  return binding;
}

describe('inert Instruction Skill activation compiler', () => {
  it('replays signed assembly, clips context deterministically and seals an inert activation', () => {
    const input = fixture();
    const result = compileInertInstructionSkillActivation(input);
    expect(result).toMatchObject({
      schema_version: 'inert-instruction-skill-activation/1',
      activation_id: 'activation-1',
      activation_sequence: 0,
      skill_binding_id: 'procedure',
      trigger: 'strategy',
      script_mode: 'inert',
      allowed_capability_binding_ids: ['plugin'],
      context: {
        tokenizer_profile: 'unicode-scalar/1',
        text: '# Proced',
        token_count: 8,
        source_token_count: 52,
        truncated: true,
      },
    });
    expect(result.context.context_hash).toBe(
      canonicalSha256({
        schema_version: 'inert-instruction-skill-context/1',
        tokenizer_profile: 'unicode-scalar/1',
        entry_content_hash: result.entry_content_hash,
        text: '# Proced',
        token_count: 8,
        source_token_count: 52,
        truncated: true,
      }),
    );
    const { activation_hash: _hash, ...preimage } = result;
    expect(result.activation_hash).toBe(canonicalSha256(preimage));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.allowed_capability_binding_ids)).toBe(true);
    expect(compileInertInstructionSkillActivation(input)).toEqual(result);
  });

  it.each([
    ['always', 'strategy'],
    ['model_selected', 'automatic'],
    ['explicit', 'strategy'],
  ] as const)(
    'rejects trigger %s/%s that does not match the sealed binding mode',
    (mode, trigger) => {
      const input = fixture();
      firstBinding(input).activation = mode;
      input.activation.trigger = trigger;
      expect(() => compileInertInstructionSkillActivation(input)).toThrow('ACTIVATION_INVALID');
    },
  );

  it('rejects capability expansion beyond the signed Skill and Agent assembly', () => {
    const input = fixture();
    firstBinding(input).allowed_capability_binding_ids = ['plugin', 'database'];
    expect(() => compileInertInstructionSkillActivation(input)).toThrow('SOURCE_INVALID');
  });

  it('rejects hash drift and explicit script execution requirements', () => {
    const drift = fixture();
    firstBinding(drift).content_hash =
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => compileInertInstructionSkillActivation(drift)).toThrow('SOURCE_INVALID');

    const script = fixture();
    script.source.document.scripts.requires_execution = true;
    resign(script.source);
    expect(() => compileInertInstructionSkillActivation(script)).toThrow(
      'SKILL_SCRIPT_EXECUTION_UNSUPPORTED',
    );
  });

  it('rejects unknown fields, invalid budgets and repeated activation identities', () => {
    const extra = fixture() as ReturnType<typeof fixture> & { execute_script?: boolean };
    extra.execute_script = true;
    expect(() => compileInertInstructionSkillActivation(extra)).toThrow('INPUT_INVALID');

    const over = fixture();
    over.activation.max_context_tokens = 13;
    expect(() => compileInertInstructionSkillActivation(over)).toThrow('ACTIVATION_INVALID');

    const invalidId = fixture();
    invalidId.activation.activation_id = '';
    expect(() => compileInertInstructionSkillActivation(invalidId)).toThrow('INPUT_INVALID');
  });

  it('rejects accessors without executing them', () => {
    const input = fixture();
    const getter = vi.fn(() => input.source);
    Object.defineProperty(input, 'source', { enumerable: true, get: getter });
    expect(() => compileInertInstructionSkillActivation(input)).toThrow('INPUT_INVALID');
    expect(getter).not.toHaveBeenCalled();
  });
});
