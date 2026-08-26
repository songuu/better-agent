import {
  AgentDeploymentEntryAdmissionSnapshotV1Schema,
  FlowDeploymentEntryAdmissionSnapshotV1Schema,
} from '@better-agent/domain-contracts';

import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256ExcludingRootKeys } from './hash.js';

export interface ExpectedAdmissionSnapshotIdentityV1 {
  readonly deployment_kind: 'agent' | 'flow';
  readonly workspace_id: string;
  readonly deployment_id: string;
  readonly deployment_revision_id: string;
  readonly deployment_revision_contract_hash: string;
  readonly admission_activation_epoch: number;
  readonly observed_revoke_epoch: number;
}

export interface VerifyAdmissionSnapshotInputV1 {
  readonly snapshot: unknown;
  readonly expected: ExpectedAdmissionSnapshotIdentityV1;
}

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_ADMISSION_SNAPSHOT_INVALID', path, reason);
}

export function verifyAdmissionSnapshot(input: VerifyAdmissionSnapshotInputV1) {
  if (
    typeof input.snapshot !== 'object' ||
    input.snapshot === null ||
    Array.isArray(input.snapshot)
  ) {
    fail('$.snapshot', 'admission snapshot must be an object');
  }
  const deploymentKind = Reflect.get(input.snapshot, 'deployment_kind');
  const result =
    deploymentKind === 'agent'
      ? AgentDeploymentEntryAdmissionSnapshotV1Schema.safeParse(input.snapshot)
      : deploymentKind === 'flow'
        ? FlowDeploymentEntryAdmissionSnapshotV1Schema.safeParse(input.snapshot)
        : undefined;
  if (result === undefined || !result.success) {
    fail('$.snapshot', 'snapshot does not match a closed Agent or Flow admission contract');
  }
  const snapshot = result.data;
  const expectedHash = canonicalSha256ExcludingRootKeys(snapshot, ['snapshot_hash']);
  if (snapshot.snapshot_hash !== expectedHash) {
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.snapshot.snapshot_hash',
      'admission snapshot hash does not match its canonical facts',
    );
  }
  if (snapshot.deployment_kind !== input.expected.deployment_kind) {
    fail('$.snapshot.deployment_kind', 'snapshot Deployment kind differs from the expected fact');
  }
  if (snapshot.workspace_id !== input.expected.workspace_id) {
    fail('$.snapshot.workspace_id', 'snapshot Workspace differs from the expected fact');
  }
  const deploymentId =
    snapshot.deployment_kind === 'agent'
      ? snapshot.agent_deployment_id
      : snapshot.flow_deployment_id;
  const revisionId =
    snapshot.deployment_kind === 'agent'
      ? snapshot.agent_deployment_revision_id
      : snapshot.flow_deployment_revision_id;
  const revisionHash =
    snapshot.deployment_kind === 'agent'
      ? snapshot.agent_deployment_revision_contract_hash
      : snapshot.flow_deployment_revision_contract_hash;
  if (deploymentId !== input.expected.deployment_id) {
    fail('$.snapshot.deployment_id', 'snapshot stable Deployment differs from the expected fact');
  }
  if (revisionId !== input.expected.deployment_revision_id) {
    fail('$.snapshot.deployment_revision_id', 'snapshot revision differs from the expected fact');
  }
  if (revisionHash !== input.expected.deployment_revision_contract_hash) {
    fail(
      '$.snapshot.deployment_revision_contract_hash',
      'snapshot revision hash differs from the expected fact',
    );
  }
  if (snapshot.admission_activation_epoch !== input.expected.admission_activation_epoch) {
    fail(
      '$.snapshot.admission_activation_epoch',
      'activation epoch differs from the locked pointer fact',
    );
  }
  if (snapshot.observed_revoke_epoch !== input.expected.observed_revoke_epoch) {
    fail('$.snapshot.observed_revoke_epoch', 'revoke epoch differs from the locked security fact');
  }
  return deepFreezeJson(snapshot);
}
