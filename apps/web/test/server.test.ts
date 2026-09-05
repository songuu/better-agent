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
import type { AgentDraft, AgentDraftInput, ProductStore } from '../src/product-store.js';

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
  readonly store: ProductStore;
} {
  const agents: AgentDraft[] = [];
  const timestamp = '2026-09-03T00:00:00.000Z';
  const store: ProductStore = {
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
  return { agents, store };
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
  });

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
