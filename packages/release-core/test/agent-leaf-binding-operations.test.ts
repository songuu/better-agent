import { describe, expect, it } from 'vitest';

import { prepareLeafResourceSource } from '../src/index.js';
import { prepareAgentLeafBindingOperations } from '../src/agent-leaf-binding-operations.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import {
  leafCandidate,
  leafKinds,
  record,
  type LeafKind,
} from './leaf-resource-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function matching(kind: LeafKind) {
  const dependency = leafCandidate(kind);
  const prepared = prepareLeafResourceSource(dependency);
  const bindingKind = {
    KNOWLEDGE_INDEX_GENERATION: 'knowledge',
    DATABASE_OPERATION_RELEASE: 'database',
    PLUGIN_TOOL_RELEASE: 'plugin',
    A2A_AGENT_RELEASE: 'subagent',
  }[kind];
  const agent = richAgentSource();
  const binding = record(agent.capability_bindings.find((item) => item.kind === bindingKind));
  const document = dependency.document;
  binding.pin = prepared.full_pin;
  binding.manual = { ...record(document.manual), hash: prepared.component_hashes.manual };
  binding.input_schema = structuredClone(record(document.operation).input_schema);
  binding.output_schema = structuredClone(record(document.operation).output_schema);
  binding.data_classification = 'internal';
  const credentials = record(document.requirements).credential_requirements as unknown[];
  if (credentials.length > 0) binding.credential_requirement = structuredClone(credentials[0]);
  else delete binding.credential_requirement;
  const config = record(binding.config);
  if (bindingKind === 'knowledge') {
    config.query_contract_hash = prepared.operation_contract.contract_hash;
    config.metadata_filter_policy_hash = prepared.component_hashes.metadata_filter_policy;
  }
  if (bindingKind === 'plugin') {
    config.operation_contract_hash = prepared.operation_contract.contract_hash;
    config.provider_tool_name = document.provider_tool_name;
    config.transport_contract_hash = prepared.component_hashes.transport;
  }
  if (bindingKind === 'database') {
    config.operation_contract_hash = prepared.operation_contract.contract_hash;
    config.table_revision_ids = [record(document.table).table_revision_id];
    config.allowed_tables = [
      { table_revision_id: record(document.table).table_revision_id, columns: ['title'] },
    ];
    config.max_rows = 20;
  }
  if (bindingKind === 'subagent') binding.target_kind = 'external_a2a';
  return { agent, dependency, prepared, binding };
}

describe('Agent leaf Binding operation collection', () => {
  it.each(leafKinds)('collects the exact %s operation under its matching root path', (kind) => {
    const value = matching(kind);
    const result = prepareAgentLeafBindingOperations(candidate(value.agent), value.dependency);
    const compiled = result.bindings.find(
      (binding) => binding.binding_id === value.binding.binding_id,
    );
    expect(compiled?.operation_contracts).toEqual([value.prepared.operation_contract]);
    expect(result.dependency).toEqual(value.prepared.full_pin);
    expect(result.intrinsic_policy).toEqual(value.prepared.intrinsic_policy);
    expect(result.bindings).toHaveLength(value.agent.capability_bindings.length);
  });

  it('keeps non-matching sibling paths but gives them no foreign operation', () => {
    const value = matching('PLUGIN_TOOL_RELEASE');
    const result = prepareAgentLeafBindingOperations(candidate(value.agent), value.dependency);
    expect(
      result.bindings.filter((binding) => binding.operation_contracts.length > 0),
    ).toHaveLength(1);
    expect(result.bindings.find((binding) => binding.binding_id === 'database')).toMatchObject({
      operation_contracts: [],
    });
  });

  it('rejects a stale exact-pin Binding projection', () => {
    const value = matching('PLUGIN_TOOL_RELEASE');
    record(value.binding.manual).description = 'stale';
    expect(() =>
      prepareAgentLeafBindingOperations(candidate(value.agent), value.dependency),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('returns a deeply frozen operation projection without closure authority', () => {
    const value = matching('DATABASE_OPERATION_RELEASE');
    const result = prepareAgentLeafBindingOperations(candidate(value.agent), value.dependency);
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bindings[0]?.operation_contracts)).toBe(true);
  });
});
