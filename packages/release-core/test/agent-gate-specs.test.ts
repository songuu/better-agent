import { describe, expect, it } from 'vitest';

import { canonicalResourceNodeId } from '../src/index.js';
import { prepareAgentGateSpecs } from '../src/agent-gate-specs.js';
import { nestedFlowSource, richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

describe('Agent GateSpec preparation', () => {
  it('compiles every source gate under the exact root resource node', () => {
    const source = richAgentSource();
    const result = prepareAgentGateSpecs(candidate(source));
    expect(result.gate_specs).toHaveLength(source.gate_specs.length);
    for (const gate of result.gate_specs) {
      const declared = source.gate_specs.find((item) => item.gate_spec_id === gate.gate_spec_id);
      expect(gate).toMatchObject({
        gate_spec_hash: declared?.gate_spec_hash,
        kind: declared?.kind,
        decision_schema_hash: declared?.decision_schema_hash,
        approver_policy_ref: declared?.approver_policy_ref,
        approver_policy_hash: declared?.approver_policy_hash,
        on_reject: declared?.on_reject,
        on_expire: declared?.on_expire,
        protected_operation_contract_hashes: declared
          ? [...declared.protected_operation_contract_hashes].sort()
          : undefined,
        source_kind: 'agent_release',
        source_node_id: canonicalResourceNodeId(result.root.pin),
      });
      expect(gate).not.toHaveProperty('source_binding_path');
      expect(gate).not.toHaveProperty('source_flow_node_id');
    }
  });

  it('sorts gates by canonical ID independent of source declaration order', () => {
    const source = richAgentSource();
    source.gate_specs.reverse();
    expect(prepareAgentGateSpecs(candidate(source))).toEqual(
      prepareAgentGateSpecs(candidate(richAgentSource())),
    );
  });

  it('preserves optional notification profile hashes exactly', () => {
    const source = richAgentSource();
    const gate = source.gate_specs[0];
    if (gate === undefined) throw new Error('fixture GateSpec is missing');
    gate.notification_profile_ref = 'notify';
    gate.notification_profile_hash =
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = prepareAgentGateSpecs(candidate(source));
    expect(result.gate_specs.find((gate) => gate.gate_spec_id === 'approval')).toMatchObject({
      notification_profile_hash:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('rejects Flow sources at the Agent gate boundary', () => {
    expect(() => prepareAgentGateSpecs(candidate(nestedFlowSource()))).toThrow(
      'GATE_SPEC_NOT_CLOSED',
    );
  });

  it('returns a deeply frozen source projection without closure authority', () => {
    const result = prepareAgentGateSpecs(candidate(richAgentSource()));
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.gate_specs)).toBe(true);
    expect(Object.isFrozen(result.gate_specs[0]?.protected_operation_contract_hashes)).toBe(true);
  });
});
