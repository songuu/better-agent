import { createHash, createPublicKey } from 'node:crypto';
import {
  CapabilityBindingV1Schema,
  InstructionSkillBindingV1Schema,
  InstructionSkillSourceCandidateV1Schema,
  InstructionSkillTrustedSignersV1Schema,
  type InstructionSkillFileV1,
  type InstructionSkillSourceCandidateV1,
  type InstructionSkillSourceV1,
  type PublishedResourcePinV1,
} from '@better-agent/domain-contracts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { canonicalJsonBytes } from './canonical-json.js';
import {
  compareCanonicalStrings,
  deepFreezeJson,
  deriveDependencyManifest,
} from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { prepareExecutableSource } from './executable-source.js';
import { canonicalSha256 } from './hash.js';
import {
  invalidSource,
  mismatchedSource,
  parseSourceLosslessly,
  snapshotSource,
  sourceEqual,
} from './source-contract-data.js';

function invalidSignature(): never {
  throw new ReleaseCoreError(
    'INSTRUCTION_SKILL_SIGNATURE_INVALID',
    '$.signature',
    'content signature or trusted signer scope does not match',
  );
}
function limit(): never {
  throw new ReleaseCoreError(
    'CLOSURE_SOURCE_LIMIT_EXCEEDED',
    '$.files',
    'decoded Skill content exceeds its absolute budget',
  );
}
function bytesHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function decodeCanonicalBase64(value: string, fail: () => never): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail();
  return bytes;
}

function hasControlCharacters(value: string, allowTextWhitespace = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code < 32 || (code >= 127 && code <= 159)) &&
      !(allowTextWhitespace && (code === 9 || code === 10 || code === 13))
    )
      return true;
  }
  return false;
}

function checkPath(path: string): string {
  if (
    path.normalize('NFC') !== path ||
    Buffer.byteLength(path, 'utf8') > 1_024 ||
    /[\\:*?"<>|%]/u.test(path) ||
    hasControlCharacters(path)
  )
    invalidSource();
  const parts = path.split('/');
  if (
    parts.length > 8 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        /[. ]$/u.test(part) ||
        Buffer.byteLength(part, 'utf8') > 128 ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
    )
  )
    invalidSource();
  return path.toUpperCase().normalize('NFC');
}

function readFiles(candidate: InstructionSkillSourceCandidateV1): string {
  const { document, files } = candidate;
  if (files.length !== document.manifest.length) invalidSource();
  const paths = new Set<string>();
  for (const item of document.manifest) {
    const canonical = checkPath(item.path);
    if (paths.has(canonical)) invalidSource();
    paths.add(canonical);
    const expectedPrefix = {
      instruction: 'SKILL.md',
      reference: 'references/',
      asset: 'assets/',
      script: 'scripts/',
    }[item.kind];
    if (
      item.kind === 'instruction'
        ? item.path !== document.entry_path
        : !item.path.startsWith(expectedPrefix)
    )
      invalidSource();
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join('/'))) invalidSource();
  }
  const manifest = new Map(document.manifest.map((item) => [item.path, item]));
  let total = 0;
  let entryText: string | undefined;
  for (const file of files) {
    checkPath(file.path);
    const expected = manifest.get(file.path);
    if (expected === undefined) invalidSource();
    const chunks = file.chunks_base64.map((chunk, index) => {
      const bytes = decodeCanonicalBase64(chunk, invalidSource);
      if (
        bytes.length === 0 ||
        bytes.length > 49_152 ||
        (index < file.chunks_base64.length - 1 && bytes.length !== 49_152)
      )
        invalidSource();
      return bytes;
    });
    const length = chunks.reduce((sum, bytes) => sum + bytes.length, 0);
    if (length !== expected.size_bytes || length > 1_048_576) invalidSource();
    total += length;
    if (total > 2_097_152) limit();
    const bytes = Buffer.concat(chunks, length);
    if (bytesHash(bytes) !== expected.content_hash) invalidSource();
    if (file.path === document.entry_path) {
      if (expected.kind !== 'instruction' || bytes.length === 0 || bytes.length > 65_536)
        invalidSource();
      const text = bytes.toString('utf8');
      if (
        !Buffer.from(text, 'utf8').equals(bytes) ||
        text.trim().length === 0 ||
        text.startsWith('\ufeff') ||
        hasControlCharacters(text, true)
      )
        invalidSource();
      entryText = text;
    }
  }
  if (entryText === undefined) invalidSource();
  return entryText;
}

function signingPayload(candidate: InstructionSkillSourceCandidateV1) {
  const { signature, ...document } = candidate.document;
  return {
    schema_version: 'instruction-skill-signing-payload/1' as const,
    canonicalizer_version: 'rfc8785/1' as const,
    workspace_id: candidate.workspace_id,
    published_resource_kind: 'INSTRUCTION_SKILL_RELEASE' as const,
    document,
    signer: { algorithm: signature.algorithm, key_id: signature.key_id },
  };
}

function verifySigner(
  candidate: InstructionSkillSourceCandidateV1,
  trustInput: unknown,
  payload: ReturnType<typeof signingPayload>,
) {
  const trust = parseSourceLosslessly(
    snapshotSource(trustInput),
    InstructionSkillTrustedSignersV1Schema,
  );
  const source = candidate.document;
  const signer = trust.signers.find((item) => item.key_id === source.signature.key_id);
  if (
    trust.workspace_id !== candidate.workspace_id ||
    signer === undefined ||
    signer.publisher_id !== source.origin.publisher_id ||
    signer.source_id !== source.origin.source_id ||
    !signer.allowed_resource_ids.includes(source.resource_id)
  )
    invalidSignature();
  const der = decodeCanonicalBase64(signer.public_key_spki_base64, invalidSignature);
  const signature = decodeCanonicalBase64(source.signature.signature_base64, invalidSignature);
  if (der.length !== 44 || signature.length !== 64) invalidSignature();
  try {
    // Reject alternate key formats/trailing DER, private keys and algorithm confusion before verification.
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (
      key.type !== 'public' ||
      key.asymmetricKeyType !== 'ed25519' ||
      !key.export({ type: 'spki', format: 'der' }).equals(der)
    )
      invalidSignature();
    // DER validity alone does not establish a usable signer: reject identity, torsion
    // components and noncanonical points before strict (non-ZIP215) verification.
    const publicKey = der.subarray(12);
    const point = ed25519.Point.fromBytes(publicKey, false);
    if (
      point.equals(ed25519.Point.ZERO) ||
      !point.isTorsionFree() ||
      !ed25519.verify(signature, canonicalJsonBytes(payload), publicKey, { zip215: false })
    )
      invalidSignature();
  } catch {
    invalidSignature();
  }
  return {
    schema_version: 'instruction-skill-signature-evidence/1' as const,
    key_id: signer.key_id,
    publisher_id: signer.publisher_id,
    source_id: signer.source_id,
    public_key_hash: bytesHash(der),
    signed_payload_hash: canonicalSha256(payload),
  };
}

export interface PreparedInstructionSkillSourceV1 {
  readonly schema_version: 'prepared-instruction-skill-source/1';
  readonly document: InstructionSkillSourceV1;
  readonly files: readonly InstructionSkillFileV1[];
  readonly signing_payload: ReturnType<typeof signingPayload>;
  readonly signature_evidence: ReturnType<typeof verifySigner>;
  readonly preimage: {
    readonly schema_version: 'instruction-skill-source-preimage/1';
    readonly compiler_version: 'capability-compiler/1';
    readonly canonicalizer_version: 'rfc8785/1';
    readonly workspace_id: string;
    readonly published_resource_kind: 'INSTRUCTION_SKILL_RELEASE';
    readonly document: InstructionSkillSourceV1;
  };
  readonly full_pin: PublishedResourcePinV1 & {
    readonly published_resource_kind: 'INSTRUCTION_SKILL_RELEASE';
  };
  readonly content_hash: `sha256:${string}`;
  readonly inert_content: {
    readonly entry_path: 'SKILL.md';
    readonly entry_text: string;
    readonly entry_content_hash: `sha256:${string}`;
    readonly allowed_capability_binding_ids: readonly string[];
    readonly context_budget_tokens: number;
    readonly data_classification: InstructionSkillSourceV1['data_classification'];
    readonly script_mode: 'inert';
  };
  readonly dependency_manifest: ReturnType<typeof deriveDependencyManifest>;
}

/** Verify a signed inert JSON bundle against independently supplied publisher trust; no extraction, execution or registry admission. */
export function prepareInstructionSkillSource(
  input: unknown,
  trustedSigners: unknown,
): PreparedInstructionSkillSourceV1 {
  const candidate = parseSourceLosslessly(
    snapshotSource(input),
    InstructionSkillSourceCandidateV1Schema,
  );
  const document = candidate.document;
  if (document.scripts.requires_execution)
    throw new ReleaseCoreError(
      'SKILL_SCRIPT_EXECUTION_UNSUPPORTED',
      '$.scripts',
      'G1 Instruction Skill scripts are inert assets only',
    );
  const entryText = readFiles(candidate);
  document.manifest.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  candidate.files.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  document.allowed_capability_binding_ids.sort(compareCanonicalStrings);
  const payload = signingPayload(candidate);
  const signature_evidence = verifySigner(candidate, trustedSigners, payload);
  const preimage = {
    schema_version: 'instruction-skill-source-preimage/1' as const,
    compiler_version: 'capability-compiler/1' as const,
    canonicalizer_version: 'rfc8785/1' as const,
    workspace_id: candidate.workspace_id,
    published_resource_kind: 'INSTRUCTION_SKILL_RELEASE' as const,
    document,
  };
  const owner = {
    workspace_id: candidate.workspace_id,
    published_resource_kind: 'INSTRUCTION_SKILL_RELEASE' as const,
    resource_id: document.resource_id,
    resource_version_id: document.resource_version_id,
  };
  const result: PreparedInstructionSkillSourceV1 = {
    schema_version: 'prepared-instruction-skill-source/1',
    document,
    files: candidate.files,
    signing_payload: payload,
    signature_evidence,
    preimage,
    full_pin: { ...owner, contract_hash: canonicalSha256(preimage), binding_mode: 'pinned' },
    content_hash: canonicalSha256({
      schema_version: 'instruction-skill-content/1',
      parser_version: document.parser_version,
      entry_path: document.entry_path,
      manifest: document.manifest,
    }),
    inert_content: {
      entry_path: document.entry_path,
      entry_text: entryText,
      entry_content_hash: bytesHash(Buffer.from(entryText, 'utf8')),
      allowed_capability_binding_ids: document.allowed_capability_binding_ids,
      context_budget_tokens: document.context_budget_tokens,
      data_classification: document.data_classification,
      script_mode: 'inert',
    },
    dependency_manifest: deriveDependencyManifest(owner, []),
  };
  snapshotSource(result);
  return deepFreezeJson(result);
}

export function verifyInstructionSkillSource(
  expected: unknown,
  input: unknown,
  trustedSigners: unknown,
): PreparedInstructionSkillSourceV1 {
  const snapshot = snapshotSource(expected);
  const actual = prepareInstructionSkillSource(input, trustedSigners);
  if (!sourceEqual(snapshot, actual)) mismatchedSource();
  return actual;
}

/** Bind content to an existing Agent assembly; canonical closure paths and budget-aware runtime activation are later compiler/host steps. */
export function verifyInstructionSkillAssembly(
  agentInput: unknown,
  bindingIdInput: unknown,
  input: unknown,
  trustedSigners: unknown,
): PreparedInstructionSkillSourceV1 {
  const agent = prepareExecutableSource(agentInput);
  const skill = prepareInstructionSkillSource(input, trustedSigners);
  const bindingId = snapshotSource(bindingIdInput);
  if (
    typeof bindingId !== 'string' ||
    bindingId.length === 0 ||
    Buffer.byteLength(bindingId, 'utf8') > 4_096
  )
    invalidSource();
  if (
    agent.root.pin.published_resource_kind !== 'AGENT_RELEASE' ||
    agent.root.pin.workspace_id !== skill.full_pin.workspace_id
  )
    mismatchedSource();
  const skills = agent.preimage.document.instruction_skill_bindings;
  const capabilities = agent.preimage.document.capability_bindings;
  if (!Array.isArray(skills) || !Array.isArray(capabilities)) mismatchedSource();
  const binding = skills
    .map((value) => parseSourceLosslessly(value, InstructionSkillBindingV1Schema))
    .find((item) => item.binding_id === bindingId);
  const available = new Set(
    capabilities.map((value) => parseSourceLosslessly(value, CapabilityBindingV1Schema).binding_id),
  );
  const allowed = new Set(skill.document.allowed_capability_binding_ids);
  if (
    binding === undefined ||
    !sourceEqual(binding.skill_pin, skill.full_pin) ||
    binding.content_hash !== skill.content_hash ||
    binding.context_budget_tokens > skill.document.context_budget_tokens ||
    !binding.allowed_capability_binding_ids.every((id) => allowed.has(id)) ||
    !skill.document.allowed_capability_binding_ids.every((id) => available.has(id))
  )
    mismatchedSource();
  return skill;
}
