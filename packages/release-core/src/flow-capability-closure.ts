import { canonicalJsonBytes } from './canonical-json.js';
import { canonicalBindingPath, canonicalResourceNodeId } from './closure-identity.js';
import { prepareCompiledCapabilityClosure } from './compiled-capability-closure.js';
import { compareCanonicalStrings, deriveDependencyManifest } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { prepareFlowGateSpecs } from './agent-gate-specs.js';
import { canonicalSha256ExcludingRootKeys } from './hash.js';
import { preparePinnedDependencyGraph } from './pinned-dependency-graph.js';

const emptyRequirements = {
  schema_version: 'capability-requirements/1' as const,
  credential_requirements: [],
  principal_modes: ['none'] as const,
  egress: [],
  readable_data_classification: 'public' as const,
  output_data_classification: 'public' as const,
  side_effect_class: 'safe' as const,
  approval_required: false,
  operation_contract_hashes: [],
  minimum_limits: {
    calls: 0,
    depth: 0,
    parallelism: 0,
    budget: {
      schema_version: 'capability-budget/1' as const,
      amount_credits: '0',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
    },
  },
};
const emptyExpression = {
  schema_version: 'capability-requirement-expression/1' as const,
  expression_kind: 'leaf' as const,
  requirements: emptyRequirements,
};
const emptyLimits = {
  credential_requirements: [],
  principal_modes: ['none'] as const,
  egress: [],
  readable_data_classification_ceiling: 'public' as const,
  output_data_classification: 'public' as const,
  side_effect: { maximum_class: 'safe' as const, approval: 'none' as const },
  operation_contract_hashes: [],
  max_calls: 0,
  max_depth: 0,
  max_parallelism: 0,
  budget: emptyRequirements.minimum_limits.budget,
};

interface SystemPin {
  readonly workspace_id: string;
  readonly published_resource_kind: 'SYSTEM_RELEASE';
  readonly resource_id: string;
  readonly resource_version_id: string;
  readonly contract_hash: string;
  readonly binding_mode: 'pinned';
}
interface CredentialRequirement {
  readonly schema_version: 'credential-requirement/1';
  readonly requirement_id: string;
  readonly provider_id: string;
  readonly audience: string;
  readonly required_scopes: readonly string[];
  readonly allowed_principal_modes: readonly (
    | 'caller_delegated'
    | 'service_principal'
    | 'team_shared'
  )[];
}
interface LinearLlmConfig {
  readonly schema_version: 'flow-llm-node-config/1';
  readonly model: SystemPin;
  readonly credential_requirement_id: string;
  readonly max_amount_credits: string;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
}
interface FlowDocument {
  readonly entry_graph: {
    readonly entry_node_id: string;
    readonly exit_node_ids: readonly string[];
    readonly nodes: readonly {
      readonly node_id: string;
      readonly type: string;
      readonly config: unknown;
      readonly timeout_ms?: number;
    }[];
    readonly edges: readonly {
      readonly from: { readonly node_id: string };
      readonly to: { readonly node_id: string };
      readonly kind: string;
    }[];
  };
  readonly resources: readonly SystemPin[];
  readonly credential_requirements: readonly CredentialRequirement[];
}

function invalid(path: string, reason: string): never {
  throw new ReleaseCoreError('COMPILED_CAPABILITY_CLOSURE_INVALID', path, reason);
}
function samePin(left: SystemPin, right: SystemPin): boolean {
  return (
    left.workspace_id === right.workspace_id &&
    left.published_resource_kind === right.published_resource_kind &&
    left.resource_id === right.resource_id &&
    left.resource_version_id === right.resource_version_id &&
    left.contract_hash === right.contract_hash &&
    left.binding_mode === right.binding_mode
  );
}
function verifyInertFlow(document: FlowDocument): void {
  const graph = document.entry_graph;
  const start = graph.nodes.find((node) => node.type === 'start');
  const output = graph.nodes.find((node) => node.type === 'output');
  if (
    graph.nodes.length !== 2 ||
    graph.edges.length !== 1 ||
    start === undefined ||
    output === undefined ||
    graph.entry_node_id !== start.node_id ||
    graph.exit_node_ids.length !== 1 ||
    graph.exit_node_ids[0] !== output.node_id ||
    graph.edges[0]?.kind !== 'control' ||
    graph.edges[0]?.from.node_id !== start.node_id ||
    graph.edges[0]?.to.node_id !== output.node_id
  ) {
    invalid('$.document.entry_graph', 'resource-free compilation requires an exact inert Flow');
  }
}
function linearLlmFacts(document: FlowDocument) {
  const graph = document.entry_graph;
  const start = graph.nodes.find((node) => node.type === 'start');
  const llm = graph.nodes.find((node) => node.type === 'llm');
  const output = graph.nodes.find((node) => node.type === 'output');
  if (
    graph.nodes.length !== 3 ||
    graph.edges.length !== 2 ||
    start === undefined ||
    llm === undefined ||
    output === undefined ||
    graph.entry_node_id !== start.node_id ||
    graph.exit_node_ids.length !== 1 ||
    graph.exit_node_ids[0] !== output.node_id ||
    !graph.edges.every((edge) => edge.kind === 'control') ||
    !graph.edges.some(
      (edge) => edge.from.node_id === start.node_id && edge.to.node_id === llm.node_id,
    ) ||
    !graph.edges.some(
      (edge) => edge.from.node_id === llm.node_id && edge.to.node_id === output.node_id,
    )
  ) {
    invalid('$.document.entry_graph', 'G1-A2 Flow must be exactly Start to LLM to Output');
  }
  const config = llm.config as LinearLlmConfig;
  const requirement = document.credential_requirements.find(
    (candidate) => candidate.requirement_id === config.credential_requirement_id,
  );
  const model = document.resources[0];
  if (
    model === undefined ||
    document.resources.length !== 1 ||
    !samePin(model, config.model) ||
    document.credential_requirements.length !== 1 ||
    requirement === undefined
  ) {
    invalid('$.document', 'linear LLM Flow requires one exact model and credential reference');
  }
  return { config, llm, model, requirement };
}

/** Seal either an inert Flow or the G1-A2 Start to LLM to Output capability subset. */
export function prepareFlowCapabilityClosure(rootInput: unknown, graphInput: unknown) {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'FLOW_VERSION')
    invalid('$.root', 'Flow closure assembly requires a Flow source');
  const document = source.preimage.document as unknown as FlowDocument;
  const isEmpty = document.resources.length === 0 && document.credential_requirements.length === 0;
  if (isEmpty) verifyInertFlow(document);
  const linear = isEmpty ? undefined : linearLlmFacts(document);
  const budget =
    linear === undefined
      ? emptyRequirements.minimum_limits.budget
      : {
          schema_version: 'capability-budget/1' as const,
          amount_credits: linear.config.max_amount_credits,
          input_tokens: linear.config.max_input_tokens,
          output_tokens: linear.config.max_output_tokens,
          total_tokens: linear.config.max_input_tokens + linear.config.max_output_tokens,
          duration_ms: linear.llm.timeout_ms ?? 300_000,
        };
  const requirements =
    linear === undefined
      ? emptyRequirements
      : {
          schema_version: 'capability-requirements/1' as const,
          credential_requirements: [linear.requirement],
          principal_modes: linear.requirement.allowed_principal_modes,
          egress: [],
          readable_data_classification: 'public' as const,
          output_data_classification: 'public' as const,
          side_effect_class: 'safe' as const,
          approval_required: false,
          operation_contract_hashes: [],
          minimum_limits: { calls: 1, depth: 0, parallelism: 1, budget },
        };
  const intrinsicPolicy = {
    schema_version: 'capability-requirement-expression/1' as const,
    expression_kind: 'leaf' as const,
    requirements,
  };
  const dependencies = linear === undefined ? [] : [linear.model];
  const graph = preparePinnedDependencyGraph({
    schema_version: 'pinned-dependency-graph-candidate/1',
    root: source.root,
    root_dependencies: dependencies,
    resources: dependencies.map((pin) => ({
      schema_version: 'pinned-dependency-record/1' as const,
      pin,
      publication_state: 'sealed' as const,
      dependency_manifest: deriveDependencyManifest(
        {
          workspace_id: pin.workspace_id,
          published_resource_kind: pin.published_resource_kind,
          resource_id: pin.resource_id,
          resource_version_id: pin.resource_version_id,
        },
        [],
      ),
    })),
  });
  if (!canonicalJsonBytes(graph).equals(canonicalJsonBytes(graphInput)))
    invalid('$.graph', 'pinned graph differs from the exact supplied Flow source');
  const draft = {
    schema_version: 'compiled-capability-closure/1' as const,
    root: source.root,
    assembly_pins: source.dependency_manifest.dependencies,
    bindings: [],
    gate_specs: prepareFlowGateSpecs(rootInput).gate_specs,
    resource_nodes: [
      {
        node_id: graph.root_node_id,
        node_role: 'root' as const,
        pin: source.root.pin,
        dependency_manifest_hash: source.dependency_manifest.manifest_hash,
        intrinsic_policy: intrinsicPolicy,
      },
      ...graph.nodes
        .filter((node) => node.node_id !== graph.root_node_id)
        .map((node) => ({
          node_id: node.node_id,
          node_role: 'dependency' as const,
          pin: node.pin,
          dependency_manifest_hash: node.dependency_manifest_hash,
          intrinsic_policy: emptyExpression,
        })),
    ].sort((left, right) => compareCanonicalStrings(left.node_id, right.node_id)),
    dependency_edges:
      linear === undefined
        ? []
        : [
            {
              from_node_id: graph.root_node_id,
              to_node_id: canonicalResourceNodeId(linear.model),
              relation: 'typed_internal_dependency' as const,
              source_path: canonicalBindingPath([{ segment_kind: 'root', pin: source.root.pin }]),
            },
          ],
    disabled_binding_paths: [],
    aggregate_limits:
      linear === undefined
        ? emptyLimits
        : {
            credential_requirements: [linear.requirement],
            principal_modes: linear.requirement.allowed_principal_modes,
            egress: [],
            readable_data_classification_ceiling: 'public' as const,
            output_data_classification: 'public' as const,
            side_effect: { maximum_class: 'safe' as const, approval: 'none' as const },
            operation_contract_hashes: [],
            max_calls: 1,
            max_depth: 0,
            max_parallelism: 1,
            budget,
          },
  };
  return prepareCompiledCapabilityClosure({
    ...draft,
    closure_hash: canonicalSha256ExcludingRootKeys(draft, ['closure_hash']),
  });
}
