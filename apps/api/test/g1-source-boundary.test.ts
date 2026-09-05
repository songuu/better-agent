import {
  prepareAgentStrategySource,
  prepareG1PublishedSourceStorage,
} from '@better-agent/release-core';
import { describe, expect, it, vi } from 'vitest';

import { createG1SourceBoundary, G1SourceBoundaryError } from '../src/modules/releases/index.js';
import type { G1SourceDatabaseTransaction } from '../src/modules/releases/g1-source-boundary.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const strategyId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const strategyReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const publicationAttestation = Object.freeze({
  attestationId: '018f47f2-c541-7cc6-9292-4a2c35303e03',
  verifierHex: 'ab'.repeat(32),
});
const hashA = `sha256:${'a'.repeat(64)}` as const;

function strategyDocument() {
  return {
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
  };
}

function preparedStrategy() {
  return prepareAgentStrategySource({
    schema_version: 'agent-strategy-source-candidate/1',
    workspace_id: workspaceId,
    document: strategyDocument(),
  });
}

function createTransaction(
  overrides: Partial<G1SourceDatabaseTransaction> = {},
): G1SourceDatabaseTransaction {
  const strategy = preparedStrategy();
  const storage = prepareG1PublishedSourceStorage(strategy, [], null);
  return {
    loadRegisteredDependencyPins: vi.fn(async () => []),
    loadTrustedInstructionSigners: vi.fn(async () => ({
      schema_version: 'trusted-instruction-signers/1',
      signers: [],
    })),
    publishAgentStrategySource: vi.fn(async () => strategyReleaseId),
    publishInstructionSkillSource: vi.fn(async (source) => source.full_pin.resource_version_id),
    publishKnowledgeIndexGeneration: vi.fn(async (source) => source.full_pin.resource_version_id),
    publishDatabaseOperationRelease: vi.fn(async (source) => source.full_pin.resource_version_id),
    publishPluginToolRelease: vi.fn(async (source) => source.full_pin.resource_version_id),
    publishA2aAgentRelease: vi.fn(async (source) => source.full_pin.resource_version_id),
    publishSkillPackRelease: vi.fn(async (source) => source.full_pin.resource_version_id),
    loadPublishedG1Source: vi.fn(async () => storage),
    ...overrides,
  };
}

function createBoundary(transaction: G1SourceDatabaseTransaction) {
  const withTransaction = vi.fn(
    async (callback: (scoped: G1SourceDatabaseTransaction) => Promise<unknown>) =>
      callback(transaction),
  ) as unknown as {
    <T>(callback: (scoped: G1SourceDatabaseTransaction) => Promise<T>): Promise<T>;
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  return { boundary: createG1SourceBoundary({ withTransaction }), withTransaction };
}

describe('G1 authoritative source API boundary', () => {
  it('fixes the source kind, persists canonical storage and returns only an identity receipt', async () => {
    const calls: string[] = [];
    const transaction = createTransaction({
      loadRegisteredDependencyPins: vi.fn(async () => {
        calls.push('registry');
        return [];
      }),
      publishAgentStrategySource: vi.fn(async () => {
        calls.push('publish');
        return strategyReleaseId;
      }),
    });
    const { boundary } = createBoundary(transaction);

    const receipt = await boundary.publishAgentStrategySource({
      workspaceId,
      document: strategyDocument(),
      publicationAttestation,
    });

    expect(calls).toEqual(['registry', 'publish']);
    expect(transaction.loadRegisteredDependencyPins).toHaveBeenCalledWith(workspaceId, []);
    expect(transaction.publishAgentStrategySource).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: 'prepared-g1-published-source-storage/1',
        full_pin: expect.objectContaining({
          published_resource_kind: 'AGENT_STRATEGY_RELEASE',
          resource_version_id: strategyReleaseId,
        }),
        canonical_source_artifact: expect.any(String),
      }),
      publicationAttestation,
    );
    expect(receipt).toEqual({
      schema_version: 'g1-published-source-receipt/1',
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      resource_id: strategyId,
      resource_version_id: strategyReleaseId,
      contract_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      dependency_manifest_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(receipt).not.toHaveProperty('canonical_source_artifact');
    expect(transaction.loadTrustedInstructionSigners).not.toHaveBeenCalled();
  });

  it('snapshots caller data before the first authority await', async () => {
    let releaseRegistry: ((value: readonly unknown[]) => void) | undefined;
    const registry = new Promise<readonly unknown[]>((resolve) => {
      releaseRegistry = resolve;
    });
    const transaction = createTransaction({
      loadRegisteredDependencyPins: vi.fn(async () => registry),
    });
    const { boundary } = createBoundary(transaction);
    const document = strategyDocument();
    const mutableAttestation = structuredClone(publicationAttestation);

    const pending = boundary.publishAgentStrategySource({
      workspaceId,
      document,
      publicationAttestation: mutableAttestation,
    });
    document.strategy_release_id = '018f47f2-c541-7cc6-9292-4a2c35303eff';
    (mutableAttestation as { verifierHex: string }).verifierHex = 'cd'.repeat(32);
    releaseRegistry?.([]);
    const receipt = await pending;

    expect(receipt.resource_version_id).toBe(strategyReleaseId);
    expect(transaction.publishAgentStrategySource).toHaveBeenCalledWith(
      expect.objectContaining({
        full_pin: expect.objectContaining({ resource_version_id: strategyReleaseId }),
      }),
      publicationAttestation,
    );
  });

  it('reloads authority and independently replays canonical storage on readback', async () => {
    const transaction = createTransaction();
    const { boundary } = createBoundary(transaction);
    const expected = preparedStrategy();

    const actual = await boundary.loadPublishedSource({
      workspaceId,
      pin: expected.full_pin,
    });

    expect(actual).toEqual(expected);
    expect(transaction.loadRegisteredDependencyPins).toHaveBeenCalledWith(workspaceId, []);
    expect(transaction.loadPublishedG1Source).toHaveBeenCalledWith(expected.full_pin);
    expect(transaction.loadTrustedInstructionSigners).not.toHaveBeenCalled();
  });

  it('snapshots loaded storage before awaiting its exact dependency registry', async () => {
    let releaseRegistry: ((value: readonly unknown[]) => void) | undefined;
    const registry = new Promise<readonly unknown[]>((resolve) => {
      releaseRegistry = resolve;
    });
    const strategy = preparedStrategy();
    const storage = structuredClone(prepareG1PublishedSourceStorage(strategy, [], null));
    const transaction = createTransaction({
      loadRegisteredDependencyPins: vi.fn(async () => registry),
      loadPublishedG1Source: vi.fn(async () => storage),
    });
    const { boundary } = createBoundary(transaction);

    const pending = boundary.loadPublishedSource({ workspaceId, pin: strategy.full_pin });
    await vi.waitFor(() => expect(transaction.loadRegisteredDependencyPins).toHaveBeenCalled());
    (storage as { canonical_document: string }).canonical_document = '{}';
    releaseRegistry?.([]);

    await expect(pending).resolves.toEqual(strategy);
  });

  it('rejects caller authority before opening a transaction', async () => {
    const transaction = createTransaction();
    const { boundary, withTransaction } = createBoundary(transaction);
    const input = { workspaceId, document: strategyDocument(), publicationAttestation };

    for (const invalid of [
      { ...input, registeredDependencyPins: [] },
      { ...input, trustedInstructionSigners: {} },
      { ...input, transaction },
      { ...input, publicationAttestation: { ...publicationAttestation, extra: true } },
    ]) {
      await expect(boundary.publishAgentStrategySource(invalid)).rejects.toEqual(
        expect.objectContaining({ code: 'G1_SOURCE_BOUNDARY_INPUT_INVALID' }),
      );
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('loads Instruction Skill trust from the transaction and never publishes invalid source', async () => {
    const calls: string[] = [];
    const transaction = createTransaction({
      loadRegisteredDependencyPins: vi.fn(async () => {
        calls.push('registry');
        return [];
      }),
      loadTrustedInstructionSigners: vi.fn(async () => {
        calls.push('trust');
        return { schema_version: 'trusted-instruction-signers/1', signers: [] };
      }),
    });
    const { boundary } = createBoundary(transaction);

    await expect(
      boundary.publishInstructionSkillSource({
        workspaceId,
        document: {},
        files: [],
        publicationAttestation,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'G1_SOURCE_PREPARATION_REJECTED' }));
    expect(calls).toEqual(['trust']);
    expect(transaction.loadRegisteredDependencyPins).not.toHaveBeenCalled();
    expect(transaction.publishInstructionSkillSource).not.toHaveBeenCalled();
  });

  it('does not accept a valid source document through a different fixed-kind publisher', async () => {
    const transaction = createTransaction();
    const { boundary } = createBoundary(transaction);

    await expect(
      boundary.publishPluginToolRelease({
        workspaceId,
        document: strategyDocument(),
        publicationAttestation,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'G1_SOURCE_PREPARATION_REJECTED' }));
    expect(transaction.publishPluginToolRelease).not.toHaveBeenCalled();
  });

  it('rejects mismatched receipts and corrupted readback without leaking infrastructure details', async () => {
    const marker = 'database-secret-must-not-leak';
    const mismatched = createBoundary(
      createTransaction({
        publishAgentStrategySource: vi.fn(async () => '018f47f2-c541-7cc6-9292-4a2c35303eff'),
      }),
    );
    await expect(
      mismatched.boundary.publishAgentStrategySource({
        workspaceId,
        document: strategyDocument(),
        publicationAttestation,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'G1_SOURCE_PERSISTENCE_FAILED' }));

    const corrupted = createBoundary(
      createTransaction({
        loadPublishedG1Source: vi.fn(async () => {
          throw new Error(marker);
        }),
      }),
    );
    try {
      await corrupted.boundary.loadPublishedSource({
        workspaceId,
        pin: preparedStrategy().full_pin,
      });
      expect.unreachable('corrupted readback should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(G1SourceBoundaryError);
      expect(error).toEqual(expect.objectContaining({ code: 'G1_SOURCE_READBACK_REJECTED' }));
      expect(String(error)).not.toContain(marker);
    }
  });
});
