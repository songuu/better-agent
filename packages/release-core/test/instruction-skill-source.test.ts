import { generateKeyPairSync } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareInstructionSkillSource as prepare,
  verifyInstructionSkillSource as verify,
  verifyInstructionSkillAssembly,
  prepareExecutableSource,
} from '../src/index.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { hashA, hashB, workspaceId, otherWorkspaceId } from './fixtures.js';
import { put } from './leaf-resource-source-fixtures.js';
import {
  digest,
  file,
  independentCanonical,
  manifestFile,
  replaceFile,
  resign,
  signedSource,
  signingPayload,
  trustedSigners,
} from './instruction-skill-source-fixtures.js';

function assembly(input = signedSource()) {
  const prepared = prepare(input, trustedSigners());
  const document = richAgentSource();
  document.instruction_skill_bindings = [
    {
      binding_id: 'procedure',
      skill_pin: structuredClone(prepared.full_pin),
      content_hash: prepared.content_hash,
      activation: 'explicit',
      allowed_capability_binding_ids: ['plugin'],
      context_budget_tokens: 1024,
      priority: 1,
      script_mode: 'inert',
    },
  ];
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

describe('Instruction Skill signed inert content source', () => {
  it('verifies actual bytes/signature and freezes exact source, content and full resource identities', () => {
    const input = signedSource();
    const trust = trustedSigners();
    const result = prepare(input, trust);
    expect(result.signing_payload).toEqual(signingPayload(input));
    expect(result.signature_evidence.signed_payload_hash).toBe(
      digest(independentCanonical(signingPayload(input))),
    );
    expect(result.preimage).toEqual({
      schema_version: 'instruction-skill-source-preimage/1',
      compiler_version: 'capability-compiler/1',
      canonicalizer_version: 'rfc8785/1',
      workspace_id: workspaceId,
      published_resource_kind: 'INSTRUCTION_SKILL_RELEASE',
      document: result.document,
    });
    expect(result.full_pin).toEqual({
      workspace_id: input.workspace_id,
      published_resource_kind: 'INSTRUCTION_SKILL_RELEASE',
      resource_id: input.document.resource_id,
      resource_version_id: input.document.resource_version_id,
      contract_hash: digest(independentCanonical(result.preimage)),
      binding_mode: 'pinned',
    });
    expect(result.dependency_manifest.owner).toEqual({
      workspace_id: input.workspace_id,
      published_resource_kind: 'INSTRUCTION_SKILL_RELEASE',
      resource_id: input.document.resource_id,
      resource_version_id: input.document.resource_version_id,
    });
    expect(result.content_hash).toBe(
      digest(
        independentCanonical({
          schema_version: 'instruction-skill-content/1',
          parser_version: input.document.parser_version,
          entry_path: 'SKILL.md',
          manifest: result.document.manifest,
        }),
      ),
    );
    expect(result.inert_content).toEqual({
      entry_path: 'SKILL.md',
      entry_text: '# Procedure\nUse only the allowed lookup capability.\n',
      entry_content_hash: digest(
        Buffer.from('# Procedure\nUse only the allowed lookup capability.\n'),
      ),
      allowed_capability_binding_ids: ['knowledge', 'plugin'],
      context_budget_tokens: 2048,
      data_classification: 'internal',
      script_mode: 'inert',
    });
    expect(result.dependency_manifest.dependencies).toEqual([]);
    expect(result.files).toEqual(input.files);
    expect(verify(result, input, trust)).toEqual(result);
    expect(verifyInstructionSkillAssembly(assembly(input), 'procedure', input, trust)).toEqual(
      result,
    );
    expect(
      prepareExecutableSource(assembly(input)).dependency_manifest.dependencies,
    ).toContainEqual(result.full_pin);
    expect(Object.isFrozen(result.files)).toBe(true);
    expect(Object.isFrozen(result.document.manifest)).toBe(true);
  });

  it.each([
    [['name'], 'tampered'],
    [['description'], 'tampered'],
    [['resource_id'], workspaceId],
    [['resource_version_id'], workspaceId],
    [['origin', 'revision'], 'tampered'],
    [['context_budget_tokens'], 2049],
    [['data_classification'], 'restricted'],
    [['allowed_capability_binding_ids'], ['plugin']],
  ] as [string[], unknown][])('rejects unsigned metadata drift at %j', (path, value) => {
    const input = signedSource();
    put(input.document, path, value);
    expect(() => prepare(input, trustedSigners())).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
  });

  it.each(['bytes', 'size', 'hash', 'missing', 'extra', 'duplicate'])(
    'rejects %s manifest/data mismatch',
    (axis) => {
      const input = signedSource();
      if (axis === 'bytes')
        put(input, ['files', '1', 'chunks_base64'], [Buffer.from('tampered').toString('base64')]);
      if (axis === 'size') put(input.document, ['manifest', '1', 'size_bytes'], 1);
      if (axis === 'hash') put(input.document, ['manifest', '1', 'content_hash'], hashA);
      if (axis === 'missing') input.files.pop();
      if (axis === 'extra') input.files.push(file('assets/extra.txt', Buffer.from('extra')));
      if (axis === 'duplicate')
        input.files.push(structuredClone(input.files[0] as (typeof input.files)[number]));
      resign(input);
      expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    },
  );

  it.each([
    '../escape',
    '/absolute',
    'C:/absolute',
    'references/../escape',
    'references//a',
    'references/a\\b',
    'references/%2e%2e/x',
    'references/CON.txt',
    'references/a.',
    'references/a ',
    'references/a\u0001',
    'references/e\u0301.md',
  ])('rejects noncanonical/traversing path %j', (path) => {
    const input = signedSource();
    put(input, ['files', '1', 'path'], path);
    put(input.document, ['manifest', '1', 'path'], path);
    resign(input);
    expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('rejects case aliases, file/directory collisions and script relabeling', () => {
    for (const [path, kind] of [
      ['references/FACTS.md', 'reference'],
      ['references/facts.md/child.txt', 'reference'],
      ['scripts/mislabel.js', 'reference'],
    ]) {
      const input = signedSource();
      replaceFile(input, path as string, kind as string, Buffer.from('asset'));
      expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    }
  });

  it.each([
    'algorithm',
    'signature',
    'key',
    'publisher',
    'origin',
    'resource',
    'workspace',
    'self-key',
  ])('rejects invalid or out-of-scope signer %s', (axis) => {
    const input = signedSource();
    const trust = trustedSigners();
    if (axis === 'algorithm') input.document.signature.algorithm = 'rsa';
    if (axis === 'signature')
      input.document.signature.signature_base64 = Buffer.alloc(64).toString('base64');
    if (axis === 'key')
      put(
        trust,
        ['signers', '0', 'public_key_spki_base64'],
        generateKeyPairSync('ed25519')
          .publicKey.export({ type: 'spki', format: 'der' })
          .toString('base64'),
      );
    if (axis === 'publisher') put(trust, ['signers', '0', 'publisher_id'], 'other');
    if (axis === 'origin') put(trust, ['signers', '0', 'source_id'], 'other');
    if (axis === 'resource') put(trust, ['signers', '0', 'allowed_resource_ids'], [workspaceId]);
    if (axis === 'workspace') trust.workspace_id = otherWorkspaceId;
    if (axis === 'self-key') {
      trust.signers = [];
      put(
        input.document.signature,
        ['public_key_spki_base64'],
        trustedSigners().signers[0]?.public_key_spki_base64,
      );
    }
    expect(() => prepare(input, trust)).toThrow(
      axis === 'algorithm' || axis === 'self-key'
        ? 'CLOSURE_SOURCE_INVALID'
        : 'INSTRUCTION_SKILL_SIGNATURE_INVALID',
    );
  });

  it('does not execute script assets and rejects an explicit execution requirement', () => {
    const input = signedSource();
    expect(
      prepare(input, trustedSigners()).files.some((item) => item.path === 'scripts/helper.js'),
    ).toBe(true);
    input.document.scripts.requires_execution = true;
    resign(input);
    expect(() => prepare(input, trustedSigners())).toThrow('SKILL_SCRIPT_EXECUTION_UNSUPPORTED');
  });

  it('selects the exact trusted key ID and does not fall back to another entry with the same public key', () => {
    const input = signedSource();
    const trust = trustedSigners();
    const key = trust.signers[0];
    if (key === undefined) throw new Error('fixture signer missing');
    trust.signers.unshift({
      ...key,
      key_id: 'different-key',
      public_key_spki_base64: generateKeyPairSync('ed25519')
        .publicKey.export({ type: 'spki', format: 'der' })
        .toString('base64'),
    });
    expect(() => prepare(input, trust)).not.toThrow();
    input.document.signature.key_id = 'unknown-but-signed';
    resign(input);
    expect(() => prepare(input, trustedSigners())).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
  });

  it('checks the second assembled capability even when both IDs exist in the Agent', () => {
    const input = signedSource();
    const agent = assembly(input);
    put(
      agent.document.instruction_skill_bindings[0],
      ['allowed_capability_binding_ids'],
      ['plugin', 'subagent'],
    );
    expect(() => prepareExecutableSource(agent)).not.toThrow();
    expect(() =>
      verifyInstructionSkillAssembly(agent, 'procedure', input, trustedSigners()),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
    put(
      agent.document.instruction_skill_bindings[0],
      ['allowed_capability_binding_ids'],
      ['plugin'],
    );
    expect(() =>
      verifyInstructionSkillAssembly(agent, 'procedure', input, trustedSigners()),
    ).not.toThrow();
  });

  it('rejects a degenerate trusted public key whose signature can otherwise authenticate arbitrary messages', () => {
    const trust = trustedSigners();
    const publicKey = Buffer.alloc(32);
    publicKey[0] = 1;
    put(
      trust,
      ['signers', '0', 'public_key_spki_base64'],
      Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]).toString('base64'),
    );
    const forged = Buffer.alloc(64);
    forged[0] = 1;
    for (const description of ['first forged message', 'second forged message']) {
      const input = signedSource();
      input.document.description = description;
      input.document.signature.signature_base64 = forged.toString('base64');
      expect(() => prepare(input, trust)).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
    }
  });

  it('rejects low-order, mixed-order and noncanonical public keys', () => {
    const identity = Buffer.alloc(32);
    identity[0] = 1;
    const negativeIdentity = Buffer.alloc(32, 255);
    negativeIdentity[0] = 236;
    negativeIdentity[31] = 127;
    const noncanonicalIdentity = Buffer.alloc(32, 255);
    noncanonicalIdentity[0] = 238;
    noncanonicalIdentity[31] = 127;
    const invalidSign = Buffer.from(identity);
    invalidSign[31] = 128;
    const mixedOrder = ed25519.Point.BASE.add(ed25519.Point.fromBytes(negativeIdentity)).toBytes();
    for (const publicKey of [
      identity,
      Buffer.alloc(32),
      negativeIdentity,
      noncanonicalIdentity,
      invalidSign,
      mixedOrder,
    ]) {
      const trust = trustedSigners();
      put(
        trust,
        ['signers', '0', 'public_key_spki_base64'],
        Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]).toString(
          'base64',
        ),
      );
      expect(() => prepare(signedSource(), trust)).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
    }
  });

  it('accepts real signed content and rejects noncanonical signature scalars', () => {
    const input = signedSource();
    expect(() => prepare(input, trustedSigners())).not.toThrow();
    const signature = Buffer.from(input.document.signature.signature_base64, 'base64');
    signature.fill(255, 32);
    input.document.signature.signature_base64 = signature.toString('base64');
    expect(() => prepare(input, trustedSigners())).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
  });

  it.each(['invalid-utf8', 'empty', 'nul', 'bom'])(
    'rejects %s instruction entry without empty-descriptor fallback',
    (axis) => {
      const bytes = {
        'invalid-utf8': Buffer.from([0xc3, 0x28]),
        empty: Buffer.alloc(0),
        nul: Buffer.from('a\0b'),
        bom: Buffer.from('\ufeff# Entry'),
      }[axis];
      const input = signedSource();
      replaceFile(input, 'SKILL.md', 'instruction', bytes as Buffer);
      expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    },
  );

  it('canonicalizes explicit sets without mutating signed input or business text bytes', () => {
    const input = signedSource();
    const before = structuredClone(input);
    const result = prepare(input, trustedSigners());
    expect(input).toEqual(before);
    input.files.reverse();
    input.document.manifest.reverse();
    input.document.allowed_capability_binding_ids.reverse();
    expect(prepare(input, trustedSigners())).toEqual(result);
    replaceFile(
      input,
      'SKILL.md',
      'instruction',
      Buffer.from('# Procedure\r\nDifferent bytes\r\n'),
    );
    expect(prepare(input, trustedSigners()).content_hash).not.toBe(result.content_hash);
    expect(() => verify(result, input, trustedSigners())).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('rejects every artifact projection drift rather than trusting a reported pin', () => {
    const input = signedSource();
    const result = prepare(input, trustedSigners());
    for (const patch of [
      { files: [] },
      { document: {} },
      { inert_content: {} },
      { signature_evidence: {} },
      { content_hash: hashB },
      { signing_payload: {} },
      { dependency_manifest: {} },
      { full_pin: {} },
      { extra: true },
    ])
      expect(() => verify({ ...result, ...patch }, input, trustedSigners())).toThrow(
        'CLOSURE_SOURCE_MISMATCH',
      );
  });

  it.each([
    [['content_hash'], hashB],
    [['skill_pin', 'contract_hash'], hashB],
    [['skill_pin', 'resource_version_id'], workspaceId],
    [['allowed_capability_binding_ids'], ['database']],
    [['context_budget_tokens'], 2049],
  ] as [string[], unknown][])('rejects assembled Skill Binding drift at %j', (path, value) => {
    const input = signedSource();
    const agent = assembly(input);
    put(agent.document.instruction_skill_bindings[0], path, value);
    expect(() =>
      verifyInstructionSkillAssembly(agent, 'procedure', input, trustedSigners()),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('requires source references to exist in the same Agent, even if not selected by the Binding', () => {
    const input = signedSource();
    input.document.allowed_capability_binding_ids.push('missing');
    resign(input);
    const agent = assembly(input);
    expect(() => prepareExecutableSource(agent)).not.toThrow();
    expect(() =>
      verifyInstructionSkillAssembly(agent, 'procedure', input, trustedSigners()),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
    expect(() =>
      verifyInstructionSkillAssembly(assembly(), 'missing-skill', signedSource(), trustedSigners()),
    ).toThrow('CLOSURE_SOURCE_MISMATCH');
  });

  it('rejects accessors and proxies in candidate, trust and expected artifact without invoking them', () => {
    const input = signedSource();
    const trap = vi.fn();
    const proxy = new Proxy({}, { get: trap, ownKeys: trap });
    expect(() => prepare(proxy, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() => prepare(input, proxy)).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() => verify(proxy, input, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    Object.defineProperty(input.document, 'manifest', { get: trap, enumerable: true });
    expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    expect(trap).not.toHaveBeenCalled();
  });

  it('bounds real decoded file/total sizes and supports a large independently verifiable bundle', () => {
    const input = signedSource();
    const initialBytes = input.document.manifest.reduce(
      (total, item) => total + item.size_bytes,
      0,
    );
    replaceFile(input, 'assets/large.bin', 'asset', Buffer.alloc(1_048_576, 123));
    replaceFile(input, 'assets/second.bin', 'asset', Buffer.alloc(1_048_576 - initialBytes, 42));
    const result = prepare(input, trustedSigners());
    expect(verify(result, input, trustedSigners())).toEqual(result);
    replaceFile(input, 'assets/overflow.bin', 'asset', Buffer.alloc(1));
    expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
    const tooLarge = signedSource();
    replaceFile(tooLarge, 'assets/too-large.bin', 'asset', Buffer.alloc(1_048_577));
    expect(() => prepare(tooLarge, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    expect(() => prepare(signedSource(), trustedSigners())).not.toThrow();
  });

  it('bounds repeated artifact metadata independently of a legal input and supports large round trips', () => {
    const input = signedSource();
    replaceFile(input, 'assets/large.bin', 'asset', Buffer.alloc(1_048_576));
    replaceFile(input, 'assets/second.bin', 'asset', Buffer.alloc(1_040_000));
    input.document.allowed_capability_binding_ids = Array.from(
      { length: 96 },
      (_, i) => `${i.toString().padStart(4, '0')}${'界'.repeat(4092)}`,
    );
    resign(input);
    const result = prepare(input, trustedSigners());
    expect(verify(result, input, trustedSigners())).toEqual(result);
    input.document.allowed_capability_binding_ids = Array.from(
      { length: 128 },
      (_, i) => `${i.toString().padStart(4, '0')}${'界'.repeat(4092)}`,
    );
    resign(input);
    expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_LIMIT_EXCEEDED');
  });

  it('accepts the exact entry byte ceiling and rejects a larger or missing/reclassified entry', () => {
    const input = signedSource();
    replaceFile(input, 'SKILL.md', 'instruction', Buffer.alloc(65_536, 65));
    expect(prepare(input, trustedSigners()).inert_content.entry_text).toHaveLength(65_536);
    replaceFile(input, 'SKILL.md', 'instruction', Buffer.alloc(65_537, 65));
    expect(() => prepare(input, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    const missing = signedSource();
    missing.files = missing.files.filter((item) => item.path !== 'SKILL.md');
    missing.document.manifest = missing.document.manifest.filter(
      (item) => item.path !== 'SKILL.md',
    );
    resign(missing);
    expect(() => prepare(missing, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    const relabeled = signedSource();
    put(relabeled.document, ['manifest', '0', 'kind'], 'asset');
    resign(relabeled);
    expect(() => prepare(relabeled, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
  });

  it('accepts NFC Unicode references while keeping scripts as opaque binary data', () => {
    const input = signedSource();
    replaceFile(input, 'references/知识.md', 'reference', Buffer.from('说明'));
    replaceFile(input, 'scripts/opaque.bin', 'script', Buffer.from([0, 255, 1, 254]));
    const result = prepare(input, trustedSigners());
    expect(result.files.some((item) => item.path === 'scripts/opaque.bin')).toBe(true);
    expect(result.inert_content.entry_text).not.toContain('说明');
  });

  it('rejects private/wrong-algorithm/trailing public keys and noncanonical signature padding bits', () => {
    const input = signedSource();
    const pair = generateKeyPairSync('ed25519');
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    for (const bytes of [
      pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
      ec.publicKey.export({ type: 'spki', format: 'der' }),
      Buffer.concat([pair.publicKey.export({ type: 'spki', format: 'der' }), Buffer.from([0])]),
    ]) {
      const trust = trustedSigners();
      put(trust, ['signers', '0', 'public_key_spki_base64'], bytes.toString('base64'));
      expect(() => prepare(input, trust)).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const signature = input.document.signature.signature_base64;
    const finalData = signature.at(-3);
    if (finalData === undefined) throw new Error('fixture signature missing');
    input.document.signature.signature_base64 = `${signature.slice(0, -3)}${alphabet[alphabet.indexOf(finalData) + 1]}==`;
    expect(() => prepare(input, trustedSigners())).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
  });

  it('requires canonical base64, exact chunk boundaries and public-only Ed25519 SPKI keys', () => {
    const input = signedSource();
    const entry = input.files[0];
    if (entry === undefined) throw new Error('fixture missing');
    const text = entry.chunks_base64[0];
    if (text === undefined) throw new Error('fixture missing');
    const originalBytes = Buffer.from(text, 'base64');
    for (const chunks of [
      [`${text}\n`],
      [text.replace(/=+$/u, '')],
      [
        originalBytes.subarray(0, 1).toString('base64'),
        originalBytes.subarray(1).toString('base64'),
      ],
    ]) {
      const changed = structuredClone(input);
      put(changed, ['files', '0', 'chunks_base64'], chunks);
      expect(() => prepare(changed, trustedSigners())).toThrow('CLOSURE_SOURCE_INVALID');
    }
    const badTrust = trustedSigners();
    put(badTrust, ['signers', '0', 'public_key_spki_base64'], 'Zm9v');
    expect(() => prepare(input, badTrust)).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
    const extra = signedSource();
    extra.files.push(file('assets/empty.bin', Buffer.alloc(0)));
    extra.document.manifest.push(manifestFile('assets/empty.bin', 'asset', Buffer.alloc(0)));
    resign(extra);
    expect(() => prepare(extra, trustedSigners())).not.toThrow();
  });
});
