import { prepareAgentCapabilityClosure } from '../src/agent-capability-closure.js';
import { prepareGraphBoundAgentLeafBindingEntrySet } from '../src/agent-leaf-binding-entries.js';
import { prepareAgentRootBindingEntrySet } from '../src/agent-root-binding-entry-set.js';
import { deriveDependencyManifest } from '../src/dependency-manifest.js';
import { prepareExecutableSource } from '../src/executable-source.js';
import { prepareFlowCapabilityClosure } from '../src/flow-capability-closure.js';
import { canonicalSha256ExcludingRootKeys } from '../src/hash.js';
import { preparePinnedDependencyGraph } from '../src/pinned-dependency-graph.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { makeFlowIr, makeStrategyRelease, workspaceId } from './fixtures.js';

export function executableStorageFixture(kind: 'AGENT_RELEASE' | 'FLOW_VERSION') {
  const strategy = { ...makeStrategyRelease(), allowed_capability_binding_ids: [] };
  strategy.contract_hash = canonicalSha256ExcludingRootKeys(strategy, ['contract_hash']);
  const agent = richAgentSource();
  agent.capability_bindings = [];
  agent.instruction_skill_bindings = [];
  agent.public_capability_handles = [];
  agent.gate_specs = [];
  const {
    source_draft_revision_id: _draft,
    schema_version: _strategySchema,
    ...strategyBody
  } = strategy;
  agent.strategy = {
    ...strategyBody,
    allowed_gate_spec_ids: [],
    published_resource_kind: 'AGENT_STRATEGY_RELEASE',
  };
  const sourceInput = {
    schema_version: 'executable-source-candidate/1',
    workspace_id: workspaceId,
    document: kind === 'AGENT_RELEASE' ? agent : makeFlowIr(),
  };
  const source = prepareExecutableSource(sourceInput);
  const ceiling = {
    schema_version: 'capability-policy-ceiling/1',
    credential_allowances: [],
    principal_modes: ['none'],
    egress: [],
    readable_data_classification_ceiling: 'public',
    output_data_classification: 'public',
    side_effect: { maximum_class: 'safe', approval: 'none' },
    operation_contract_hashes: [],
    max_calls: 0,
    max_depth: 0,
    max_parallelism: 0,
    budget: {
      schema_version: 'capability-budget/1',
      amount_credits: '0',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
    },
  } as const;
  if (kind === 'AGENT_RELEASE') {
    const graphInput = {
      schema_version: 'pinned-dependency-graph-candidate/1',
      root: source.root,
      root_dependencies: source.dependency_manifest.dependencies,
      resources: source.dependency_manifest.dependencies.map((pin) => {
        const { contract_hash: _hash, binding_mode: _mode, ...owner } = pin;
        return {
          schema_version: 'pinned-dependency-record/1',
          pin,
          publication_state: 'sealed',
          dependency_manifest: deriveDependencyManifest(owner, []),
        };
      }),
    };
    const graph = preparePinnedDependencyGraph(graphInput);
    const policy = {
      schema_version: 'agent-leaf-binding-policy-input/1',
      workspace_ceiling: ceiling,
      root_ceiling: ceiling,
      binding_ceilings: [],
    };
    const slice = prepareGraphBoundAgentLeafBindingEntrySet(
      graph,
      graphInput,
      sourceInput,
      [],
      policy,
    );
    const entries = prepareAgentRootBindingEntrySet(sourceInput, graph.graph_hash, [slice], {
      ...policy,
      schema_version: 'agent-root-binding-policy-input/1',
    });
    return {
      sourceInput,
      source,
      strategy,
      closure: prepareAgentCapabilityClosure(sourceInput, graph, entries),
    };
  }
  const graph = preparePinnedDependencyGraph({
    schema_version: 'pinned-dependency-graph-candidate/1',
    root: source.root,
    root_dependencies: [],
    resources: [],
  });
  return {
    sourceInput,
    source,
    strategy,
    closure: prepareFlowCapabilityClosure(sourceInput, graph),
  };
}
