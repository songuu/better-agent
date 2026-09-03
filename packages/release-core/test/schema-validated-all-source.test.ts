import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  prepareExecutableSource,
  prepareOperationContractSource,
  prepareLeafResourceSource,
  prepareSchemaValidatedExecutableSource as executable,
  prepareSchemaValidatedLeafResourceSource as leaf,
  prepareSchemaValidatedSkillPackSource as pack,
  prepareSkillPackSource,
  verifySchemaValidatedExecutableSource as verifyExecutable,
  verifySchemaValidatedLeafResourceSource as verifyLeaf,
  verifySchemaValidatedSkillPackSource as verifyPack,
} from '../src/index.js';
import { nestedFlowSource, richAgentSource } from './executable-source-fixtures.js';
import { leafCandidate, leafKinds, put, record } from './leaf-resource-source-fixtures.js';
import { skillPackSource } from './skill-pack-source-fixtures.js';
import { makeFlowIr } from './fixtures.js';

function candidate(document: unknown) {
  return {
    schema_version: 'executable-source-candidate/1',
    workspace_id: leafCandidate().workspace_id,
    document,
  };
}
function flattened(result: {
  evidence: { schema_batches: readonly (readonly { field: string }[])[] };
}) {
  return result.evidence.schema_batches.flat();
}
function fields(result: Parameters<typeof flattened>[0]) {
  return flattened(result).map((entry) => entry.field);
}
function expectSortedUnique(values: readonly string[]) {
  expect(values).toEqual([...new Set(values)].sort());
}
function expandedSkillPackSource() {
  const input = skillPackSource();
  const nestedInput = skillPackSource();
  record(nestedInput.document).resource_id = '018f47f2-c541-7cc6-9292-4a2c35303e30';
  record(nestedInput.document).resource_version_id = '018f47f2-c541-7cc6-9292-4a2c35303e31';
  const nested = prepareSkillPackSource(nestedInput);
  const template = richAgentSource().capability_bindings.find((item) => item.kind === 'skill_pack');
  const nestedExposure = nestedInput.document.exposures[0];
  if (template === undefined || nestedExposure === undefined)
    throw new Error('fixture is incomplete');
  const member = structuredClone(template);
  const exposure = structuredClone(nestedExposure);
  member.binding_id = 'secondary-member';
  member.pin = structuredClone(nested.full_pin);
  member.manual = { ...nestedInput.document.manual, hash: nested.component_hashes.manual };
  member.input_schema = nestedInput.document.input_schema;
  member.output_schema = nestedInput.document.output_schema;
  member.config = {
    schema_version: 'skill-pack-binding/1',
    member_projection_hash: nested.member_projection_hash,
    exposed_operations: nested.exposed_operations.map((item) => ({
      exposed_operation_id: item.exposed_operation_id,
      exposed_operation_contract_hash: item.exposed_operation_contract_hash,
    })),
  };
  exposure.exposed_operation_id = 'secondary-search';
  exposure.member_binding_id = member.binding_id;
  exposure.member_operation_id = 'search';
  input.document.member_bindings.push(member);
  input.document.exposures.push(exposure);
  return input;
}

describe('Schema validation across every typed source location', () => {
  it('binds Agent contracts, gates and every capability Binding in canonical field order', async () => {
    const input = candidate(richAgentSource());
    const source = prepareExecutableSource(input);
    const result = await executable(input);
    expect(result.schema_version).toBe('schema-validated-executable-source/1');
    expect(result.source_artifact).toEqual(source);
    expect(result.evidence.source_artifact_hash).toBe(canonicalSha256(source));
    expect(result.evidence.schema_count).toBe(9);
    expect(fields(result)).toEqual([
      '/preimage/document/capability_bindings/0/input_schema',
      '/preimage/document/capability_bindings/1/input_schema',
      '/preimage/document/capability_bindings/2/input_schema',
      '/preimage/document/capability_bindings/3/input_schema',
      '/preimage/document/capability_bindings/4/input_schema',
      '/preimage/document/capability_bindings/5/input_schema',
      '/preimage/document/gate_specs/0/decision_schema',
      '/preimage/document/gate_specs/1/decision_schema',
      '/preimage/document/input_contract',
    ]);
    expect(result.evidence.schema_count).toBe(fields(result).length);
    expectSortedUnique(fields(result));
    expect(result.validation_hash).toBe(canonicalSha256(result.evidence));
    expect(await verifyExecutable(result, input)).toEqual(result);
    expect(Object.isFrozen(result.evidence.schema_batches[0])).toBe(true);
  });

  it.each(['input_contract', 'output_contract'] as const)(
    'rejects an invalid Agent %s while the source declaration alone still parses',
    async (field) => {
      const document = richAgentSource();
      Object.assign(document, { [field]: { type: 'not-a-type' } });
      const input = candidate(document);
      expect(prepareExecutableSource(input)).toBeDefined();
      await expect(executable(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
    },
  );

  it.each(['binding', 'gate'] as const)(
    'rejects an invalid non-root Agent %s schema',
    async (axis) => {
      const document = richAgentSource();
      if (axis === 'binding')
        record(document.capability_bindings[5]).input_schema = { type: 'not-a-type' };
      else record(document.gate_specs[1]).decision_schema = { type: 'not-a-type' };
      const input = candidate(document);
      expect(prepareExecutableSource(input)).toBeDefined();
      await expect(executable(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
    },
  );

  it('walks Flow root schemas, every nested node output and nested human gate without treating loop exports as schemas', async () => {
    const document = nestedFlowSource();
    const branch = record(
      document.entry_graph.nodes.find((node) => node.type === 'branch')?.config,
    );
    const firstGraph = record(record(branch.cases)[0]).graph as typeof document.entry_graph;
    firstGraph.nodes[1] = record({
      ...record(firstGraph.nodes[1]),
      type: 'human_gate',
      config: {
        gate: {
          schema_version: 'human-gate/1',
          gate_spec_id: 'input',
          kind: 'input',
          decision_schema: { type: 'string' },
          decision_schema_hash: `sha256:${'a'.repeat(64)}`,
          approver_policy_ref: 'policy',
          approver_policy_hash: `sha256:${'b'.repeat(64)}`,
          expires_after_seconds: 30,
          on_reject: 'fail_run',
          on_expire: 'cancel_run',
          gate_spec_hash: `sha256:${'a'.repeat(64)}`,
          protected_operation_contract_hashes: [],
        },
        prompt: 'continue?',
        exports: {},
      },
    }) as never;
    const input = candidate(document);
    const result = await executable(input);
    expect(result.evidence.schema_count).toBe(15);
    expect(
      fields(result).filter((field) => field.endsWith('/config/gate/decision_schema')),
    ).toHaveLength(1);
    expect(fields(result).filter((field) => field.endsWith('/output_schema'))).toHaveLength(13);
    expect(fields(result).some((field) => field.includes('/exports/'))).toBe(false);
    expectSortedUnique(fields(result));
  });

  it.each(['root-input', 'root-output', 'nested-output', 'nested-gate'] as const)(
    'rejects invalid Flow %s schema while preserving valid surrounding recursion',
    async (axis) => {
      const document = nestedFlowSource();
      if (axis === 'root-input') record(document).input_schema = { type: 'not-a-type' };
      if (axis === 'root-output') record(document).output_schema = { type: 'not-a-type' };
      if (axis === 'nested-output') {
        const branch = record(
          document.entry_graph.nodes.find((node) => node.type === 'branch')?.config,
        );
        const graph = record(record(record(branch.cases)[1]).graph);
        record(record(graph.nodes)[2]).output_schema = { type: 'not-a-type' };
      }
      if (axis === 'nested-gate') {
        const branch = record(
          document.entry_graph.nodes.find((node) => node.type === 'branch')?.config,
        );
        const elseGraph = record(record(record(branch.else_case).graph));
        const loop = record(record(record(elseGraph.nodes)[0]).config);
        const node = record(record(record(loop.body).nodes)[1]);
        Object.assign(node, {
          type: 'human_gate',
          config: {
            gate: {
              schema_version: 'human-gate/1',
              gate_spec_id: 'input',
              kind: 'input',
              decision_schema: { type: 'not-a-type' },
              decision_schema_hash: `sha256:${'a'.repeat(64)}`,
              approver_policy_ref: 'policy',
              approver_policy_hash: `sha256:${'b'.repeat(64)}`,
              expires_after_seconds: 30,
              on_reject: 'fail_run',
              on_expire: 'cancel_run',
              gate_spec_hash: `sha256:${'a'.repeat(64)}`,
              protected_operation_contract_hashes: [],
            },
            prompt: 'continue?',
            exports: {},
          },
        });
      }
      const input = candidate(document);
      expect(prepareExecutableSource(input)).toBeDefined();
      await expect(executable(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
    },
  );

  it('splits 1025 real Flow schema locations into frozen 1024/1 evidence batches', async () => {
    const document = makeFlowIr();
    const nodes = Array.from({ length: 1023 }, (_, index) => ({
      node_id: `node-${index.toString().padStart(4, '0')}`,
      key: `node_${index.toString().padStart(4, '0')}`,
      type: index === 0 ? ('start' as const) : ('text' as const),
      config: {},
      inputs: {},
      output_schema: {},
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      edge_id: `edge-${index.toString().padStart(4, '0')}`,
      kind: 'control' as const,
      from: { node_id: nodes[index]?.node_id ?? '', port: 'next' },
      to: { node_id: node.node_id, port: 'in' },
    }));
    record(document).entry_graph = {
      graph_id: 'root',
      entry_node_id: nodes[0]?.node_id ?? '',
      exit_node_ids: [nodes.at(-1)?.node_id ?? ''],
      nodes,
      edges,
    };
    const input = candidate(document);
    const result = await executable(input);
    expect(result.evidence.schema_count).toBe(1025);
    expect(result.evidence.schema_batches.map((batch) => batch.length)).toEqual([1024, 1]);
    expect(result.evidence.schema_batches.every(Object.isFrozen)).toBe(true);
    expect(await verifyExecutable(result, input)).toEqual(result);
  }, 20_000);

  it.each(leafKinds)('validates every operation location for %s', async (kind) => {
    const input = leafCandidate(kind);
    const result = await leaf(input);
    const expected = ['/document/operation/input_schema', '/document/operation/output_schema'];
    if (kind === 'PLUGIN_TOOL_RELEASE')
      expected.push(
        '/document/tool_list/operations/0/input_schema',
        '/document/tool_list/operations/0/output_schema',
      );
    if (kind === 'A2A_AGENT_RELEASE')
      expected.push(
        '/document/agent_card/skills/0/operation/input_schema',
        '/document/agent_card/skills/0/operation/output_schema',
      );
    expect(fields(result)).toEqual(expected.sort());
    expect(result.source_artifact).toEqual(prepareLeafResourceSource(input));
    expect(await verifyLeaf(result, input)).toEqual(result);
  });

  it.each(leafKinds)(
    'rejects an invalid selected operation schema for %s after typed source normalization',
    async (kind) => {
      const input = leafCandidate(kind);
      put(
        input,
        [
          'document',
          'operation',
          kind === 'DATABASE_OPERATION_RELEASE' ? 'output_schema' : 'input_schema',
        ],
        { type: 'not-a-type' },
      );
      if (kind === 'PLUGIN_TOOL_RELEASE')
        put(input, ['document', 'tool_list', 'operations', '0', 'input_schema'], {
          type: 'not-a-type',
        });
      if (kind === 'A2A_AGENT_RELEASE')
        put(input, ['document', 'agent_card', 'skills', '0', 'operation', 'input_schema'], {
          type: 'not-a-type',
        });
      expect(prepareLeafResourceSource(input)).toBeDefined();
      await expect(leaf(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
    },
  );

  it.each(['PLUGIN_TOOL_RELEASE', 'A2A_AGENT_RELEASE'] as const)(
    'rejects an invalid non-first nested operation for %s',
    async (kind) => {
      const input = leafCandidate(kind);
      const document = record(input.document);
      if (kind === 'PLUGIN_TOOL_RELEASE') {
        const operations = record(document.tool_list).operations as unknown[];
        const second = structuredClone(record(operations[0]));
        second.operation_id = 'lookup-second';
        second.input_schema = { type: 'not-a-type' };
        operations.push(second);
      } else {
        const skills = record(document.agent_card).skills as unknown[];
        const second = structuredClone(record(skills[0]));
        second.skill_id = 'lookup-second';
        record(second.operation).operation_id = 'lookup-second';
        record(second.operation).input_schema = { type: 'not-a-type' };
        skills.push(second);
      }
      expect(prepareLeafResourceSource(input)).toBeDefined();
      await expect(leaf(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
    },
  );

  it('validates Skill Pack envelopes, every member Binding and every exposed operation', async () => {
    const input = skillPackSource();
    const result = await pack(input);
    expect(fields(result)).toEqual([
      '/document/exposures/0/operation/input_schema',
      '/document/exposures/0/operation/output_schema',
      '/document/input_schema',
      '/document/member_bindings/0/input_schema',
      '/document/member_bindings/0/output_schema',
      '/document/output_schema',
    ]);
    expect(result.source_artifact).toEqual(prepareSkillPackSource(input));
    expect(await verifyPack(result, input)).toEqual(result);
  });

  it('does not truncate non-first Skill Pack members or exposures', async () => {
    const input = expandedSkillPackSource();
    const result = await pack(input);
    expect(fields(result)).toContain('/document/member_bindings/1/input_schema');
    expect(fields(result)).toContain('/document/member_bindings/1/output_schema');
    expect(fields(result)).toContain('/document/exposures/1/operation/input_schema');
    expect(fields(result)).toContain('/document/exposures/1/operation/output_schema');
    expect(result.evidence.schema_count).toBe(10);

    const invalid = expandedSkillPackSource();
    const member = invalid.document.member_bindings.find(
      (item) => item.binding_id === 'secondary-member',
    );
    const exposure = invalid.document.exposures.find(
      (item) => item.exposed_operation_id === 'secondary-search',
    );
    if (member === undefined || exposure === undefined) throw new Error('fixture is incomplete');
    record(exposure.operation).input_schema = { type: 'not-a-type' };
    const operationHash = prepareOperationContractSource(exposure.operation).pin.contract_hash;
    const exposedOperations = record(member.config).exposed_operations as unknown[];
    const exposedOperation = exposedOperations
      .map(record)
      .find((item) => item.exposed_operation_id === exposure.member_operation_id);
    if (exposedOperation === undefined) throw new Error('fixture is incomplete');
    exposedOperation.exposed_operation_contract_hash = operationHash;
    expect(prepareSkillPackSource(invalid)).toBeDefined();
    await expect(pack(invalid)).rejects.toThrow('JSON_SCHEMA_INVALID');
  });

  it.each([
    'envelope-input',
    'envelope-output',
    'member-exposure-input',
    'member-exposure-output',
  ] as const)(
    'rejects invalid Skill Pack %s schemas without relying on an opaque name scan',
    async (axis) => {
      const input = skillPackSource();
      if (axis === 'envelope-input') record(input.document).input_schema = { type: 'not-a-type' };
      else if (axis === 'envelope-output')
        record(input.document).output_schema = { type: 'not-a-type' };
      else {
        const invalid = { type: 'not-a-type' };
        const member = input.document.member_bindings[0];
        const exposure = input.document.exposures[0];
        if (member === undefined || exposure === undefined)
          throw new Error('fixture is incomplete');
        const field = axis === 'member-exposure-input' ? 'input_schema' : 'output_schema';
        record(member)[field] = invalid;
        record(exposure.operation)[field] = invalid;
        // Keep the typed member/exposure declaration internally consistent; only JSON Schema validity fails.
        record(member.config).operation_contract_hash = prepareOperationContractSource(
          exposure.operation,
        ).pin.contract_hash;
      }
      expect(prepareSkillPackSource(input)).toBeDefined();
      await expect(pack(input)).rejects.toThrow('JSON_SCHEMA_INVALID');
    },
  );

  it.each(['executable', 'leaf', 'pack'] as const)(
    'rebuilds the complete %s wrapper and rejects caller evidence drift',
    async (kind) => {
      const input =
        kind === 'executable'
          ? candidate(richAgentSource())
          : kind === 'leaf'
            ? leafCandidate()
            : skillPackSource();
      const prepare = kind === 'executable' ? executable : kind === 'leaf' ? leaf : pack;
      const verify =
        kind === 'executable' ? verifyExecutable : kind === 'leaf' ? verifyLeaf : verifyPack;
      const result = await prepare(input as never);
      for (const patch of [
        { source_artifact: {} },
        { evidence: {} },
        { validation_hash: `sha256:${'0'.repeat(64)}` },
        { extra: true },
        { evidence: { ...result.evidence, schema_count: result.evidence.schema_count - 1 } },
        { evidence: { ...result.evidence, schema_batches: [] } },
      ])
        await expect(verify({ ...result, ...patch }, input as never)).rejects.toThrow(
          'CLOSURE_SOURCE_MISMATCH',
        );
    },
    20_000,
  );
});
