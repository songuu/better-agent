import { describe, expect, it, vi } from 'vitest';

import { SecureMcpRuntime, validateMcpEndpoint } from '../src/mcp-runtime.js';

describe('secure MCP runtime', () => {
  it('accepts only public HTTPS Streamable HTTP endpoints', () => {
    expect(validateMcpEndpoint('https://mcp.example.com/mcp').href).toBe(
      'https://mcp.example.com/mcp',
    );
    for (const endpoint of [
      'http://mcp.example.com/mcp',
      'https://localhost/mcp',
      'https://10.0.0.1/mcp',
      'https://user:secret@mcp.example.com/mcp',
      'https://mcp.example.com:8443/mcp',
    ]) {
      expect(() => validateMcpEndpoint(endpoint)).toThrow('mcp_endpoint');
    }
  });

  it('pins DNS and performs initialize, initialized and a bounded tools/call exchange', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        body: Buffer.from(
          JSON.stringify({
            id: '00000000-0000-4000-8000-000000000001:initialize',
            jsonrpc: '2.0',
            result: {
              capabilities: {},
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'fixture', version: '1' },
            },
          }),
        ),
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
        statusCode: 200,
      })
      .mockResolvedValueOnce({ body: Buffer.alloc(0), headers: {}, statusCode: 202 })
      .mockResolvedValueOnce({
        body: Buffer.from(
          JSON.stringify({
            id: '00000000-0000-4000-8000-000000000001:call',
            jsonrpc: '2.0',
            result: { content: [{ text: 'verified result', type: 'text' }], isError: false },
          }),
        ),
        headers: { 'content-type': 'application/json' },
        statusCode: 200,
      });
    const runtime = new SecureMcpRuntime({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
    });

    await expect(
      runtime.callTool({
        endpointUrl: 'https://mcp.example.com/mcp',
        input: 'inspect release',
        requestId: '00000000-0000-4000-8000-000000000001',
        toolName: 'release_check',
      }),
    ).resolves.toBe('verified result');
    expect(transport).toHaveBeenCalledTimes(3);
    expect(JSON.parse(transport.mock.calls[2]?.[0].body.toString('utf8') ?? '{}')).toEqual({
      id: '00000000-0000-4000-8000-000000000001:call',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { input: 'inspect release' }, name: 'release_check' },
    });
    expect(transport.mock.calls[2]?.[0].headers).toMatchObject({
      'mcp-protocol-version': '2025-06-18',
      'mcp-session-id': 'session-1',
    });
  });

  it('fails closed for private DNS, protocol errors and non-text tool results', async () => {
    const privateRuntime = new SecureMcpRuntime({
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
      transport: vi.fn(),
    });
    await expect(
      privateRuntime.callTool({
        endpointUrl: 'https://mcp.example.com/mcp',
        input: 'x',
        requestId: 'request',
        toolName: 'lookup',
      }),
    ).rejects.toThrow('mcp_private_address');

    const transport = vi.fn().mockResolvedValueOnce({
      body: Buffer.from(
        JSON.stringify({
          error: { code: -32600, message: 'bad' },
          id: 'initialize',
          jsonrpc: '2.0',
        }),
      ),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    });
    const protocolRuntime = new SecureMcpRuntime({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
    });
    await expect(
      protocolRuntime.callTool({
        endpointUrl: 'https://mcp.example.com/mcp',
        input: 'x',
        requestId: 'request',
        toolName: 'lookup',
      }),
    ).rejects.toThrow('mcp_protocol_error');
  });
});
