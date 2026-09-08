import {
  type ProductApiExecutionRequest,
  validateProductApiEndpoint,
  validateProductApiResponsePath,
} from './api-runtime.js';

export type ProductFlowNode =
  | {
      readonly config: { readonly key: string };
      readonly id: string;
      readonly label: string;
      readonly type: 'input';
    }
  | {
      readonly config: { readonly template: string };
      readonly id: string;
      readonly label: string;
      readonly type: 'template';
    }
  | {
      readonly config: {
        readonly operand: string;
        readonly operator: ProductFlowConditionOperator;
        readonly source: string;
        readonly whenFalse: string;
        readonly whenTrue: string;
      };
      readonly id: string;
      readonly label: string;
      readonly type: 'condition';
    }
  | {
      readonly config: {
        readonly operation: ProductFlowTransformOperation;
        readonly source: string;
      };
      readonly id: string;
      readonly label: string;
      readonly type: 'transform';
    }
  | {
      readonly config: {
        readonly operation: ProductFlowBuiltinTextPluginOperation;
        readonly plugin: 'builtin.text.v1';
        readonly source: string;
      };
      readonly id: string;
      readonly label: string;
      readonly type: 'plugin';
    }
  | {
      readonly config: {
        readonly endpointUrl: string;
        readonly operation: string;
        readonly plugin: `custom.${string}.v${number}`;
        readonly pluginId: string;
        readonly pluginRevision: number;
        readonly responsePath: string;
        readonly source: string;
      };
      readonly id: string;
      readonly label: string;
      readonly type: 'plugin';
    }
  | {
      readonly config: {
        readonly apiId: string;
        readonly apiRevision: number;
        readonly method: 'GET' | 'POST';
        readonly responsePath: string;
        readonly source: string;
        readonly url: string;
      };
      readonly id: string;
      readonly label: string;
      readonly type: 'api';
    }
  | {
      readonly config: { readonly source: string };
      readonly id: string;
      readonly label: string;
      readonly type: 'output';
    };

export interface ProductFlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface ProductFlowGraph {
  readonly edges: readonly ProductFlowEdge[];
  readonly nodes: readonly ProductFlowNode[];
}

export interface ProductFlowDebugResult {
  readonly logs: readonly {
    readonly nodeId: string;
    readonly outputPreview: string;
    readonly status: 'completed';
  }[];
  readonly output: string;
}

export const PRODUCT_FLOW_CONDITION_OPERATORS = [
  'equals',
  'contains',
  'starts_with',
  'ends_with',
] as const;
export type ProductFlowConditionOperator = (typeof PRODUCT_FLOW_CONDITION_OPERATORS)[number];
export const PRODUCT_FLOW_TRANSFORM_OPERATIONS = ['trim', 'uppercase', 'lowercase'] as const;
export type ProductFlowTransformOperation = (typeof PRODUCT_FLOW_TRANSFORM_OPERATIONS)[number];
export const PRODUCT_FLOW_BUILTIN_TEXT_PLUGIN_OPERATIONS = [
  'character_count',
  'word_count',
] as const;
export type ProductFlowBuiltinTextPluginOperation =
  (typeof PRODUCT_FLOW_BUILTIN_TEXT_PLUGIN_OPERATIONS)[number];
type ProductFlowCustomPluginIdentity = `custom.${string}.v${number}`;
export type ProductFlowApiExecutor = (request: ProductApiExecutionRequest) => Promise<string>;

const PRODUCT_FLOW_BUILTIN_TEXT_PLUGIN_EXECUTORS: Readonly<
  Record<ProductFlowBuiltinTextPluginOperation, (input: string) => string>
> = Object.freeze({
  character_count: (input) => String([...input].length),
  word_count: (input) => String(input.trim() === '' ? 0 : input.trim().split(/\s+/u).length),
});

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,39}$/u;
const PLUGIN_OPERATION = /^[a-z][a-z0-9_]{0,39}$/u;
const TEMPLATE_REFERENCE = /\{\{\s*([a-z][a-z0-9_-]{0,39})\s*\}\}/gu;
const CONDITION_VALUE_REFERENCE = /\{\{\s*value\s*\}\}/gu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function closedObject(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(object, key))
  ) {
    throw new Error(`${context} has an invalid shape`);
  }
  return object;
}

function boundedText(value: unknown, min: number, max: number, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be text`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${context} must contain ${min}–${max} characters`);
  }
  return text;
}

function validateNode(value: unknown): ProductFlowNode {
  const node = closedObject(value, ['id', 'type', 'label', 'config'], 'Flow node');
  const id = boundedText(node.id, 1, 40, 'Flow node id');
  if (!IDENTIFIER.test(id)) throw new Error('Flow node id is invalid');
  const label = boundedText(node.label, 1, 80, 'Flow node label');
  if (node.type === 'input') {
    const config = closedObject(node.config, ['key'], 'Input node config');
    const key = boundedText(config.key, 1, 40, 'Input variable');
    if (!IDENTIFIER.test(key)) throw new Error('Input variable is invalid');
    return Object.freeze({ config: Object.freeze({ key }), id, label, type: 'input' });
  }
  if (node.type === 'template') {
    const config = closedObject(node.config, ['template'], 'Template node config');
    const template = boundedText(config.template, 1, 8_000, 'Template');
    return Object.freeze({ config: Object.freeze({ template }), id, label, type: 'template' });
  }
  if (node.type === 'condition') {
    const config = closedObject(
      node.config,
      ['source', 'operator', 'operand', 'whenTrue', 'whenFalse'],
      'Condition node config',
    );
    const source = boundedText(config.source, 1, 40, 'Condition source');
    if (!IDENTIFIER.test(source)) throw new Error('Condition source is invalid');
    if (
      !PRODUCT_FLOW_CONDITION_OPERATORS.includes(config.operator as ProductFlowConditionOperator)
    ) {
      throw new Error('Condition operator is unsupported');
    }
    const operand = boundedText(config.operand, 1, 1_000, 'Condition operand');
    const whenTrue = boundedText(config.whenTrue, 1, 8_000, 'Condition true output');
    const whenFalse = boundedText(config.whenFalse, 1, 8_000, 'Condition false output');
    return Object.freeze({
      config: Object.freeze({
        operand,
        operator: config.operator as ProductFlowConditionOperator,
        source,
        whenFalse,
        whenTrue,
      }),
      id,
      label,
      type: 'condition',
    });
  }
  if (node.type === 'transform') {
    const config = closedObject(node.config, ['source', 'operation'], 'Transform node config');
    const source = boundedText(config.source, 1, 40, 'Transform source');
    if (!IDENTIFIER.test(source)) throw new Error('Transform source is invalid');
    if (
      !PRODUCT_FLOW_TRANSFORM_OPERATIONS.includes(config.operation as ProductFlowTransformOperation)
    ) {
      throw new Error('Transform operation is unsupported');
    }
    return Object.freeze({
      config: Object.freeze({
        operation: config.operation as ProductFlowTransformOperation,
        source,
      }),
      id,
      label,
      type: 'transform',
    });
  }
  if (node.type === 'plugin') {
    const rawConfig = node.config as Record<string, unknown>;
    const custom = Object.hasOwn(rawConfig, 'pluginId');
    const config = closedObject(
      rawConfig,
      custom
        ? [
            'source',
            'plugin',
            'operation',
            'pluginId',
            'pluginRevision',
            'endpointUrl',
            'responsePath',
          ]
        : ['source', 'plugin', 'operation'],
      'Plugin node config',
    );
    const source = boundedText(config.source, 1, 40, 'Plugin source');
    if (!IDENTIFIER.test(source)) throw new Error('Plugin source is invalid');
    if (custom) {
      if (typeof config.pluginId !== 'string' || !UUID.test(config.pluginId)) {
        throw new Error('Plugin resource id is invalid');
      }
      if (!Number.isSafeInteger(config.pluginRevision) || (config.pluginRevision as number) < 1) {
        throw new Error('Plugin resource revision is invalid');
      }
      const operation = boundedText(config.operation, 1, 40, 'Plugin operation');
      if (!PLUGIN_OPERATION.test(operation)) throw new Error('Plugin operation is invalid');
      const identity =
        `custom.${config.pluginId.replaceAll('-', '')}.v${String(config.pluginRevision)}` as ProductFlowCustomPluginIdentity;
      if (config.plugin !== identity) throw new Error('Plugin identity does not match its release');
      const endpointUrl = validateProductApiEndpoint(config.endpointUrl as string).href;
      const responsePath = validateProductApiResponsePath(config.responsePath as string);
      return Object.freeze({
        config: Object.freeze({
          endpointUrl,
          operation,
          plugin: identity,
          pluginId: config.pluginId,
          pluginRevision: config.pluginRevision as number,
          responsePath,
          source,
        }),
        id,
        label,
        type: 'plugin',
      });
    }
    if (config.plugin !== 'builtin.text.v1') throw new Error('Plugin identity is unsupported');
    if (
      !PRODUCT_FLOW_BUILTIN_TEXT_PLUGIN_OPERATIONS.includes(
        config.operation as ProductFlowBuiltinTextPluginOperation,
      )
    ) {
      throw new Error('Plugin operation is unsupported');
    }
    return Object.freeze({
      config: Object.freeze({
        operation: config.operation as ProductFlowBuiltinTextPluginOperation,
        plugin: 'builtin.text.v1' as const,
        source,
      }),
      id,
      label,
      type: 'plugin',
    });
  }
  if (node.type === 'api') {
    const config = closedObject(
      node.config,
      ['source', 'apiId', 'apiRevision', 'method', 'url', 'responsePath'],
      'API node config',
    );
    const source = boundedText(config.source, 1, 40, 'API source');
    if (!IDENTIFIER.test(source)) throw new Error('API source is invalid');
    if (typeof config.apiId !== 'string' || !UUID.test(config.apiId)) {
      throw new Error('API resource id is invalid');
    }
    if (!Number.isSafeInteger(config.apiRevision) || (config.apiRevision as number) < 1) {
      throw new Error('API resource revision is invalid');
    }
    if (config.method !== 'GET' && config.method !== 'POST') {
      throw new Error('API method is unsupported');
    }
    const url = validateProductApiEndpoint(config.url as string).href;
    const responsePath = validateProductApiResponsePath(config.responsePath as string);
    return Object.freeze({
      config: Object.freeze({
        apiId: config.apiId,
        apiRevision: config.apiRevision as number,
        method: config.method,
        responsePath,
        source,
        url,
      }),
      id,
      label,
      type: 'api',
    });
  }
  if (node.type === 'output') {
    const config = closedObject(node.config, ['source'], 'Output node config');
    const source = boundedText(config.source, 1, 40, 'Output source');
    if (!IDENTIFIER.test(source)) throw new Error('Output source is invalid');
    return Object.freeze({ config: Object.freeze({ source }), id, label, type: 'output' });
  }
  throw new Error('Flow node type is unsupported');
}

function validateEdge(value: unknown): ProductFlowEdge {
  const edge = closedObject(value, ['id', 'source', 'target'], 'Flow edge');
  const id = boundedText(edge.id, 1, 40, 'Flow edge id');
  const source = boundedText(edge.source, 1, 40, 'Flow edge source');
  const target = boundedText(edge.target, 1, 40, 'Flow edge target');
  if (![id, source, target].every((part) => IDENTIFIER.test(part))) {
    throw new Error('Flow edge identifier is invalid');
  }
  if (source === target) throw new Error('Flow edge cannot reference itself');
  return Object.freeze({ id, source, target });
}

function graphOrder(graph: ProductFlowGraph): readonly ProductFlowNode[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      throw new Error('Flow edge references an unknown node');
    }
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = graph.nodes.filter((node) => incoming.get(node.id) === 0);
  const ordered: ProductFlowNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    ordered.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      const remaining = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) queue.push(nodeById.get(target) as ProductFlowNode);
    }
  }
  if (ordered.length !== graph.nodes.length) throw new Error('Flow graph must be acyclic');
  return Object.freeze(ordered);
}

export function validateProductFlowGraph(value: unknown): ProductFlowGraph {
  const input = closedObject(value, ['nodes', 'edges'], 'Flow graph');
  if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 32) {
    throw new Error('Flow graph must contain 2–32 nodes');
  }
  if (!Array.isArray(input.edges) || input.edges.length < 1 || input.edges.length > 64) {
    throw new Error('Flow graph must contain 1–64 edges');
  }
  const nodes = input.nodes.map(validateNode);
  const edges = input.edges.map(validateEdge);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new Error('Flow node ids must be unique');
  }
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
    throw new Error('Flow edge ids must be unique');
  }
  if (new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}`)).size !== edges.length) {
    throw new Error('Flow edges must be unique');
  }
  const inputs = nodes.filter((node) => node.type === 'input');
  const outputs = nodes.filter((node) => node.type === 'output');
  if (inputs.length !== 1 || outputs.length !== 1) {
    throw new Error('Flow graph requires exactly one input and one output node');
  }
  const graph = Object.freeze({ edges: Object.freeze(edges), nodes: Object.freeze(nodes) });
  graphOrder(graph);
  const incomingByTarget = new Map<string, Set<string>>();
  for (const edge of edges) {
    const incoming = incomingByTarget.get(edge.target) ?? new Set<string>();
    incoming.add(edge.source);
    incomingByTarget.set(edge.target, incoming);
  }
  const inputNode = inputs[0] as Extract<ProductFlowNode, { type: 'input' }>;
  const outputNode = outputs[0] as Extract<ProductFlowNode, { type: 'output' }>;
  if (!incomingByTarget.get(outputNode.id)?.has(outputNode.config.source)) {
    throw new Error('Output source must be connected to the output node');
  }
  for (const node of nodes) {
    if (node.type === 'template') {
      const references = [...node.config.template.matchAll(TEMPLATE_REFERENCE)].map(
        (match) => match[1] as string,
      );
      if (references.length === 0) throw new Error('Template must reference an input variable');
      const incoming = incomingByTarget.get(node.id) ?? new Set<string>();
      for (const reference of references) {
        if (reference !== inputNode.config.key && !incoming.has(reference)) {
          throw new Error(`Template references an unavailable variable: ${reference}`);
        }
      }
    } else if (node.type === 'condition') {
      if (!incomingByTarget.get(node.id)?.has(node.config.source)) {
        throw new Error('Condition source must be connected to the condition node');
      }
    } else if (node.type === 'transform') {
      if (!incomingByTarget.get(node.id)?.has(node.config.source)) {
        throw new Error('Transform source must be connected to the transform node');
      }
    } else if (node.type === 'plugin') {
      if (!incomingByTarget.get(node.id)?.has(node.config.source)) {
        throw new Error('Plugin source must be connected to the plugin node');
      }
    } else if (node.type === 'api') {
      if (!incomingByTarget.get(node.id)?.has(node.config.source)) {
        throw new Error('API source must be connected to the API node');
      }
    }
  }
  const reachable = new Set([inputNode.id]);
  for (const node of graphOrder(graph)) {
    if (!reachable.has(node.id)) continue;
    for (const edge of edges.filter((candidate) => candidate.source === node.id)) {
      reachable.add(edge.target);
    }
  }
  if (reachable.size !== nodes.length || !reachable.has(outputNode.id)) {
    throw new Error('Every Flow node must be reachable from input');
  }
  return graph;
}

interface ProductFlowExecutionState {
  readonly graph: ProductFlowGraph;
  readonly inputNode: Extract<ProductFlowNode, { type: 'input' }>;
  readonly inputText: string;
  readonly logs: { nodeId: string; outputPreview: string; status: 'completed' }[];
  readonly values: Map<string, string>;
}

function createExecutionState(graphValue: unknown, inputValue: unknown): ProductFlowExecutionState {
  const graph = validateProductFlowGraph(graphValue);
  const input = closedObject(inputValue, ['input'], 'Flow debug input');
  const inputText = boundedText(input.input, 1, 8_000, 'Flow debug input');
  return {
    graph,
    inputNode: graph.nodes.find((node) => node.type === 'input') as Extract<
      ProductFlowNode,
      { type: 'input' }
    >,
    inputText,
    logs: [],
    values: new Map<string, string>(),
  };
}

function executeLocalNode(node: ProductFlowNode, state: ProductFlowExecutionState): string {
  if (node.type === 'input') return state.inputText;
  if (node.type === 'template') {
    return node.config.template.replace(TEMPLATE_REFERENCE, (_match, reference: string) => {
      if (reference === state.inputNode.config.key) return state.inputText;
      const value = state.values.get(reference);
      if (value === undefined) throw new Error(`Flow variable is unavailable: ${reference}`);
      return value;
    });
  }
  if (node.type === 'condition') {
    const sourceValue = state.values.get(node.config.source);
    if (sourceValue === undefined) throw new Error('Flow condition source is unavailable');
    const matches =
      node.config.operator === 'equals'
        ? sourceValue === node.config.operand
        : node.config.operator === 'contains'
          ? sourceValue.includes(node.config.operand)
          : node.config.operator === 'starts_with'
            ? sourceValue.startsWith(node.config.operand)
            : sourceValue.endsWith(node.config.operand);
    const selected = matches ? node.config.whenTrue : node.config.whenFalse;
    return selected.replace(CONDITION_VALUE_REFERENCE, () => sourceValue);
  }
  if (node.type === 'transform') {
    const sourceValue = state.values.get(node.config.source);
    if (sourceValue === undefined) throw new Error('Flow transform source is unavailable');
    return node.config.operation === 'trim'
      ? sourceValue.trim()
      : node.config.operation === 'uppercase'
        ? sourceValue.toLocaleUpperCase()
        : sourceValue.toLocaleLowerCase();
  }
  if (node.type === 'plugin') {
    const sourceValue = state.values.get(node.config.source);
    if (sourceValue === undefined) throw new Error('Flow plugin source is unavailable');
    if ('endpointUrl' in node.config) {
      throw new Error('Flow custom Plugin node requires the secure API runtime');
    }
    return PRODUCT_FLOW_BUILTIN_TEXT_PLUGIN_EXECUTORS[node.config.operation](sourceValue);
  }
  if (node.type === 'api') throw new Error('Flow API node requires the secure API runtime');
  const value = state.values.get(node.config.source);
  if (value === undefined) throw new Error('Flow output source is unavailable');
  return value;
}

function recordNodeOutput(
  state: ProductFlowExecutionState,
  node: ProductFlowNode,
  output: string,
): void {
  if (output.length > 20_000) throw new Error('Flow debug output exceeds 20,000 characters');
  state.values.set(node.id, output);
  state.logs.push({ nodeId: node.id, outputPreview: output.slice(0, 200), status: 'completed' });
}

function completeExecution(state: ProductFlowExecutionState): ProductFlowDebugResult {
  const outputNode = state.graph.nodes.find((node) => node.type === 'output') as Extract<
    ProductFlowNode,
    { type: 'output' }
  >;
  return Object.freeze({
    logs: Object.freeze(state.logs.map((log) => Object.freeze(log))),
    output: state.values.get(outputNode.id) as string,
  });
}

export function executeProductFlow(
  graphValue: unknown,
  inputValue: unknown,
): ProductFlowDebugResult {
  const state = createExecutionState(graphValue, inputValue);
  for (const node of graphOrder(state.graph)) {
    recordNodeOutput(state, node, executeLocalNode(node, state));
  }
  return completeExecution(state);
}

export async function executeProductFlowWithApis(
  graphValue: unknown,
  inputValue: unknown,
  apiExecutor: ProductFlowApiExecutor,
): Promise<ProductFlowDebugResult> {
  const state = createExecutionState(graphValue, inputValue);
  for (const node of graphOrder(state.graph)) {
    let output: string;
    if (node.type === 'api') {
      const sourceValue = state.values.get(node.config.source);
      if (sourceValue === undefined) throw new Error('Flow API source is unavailable');
      output = await apiExecutor({
        input: sourceValue,
        method: node.config.method,
        responsePath: node.config.responsePath,
        url: node.config.url,
      });
    } else if (node.type === 'plugin' && 'endpointUrl' in node.config) {
      const sourceValue = state.values.get(node.config.source);
      if (sourceValue === undefined) throw new Error('Flow Plugin source is unavailable');
      output = await apiExecutor({
        input: sourceValue,
        method: 'POST',
        responsePath: node.config.responsePath,
        url: node.config.endpointUrl,
      });
    } else output = executeLocalNode(node, state);
    recordNodeOutput(state, node, output);
  }
  return completeExecution(state);
}
