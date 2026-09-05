import { describe, expect, it, vi } from 'vitest';

import { createProductionEvaluationPostgres } from '../src/modules/releases/index.js';
import type { G1SourceSqlQueryClient } from '../src/modules/releases/g1-source-postgres-readback.js';

const id = (tail: string) => `018f47f2-c541-7cc6-9292-${tail.padStart(12, '0')}`;
const hash = (value: string) => `sha256:${value.repeat(64)}`;

const draft = {
  schema_version: 'evaluation-suite-release/1' as const,
  workspace_id: id('1'),
  evaluation_suite_release_id: id('2'),
  dataset_release_id: id('3'),
  dataset_hash: hash('a'),
  evaluator_pins: [
    { evaluator_id: 'safety', evaluator_release_id: 'v1', contract_hash: hash('b') },
  ],
  policy: {
    schema_version: 'production-evaluation-policy/1' as const,
    minimum_pass_rate_ppm: 900_000,
    minimum_safety_rate_ppm: 1_000_000,
    maximum_cost_micredits: 1_000,
    maximum_p95_latency_ms: 1_000,
    minimum_case_count: 1,
  },
};

function queryClient(rows: readonly unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  return { query } as unknown as G1SourceSqlQueryClient;
}

describe('production evaluation PostgreSQL adapter', () => {
  it('prepares the suite locally and registers it with fixed parameterized SQL', async () => {
    const client = queryClient([
      { evaluation_suite_release_id: draft.evaluation_suite_release_id },
    ]);
    const adapter = createProductionEvaluationPostgres(client);

    const suite = await adapter.registerSuite(draft);

    expect(suite.suite_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT app.register_evaluation_suite_release($1::jsonb) AS evaluation_suite_release_id',
      [JSON.stringify(suite)],
    );
  });

  it('rejects a malformed database receipt without exposing its contents', async () => {
    const adapter = createProductionEvaluationPostgres(
      queryClient([{ evaluation_suite_release_id: id('9'), secret: 'x' }]),
    );
    await expect(adapter.registerSuite(draft)).rejects.toThrow(
      'production evaluation SQL returned an invalid receipt',
    );
  });

  it('rejects malformed input before querying', async () => {
    const client = queryClient([]);
    const adapter = createProductionEvaluationPostgres(client);
    await expect(
      adapter.transitionDecision(id('1'), id('2'), 0, 'APPROVED', 'reviewed'),
    ).rejects.toThrow('production evaluation SQL rejected the input');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('uses fixed CAS calls for reviewer transition and control consumption', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ decision_version: '2' }] })
      .mockResolvedValueOnce({ rows: [{ activation_epoch: '1' }] });
    const adapter = createProductionEvaluationPostgres({ query } as G1SourceSqlQueryClient);

    await expect(
      adapter.transitionDecision(id('1'), id('2'), 1, 'APPROVED', 'reviewed'),
    ).resolves.toBe(2);
    await expect(adapter.consumeDecision(id('2'), 2, 'promote')).resolves.toBe(1);
    expect(query.mock.calls[0]?.[0]).toContain('app.transition_production_promotion_decision');
    expect(query.mock.calls[1]?.[0]).toContain('app.consume_production_promotion_decision');
  });
});
