import { describe, expect, it } from 'vitest';

import {
  CallerPrincipalV1Schema,
  CredentialKindV1Schema,
  CredentialOperationPolicyV1Schema,
  domainContractSchemaVersions,
  InboundCredentialScopeV1Schema,
  parseDomainContract,
  TenantAuthContextV1Schema,
  UuidV1Schema,
  VerifiedSubjectAssertionV1Schema,
} from '../src/index.js';

const verifiedAssertion = {
  schema_version: 'verified-subject-assertion/1',
  signature_profile: 'jws-eddsa/1',
  issuer_config_id: '10000000-0000-4000-8000-000000000001',
  issuer: 'https://issuer.example',
  audience: 'better-agent-browser-session',
  subject_hash: 'a'.repeat(43),
  nonce_hash: 'b'.repeat(43),
  issued_at: '2027-01-15T08:00:00.000Z',
  expires_at: '2027-01-15T08:05:00.000Z',
  canonical_origin: 'https://app.example',
  key_version: 7,
} as const;

const exchangePolicy = {
  schema_version: 'credential-operation-policy/1',
  operation_purpose: 'deployment_publish',
  allowed_kinds: ['publish'],
  required_scopes: ['browser-session:exchange'],
  typed_grant_family: 'agent_deployment_entry_grants',
  target_cardinality: 'exactly_one_deployment',
} as const;

describe('G0-04 authentication contracts', () => {
  it('accepts only canonical lowercase UUID text used by PostgreSQL readback', () => {
    expect(UuidV1Schema.parse('10000000-0000-4000-8000-00000000000a')).toBe(
      '10000000-0000-4000-8000-00000000000a',
    );
    expect(UuidV1Schema.parse('10000000-0000-0000-0000-00000000000a')).toBe(
      '10000000-0000-0000-0000-00000000000a',
    );
    expect(UuidV1Schema.safeParse('10000000-0000-4000-8000-00000000000A').success).toBe(false);
    expect(UuidV1Schema.safeParse('10000000-0000-0000-0000-00000000000A').success).toBe(false);
    expect(UuidV1Schema.safeParse('100000000000-0000-0000-00000000000a').success).toBe(false);
  });

  it('closes credential kinds and inbound operation scopes', () => {
    expect(CredentialKindV1Schema.parse('service_api')).toBe('service_api');
    expect(CredentialKindV1Schema.parse('permission_callback')).toBe('permission_callback');
    expect(() => CredentialKindV1Schema.parse('deployment_publish')).toThrow();

    expect(InboundCredentialScopeV1Schema.parse('run:events:read')).toBe('run:events:read');
    expect(() => InboundCredentialScopeV1Schema.parse('browser-session:*')).toThrow();
  });

  it('accepts only the redacted verified assertion DTO', () => {
    expect(VerifiedSubjectAssertionV1Schema.parse(verifiedAssertion)).toEqual(verifiedAssertion);
    expect(parseDomainContract(verifiedAssertion)).toEqual(verifiedAssertion);

    expect(
      VerifiedSubjectAssertionV1Schema.safeParse({
        ...verifiedAssertion,
        raw_assertion: 'must-never-be-persisted',
      }).success,
    ).toBe(false);
    expect(
      VerifiedSubjectAssertionV1Schema.safeParse({
        ...verifiedAssertion,
        sub: 'host-user-42',
      }).success,
    ).toBe(false);
    expect(
      VerifiedSubjectAssertionV1Schema.safeParse({
        ...verifiedAssertion,
        nonce: 'raw-replay-value',
      }).success,
    ).toBe(false);
    expect(
      VerifiedSubjectAssertionV1Schema.safeParse({
        ...verifiedAssertion,
        expires_at: '2027-01-15T08:05:01.000Z',
      }).success,
    ).toBe(false);
  });

  it('keeps caller principals and tenant auth context as closed discriminated contracts', () => {
    const principal = {
      schema_version: 'caller-principal/1',
      kind: 'end_user',
      end_user_principal_id: '20000000-0000-4000-8000-000000000001',
    } as const;
    expect(CallerPrincipalV1Schema.parse(principal)).toEqual(principal);
    expect(
      CallerPrincipalV1Schema.safeParse({ ...principal, sdk_user_id: 'untrusted' }).success,
    ).toBe(false);

    const context = {
      schema_version: 'tenant-auth-context/1',
      workspace_id: '30000000-0000-4000-8000-000000000001',
      caller_principal: principal,
      observed_authorization_epochs: {
        credential: 3,
        workspace: 5,
      },
    } as const;
    expect(TenantAuthContextV1Schema.parse(context)).toEqual(context);
    expect(parseDomainContract(context)).toEqual(context);
    expect(
      TenantAuthContextV1Schema.safeParse({
        ...context,
        observed_authorization_epochs: { authorization_epoch: 3 },
      }).success,
    ).toBe(false);
  });

  it('permits publish only for exchange and never permits service_api to exchange', () => {
    expect(CredentialOperationPolicyV1Schema.parse(exchangePolicy)).toEqual(exchangePolicy);

    for (const required_scopes of [
      [],
      ['browser-session:exchange', 'browser-session:exchange'],
      ['unknown:scope'],
    ]) {
      expect(
        CredentialOperationPolicyV1Schema.safeParse({ ...exchangePolicy, required_scopes }).success,
      ).toBe(false);
    }

    expect(
      CredentialOperationPolicyV1Schema.safeParse({
        ...exchangePolicy,
        allowed_kinds: ['service_api'],
      }).success,
    ).toBe(false);
    expect(
      CredentialOperationPolicyV1Schema.safeParse({
        ...exchangePolicy,
        operation_purpose: 'agent_invoke',
        allowed_kinds: ['publish'],
        required_scopes: ['agent:run:create'],
      }).success,
    ).toBe(false);
  });

  it('registers the four versioned G0-04 payloads', () => {
    expect(domainContractSchemaVersions).toEqual(
      expect.arrayContaining([
        'caller-principal/1',
        'tenant-auth-context/1',
        'verified-subject-assertion/1',
        'credential-operation-policy/1',
      ]),
    );
    expect(parseDomainContract(exchangePolicy)).toEqual(exchangePolicy);
  });
});
