import { prepareLeafResourceSource } from '../src/index.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { agentId, agentReleaseId, workspaceId } from './fixtures.js';
import { leafCandidate, record } from './leaf-resource-source-fixtures.js';

export function skillPackSource() {
  const target = leafCandidate();
  const leaf = prepareLeafResourceSource(target);
  const template = richAgentSource().capability_bindings.find((item) => item.kind === 'plugin');
  const member = record(structuredClone(template));
  member.binding_id = 'lookup-member';
  member.pin = structuredClone(leaf.full_pin);
  member.manual = { ...record(target.document.manual), hash: leaf.component_hashes.manual };
  member.input_schema = record(target.document.operation).input_schema;
  member.output_schema = record(target.document.operation).output_schema;
  member.config = {
    ...record(member.config),
    provider_tool_name: 'lookup',
    operation_contract_hash: leaf.operation_contract.contract_hash,
    transport_contract_hash: leaf.component_hashes.transport,
  };
  return {
    schema_version: 'skill-pack-source-candidate/1' as const,
    workspace_id: workspaceId,
    document: {
      schema_version: 'skill-pack-source/1' as const,
      resource_id: agentId,
      resource_version_id: agentReleaseId,
      manual: { description: 'A fixed lookup pack' },
      input_schema: {
        type: 'object',
        properties: { operation: { const: 'search' }, input: { type: 'object' } },
      },
      output_schema: { type: 'array', items: { type: 'string' } },
      member_bindings: [member],
      exposures: [
        {
          exposed_operation_id: 'search',
          member_binding_id: 'lookup-member',
          member_operation_id: 'lookup',
          operation: structuredClone(target.document.operation),
        },
      ],
    },
  };
}
