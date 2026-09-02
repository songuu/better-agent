import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { agentId, agentReleaseId, workspaceId } from './fixtures.js';
import { record } from './leaf-resource-source-fixtures.js';

// Ephemeral test-only keys: no production key material or trust configuration is read.
export const signer = generateKeyPairSync('ed25519');
export function independentCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${independentCanonical(record(value)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
export function trustedSigners() {
  return {
    schema_version: 'instruction-skill-trusted-signers/1',
    workspace_id: workspaceId,
    signers: [
      {
        key_id: 'publisher-key-1',
        publisher_id: 'publisher-1',
        source_id: 'reviewed-content',
        allowed_resource_ids: [agentId],
        public_key_spki_base64: signer.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64'),
      },
    ],
  };
}
export function file(path: string, content: Buffer) {
  return {
    path,
    chunks_base64: Array.from({ length: Math.ceil(content.length / 49_152) }, (_, index) =>
      content.subarray(index * 49_152, (index + 1) * 49_152).toString('base64'),
    ),
  };
}
export function manifestFile(path: string, kind: string, content: Buffer) {
  return { path, kind, size_bytes: content.length, content_hash: digest(content) };
}
export function signingPayload(input: ReturnType<typeof skillSource>) {
  const { signature, ...document } = input.document;
  return {
    schema_version: 'instruction-skill-signing-payload/1',
    canonicalizer_version: 'rfc8785/1',
    workspace_id: input.workspace_id,
    published_resource_kind: 'INSTRUCTION_SKILL_RELEASE',
    document: {
      ...document,
      manifest: [...document.manifest].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
      allowed_capability_binding_ids: [...document.allowed_capability_binding_ids].sort(),
    },
    signer: { algorithm: signature.algorithm, key_id: signature.key_id },
  };
}
export function resign(input: ReturnType<typeof skillSource>) {
  input.document.signature.signature_base64 = sign(
    null,
    Buffer.from(independentCanonical(signingPayload(input))),
    signer.privateKey,
  ).toString('base64');
  return input;
}
export function skillSource() {
  const entry = Buffer.from('# Procedure\nUse only the allowed lookup capability.\n', 'utf8');
  const reference = Buffer.from('Reference facts.\n');
  const script = Buffer.from('throw new Error("INERT_SCRIPT_MUST_NOT_RUN");');
  return {
    schema_version: 'instruction-skill-source-candidate/1',
    workspace_id: workspaceId,
    document: {
      schema_version: 'instruction-skill-source/1',
      resource_id: agentId,
      resource_version_id: agentReleaseId,
      name: 'Reviewed procedure',
      description: 'A signed inert procedure',
      parser_version: 'instruction-skill-bundle-parser/1',
      entry_path: 'SKILL.md',
      origin: {
        publisher_id: 'publisher-1',
        source_id: 'reviewed-content',
        revision: '2026-09-02',
      },
      manifest: [
        manifestFile('SKILL.md', 'instruction', entry),
        manifestFile('references/facts.md', 'reference', reference),
        manifestFile('scripts/helper.js', 'script', script),
      ],
      allowed_capability_binding_ids: ['plugin', 'knowledge'],
      context_budget_tokens: 2048,
      data_classification: 'internal',
      scripts: { mode: 'inert', requires_execution: false },
      signature: { algorithm: 'ed25519', key_id: 'publisher-key-1', signature_base64: '' },
    },
    files: [
      file('SKILL.md', entry),
      file('references/facts.md', reference),
      file('scripts/helper.js', script),
    ],
  };
}
export function signedSource() {
  return resign(skillSource());
}
export function replaceFile(
  input: ReturnType<typeof skillSource>,
  path: string,
  kind: string,
  bytes: Buffer,
) {
  input.files = input.files.filter((item) => item.path !== path);
  input.files.push(file(path, bytes));
  input.document.manifest = input.document.manifest.filter((item) => item.path !== path);
  input.document.manifest.push(manifestFile(path, kind, bytes));
  return resign(input);
}
