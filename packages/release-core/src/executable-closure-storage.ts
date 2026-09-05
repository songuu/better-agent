import { types } from 'node:util';
import { AgentReleaseV1Schema, FlowIrV1Schema } from '@better-agent/domain-contracts';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { prepareCompiledCapabilityClosure } from './compiled-capability-closure.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256 } from './hash.js';

// These wire limits are additional to the compiler's object/string allocation limits.
const sourceBytes = 8_388_608;
const closureBytes = 33_554_432;

function invalid(path: string, reason: string): never {
  throw new ReleaseCoreError('CLOSURE_SOURCE_MISMATCH', path, reason);
}

function record(value: unknown, keys: readonly string[], path: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value))
    invalid(path, 'storage record must be a plain data object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(path, 'storage record prototype is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  )
    invalid(path, 'storage record fields differ from the closed projection');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      invalid(`${path}.${key}`, 'storage getters and hidden fields are forbidden');
    result[key] = descriptor.value;
  }
  return result;
}

function encode(value: unknown, maximum: number, path: string): string {
  const bytes = canonicalJsonBytes(value);
  if (bytes.length > maximum) invalid(path, 'canonical storage bytes exceed the wire limit');
  return bytes.toString('utf8');
}

function decode(value: unknown, maximum: number, profile: 'source' | 'closure', path: string) {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    Buffer.byteLength(value, 'utf8') > maximum
  )
    invalid(path, 'stored text is missing or exceeds the wire limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid(path, 'stored text is not valid JSON');
  }
  const snapshot = boundedDataSnapshot(parsed, profile);
  if (encode(snapshot, maximum, path) !== value)
    invalid(path, 'stored JSON must use exact canonical bytes');
  return snapshot;
}

function same(left: unknown, right: unknown, path: string) {
  if (!canonicalJsonBytes(left).equals(canonicalJsonBytes(right)))
    invalid(path, 'stored executable evidence differs from independent recomputation');
}

/** Private persistence projection: content consistency only, never registry/compiler authority. */
export function prepareExecutableClosureStorage(sourceInput: unknown, closureInput: unknown) {
  const input = boundedDataSnapshot(sourceInput, 'source');
  const source = prepareExecutableSource(input);
  const closure = prepareCompiledCapabilityClosure(closureInput);
  same(closure.root, source.root, '$.closure.root');
  same(closure.assembly_pins, source.dependency_manifest.dependencies, '$.closure.assembly_pins');
  const rootNode = closure.resource_nodes.find((node) => node.node_role === 'root');
  if (rootNode?.dependency_manifest_hash !== source.dependency_manifest.manifest_hash)
    invalid(
      '$.closure.resource_nodes',
      'closure root does not bind the source dependency manifest',
    );
  const compiledPreimage = {
    ...source.preimage,
    schema_version: 'executable-compiled-preimage/1',
    capability_closure_hash: closure.closure_hash,
  };
  const fullPin = { ...source.root.pin, contract_hash: canonicalSha256(compiledPreimage) };
  const sourceDocument = (input as { document: Record<string, unknown> }).document;
  const document =
    source.root.pin.published_resource_kind === 'AGENT_RELEASE'
      ? {
          ...sourceDocument,
          schema_version: 'agent-release/1',
          compiled_hash: fullPin.contract_hash,
          capability_closure_hash: closure.closure_hash,
        }
      : sourceDocument;
  const { closure_hash: _hash, ...closurePreimage } = closure;
  return deepFreezeJson({
    prepared_resource: {
      schema_version: 'prepared-published-resource/1' as const,
      full_pin: fullPin,
      canonical_document: encode(document, sourceBytes, '$.canonical_document'),
      dependency_manifest: source.dependency_manifest,
    },
    canonical_compiled_preimage: encode(
      compiledPreimage,
      sourceBytes,
      '$.canonical_compiled_preimage',
    ),
    canonical_closure_preimage: encode(
      closurePreimage,
      closureBytes,
      '$.canonical_closure_preimage',
    ),
  });
}

/** The expected pin must come from the caller's trusted selection, not the returned row. */
export function verifyExecutableClosureStorage(expectedPin: unknown, input: unknown) {
  const storage = record(
    input,
    ['prepared_resource', 'canonical_compiled_preimage', 'canonical_closure_preimage'],
    '$',
  );
  const prepared = record(
    storage.prepared_resource,
    ['schema_version', 'full_pin', 'canonical_document', 'dependency_manifest'],
    '$.prepared_resource',
  );
  const pin = boundedDataSnapshot(prepared.full_pin, 'identity');
  const expected = boundedDataSnapshot(expectedPin, 'identity');
  same(pin, expected, '$.expected_pin');
  const document = decode(
    prepared.canonical_document,
    sourceBytes,
    'source',
    '$.canonical_document',
  );
  const parsedAgent = AgentReleaseV1Schema.safeParse(document);
  const parsedFlow = parsedAgent.success ? undefined : FlowIrV1Schema.safeParse(document);
  if (!parsedAgent.success && !parsedFlow?.success)
    invalid('$.canonical_document', 'stored typed release is invalid');
  let sourceDocument: unknown;
  if (parsedAgent.success) {
    same(document, parsedAgent.data, '$.canonical_document');
    const {
      compiled_hash: _compiled,
      capability_closure_hash: _closure,
      ...body
    } = parsedAgent.data;
    sourceDocument = { ...body, schema_version: 'agent-executable-source/1' };
  } else {
    sourceDocument = document;
  }
  const closurePreimage = decode(
    storage.canonical_closure_preimage,
    closureBytes,
    'closure',
    '$.canonical_closure_preimage',
  );
  if (
    typeof closurePreimage !== 'object' ||
    closurePreimage === null ||
    Array.isArray(closurePreimage) ||
    Object.hasOwn(closurePreimage, 'closure_hash')
  )
    invalid('$.canonical_closure_preimage', 'closure preimage must omit its own hash');
  const closure = prepareCompiledCapabilityClosure({
    ...closurePreimage,
    closure_hash: canonicalSha256(closurePreimage),
  });
  const sourceInput = {
    schema_version: 'executable-source-candidate/1',
    workspace_id: (pin as { workspace_id: string }).workspace_id,
    document: sourceDocument,
  };
  const actual = prepareExecutableClosureStorage(sourceInput, closure);
  same(pin, actual.prepared_resource.full_pin, '$.full_pin');
  same(
    boundedDataSnapshot(prepared.dependency_manifest, 'source'),
    actual.prepared_resource.dependency_manifest,
    '$.dependency_manifest',
  );
  if (
    prepared.schema_version !== actual.prepared_resource.schema_version ||
    prepared.canonical_document !== actual.prepared_resource.canonical_document ||
    storage.canonical_compiled_preimage !== actual.canonical_compiled_preimage ||
    storage.canonical_closure_preimage !== actual.canonical_closure_preimage
  )
    invalid('$', 'stored text or schema differs from the source/closure projection');
  return deepFreezeJson({
    source: prepareExecutableSource(sourceInput),
    closure,
    full_pin: actual.prepared_resource.full_pin,
  });
}
