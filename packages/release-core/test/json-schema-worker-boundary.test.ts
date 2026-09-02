import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareJsonSchemaContract as prepare,
  validateJsonSchemaInstance as validate,
} from '../src/index.js';

interface FakeWorker {
  options: Record<string, unknown>;
  url: URL;
  emit(event: string, ...args: unknown[]): boolean;
  stdout: { emit(event: string, ...args: unknown[]): boolean };
  stderr: { emit(event: string, ...args: unknown[]): boolean };
  terminate(): Promise<number>;
}
const state = vi.hoisted(() => ({
  workers: [] as FakeWorker[],
  failConstructor: false,
  holdExit: false,
  failTermination: false,
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      terminate = vi.fn(async () => {
        if (state.failTermination) throw new Error('private termination diagnostics');
        if (!state.holdExit) queueMicrotask(() => this.emit('exit', 1));
        return 1;
      });
      constructor(
        readonly url: URL,
        readonly options: Record<string, unknown>,
      ) {
        super();
        if (state.failConstructor) throw new Error('private host diagnostics');
        state.workers.push(this);
      }
    },
  };
});
function lastWorker() {
  const worker = state.workers.at(-1);
  if (!worker) throw new Error('worker missing');
  return worker;
}
function succeed(worker = lastWorker()) {
  worker.emit('message', 'ok');
  worker.emit('exit', 0);
}

afterEach(() => {
  state.failConstructor = false;
  state.holdExit = false;
  state.failTermination = false;
  vi.useRealTimers();
});
describe('JSON Schema worker lifecycle boundary (real engine tested separately)', () => {
  it('uses a fixed module, clean options and waits for successful exit after a reply', async () => {
    const pending = prepare({ type: 'integer' });
    const worker = lastWorker();
    expect(worker.url.pathname).toMatch(/\/json-schema-validation-worker\.mjs$/u);
    expect(worker.options).toEqual({
      workerData: { schema: '{"type":"integer"}' },
      env: {},
      execArgv: [],
      argv: [],
      stdin: false,
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    worker.emit('message', 'ok');
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.emit('exit', 0);
    expect((await pending).document).toEqual({ type: 'integer' });
  });
  it.each([
    'missing',
    'duplicate',
    'invalid',
    'object',
    'error',
    'messageerror',
    'stdout',
    'stderr',
    'nonzero',
  ])('fails closed for worker %s and never returns its diagnostics', async (axis) => {
    const pending = prepare({});
    const worker = lastWorker();
    const assertion = expect(pending).rejects.toThrow('JSON_SCHEMA_VALIDATOR_UNAVAILABLE');
    if (axis === 'missing') worker.emit('exit', 0);
    if (axis === 'duplicate') {
      worker.emit('message', 'ok');
      worker.emit('message', 'ok');
    }
    if (axis === 'invalid') worker.emit('message', 'private host diagnostics');
    if (axis === 'object') worker.emit('message', { status: 'ok' });
    if (axis === 'error') {
      worker.emit('error', new Error('private host diagnostics'));
      worker.emit('exit', 0);
    }
    if (axis === 'messageerror') worker.emit('messageerror', new Error('private host diagnostics'));
    if (axis === 'stdout' || axis === 'stderr')
      worker[axis].emit('data', Buffer.from('private host diagnostics'));
    if (axis === 'nonzero') {
      worker.emit('message', 'ok');
      worker.emit('exit', 1);
    }
    await assertion;
    const recovered = prepare({});
    succeed();
    await expect(recovered).resolves.toBeDefined();
  });
  it.each([
    ['invalid_schema', 'JSON_SCHEMA_INVALID'],
    ['invalid_instance', 'JSON_SCHEMA_INSTANCE_INVALID'],
    ['limit', 'JSON_SCHEMA_LIMIT_EXCEEDED'],
  ])('maps worker status %s to bounded public error', async (status, code) => {
    const pending = validate({}, {});
    const worker = lastWorker();
    worker.emit('message', status);
    worker.emit('exit', 0);
    await expect(pending).rejects.toThrow(code);
  });
  it('releases admission after constructor failures', async () => {
    state.failConstructor = true;
    for (let i = 0; i < 6; i++)
      await expect(prepare({})).rejects.toThrow('JSON_SCHEMA_VALIDATOR_UNAVAILABLE');
    state.failConstructor = false;
    const pending = prepare({});
    succeed();
    await expect(pending).resolves.toBeDefined();
  });
  it('terminates a timed-out worker exactly once and releases its slot only on exit', async () => {
    vi.useFakeTimers();
    const pending = prepare({});
    const worker = lastWorker();
    const assertion = expect(pending).rejects.toThrow('JSON_SCHEMA_LIMIT_EXCEEDED');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const recovered = prepare({});
    succeed();
    await expect(recovered).resolves.toBeDefined();
  });
  it('maps worker memory exhaustion to a resource error', async () => {
    const pending = prepare({});
    const worker = lastWorker();
    worker.emit(
      'error',
      Object.assign(new Error('private heap diagnostics'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }),
    );
    worker.emit('exit', 1);
    await expect(pending).rejects.toThrow('JSON_SCHEMA_LIMIT_EXCEEDED');
  });
  it.each(['timeout', 'protocol', 'termination-rejection'])(
    'keeps all four slots until actual exit after %s and terminates each worker once',
    async (axis) => {
      vi.useFakeTimers();
      state.holdExit = true;
      state.failTermination = axis === 'termination-rejection';
      const pending = Array.from({ length: 4 }, () => prepare({}));
      const workers = state.workers.slice(-4);
      const assertions = pending.map(async (promise) => {
        await expect(promise).rejects.toThrow(
          axis === 'timeout' ? 'JSON_SCHEMA_LIMIT_EXCEEDED' : 'JSON_SCHEMA_VALIDATOR_UNAVAILABLE',
        );
      });
      if (axis !== 'timeout')
        for (const worker of workers) worker.emit('messageerror', new Error('private error'));
      await vi.advanceTimersByTimeAsync(5000);
      for (const worker of workers) {
        worker.stdout.emit('data', Buffer.from('private output'));
        worker.emit('messageerror', new Error('private error'));
        expect(worker.terminate).toHaveBeenCalledTimes(1);
      }
      await expect(prepare({})).rejects.toThrow('JSON_SCHEMA_VALIDATOR_BUSY');
      for (const worker of workers) worker.emit('exit', 1);
      await Promise.all(assertions);
      const recovered = prepare({});
      succeed();
      await expect(recovered).resolves.toBeDefined();
    },
  );
});
