import { isCredentialPolicyPhasePassed } from '@better-agent/auth';
import type {
  AgentDeploymentEntryAdmissionSnapshotV1,
  FlowDeploymentEntryAdmissionSnapshotV1,
} from '@better-agent/domain-contracts';
import {
  canonicalSha256ExcludingRootKeys,
  verifyAdmissionSnapshot,
} from '@better-agent/release-core';
import type { AuthDatabaseTransaction } from '../auth/auth-boundary.js';
import type { AuthenticatedAccessKeyContext } from '../auth/index.js';

export type DeploymentBoundaryErrorCode =
  | 'DEPLOYMENT_BOUNDARY_INPUT_INVALID'
  | 'DEPLOYMENT_ROUTE_BINDING_INVALID'
  | 'DEPLOYMENT_ADMISSION_FAILED';

export class DeploymentBoundaryError extends Error {
  constructor(readonly code: DeploymentBoundaryErrorCode) {
    super('deployment admission boundary rejected the request');
    this.name = 'DeploymentBoundaryError';
  }
}

export interface DeploymentDatabaseTransaction extends AuthDatabaseTransaction {
  resolveAgentServiceAdmission(publicSelector: string, requiredScope: string): Promise<unknown>;
  resolveFlowServiceAdmission(publicSelector: string, requiredScope: string): Promise<unknown>;
}

export interface TransactionScopedDeploymentAdmissionInput {
  readonly publicSelector: string;
  readonly requiredScope: string;
}

const transactionScopedInputKeys = Object.freeze(['publicSelector', 'requiredScope']);

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertTransactionScopedInput(input: TransactionScopedDeploymentAdmissionInput): void {
  if (
    !hasExactKeys(input, transactionScopedInputKeys) ||
    typeof input.publicSelector !== 'string' ||
    input.publicSelector.length < 1 ||
    input.publicSelector.length > 255 ||
    typeof input.requiredScope !== 'string' ||
    input.requiredScope.length < 1
  ) {
    throw new DeploymentBoundaryError('DEPLOYMENT_BOUNDARY_INPUT_INVALID');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  return value;
}

function readEpoch(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
  return value as number;
}

function assertPolicyProof(context: AuthenticatedAccessKeyContext, kind: 'agent' | 'flow'): void {
  const proof = context.policyPhase;
  const expectedFamily =
    kind === 'agent' ? 'agent_deployment_entry_grants' : 'flow_deployment_entry_grants';
  const expectedCardinality = kind === 'agent' ? 'exactly_one_deployment' : 'exactly_one_flow';
  if (
    !isCredentialPolicyPhasePassed(proof) ||
    context.credentialKind !== 'service_api' ||
    context.tenantAuthContext.caller_principal.kind !== 'credential' ||
    proof.remainingGate.typedGrantFamily !== expectedFamily ||
    proof.remainingGate.targetCardinality !== expectedCardinality ||
    proof.requiredScopes.length !== 1
  ) {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
}

function assertCredentialFacts(
  facts: Record<string, unknown>,
  context: AuthenticatedAccessKeyContext,
  kind: 'agent' | 'flow',
): void {
  assertPolicyProof(context, kind);
  const proof = context.policyPhase;
  const expectedSnapshotCardinality =
    kind === 'agent' ? 'exactly_one_agent_deployment' : 'exactly_one_flow_deployment';
  if (
    facts.schema_version !== `${kind}-deployment-entry-admission-facts/1` ||
    facts.deployment_kind !== kind ||
    facts.entry_source_kind !== 'service_credential' ||
    facts.workspace_id !== context.tenantAuthContext.workspace_id ||
    context.tenantAuthContext.caller_principal.kind !== 'credential' ||
    facts.credential_id !== context.tenantAuthContext.caller_principal.credential_id ||
    facts.credential_authorization_epoch !==
      context.tenantAuthContext.observed_authorization_epochs.credential ||
    facts.workspace_authorization_epoch !==
      context.tenantAuthContext.observed_authorization_epochs.workspace ||
    facts.entry_credential_kind !== 'service_api' ||
    facts.entry_principal_mode !== 'credential_service_principal' ||
    facts.entry_channel !== 'service_api' ||
    facts.entry_scope !== proof.requiredScopes[0] ||
    facts.entry_target_cardinality !== expectedSnapshotCardinality ||
    Object.hasOwn(facts, 'snapshot_hash')
  ) {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
}

function closeAgentFacts(
  factsInput: unknown,
  context: AuthenticatedAccessKeyContext,
): AgentDeploymentEntryAdmissionSnapshotV1 {
  if (!isRecord(factsInput)) throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  assertCredentialFacts(factsInput, context, 'agent');
  const candidate = {
    ...factsInput,
    schema_version: 'agent-deployment-entry-admission-snapshot/1',
    snapshot_hash: '',
  };
  const snapshot = {
    ...candidate,
    snapshot_hash: canonicalSha256ExcludingRootKeys(candidate, ['snapshot_hash']),
  };
  const verified = verifyAdmissionSnapshot({
    snapshot,
    expected: {
      deployment_kind: 'agent',
      workspace_id: readString(factsInput, 'workspace_id'),
      deployment_id: readString(factsInput, 'agent_deployment_id'),
      deployment_revision_id: readString(factsInput, 'agent_deployment_revision_id'),
      deployment_revision_contract_hash: readString(
        factsInput,
        'agent_deployment_revision_contract_hash',
      ),
      admission_activation_epoch: readEpoch(factsInput, 'admission_activation_epoch'),
      observed_revoke_epoch: readEpoch(factsInput, 'observed_revoke_epoch'),
    },
  });
  if (verified.deployment_kind !== 'agent') {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
  return Object.freeze(verified);
}

function closeFlowFacts(
  factsInput: unknown,
  context: AuthenticatedAccessKeyContext,
): FlowDeploymentEntryAdmissionSnapshotV1 {
  if (!isRecord(factsInput)) throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  assertCredentialFacts(factsInput, context, 'flow');
  const candidate = {
    ...factsInput,
    schema_version: 'flow-deployment-entry-admission-snapshot/1',
    snapshot_hash: '',
  };
  const snapshot = {
    ...candidate,
    snapshot_hash: canonicalSha256ExcludingRootKeys(candidate, ['snapshot_hash']),
  };
  const verified = verifyAdmissionSnapshot({
    snapshot,
    expected: {
      deployment_kind: 'flow',
      workspace_id: readString(factsInput, 'workspace_id'),
      deployment_id: readString(factsInput, 'flow_deployment_id'),
      deployment_revision_id: readString(factsInput, 'flow_deployment_revision_id'),
      deployment_revision_contract_hash: readString(
        factsInput,
        'flow_deployment_revision_contract_hash',
      ),
      admission_activation_epoch: readEpoch(factsInput, 'admission_activation_epoch'),
      observed_revoke_epoch: readEpoch(factsInput, 'observed_revoke_epoch'),
    },
  });
  if (verified.deployment_kind !== 'flow') {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
  return Object.freeze(verified);
}

function assertScopeMatchesContext(
  context: AuthenticatedAccessKeyContext,
  kind: 'agent' | 'flow',
  requiredScope: string,
): void {
  assertPolicyProof(context, kind);
  if (context.policyPhase.requiredScopes[0] !== requiredScope) {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
}

export async function admitAgentServiceDeploymentInTransaction(
  transaction: DeploymentDatabaseTransaction,
  context: AuthenticatedAccessKeyContext,
  input: TransactionScopedDeploymentAdmissionInput,
): Promise<AgentDeploymentEntryAdmissionSnapshotV1> {
  assertTransactionScopedInput(input);
  assertScopeMatchesContext(context, 'agent', input.requiredScope);
  try {
    const facts = await transaction.resolveAgentServiceAdmission(
      input.publicSelector,
      input.requiredScope,
    );
    return closeAgentFacts(facts, context);
  } catch {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
}

export async function admitFlowServiceDeploymentInTransaction(
  transaction: DeploymentDatabaseTransaction,
  context: AuthenticatedAccessKeyContext,
  input: TransactionScopedDeploymentAdmissionInput,
): Promise<FlowDeploymentEntryAdmissionSnapshotV1> {
  assertTransactionScopedInput(input);
  assertScopeMatchesContext(context, 'flow', input.requiredScope);
  try {
    const facts = await transaction.resolveFlowServiceAdmission(
      input.publicSelector,
      input.requiredScope,
    );
    return closeFlowFacts(facts, context);
  } catch {
    throw new DeploymentBoundaryError('DEPLOYMENT_ADMISSION_FAILED');
  }
}
