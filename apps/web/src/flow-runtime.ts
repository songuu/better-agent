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

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,39}$/u;
const TEMPLATE_REFERENCE = /\{\{\s*([a-z][a-z0-9_-]{0,39})\s*\}\}/gu;
const CONDITION_VALUE_REFERENCE = /\{\{\s*value\s*\}\}/gu;

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

export function executeProductFlow(
  graphValue: unknown,
  inputValue: unknown,
): ProductFlowDebugResult {
  const graph = validateProductFlowGraph(graphValue);
  const input = closedObject(inputValue, ['input'], 'Flow debug input');
  const inputText = boundedText(input.input, 1, 8_000, 'Flow debug input');
  const values = new Map<string, string>();
  const logs: { nodeId: string; outputPreview: string; status: 'completed' }[] = [];
  const inputNode = graph.nodes.find((node) => node.type === 'input') as Extract<
    ProductFlowNode,
    { type: 'input' }
  >;
  for (const node of graphOrder(graph)) {
    let output: string;
    if (node.type === 'input') output = inputText;
    else if (node.type === 'template') {
      output = node.config.template.replace(TEMPLATE_REFERENCE, (_match, reference: string) => {
        if (reference === inputNode.config.key) return inputText;
        const value = values.get(reference);
        if (value === undefined) throw new Error(`Flow variable is unavailable: ${reference}`);
        return value;
      });
    } else if (node.type === 'condition') {
      const sourceValue = values.get(node.config.source);
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
      output = selected.replace(CONDITION_VALUE_REFERENCE, () => sourceValue);
    } else {
      const value = values.get(node.config.source);
      if (value === undefined) throw new Error('Flow output source is unavailable');
      output = value;
    }
    if (output.length > 20_000) throw new Error('Flow debug output exceeds 20,000 characters');
    values.set(node.id, output);
    logs.push({ nodeId: node.id, outputPreview: output.slice(0, 200), status: 'completed' });
  }
  const outputNode = graph.nodes.find((node) => node.type === 'output') as Extract<
    ProductFlowNode,
    { type: 'output' }
  >;
  return Object.freeze({
    logs: Object.freeze(logs.map((log) => Object.freeze(log))),
    output: values.get(outputNode.id) as string,
  });
}
