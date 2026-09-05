import type { Pool } from 'pg';

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
  listAgents(workspaceId: string): Promise<readonly AgentDraft[]>;
  listRuns(workspaceId: string): Promise<readonly ProductRun[]>;
  publishAgent(
    workspaceId: string,
    actorId: string,
    agentId: string,
    expectedRevision: number,
  ): Promise<AgentDraft>;
  updateAgent(
    workspaceId: string,
    agentId: string,
    expectedRevision: number,
    input: AgentDraftInput,
  ): Promise<AgentDraft>;
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

export class PostgresProductStore implements ProductStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
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
