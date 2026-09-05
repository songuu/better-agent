import { describe, expect, it } from 'vitest';

import { canonicalJsonBytes } from '../src/canonical-json.js';
import {
  prepareG1PublishedSourceStorage,
  verifyG1PublishedSourceStorage,
} from '../src/g1-published-source.js';
import { prepareAgentStrategySource } from '../src/agent-strategy-source.js';
import { prepareInstructionSkillSource } from '../src/instruction-skill-source.js';
import { prepareLeafResourceSource } from '../src/leaf-resource-source.js';
import { prepareSkillPackSource } from '../src/skill-pack-source.js';
import { hashA, strategyId, strategyReleaseId, workspaceId } from './fixtures.js';
import {
  signedSource as instructionSource,
  trustedSigners,
} from './instruction-skill-source-fixtures.js';
import { leafCandidate, leafKinds } from './leaf-resource-source-fixtures.js';
import { skillPackSource } from './skill-pack-source-fixtures.js';

function strategySource() {
  return {
    schema_version: 'agent-strategy-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'agent-strategy-source/1',
      strategy_id: strategyId,
      strategy_release_id: strategyReleaseId,
      abi_version: 'agent-strategy-abi/1',
      implementation_digest: hashA,
      config: { planning: { mode: 'react' } },
      config_schema: { type: 'object' },
      input_schema: { type: 'object' },
      state_schema: { type: 'object' },
      decision_schema: { type: 'object' },
      observation_schema: { type: 'object' },
      sandbox_profile: {
        schema_version: 'strategy-sandbox-profile/1',
        profile_id: 'isolated-strategy/1',
        host_abi: 'agent-strategy-abi/1',
        network: 'deny',
        filesystem: 'deny',
        database: 'deny',
        secrets: 'deny',
        maximum_memory_bytes: 67_108_864,
        maximum_instruction_count: 1_000_000,
      },
      allowed_model_policy: {
        schema_version: 'strategy-model-policy/1',
        models: [
          {
            descriptor_id: 'primary',
            provider_id: 'provider',
            model_id: 'chat',
            model_revision: '2026-01',
            model_contract_hash: hashA,
          },
        ],
        maximum_input_tokens: 32_768,
        maximum_output_tokens: 4_096,
      },
      allowed_capability_binding_ids: [],
      allowed_gate_spec_ids: [],
      max_iterations: 10,
      max_model_attempts: 5,
      max_tool_calls: 5,
    },
  };
}

function fixtures() {
  const strategy = prepareAgentStrategySource(strategySource());
  const instruction = prepareInstructionSkillSource(instructionSource(), trustedSigners());
  const leaves = leafKinds.map((kind) => prepareLeafResourceSource(leafCandidate(kind)));
  const pack = prepareSkillPackSource(skillPackSource());
  return [strategy, instruction, ...leaves, pack];
}

function trustFor(source: ReturnType<typeof fixtures>[number]) {
  return source.schema_version === 'prepared-instruction-skill-source/1' ? trustedSigners() : null;
}

describe('G1 typed source registry storage', () => {
  it('round-trips all seven supported source kinds from exact canonical bytes', () => {
    for (const source of fixtures()) {
      const storage = prepareG1PublishedSourceStorage(
        source,
        source.dependency_manifest.dependencies,
        trustFor(source),
      );
      const verified = verifyG1PublishedSourceStorage(
        source.full_pin,
        storage,
        source.dependency_manifest.dependencies,
        trustFor(source),
      );
      expect(verified).toEqual(source);
      expect(JSON.parse(storage.canonical_source_artifact)).toEqual(source);
      expect(Object.isFrozen(storage)).toBe(true);
    }
  });

  it('requires every exact dependency in the independently supplied registry snapshot', () => {
    const source = prepareSkillPackSource(skillPackSource());
    expect(() => prepareG1PublishedSourceStorage(source, [], null)).toThrow(
      'G1_PUBLISHED_SOURCE_DEPENDENCY_UNREGISTERED',
    );
  });

  it('requires the independently supplied Instruction Skill trust root', () => {
    const source = prepareInstructionSkillSource(instructionSource(), trustedSigners());
    expect(() =>
      prepareG1PublishedSourceStorage(source, source.dependency_manifest.dependencies, null),
    ).toThrow('G1_PUBLISHED_SOURCE_TRUST_REQUIRED');
    const wrongTrust = trustedSigners();
    const [wrongSigner] = wrongTrust.signers;
    if (wrongSigner === undefined) throw new Error('trusted signer fixture is empty');
    wrongSigner.source_id = 'different-source';
    expect(() =>
      prepareG1PublishedSourceStorage(source, source.dependency_manifest.dependencies, wrongTrust),
    ).toThrow();
  });

  it.each(['pin', 'document', 'preimage', 'artifact', 'manifest', 'bytes', 'unknown'] as const)(
    'rejects independently corrupted %s storage',
    (mutation) => {
      const source = prepareLeafResourceSource(leafCandidate('PLUGIN_TOOL_RELEASE'));
      const storage = prepareG1PublishedSourceStorage(source, [], null);
      const changed = structuredClone(storage) as unknown as Record<string, unknown>;
      if (mutation === 'pin') {
        const pin = changed.full_pin as Record<string, unknown>;
        pin.contract_hash = hashA;
      }
      if (mutation === 'document') changed.canonical_document = '{}';
      if (mutation === 'preimage') changed.canonical_source_preimage = '{}';
      if (mutation === 'artifact') {
        const artifact = JSON.parse(String(changed.canonical_source_artifact));
        artifact.component_hashes.manual = hashA;
        changed.canonical_source_artifact = canonicalJsonBytes(artifact).toString('utf8');
      }
      if (mutation === 'manifest') {
        const manifest = changed.dependency_manifest as Record<string, unknown>;
        manifest.manifest_hash = hashA;
      }
      if (mutation === 'bytes') {
        changed.canonical_source_artifact = `${changed.canonical_source_artifact} `;
      }
      if (mutation === 'unknown') changed.extra = true;
      expect(() => verifyG1PublishedSourceStorage(source.full_pin, changed, [], null)).toThrow();
    },
  );

  it('rejects unsupported prepared artifacts without an opaque fallback', () => {
    const [example] = fixtures();
    if (example === undefined) throw new Error('G1 source fixture set is empty');
    expect(() =>
      prepareG1PublishedSourceStorage(
        {
          schema_version: 'prepared-future-source/1',
          full_pin: example.full_pin,
          dependency_manifest: example.dependency_manifest,
        },
        [],
        null,
      ),
    ).toThrow('G1_PUBLISHED_SOURCE_UNSUPPORTED');
  });
});
