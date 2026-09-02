import { describe, expect, it, vi } from 'vitest';
import {
  normalizeCapabilityRequirementExpression as normalizeExpression,
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

describe('requirement expression normalization', () => {
  const leaf = (principalMode: 'caller_delegated' | 'service_principal') => ({
    schema_version: 'capability-requirement-expression/1',
    expression_kind: 'leaf',
    requirements: { ...requirements(), principal_modes: [principalMode] },
  });

  it('preserves ordered sequence topology but canonicalizes alternative and parallel branches', () => {
    const delegated = leaf('caller_delegated');
    const service = leaf('service_principal');
    const sequence = normalizeExpression({
      schema_version: 'capability-requirement-expression/1',
      expression_kind: 'sequence',
      children: [service, delegated],
    });
    if (sequence.expression_kind !== 'sequence') throw new Error('expected sequence expression');
    expect(sequence).not.toEqual(
      normalizeExpression({ ...sequence, children: [...sequence.children].reverse() }),
    );

    for (const expressionKind of ['alternative', 'parallel'] as const) {
      const forward = normalizeExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: expressionKind,
        children: [service, delegated],
      });
      const reverse = normalizeExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: expressionKind,
        children: [delegated, service],
      });
      expect(forward).toEqual(reverse);
      expect(Object.isFrozen(forward)).toBe(true);
      if (forward.expression_kind !== expressionKind) {
        throw new Error(`expected ${expressionKind} expression`);
      }
      expect(Object.isFrozen(forward.children)).toBe(true);
    }
  });

  it('rejects duplicate unordered branches instead of silently changing cardinality', () => {
    const child = leaf('service_principal');
    expect(() =>
      normalizeExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'alternative',
        children: [child, child],
      }),
    ).toThrow('CLOSURE_POLICY_INPUT_INVALID');
  });

  it('accepts the exact topology depth boundary and rejects the next level', () => {
    let expression: unknown = leaf('service_principal');
    for (let index = 0; index < 31; index += 1) {
      expression = {
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'nested_call',
        invocation: requirements(),
        child: expression,
      };
    }
    expect(normalizeExpression(expression)).toBeDefined();
    expect(() =>
      normalizeExpression({
        schema_version: 'capability-requirement-expression/1',
        expression_kind: 'nested_call',
        invocation: requirements(),
        child: expression,
      }),
    ).toThrow('CLOSURE_POLICY_INPUT_INVALID');
  });
});
