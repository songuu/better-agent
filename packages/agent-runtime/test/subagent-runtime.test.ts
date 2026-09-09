import { describe, expect, it } from 'vitest';

import {
  executeParallelSubagents,
  executeRecursiveSubagent,
  type AgentModelRuntime,
  type AgentStrategyProfile,
  type SubagentNode,
} from '../src/index.js';

const leafStrategy: AgentStrategyProfile = {
  forcedCapability: 'none',
  maxInputTokens: 2_000,
  maxIterations: 1,
  maxOutputTokens: 1_000,
  maxToolCalls: 0,
  schemaVersion: 'product-agent-strategy/1',
  temperature: 0.2,
};

function leaf(branch: 1 | 2 | 3, name: string): SubagentNode {
  return {
    agentId: `${String(branch).repeat(8)}-${String(branch).repeat(4)}-4${String(branch).repeat(3)}-8${String(branch).repeat(3)}-${String(branch).repeat(12)}`,
    branch,
    depth: 1,
    instructions: `verify ${name}`,
    maxOutputTokens: 1_000,
    model: 'gpt-5.4-mini',
    name,
    releaseVersion: branch,
    strategyProfile: leafStrategy,
    temperature: 0.2,
  };
}

describe('shared SubAgent runtime', () => {
  it('runs independent root branches concurrently and aggregates exact usage', async () => {
    const started: string[] = [];
    let releaseBoth: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const runtime: AgentModelRuntime = {
      async generate(input) {
        started.push(input.instructions);
        if (started.length === 2) releaseBoth?.();
        await bothStarted;
        const first = input.instructions === 'verify Billing';
        return {
          inputTokens: first ? 3 : 5,
          outputText: first ? 'billing ok' : 'security ok',
          outputTokens: first ? 1 : 2,
          providerRequestId: first ? 'provider-billing' : 'provider-security',
        };
      },
    };
    const receipts: { branch: number; depth: number }[] = [];

    const result = await executeParallelSubagents(
      [[leaf(1, 'Billing')], [leaf(2, 'Security')]],
      'verify release',
      1,
      runtime,
      async (receipt) => {
        receipts.push({ branch: receipt.branch, depth: receipt.depth });
      },
    );

    expect(started).toHaveLength(2);
    expect(result.aggregateInputTokens).toBe(8);
    expect(result.aggregateOutputTokens).toBe(3);
    expect(result.branches.map(({ branch, outputText }) => ({ branch, outputText }))).toEqual([
      { branch: 1, outputText: 'billing ok' },
      { branch: 2, outputText: 'security ok' },
    ]);
    expect(receipts).toEqual([
      { branch: 1, depth: 1 },
      { branch: 2, depth: 1 },
    ]);
  });

  it('rejects cyclic and non-contiguous chains before a provider call', async () => {
    let called = false;
    const runtime: AgentModelRuntime = {
      async generate() {
        called = true;
        throw new Error('must not run');
      },
    };
    const duplicated = leaf(1, 'Duplicated');

    await expect(
      executeRecursiveSubagent(
        [duplicated, { ...duplicated, depth: 3 }],
        'prompt',
        1,
        runtime,
        async () => undefined,
      ),
    ).rejects.toThrow('model_subagent_chain_invalid');
    expect(called).toBe(false);
  });
});
