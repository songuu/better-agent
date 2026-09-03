import {
  AgentDeploymentCredentialMappingV1Schema,
  CredentialRequirementV1Schema,
} from '@better-agent/domain-contracts';
import { describe, expect, it } from 'vitest';
import {
  credentialMaterialIdentityHash,
  verifyAdmissionCredential,
} from '../src/admission-credential.js';
import { calculateCredentialMappingHash } from '../src/credential-mapping.js';
import { canonicalSha256 } from '../src/hash.js';
import {
  hashA,
  hashB,
  makeCredentialRequirement,
  makePolicyPin,
  principalId,
  workspaceId,
} from './fixtures.js';

type Mode = 'caller_delegated' | 'service_principal' | 'team_shared';
function fixture(mode: Mode) {
  const requirement = CredentialRequirementV1Schema.parse({
    ...makeCredentialRequirement(),
    allowed_principal_modes: [mode],
  });
  const policy = makePolicyPin(
    mode === 'caller_delegated'
      ? 'oauth_delegation'
      : mode === 'team_shared'
        ? 'team_credential'
        : 'service_principal',
  );
  const candidate = {
    schema_version: 'agent-deployment-credential-mapping/1',
    requirement_id: requirement.requirement_id,
    provider_id: requirement.provider_id,
    audience: requirement.audience,
    allowed_scopes: requirement.required_scopes,
    principal_mode: mode,
    credential_policy: policy,
    ...(mode === 'caller_delegated'
      ? {
          credential_source_kind: 'oauth_delegation_policy',
          principal_source: 'authenticated_end_user',
        }
      : mode === 'team_shared'
        ? {
            credential_source_kind: 'team_credential_policy',
            team_credential_policy_id: policy.policy_id,
          }
        : {
            credential_source_kind: 'service_principal_policy',
            service_principal_id: principalId,
          }),
    mapping_hash: hashA,
  };
  const mapping = AgentDeploymentCredentialMappingV1Schema.parse({
    ...candidate,
    mapping_hash: calculateCredentialMappingHash(candidate),
  });
  const material = {
    credential_id: 'actual-credential',
    credential_version_id: 'material-v1',
    provider_id: requirement.provider_id,
    audience: requirement.audience,
    granted_scopes: requirement.required_scopes,
    principal_mode: mode,
    credential_subject_id: mode === 'team_shared' ? policy.policy_id : principalId,
    credential_handle_hash: hashA,
    material_fingerprint_hash: hashB,
  };
  const credential = {
    ...material,
    requirement_id: requirement.requirement_id,
    mapping_hash: mapping.mapping_hash,
    epoch_source: {
      source_kind: 'credential' as const,
      source_id: material.credential_id,
      source_subkey: credentialMaterialIdentityHash(material),
      observed_epoch: 3,
    },
  };
  return {
    deployment_kind: 'agent' as const,
    workspace_id: workspaceId,
    caller:
      mode === 'service_principal'
        ? { kind: 'service' as const }
        : { kind: 'browser' as const, principal_id: principalId },
    requirement,
    mapping,
    credential,
    epoch_evidence: new Set([canonicalSha256(credential.epoch_source)]),
    path: '$.fixture',
  };
}

describe('actual admission credential evidence', () => {
  it.each(['caller_delegated', 'service_principal', 'team_shared'] as const)(
    'joins every authority axis for %s',
    (mode) => {
      const value = fixture(mode);
      expect(verifyAdmissionCredential(value)).toBe(value.mapping.mapping_hash);
      for (const change of [
        { provider_id: 'another-provider' },
        { audience: 'another-audience' },
        { granted_scopes: [] },
        { granted_scopes: ['extra', ...value.credential.granted_scopes] },
        {
          principal_mode:
            mode === 'team_shared' ? ('caller_delegated' as const) : ('team_shared' as const),
        },
        { credential_subject_id: 'another-subject' },
        { mapping_hash: hashA },
        { requirement_id: 'another-requirement' },
      ]) {
        const credential = { ...value.credential, ...change };
        credential.epoch_source = {
          ...credential.epoch_source,
          source_id: credential.credential_id,
          source_subkey: credentialMaterialIdentityHash(credential),
        };
        expect(() =>
          verifyAdmissionCredential({
            ...value,
            credential,
            epoch_evidence: new Set([canonicalSha256(credential.epoch_source)]),
          }),
        ).toThrow(/exact Deployment mapping and authenticated subject/);
      }
      for (const change of [
        { credential_id: 'another-credential' },
        { credential_version_id: 'rotated-version' },
        { credential_handle_hash: hashB },
        { material_fingerprint_hash: hashA },
      ]) {
        const credential = { ...value.credential, ...change };
        credential.epoch_source = {
          ...credential.epoch_source,
          source_id: credential.credential_id,
          source_subkey: credentialMaterialIdentityHash(credential),
        };
        expect(() => verifyAdmissionCredential({ ...value, credential })).toThrow(
          /authoritative decision vector/,
        );
      }
      expect(() =>
        verifyAdmissionCredential({
          ...value,
          epoch_evidence: new Set([
            canonicalSha256({ ...value.credential.epoch_source, observed_epoch: 4 }),
          ]),
        }),
      ).toThrow(/authoritative decision vector/);
      expect(() => verifyAdmissionCredential({ ...value, credential: undefined })).toThrow();
      expect(() => verifyAdmissionCredential({ ...value, mapping: undefined })).toThrow();
    },
  );

  it('separates interactive end-user delegation from background service principal entry', () => {
    expect(() =>
      verifyAdmissionCredential({ ...fixture('caller_delegated'), caller: { kind: 'service' } }),
    ).toThrow(/service entry cannot borrow/);
    expect(() =>
      verifyAdmissionCredential({
        ...fixture('service_principal'),
        caller: { kind: 'browser', principal_id: principalId },
      }),
    ).toThrow(/interactive entry cannot borrow/);
    const team = fixture('team_shared');
    expect(verifyAdmissionCredential({ ...team, caller: { kind: 'service' } })).toBe(
      team.mapping.mapping_hash,
    );
    expect(() =>
      verifyAdmissionCredential({
        ...fixture('caller_delegated'),
        caller: { kind: 'browser', principal_id: 'another-user' },
      }),
    ).toThrow(/authenticated subject/);
  });

  it('rejects a different team policy even when mapping and material summaries are resealed', () => {
    const value = fixture('team_shared');
    const candidate = {
      ...value.mapping,
      credential_policy: { ...value.mapping.credential_policy, policy_id: principalId },
    };
    const mapping = AgentDeploymentCredentialMappingV1Schema.parse({
      ...candidate,
      mapping_hash: calculateCredentialMappingHash(candidate),
    });
    expect(() =>
      verifyAdmissionCredential({
        ...value,
        mapping,
        credential: { ...value.credential, mapping_hash: mapping.mapping_hash },
      }),
    ).toThrow(/team credential policy identity/);
  });
});
