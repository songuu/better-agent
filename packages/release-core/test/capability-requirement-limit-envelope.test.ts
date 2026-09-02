import { describe, expect, it } from 'vitest';

import {
  compileCapabilityRequirementLimitEnvelope as compile,
  resolveEffectiveCapabilityPolicy,
  verifyCapabilityRequirementLimitEnvelope as verify,
} from '../src/index.js';
import { ceiling, requirements } from './policy-fixtures.js';

interface LimitOverrides {
  readonly calls?: number;
  readonly depth?: number;
  readonly parallelism?: number;
  readonly amountCredits?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly durationMs?: number;
}

function demand(overrides: LimitOverrides = {}) {
  const value = requirements();
  value.minimum_limits = {
    calls: overrides.calls ?? 1,
    depth: overrides.depth ?? 0,
    parallelism: overrides.parallelism ?? 1,
    budget: {
      schema_version: 'capability-budget/1',
      amount_credits: overrides.amountCredits ?? '1',
      input_tokens: overrides.inputTokens ?? 1,
      output_tokens: overrides.outputTokens ?? 1,
      total_tokens: overrides.totalTokens ?? 2,
      duration_ms: overrides.durationMs ?? 1,
    },
  };
  return value;
}

function leaf(overrides: LimitOverrides = {}) {
  return {
    schema_version: 'capability-requirement-expression/1',
    expression_kind: 'leaf',
    requirements: demand(overrides),
  };
}

function group(expressionKind: 'sequence' | 'parallel' | 'alternative', children: unknown[]) {
  return {
    schema_version: 'capability-requirement-expression/1',
    expression_kind: expressionKind,
    children,
  };
}

describe('capability requirement limit envelope', () => {
  const first = leaf({
    calls: 2,
    depth: 3,
    parallelism: 2,
    amountCredits: '3',
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 12,
    durationMs: 11,
  });
  const second = leaf({
    calls: 4,
    depth: 1,
    parallelism: 5,
    amountCredits: '7',
    inputTokens: 11,
    outputTokens: 13,
    totalTokens: 24,
    durationMs: 17,
  });

  it('raises a leaf total-token demand to its simultaneous input/output floor', () => {
    expect(
      compile(leaf({ inputTokens: 8, outputTokens: 5, totalTokens: 1 })).budget.total_tokens,
    ).toBe(13);
  });

  it('sums sequential work while retaining maximum depth and parallelism', () => {
    expect(compile(group('sequence', [first, second]))).toEqual({
      calls: 6,
      depth: 3,
      parallelism: 5,
      budget: {
        schema_version: 'capability-budget/1',
        amount_credits: '10',
        input_tokens: 16,
        output_tokens: 20,
        total_tokens: 36,
        duration_ms: 28,
      },
    });
  });

  it('sums parallel capacity but uses the longest concurrent duration', () => {
    expect(compile(group('parallel', [first, second]))).toEqual({
      calls: 6,
      depth: 3,
      parallelism: 7,
      budget: {
        schema_version: 'capability-budget/1',
        amount_credits: '10',
        input_tokens: 16,
        output_tokens: 20,
        total_tokens: 36,
        duration_ms: 17,
      },
    });
  });

  it('builds the least flat envelope that can admit every alternative branch', () => {
    const inputHeavy = leaf({ inputTokens: 10, outputTokens: 0, totalTokens: 10 });
    const outputHeavy = leaf({ inputTokens: 0, outputTokens: 20, totalTokens: 20 });
    const result = compile(group('alternative', [inputHeavy, outputHeavy]));
    expect(result.budget).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    });
    expect(result.calls).toBe(1);
  });

  it('multiplies repeated consumables without multiplying stack depth or concurrency', () => {
    expect(
      compile({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'repeat',
        max_iterations: 3,
        child: first,
      }),
    ).toEqual({
      calls: 6,
      depth: 3,
      parallelism: 2,
      budget: {
        schema_version: 'capability-budget/1',
        amount_credits: '9',
        input_tokens: 15,
        output_tokens: 21,
        total_tokens: 36,
        duration_ms: 33,
      },
    });
  });

  it('adds an explicit nested invocation and increments the child stack depth', () => {
    const invocation = demand({
      calls: 1,
      depth: 0,
      parallelism: 1,
      amountCredits: '2',
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
      durationMs: 7,
    });
    expect(
      compile({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'nested_call',
        invocation,
        child: second,
      }),
    ).toEqual({
      calls: 5,
      depth: 2,
      parallelism: 5,
      budget: {
        schema_version: 'capability-budget/1',
        amount_credits: '9',
        input_tokens: 14,
        output_tokens: 18,
        total_tokens: 32,
        duration_ms: 24,
      },
    });
  });

  it('is permutation-stable for alternatives and returns detached frozen data', () => {
    const input = group('alternative', [first, second]);
    const before = structuredClone(input);
    const result = compile(input);
    expect(input).toEqual(before);
    expect(result).toEqual(compile(group('alternative', [second, first])));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.budget)).toBe(true);
  });

  it('fails closed on safe-integer addition and multiplication overflow', () => {
    expect(() =>
      compile(group('sequence', [leaf({ calls: Number.MAX_SAFE_INTEGER }), leaf({ calls: 1 })])),
    ).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
    expect(() =>
      compile({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'repeat',
        max_iterations: 2,
        child: leaf({ durationMs: Number.MAX_SAFE_INTEGER }),
      }),
    ).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
  });

  it('fails closed on PostgreSQL bigint credit overflow', () => {
    expect(() =>
      compile(
        group('sequence', [
          leaf({ amountCredits: '9223372036854775807' }),
          leaf({ amountCredits: '1' }),
        ]),
      ),
    ).toThrow('CLOSURE_POLICY_LIMIT_EXCEEDED');
  });

  it('accepts an envelope when every axis fits the effective policy', () => {
    const policy = resolveEffectiveCapabilityPolicy(ceiling(), requirements());
    const expression = leaf({ calls: 2, inputTokens: 4, outputTokens: 5, totalTokens: 9 });
    expect(verify(expression, policy)).toEqual(compile(expression));
  });

  it.each([
    [
      'calls',
      leaf({ calls: 2 }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        max_calls: 1,
      }),
    ],
    [
      'depth',
      leaf({ depth: 2 }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        max_depth: 1,
      }),
    ],
    [
      'parallelism',
      leaf({ parallelism: 2 }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        max_parallelism: 1,
      }),
    ],
    [
      'amount credits',
      leaf({ amountCredits: '2' }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        budget: { ...policy.budget, amount_credits: '1' },
      }),
    ],
    [
      'input tokens',
      leaf({ inputTokens: 2 }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        budget: { ...policy.budget, input_tokens: 1 },
      }),
    ],
    [
      'output tokens',
      leaf({ outputTokens: 2 }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        budget: { ...policy.budget, output_tokens: 1 },
      }),
    ],
    [
      'total tokens',
      leaf({ inputTokens: 2, outputTokens: 2, totalTokens: 4 }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        budget: { ...policy.budget, total_tokens: 3 },
      }),
    ],
    [
      'duration',
      leaf({ durationMs: 2 }),
      (policy: ReturnType<typeof resolveEffectiveCapabilityPolicy>) => ({
        ...policy,
        budget: { ...policy.budget, duration_ms: 1 },
      }),
    ],
  ] as const)('rejects an under-provisioned %s axis', (_axis, expression, underProvision) => {
    const policy = resolveEffectiveCapabilityPolicy(ceiling(), requirements());
    expect(() => verify(expression, underProvision(policy))).toThrow(
      'CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE',
    );
  });
});
