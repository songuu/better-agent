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

export interface ProductStore {
  createAgent(workspaceId: string, actorId: string, input: AgentDraftInput): Promise<AgentDraft>;
  listAgents(workspaceId: string): Promise<readonly AgentDraft[]>;
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

export class PostgresProductStore implements ProductStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
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
