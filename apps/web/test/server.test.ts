import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type BetterAgentWebOptions,
  createBetterAgentWebServer,
  isInvokedEntrypoint,
  WEB_BASE_PATH,
} from '../src/server.js';
import type { ProductModelRuntime } from '../src/model-runtime.js';
import type {
  AgentDraft,
  AgentDraftInput,
  ProductConversation,
  ProductDatabaseRow,
  ProductDatabaseTable,
  ProductFlowDebugRun,
  ProductFlowDraft,
  ProductKnowledgeBase,
  ProductKnowledgeDocument,
  ProductKnowledgeHit,
  ProductReleaseEvaluationTarget,
  ProductRun,
  ProductStore,
} from '../src/product-store.js';
import { createDefaultAgentStrategyProfile } from '../src/product-store.js';

const openServers: Awaited<ReturnType<typeof createBetterAgentWebServer>>[] = [];
const execFileAsync = promisify(execFile);

async function compileServer(packageDirectory: string, releaseDirectory: string): Promise<void> {
  const compilerPath = join(
    packageDirectory,
    '..',
    '..',
    'node_modules',
    'typescript',
    'lib',
    'tsc.js',
  );
  try {
    await execFileAsync(
      process.execPath,
      [
        compilerPath,
        join(packageDirectory, 'src', 'server.ts'),
        '--ignoreConfig',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--outDir',
        join(releaseDirectory, 'dist'),
        '--skipLibCheck',
        '--target',
        'es2022',
        '--types',
        'node',
      ],
      { maxBuffer: 8_192 },
    );
  } catch (error) {
    throw new Error('failed to compile the current web server fixture', { cause: error });
  }
}

async function waitForListeningOrigin(child: ReturnType<typeof spawn>): Promise<string> {
  if (child.stdout === null || child.stderr === null) {
    throw new Error('web child process must expose stdout and stderr');
  }
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`web child did not listen before timeout; stderr=${stderr}`));
    }, 5_000);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      stdoutStream.off('data', onStdout);
      stderrStream.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-8_192);
      const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)\/better-agent\//u);
      if (match?.[1] !== undefined) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_192);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `web child exited before listening; code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`,
        ),
      );
    };

    stdoutStream.on('data', onStdout);
    stderrStream.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function start(options: BetterAgentWebOptions = {}): Promise<string> {
  const server = await createBetterAgentWebServer({
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    ...options,
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function rawGet(
  origin: string,
  path: string,
): Promise<{ readonly body: string; readonly status: number }> {
  const target = new URL(origin);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        method: 'GET',
        path,
        port: target.port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function localRequest(
  origin: string,
  path: string,
  options: {
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: string;
  } = {},
): Promise<Response> {
  const target = new URL(origin);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        method: options.method ?? 'GET',
        path,
        port: target.port,
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          const headers = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            headers.append(response.rawHeaders[index] ?? '', response.rawHeaders[index + 1] ?? '');
          }
          resolve(
            new Response(options.method === 'HEAD' ? null : Buffer.concat(chunks), {
              headers,
              status: response.statusCode ?? 500,
            }),
          );
        });
      },
    );
    request.once('error', reject);
    request.end(options.body);
  });
}

function productFixture(): {
  readonly agents: AgentDraft[];
  readonly conversations: ProductConversation[];
  readonly databaseRows: ProductDatabaseRow[];
  readonly databaseTables: ProductDatabaseTable[];
  readonly flowDebugRuns: ProductFlowDebugRun[];
  readonly flows: ProductFlowDraft[];
  readonly knowledgeBases: ProductKnowledgeBase[];
  readonly knowledgeDocuments: ProductKnowledgeDocument[];
  readonly runs: ProductRun[];
  readonly store: ProductStore;
} {
  const agents: AgentDraft[] = [];
  const conversations: ProductConversation[] = [];
  const databaseRows: ProductDatabaseRow[] = [];
  const databaseTables: ProductDatabaseTable[] = [];
  const flows: ProductFlowDraft[] = [];
  const flowDebugRuns: ProductFlowDebugRun[] = [];
  const knowledgeBases: ProductKnowledgeBase[] = [];
  const knowledgeDocuments: ProductKnowledgeDocument[] = [];
  const runs: ProductRun[] = [];
  const timestamp = '2026-09-03T00:00:00.000Z';
  const store: ProductStore = {
    async createDatabaseTable(_workspaceId, _actorId, input) {
      const table: ProductDatabaseTable = {
        ...input,
        createdAt: timestamp,
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        rowCount: 0,
        updatedAt: timestamp,
      };
      databaseTables.push(table);
      return table;
    },
    async appendDatabaseRows(_workspaceId, _actorId, tableId, input) {
      const table = databaseTables.find((item) => item.id === tableId);
      if (table === undefined) throw new Error('Database table not found');
      const offset = databaseRows.length;
      databaseRows.push(
        ...input.rows.map((record, index) => ({
          createdAt: timestamp,
          ordinal: offset + index,
          record,
        })),
      );
      databaseTables[databaseTables.indexOf(table)] = {
        ...table,
        rowCount: table.rowCount + input.rows.length,
      };
      return input.rows.length;
    },
    async listDatabaseTables() {
      return databaseTables;
    },
    async queryDatabaseTable(_workspaceId, _tableId, input) {
      return databaseRows
        .filter((row) => String(row.record[input.column] ?? '').includes(input.contains))
        .slice(0, input.limit);
    },
    async readAgentDatabase(_workspaceId, conversationId) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const agent = agents.find((item) => item.id === conversation?.agentId);
      const table = databaseTables.find((item) => item.id === agent?.databaseTableId);
      if (table === undefined) return [];
      return databaseRows.slice(0, 20).map((row) => ({
        columns: table.columns,
        ordinal: row.ordinal,
        record: row.record,
        tableName: table.name,
      }));
    },
    async createKnowledgeBase(_workspaceId, _actorId, input) {
      const knowledgeBase: ProductKnowledgeBase = {
        ...input,
        createdAt: timestamp,
        documentCount: 0,
        id: '88888888-8888-4888-8888-888888888888',
        updatedAt: timestamp,
      };
      knowledgeBases.push(knowledgeBase);
      return knowledgeBase;
    },
    async ingestKnowledgeDocument(_workspaceId, _actorId, knowledgeBaseId, input) {
      const knowledgeBase = knowledgeBases.find((item) => item.id === knowledgeBaseId);
      if (knowledgeBase === undefined) throw new Error('Knowledge base not found');
      const document: ProductKnowledgeDocument = {
        chunkCount: 1,
        createdAt: timestamp,
        id: '99999999-9999-4999-8999-999999999999',
        knowledgeBaseId,
        title: input.title,
      };
      knowledgeDocuments.push(document);
      knowledgeBases[knowledgeBases.indexOf(knowledgeBase)] = {
        ...knowledgeBase,
        documentCount: knowledgeBase.documentCount + 1,
      };
      return document;
    },
    async listKnowledgeBases() {
      return knowledgeBases;
    },
    async listKnowledgeDocuments(_workspaceId, knowledgeBaseId) {
      return knowledgeDocuments.filter((document) => document.knowledgeBaseId === knowledgeBaseId);
    },
    async searchKnowledge(_workspaceId, knowledgeBaseId, query) {
      const document = knowledgeDocuments.find((item) => item.knowledgeBaseId === knowledgeBaseId);
      if (document === undefined) return [];
      const hit: ProductKnowledgeHit = {
        content: `服务健康检查使用 /healthz。查询：${query}`,
        documentId: document.id,
        documentTitle: document.title,
        ordinal: 0,
        score: 0.75,
      };
      return [hit];
    },
    async searchAgentKnowledge(_workspaceId, conversationId, query) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const agent = agents.find((item) => item.id === conversation?.agentId);
      if (agent?.knowledgeBaseId === null || agent?.knowledgeBaseId === undefined) return [];
      return await store.searchKnowledge(_workspaceId, agent.knowledgeBaseId, query);
    },
    async createFlow(_workspaceId, _actorId, input) {
      const flow: ProductFlowDraft = {
        ...input,
        createdAt: timestamp,
        deployments: [],
        id: '66666666-6666-4666-8666-666666666666',
        publishedVersion: null,
        revision: 1,
        status: 'draft',
        updatedAt: timestamp,
      };
      flows.push(flow);
      return flow;
    },
    async updateFlow(_workspaceId, flowId, expectedRevision, input) {
      const index = flows.findIndex((flow) => flow.id === flowId);
      const current = flows[index];
      if (current === undefined || current.revision !== expectedRevision)
        throw new Error('Flow draft revision conflict');
      const flow: ProductFlowDraft = {
        ...current,
        ...input,
        revision: current.revision + 1,
        status: 'draft',
        updatedAt: timestamp,
      };
      flows[index] = flow;
      return flow;
    },
    async publishFlow(_workspaceId, _actorId, flowId, expectedRevision, environment) {
      const index = flows.findIndex((flow) => flow.id === flowId);
      const current = flows[index];
      if (current === undefined || current.revision !== expectedRevision)
        throw new Error('Flow draft revision conflict');
      const releaseVersion = (current.publishedVersion ?? 0) + 1;
      const flow: ProductFlowDraft = {
        ...current,
        deployments: [
          ...current.deployments.filter((deployment) => deployment.environment !== environment),
          { deployedAt: timestamp, environment, releaseVersion },
        ],
        publishedVersion: releaseVersion,
        revision: current.revision + 1,
        status: 'published',
        updatedAt: timestamp,
      };
      flows[index] = flow;
      return flow;
    },
    async debugFlow(_workspaceId, _actorId, flowId, expectedRevision, inputText) {
      const flow = flows.find((item) => item.id === flowId);
      if (flow === undefined || flow.revision !== expectedRevision)
        throw new Error('Flow draft revision conflict');
      const debug: ProductFlowDebugRun = {
        createdAt: timestamp,
        draftRevision: expectedRevision,
        flowId,
        id: '77777777-7777-4777-8777-777777777777',
        inputText,
        logs: flow.graph.nodes.map((node) => ({
          nodeId: node.id,
          outputPreview: `完成 ${node.label}`,
          status: 'completed' as const,
        })),
        outputText: `已处理：${inputText}`,
        status: 'completed',
      };
      flowDebugRuns.push(debug);
      return debug;
    },
    async listFlows() {
      return flows;
    },
    async listFlowDebugRuns(_workspaceId, flowId) {
      return flowDebugRuns.filter((run) => run.flowId === flowId);
    },
    async createConversation(_workspaceId, _actorId, agentId) {
      const agent = agents.find((item) => item.id === agentId && item.status === 'published');
      if (agent === undefined) throw new Error('agent has no published release');
      const conversation: ProductConversation = {
        agentId,
        createdAt: timestamp,
        id: '44444444-4444-4444-8444-444444444444',
        releaseVersion: 1,
        updatedAt: timestamp,
      };
      conversations.push(conversation);
      return conversation;
    },
    async beginRun(_workspaceId, _actorId, conversationId, input) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const agent = agents.find((item) => item.id === conversation?.agentId);
      if (conversation === undefined || agent === undefined)
        throw new Error('conversation not found');
      const sequence = runs.filter((item) => item.conversationId === conversationId).length + 1;
      const runId = `55555555-5555-4555-8555-${String(sequence).padStart(12, '0')}`;
      runs.push({
        completedAt: null,
        conversationId,
        createdAt: timestamp,
        errorCode: null,
        id: runId,
        inputText: input.message,
        inputTokens: 0,
        model: agent.model,
        outputText: null,
        outputTokens: 0,
        providerRequestId: null,
        sequence,
        status: 'pending',
      });
      return {
        agentId: agent.id,
        conversationId,
        history: [],
        inputText: input.message,
        instructions: agent.instructions,
        model: agent.model,
        runId,
        sequence,
        strategyProfile: agent.strategyProfile,
        strategyVersion: agent.strategyVersion,
      };
    },
    async completeRun(_workspaceId, _actorId, runId, output) {
      const index = runs.findIndex((item) => item.id === runId);
      const current = runs[index];
      if (current === undefined) throw new Error('Run not found');
      const run: ProductRun = {
        ...current,
        completedAt: timestamp,
        inputTokens: output.inputTokens,
        outputText: output.outputText,
        outputTokens: output.outputTokens,
        providerRequestId: output.providerRequestId,
        status: 'completed',
      };
      runs[index] = run;
      return run;
    },
    async routeRun(_workspaceId, _actorId, runId, route) {
      const index = runs.findIndex((item) => item.id === runId);
      const current = runs[index];
      if (current === undefined) throw new Error('Run not found');
      runs[index] = { ...current, model: route.model };
    },
    async resolveRunParameters(_workspaceId, _actorId, _runId, resolution) {
      return resolution.effectiveParameters;
    },
    async failRun(_workspaceId, _actorId, runId, errorCode) {
      const index = runs.findIndex((item) => item.id === runId);
      const current = runs[index];
      if (current === undefined) throw new Error('Run not found');
      const run: ProductRun = {
        ...current,
        completedAt: timestamp,
        errorCode,
        status: 'failed',
      };
      runs[index] = run;
      return run;
    },
    async listRuns() {
      return runs;
    },
    async listReleaseEvaluationTargets() {
      const agentTargets: ProductReleaseEvaluationTarget[] = agents
        .filter((agent) => agent.status === 'published')
        .map((agent) => ({
          environments: ['release'],
          failedEvidenceCount: runs.filter((run) => run.status === 'failed').length,
          id: agent.id,
          kind: 'agent',
          model: agent.model,
          name: agent.name,
          publishedAt: agent.updatedAt,
          releaseVersion: 1,
          successfulEvidenceCount: runs.filter((run) => run.status === 'completed').length,
          totalEvidenceCount: runs.length,
        }));
      return agentTargets;
    },
    async listAgents() {
      return agents;
    },
    async createAgent(_workspaceId, _actorId, input) {
      const agent: AgentDraft = {
        ...input,
        createdAt: timestamp,
        id: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        status: 'draft',
        strategyVersion: 1,
        updatedAt: timestamp,
      };
      agents.push(agent);
      return agent;
    },
    async updateAgent(_workspaceId, agentId, expectedRevision, input: AgentDraftInput) {
      const index = agents.findIndex((agent) => agent.id === agentId);
      const current = agents[index];
      if (current === undefined || current.revision !== expectedRevision)
        throw new Error('agent revision conflict');
      const agent: AgentDraft = {
        ...current,
        ...input,
        revision: current.revision + 1,
        status: 'draft',
        updatedAt: timestamp,
        strategyVersion:
          JSON.stringify(current.strategyProfile) === JSON.stringify(input.strategyProfile)
            ? current.strategyVersion
            : current.strategyVersion + 1,
      };
      agents[index] = agent;
      return agent;
    },
    async publishAgent(_workspaceId, _actorId, agentId, expectedRevision) {
      const index = agents.findIndex((agent) => agent.id === agentId);
      const current = agents[index];
      if (current === undefined || current.revision !== expectedRevision)
        throw new Error('agent revision conflict');
      const agent: AgentDraft = {
        ...current,
        revision: current.revision + 1,
        status: 'published',
        updatedAt: timestamp,
      };
      agents[index] = agent;
      return agent;
    },
  };
  return {
    agents,
    conversations,
    flowDebugRuns,
    flows,
    databaseRows,
    databaseTables,
    knowledgeBases,
    knowledgeDocuments,
    runs,
    store,
  };
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe('Better Agent web runtime', () => {
  it('recognizes the production entrypoint through the current-release directory symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-agent-web-entrypoint-'));
    const releaseDirectory = join(directory, 'release');
    const currentDirectory = join(directory, 'current');
    const serverPath = join(releaseDirectory, 'server.js');
    const importedPath = join(releaseDirectory, 'imported.js');
    try {
      await mkdir(releaseDirectory);
      await writeFile(serverPath, 'export {};\n');
      await writeFile(importedPath, 'export {};\n');
      await symlink(
        releaseDirectory,
        currentDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect(
        isInvokedEntrypoint(pathToFileURL(serverPath), join(currentDirectory, 'server.js')),
      ).toBe(true);
      expect(isInvokedEntrypoint(pathToFileURL(serverPath), importedPath)).toBe(false);
      expect(isInvokedEntrypoint(pathToFileURL(serverPath), undefined)).toBe(false);
      expect(isInvokedEntrypoint(pathToFileURL(serverPath), join(directory, 'missing.js'))).toBe(
        false,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('starts the compiled CLI through the current-release directory symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-agent-web-process-'));
    const releaseDirectory = join(directory, 'release');
    const currentDirectory = join(directory, 'current');
    const packageDirectory = join(import.meta.dirname, '..');
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed: Promise<void> | undefined;
    try {
      await mkdir(join(releaseDirectory, 'dist'), { recursive: true });
      await writeFile(join(releaseDirectory, 'package.json'), '{"type":"module"}\n');
      await compileServer(packageDirectory, releaseDirectory);
      await symlink(
        join(packageDirectory, 'public'),
        join(releaseDirectory, 'public'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await symlink(
        releaseDirectory,
        currentDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      child = spawn(process.execPath, [join(currentDirectory, 'dist', 'server.js')], {
        env: {
          ...process.env,
          BETTER_AGENT_BUILD_SHA: 'b'.repeat(40),
          BETTER_AGENT_WEB_HOST: '127.0.0.1',
          BETTER_AGENT_WEB_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const spawnedChild = child;
      childClosed = new Promise((resolve) => spawnedChild.once('close', () => resolve()));
      const origin = await waitForListeningOrigin(child);
      const response = await localRequest(origin, '/better-agent/api/healthz');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        build_sha: 'b'.repeat(40),
        status: 'ok',
      });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await childClosed;
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it('redirects the base path to its canonical trailing-slash form', async () => {
    const origin = await start();
    const response = await localRequest(origin, '/better-agent');

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(WEB_BASE_PATH);
  });

  it('serves the application shell at the canonical public route', async () => {
    const origin = await start();
    const response = await localRequest(origin, WEB_BASE_PATH);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(body).toContain('<title>Better Agent · Studio</title>');
    expect(body).toContain('Agent Studio');
    expect(body).not.toContain('localStorage');
  });

  it.each([
    ['/better-agent/assets/app.css', 'text/css; charset=utf-8', '--paper'],
    ['/better-agent/assets/app.js', 'text/javascript; charset=utf-8', '/better-agent/api/healthz'],
  ])('serves the allowlisted asset %s', async (path, contentType, marker) => {
    const origin = await start();
    const response = await localRequest(origin, path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    expect(await response.text()).toContain(marker);
  });

  it('reports bounded same-origin runtime identity without environment secrets', async () => {
    const origin = await start({ buildSha: 'a'.repeat(40) });
    const response = await localRequest(origin, '/better-agent/api/healthz');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema_version: 'better-agent-web-health/1',
      status: 'ok',
      service: 'better-agent-web',
      base_path: '/better-agent/',
      build_sha: 'a'.repeat(40),
      model_runtime: 'unconfigured',
      started_at: '2026-09-03T00:00:00.000Z',
    });
  });

  it('authenticates a workspace and persists the Agent draft-to-release lifecycle', async () => {
    const { store } = productFixture();
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      productStore: store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toMatch(/^ba_session=/u);
    const authenticatedHeaders = { ...mutationHeaders, Cookie: cookie ?? '' };

    const created = await localRequest(origin, '/better-agent/api/product/agents', {
      body: JSON.stringify({
        description: '研究公开资料',
        instructions: '只使用可验证来源。',
        model: 'gpt-5.6-sol',
        name: '研究员',
      }),
      headers: authenticatedHeaders,
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const createdAgent = ((await created.json()) as { agent: AgentDraft }).agent;
    expect(createdAgent).toMatchObject({ revision: 1, status: 'draft' });

    const updated = await localRequest(
      origin,
      `/better-agent/api/product/agents/${createdAgent.id}`,
      {
        body: JSON.stringify({
          description: '研究并总结公开资料',
          expected_revision: 1,
          instructions: '只使用可验证来源，并标注出处。',
          model: 'gpt-5.6-sol',
          name: '高级研究员',
        }),
        headers: authenticatedHeaders,
        method: 'PUT',
      },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { agent: AgentDraft }).agent.revision).toBe(2);

    const published = await localRequest(
      origin,
      `/better-agent/api/product/agents/${createdAgent.id}/publish`,
      {
        body: JSON.stringify({ expected_revision: 2 }),
        headers: authenticatedHeaders,
        method: 'POST',
      },
    );
    expect(published.status).toBe(200);
    expect(((await published.json()) as { agent: AgentDraft }).agent).toMatchObject({
      revision: 3,
      status: 'published',
    });

    const listed = await localRequest(origin, '/better-agent/api/product/agents', {
      headers: { Cookie: cookie ?? '' },
    });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { agents: AgentDraft[] }).agents).toHaveLength(1);

    const evaluation = await localRequest(origin, '/better-agent/api/product/release-evaluation', {
      headers: { Cookie: cookie ?? '' },
    });
    expect(evaluation.status).toBe(200);
    expect(
      ((await evaluation.json()) as { targets: ProductReleaseEvaluationTarget[] }).targets[0],
    ).toMatchObject({ kind: 'agent', name: '高级研究员', releaseVersion: 1 });
  });

  it('persists the Flow Draft, debug trace and immutable environment release lifecycle', async () => {
    const { store } = productFixture();
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      productStore: store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const headers = { ...mutationHeaders, Cookie: cookie };
    const graph = {
      edges: [
        { id: 'input_prompt', source: 'input', target: 'prompt' },
        { id: 'prompt_output', source: 'prompt', target: 'output' },
      ],
      nodes: [
        { config: { key: 'message' }, id: 'input', label: '输入', type: 'input' },
        {
          config: { template: '已处理：{{message}}' },
          id: 'prompt',
          label: '模板',
          type: 'template',
        },
        { config: { source: 'prompt' }, id: 'output', label: '输出', type: 'output' },
      ],
    };

    const created = await localRequest(origin, '/better-agent/api/product/flows', {
      body: JSON.stringify({ description: '三节点映射', graph, name: '响应管线' }),
      headers,
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const flow = ((await created.json()) as { flow: ProductFlowDraft }).flow;
    expect(flow).toMatchObject({ revision: 1, status: 'draft' });

    const debugResponse = await localRequest(
      origin,
      `/better-agent/api/product/flows/${flow.id}/debug`,
      {
        body: JSON.stringify({ expected_revision: 1, input: '验证变量映射' }),
        headers,
        method: 'POST',
      },
    );
    expect(debugResponse.status).toBe(201);
    expect(((await debugResponse.json()) as { debug: ProductFlowDebugRun }).debug).toMatchObject({
      draftRevision: 1,
      inputText: '验证变量映射',
      outputText: '已处理：验证变量映射',
      status: 'completed',
    });

    const published = await localRequest(
      origin,
      `/better-agent/api/product/flows/${flow.id}/publish`,
      {
        body: JSON.stringify({ environment: 'staging', expected_revision: 1 }),
        headers,
        method: 'POST',
      },
    );
    expect(published.status).toBe(200);
    expect(((await published.json()) as { flow: ProductFlowDraft }).flow).toMatchObject({
      deployments: [{ environment: 'staging', releaseVersion: 1 }],
      publishedVersion: 1,
      revision: 2,
      status: 'published',
    });

    const [listed, debugHistory] = await Promise.all([
      localRequest(origin, '/better-agent/api/product/flows', {
        headers: { Cookie: cookie },
      }),
      localRequest(origin, `/better-agent/api/product/flows/${flow.id}/debug-runs`, {
        headers: { Cookie: cookie },
      }),
    ]);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { flows: ProductFlowDraft[] }).flows).toHaveLength(1);
    expect(debugHistory.status).toBe(200);
    expect(
      ((await debugHistory.json()) as { debug_runs: ProductFlowDebugRun[] }).debug_runs,
    ).toHaveLength(1);

    const malformedDebug = await localRequest(
      origin,
      `/better-agent/api/product/flows/${flow.id}/debug`,
      { body: 'null', headers, method: 'POST' },
    );
    expect(malformedDebug.status).toBe(400);
    expect(await malformedDebug.json()).toEqual({ error: 'invalid_flow_debug_payload' });
  });

  it('creates a Knowledge base, ingests a document and returns bounded retrieval hits', async () => {
    const { store } = productFixture();
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      productStore: store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const headers = { ...mutationHeaders, Cookie: cookie };
    const created = await localRequest(origin, '/better-agent/api/product/knowledge-bases', {
      body: JSON.stringify({ description: '生产运行知识', name: '运维知识库' }),
      headers,
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const knowledgeBase = ((await created.json()) as { knowledge_base: ProductKnowledgeBase })
      .knowledge_base;
    expect(knowledgeBase).toMatchObject({ documentCount: 0, name: '运维知识库' });

    const ingested = await localRequest(
      origin,
      `/better-agent/api/product/knowledge-bases/${knowledgeBase.id}/documents`,
      {
        body: JSON.stringify({
          content: '服务健康检查使用 /healthz。异常时先检查 PostgreSQL 连接。',
          title: '运行手册',
        }),
        headers,
        method: 'POST',
      },
    );
    expect(ingested.status).toBe(201);
    expect(
      ((await ingested.json()) as { document: ProductKnowledgeDocument }).document,
    ).toMatchObject({ chunkCount: 1, title: '运行手册' });

    const search = await localRequest(
      origin,
      `/better-agent/api/product/knowledge-bases/${knowledgeBase.id}/search`,
      {
        body: JSON.stringify({ query: '健康检查' }),
        headers,
        method: 'POST',
      },
    );
    expect(search.status).toBe(200);
    expect(((await search.json()) as { hits: ProductKnowledgeHit[] }).hits[0]).toMatchObject({
      documentTitle: '运行手册',
      ordinal: 0,
    });

    const [bases, documents] = await Promise.all([
      localRequest(origin, '/better-agent/api/product/knowledge-bases', {
        headers: { Cookie: cookie },
      }),
      localRequest(
        origin,
        `/better-agent/api/product/knowledge-bases/${knowledgeBase.id}/documents`,
        { headers: { Cookie: cookie } },
      ),
    ]);
    expect(bases.status).toBe(200);
    expect(
      ((await bases.json()) as { knowledge_bases: ProductKnowledgeBase[] }).knowledge_bases,
    ).toHaveLength(1);
    expect(documents.status).toBe(200);
    expect(
      ((await documents.json()) as { documents: ProductKnowledgeDocument[] }).documents,
    ).toHaveLength(1);
  });

  it('creates a managed Database table, appends rows and executes a bounded query', async () => {
    const { store } = productFixture();
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      productStore: store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const headers = { ...mutationHeaders, Cookie: cookie };
    const created = await localRequest(origin, '/better-agent/api/product/database-tables', {
      body: JSON.stringify({
        columns: ['customer_id', 'status'],
        description: '客户状态投影',
        name: 'customers',
      }),
      headers,
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const table = ((await created.json()) as { database_table: ProductDatabaseTable })
      .database_table;

    const appended = await localRequest(
      origin,
      `/better-agent/api/product/database-tables/${table.id}/rows`,
      {
        body: JSON.stringify({
          rows: [
            { customer_id: 7, status: 'active' },
            { customer_id: 8, status: 'paused' },
          ],
        }),
        headers,
        method: 'POST',
      },
    );
    expect(appended.status).toBe(201);
    expect(await appended.json()).toEqual({ appended: 2 });

    const queried = await localRequest(
      origin,
      `/better-agent/api/product/database-tables/${table.id}/query`,
      {
        body: JSON.stringify({ column: 'status', contains: 'active', limit: 20 }),
        headers,
        method: 'POST',
      },
    );
    expect(queried.status).toBe(200);
    expect(((await queried.json()) as { rows: ProductDatabaseRow[] }).rows).toMatchObject([
      { ordinal: 0, record: { customer_id: 7, status: 'active' } },
    ]);

    const listed = await localRequest(origin, '/better-agent/api/product/database-tables', {
      headers: { Cookie: cookie },
    });
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { database_tables: ProductDatabaseTable[] }).database_tables[0],
    ).toMatchObject({ columns: ['customer_id', 'status'], rowCount: 2 });
  });

  it('requires the product CSRF header before authenticating mutation routes', async () => {
    const { store } = productFixture();
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      productStore: store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const response = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'csrf_guard_required' });
  });

  it('runs a published Agent through the configured model and persists observable history', async () => {
    const { agents, databaseRows, databaseTables, knowledgeBases, knowledgeDocuments, store } =
      productFixture();
    databaseTables.push({
      columns: ['service', 'status'],
      createdAt: '2026-09-03T00:00:00.000Z',
      description: '服务状态',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'service_status',
      rowCount: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
    });
    databaseRows.push({
      createdAt: '2026-09-03T00:00:00.000Z',
      ordinal: 0,
      record: { service: 'web', status: 'healthy' },
    });
    databaseRows.push({
      createdAt: '2026-09-03T00:00:00.000Z',
      ordinal: 1,
      record: { service: 'worker', status: 'paused' },
    });
    knowledgeBases.push({
      createdAt: '2026-09-03T00:00:00.000Z',
      description: '生产运行手册',
      documentCount: 1,
      id: '88888888-8888-4888-8888-888888888888',
      name: '运维知识库',
      updatedAt: '2026-09-03T00:00:00.000Z',
    });
    knowledgeDocuments.push({
      chunkCount: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
      id: '99999999-9999-4999-8999-999999999999',
      knowledgeBaseId: '88888888-8888-4888-8888-888888888888',
      title: '运行手册',
    });
    agents.push({
      createdAt: '2026-09-03T00:00:00.000Z',
      databaseTableId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      description: '运行助手',
      id: '11111111-1111-4111-8111-111111111111',
      instructions: '只回答已核验事实。',
      knowledgeBaseId: '88888888-8888-4888-8888-888888888888',
      model: 'gpt-5.6-sol',
      name: '运行助手',
      revision: 2,
      roleMode: 'text',
      roleProfile: null,
      status: 'published',
      strategyProfile: {
        ...createDefaultAgentStrategyProfile('gpt-5.6-sol'),
        parameterDefaults: { databaseContains: 'healthy', knowledgeQuery: '默认健康检查' },
        routes: [
          { description: '快速状态查询', model: 'gpt-5.4-mini' },
          { description: '复杂诊断', model: 'gpt-5.6-sol' },
        ],
        routingMode: 'autonomous',
        parameterExtraction: true,
      },
      strategyVersion: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
    });
    let providerFails = false;
    const extractedQueries: string[] = [];
    const persistedParameters: unknown[] = [];
    const generationInputs: Parameters<ProductModelRuntime['generate']>[0][] = [];
    const originalSearchAgentKnowledge = store.searchAgentKnowledge.bind(store);
    store.searchAgentKnowledge = async (workspaceId, conversationId, query) => {
      extractedQueries.push(query);
      return await originalSearchAgentKnowledge(workspaceId, conversationId, query);
    };
    store.resolveRunParameters = async (_workspaceId, _actorId, _runId, resolution) => {
      persistedParameters.push(resolution);
      return resolution.effectiveParameters;
    };
    const modelRuntime: ProductModelRuntime = {
      async generate(input) {
        if (providerFails) throw new Error('model_provider_http_503');
        generationInputs.push(input);
        return {
          inputTokens: 12,
          outputText: '当前服务正常。',
          outputTokens: 6,
          providerRequestId: 'resp_test',
        };
      },
      async selectModel() {
        return {
          inputTokens: 4,
          model: 'gpt-5.4-mini',
          outputText: '{"model":"gpt-5.4-mini"}',
          outputTokens: 2,
          providerRequestId: 'resp_route',
        };
      },
      async extractParameters(input) {
        expect(input.maxOutputTokens).toBe(1_998);
        return {
          databaseContains: '',
          inputTokens: 6,
          knowledgeQuery: '生产健康检查',
          outputText: '{"database_contains":"healthy","knowledge_query":"生产健康检查"}',
          outputTokens: 3,
          providerRequestId: 'resp_parameters',
        };
      },
    };
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      modelRuntime,
      productStore: store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const headers = { ...mutationHeaders, Cookie: cookie };
    const conversationResponse = await localRequest(
      origin,
      '/better-agent/api/product/agents/11111111-1111-4111-8111-111111111111/conversations',
      { body: '{}', headers, method: 'POST' },
    );
    expect(conversationResponse.status).toBe(201);
    const conversation = (await conversationResponse.json()) as {
      conversation: ProductConversation;
    };

    const runResponse = await localRequest(
      origin,
      `/better-agent/api/product/conversations/${conversation.conversation.id}/runs`,
      {
        body: JSON.stringify({ message: '当前服务正常吗？' }),
        headers,
        method: 'POST',
      },
    );
    expect(runResponse.status, JSON.stringify(await runResponse.clone().json())).toBe(201);
    expect(((await runResponse.json()) as { run: ProductRun }).run).toMatchObject({
      inputText: '当前服务正常吗？',
      outputText: '当前服务正常。',
      status: 'completed',
    });
    expect(extractedQueries).toEqual(['生产健康检查']);
    expect(persistedParameters).toHaveLength(1);
    expect(persistedParameters[0]).toMatchObject({
      effectiveParameters: {
        databaseContains: 'healthy',
        knowledgeQuery: '生产健康检查',
      },
      extractedParameters: { databaseContains: '', knowledgeQuery: '生产健康检查' },
      providerRequestId: 'resp_parameters',
    });
    expect(generationInputs).toHaveLength(1);
    expect(generationInputs[0]).toMatchObject({
      maxOutputTokens: 1_995,
      model: 'gpt-5.4-mini',
      prompt: '当前服务正常吗？',
      temperature: 0.2,
    });
    expect(generationInputs[0]?.instructions).toContain('只回答已核验事实。');
    expect(generationInputs[0]?.instructions).toContain('KNOWLEDGE_CONTEXT');
    expect(generationInputs[0]?.instructions).toContain('服务健康检查使用 /healthz。');
    expect(generationInputs[0]?.instructions).toContain('DATABASE_CONTEXT');
    expect(generationInputs[0]?.instructions).toContain('service_status');
    expect(generationInputs[0]?.instructions).toContain('healthy');
    expect(generationInputs[0]?.instructions).not.toContain('paused');

    providerFails = true;
    const failedResponse = await localRequest(
      origin,
      `/better-agent/api/product/conversations/${conversation.conversation.id}/runs`,
      {
        body: JSON.stringify({ message: '触发失败路径。' }),
        headers,
        method: 'POST',
      },
    );
    expect(failedResponse.status).toBe(502);
    expect(await failedResponse.json()).toEqual({ error: 'model_provider_http_503' });

    const historyResponse = await localRequest(origin, '/better-agent/api/product/runs', {
      headers: { Cookie: cookie },
    });
    expect(historyResponse.status).toBe(200);
    const history = ((await historyResponse.json()) as { runs: ProductRun[] }).runs;
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      errorCode: 'model_provider_http_503',
      status: 'failed',
    });
  });

  it('resolves published defaults without invoking the parameter extraction model', async () => {
    const { agents, store } = productFixture();
    agents.push({
      createdAt: '2026-09-03T00:00:00.000Z',
      databaseTableId: null,
      description: '默认参数助手',
      id: '11111111-1111-4111-8111-111111111111',
      instructions: '使用已发布策略。',
      knowledgeBaseId: null,
      model: 'gpt-5.6-sol',
      name: '默认参数助手',
      revision: 2,
      roleMode: 'text',
      roleProfile: null,
      status: 'published',
      strategyProfile: {
        ...createDefaultAgentStrategyProfile('gpt-5.6-sol'),
        maxToolCalls: 0,
        parameterDefaults: {
          databaseContains: 'active',
          knowledgeQuery: '已发布默认问题',
        },
      },
      strategyVersion: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
    });
    const resolutions: unknown[] = [];
    store.resolveRunParameters = async (_workspaceId, _actorId, _runId, resolution) => {
      resolutions.push(resolution);
      return resolution.effectiveParameters;
    };
    const modelRuntime: ProductModelRuntime = {
      async generate(input) {
        expect(input.maxOutputTokens).toBe(2_000);
        return {
          inputTokens: 5,
          outputText: '已使用默认参数。',
          outputTokens: 5,
          providerRequestId: 'resp_defaults',
        };
      },
    };
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      modelRuntime,
      productStore: store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    const headers = {
      ...mutationHeaders,
      Cookie: login.headers.get('set-cookie')?.split(';', 1)[0] ?? '',
    };
    const conversationResponse = await localRequest(
      origin,
      '/better-agent/api/product/agents/11111111-1111-4111-8111-111111111111/conversations',
      { body: '{}', headers, method: 'POST' },
    );
    const conversation = (await conversationResponse.json()) as {
      conversation: ProductConversation;
    };
    const response = await localRequest(
      origin,
      `/better-agent/api/product/conversations/${conversation.conversation.id}/runs`,
      {
        body: JSON.stringify({ message: '这次不使用用户输入作为默认查询' }),
        headers,
        method: 'POST',
      },
    );

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    expect(resolutions).toEqual([
      {
        effectiveParameters: {
          databaseContains: 'active',
          knowledgeQuery: '已发布默认问题',
        },
        extractedParameters: null,
        inputTokens: 0,
        outputTokens: 0,
        providerRequestId: null,
      },
    ]);
  });

  it('runs authenticated role assistance through the model boundary and returns validated JSON', async () => {
    const prompts: string[] = [];
    const modelRuntime: ProductModelRuntime = {
      async generate(input) {
        prompts.push(input.prompt);
        expect(input.history).toEqual([]);
        expect(input.instructions).toContain('只返回一个 JSON 对象');
        return {
          inputTokens: 20,
          outputText: JSON.stringify({ instructions: '先核验事实，再以简洁中文回答。' }),
          outputTokens: 12,
          providerRequestId: 'resp_role_assist',
        };
      },
    };
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      modelRuntime,
      productStore: productFixture().store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const response = await localRequest(origin, '/better-agent/api/product/role-assist', {
      body: JSON.stringify({
        action: 'optimize',
        capability_kinds: [],
        description: '运维助手',
        instructions: '回答问题。',
        model: 'gpt-5.6-sol',
        name: '守望者',
        role_mode: 'text',
      }),
      headers: { ...mutationHeaders, Cookie: cookie },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      suggestion: {
        instructions: '先核验事实，再以简洁中文回答。',
        role_mode: 'text',
        role_profile: null,
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"instructions":"回答问题。"');

    const invalidResponse = await localRequest(origin, '/better-agent/api/product/role-assist', {
      body: JSON.stringify({ action: 'generate', unexpected: true }),
      headers: { ...mutationHeaders, Cookie: cookie },
      method: 'POST',
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({
      error: 'Role assist payload contains unknown fields',
    });
  });

  it('fails role assistance closed when no model runtime is configured', async () => {
    const origin = await start({
      actorId: '22222222-2222-4222-8222-222222222222',
      adminPassword: 'a-secure-admin-password',
      productStore: productFixture().store,
      sessionSecret: 's'.repeat(32),
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });
    const mutationHeaders = {
      'Content-Type': 'application/json',
      'X-Better-Agent-CSRF': '1',
    };
    const login = await localRequest(origin, '/better-agent/api/product/login', {
      body: JSON.stringify({ password: 'a-secure-admin-password' }),
      headers: mutationHeaders,
      method: 'POST',
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const response = await localRequest(origin, '/better-agent/api/product/role-assist', {
      body: JSON.stringify({}),
      headers: { ...mutationHeaders, Cookie: cookie },
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'model_runtime_not_configured' });
  });

  it('does not reflect malformed build identity into the health contract', async () => {
    const origin = await start({ buildSha: '<script>secret</script>' });
    const response = await localRequest(origin, '/better-agent/api/healthz');
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.build_sha).toBe('development');
  });

  it('answers HEAD without a response body while preserving representation length', async () => {
    const origin = await start();
    const getResponse = await localRequest(origin, '/better-agent/assets/app.css');
    const headResponse = await localRequest(origin, '/better-agent/assets/app.css', {
      method: 'HEAD',
    });

    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-length')).toBe(
      getResponse.headers.get('content-length'),
    );
    expect(await headResponse.text()).toBe('');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'rejects the unsupported %s method before route handling',
    async (method) => {
      const origin = await start();
      const response = await localRequest(origin, '/better-agent/api/healthz', { method });

      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(await response.json()).toEqual({ error: 'method_not_allowed' });
    },
  );

  it('keeps unknown API and page routes distinct and closed', async () => {
    const origin = await start();
    const [apiResponse, pageResponse, foreignResponse] = await Promise.all([
      localRequest(origin, '/better-agent/api/missing'),
      localRequest(origin, '/better-agent/missing'),
      localRequest(origin, '/agent-build/'),
    ]);

    expect(await apiResponse.json()).toEqual({ error: 'api_route_not_found' });
    expect(await pageResponse.json()).toEqual({ error: 'route_not_found' });
    expect(await foreignResponse.json()).toEqual({ error: 'route_not_found' });
    expect([apiResponse.status, pageResponse.status, foreignResponse.status]).toEqual([
      404, 404, 404,
    ]);
  });

  it.each(['/better-agent/%2e%2e/secret', '/better-agent/%2Fsecret', '/better-agent/%5csecret'])(
    'rejects encoded path-boundary input %s',
    async (path) => {
      const origin = await start();
      const response = await rawGet(origin, path);

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request_path' });
    },
  );

  it.each(['//foreign.example/better-agent/', 'http://foreign.example/better-agent/'])(
    'rejects non-origin-form request target %s',
    async (path) => {
      const origin = await start();
      const response = await rawGet(origin, path);

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request_path' });
    },
  );

  it('bounds HTTP parser and connection lifetimes', async () => {
    const server = await createBetterAgentWebServer();

    expect(server.headersTimeout).toBe(5_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxHeadersCount).toBe(64);
    expect(server.requestTimeout).toBe(10_000);
  });

  it('applies browser isolation and content security headers to HTML, API and errors', async () => {
    const origin = await start();
    for (const path of ['/better-agent/', '/better-agent/api/healthz', '/missing']) {
      const response = await localRequest(origin, path);
      const policy = response.headers.get('content-security-policy');

      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});
