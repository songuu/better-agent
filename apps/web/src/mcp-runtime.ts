import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

import { isBlockedAddress, validateProductApiEndpoint } from './api-runtime.js';

interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

export interface McpToolCallRequest {
  readonly endpointUrl: string;
  readonly input: string;
  readonly requestId: string;
  readonly toolName: string;
}

export interface ProductMcpRuntime {
  callTool(request: McpToolCallRequest): Promise<string>;
}

interface McpTransportRequest {
  readonly address: string;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly hostname: string;
  readonly path: string;
  readonly timeoutMs: number;
}

interface McpTransportResponse {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly statusCode: number;
}

export interface SecureMcpRuntimeOptions {
  readonly lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly timeoutMs?: number;
  readonly transport?: (request: McpTransportRequest) => Promise<McpTransportResponse>;
}

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_RESPONSE_BYTES = 32_768;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u;

function firstHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : value?.[0];
}

export function validateMcpEndpoint(value: string): URL {
  try {
    return validateProductApiEndpoint(value);
  } catch (cause) {
    throw new Error('mcp_endpoint_is_invalid', { cause });
  }
}

async function defaultLookup(hostname: string): Promise<readonly LookupAddress[]> {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

async function defaultTransport(request: McpTransportRequest): Promise<McpTransportResponse> {
  return await new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        headers: {
          ...request.headers,
          'content-length': request.body.length,
          host: request.hostname,
          'user-agent': 'better-agent-mcp/1',
        },
        hostname: request.address,
        method: 'POST',
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
            response.destroy(new Error('mcp_response_too_large'));
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
    outgoing.setTimeout(request.timeoutMs, () => outgoing.destroy(new Error('mcp_timeout')));
    outgoing.on('error', reject);
    outgoing.write(request.body);
    outgoing.end();
  });
}

function parseJsonResponse(response: McpTransportResponse): Record<string, unknown> {
  if (response.statusCode < 200 || response.statusCode > 299) {
    throw new Error(`mcp_http_status_${String(response.statusCode)}`);
  }
  if (response.body.length > MAX_RESPONSE_BYTES) throw new Error('mcp_response_too_large');
  if (!(firstHeader(response.headers, 'content-type') ?? '').toLowerCase().includes('json')) {
    throw new Error('mcp_response_is_not_json');
  }
  try {
    const value: unknown = JSON.parse(response.body.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== '2.0' || 'error' in record) throw new Error();
    return record;
  } catch (cause) {
    throw new Error('mcp_protocol_error', { cause });
  }
}

function toolText(payload: Record<string, unknown>): string {
  const result = payload.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('mcp_tool_result_is_invalid');
  }
  const record = result as Record<string, unknown>;
  if (record.isError === true || !Array.isArray(record.content)) {
    throw new Error(
      record.isError === true ? 'mcp_tool_reported_error' : 'mcp_tool_result_is_invalid',
    );
  }
  const parts: string[] = [];
  for (const item of record.content) {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      (item as Record<string, unknown>).type !== 'text' ||
      typeof (item as Record<string, unknown>).text !== 'string'
    ) {
      throw new Error('mcp_tool_result_is_not_text');
    }
    parts.push((item as { readonly text: string }).text);
  }
  const output = parts.join('\n').trim();
  if (output.length < 1 || output.length > 20_000) throw new Error('mcp_tool_output_is_invalid');
  return output;
}

function requireResponseId(payload: Record<string, unknown>, expected: string): void {
  if (payload.id !== expected) throw new Error('mcp_response_id_mismatch');
}

export class SecureMcpRuntime implements ProductMcpRuntime {
  readonly #lookup: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly #timeoutMs: number;
  readonly #transport: (request: McpTransportRequest) => Promise<McpTransportResponse>;

  constructor(options: SecureMcpRuntimeOptions = {}) {
    this.#lookup = options.lookup ?? defaultLookup;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 10_000) {
      throw new Error('mcp_timeout_is_invalid');
    }
    this.#transport = options.transport ?? defaultTransport;
  }

  async callTool(request: McpToolCallRequest): Promise<string> {
    if (
      typeof request.input !== 'string' ||
      request.input.length < 1 ||
      request.input.length > 8_000 ||
      typeof request.requestId !== 'string' ||
      request.requestId.length < 1 ||
      request.requestId.length > 200 ||
      !TOOL_NAME.test(request.toolName)
    ) {
      throw new Error('mcp_tool_call_is_invalid');
    }
    const url = validateMcpEndpoint(request.endpointUrl);
    const addresses = await this.#lookup(url.hostname);
    if (addresses.length === 0) throw new Error('mcp_dns_not_found');
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      throw new Error('mcp_private_address');
    }
    const address = addresses[0] as LookupAddress;
    const invoke = async (
      body: Record<string, unknown>,
      sessionId?: string,
    ): Promise<McpTransportResponse> =>
      await this.#transport({
        address: address.address,
        body: Buffer.from(JSON.stringify(body)),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
          ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
        },
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        timeoutMs: this.#timeoutMs,
      });

    const initialized = await invoke({
      id: `${request.requestId}:initialize`,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'better-agent', version: '1' },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    });
    const initialization = parseJsonResponse(initialized);
    requireResponseId(initialization, `${request.requestId}:initialize`);
    const result = initialization.result;
    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      (result as Record<string, unknown>).protocolVersion !== MCP_PROTOCOL_VERSION
    ) {
      throw new Error('mcp_protocol_version_mismatch');
    }
    const sessionId = firstHeader(initialized.headers, 'mcp-session-id');
    if (sessionId !== undefined && !/^[\x21-\x7e]{1,200}$/u.test(sessionId)) {
      throw new Error('mcp_session_id_is_invalid');
    }
    const notification = await invoke(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
    if (notification.statusCode < 200 || notification.statusCode > 299) {
      throw new Error(`mcp_http_status_${String(notification.statusCode)}`);
    }
    const called = await invoke(
      {
        id: `${request.requestId}:call`,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: { input: request.input }, name: request.toolName },
      },
      sessionId,
    );
    const toolResult = parseJsonResponse(called);
    requireResponseId(toolResult, `${request.requestId}:call`);
    return toolText(toolResult);
  }
}
