import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  createPostgresProductStore,
  type ProductStore,
  validateAgentInput,
  validateRunInput,
} from './product-store.js';
import { createModelRuntimeFromEnvironment, type ProductModelRuntime } from './model-runtime.js';

export const WEB_BASE_PATH = '/better-agent/';

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface BetterAgentWebOptions {
  readonly actorId?: string;
  readonly adminPassword?: string;
  readonly buildSha?: string;
  readonly modelRuntime?: ProductModelRuntime;
  readonly now?: () => Date;
  readonly productStore?: ProductStore;
  readonly publicRoot?: string;
  readonly secureCookies?: boolean;
  readonly sessionSecret?: string;
  readonly workspaceId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function safeEqualText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function sessionToken(workspaceId: string, actorId: string, secret: string, now: Date): string {
  const payload = Buffer.from(
    JSON.stringify({ actorId, expiresAt: now.valueOf() + 8 * 60 * 60 * 1000, workspaceId }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function hasSession(
  request: IncomingMessage,
  workspaceId: string,
  actorId: string,
  secret: string,
  currentTime: Date,
): boolean {
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('ba_session='));
  const token = cookie?.slice('ba_session='.length);
  if (token === undefined) return false;
  const [payload, signature, extra] = token.split('.');
  if (payload === undefined || signature === undefined || extra !== undefined) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqualText(signature, expected)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return (
      value.workspaceId === workspaceId &&
      value.actorId === actorId &&
      typeof value.expiresAt === 'number' &&
      value.expiresAt > currentTime.valueOf()
    );
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 64 * 1024) throw new Error('request_body_too_large');
    chunks.push(bytes);
  }
  if (chunks.length === 0) throw new Error('request_body_required');
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function isInvokedEntrypoint(moduleUrl: URL, invokedPath: string | undefined): boolean {
  if (invokedPath === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invokedPath);
  } catch {
    return false;
  }
}

function normalizedBuildSha(value: string | undefined): string {
  return value !== undefined && /^[0-9a-f]{40}$/u.test(value) ? value : 'development';
}

async function loadAssets(publicRoot: string): Promise<ReadonlyMap<string, StaticAsset>> {
  const definitions = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/assets/app.css', 'assets/app.css', 'text/css; charset=utf-8'],
    ['/assets/app.js', 'assets/app.js', 'text/javascript; charset=utf-8'],
  ] as const;
  const assets = new Map<string, StaticAsset>();
  for (const [route, filename, contentType] of definitions) {
    assets.set(route, { body: await readFile(`${publicRoot}/${filename}`), contentType });
  }
  return assets;
}

function setCommonHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader('Cache-Control', 'no-store');
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | string,
): void {
  const encoded = typeof body === 'string' ? Buffer.from(body) : body;
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(encoded.byteLength));
  response.end(request.method === 'HEAD' ? undefined : encoded);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  send(request, response, status, 'application/json; charset=utf-8', `${JSON.stringify(body)}\n`);
}

function requestPath(request: IncomingMessage): string | null {
  try {
    const rawTarget = request.url ?? '/';
    if (!rawTarget.startsWith('/') || rawTarget.startsWith('//')) return null;
    const rawPath = rawTarget.split('?', 1)[0] ?? '';
    if (/%(?:2e|2f|5c)/iu.test(rawPath) || rawPath.includes('\\')) return null;
    const url = new URL(rawTarget, 'http://better-agent.invalid');
    if (url.username !== '' || url.password !== '') return null;
    return url.pathname;
  } catch {
    return null;
  }
}

export async function createBetterAgentWebServer(
  options: BetterAgentWebOptions = {},
): Promise<Server> {
  const publicRoot = options.publicRoot ?? fileURLToPath(new URL('../public', import.meta.url));
  const assets = await loadAssets(publicRoot);
  const buildSha = normalizedBuildSha(options.buildSha ?? process.env.BETTER_AGENT_BUILD_SHA);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const workspaceId = options.workspaceId ?? process.env.BETTER_AGENT_PRODUCT_WORKSPACE_ID;
  const actorId = options.actorId ?? process.env.BETTER_AGENT_PRODUCT_ACTOR_ID;
  const adminPassword = options.adminPassword ?? process.env.BETTER_AGENT_ADMIN_PASSWORD;
  const sessionSecret = options.sessionSecret ?? process.env.BETTER_AGENT_SESSION_SECRET;
  const secureCookies =
    options.secureCookies ?? process.env.BETTER_AGENT_SECURE_COOKIES !== 'false';
  const databaseUrl = process.env.BETTER_AGENT_RUNTIME_DATABASE_URL;
  const modelRuntime = options.modelRuntime ?? createModelRuntimeFromEnvironment();
  const hasPostgresEnvironment = databaseUrl !== undefined || process.env.PGHOST !== undefined;
  const productStore =
    options.productStore ??
    (hasPostgresEnvironment ? await createPostgresProductStore(databaseUrl) : undefined);
  const productConfigured =
    productStore !== undefined &&
    workspaceId !== undefined &&
    actorId !== undefined &&
    adminPassword !== undefined &&
    sessionSecret !== undefined &&
    UUID.test(workspaceId) &&
    UUID.test(actorId) &&
    adminPassword.length >= 12 &&
    sessionSecret.length >= 32;

  const handleProductApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<boolean> => {
    if (!path.startsWith(`${WEB_BASE_PATH}api/product/`)) return false;
    if (
      !productConfigured ||
      productStore === undefined ||
      workspaceId === undefined ||
      actorId === undefined ||
      adminPassword === undefined ||
      sessionSecret === undefined
    ) {
      sendJson(request, response, 503, { error: 'product_runtime_not_configured' });
      return true;
    }
    const isMutation = request.method === 'POST' || request.method === 'PUT';
    if (isMutation && request.headers['x-better-agent-csrf'] !== '1') {
      sendJson(request, response, 403, { error: 'csrf_guard_required' });
      return true;
    }
    if (path === `${WEB_BASE_PATH}api/product/login` && request.method === 'POST') {
      const payload = (await readJsonBody(request)) as Record<string, unknown>;
      if (typeof payload.password !== 'string' || !safeEqualText(payload.password, adminPassword)) {
        sendJson(request, response, 401, { error: 'invalid_credentials' });
        return true;
      }
      response.setHeader(
        'Set-Cookie',
        `ba_session=${sessionToken(workspaceId, actorId, sessionSecret, now())}; Path=${WEB_BASE_PATH}; HttpOnly;${secureCookies ? ' Secure;' : ''} SameSite=Strict; Max-Age=28800`,
      );
      sendJson(request, response, 200, {
        actor_id: actorId,
        authenticated: true,
        workspace_id: workspaceId,
      });
      return true;
    }
    if (!hasSession(request, workspaceId, actorId, sessionSecret, now())) {
      sendJson(request, response, 401, { error: 'authentication_required' });
      return true;
    }
    if (path === `${WEB_BASE_PATH}api/product/session` && request.method === 'GET') {
      sendJson(request, response, 200, {
        actor_id: actorId,
        authenticated: true,
        workspace_id: workspaceId,
      });
      return true;
    }
    if (path === `${WEB_BASE_PATH}api/product/agents` && request.method === 'GET') {
      sendJson(request, response, 200, { agents: await productStore.listAgents(workspaceId) });
      return true;
    }
    if (path === `${WEB_BASE_PATH}api/product/agents` && request.method === 'POST') {
      const agent = await productStore.createAgent(
        workspaceId,
        actorId,
        validateAgentInput(await readJsonBody(request)),
      );
      sendJson(request, response, 201, { agent });
      return true;
    }
    if (path === `${WEB_BASE_PATH}api/product/runs` && request.method === 'GET') {
      sendJson(request, response, 200, { runs: await productStore.listRuns(workspaceId) });
      return true;
    }
    const conversationCreationMatch = new RegExp(
      `^${WEB_BASE_PATH}api/product/agents/([0-9a-f-]{36})/conversations$`,
      'u',
    ).exec(path);
    if (
      conversationCreationMatch !== null &&
      UUID.test(conversationCreationMatch[1] ?? '') &&
      request.method === 'POST'
    ) {
      const payload = (await readJsonBody(request)) as Record<string, unknown>;
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        Object.keys(payload).length !== 0
      ) {
        throw new Error('invalid_conversation_payload');
      }
      const conversation = await productStore.createConversation(
        workspaceId,
        actorId,
        conversationCreationMatch[1] as string,
      );
      sendJson(request, response, 201, { conversation });
      return true;
    }
    const conversationRunMatch = new RegExp(
      `^${WEB_BASE_PATH}api/product/conversations/([0-9a-f-]{36})/runs$`,
      'u',
    ).exec(path);
    if (
      conversationRunMatch !== null &&
      UUID.test(conversationRunMatch[1] ?? '') &&
      request.method === 'POST'
    ) {
      if (modelRuntime === undefined) {
        sendJson(request, response, 503, { error: 'model_runtime_not_configured' });
        return true;
      }
      const prepared = await productStore.beginRun(
        workspaceId,
        actorId,
        conversationRunMatch[1] as string,
        validateRunInput(await readJsonBody(request)),
      );
      try {
        const output = await modelRuntime.generate({
          history: prepared.history,
          instructions: prepared.instructions,
          model: prepared.model,
          prompt: prepared.inputText,
        });
        const run = await productStore.completeRun(workspaceId, actorId, prepared.runId, output);
        sendJson(request, response, 201, { run });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'model_provider_failed';
        const errorCode = /^model_[a-z0-9_]+$/u.test(message) ? message : 'model_provider_failed';
        await productStore.failRun(workspaceId, actorId, prepared.runId, errorCode);
        throw new Error(errorCode, { cause: error });
      }
      return true;
    }
    const match = new RegExp(
      `^${WEB_BASE_PATH}api/product/agents/([0-9a-f-]{36})(/publish)?$`,
      'u',
    ).exec(path);
    if (match !== null && UUID.test(match[1] ?? '')) {
      if (match[2] === '/publish' && request.method === 'POST') {
        const payload = (await readJsonBody(request)) as Record<string, unknown>;
        const expectedRevision = payload.expected_revision;
        if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
          throw new Error('invalid_expected_revision');
        const agent = await productStore.publishAgent(
          workspaceId,
          actorId,
          match[1] as string,
          Number(expectedRevision),
        );
        sendJson(request, response, 200, { agent });
        return true;
      }
      if (match[2] === undefined && request.method === 'PUT') {
        const payload = (await readJsonBody(request)) as Record<string, unknown>;
        const expectedRevision = payload.expected_revision;
        if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
          throw new Error('invalid_expected_revision');
        const { expected_revision: _, ...agentPayload } = payload;
        const agent = await productStore.updateAgent(
          workspaceId,
          match[1] as string,
          Number(expectedRevision),
          validateAgentInput(agentPayload),
        );
        sendJson(request, response, 200, { agent });
        return true;
      }
    }
    sendJson(request, response, 404, { error: 'product_route_not_found' });
    return true;
  };

  const server = createServer(
    { maxHeaderSize: 16_384, requireHostHeader: true },
    (request, response) => {
      const path = requestPath(request);
      if (path === null) {
        sendJson(request, response, 400, { error: 'invalid_request_path' });
        return;
      }
      if (path.startsWith(`${WEB_BASE_PATH}api/product/`)) {
        void handleProductApi(request, response, path).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'unknown_product_error';
          const status = message.includes('revision conflict')
            ? 409
            : message === 'agent has no published release'
              ? 409
              : message === 'conversation not found'
                ? 404
                : message.startsWith('model_')
                  ? 502
                  : message.startsWith('invalid_') ||
                      message.includes('payload') ||
                      message.includes('request_body')
                    ? 400
                    : 500;
          sendJson(request, response, status, {
            error: status === 500 ? 'product_operation_failed' : message,
          });
        });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(request, response, 405, { error: 'method_not_allowed' });
        return;
      }
      if (path === WEB_BASE_PATH.slice(0, -1)) {
        setCommonHeaders(response);
        response.statusCode = 308;
        response.setHeader('Location', WEB_BASE_PATH);
        response.end();
        return;
      }
      if (path === `${WEB_BASE_PATH}api/healthz`) {
        sendJson(request, response, 200, {
          schema_version: 'better-agent-web-health/1',
          status: 'ok',
          service: 'better-agent-web',
          base_path: WEB_BASE_PATH,
          build_sha: buildSha,
          model_runtime: modelRuntime === undefined ? 'unconfigured' : 'configured',
          started_at: startedAt,
        });
        return;
      }
      if (path.startsWith(`${WEB_BASE_PATH}api/`)) {
        sendJson(request, response, 404, { error: 'api_route_not_found' });
        return;
      }
      if (!path.startsWith(WEB_BASE_PATH)) {
        sendJson(request, response, 404, { error: 'route_not_found' });
        return;
      }
      const assetPath = path.slice(WEB_BASE_PATH.length - 1);
      const asset = assets.get(assetPath);
      if (asset === undefined) {
        sendJson(request, response, 404, { error: 'route_not_found' });
        return;
      }
      send(request, response, 200, asset.contentType, asset.body);
    },
  );
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.requestTimeout = 10_000;
  return server;
}

export async function startBetterAgentWebServer(): Promise<Server> {
  const host = process.env.BETTER_AGENT_WEB_HOST ?? '127.0.0.1';
  const portText = process.env.BETTER_AGENT_WEB_PORT ?? '4310';
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(portText)) {
    throw new Error(`BETTER_AGENT_WEB_PORT must be a canonical TCP port, received ${portText}`);
  }
  const port = Number(portText);
  if (port > 65_535) throw new Error(`BETTER_AGENT_WEB_PORT is outside the TCP range: ${portText}`);
  const server = await createBetterAgentWebServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const listeningPort = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(
    `Better Agent web listening on http://${host}:${listeningPort}${WEB_BASE_PATH}\n`,
  );
  return server;
}

if (isInvokedEntrypoint(new URL(import.meta.url), process.argv[1])) {
  startBetterAgentWebServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Better Agent web failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
