import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it, vi } from 'vitest';
import { prepareInstructionSkillSource as prepare } from '../src/index.js';
import { signedSource, trustedSigners } from './instruction-skill-source-fixtures.js';
import { put } from './leaf-resource-source-fixtures.js';

// This isolated boundary suite tests our guard ordering/options, not cryptography.
// instruction-skill-source.test.ts retains real library/Node-generated signature tests.
vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/ed25519.js')>();
  return { ...actual, ed25519: { ...actual.ed25519, verify: vi.fn() } };
});

describe('Instruction Skill strict crypto boundary', () => {
  it('rejects identity, torsion and noncanonical keys before even a permissive verifier can run', () => {
    const identity = Buffer.alloc(32);
    identity[0] = 1;
    const torsion = Buffer.alloc(32, 255);
    torsion[0] = 236;
    torsion[31] = 127;
    const noncanonical = Buffer.alloc(32, 255);
    noncanonical[0] = 238;
    noncanonical[31] = 127;
    const invalidSign = Buffer.from(identity);
    invalidSign[31] = 128;
    const mixedOrder = ed25519.Point.BASE.add(ed25519.Point.fromBytes(torsion)).toBytes();
    const verifier = vi.mocked(ed25519.verify);
    verifier.mockReset().mockReturnValue(true);
    for (const publicKey of [
      identity,
      Buffer.alloc(32),
      torsion,
      mixedOrder,
      noncanonical,
      invalidSign,
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
    expect(verifier).not.toHaveBeenCalled();
  });
  it('requires explicit non-ZIP215 mode and propagates verifier rejection or errors safely', () => {
    const input = signedSource();
    const verifier = vi.mocked(ed25519.verify);
    verifier.mockReset().mockReturnValue(true);
    expect(() => prepare(input, trustedSigners())).not.toThrow();
    expect(verifier).toHaveBeenCalledExactlyOnceWith(
      expect.any(Uint8Array),
      expect.any(Uint8Array),
      expect.any(Uint8Array),
      { zip215: false },
    );
    verifier.mockReturnValue(false);
    expect(() => prepare(input, trustedSigners())).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
    verifier.mockImplementation(() => {
      throw new Error('private crypto diagnostics');
    });
    expect(() => prepare(input, trustedSigners())).toThrow('INSTRUCTION_SKILL_SIGNATURE_INVALID');
    expect(() => prepare(input, trustedSigners())).not.toThrow('private crypto diagnostics');
  });
});
