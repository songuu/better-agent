import { isCredentialPolicyPhasePassed } from '@better-agent/auth';
import {
  type ConversationPrincipalV1,
  ConversationPrincipalV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import type { AuthenticatedAccessKeyContext } from '../auth/index.js';
import {
  hasExactKeys,
  type OriginalRunAuthorizationFacts,
  RunBoundaryError,
  type RunDatabaseTransaction,
  samePrincipal,
} from './run-transaction.js';

function credentialPrincipal(context: AuthenticatedAccessKeyContext): ConversationPrincipalV1 {
  const principal = context.tenantAuthContext.caller_principal;
  if (principal.kind !== 'credential') throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  return {
    schema_version: 'conversation-principal/1',
    kind: 'credential',
    credential_id: principal.credential_id,
  };
}

function assertCreateContext(
  context: AuthenticatedAccessKeyContext,
  targetKind: 'agent' | 'flow',
): void {
  const proof = context.policyPhase;
  const expectedOperation = targetKind === 'agent' ? 'createAgentChatRun' : 'createFlowRun';
  const expectedPurpose = targetKind === 'agent' ? 'agent_invoke' : 'flow_invoke';
  const expectedScope = targetKind === 'agent' ? 'agent:run:create' : 'flow:run:create';
  const expectedGrant =
    targetKind === 'agent' ? 'agent_deployment_entry_grants' : 'flow_deployment_entry_grants';
  const expectedCardinality =
    targetKind === 'agent' ? 'exactly_one_deployment' : 'exactly_one_flow';
  if (
    !isCredentialPolicyPhasePassed(proof) ||
    context.credentialKind !== 'service_api' ||
    proof.operationId !== expectedOperation ||
    proof.operationPurpose !== expectedPurpose ||
    proof.requiredScopes.length !== 1 ||
    proof.requiredScopes[0] !== expectedScope ||
    proof.remainingGate.typedGrantFamily !== expectedGrant ||
    proof.remainingGate.targetCardinality !== expectedCardinality
  ) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
}

export function assertCancellationContext(
  context: AuthenticatedAccessKeyContext,
): ConversationPrincipalV1 {
  const proof = context.policyPhase;
  if (
    !isCredentialPolicyPhasePassed(proof) ||
    context.credentialKind !== 'service_api' ||
    proof.operationId !== 'requestRunCancellation' ||
    proof.operationPurpose !== 'run_cancel' ||
    proof.requiredScopes.length !== 1 ||
    proof.requiredScopes[0] !== 'run:cancel' ||
    proof.remainingGate.typedGrantFamily !== 'original_run_entry_grant' ||
    proof.remainingGate.targetCardinality !== 'original_run_only'
  ) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  return credentialPrincipal(context);
}

function assertReadContext(context: AuthenticatedAccessKeyContext): void {
  const proof = context.policyPhase;
  if (
    !isCredentialPolicyPhasePassed(proof) ||
    context.credentialKind !== 'service_api' ||
    proof.operationId !== 'getRun' ||
    proof.operationPurpose !== 'run_read' ||
    proof.requiredScopes.length !== 1 ||
    proof.requiredScopes[0] !== 'run:read' ||
    proof.remainingGate.typedGrantFamily !== 'original_run_entry_grant' ||
    proof.remainingGate.targetCardinality !== 'original_run_only'
  ) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
}

function readOriginalAuthorization(value: unknown): OriginalRunAuthorizationFacts {
  if (
    !hasExactKeys(value, [
      'acceptedPrincipal',
      'authorizedScope',
      'deploymentId',
      'runId',
      'targetKind',
      'workspaceId',
    ]) ||
    !UuidV1Schema.safeParse(value.workspaceId).success ||
    !UuidV1Schema.safeParse(value.runId).success ||
    !UuidV1Schema.safeParse(value.deploymentId).success ||
    (value.targetKind !== 'agent' && value.targetKind !== 'flow') ||
    value.authorizedScope !== 'run:read'
  ) {
    throw new RunBoundaryError('RUN_NOT_FOUND');
  }
  const principal = ConversationPrincipalV1Schema.safeParse(value.acceptedPrincipal);
  if (!principal.success) throw new RunBoundaryError('RUN_NOT_FOUND');
  return Object.freeze({
    workspaceId: value.workspaceId as string,
    runId: value.runId as string,
    acceptedPrincipal: principal.data,
    targetKind: value.targetKind,
    deploymentId: value.deploymentId as string,
    authorizedScope: 'run:read',
  });
}

export function assertIndependentServiceGates(input: {
  readonly createContext: AuthenticatedAccessKeyContext;
  readonly readContext: AuthenticatedAccessKeyContext;
  readonly targetKind: 'agent' | 'flow';
}): ConversationPrincipalV1 {
  assertCreateContext(input.createContext, input.targetKind);
  assertReadContext(input.readContext);
  const createPrincipal = credentialPrincipal(input.createContext);
  const readPrincipal = credentialPrincipal(input.readContext);
  if (
    input.createContext.tenantAuthContext.workspace_id !==
      input.readContext.tenantAuthContext.workspace_id ||
    !samePrincipal(createPrincipal, readPrincipal)
  ) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  return createPrincipal;
}

export async function authorizeServiceOriginalRunInTransaction(input: {
  readonly transaction: RunDatabaseTransaction;
  readonly createContext: AuthenticatedAccessKeyContext;
  readonly readContext: AuthenticatedAccessKeyContext;
  readonly runId: string;
  readonly targetKind: 'agent' | 'flow';
}): Promise<OriginalRunAuthorizationFacts> {
  const principal = assertIndependentServiceGates(input);
  const value = await input.transaction.authorizeServiceOriginalRun({
    workspaceId: input.readContext.tenantAuthContext.workspace_id,
    credentialId: principal.kind === 'credential' ? principal.credential_id : '',
    runId: input.runId,
    targetKind: input.targetKind,
    requiredScope: 'run:read',
  });
  const facts = readOriginalAuthorization(value);
  if (
    facts.workspaceId !== input.readContext.tenantAuthContext.workspace_id ||
    facts.runId !== input.runId ||
    facts.targetKind !== input.targetKind ||
    !samePrincipal(facts.acceptedPrincipal, principal)
  ) {
    throw new RunBoundaryError('RUN_NOT_FOUND');
  }
  return facts;
}
