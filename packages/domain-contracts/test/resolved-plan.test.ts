import { describe, expect, it } from 'vitest';
import {
  CanonicalAuthorizationEpochSourcesV1Schema,
  ForcedExecutionV1Schema,
  ResolvedExecutionPlanV1Schema,
} from '../src/index.js';

const hash = `sha256:${'a'.repeat(64)}`;
const path = `bp1.${'a'.repeat(43)}`;
const call = {
  order: 0,
  output_injection: 'before_role_context',
  on_empty: 'fail_closed',
  on_timeout: 'fail_closed',
  on_authorization_denied: 'fail_closed',
} as const;
const plan = {
  schema_version: 'resolved-execution-plan/1',
  plan_kind: 'flow',
  workspace_id: 'workspace',
  deployment_revision_id: 'revision',
  deployment_revision_contract_hash: hash,
  root_release: {
    workspace_id: 'workspace',
    published_resource_kind: 'FLOW_VERSION',
    resource_id: 'flow',
    resource_version_id: 'version',
    contract_hash: hash,
    binding_mode: 'pinned',
  },
  flow_deployment_id: 'deployment',
  flow_version_id: 'version',
  capability_closure_hash: hash,
  admission_snapshot_hash: hash,
  admission_activation_epoch: 1,
  observed_revoke_epoch: 1,
  authorization_decision_id: 'decision',
  authorization_decision_hash: hash,
  authorization_epoch_vector_hash: hash,
  authorization_expires_at: '2099-01-01T00:00:00.000Z',
  enabled_bindings: [],
  disabled_binding_paths: [],
  required_binding_paths: [],
  required_calls: [],
  plan_hash: hash,
};

describe('closed typed admission contracts', () => {
  it('requires an exact GateSpec pin only for ask_user dispositions', () => {
    expect(ForcedExecutionV1Schema.safeParse(call).success).toBe(true);
    expect(ForcedExecutionV1Schema.safeParse({ ...call, on_empty: 'ask_user' }).success).toBe(
      false,
    );
    const gate = { gate_spec_id: 'input', gate_spec_hash: hash };
    expect(
      ForcedExecutionV1Schema.safeParse({ ...call, on_empty: 'ask_user', on_empty_gate_spec: gate })
        .success,
    ).toBe(true);
    expect(ForcedExecutionV1Schema.safeParse({ ...call, on_empty_gate_spec: gate }).success).toBe(
      false,
    );
    expect(ForcedExecutionV1Schema.safeParse({ ...call, future_field: true }).success).toBe(false);
  });

  it('keeps epoch identities unique, closed and in canonical order', () => {
    const first = {
      source_kind: 'credential',
      source_id: 'a',
      source_subkey: '',
      observed_epoch: 1,
    };
    const second = { ...first, source_id: 'b' };
    expect(CanonicalAuthorizationEpochSourcesV1Schema.safeParse([first, second]).success).toBe(
      true,
    );
    for (const values of [[second, first], [first, first], [{ ...first, extra: true }], []])
      expect(CanonicalAuthorizationEpochSourcesV1Schema.safeParse(values).success).toBe(false);
  });

  it('binds each Plan kind to its own root release kind, Workspace and version', () => {
    expect(ResolvedExecutionPlanV1Schema.safeParse(plan).success).toBe(true);
    for (const mutation of [
      { root_release: { ...plan.root_release, published_resource_kind: 'AGENT_RELEASE' } },
      { root_release: { ...plan.root_release, workspace_id: 'other-workspace' } },
      { flow_version_id: 'other-version' },
      { agent_deployment_id: 'foreign-kind-field' },
    ])
      expect(ResolvedExecutionPlanV1Schema.safeParse({ ...plan, ...mutation }).success).toBe(false);
  });

  it('rejects missing required Binding and call evidence without trusting its hashes', () => {
    expect(
      ResolvedExecutionPlanV1Schema.safeParse({ ...plan, required_binding_paths: [path] }).success,
    ).toBe(false);
    expect(
      ResolvedExecutionPlanV1Schema.safeParse({
        ...plan,
        required_calls: [
          {
            ...call,
            binding_path: path,
            execution_scope_path: path,
            source_node_id: `rn1.${'b'.repeat(43)}`,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
