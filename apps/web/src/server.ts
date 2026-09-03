import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

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
  readonly buildSha?: string;
  readonly now?: () => Date;
  readonly publicRoot?: string;
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
  const startedAt = (options.now ?? (() => new Date()))().toISOString();

  const server = createServer(
    { maxHeaderSize: 16_384, requireHostHeader: true },
    (request, response) => {
      const path = requestPath(request);
      if (path === null) {
        sendJson(request, response, 400, { error: 'invalid_request_path' });
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
  process.stdout.write(`Better Agent web listening on http://${host}:${port}${WEB_BASE_PATH}\n`);
  return server;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  startBetterAgentWebServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Better Agent web failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
