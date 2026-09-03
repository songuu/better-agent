import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type BetterAgentWebOptions,
  createBetterAgentWebServer,
  WEB_BASE_PATH,
} from '../src/server.js';

const openServers: Awaited<ReturnType<typeof createBetterAgentWebServer>>[] = [];

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
  it('redirects the base path to its canonical trailing-slash form', async () => {
    const origin = await start();
    const response = await fetch(`${origin}/better-agent`, { redirect: 'manual' });

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(WEB_BASE_PATH);
  });

  it('serves the application shell at the canonical public route', async () => {
    const origin = await start();
    const response = await fetch(`${origin}${WEB_BASE_PATH}`);
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
    const response = await fetch(`${origin}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    expect(await response.text()).toContain(marker);
  });

  it('reports bounded same-origin runtime identity without environment secrets', async () => {
    const origin = await start({ buildSha: 'a'.repeat(40) });
    const response = await fetch(`${origin}/better-agent/api/healthz`);

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

  it('does not reflect malformed build identity into the health contract', async () => {
    const origin = await start({ buildSha: '<script>secret</script>' });
    const response = await fetch(`${origin}/better-agent/api/healthz`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.build_sha).toBe('development');
  });

  it('answers HEAD without a response body while preserving representation length', async () => {
    const origin = await start();
    const getResponse = await fetch(`${origin}/better-agent/assets/app.css`);
    const headResponse = await fetch(`${origin}/better-agent/assets/app.css`, { method: 'HEAD' });

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
      const response = await fetch(`${origin}/better-agent/api/healthz`, { method });

      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(await response.json()).toEqual({ error: 'method_not_allowed' });
    },
  );

  it('keeps unknown API and page routes distinct and closed', async () => {
    const origin = await start();
    const [apiResponse, pageResponse, foreignResponse] = await Promise.all([
      fetch(`${origin}/better-agent/api/missing`),
      fetch(`${origin}/better-agent/missing`),
      fetch(`${origin}/agent-build/`),
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
      const response = await fetch(`${origin}${path}`);
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
