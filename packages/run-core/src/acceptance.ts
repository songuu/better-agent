import { type RunAcceptanceV1, RunAcceptanceV1Schema } from '@better-agent/domain-contracts';
import {
  type ExpectedAdmissionSnapshotIdentityV1,
  verifyAdmissionSnapshot,
} from '@better-agent/release-core';

import { failRunCore } from './errors.js';

export interface PrepareRunAcceptanceFactsInputV1 {
  readonly acceptance: unknown;
  readonly admission_snapshot: unknown;
  readonly expected_admission: ExpectedAdmissionSnapshotIdentityV1;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function principalMatches(
  acceptance: RunAcceptanceV1,
  snapshot: ReturnType<typeof verifyAdmissionSnapshot>,
): boolean {
  const accepted = acceptance.accepted_principal;
  const authenticated = snapshot.authenticated_principal;
  if (accepted.kind !== authenticated.kind) return false;
  return accepted.kind === 'credential' && authenticated.kind === 'credential'
    ? accepted.credential_id === authenticated.credential_id
    : accepted.kind === 'end_user' && authenticated.kind === 'end_user'
      ? accepted.end_user_principal_id === authenticated.end_user_principal_id
      : false;
}

function assertTargetMatchesSnapshot(
  acceptance: RunAcceptanceV1,
  snapshot: ReturnType<typeof verifyAdmissionSnapshot>,
): void {
  if (acceptance.target.target_kind !== snapshot.deployment_kind) {
    failRunCore(
      'RUN_ACCEPTANCE_INVALID',
      '$.acceptance.target.target_kind',
      'Run target kind differs from the verified admission snapshot',
    );
  }
  if (acceptance.target.target_kind === 'agent' && snapshot.deployment_kind === 'agent') {
    const target = acceptance.target;
    if (
      target.agent_deployment_id !== snapshot.agent_deployment_id ||
      target.agent_deployment_revision_id !== snapshot.agent_deployment_revision_id ||
      target.agent_id !== snapshot.agent_release.resource_id ||
      target.agent_release_id !== snapshot.agent_release.resource_version_id ||
      target.experience_release_id !== snapshot.experience_release.resource_version_id
    ) {
      failRunCore(
        'RUN_ACCEPTANCE_INVALID',
        '$.acceptance.target',
        'Agent target pins differ from the verified admission snapshot',
      );
    }
    return;
  }
  if (acceptance.target.target_kind === 'flow' && snapshot.deployment_kind === 'flow') {
    const target = acceptance.target;
    if (
      target.flow_deployment_id !== snapshot.flow_deployment_id ||
      target.flow_deployment_revision_id !== snapshot.flow_deployment_revision_id ||
      target.flow_id !== snapshot.flow_version.resource_id ||
      target.flow_version_id !== snapshot.flow_version.resource_version_id
    ) {
      failRunCore(
        'RUN_ACCEPTANCE_INVALID',
        '$.acceptance.target',
        'Flow target pins differ from the verified admission snapshot',
      );
    }
  }
}

export function prepareRunAcceptanceFacts(input: PrepareRunAcceptanceFactsInputV1) {
  const parsed = RunAcceptanceV1Schema.safeParse(input.acceptance);
  if (!parsed.success) {
    failRunCore(
      'RUN_ACCEPTANCE_INVALID',
      '$.acceptance',
      'acceptance does not satisfy the closed Run contract',
      { cause: parsed.error },
    );
  }
  const acceptance = parsed.data;
  let snapshot: ReturnType<typeof verifyAdmissionSnapshot>;
  try {
    snapshot = verifyAdmissionSnapshot({
      snapshot: input.admission_snapshot,
      expected: input.expected_admission,
    });
  } catch (error) {
    failRunCore(
      'RUN_ADMISSION_SNAPSHOT_INVALID',
      '$.admission_snapshot',
      'admission snapshot verification failed',
      { cause: error },
    );
  }
  if (
    acceptance.workspace_id !== snapshot.workspace_id ||
    acceptance.admission_snapshot_hash !== snapshot.snapshot_hash
  ) {
    failRunCore(
      'RUN_ACCEPTANCE_INVALID',
      '$.acceptance.admission_snapshot_hash',
      'Run acceptance does not bind the verified Workspace snapshot',
    );
  }
  if (!principalMatches(acceptance, snapshot)) {
    failRunCore(
      'RUN_ACCEPTANCE_INVALID',
      '$.acceptance.accepted_principal',
      'accepted principal differs from the authenticated snapshot principal',
    );
  }
  if (acceptance.dependency_pins_hash !== snapshot.dependency_manifest_hash) {
    failRunCore(
      'RUN_ACCEPTANCE_INVALID',
      '$.acceptance.dependency_pins_hash',
      'accepted dependency pins differ from the verified snapshot manifest',
    );
  }
  assertTargetMatchesSnapshot(acceptance, snapshot);
  return deepFreeze({ acceptance: deepFreeze(acceptance), admission_snapshot: snapshot });
}
