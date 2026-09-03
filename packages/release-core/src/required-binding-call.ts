import type {
  CapabilityBindingV1,
  CompiledCapabilityClosureV1,
} from '@better-agent/domain-contracts';
import { canonicalBindingPath } from './closure-identity.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';

/** Local call order belongs to the mounted owner, never to the entire recursive closure. */
export function bindingAdmissionEvidence(binding: CapabilityBindingV1) {
  return {
    admission_requirement:
      binding.enabled && binding.discoverability === 'forced' ? 'forced' : 'optional',
    ...(binding.enabled && binding.kind === 'knowledge' && binding.config.selection === 'force'
      ? { required_call: binding.config.forced_execution }
      : {}),
  };
}

export function verifyProjectedBindingAdmission(
  nested: CompiledCapabilityClosureV1,
  mounts: readonly (readonly CompiledCapabilityClosureV1['bindings'][number]['binding_path_segments'][number][])[],
  entries: readonly CompiledCapabilityClosureV1['bindings'][number][],
) {
  if (mounts.length * nested.bindings.length > 8_192)
    throw new ReleaseCoreError(
      'COMPILED_CAPABILITY_CLOSURE_INVALID',
      '$.required_call',
      'projected admission evidence exceeds its bound',
    );
  const byPath = new Map(entries.map((entry) => [entry.binding_path, entry]));
  for (const mount of mounts) {
    for (const child of nested.bindings) {
      const segments = child.binding_path_segments.slice(1).map((segment) =>
        (segment.segment_kind === 'binding' || segment.segment_kind === 'flow_node') &&
        segment.owner.owner_kind === 'root'
          ? {
              ...segment,
              owner: { owner_kind: 'published_dependency' as const, pin: nested.root.pin },
            }
          : segment,
      );
      const path = canonicalBindingPath([...mount, ...segments]);
      const projected = byPath.get(path);
      const evidence = (entry: CompiledCapabilityClosureV1['bindings'][number]) => ({
        admission_requirement: entry.admission_requirement,
        ...(entry.required_call === undefined ? {} : { required_call: entry.required_call }),
      });
      if (
        projected === undefined ||
        canonicalSha256(evidence(projected)) !== canonicalSha256(evidence(child))
      )
        throw new ReleaseCoreError(
          'COMPILED_CAPABILITY_CLOSURE_INVALID',
          '$.required_call',
          'projected Binding admission must replay the exact committed child evidence',
        );
    }
  }
}

export function createRequiredBindingCallResolver(
  gates: CompiledCapabilityClosureV1['gate_specs'],
  nodes: CompiledCapabilityClosureV1['resource_nodes'],
) {
  const versionKey = (
    pin:
      | CompiledCapabilityClosureV1['root']['pin']
      | CompiledCapabilityClosureV1['assembly_pins'][number],
  ) =>
    JSON.stringify([
      pin.workspace_id,
      pin.published_resource_kind,
      pin.resource_id,
      pin.resource_version_id,
      pin.binding_mode,
    ]);
  const nodesByVersion = new Map<string, CompiledCapabilityClosureV1['resource_nodes']>();
  for (const node of nodes) {
    const key = versionKey(node.pin);
    const matches = nodesByVersion.get(key) ?? [];
    matches.push(node);
    nodesByVersion.set(key, matches);
  }
  const inputGates = new Map<string, CompiledCapabilityClosureV1['gate_specs']>();
  for (const gate of gates)
    if (gate.kind === 'input' && gate.source_kind === 'agent_release') {
      const key = JSON.stringify([gate.source_node_id, gate.gate_spec_id, gate.gate_spec_hash]);
      const matches = inputGates.get(key) ?? [];
      matches.push(gate);
      inputGates.set(key, matches);
    }
  return (binding: CompiledCapabilityClosureV1['bindings'][number]) => {
    if (binding.required_call === undefined) return undefined;
    const terminal = binding.binding_path_segments.at(-1);
    const owner =
      terminal?.segment_kind === 'binding' || terminal?.segment_kind === 'flow_node'
        ? terminal.owner.pin
        : terminal?.segment_kind === 'skill_pack_member'
          ? terminal.owner_pin
          : undefined;
    if (owner === undefined)
      throw new ReleaseCoreError(
        'RELEASE_RESOLVED_PLAN_INVALID',
        '$.required_call',
        'required call has no exact owning scope',
      );
    const owners = nodesByVersion.get(versionKey(owner)) ?? [];
    if (owners.length !== 1 || owners[0] === undefined)
      throw new ReleaseCoreError(
        'COMPILED_CAPABILITY_CLOSURE_INVALID',
        '$.required_call',
        'required call owner must resolve to one committed resource version',
      );
    const sourceNodeId = owners[0].node_id;
    const scopePath = canonicalBindingPath(binding.binding_path_segments.slice(0, -1));
    const branchGate = (branch: 'on_empty' | 'on_timeout') => {
      const pin = binding.required_call?.[`${branch}_gate_spec`];
      if (pin === undefined) return {};
      const matches =
        inputGates.get(JSON.stringify([sourceNodeId, pin.gate_spec_id, pin.gate_spec_hash])) ?? [];
      if (matches.length !== 1)
        throw new ReleaseCoreError(
          'RELEASE_RESOLVED_PLAN_INVALID',
          `$.required_call.${branch}`,
          'ask_user requires one exact same-owner input GateSpec',
        );
      return { [`${branch}_gate`]: matches[0] };
    };
    return {
      binding_path: binding.binding_path,
      execution_scope_path: scopePath,
      source_node_id: sourceNodeId,
      ...binding.required_call,
      ...branchGate('on_empty'),
      ...branchGate('on_timeout'),
    };
  };
}
