import { describe, expect, it } from 'vitest';

import { canonicalSha256ExcludingRootKeys, verifyAdmissionSnapshot } from '../src/index.js';
import {
  agentDeploymentId,
  agentDeploymentRevisionId,
  credentialId,
  hashA,
  hashC,
  makeAgentReleasePin,
  makeExperiencePin,
  workspaceId,
} from './fixtures.js';

const entryGrantId = '018f47f2-c541-7cc6-9292-4a2c35303e18';

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  const candidate = {
    schema_version: 'agent-deployment-entry-admission-snapshot/1',
    deployment_kind: 'agent',
    entry_source_kind: 'service_credential',
    workspace_id: workspaceId,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentDeploymentRevisionId,
    agent_deployment_revision_contract_hash: hashA,
    agent_release: makeAgentReleasePin(),
    experience_release: makeExperiencePin(),
    environment: 'development',
    ingress_channel: 'service_api',
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
    authenticated_principal: {
      schema_version: 'caller-principal/1',
      kind: 'credential',
      credential_id: credentialId,
    },
    credential_id: credentialId,
    credential_authorization_epoch: 5,
    workspace_authorization_epoch: 9,
    entry_grant_id: entryGrantId,
    entry_grant_authorization_epoch: 4,
    entry_credential_kind: 'service_api',
    entry_principal_mode: 'credential_service_principal',
    entry_audience: 'agent_runtime_api',
    entry_channel: 'service_api',
    entry_scope: 'agent:run:create',
    entry_target_cardinality: 'exactly_one_agent_deployment',
    policy_profile_contract_hash: hashA,
    entry_scope_policy_contract_hash: hashA,
    credential_mapping_hash: hashA,
    dependency_manifest_hash: hashA,
    snapshot_hash: hashA,
    ...overrides,
  };
  return {
    ...candidate,
    snapshot_hash: canonicalSha256ExcludingRootKeys(candidate, ['snapshot_hash']),
  };
}

function expected() {
  return {
    deployment_kind: 'agent',
    workspace_id: workspaceId,
    deployment_id: agentDeploymentId,
    deployment_revision_id: agentDeploymentRevisionId,
    deployment_revision_contract_hash: hashA,
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
  } as const;
}

describe('G0 admission snapshot verification', () => {
  it('recomputes the snapshot hash and preserves activation/revoke as separate facts', () => {
    const snapshot = verifyAdmissionSnapshot({ snapshot: makeSnapshot(), expected: expected() });

    expect(snapshot.admission_activation_epoch).toBe(3);
    expect(snapshot.observed_revoke_epoch).toBe(7);
    expect(Object.isFrozen(snapshot.authenticated_principal)).toBe(true);
  });

  it('rejects hash tampering and Agent/Flow kind substitution', () => {
    expect(() =>
      verifyAdmissionSnapshot({
        snapshot: { ...makeSnapshot(), snapshot_hash: hashC },
        expected: expected(),
      }),
    ).toThrowError(/RELEASE_HASH_MISMATCH/);
    expect(() =>
      verifyAdmissionSnapshot({
        snapshot: { ...makeSnapshot(), deployment_kind: 'flow' },
        expected: expected(),
      }),
    ).toThrowError(/RELEASE_ADMISSION_SNAPSHOT_INVALID/);
  });

  it('rejects a hash-valid activation epoch masquerading as the revoke epoch', () => {
    const swapped = makeSnapshot({ admission_activation_epoch: 7, observed_revoke_epoch: 3 });

    expect(() => verifyAdmissionSnapshot({ snapshot: swapped, expected: expected() })).toThrowError(
      /RELEASE_ADMISSION_SNAPSHOT_INVALID/,
    );
  });
});
