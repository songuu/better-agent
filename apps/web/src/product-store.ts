import type { Pool } from 'pg';

import {
  executeProductFlow,
  type ProductFlowGraph,
  validateProductFlowGraph,
} from './flow-runtime.js';
import { splitKnowledgeText } from './knowledge-runtime.js';

export const PRODUCT_MODELS = ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol'] as const;
export type ProductModel = (typeof PRODUCT_MODELS)[number];
export type ProductAgentRoutingMode = 'autonomous' | 'fixed';
export type ProductAgentForcedCapability = 'database' | 'knowledge' | 'none';
export interface ProductAgentModelRoute {
  readonly description: string;
  readonly model: ProductModel;
}
export interface ProductAgentStrategyProfile {
  readonly forcedCapability: ProductAgentForcedCapability;
  readonly maxInputTokens: number;
  readonly maxIterations: 1;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
  readonly parameterExtraction: boolean;
  readonly routes: readonly ProductAgentModelRoute[];
  readonly routingMode: ProductAgentRoutingMode;
  readonly schemaVersion: 'product-agent-strategy/1';
  readonly temperature: number;
}
export const PRODUCT_AGENT_ROLE_THEMES = [
  'identity',
  'objective',
  'audience',
  'expertise',
  'tone',
  'constraints',
  'process',
] as const;
export type ProductAgentRoleTheme = (typeof PRODUCT_AGENT_ROLE_THEMES)[number];
export type ProductAgentRoleMode = 'structured' | 'text';
export interface ProductAgentRoleSection {
  readonly content: string;
  readonly weight: number;
}
export type ProductAgentRoleProfile = Readonly<
  Record<ProductAgentRoleTheme, ProductAgentRoleSection>
>;
const PRODUCT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AgentDraft {
  readonly createdAt: string;
  readonly databaseTableId: string | null;
  readonly description: string;
  readonly id: string;
  readonly instructions: string;
  readonly knowledgeBaseId: string | null;
  readonly model: ProductModel;
  readonly name: string;
  readonly revision: number;
  readonly roleMode: ProductAgentRoleMode;
  readonly roleProfile: ProductAgentRoleProfile | null;
  readonly status: 'draft' | 'published';
  readonly strategyProfile: ProductAgentStrategyProfile;
  readonly strategyVersion: number;
  readonly updatedAt: string;
}

export interface AgentDraftInput {
  readonly databaseTableId: string | null;
  readonly description: string;
  readonly instructions: string;
  readonly knowledgeBaseId: string | null;
  readonly model: ProductModel;
  readonly name: string;
  readonly roleMode: ProductAgentRoleMode;
  readonly roleProfile: ProductAgentRoleProfile | null;
  readonly strategyProfile: ProductAgentStrategyProfile;
}

export interface ProductRunInput {
  readonly message: string;
}

export interface ProductConversation {
  readonly agentId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly releaseVersion: number;
  readonly updatedAt: string;
}

export interface ProductRun {
  readonly completedAt: string | null;
  readonly conversationId: string;
  readonly createdAt: string;
  readonly errorCode: string | null;
  readonly id: string;
  readonly inputText: string;
  readonly inputTokens: number;
  readonly model: ProductModel;
  readonly outputText: string | null;
  readonly outputTokens: number;
  readonly providerRequestId: string | null;
  readonly sequence: number;
  readonly status: 'pending' | 'completed' | 'failed';
}

export interface PreparedProductRun {
  readonly agentId: string;
  readonly conversationId: string;
  readonly history: readonly { readonly assistant: string; readonly user: string }[];
  readonly inputText: string;
  readonly instructions: string;
  readonly model: ProductModel;
  readonly runId: string;
  readonly sequence: number;
  readonly strategyProfile: ProductAgentStrategyProfile;
  readonly strategyVersion: number;
}

export const PRODUCT_FLOW_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type ProductFlowEnvironment = (typeof PRODUCT_FLOW_ENVIRONMENTS)[number];

export interface ProductFlowDeployment {
  readonly deployedAt: string;
  readonly environment: ProductFlowEnvironment;
  readonly releaseVersion: number;
}

export interface ProductFlowDraftInput {
  readonly description: string;
  readonly graph: ProductFlowGraph;
  readonly name: string;
}

export interface ProductFlowDraft extends ProductFlowDraftInput {
  readonly createdAt: string;
  readonly deployments: readonly ProductFlowDeployment[];
  readonly id: string;
  readonly publishedVersion: number | null;
  readonly revision: number;
  readonly status: 'draft' | 'published';
  readonly updatedAt: string;
}

export interface ProductFlowDebugRun {
  readonly createdAt: string;
  readonly draftRevision: number;
  readonly flowId: string;
  readonly id: string;
  readonly inputText: string;
  readonly logs: readonly {
    readonly nodeId: string;
    readonly outputPreview: string;
    readonly status: 'completed';
  }[];
  readonly outputText: string;
  readonly status: 'completed';
}

export interface ProductKnowledgeBase {
  readonly createdAt: string;
  readonly description: string;
  readonly documentCount: number;
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

export interface ProductKnowledgeDocument {
  readonly chunkCount: number;
  readonly createdAt: string;
  readonly id: string;
  readonly knowledgeBaseId: string;
  readonly title: string;
}

export interface ProductKnowledgeHit {
  readonly content: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly ordinal: number;
  readonly score: number;
}

export interface ProductKnowledgeBaseInput {
  readonly description: string;
  readonly name: string;
}

export interface ProductKnowledgeDocumentInput {
  readonly content: string;
  readonly title: string;
}

export interface ProductDatabaseTable {
  readonly columns: readonly string[];
  readonly createdAt: string;
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly rowCount: number;
  readonly updatedAt: string;
}

export interface ProductDatabaseTableInput {
  readonly columns: readonly string[];
  readonly description: string;
  readonly name: string;
}

export interface ProductDatabaseRow {
  readonly createdAt: string;
  readonly ordinal: number;
  readonly record: Readonly<Record<string, boolean | null | number | string>>;
}

export interface ProductAgentDatabaseRecord {
  readonly columns: readonly string[];
  readonly ordinal: number;
  readonly record: Readonly<Record<string, boolean | null | number | string>>;
  readonly tableName: string;
}

export interface ProductDatabaseRowsInput {
  readonly rows: readonly Readonly<Record<string, boolean | null | number | string>>[];
}

export interface ProductDatabaseQueryInput {
  readonly column: string;
  readonly contains: string;
  readonly limit: number;
}

export interface ProductReleaseEvaluationTarget {
  readonly environments: readonly string[];
  readonly failedEvidenceCount: number;
  readonly id: string;
  readonly kind: 'agent' | 'flow';
  readonly model: ProductModel | null;
  readonly name: string;
  readonly publishedAt: string;
  readonly releaseVersion: number;
  readonly successfulEvidenceCount: number;
  readonly totalEvidenceCount: number;
}

export interface ProductStore {
  beginRun(
    workspaceId: string,
    actorId: string,
    conversationId: string,
    input: ProductRunInput,
  ): Promise<PreparedProductRun>;
  completeRun(
    workspaceId: string,
    actorId: string,
    runId: string,
    output: {
      readonly inputTokens: number;
      readonly outputText: string;
      readonly outputTokens: number;
      readonly providerRequestId: string;
    },
  ): Promise<ProductRun>;
  createAgent(workspaceId: string, actorId: string, input: AgentDraftInput): Promise<AgentDraft>;
  createConversation(
    workspaceId: string,
    actorId: string,
    agentId: string,
  ): Promise<ProductConversation>;
  failRun(
    workspaceId: string,
    actorId: string,
    runId: string,
    errorCode: string,
  ): Promise<ProductRun>;
  createFlow(
    workspaceId: string,
    actorId: string,
    input: ProductFlowDraftInput,
  ): Promise<ProductFlowDraft>;
  createKnowledgeBase(
    workspaceId: string,
    actorId: string,
    input: ProductKnowledgeBaseInput,
  ): Promise<ProductKnowledgeBase>;
  createDatabaseTable(
    workspaceId: string,
    actorId: string,
    input: ProductDatabaseTableInput,
  ): Promise<ProductDatabaseTable>;
  appendDatabaseRows(
    workspaceId: string,
    actorId: string,
    tableId: string,
    input: ProductDatabaseRowsInput,
  ): Promise<number>;
  ingestKnowledgeDocument(
    workspaceId: string,
    actorId: string,
    knowledgeBaseId: string,
    input: ProductKnowledgeDocumentInput,
  ): Promise<ProductKnowledgeDocument>;
  debugFlow(
    workspaceId: string,
    actorId: string,
    flowId: string,
    expectedRevision: number,
    inputText: string,
  ): Promise<ProductFlowDebugRun>;
  listAgents(workspaceId: string): Promise<readonly AgentDraft[]>;
  listFlowDebugRuns(workspaceId: string, flowId: string): Promise<readonly ProductFlowDebugRun[]>;
  listFlows(workspaceId: string): Promise<readonly ProductFlowDraft[]>;
  listKnowledgeBases(workspaceId: string): Promise<readonly ProductKnowledgeBase[]>;
  listDatabaseTables(workspaceId: string): Promise<readonly ProductDatabaseTable[]>;
  readAgentDatabase(
    workspaceId: string,
    conversationId: string,
  ): Promise<readonly ProductAgentDatabaseRecord[]>;
  listKnowledgeDocuments(
    workspaceId: string,
    knowledgeBaseId: string,
  ): Promise<readonly ProductKnowledgeDocument[]>;
  listRuns(workspaceId: string): Promise<readonly ProductRun[]>;
  listReleaseEvaluationTargets(
    workspaceId: string,
  ): Promise<readonly ProductReleaseEvaluationTarget[]>;
  publishAgent(
    workspaceId: string,
    actorId: string,
    agentId: string,
    expectedRevision: number,
  ): Promise<AgentDraft>;
  routeRun?(
    workspaceId: string,
    actorId: string,
    runId: string,
    route: {
      readonly inputTokens: number;
      readonly model: ProductModel;
      readonly outputTokens: number;
      readonly providerRequestId: string;
    },
  ): Promise<void>;
  searchAgentKnowledge(
    workspaceId: string,
    conversationId: string,
    query: string,
  ): Promise<readonly ProductKnowledgeHit[]>;
  publishFlow(
    workspaceId: string,
    actorId: string,
    flowId: string,
    expectedRevision: number,
    environment: ProductFlowEnvironment,
  ): Promise<ProductFlowDraft>;
  searchKnowledge(
    workspaceId: string,
    knowledgeBaseId: string,
    query: string,
  ): Promise<readonly ProductKnowledgeHit[]>;
  queryDatabaseTable(
    workspaceId: string,
    tableId: string,
    input: ProductDatabaseQueryInput,
  ): Promise<readonly ProductDatabaseRow[]>;
  updateAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    input: AgentDraftInput,
  ): Promise<AgentDraft>;
  updateFlow(
    workspaceId: string,
    flowId: string,
    expectedRevision: number,
    input: ProductFlowDraftInput,
  ): Promise<ProductFlowDraft>;
}

interface FlowRow {
  readonly created_at: Date | string;
  readonly deployments: unknown;
  readonly description: string;
  readonly graph: unknown;
  readonly id: string;
  readonly name: string;
  readonly published_version: string | number | null;
  readonly revision: string | number;
  readonly status: string;
  readonly updated_at: Date | string;
}

interface FlowDebugRow {
  readonly created_at: Date | string;
  readonly draft_revision: string | number;
  readonly flow_id: string;
  readonly id: string;
  readonly input_text: string;
  readonly logs: unknown;
  readonly output_text: string;
  readonly status: string;
}

interface KnowledgeBaseRow {
  readonly created_at: Date | string;
  readonly description: string;
  readonly document_count: string | number;
  readonly id: string;
  readonly name: string;
  readonly updated_at: Date | string;
}

interface KnowledgeDocumentRow {
  readonly chunk_count: string | number;
  readonly created_at: Date | string;
  readonly id: string;
  readonly knowledge_base_id: string;
  readonly title: string;
}

interface KnowledgeHitRow {
  readonly content: string;
  readonly document_id: string;
  readonly document_title: string;
  readonly ordinal: string | number;
  readonly score: string | number;
}

interface DatabaseTableRow {
  readonly columns: unknown;
  readonly created_at: Date | string;
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly row_count: string | number;
  readonly updated_at: Date | string;
}

interface DatabaseRecordRow {
  readonly created_at: Date | string;
  readonly ordinal: string | number;
  readonly record: unknown;
}

interface AgentDatabaseRecordRow {
  readonly columns: unknown;
  readonly record: unknown;
  readonly row_ordinal: string | number;
  readonly table_name: string;
}

interface ConversationRow {
  readonly agent_id: string;
  readonly created_at: Date | string;
  readonly id: string;
  readonly release_version: string | number;
  readonly updated_at: Date | string;
}

interface ProductRunRow {
  readonly completed_at: Date | string | null;
  readonly conversation_id: string;
  readonly created_at: Date | string;
  readonly error_code: string | null;
  readonly id: string;
  readonly input_text: string;
  readonly input_tokens: string | number;
  readonly model: string;
  readonly output_text: string | null;
  readonly output_tokens: string | number;
  readonly provider_request_id: string | null;
  readonly sequence: string | number;
  readonly status: string;
}

interface ProductReleaseEvaluationTargetRow {
  readonly environments: unknown;
  readonly failed_evidence_count: string | number;
  readonly model: string | null;
  readonly name: string;
  readonly published_at: Date | string;
  readonly release_version: string | number;
  readonly successful_evidence_count: string | number;
  readonly target_id: string;
  readonly target_kind: string;
  readonly total_evidence_count: string | number;
}

interface PreparedRunRow {
  readonly agent_id: string;
  readonly conversation_id: string;
  readonly history: unknown;
  readonly input_text: string;
  readonly instructions: string;
  readonly model: string;
  readonly run_id: string;
  readonly sequence: string | number;
  readonly strategy_profile: unknown;
  readonly strategy_version: string | number;
}

interface AgentRow {
  readonly created_at: Date | string;
  readonly description: string;
  readonly database_table_id: string | null;
  readonly id: string;
  readonly instructions: string;
  readonly knowledge_base_id: string | null;
  readonly model: string;
  readonly name: string;
  readonly revision: string | number;
  readonly role_mode: string;
  readonly role_profile: unknown;
  readonly status: string;
  readonly strategy_profile: unknown;
  readonly strategy_version: string | number;
  readonly updated_at: Date | string;
}

export function createDefaultAgentStrategyProfile(
  model: ProductModel,
): ProductAgentStrategyProfile {
  return Object.freeze({
    forcedCapability: 'none',
    maxInputTokens: 32_000,
    maxIterations: 1,
    maxOutputTokens: 2_000,
    maxToolCalls: 2,
    parameterExtraction: false,
    routes: Object.freeze([Object.freeze({ description: '默认模型', model })]),
    routingMode: 'fixed',
    schemaVersion: 'product-agent-strategy/1',
    temperature: 0.2,
  });
}

function strategyValue(profile: Record<string, unknown>, camel: string, snake: string): unknown {
  return profile[camel] ?? profile[snake];
}

export function parseAgentStrategyProfile(value: unknown): ProductAgentStrategyProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Agent strategy profile must be an object');
  }
  const profile = value as Record<string, unknown>;
  const allowed = new Set([
    'forcedCapability',
    'forced_capability',
    'maxInputTokens',
    'max_input_tokens',
    'maxIterations',
    'max_iterations',
    'maxOutputTokens',
    'max_output_tokens',
    'maxToolCalls',
    'max_tool_calls',
    'parameterExtraction',
    'parameter_extraction',
    'routes',
    'routingMode',
    'routing_mode',
    'schemaVersion',
    'schema_version',
    'temperature',
  ]);
  if (Object.keys(profile).some((key) => !allowed.has(key))) {
    throw new Error('Agent strategy profile contains unknown fields');
  }
  const hasCamelKeys = Object.keys(profile).some((key) => /[A-Z]/u.test(key));
  const hasSnakeKeys = Object.keys(profile).some((key) => key.includes('_'));
  if (hasCamelKeys && hasSnakeKeys) {
    throw new Error('Agent strategy profile cannot mix API and domain field names');
  }
  const schemaVersion = strategyValue(profile, 'schemaVersion', 'schema_version');
  const routingMode = strategyValue(profile, 'routingMode', 'routing_mode');
  const forcedCapability = strategyValue(profile, 'forcedCapability', 'forced_capability');
  const parameterExtraction = strategyValue(profile, 'parameterExtraction', 'parameter_extraction');
  const maxIterations = strategyValue(profile, 'maxIterations', 'max_iterations');
  const maxToolCalls = strategyValue(profile, 'maxToolCalls', 'max_tool_calls');
  const maxInputTokens = strategyValue(profile, 'maxInputTokens', 'max_input_tokens');
  const maxOutputTokens = strategyValue(profile, 'maxOutputTokens', 'max_output_tokens');
  const routesValue = profile.routes;
  if (schemaVersion !== 'product-agent-strategy/1')
    throw new Error('Agent strategy schema is unsupported');
  if (routingMode !== 'fixed' && routingMode !== 'autonomous')
    throw new Error('Agent routing mode is invalid');
  if (!['none', 'knowledge', 'database'].includes(String(forcedCapability)))
    throw new Error('Agent forced capability is invalid');
  if (typeof parameterExtraction !== 'boolean')
    throw new Error('Agent parameter extraction flag is invalid');
  if (maxIterations !== 1)
    throw new Error('Agent strategy v1 supports exactly one model iteration');
  if (!Number.isSafeInteger(maxToolCalls) || Number(maxToolCalls) < 0 || Number(maxToolCalls) > 2)
    throw new Error('Agent tool call budget must be 0–2');
  if (forcedCapability !== 'none' && Number(maxToolCalls) < 1)
    throw new Error('A forced capability requires at least one tool call');
  if (
    !Number.isSafeInteger(maxInputTokens) ||
    Number(maxInputTokens) < 256 ||
    Number(maxInputTokens) > 128_000
  )
    throw new Error('Agent input token budget must be 256–128,000');
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    Number(maxOutputTokens) < 64 ||
    Number(maxOutputTokens) > 32_000
  )
    throw new Error('Agent output token budget must be 64–32,000');
  if (
    typeof profile.temperature !== 'number' ||
    !Number.isFinite(profile.temperature) ||
    profile.temperature < 0 ||
    profile.temperature > 2
  )
    throw new Error('Agent temperature must be 0–2');
  if (
    !Array.isArray(routesValue) ||
    routesValue.length < 1 ||
    routesValue.length > PRODUCT_MODELS.length
  )
    throw new Error('Agent strategy must contain 1–3 routes');
  const seen = new Set<string>();
  const routes = routesValue.map((candidate) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(',') !== 'description,model'
    )
      throw new Error('Agent model route is invalid');
    const route = candidate as Record<string, unknown>;
    const description = typeof route.description === 'string' ? route.description.trim() : '';
    if (
      !PRODUCT_MODELS.includes(route.model as ProductModel) ||
      description.length < 1 ||
      description.length > 200 ||
      seen.has(String(route.model))
    )
      throw new Error('Agent model route is invalid');
    seen.add(String(route.model));
    return Object.freeze({ description, model: route.model as ProductModel });
  });
  if (routingMode === 'autonomous' && routes.length < 2)
    throw new Error('Autonomous routing requires at least two model routes');
  return Object.freeze({
    forcedCapability: forcedCapability as ProductAgentForcedCapability,
    maxInputTokens: Number(maxInputTokens),
    maxIterations: 1,
    maxOutputTokens: Number(maxOutputTokens),
    maxToolCalls: Number(maxToolCalls),
    parameterExtraction,
    routes: Object.freeze(routes),
    routingMode,
    schemaVersion: 'product-agent-strategy/1',
    temperature: profile.temperature,
  });
}

function strategyProfileToStorage(profile: ProductAgentStrategyProfile): string {
  return JSON.stringify({
    forced_capability: profile.forcedCapability,
    max_input_tokens: profile.maxInputTokens,
    max_iterations: profile.maxIterations,
    max_output_tokens: profile.maxOutputTokens,
    max_tool_calls: profile.maxToolCalls,
    parameter_extraction: profile.parameterExtraction,
    routes: profile.routes,
    routing_mode: profile.routingMode,
    schema_version: profile.schemaVersion,
    temperature: profile.temperature,
  });
}

const PRODUCT_AGENT_ROLE_LABELS: Readonly<Record<ProductAgentRoleTheme, string>> = Object.freeze({
  audience: '服务对象',
  constraints: '边界约束',
  expertise: '专业能力',
  identity: '身份定位',
  objective: '核心目标',
  process: '工作流程',
  tone: '表达风格',
});

export function parseStructuredAgentRoleProfile(value: unknown): ProductAgentRoleProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Agent structured role profile must be an object');
  }
  const profile = value as Record<string, unknown>;
  const keys = Object.keys(profile).sort();
  const expectedKeys = [...PRODUCT_AGENT_ROLE_THEMES].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('Agent structured role profile must contain exactly seven themes');
  }
  const entries = PRODUCT_AGENT_ROLE_THEMES.map((theme) => {
    const candidate = profile[theme];
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Agent role theme ${theme} must be an object`);
    }
    const section = candidate as Record<string, unknown>;
    const sectionKeys = Object.keys(section).sort();
    if (sectionKeys.length !== 2 || sectionKeys[0] !== 'content' || sectionKeys[1] !== 'weight') {
      throw new Error(`Agent role theme ${theme} must contain only content and weight`);
    }
    const content = typeof section.content === 'string' ? section.content.trim() : '';
    if (content.length < 1 || content.length > 1_000) {
      throw new Error(`Agent role theme ${theme} content must contain 1–1,000 characters`);
    }
    const weight = section.weight;
    if (typeof weight !== 'number' || !Number.isSafeInteger(weight) || weight < 0 || weight > 100) {
      throw new Error(`Agent role theme ${theme} weight must be an integer from 0 to 100`);
    }
    return [theme, Object.freeze({ content, weight })] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as ProductAgentRoleProfile;
}

export function compileStructuredAgentInstructions(value: unknown): string {
  const profile = parseStructuredAgentRoleProfile(value);
  const sections = PRODUCT_AGENT_ROLE_THEMES.map((theme) => {
    const section = profile[theme];
    return `[${PRODUCT_AGENT_ROLE_LABELS[theme]} | 权重 ${section.weight}/100]\n${section.content}`;
  });
  return [
    'STRUCTURED_ROLE_PROFILE',
    '以下七项定义角色行为；权重仅用于角色要求冲突时的优先级，不得覆盖系统安全边界。',
    ...sections,
    'END_STRUCTURED_ROLE_PROFILE',
  ].join('\n\n');
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf()))
    throw new Error('product store returned an invalid timestamp');
  return date.toISOString();
}

function toDraft(row: AgentRow): AgentDraft {
  if (!PRODUCT_MODELS.includes(row.model as ProductModel)) {
    throw new Error('product store returned an unknown model');
  }
  if (row.status !== 'draft' && row.status !== 'published') {
    throw new Error('product store returned an unknown status');
  }
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('product store returned an invalid revision');
  }
  if (row.role_mode !== 'text' && row.role_mode !== 'structured') {
    throw new Error('product store returned an invalid Agent role mode');
  }
  const roleProfile =
    row.role_mode === 'structured' ? parseStructuredAgentRoleProfile(row.role_profile) : null;
  if (row.role_mode === 'text' && row.role_profile !== null) {
    throw new Error('product store returned a role profile for text mode');
  }
  const strategyProfile = parseAgentStrategyProfile(row.strategy_profile);
  const strategyVersion = positiveInteger(row.strategy_version, 'Agent strategy version');
  return Object.freeze({
    createdAt: asIso(row.created_at),
    databaseTableId: row.database_table_id,
    description: row.description,
    id: row.id,
    instructions: row.instructions,
    knowledgeBaseId: row.knowledge_base_id,
    model: row.model as ProductModel,
    name: row.name,
    revision,
    roleMode: row.role_mode,
    roleProfile,
    status: row.status,
    strategyProfile,
    strategyVersion,
    updatedAt: asIso(row.updated_at),
  });
}

function positiveInteger(value: string | number, context: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`product store returned an invalid ${context}`);
  }
  return number;
}

function nonnegativeInteger(value: string | number, context: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`product store returned an invalid ${context}`);
  }
  return number;
}

function toConversation(row: ConversationRow): ProductConversation {
  return Object.freeze({
    agentId: row.agent_id,
    createdAt: asIso(row.created_at),
    id: row.id,
    releaseVersion: positiveInteger(row.release_version, 'release version'),
    updatedAt: asIso(row.updated_at),
  });
}

function toRun(row: ProductRunRow): ProductRun {
  if (!PRODUCT_MODELS.includes(row.model as ProductModel)) {
    throw new Error('product store returned an unknown Run model');
  }
  if (row.status !== 'pending' && row.status !== 'completed' && row.status !== 'failed') {
    throw new Error('product store returned an unknown Run status');
  }
  return Object.freeze({
    completedAt: row.completed_at === null ? null : asIso(row.completed_at),
    conversationId: row.conversation_id,
    createdAt: asIso(row.created_at),
    errorCode: row.error_code,
    id: row.id,
    inputText: row.input_text,
    inputTokens: nonnegativeInteger(row.input_tokens, 'input token count'),
    model: row.model as ProductModel,
    outputText: row.output_text,
    outputTokens: nonnegativeInteger(row.output_tokens, 'output token count'),
    providerRequestId: row.provider_request_id,
    sequence: positiveInteger(row.sequence, 'Run sequence'),
    status: row.status,
  });
}

function toReleaseEvaluationTarget(
  row: ProductReleaseEvaluationTargetRow,
): ProductReleaseEvaluationTarget {
  if (row.target_kind !== 'agent' && row.target_kind !== 'flow') {
    throw new Error('product store returned an invalid release target kind');
  }
  if (row.model !== null && !PRODUCT_MODELS.includes(row.model as ProductModel)) {
    throw new Error('product store returned an invalid release target model');
  }
  if (
    !Array.isArray(row.environments) ||
    row.environments.some((value) => typeof value !== 'string')
  ) {
    throw new Error('product store returned invalid release environments');
  }
  return Object.freeze({
    environments: Object.freeze([...row.environments]) as readonly string[],
    failedEvidenceCount: nonnegativeInteger(row.failed_evidence_count, 'failed evidence count'),
    id: row.target_id,
    kind: row.target_kind,
    model: row.model as ProductModel | null,
    name: row.name,
    publishedAt: asIso(row.published_at),
    releaseVersion: positiveInteger(row.release_version, 'release version'),
    successfulEvidenceCount: nonnegativeInteger(
      row.successful_evidence_count,
      'successful evidence count',
    ),
    totalEvidenceCount: nonnegativeInteger(row.total_evidence_count, 'total evidence count'),
  });
}

function toPreparedRun(row: PreparedRunRow): PreparedProductRun {
  if (!PRODUCT_MODELS.includes(row.model as ProductModel)) {
    throw new Error('product store returned an unknown prepared Run model');
  }
  if (!Array.isArray(row.history)) throw new Error('product store returned invalid Run history');
  const history = row.history.map((turn) => {
    if (
      typeof turn !== 'object' ||
      turn === null ||
      typeof (turn as Record<string, unknown>).user !== 'string' ||
      typeof (turn as Record<string, unknown>).assistant !== 'string'
    ) {
      throw new Error('product store returned invalid Run history');
    }
    return Object.freeze({
      assistant: (turn as { assistant: string }).assistant,
      user: (turn as { user: string }).user,
    });
  });
  return Object.freeze({
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    history: Object.freeze(history),
    inputText: row.input_text,
    instructions: row.instructions,
    model: row.model as ProductModel,
    runId: row.run_id,
    sequence: positiveInteger(row.sequence, 'Run sequence'),
    strategyProfile: parseAgentStrategyProfile(row.strategy_profile),
    strategyVersion: positiveInteger(row.strategy_version, 'Run strategy version'),
  });
}

function toFlowDeployment(value: unknown): ProductFlowDeployment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('product store returned an invalid Flow deployment');
  }
  const deployment = value as Record<string, unknown>;
  if (!PRODUCT_FLOW_ENVIRONMENTS.includes(deployment.environment as ProductFlowEnvironment)) {
    throw new Error('product store returned an invalid Flow environment');
  }
  if (typeof deployment.deployed_at !== 'string') {
    throw new Error('product store returned an invalid Flow deployment timestamp');
  }
  return Object.freeze({
    deployedAt: asIso(deployment.deployed_at),
    environment: deployment.environment as ProductFlowEnvironment,
    releaseVersion: positiveInteger(
      deployment.release_version as string | number,
      'Flow release version',
    ),
  });
}

function toFlow(row: FlowRow): ProductFlowDraft {
  if (row.status !== 'draft' && row.status !== 'published') {
    throw new Error('product store returned an invalid Flow status');
  }
  if (!Array.isArray(row.deployments)) {
    throw new Error('product store returned invalid Flow deployments');
  }
  return Object.freeze({
    createdAt: asIso(row.created_at),
    deployments: Object.freeze(row.deployments.map(toFlowDeployment)),
    description: row.description,
    graph: validateProductFlowGraph(row.graph),
    id: row.id,
    name: row.name,
    publishedVersion:
      row.published_version === null
        ? null
        : positiveInteger(row.published_version, 'Flow published version'),
    revision: positiveInteger(row.revision, 'Flow revision'),
    status: row.status,
    updatedAt: asIso(row.updated_at),
  });
}

function toFlowDebug(row: FlowDebugRow): ProductFlowDebugRun {
  if (row.status !== 'completed' || !Array.isArray(row.logs)) {
    throw new Error('product store returned an invalid Flow debug status');
  }
  const logs = row.logs.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('product store returned invalid Flow debug logs');
    }
    const log = value as Record<string, unknown>;
    if (
      typeof log.nodeId !== 'string' ||
      typeof log.outputPreview !== 'string' ||
      log.status !== 'completed'
    ) {
      throw new Error('product store returned invalid Flow debug logs');
    }
    return Object.freeze({
      nodeId: log.nodeId,
      outputPreview: log.outputPreview,
      status: 'completed' as const,
    });
  });
  return Object.freeze({
    createdAt: asIso(row.created_at),
    draftRevision: positiveInteger(row.draft_revision, 'Flow debug revision'),
    flowId: row.flow_id,
    id: row.id,
    inputText: row.input_text,
    logs: Object.freeze(logs),
    outputText: row.output_text,
    status: 'completed',
  });
}

function toKnowledgeBase(row: KnowledgeBaseRow): ProductKnowledgeBase {
  return Object.freeze({
    createdAt: asIso(row.created_at),
    description: row.description,
    documentCount: nonnegativeInteger(row.document_count, 'Knowledge document count'),
    id: row.id,
    name: row.name,
    updatedAt: asIso(row.updated_at),
  });
}

function toKnowledgeDocument(row: KnowledgeDocumentRow): ProductKnowledgeDocument {
  return Object.freeze({
    chunkCount: positiveInteger(row.chunk_count, 'Knowledge chunk count'),
    createdAt: asIso(row.created_at),
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    title: row.title,
  });
}

function toKnowledgeHit(row: KnowledgeHitRow): ProductKnowledgeHit {
  const score = Number(row.score);
  if (!Number.isFinite(score) || score < 0) {
    throw new Error('product store returned an invalid Knowledge score');
  }
  return Object.freeze({
    content: row.content,
    documentId: row.document_id,
    documentTitle: row.document_title,
    ordinal: nonnegativeInteger(row.ordinal, 'Knowledge chunk ordinal'),
    score,
  });
}

function toDatabaseTable(row: DatabaseTableRow): ProductDatabaseTable {
  if (!Array.isArray(row.columns) || row.columns.some((column) => typeof column !== 'string')) {
    throw new Error('product store returned invalid Database columns');
  }
  return Object.freeze({
    columns: Object.freeze([...row.columns]) as readonly string[],
    createdAt: asIso(row.created_at),
    description: row.description,
    id: row.id,
    name: row.name,
    rowCount: nonnegativeInteger(row.row_count, 'Database row count'),
    updatedAt: asIso(row.updated_at),
  });
}

function toScalarDatabaseRecord(
  value: unknown,
): Readonly<Record<string, boolean | null | number | string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('product store returned an invalid Database record');
  }
  const record = Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => {
      if (fieldValue !== null && !['boolean', 'number', 'string'].includes(typeof fieldValue)) {
        throw new Error('product store returned an invalid Database field');
      }
      return [key, fieldValue as boolean | null | number | string];
    }),
  );
  return Object.freeze(record);
}

function toDatabaseRow(row: DatabaseRecordRow): ProductDatabaseRow {
  return Object.freeze({
    createdAt: asIso(row.created_at),
    ordinal: nonnegativeInteger(row.ordinal, 'Database row ordinal'),
    record: toScalarDatabaseRecord(row.record),
  });
}

function toAgentDatabaseRecord(row: AgentDatabaseRecordRow): ProductAgentDatabaseRecord {
  if (!Array.isArray(row.columns) || row.columns.some((column) => typeof column !== 'string')) {
    throw new Error('product store returned invalid Agent Database columns');
  }
  return Object.freeze({
    columns: Object.freeze([...row.columns]) as readonly string[],
    ordinal: nonnegativeInteger(row.row_ordinal, 'Agent Database row ordinal'),
    record: toScalarDatabaseRecord(row.record),
    tableName: row.table_name,
  });
}

export class PostgresProductStore implements ProductStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async #getAgent(workspaceId: string, agentId: string): Promise<AgentDraft> {
    const result = await this.#pool.query<AgentRow>(
      'SELECT * FROM app.list_agent_drafts_with_role_capabilities($1::uuid) AS agent WHERE agent.id = $2::uuid',
      [workspaceId, agentId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the Agent');
    return toDraft(row);
  }

  async #getFlow(workspaceId: string, flowId: string): Promise<ProductFlowDraft> {
    const result = await this.#pool.query<FlowRow>(
      'SELECT * FROM app.list_product_flow_drafts($1::uuid) AS flow WHERE flow.id = $2::uuid',
      [workspaceId, flowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the Flow');
    return toFlow(row);
  }

  async createFlow(
    workspaceId: string,
    actorId: string,
    input: ProductFlowDraftInput,
  ): Promise<ProductFlowDraft> {
    const result = await this.#pool.query<{ readonly id: string }>(
      'SELECT app.create_product_flow_draft($1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb) AS id',
      [workspaceId, actorId, input.name, input.description, JSON.stringify(input.graph)],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('product store did not create the Flow');
    return await this.#getFlow(workspaceId, id);
  }

  async updateFlow(
    workspaceId: string,
    flowId: string,
    expectedRevision: number,
    input: ProductFlowDraftInput,
  ): Promise<ProductFlowDraft> {
    await this.#pool.query(
      'SELECT app.update_product_flow_draft($1::uuid, $2::uuid, $3::bigint, $4::text, $5::text, $6::jsonb)',
      [
        workspaceId,
        flowId,
        expectedRevision,
        input.name,
        input.description,
        JSON.stringify(input.graph),
      ],
    );
    return await this.#getFlow(workspaceId, flowId);
  }

  async publishFlow(
    workspaceId: string,
    actorId: string,
    flowId: string,
    expectedRevision: number,
    environment: ProductFlowEnvironment,
  ): Promise<ProductFlowDraft> {
    await this.#pool.query(
      'SELECT app.publish_product_flow($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::text)',
      [workspaceId, flowId, expectedRevision, actorId, environment],
    );
    return await this.#getFlow(workspaceId, flowId);
  }

  async debugFlow(
    workspaceId: string,
    actorId: string,
    flowId: string,
    expectedRevision: number,
    inputText: string,
  ): Promise<ProductFlowDebugRun> {
    const prepared = await this.#pool.query<{ readonly graph: unknown }>(
      'SELECT app.prepare_product_flow_debug($1::uuid, $2::uuid, $3::bigint, $4::uuid) AS graph',
      [workspaceId, flowId, expectedRevision, actorId],
    );
    const graph = prepared.rows[0]?.graph;
    if (graph === undefined) throw new Error('product store did not prepare Flow debug');
    const result = executeProductFlow(graph, {
      input: validateFlowDebugInput({ input: inputText }),
    });
    const recorded = await this.#pool.query<FlowDebugRow>(
      'SELECT * FROM app.record_product_flow_debug($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::text, $6::text, $7::jsonb)',
      [
        workspaceId,
        flowId,
        expectedRevision,
        actorId,
        inputText.trim(),
        result.output,
        JSON.stringify(result.logs),
      ],
    );
    const row = recorded.rows[0];
    if (row === undefined) throw new Error('product store did not record Flow debug');
    return toFlowDebug(row);
  }

  async listFlows(workspaceId: string): Promise<readonly ProductFlowDraft[]> {
    const result = await this.#pool.query<FlowRow>(
      'SELECT * FROM app.list_product_flow_drafts($1::uuid)',
      [workspaceId],
    );
    return Object.freeze(result.rows.map(toFlow));
  }

  async listFlowDebugRuns(
    workspaceId: string,
    flowId: string,
  ): Promise<readonly ProductFlowDebugRun[]> {
    const result = await this.#pool.query<FlowDebugRow>(
      'SELECT * FROM app.list_product_flow_debug_runs($1::uuid, $2::uuid)',
      [workspaceId, flowId],
    );
    return Object.freeze(result.rows.map(toFlowDebug));
  }

  async #getKnowledgeBase(
    workspaceId: string,
    knowledgeBaseId: string,
  ): Promise<ProductKnowledgeBase> {
    const result = await this.#pool.query<KnowledgeBaseRow>(
      'SELECT * FROM app.list_product_knowledge_bases($1::uuid) AS base WHERE base.id = $2::uuid',
      [workspaceId, knowledgeBaseId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the Knowledge base');
    return toKnowledgeBase(row);
  }

  async #getDatabaseTable(workspaceId: string, tableId: string): Promise<ProductDatabaseTable> {
    const result = await this.#pool.query<DatabaseTableRow>(
      'SELECT * FROM app.list_product_database_tables($1::uuid) AS source WHERE source.id = $2::uuid',
      [workspaceId, tableId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the Database table');
    return toDatabaseTable(row);
  }

  async createDatabaseTable(
    workspaceId: string,
    actorId: string,
    input: ProductDatabaseTableInput,
  ): Promise<ProductDatabaseTable> {
    const result = await this.#pool.query<{ readonly id: string }>(
      'SELECT app.create_product_database_table($1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb) AS id',
      [workspaceId, actorId, input.name, input.description, JSON.stringify(input.columns)],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('product store did not create the Database table');
    return await this.#getDatabaseTable(workspaceId, id);
  }

  async appendDatabaseRows(
    workspaceId: string,
    actorId: string,
    tableId: string,
    input: ProductDatabaseRowsInput,
  ): Promise<number> {
    const result = await this.#pool.query<{ readonly count: string | number }>(
      'SELECT app.append_product_database_rows($1::uuid, $2::uuid, $3::uuid, $4::jsonb) AS count',
      [workspaceId, tableId, actorId, JSON.stringify(input.rows)],
    );
    return positiveInteger(result.rows[0]?.count ?? 0, 'appended Database row count');
  }

  async listDatabaseTables(workspaceId: string): Promise<readonly ProductDatabaseTable[]> {
    const result = await this.#pool.query<DatabaseTableRow>(
      'SELECT * FROM app.list_product_database_tables($1::uuid)',
      [workspaceId],
    );
    return Object.freeze(result.rows.map(toDatabaseTable));
  }

  async queryDatabaseTable(
    workspaceId: string,
    tableId: string,
    input: ProductDatabaseQueryInput,
  ): Promise<readonly ProductDatabaseRow[]> {
    const result = await this.#pool.query<DatabaseRecordRow>(
      'SELECT * FROM app.query_product_database_table($1::uuid, $2::uuid, $3::text, $4::text, $5::integer)',
      [workspaceId, tableId, input.column, input.contains, input.limit],
    );
    return Object.freeze(result.rows.map(toDatabaseRow));
  }

  async readAgentDatabase(
    workspaceId: string,
    conversationId: string,
  ): Promise<readonly ProductAgentDatabaseRecord[]> {
    const result = await this.#pool.query<AgentDatabaseRecordRow>(
      'SELECT * FROM app.read_agent_product_conversation_database($1::uuid, $2::uuid, 20)',
      [workspaceId, conversationId],
    );
    return Object.freeze(result.rows.map(toAgentDatabaseRecord));
  }

  async createKnowledgeBase(
    workspaceId: string,
    actorId: string,
    input: ProductKnowledgeBaseInput,
  ): Promise<ProductKnowledgeBase> {
    const result = await this.#pool.query<{ readonly id: string }>(
      'SELECT app.create_product_knowledge_base($1::uuid, $2::uuid, $3::text, $4::text) AS id',
      [workspaceId, actorId, input.name, input.description],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('product store did not create the Knowledge base');
    return await this.#getKnowledgeBase(workspaceId, id);
  }

  async ingestKnowledgeDocument(
    workspaceId: string,
    actorId: string,
    knowledgeBaseId: string,
    input: ProductKnowledgeDocumentInput,
  ): Promise<ProductKnowledgeDocument> {
    const chunks = splitKnowledgeText(input.content);
    const result = await this.#pool.query<KnowledgeDocumentRow>(
      'SELECT * FROM app.ingest_product_knowledge_document($1::uuid, $2::uuid, $3::uuid, $4::text, $5::jsonb)',
      [workspaceId, knowledgeBaseId, actorId, input.title, JSON.stringify(chunks)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not ingest the Knowledge document');
    return toKnowledgeDocument(row);
  }

  async listKnowledgeBases(workspaceId: string): Promise<readonly ProductKnowledgeBase[]> {
    const result = await this.#pool.query<KnowledgeBaseRow>(
      'SELECT * FROM app.list_product_knowledge_bases($1::uuid)',
      [workspaceId],
    );
    return Object.freeze(result.rows.map(toKnowledgeBase));
  }

  async listKnowledgeDocuments(
    workspaceId: string,
    knowledgeBaseId: string,
  ): Promise<readonly ProductKnowledgeDocument[]> {
    const result = await this.#pool.query<KnowledgeDocumentRow>(
      'SELECT * FROM app.list_product_knowledge_documents($1::uuid, $2::uuid)',
      [workspaceId, knowledgeBaseId],
    );
    return Object.freeze(result.rows.map(toKnowledgeDocument));
  }

  async searchKnowledge(
    workspaceId: string,
    knowledgeBaseId: string,
    query: string,
  ): Promise<readonly ProductKnowledgeHit[]> {
    const result = await this.#pool.query<KnowledgeHitRow>(
      'SELECT * FROM app.search_product_knowledge($1::uuid, $2::uuid, $3::text, 8)',
      [workspaceId, knowledgeBaseId, validateKnowledgeQuery(query)],
    );
    return Object.freeze(result.rows.map(toKnowledgeHit));
  }

  async searchAgentKnowledge(
    workspaceId: string,
    conversationId: string,
    query: string,
  ): Promise<readonly ProductKnowledgeHit[]> {
    const result = await this.#pool.query<KnowledgeHitRow>(
      'SELECT * FROM app.search_agent_product_conversation_knowledge($1::uuid, $2::uuid, $3::text, 8)',
      [workspaceId, conversationId, validateKnowledgeQuery(query)],
    );
    return Object.freeze(result.rows.map(toKnowledgeHit));
  }

  async createConversation(
    workspaceId: string,
    actorId: string,
    agentId: string,
  ): Promise<ProductConversation> {
    const result = await this.#pool.query<ConversationRow>(
      'SELECT * FROM app.create_agent_product_conversation($1::uuid, $2::uuid, $3::uuid)',
      [workspaceId, agentId, actorId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the conversation');
    return toConversation(row);
  }

  async beginRun(
    workspaceId: string,
    actorId: string,
    conversationId: string,
    input: ProductRunInput,
  ): Promise<PreparedProductRun> {
    const result = await this.#pool.query<PreparedRunRow>(
      'SELECT * FROM app.begin_agent_product_run($1::uuid, $2::uuid, $3::uuid, $4::text)',
      [workspaceId, conversationId, actorId, input.message],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not prepare the Run');
    return toPreparedRun(row);
  }

  async routeRun(
    workspaceId: string,
    actorId: string,
    runId: string,
    route: {
      readonly inputTokens: number;
      readonly model: ProductModel;
      readonly outputTokens: number;
      readonly providerRequestId: string;
    },
  ): Promise<void> {
    await this.#pool.query(
      'SELECT app.route_agent_product_run($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::bigint, $7::bigint)',
      [
        workspaceId,
        runId,
        actorId,
        route.model,
        route.providerRequestId,
        route.inputTokens,
        route.outputTokens,
      ],
    );
  }

  async completeRun(
    workspaceId: string,
    actorId: string,
    runId: string,
    output: {
      readonly inputTokens: number;
      readonly outputText: string;
      readonly outputTokens: number;
      readonly providerRequestId: string;
    },
  ): Promise<ProductRun> {
    const result = await this.#pool.query<ProductRunRow>(
      'SELECT * FROM app.complete_agent_product_run($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::bigint, $7::bigint)',
      [
        workspaceId,
        runId,
        actorId,
        output.outputText,
        output.providerRequestId,
        output.inputTokens,
        output.outputTokens,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not complete the Run');
    return toRun(row);
  }

  async failRun(
    workspaceId: string,
    actorId: string,
    runId: string,
    errorCode: string,
  ): Promise<ProductRun> {
    const result = await this.#pool.query<ProductRunRow>(
      'SELECT * FROM app.fail_agent_product_run($1::uuid, $2::uuid, $3::uuid, $4::text)',
      [workspaceId, runId, actorId, errorCode],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not fail the Run');
    return toRun(row);
  }

  async listRuns(workspaceId: string): Promise<readonly ProductRun[]> {
    const result = await this.#pool.query<ProductRunRow>(
      'SELECT * FROM app.list_agent_product_runs($1::uuid)',
      [workspaceId],
    );
    return Object.freeze(result.rows.map(toRun));
  }

  async listReleaseEvaluationTargets(
    workspaceId: string,
  ): Promise<readonly ProductReleaseEvaluationTarget[]> {
    const result = await this.#pool.query<ProductReleaseEvaluationTargetRow>(
      'SELECT * FROM app.list_product_release_evaluation_targets($1::uuid)',
      [workspaceId],
    );
    return Object.freeze(result.rows.map(toReleaseEvaluationTarget));
  }

  async listAgents(workspaceId: string): Promise<readonly AgentDraft[]> {
    const result = await this.#pool.query<AgentRow>(
      'SELECT * FROM app.list_agent_drafts_with_role_capabilities($1::uuid)',
      [workspaceId],
    );
    return Object.freeze(result.rows.map(toDraft));
  }

  async createAgent(
    workspaceId: string,
    actorId: string,
    input: AgentDraftInput,
  ): Promise<AgentDraft> {
    const result = await this.#pool.query<{ readonly id: string }>(
      'SELECT (app.create_agent_draft_with_strategy_capabilities($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::uuid, $8::uuid, $9::text, $10::jsonb, $11::jsonb)).id AS id',
      [
        workspaceId,
        actorId,
        input.name,
        input.description,
        input.instructions,
        input.model,
        input.knowledgeBaseId,
        input.databaseTableId,
        input.roleMode,
        input.roleProfile === null ? null : JSON.stringify(input.roleProfile),
        strategyProfileToStorage(input.strategyProfile),
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('product store did not return the created Agent');
    return await this.#getAgent(workspaceId, id);
  }

  async updateAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    input: AgentDraftInput,
  ): Promise<AgentDraft> {
    await this.#pool.query(
      'SELECT app.update_agent_draft_with_strategy_capabilities($1::uuid, $2::uuid, $3::bigint, $4::text, $5::text, $6::text, $7::text, $8::uuid, $9::uuid, $10::text, $11::jsonb, $12::jsonb)',
      [
        workspaceId,
        agentId,
        expectedRevision,
        input.name,
        input.description,
        input.instructions,
        input.model,
        input.knowledgeBaseId,
        input.databaseTableId,
        input.roleMode,
        input.roleProfile === null ? null : JSON.stringify(input.roleProfile),
        strategyProfileToStorage(input.strategyProfile),
      ],
    );
    return await this.#getAgent(workspaceId, agentId);
  }

  async publishAgent(
    workspaceId: string,
    actorId: string,
    agentId: string,
    expectedRevision: number,
  ): Promise<AgentDraft> {
    await this.#pool.query(
      'SELECT app.publish_agent_draft($1::uuid, $2::uuid, $3::bigint, $4::uuid)',
      [workspaceId, agentId, expectedRevision, actorId],
    );
    return await this.#getAgent(workspaceId, agentId);
  }
}

export async function createPostgresProductStore(connectionString?: string): Promise<ProductStore> {
  const { default: pg } = await import('pg');
  return new PostgresProductStore(
    new pg.Pool({
      allowExitOnIdle: true,
      ...(connectionString === undefined ? {} : { connectionString }),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      max: 8,
      statement_timeout: 8_000,
    }),
  );
}

export function validateAgentInput(value: unknown): AgentDraftInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Agent payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (!['name', 'description', 'instructions', 'model'].every((key) => key in input)) {
    throw new Error('Agent payload is incomplete');
  }
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'name',
          'description',
          'instructions',
          'model',
          'knowledge_base_id',
          'database_table_id',
          'role_mode',
          'role_profile',
          'strategy_profile',
        ].includes(key),
    )
  ) {
    throw new Error('Agent payload contains unknown fields');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const callerInstructions =
    typeof input.instructions === 'string' ? input.instructions.trim() : '';
  if (name.length < 1 || name.length > 80)
    throw new Error('Agent name must contain 1–80 characters');
  if (description.length > 500) throw new Error('Agent description must not exceed 500 characters');
  const roleMode = input.role_mode ?? 'text';
  if (roleMode !== 'text' && roleMode !== 'structured') {
    throw new Error('Agent role mode must be text or structured');
  }
  let roleProfile: ProductAgentRoleProfile | null = null;
  let instructions = callerInstructions;
  if (roleMode === 'structured') {
    roleProfile = parseStructuredAgentRoleProfile(input.role_profile);
    instructions = compileStructuredAgentInstructions(roleProfile);
  } else if (input.role_profile !== undefined && input.role_profile !== null) {
    throw new Error('Agent text role mode cannot contain a structured profile');
  }
  if (instructions.length < 1 || instructions.length > 20_000) {
    throw new Error('Agent instructions must contain 1–20,000 characters');
  }
  if (!PRODUCT_MODELS.includes(input.model as ProductModel))
    throw new Error('Agent model is unsupported');
  const strategyProfile =
    input.strategy_profile === undefined
      ? createDefaultAgentStrategyProfile(input.model as ProductModel)
      : parseAgentStrategyProfile(input.strategy_profile);
  if (!strategyProfile.routes.some((route) => route.model === input.model)) {
    throw new Error('Agent default model must be present in strategy routes');
  }
  const knowledgeBaseId = input.knowledge_base_id ?? null;
  if (
    knowledgeBaseId !== null &&
    (typeof knowledgeBaseId !== 'string' || !PRODUCT_UUID.test(knowledgeBaseId))
  ) {
    throw new Error('Agent Knowledge base id must be a UUID or null');
  }
  const databaseTableId = input.database_table_id ?? null;
  if (
    databaseTableId !== null &&
    (typeof databaseTableId !== 'string' || !PRODUCT_UUID.test(databaseTableId))
  ) {
    throw new Error('Agent Database table id must be a UUID or null');
  }
  if (strategyProfile.forcedCapability === 'knowledge' && knowledgeBaseId === null)
    throw new Error('A forced Knowledge call requires a bound Knowledge base');
  if (strategyProfile.forcedCapability === 'database' && databaseTableId === null)
    throw new Error('A forced Database call requires a bound Database table');
  return Object.freeze({
    databaseTableId,
    description,
    instructions,
    knowledgeBaseId,
    model: input.model as ProductModel,
    name,
    roleMode,
    roleProfile,
    strategyProfile,
  });
}

export function validateRunInput(value: unknown): ProductRunInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Run payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.message !== 'string') {
    throw new Error('Run payload must contain only a message');
  }
  const message = input.message.trim();
  if (message.length < 1 || message.length > 8_000) {
    throw new Error('Run message must contain 1–8,000 characters');
  }
  return Object.freeze({ message });
}

export function validateFlowDraftInput(value: unknown): ProductFlowDraftInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Flow payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    !['name', 'description', 'graph'].every((key) => Object.hasOwn(input, key))
  ) {
    throw new Error('Flow payload has an invalid shape');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description : '';
  if (name.length < 1 || name.length > 80) {
    throw new Error('Flow name must contain 1–80 characters');
  }
  if (description.length > 500) throw new Error('Flow description must not exceed 500 characters');
  return Object.freeze({
    description,
    graph: validateProductFlowGraph(input.graph),
    name,
  });
}

export function validateFlowDebugInput(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Flow debug payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.input !== 'string') {
    throw new Error('Flow debug payload must contain only input');
  }
  const text = input.input.trim();
  if (text.length < 1 || text.length > 8_000) {
    throw new Error('Flow debug input must contain 1–8,000 characters');
  }
  return text;
}

export function validateFlowEnvironment(value: unknown): ProductFlowEnvironment {
  if (!PRODUCT_FLOW_ENVIRONMENTS.includes(value as ProductFlowEnvironment)) {
    throw new Error('Flow environment is unsupported');
  }
  return value as ProductFlowEnvironment;
}

export function validateKnowledgeBaseInput(value: unknown): ProductKnowledgeBaseInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Knowledge base payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input.name !== 'string' ||
    typeof input.description !== 'string'
  ) {
    throw new Error('Knowledge base payload has an invalid shape');
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new Error('Knowledge base name must contain 1–80 characters');
  }
  if (input.description.length > 500) {
    throw new Error('Knowledge base description must not exceed 500 characters');
  }
  return Object.freeze({ description: input.description, name });
}

export function validateKnowledgeDocumentInput(value: unknown): ProductKnowledgeDocumentInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Knowledge document payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input.title !== 'string' ||
    typeof input.content !== 'string'
  ) {
    throw new Error('Knowledge document payload has an invalid shape');
  }
  const title = input.title.trim();
  if (title.length < 1 || title.length > 160) {
    throw new Error('Knowledge document title must contain 1–160 characters');
  }
  splitKnowledgeText(input.content);
  return Object.freeze({ content: input.content, title });
}

export function validateKnowledgeQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Knowledge query must be text');
  const query = value.trim();
  if (query.length < 1 || query.length > 500) {
    throw new Error('Knowledge query must contain 1–500 characters');
  }
  return query;
}

const DATABASE_COLUMN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;

export function validateDatabaseTableInput(value: unknown): ProductDatabaseTableInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Database table payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    typeof input.name !== 'string' ||
    typeof input.description !== 'string' ||
    !Array.isArray(input.columns)
  ) {
    throw new Error('Database table payload has an invalid shape');
  }
  const name = input.name.trim();
  const columns = input.columns.map((column) => (typeof column === 'string' ? column.trim() : ''));
  if (name.length < 1 || name.length > 80 || input.description.length > 500) {
    throw new Error('Database table metadata is invalid');
  }
  if (
    columns.length < 1 ||
    columns.length > 20 ||
    columns.some((column) => !DATABASE_COLUMN.test(column)) ||
    new Set(columns).size !== columns.length
  ) {
    throw new Error('Database columns must be 1–20 unique identifiers');
  }
  return Object.freeze({ columns: Object.freeze(columns), description: input.description, name });
}

export function validateDatabaseRowsInput(value: unknown): ProductDatabaseRowsInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Database rows payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Array.isArray(input.rows)) {
    throw new Error('Database rows payload must contain only rows');
  }
  if (input.rows.length < 1 || input.rows.length > 500) {
    throw new Error('Database row batch must contain 1–500 rows');
  }
  if (Buffer.byteLength(JSON.stringify(input.rows), 'utf8') > 1_048_576) {
    throw new Error('Database row batch must not exceed 1 MiB');
  }
  const rows = input.rows.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Database row must be an object');
    }
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).length < 1 ||
      Object.entries(row).some(
        ([key, field]) =>
          !DATABASE_COLUMN.test(key) ||
          (field !== null && !['boolean', 'number', 'string'].includes(typeof field)) ||
          (typeof field === 'number' && !Number.isFinite(field)),
      )
    ) {
      throw new Error('Database row fields must be scalar values');
    }
    return Object.freeze({ ...row }) as Readonly<Record<string, boolean | null | number | string>>;
  });
  return Object.freeze({ rows: Object.freeze(rows) });
}

export function validateDatabaseQueryInput(value: unknown): ProductDatabaseQueryInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Database query payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    typeof input.column !== 'string' ||
    typeof input.contains !== 'string' ||
    !Number.isSafeInteger(input.limit)
  ) {
    throw new Error('Database query payload has an invalid shape');
  }
  const column = input.column.trim();
  const contains = input.contains.trim();
  const limit = Number(input.limit);
  if (!DATABASE_COLUMN.test(column) || contains.length > 500 || limit < 1 || limit > 100) {
    throw new Error('Database query is invalid');
  }
  return Object.freeze({ column, contains, limit });
}
