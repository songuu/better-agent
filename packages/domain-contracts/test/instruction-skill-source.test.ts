import { describe, expect, it } from 'vitest';
import {
  InstructionSkillSourceV1Schema,
  InstructionSkillSourceCandidateV1Schema,
  InstructionSkillTrustedSignersV1Schema,
  InstructionSkillFileV1Schema,
  domainContractSchemaRegistry,
} from '../src/index.js';

const id = '10000000-0000-4000-8000-000000000001';
const hash = `sha256:${'a'.repeat(64)}`;
function source() {
  return {
    schema_version: 'instruction-skill-source/1',
    resource_id: id,
    resource_version_id: id,
    name: 'Procedure',
    description: 'Use pinned capabilities only.',
    parser_version: 'instruction-skill-bundle-parser/1',
    entry_path: 'SKILL.md',
    origin: { publisher_id: 'publisher', source_id: 'source', revision: 'v1' },
    manifest: [{ path: 'SKILL.md', kind: 'instruction', size_bytes: 1, content_hash: hash }],
    allowed_capability_binding_ids: ['lookup'],
    context_budget_tokens: 2048,
    data_classification: 'internal',
    scripts: { mode: 'inert', requires_execution: false },
    signature: {
      algorithm: 'ed25519',
      key_id: 'publisher-key',
      signature_base64: `${'A'.repeat(86)}==`,
    },
  };
}
function trust() {
  return {
    schema_version: 'instruction-skill-trusted-signers/1',
    workspace_id: id,
    signers: [
      {
        key_id: 'publisher-key',
        publisher_id: 'publisher',
        source_id: 'source',
        allowed_resource_ids: [id],
        public_key_spki_base64: 'structural-only',
      },
    ],
  };
}

describe('Instruction Skill structural contracts (not content/signature proof)', () => {
  it.each([
    'instruction-skill-source/1',
    'instruction-skill-source-candidate/1',
    'instruction-skill-trusted-signers/1',
  ])('registers closed %s', (schema_version) => {
    expect(
      domainContractSchemaRegistry
        .schemaFor(schema_version)
        .safeParse({ schema_version, secret: 'forbidden' }).success,
    ).toBe(false);
  });
  it('accepts structural source/bundle/trust without claiming cryptographic verification', () => {
    expect(InstructionSkillSourceV1Schema.safeParse(source()).success).toBe(true);
    expect(
      InstructionSkillSourceCandidateV1Schema.safeParse({
        schema_version: 'instruction-skill-source-candidate/1',
        workspace_id: id,
        document: source(),
        files: [{ path: 'SKILL.md', chunks_base64: ['YQ=='] }],
      }).success,
    ).toBe(true);
    expect(InstructionSkillTrustedSignersV1Schema.safeParse(trust()).success).toBe(true);
  });
  it('requires pinned parser/origin and closed inert script and signature declarations', () => {
    for (const patch of [
      { parser_version: 'latest' },
      { entry_path: 'index.js' },
      { origin: { ...source().origin, revision: 'LATEST' } },
      { origin: { ...source().origin, revision: 'floating_latest' } },
      { origin: { ...source().origin, url: 'https://example.test' } },
      { scripts: { mode: 'execute', requires_execution: true } },
      { scripts: { ...source().scripts, executable: false } },
      { signature: { ...source().signature, algorithm: 'rsa' } },
      { signature: { ...source().signature, public_key: 'self-trusted' } },
      { signature: { ...source().signature, signature_base64: 'A'.repeat(87) } },
      { compiled_hash: hash },
      { closure_hash: hash },
      { runtime_tools: [] },
    ])
      expect(InstructionSkillSourceV1Schema.safeParse({ ...source(), ...patch }).success).toBe(
        false,
      );
    expect(
      InstructionSkillSourceV1Schema.safeParse({
        ...source(),
        scripts: { mode: 'inert', requires_execution: true },
      }).success,
    ).toBe(true);
  });
  it('bounds unique manifest and capability reference sets', () => {
    const input = source();
    const entry = input.manifest[0];
    if (!entry) throw new Error('fixture missing');
    for (const patch of [
      { manifest: [] },
      { manifest: [entry, entry] },
      { manifest: Array.from({ length: 65 }, (_, i) => ({ ...entry, path: `assets/${i}` })) },
      { manifest: [{ ...entry, size_bytes: 1_048_577 }] },
      { manifest: [{ ...entry, size_bytes: -1 }] },
      { manifest: [{ ...entry, size_bytes: 0.5 }] },
      { manifest: [{ ...entry, content_hash: `${hash}a` }] },
      { allowed_capability_binding_ids: ['x', 'x'] },
      { allowed_capability_binding_ids: Array.from({ length: 129 }, (_, i) => `${i}`) },
    ])
      expect(InstructionSkillSourceV1Schema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(
      InstructionSkillSourceV1Schema.safeParse({
        ...input,
        manifest: Array.from({ length: 64 }, (_, i) => ({
          ...entry,
          path: `assets/${i}`,
          size_bytes: 1_048_576,
        })),
        allowed_capability_binding_ids: Array.from({ length: 128 }, (_, i) => `${i}`),
      }).success,
    ).toBe(true);
  });
  it('bounds token budgets, classification and canonical IDs', () => {
    for (const patch of [
      { context_budget_tokens: 0 },
      { context_budget_tokens: 1_000_001 },
      { context_budget_tokens: 0.5 },
      { data_classification: 'unknown' },
      { name: '' },
      { resource_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    ])
      expect(InstructionSkillSourceV1Schema.safeParse({ ...source(), ...patch }).success).toBe(
        false,
      );
    expect(
      InstructionSkillSourceV1Schema.safeParse({
        ...source(),
        context_budget_tokens: 1_000_000,
        allowed_capability_binding_ids: [],
      }).success,
    ).toBe(true);
  });
  it('bounds chunk shapes and requires unique candidate paths', () => {
    const file = { path: 'assets/empty', chunks_base64: [] as string[] };
    expect(InstructionSkillFileV1Schema.safeParse(file).success).toBe(true);
    expect(
      InstructionSkillFileV1Schema.safeParse({
        ...file,
        chunks_base64: Array(22).fill('A'.repeat(65_536)),
      }).success,
    ).toBe(true);
    for (const chunks_base64 of [[''], ['A'.repeat(65_537)], Array(23).fill('YQ==')])
      expect(InstructionSkillFileV1Schema.safeParse({ ...file, chunks_base64 }).success).toBe(
        false,
      );
    const candidate = {
      schema_version: 'instruction-skill-source-candidate/1',
      workspace_id: id,
      document: source(),
      files: [file],
    };
    for (const patch of [
      { files: [] },
      { files: [file, file] },
      { trust: trust() },
      { workspace_id: 'invalid' },
    ])
      expect(
        InstructionSkillSourceCandidateV1Schema.safeParse({ ...candidate, ...patch }).success,
      ).toBe(false);
  });
  it('requires separately scoped, bounded and unique signer entries', () => {
    const input = trust();
    const signer = input.signers[0];
    if (!signer) throw new Error('fixture missing');
    for (const signers of [
      [signer, signer],
      [{ ...signer, allowed_resource_ids: [] }],
      [{ ...signer, allowed_resource_ids: [id, id] }],
      [{ ...signer, private_key: 'forbidden' }],
      [{ ...signer, public_key_spki_base64: '' }],
      Array.from({ length: 129 }, (_, i) => ({ ...signer, key_id: `${i}` })),
    ])
      expect(InstructionSkillTrustedSignersV1Schema.safeParse({ ...input, signers }).success).toBe(
        false,
      );
    expect(
      InstructionSkillTrustedSignersV1Schema.safeParse({ ...input, signers: [] }).success,
    ).toBe(true);
    expect(
      InstructionSkillTrustedSignersV1Schema.safeParse({
        ...input,
        signers: Array.from({ length: 128 }, (_, i) => ({ ...signer, key_id: `${i}` })),
      }).success,
    ).toBe(true);
  });
});
