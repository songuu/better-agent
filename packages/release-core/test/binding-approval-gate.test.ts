import { describe, expect, it } from 'vitest';

import { prepareOperationContractSource } from '../src/index.js';
import { prepareAgentBindingApprovalGate } from '../src/agent-gate-specs.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import { leafCandidate, record } from './leaf-resource-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function operation(approvalRequired = false) {
  const source = record(structuredClone(leafCandidate().document.operation));
  source.approval_required = approvalRequired;
  return prepareOperationContractSource(source).pin;
}

function requiredApproval() {
  const source = richAgentSource();
  const binding = source.capability_bindings.find((item) => item.binding_id === 'plugin');
  const gate = source.gate_specs.find((item) => item.gate_spec_id === 'approval');
  if (binding === undefined || gate === undefined)
    throw new Error('approval fixture is incomplete');
  const pin = operation();
  binding.side_effect = {
    class: binding.side_effect.class,
    approval: 'required',
    approval_gate_spec_id: gate.gate_spec_id,
  };
  gate.protected_operation_contract_hashes = [pin.contract_hash];
  return { source, binding, gate, pin };
}

describe('Agent Binding approval gate coverage', () => {
  it('joins an approval Binding to the exact same-source gate ID, hash and operation', () => {
    const value = requiredApproval();
    const result = prepareAgentBindingApprovalGate(
      candidate(value.source),
      value.binding.binding_id,
      [value.pin],
    );
    expect(result.approval_gate_spec).toEqual({
      gate_spec_id: value.gate.gate_spec_id,
      gate_spec_hash: value.gate.gate_spec_hash,
    });
    expect(result.operation_contracts).toEqual([value.pin]);
  });

  it('omits approval evidence for a non-approval Binding with non-approval operations', () => {
    const source = richAgentSource();
    const result = prepareAgentBindingApprovalGate(candidate(source), 'plugin', [operation()]);
    expect(result).not.toHaveProperty('approval_gate_spec');
  });

  it('rejects an operation that requires approval when the Binding declares none', () => {
    expect(() =>
      prepareAgentBindingApprovalGate(candidate(richAgentSource()), 'plugin', [operation(true)]),
    ).toThrow('GATE_SPEC_NOT_CLOSED');
  });

  it('rejects incomplete protected operation coverage', () => {
    const value = requiredApproval();
    value.gate.protected_operation_contract_hashes = [
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ];
    expect(() =>
      prepareAgentBindingApprovalGate(candidate(value.source), value.binding.binding_id, [
        value.pin,
      ]),
    ).toThrow('GATE_SPEC_NOT_CLOSED');
  });

  it('rejects empty or duplicate operation sets for required approval', () => {
    const value = requiredApproval();
    for (const operations of [[], [value.pin, value.pin]]) {
      expect(() =>
        prepareAgentBindingApprovalGate(
          candidate(value.source),
          value.binding.binding_id,
          operations,
        ),
      ).toThrow('GATE_SPEC_NOT_CLOSED');
    }
  });

  it('returns deeply frozen evidence without an authorization hash', () => {
    const value = requiredApproval();
    const result = prepareAgentBindingApprovalGate(
      candidate(value.source),
      value.binding.binding_id,
      [value.pin],
    );
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.operation_contracts)).toBe(true);
  });
});
