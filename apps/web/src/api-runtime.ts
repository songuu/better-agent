import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export type ProductApiMethod = 'GET' | 'POST';

export interface ProductApiExecutionRequest {
  readonly input: string;
  readonly method: ProductApiMethod;
  readonly responsePath: string;
  readonly url: string;
}

interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

interface ProductApiTransportRequest {
  readonly address: string;
  readonly body: Buffer;
  readonly hostname: string;
  readonly method: ProductApiMethod;
  readonly path: string;
  readonly timeoutMs: number;
}

interface ProductApiTransportResponse {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly statusCode: number;
}

export interface SecureProductApiRuntimeOptions {
  readonly lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly timeoutMs?: number;
  readonly transport?: (
    request: ProductApiTransportRequest,
  ) => Promise<ProductApiTransportResponse>;
}

const MAX_RESPONSE_BYTES = 32_768;
const REDIRECT_STATUSES = new Set([307, 308]);
const RESPONSE_PATH = /^[A-Za-z][A-Za-z0-9_]{0,39}(\.[A-Za-z][A-Za-z0-9_]{0,39}){0,5}$/u;

function invalidEndpoint(): never {
  throw new Error('custom_api_endpoint_is_invalid');
}

export function validateProductApiEndpoint(value: string): URL {
  if (typeof value !== 'string' || value.length < 12 || value.length > 2_000) invalidEndpoint();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidEndpoint();
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (url.port !== '' && url.port !== '443') ||
    hostname.length > 253 ||
    !hostname.includes('.') ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    invalidEndpoint();
  }
  return url;
}

export function validateProductApiResponsePath(value: string): string {
  if (typeof value !== 'string' || value.length > 200) {
    throw new Error('custom_api_response_path_is_invalid');
  }
  const path = value.trim();
  if (path !== '' && !RESPONSE_PATH.test(path)) {
    throw new Error('custom_api_response_path_is_invalid');
  }
  return path;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return isBlockedIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mapped !== undefined) return isBlockedIpv4(mapped);
  // Block hexadecimal IPv4-mapped forms too. Resolving them as IPv6 would
  // otherwise make private IPv4 destinations harder to classify safely.
  if (normalized.startsWith('::ffff:')) return true;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

async function defaultLookup(hostname: string): Promise<readonly LookupAddress[]> {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

async function defaultTransport(
  request: ProductApiTransportRequest,
): Promise<ProductApiTransportResponse> {
  return await new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        headers: {
          accept: 'application/json, text/plain;q=0.9',
          'content-length': request.body.length,
          ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}),
          host: request.hostname,
          'user-agent': 'better-agent-custom-api/1',
        },
        hostname: request.address,
        method: request.method,
        path: request.path,
        port: 443,
        rejectUnauthorized: true,
        servername: request.hostname,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('custom_api_response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            statusCode: response.statusCode ?? 0,
          });
        });
      },
    );
    outgoing.setTimeout(request.timeoutMs, () => {
      outgoing.destroy(new Error('custom_api_timeout'));
    });
    outgoing.on('error', reject);
    if (request.body.length > 0) outgoing.write(request.body);
    outgoing.end();
  });
}

function firstHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : value?.[0];
}

function scalarAtPath(body: Buffer, responsePath: string, contentType: string): string {
  const text = body.toString('utf8');
  if (responsePath === '') return text;
  if (!contentType.toLowerCase().includes('json')) {
    throw new Error('custom_api_response_is_not_json');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('custom_api_response_is_not_json');
  }
  for (const segment of responsePath.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('custom_api_response_path_not_found');
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new Error('custom_api_response_path_not_scalar');
}

export class SecureProductApiRuntime {
  readonly #lookup: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly #timeoutMs: number;
  readonly #transport: (
    request: ProductApiTransportRequest,
  ) => Promise<ProductApiTransportResponse>;

  constructor(options: SecureProductApiRuntimeOptions = {}) {
    this.#lookup = options.lookup ?? defaultLookup;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 10_000) {
      throw new Error('custom_api_timeout_is_invalid');
    }
    this.#transport = options.transport ?? defaultTransport;
  }

  async execute(request: ProductApiExecutionRequest): Promise<string> {
    if (request.method !== 'GET' && request.method !== 'POST') {
      throw new Error('custom_api_method_is_invalid');
    }
    if (typeof request.input !== 'string' || request.input.length > 8_000) {
      throw new Error('custom_api_input_is_invalid');
    }
    const responsePath = validateProductApiResponsePath(request.responsePath);
    return await this.#executeRedirect(
      request,
      validateProductApiEndpoint(request.url),
      responsePath,
      0,
    );
  }

  async #executeRedirect(
    request: ProductApiExecutionRequest,
    url: URL,
    responsePath: string,
    redirectCount: number,
  ): Promise<string> {
    const addresses = await this.#lookup(url.hostname);
    if (addresses.length === 0) throw new Error('custom_api_dns_not_found');
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      throw new Error('custom_api_private_address');
    }
    const target = new URL(url.href);
    const body =
      request.method === 'POST'
        ? Buffer.from(JSON.stringify({ input: request.input }))
        : Buffer.alloc(0);
    if (request.method === 'GET') target.searchParams.set('input', request.input);
    const address = addresses[0] as LookupAddress;
    const response = await this.#transport({
      address: address.address,
      body,
      hostname: target.hostname,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      timeoutMs: this.#timeoutMs,
    });
    if (REDIRECT_STATUSES.has(response.statusCode)) {
      if (redirectCount >= 2) throw new Error('custom_api_redirect_limit');
      const location = firstHeader(response.headers, 'location');
      if (location === undefined) throw new Error('custom_api_redirect_is_invalid');
      const redirected = validateProductApiEndpoint(new URL(location, target).href);
      return await this.#executeRedirect(request, redirected, responsePath, redirectCount + 1);
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`custom_api_http_status_${response.statusCode}`);
    }
    if (response.body.length > MAX_RESPONSE_BYTES) throw new Error('custom_api_response_too_large');
    const output = scalarAtPath(
      response.body,
      responsePath,
      firstHeader(response.headers, 'content-type') ?? '',
    );
    if (output.length > 20_000) throw new Error('custom_api_output_too_large');
    return output;
  }
}
