import { Pool } from 'pg';

import { PostgresWorkerJobStore } from './postgres-worker-store.js';
import {
  createWorkerCycle,
  runWorkerLoop,
  workerConfigurationFromEnvironment,
} from './worker-service.js';

async function main(): Promise<void> {
  const configuration = workerConfigurationFromEnvironment();
  const pool = new Pool({ max: 2 });
  const store = new PostgresWorkerJobStore(
    pool,
    configuration.workerId,
    configuration.leaseSeconds,
  );
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runWorkerLoop({
      cycle: createWorkerCycle(store, configuration.modelRuntime, configuration.leaseSeconds),
      idleDelayMs: configuration.idleDelayMs,
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await pool.end();
  }
}

main().catch(() => {
  // Provider and database diagnostics can contain secrets; systemd receives only a stable code.
  process.stderr.write('better_agent_worker_failed\n');
  process.exitCode = 1;
});
