import { describe, expect, it } from 'vitest';

import { prepareCredentialMappings } from '../src/index.js';
import {
  hashC,
  makeCredentialRequirement,
  makeServiceMapping,
  otherWorkspaceId,
  workspaceId,
} from './fixtures.js';

function prepare(mappings: readonly unknown[], requirements = [makeCredentialRequirement()]) {
  return prepareCredentialMappings({
    deployment_kind: 'agent',
    workspace_id: workspaceId,
    requirements,
    mappings,
  });
}

describe('closed Deployment credential mapping', () => {
  it('requires one exact mapping per enabled requirement and freezes the normalized set', () => {
    const result = prepare([makeServiceMapping()]);

    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]?.allowed_scopes).toEqual(['model:invoke']);
    expect(result.credential_mapping_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(result.mappings[0])).toBe(true);
  });

  it('rejects zero, multiple and extra mappings', () => {
    expect(() => prepare([])).toThrowError(/RELEASE_CREDENTIAL_MAPPING_INVALID/);
    expect(() => prepare([makeServiceMapping(), makeServiceMapping()])).toThrowError(
      /RELEASE_CREDENTIAL_MAPPING_INVALID/,
    );
    expect(() =>
      prepare([makeServiceMapping(), makeServiceMapping('agent', { requirement_id: 'extra' })]),
    ).toThrowError(/RELEASE_CREDENTIAL_MAPPING_INVALID/);
  });

  it('rejects scope, provider, audience, principal-mode and policy drift', () => {
    for (const mapping of [
      makeServiceMapping('agent', { allowed_scopes: ['model:invoke', 'model:admin'] }),
      makeServiceMapping('agent', { provider_id: 'other-provider' }),
      makeServiceMapping('agent', { audience: 'other-audience' }),
      makeServiceMapping('agent', {
        principal_mode: 'caller_delegated',
        credential_source_kind: 'oauth_delegation_policy',
        principal_source: 'authenticated_end_user',
        credential_policy: {
          schema_version: 'deployment-policy-pin/1',
          workspace_id: workspaceId,
          policy_kind: 'oauth_delegation',
          policy_id: '018f47f2-c541-7cc6-9292-4a2c35303e16',
          policy_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e17',
          contract_hash: `sha256:${'a'.repeat(64)}`,
        },
        service_principal_id: undefined,
      }),
      makeServiceMapping('agent', {
        credential_policy: {
          schema_version: 'deployment-policy-pin/1',
          workspace_id: otherWorkspaceId,
          policy_kind: 'service_principal',
          policy_id: '018f47f2-c541-7cc6-9292-4a2c35303e16',
          policy_version_id: '018f47f2-c541-7cc6-9292-4a2c35303e17',
          contract_hash: `sha256:${'a'.repeat(64)}`,
        },
      }),
    ]) {
      expect(() => prepare([mapping])).toThrowError(/RELEASE_CREDENTIAL_MAPPING_INVALID/);
    }
  });

  it('rejects mapping hash tampering and duplicate requirement definitions', () => {
    expect(() => prepare([{ ...makeServiceMapping(), mapping_hash: hashC }])).toThrowError(
      /RELEASE_HASH_MISMATCH/,
    );
    expect(() =>
      prepare([makeServiceMapping()], [makeCredentialRequirement(), makeCredentialRequirement()]),
    ).toThrowError(/RELEASE_CREDENTIAL_MAPPING_INVALID/);
  });

  it('normalizes semantic set order without mutating caller arrays', () => {
    const firstRequirement = {
      ...makeCredentialRequirement(),
      required_scopes: ['model:read', 'model:invoke'],
    };
    const secondRequirement = {
      ...makeCredentialRequirement(),
      requirement_id: 'embedding-provider',
      provider_id: 'embedding-provider',
      audience: 'embedding-runtime',
      required_scopes: ['embedding:invoke'],
    };
    const firstMapping = makeServiceMapping('agent', {
      allowed_scopes: ['model:invoke', 'model:read'],
    });
    const secondMapping = makeServiceMapping('agent', {
      requirement_id: 'embedding-provider',
      provider_id: 'embedding-provider',
      audience: 'embedding-runtime',
      allowed_scopes: ['embedding:invoke'],
    });
    const reversedRequirements = Object.freeze([secondRequirement, firstRequirement]);
    const reversedMappings = Object.freeze([secondMapping, firstMapping]);

    const left = prepareCredentialMappings({
      deployment_kind: 'agent',
      workspace_id: workspaceId,
      requirements: reversedRequirements,
      mappings: reversedMappings,
    });
    const right = prepareCredentialMappings({
      deployment_kind: 'agent',
      workspace_id: workspaceId,
      requirements: [firstRequirement, secondRequirement],
      mappings: [firstMapping, secondMapping],
    });

    expect(left).toEqual(right);
    expect(reversedRequirements[0]?.requirement_id).toBe('embedding-provider');
    expect(reversedMappings[0]).toMatchObject({ requirement_id: 'embedding-provider' });
  });
});
