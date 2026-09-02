import { Worker } from 'node:worker_threads';
import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError, type ReleaseCoreErrorCode } from './errors.js';
import { canonicalSha256 } from './hash.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { snapshotSource, sourceEqual } from './source-contract-data.js';
import { JSON_SCHEMA_VALIDATOR_PROFILE } from './json-schema-profile.mjs';

function failure(code: ReleaseCoreErrorCode): ReleaseCoreError {
  return new ReleaseCoreError(code, '$', 'schema validation did not satisfy its bounded contract');
}
function snapshot(input: unknown, instance = false): unknown {
  try {
    return snapshotSource(input);
  } catch (error) {
    throw failure(
      error instanceof ReleaseCoreError && error.code === 'CLOSURE_SOURCE_LIMIT_EXCEEDED'
        ? 'JSON_SCHEMA_LIMIT_EXCEEDED'
        : instance
          ? 'JSON_SCHEMA_INSTANCE_INVALID'
          : 'JSON_SCHEMA_INVALID',
    );
  }
}

let activeWorkers = 0;
async function check(document: unknown, value?: { instance: unknown }): Promise<void> {
  if (activeWorkers >= JSON_SCHEMA_VALIDATOR_PROFILE.maximum_workers)
    throw failure('JSON_SCHEMA_VALIDATOR_BUSY');
  const workerData = {
    schema: canonicalJsonBytes(document).toString('utf8'),
    ...(value === undefined
      ? {}
      : { instance: canonicalJsonBytes(value.instance).toString('utf8') }),
  };
  activeWorkers++;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./json-schema-validation-worker.mjs', import.meta.url), {
      workerData,
      env: {},
      execArgv: [],
      argv: [],
      stdin: false,
      stdout: true,
      stderr: true,
      resourceLimits: { ...JSON_SCHEMA_VALIDATOR_PROFILE.resource_limits },
    });
  } catch {
    activeWorkers--;
    throw failure('JSON_SCHEMA_VALIDATOR_UNAVAILABLE');
  }
  await new Promise<void>((resolve, reject) => {
    let reply: unknown;
    let terminalFailure: ReleaseCoreErrorCode | undefined;
    let stopped = false;
    const stop = (code: ReleaseCoreErrorCode) => {
      terminalFailure ??= code;
      if (!stopped) {
        stopped = true;
        // Keep the concurrency slot until the exit event, including failed termination.
        void worker.terminate().catch(() => reject(failure('JSON_SCHEMA_VALIDATOR_UNAVAILABLE')));
      }
    };
    const timer = setTimeout(
      () => stop('JSON_SCHEMA_LIMIT_EXCEEDED'),
      JSON_SCHEMA_VALIDATOR_PROFILE.worker_deadline_ms,
    );
    worker.on('message', (message: unknown) => {
      if (
        reply !== undefined ||
        typeof message !== 'string' ||
        !['ok', 'invalid_schema', 'invalid_instance', 'limit'].includes(message)
      )
        stop('JSON_SCHEMA_VALIDATOR_UNAVAILABLE');
      else reply = message;
    });
    worker.on('messageerror', () => stop('JSON_SCHEMA_VALIDATOR_UNAVAILABLE'));
    worker.on('error', (error: Error & { code?: string }) => {
      terminalFailure ??=
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? 'JSON_SCHEMA_LIMIT_EXCEEDED'
          : 'JSON_SCHEMA_VALIDATOR_UNAVAILABLE';
    });
    worker.stdout.on('data', () => stop('JSON_SCHEMA_VALIDATOR_UNAVAILABLE'));
    worker.stderr.on('data', () => stop('JSON_SCHEMA_VALIDATOR_UNAVAILABLE'));
    worker.once('exit', (code) => {
      clearTimeout(timer);
      activeWorkers--;
      const error =
        terminalFailure ??
        (code !== 0
          ? 'JSON_SCHEMA_VALIDATOR_UNAVAILABLE'
          : reply === 'ok'
            ? undefined
            : reply === 'invalid_schema'
              ? 'JSON_SCHEMA_INVALID'
              : reply === 'invalid_instance'
                ? 'JSON_SCHEMA_INSTANCE_INVALID'
                : reply === 'limit'
                  ? 'JSON_SCHEMA_LIMIT_EXCEEDED'
                  : 'JSON_SCHEMA_VALIDATOR_UNAVAILABLE');
      if (error === undefined) resolve();
      else reject(failure(error));
    });
  });
}

export interface PreparedJsonSchemaContractV1 {
  readonly schema_version: 'prepared-json-schema-contract/1';
  readonly document: unknown;
  readonly schema_hash: `sha256:${string}`;
  readonly validator_profile: typeof JSON_SCHEMA_VALIDATOR_PROFILE;
  readonly validator_profile_hash: `sha256:${string}`;
  readonly contract_hash: `sha256:${string}`;
}

/** Validate a single, self-contained 2020-12 schema. This is not publisher provenance or runtime authorization. */
export async function prepareJsonSchemaContract(
  input: unknown,
): Promise<PreparedJsonSchemaContractV1> {
  const document = snapshot(input);
  await check(document);
  const schema_hash = canonicalSha256(document);
  const validator_profile_hash = canonicalSha256(JSON_SCHEMA_VALIDATOR_PROFILE);
  const result: PreparedJsonSchemaContractV1 = {
    schema_version: 'prepared-json-schema-contract/1',
    document,
    schema_hash,
    validator_profile: JSON_SCHEMA_VALIDATOR_PROFILE,
    validator_profile_hash,
    contract_hash: canonicalSha256({
      schema_version: 'json-schema-validation-contract/1',
      schema_hash,
      validator_profile_hash,
    }),
  };
  snapshot(result);
  return deepFreezeJson(result);
}

export async function verifyJsonSchemaContract(
  expected: unknown,
  input: unknown,
): Promise<PreparedJsonSchemaContractV1> {
  const expectedSnapshot = snapshot(expected);
  const actual = await prepareJsonSchemaContract(input);
  if (!sourceEqual(expectedSnapshot, actual)) throw failure('JSON_SCHEMA_CONTRACT_MISMATCH');
  return actual;
}

/** Revalidate real input without coercion/defaults/property removal; return only detached frozen data. */
export async function validateJsonSchemaInstance(
  schemaInput: unknown,
  input: unknown,
): Promise<unknown> {
  const document = snapshot(schemaInput);
  const instance = snapshot(input, true);
  await check(document, { instance });
  return deepFreezeJson(instance);
}
