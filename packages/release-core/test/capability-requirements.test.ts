import { describe, expect, it, vi } from 'vitest';
import {
  normalizeCapabilityRequirements as normalize,
  resolveEffectiveCapabilityPolicy,
} from '../src/index.js';
import { ceiling, requirements, hashA, hashB } from './policy-fixtures.js';

describe('intrinsic requirement normalization', () => {
  it('canonicalizes all explicit sets without dropping demands or mutating inputs', () => {
    const input = {
      ...requirements(),
      operation_contract_hashes: [hashB, hashA],
      credential_requirements: [
        {
          ...requirements().credential_requirements[0],
          requirement_id: 'second',
          required_scopes: ['write', 'read'],
          allowed_principal_modes: ['service_principal', 'caller_delegated'],
        },
        { ...requirements().credential_requirements[0], requirement_id: 'first' },
      ],
      principal_modes: ['service_principal', 'caller_delegated'],
    };
    const before = structuredClone(input);
    const result = normalize(input);
    expect(input).toEqual(before);
    expect(result.operation_contract_hashes).toEqual([hashA, hashB]);
    expect(
      result.credential_requirements.find((item) => item.requirement_id === 'second')
        ?.required_scopes,
    ).toEqual(['read', 'write']);
    expect(
      result.credential_requirements.find((item) => item.requirement_id === 'second')
        ?.allowed_principal_modes,
    ).toEqual(['caller_delegated', 'service_principal']);
    input.credential_requirements.reverse();
    input.operation_contract_hashes.reverse();
    input.principal_modes.reverse();
    expect(normalize(input)).toEqual(result);
    expect(normalize(result)).toEqual(result);
    expect(Object.isFrozen(result.credential_requirements[0]?.required_scopes)).toBe(true);
  });

  it('reuses canonical egress semantics and remains consumable by policy resolution', () => {
    const input = requirements();
    const first = input.egress[0];
    if (first === undefined) throw new Error('fixture requires an egress rule');
    input.egress.push(structuredClone(first));
    expect(normalize(input).egress).toEqual(requirements().egress);
    expect(resolveEffectiveCapabilityPolicy(ceiling(), normalize(input))).toEqual(
      resolveEffectiveCapabilityPolicy(ceiling(), requirements()),
    );
    expect(() => normalize({ ...input, operation_contract_hashes: [hashA, hashA] })).toThrow(
      'CLOSURE_POLICY_INPUT_INVALID',
    );
  });

  it('rejects hostile data without traps and bounds its own output', () => {
    const trap = vi.fn();
    const input = requirements();
    Object.defineProperty(input, 'egress', { enumerable: true, get: trap });
    expect(() => normalize(input)).toThrow('CLOSURE_POLICY_INPUT_INVALID');
    expect(() => normalize(new Proxy(requirements(), { get: trap, ownKeys: trap }))).toThrow(
      'CLOSURE_POLICY_INPUT_INVALID',
    );
    expect(trap).not.toHaveBeenCalled();
    expect(() =>
      normalize({
        ...requirements(),
        credential_requirements: Array(33).fill(requirements().credential_requirements[0]),
      }),
    ).toThrow('CLOSURE_POLICY_INPUT_INVALID');
  });
});
