import type { Pool } from 'pg';

import {
  executeProductFlow,
  type ProductFlowGraph,
  validateProductFlowGraph,
} from './flow-runtime.js';

export const PRODUCT_MODELS = ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol'] as const;
export type ProductModel = (typeof PRODUCT_MODELS)[number];

export interface AgentDraft {
  readonly createdAt: string;
  readonly description: string;
  readonly id: string;
  readonly instructions: string;
  readonly model: ProductModel;
  readonly name: string;
  readonly revision: number;
  readonly status: 'draft' | 'published';
  readonly updatedAt: string;
}

export interface AgentDraftInput {
  readonly description: string;
  readonly instructions: string;
  readonly model: ProductModel;
  readonly name: string;
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
  listRuns(workspaceId: string): Promise<readonly ProductRun[]>;
  publishAgent(
    workspaceId: string,
    actorId: string,
    agentId: string,
    expectedRevision: number,
  ): Promise<AgentDraft>;
  publishFlow(
    workspaceId: string,
    actorId: string,
    flowId: string,
    expectedRevision: number,
    environment: ProductFlowEnvironment,
  ): Promise<ProductFlowDraft>;
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

interface PreparedRunRow {
  readonly agent_id: string;
  readonly conversation_id: string;
  readonly history: unknown;
  readonly input_text: string;
  readonly instructions: string;
  readonly model: string;
  readonly run_id: string;
  readonly sequence: string | number;
}

interface AgentRow {
  readonly created_at: Date | string;
  readonly description: string;
  readonly id: string;
  readonly instructions: string;
  readonly model: string;
  readonly name: string;
  readonly revision: string | number;
  readonly status: string;
  readonly updated_at: Date | string;
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
  return Object.freeze({
    createdAt: asIso(row.created_at),
    description: row.description,
    id: row.id,
    instructions: row.instructions,
    model: row.model as ProductModel,
    name: row.name,
    revision,
    status: row.status,
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

export class PostgresProductStore implements ProductStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
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

  async listAgents(workspaceId: string): Promise<readonly AgentDraft[]> {
    const result = await this.#pool.query<AgentRow>(
      'SELECT * FROM app.list_agent_drafts($1::uuid)',
      [workspaceId],
    );
    return Object.freeze(result.rows.map(toDraft));
  }

  async createAgent(
    workspaceId: string,
    actorId: string,
    input: AgentDraftInput,
  ): Promise<AgentDraft> {
    const result = await this.#pool.query<AgentRow>(
      'SELECT * FROM app.create_agent_draft($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)',
      [workspaceId, actorId, input.name, input.description, input.instructions, input.model],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the created Agent');
    return toDraft(row);
  }

  async updateAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    input: AgentDraftInput,
  ): Promise<AgentDraft> {
    const result = await this.#pool.query<AgentRow>(
      'SELECT * FROM app.update_agent_draft($1::uuid, $2::uuid, $3::bigint, $4::text, $5::text, $6::text, $7::text)',
      [
        workspaceId,
        agentId,
        expectedRevision,
        input.name,
        input.description,
        input.instructions,
        input.model,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the updated Agent');
    return toDraft(row);
  }

  async publishAgent(
    workspaceId: string,
    actorId: string,
    agentId: string,
    expectedRevision: number,
  ): Promise<AgentDraft> {
    const result = await this.#pool.query<AgentRow>(
      'SELECT * FROM app.publish_agent_draft($1::uuid, $2::uuid, $3::bigint, $4::uuid)',
      [workspaceId, agentId, expectedRevision, actorId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('product store did not return the published Agent');
    return toDraft(row);
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
      (key) => !['name', 'description', 'instructions', 'model'].includes(key),
    )
  ) {
    throw new Error('Agent payload contains unknown fields');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : '';
  if (name.length < 1 || name.length > 80)
    throw new Error('Agent name must contain 1–80 characters');
  if (description.length > 500) throw new Error('Agent description must not exceed 500 characters');
  if (instructions.length < 1 || instructions.length > 20_000) {
    throw new Error('Agent instructions must contain 1–20,000 characters');
  }
  if (!PRODUCT_MODELS.includes(input.model as ProductModel))
    throw new Error('Agent model is unsupported');
  return Object.freeze({
    description,
    instructions,
    model: input.model as ProductModel,
    name,
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
