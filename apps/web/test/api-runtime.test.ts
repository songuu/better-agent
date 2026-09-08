import { describe, expect, it, vi } from 'vitest';

import { SecureProductApiRuntime, validateProductApiEndpoint } from '../src/api-runtime.js';

describe('secure product API runtime', () => {
  it('accepts only public HTTPS endpoints on the canonical port', () => {
    expect(validateProductApiEndpoint('https://api.example.com/v1/run').href).toBe(
      'https://api.example.com/v1/run',
    );
    for (const endpoint of [
      'http://api.example.com/run',
      'https://localhost/run',
      'https://10.0.0.1/run',
      'https://user:secret@api.example.com/run',
      'https://api.example.com:8443/run',
      'https://api.example.com/run#secret',
    ]) {
      expect(() => validateProductApiEndpoint(endpoint)).toThrow('custom_api_endpoint');
    }
  });

  it('pins a public DNS answer, sends a bounded request and extracts a scalar response path', async () => {
    const transport = vi.fn(async () => ({
      body: Buffer.from('{"data":{"answer":"ready"}}'),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    }));
    const runtime = new SecureProductApiRuntime({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
    });

    await expect(
      runtime.execute({
        input: 'hello',
        method: 'POST',
        responsePath: 'data.answer',
        url: 'https://api.example.com/v1/run',
      }),
    ).resolves.toBe('ready');
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '93.184.216.34',
        body: Buffer.from('{"input":"hello"}'),
        hostname: 'api.example.com',
        method: 'POST',
        path: '/v1/run',
      }),
    );
  });

  it('fails closed for private DNS, redirect escape, non-2xx and oversized responses', async () => {
    const privateRuntime = new SecureProductApiRuntime({
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
      transport: vi.fn(),
    });
    await expect(
      privateRuntime.execute({
        input: 'x',
        method: 'GET',
        responsePath: '',
        url: 'https://api.example.com/value',
      }),
    ).rejects.toThrow('custom_api_private_address');

    const mappedPrivateRuntime = new SecureProductApiRuntime({
      lookup: async () => [{ address: '::ffff:7f00:1', family: 6 }],
      transport: vi.fn(),
    });
    await expect(
      mappedPrivateRuntime.execute({
        input: 'x',
        method: 'GET',
        responsePath: '',
        url: 'https://api.example.com/value',
      }),
    ).rejects.toThrow('custom_api_private_address');

    const redirectRuntime = new SecureProductApiRuntime({
      lookup: async (hostname) => [
        { address: hostname === 'api.example.com' ? '93.184.216.34' : '127.0.0.1', family: 4 },
      ],
      transport: async () => ({
        body: Buffer.alloc(0),
        headers: { location: 'https://internal.example.net/value' },
        statusCode: 307,
      }),
    });
    await expect(
      redirectRuntime.execute({
        input: 'x',
        method: 'GET',
        responsePath: '',
        url: 'https://api.example.com/value',
      }),
    ).rejects.toThrow('custom_api_private_address');

    for (const response of [
      { body: Buffer.from('no'), headers: { 'content-type': 'text/plain' }, statusCode: 503 },
      {
        body: Buffer.alloc(32_769),
        headers: { 'content-type': 'text/plain' },
        statusCode: 200,
      },
    ]) {
      const runtime = new SecureProductApiRuntime({
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => response,
      });
      await expect(
        runtime.execute({
          input: 'x',
          method: 'GET',
          responsePath: '',
          url: 'https://api.example.com/value',
        }),
      ).rejects.toThrow(/custom_api_(http_status|response_too_large)/u);
    }
  });
});
