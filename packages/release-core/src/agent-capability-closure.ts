import { ClosureRootV1Schema, CompiledBindingEntryV1Schema } from '@better-agent/domain-contracts';
import { prepareAgentGateSpecs } from './agent-gate-specs.js';
import type { PreparedAgentRootBindingEntrySetV1 } from './agent-root-binding-entry-set.js';
import { prepareAgentRootResourceGraph } from './agent-root-resource-graph.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { prepareCompiledCapabilityClosure } from './compiled-capability-closure.js';
import { compareCanonicalStrings } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256ExcludingRootKeys } from './hash.js';

function notClosed(path: string, reason: string): never {
  throw new ReleaseCoreError('COMPILED_CAPABILITY_CLOSURE_INVALID', path, reason);
}

function parseRetainedEntrySet(input: unknown): PreparedAgentRootBindingEntrySetV1 {
  const snapshot = boundedDataSnapshot(input, 'closure');
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    notClosed('$.entry_set', 'Agent entry set must be a closed object');
  }
  const entrySet = snapshot as unknown as PreparedAgentRootBindingEntrySetV1;
  const root = ClosureRootV1Schema.safeParse(entrySet.root);
  if (
    entrySet.schema_version !== 'prepared-agent-root-binding-entry-set/1' ||
    !root.success ||
    !Array.isArray(entrySet.entries) ||
    !Array.isArray(entrySet.descendant_binding_entries)
  ) {
    notClosed('$.entry_set', 'Agent entry set does not retain closure assembly facts');
  }
  for (const [index, entry] of [
    ...entrySet.entries,
    ...entrySet.descendant_binding_entries,
  ].entries()) {
    if (!CompiledBindingEntryV1Schema.safeParse(entry).success) {
      notClosed(`$.entry_set.bindings[${index}]`, 'Agent entry set contains an invalid Binding');
    }
  }
  return entrySet;
}

/**
 * Seal the non-recursive Agent subset whose root and leaf-Pack provenance is already complete.
 * Recursive Agent/Flow authority needs parent-relative demand recompilation and remains fail-closed.
 */
export function prepareNonRecursiveAgentCapabilityClosure(
  rootInput: unknown,
  graphInput: unknown,
  entrySetInput: unknown,
) {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') {
    notClosed('$.root', 'non-recursive Agent closure assembly requires an Agent root');
  }
  const entrySet = parseRetainedEntrySet(entrySetInput);
  const resourceGraph = prepareAgentRootResourceGraph(graphInput, entrySetInput);
  const gateSpecs = prepareAgentGateSpecs(rootInput);
  if (
    !canonicalJsonBytes(source.root).equals(canonicalJsonBytes(entrySet.root)) ||
    !canonicalJsonBytes(source.root).equals(canonicalJsonBytes(gateSpecs.root))
  ) {
    notClosed('$.entry_set.root', 'Agent entry set is not bound to the supplied source');
  }
  if (
    resourceGraph.resource_nodes.some(
      (node) =>
        node.node_role === 'dependency' &&
        (node.pin.published_resource_kind === 'AGENT_RELEASE' ||
          node.pin.published_resource_kind === 'FLOW_VERSION'),
    )
  ) {
    notClosed(
      '$.resource_nodes',
      'recursive Agent or Flow authority requires parent-relative demand recompilation',
    );
  }
  const bindings = [...entrySet.entries, ...entrySet.descendant_binding_entries].sort(
    (left, right) => compareCanonicalStrings(left.binding_path, right.binding_path),
  );
  const draft = {
    schema_version: 'compiled-capability-closure/1' as const,
    root: source.root,
    assembly_pins: source.dependency_manifest.dependencies,
    bindings,
    gate_specs: gateSpecs.gate_specs,
    resource_nodes: resourceGraph.resource_nodes,
    dependency_edges: resourceGraph.dependency_edges,
    disabled_binding_paths: entrySet.disabled_binding_paths,
    aggregate_limits: entrySet.aggregate_limits,
  };
  return prepareCompiledCapabilityClosure({
    ...draft,
    closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
  });
}
