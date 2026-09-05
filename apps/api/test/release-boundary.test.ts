import { canonicalSha256ExcludingRootKeys } from '@better-agent/release-core';
import { describe, expect, it, vi } from 'vitest';

import { createReleaseBoundary, ReleaseBoundaryError } from '../src/modules/releases/index.js';
import type { ReleaseDatabaseTransaction } from '../src/modules/releases/release-boundary.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const strategyId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const strategyReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const hashA = `sha256:${'a'.repeat(64)}` as const;

function makeStrategyRelease() {
  const candidate = {
    schema_version: 'agent-strategy-release/1',
    strategy_id: strategyId,
    strategy_release_id: strategyReleaseId,
    source_draft_revision_id: '018f47f2-c541-7cc6-9292-4a2c35303e03',
    abi_version: 'agent-strategy-abi/1',
    implementation_digest: hashA,
    config_hash: hashA,
    input_schema_hash: hashA,
    state_schema_hash: hashA,
    decision_schema_hash: hashA,
    observation_schema_hash: hashA,
    sandbox_profile_id: 'sandbox-default',
    allowed_model_policy_hash: hashA,
    allowed_capability_binding_ids: [],
    allowed_gate_spec_ids: [],
    max_iterations: 4,
    max_model_attempts: 2,
    max_tool_calls: 2,
    contract_hash: hashA,
  } as const;
  return {
    ...candidate,
    contract_hash: canonicalSha256ExcludingRootKeys(candidate, ['contract_hash']),
  };
}

function createTransaction(
  overrides: Partial<ReleaseDatabaseTransaction> = {},
): ReleaseDatabaseTransaction {
  return {
    loadRegisteredDependencyPins: vi.fn(async () => []),
    publishAgentStrategyRelease: vi.fn(async () => strategyReleaseId),
    publishAgentRelease: vi.fn(async (prepared) => prepared.full_pin.resource_version_id),
    publishFlowVersion: vi.fn(async (prepared) => prepared.full_pin.resource_version_id),
    publishExperienceRelease: vi.fn(async (prepared) => prepared.full_pin.resource_version_id),
    publishAgentDeploymentRevision: vi.fn(
      async (prepared) => prepared.full_pin.resource_version_id,
    ),
    publishFlowDeploymentRevision: vi.fn(async (prepared) => prepared.full_pin.resource_version_id),
    ...overrides,
  };
}

function createBoundary(transaction: ReleaseDatabaseTransaction) {
  const withTransaction = vi.fn(
    async (callback: (scopedTransaction: ReleaseDatabaseTransaction) => Promise<unknown>) =>
      callback(transaction),
  ) as unknown as {
    <T>(callback: (scopedTransaction: ReleaseDatabaseTransaction) => Promise<T>): Promise<T>;
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  return {
    boundary: createReleaseBoundary({ withTransaction }),
    withTransaction,
  };
}

describe('G0-05 Release API composition boundary', () => {
  it('fixes the publisher kind, persists only a prepared command and returns a safe receipt', async () => {
    const calls: string[] = [];
    const transaction = createTransaction({
      loadRegisteredDependencyPins: vi.fn(async () => {
        calls.push('load');
        return [];
      }),
      publishAgentStrategyRelease: vi.fn(async () => {
        calls.push('publish');
        return strategyReleaseId;
      }),
    });
    const { boundary, withTransaction } = createBoundary(transaction);
    const result = await boundary.publishAgentStrategyRelease({
      workspaceId,
      document: makeStrategyRelease(),
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['load', 'publish']);
    expect(transaction.loadRegisteredDependencyPins).toHaveBeenCalledTimes(1);
    expect(transaction.loadRegisteredDependencyPins).toHaveBeenCalledWith(workspaceId);
    expect(transaction.publishAgentStrategyRelease).toHaveBeenCalledTimes(1);
    expect(transaction.publishAgentStrategyRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: 'prepared-published-resource/1',
        full_pin: expect.objectContaining({
          published_resource_kind: 'AGENT_STRATEGY_RELEASE',
          resource_id: strategyId,
          resource_version_id: strategyReleaseId,
        }),
      }),
    );
    expect(result).toEqual({
      schema_version: 'published-resource-receipt/1',
      published_resource_kind: 'AGENT_STRATEGY_RELEASE',
      resource_id: strategyId,
      resource_version_id: strategyReleaseId,
      contract_hash: makeStrategyRelease().contract_hash,
      dependency_manifest_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(result).not.toHaveProperty('canonical_document');
  });

  it('rejects caller-supplied pins and transaction before opening a transaction', async () => {
    const transaction = createTransaction({
      publishAgentStrategyRelease: vi.fn(async () => '018f47f2-c541-7cc6-9292-4a2c35303eff'),
    });
    const { boundary, withTransaction } = createBoundary(transaction);
    const validInput = {
      workspaceId,
      document: makeStrategyRelease(),
    };

    for (const invalidInput of [
      { ...validInput, registeredDependencyPins: [] },
      { ...validInput, transaction },
    ]) {
      await expect(boundary.publishAgentStrategyRelease(invalidInput)).rejects.toEqual(
        expect.objectContaining({ code: 'RELEASE_BOUNDARY_INPUT_INVALID' }),
      );
    }
    expect(withTransaction).not.toHaveBeenCalled();
    expect(transaction.loadRegisteredDependencyPins).not.toHaveBeenCalled();
    expect(transaction.publishAgentStrategyRelease).not.toHaveBeenCalled();
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
    const document = makeStrategyRelease();

    const pending = boundary.publishAgentStrategyRelease({ workspaceId, document });
    (document as { strategy_release_id: string }).strategy_release_id =
      '018f47f2-c541-7cc6-9292-4a2c35303eff';
    releaseRegistry?.([]);
    const receipt = await pending;

    expect(receipt.resource_version_id).toBe(strategyReleaseId);
    expect(transaction.publishAgentStrategyRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        full_pin: expect.objectContaining({ resource_version_id: strategyReleaseId }),
      }),
    );
  });

  it('rejects a mismatched database receipt', async () => {
    const transaction = createTransaction({
      publishAgentStrategyRelease: vi.fn(async () => '018f47f2-c541-7cc6-9292-4a2c35303eff'),
    });
    const { boundary } = createBoundary(transaction);

    await expect(
      boundary.publishAgentStrategyRelease({
        workspaceId,
        document: makeStrategyRelease(),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RELEASE_PERSISTENCE_FAILED' }));
  });

  it('normalizes loader and publisher failures without echoing infrastructure details', async () => {
    const marker = 'candidate-secret-must-not-leak';
    const loaderTransaction = createTransaction({
      loadRegisteredDependencyPins: vi.fn(async () => {
        throw new Error(`loader leaked ${marker}`);
      }),
    });
    const loaderFixture = createBoundary(loaderTransaction);
    await expect(
      loaderFixture.boundary.publishAgentStrategyRelease({
        workspaceId,
        document: makeStrategyRelease(),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RELEASE_PERSISTENCE_FAILED' }));
    expect(loaderTransaction.publishAgentStrategyRelease).not.toHaveBeenCalled();

    const publisherTransaction = createTransaction({
      publishAgentStrategyRelease: vi.fn(async () => {
        throw new Error(`database leaked ${marker}`);
      }),
    });
    const { boundary } = createBoundary(publisherTransaction);
    try {
      await boundary.publishAgentStrategyRelease({
        workspaceId,
        document: makeStrategyRelease(),
      });
      expect.unreachable('database failure should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseBoundaryError);
      expect(String(error)).not.toContain(marker);
    }
  });

  it('loads authority first and closes preparation failures before publisher invocation', async () => {
    const transaction = createTransaction();
    const { boundary, withTransaction } = createBoundary(transaction);
    await expect(
      boundary.publishFlowVersion({
        workspaceId,
        document: { secret: 'candidate-secret-must-not-leak' },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RELEASE_PREPARATION_REJECTED' }));
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.loadRegisteredDependencyPins).toHaveBeenCalledTimes(1);
    expect(transaction.publishFlowVersion).not.toHaveBeenCalled();
  });

  it('keeps Agent Release and Deployment Revision publication paused', async () => {
    const transaction = createTransaction();
    const { boundary } = createBoundary(transaction);

    await expect(boundary.publishAgentRelease({ workspaceId, document: {} })).rejects.toEqual(
      expect.objectContaining({ code: 'RELEASE_PREPARATION_REJECTED' }),
    );
    await expect(
      boundary.publishAgentDeploymentRevision({ workspaceId, document: {} }),
    ).rejects.toEqual(expect.objectContaining({ code: 'RELEASE_PREPARATION_REJECTED' }));
    expect(transaction.publishAgentRelease).not.toHaveBeenCalled();
    expect(transaction.publishAgentDeploymentRevision).not.toHaveBeenCalled();
  });
});
