import { withBrowserSessionVerifier } from '@better-agent/auth';
import { BrowserClientChannelV1Schema, UuidV1Schema } from '@better-agent/domain-contracts';

import {
  type BrowserIdentityDatabaseTransaction,
  type BrowserOriginalRunAuthorizationCommand,
  type BrowserSessionIdentityFacts,
  type BrowserTrustedRequestContext,
  hasExactKeys,
  type OriginalRunAuthorizationFacts,
  RunBoundaryError,
  type RunDatabaseTransaction,
} from './run-transaction.js';

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === value &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function readTrustedBrowserRequestContext(value: unknown): BrowserTrustedRequestContext {
  if (
    !hasExactKeys(value, ['actualOrigin', 'clientChannel', 'tokenAudience']) ||
    typeof value.actualOrigin !== 'string' ||
    !isCanonicalHttpsOrigin(value.actualOrigin) ||
    value.tokenAudience !== 'agent_browser_api' ||
    !BrowserClientChannelV1Schema.safeParse(value.clientChannel).success
  ) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  return Object.freeze({
    actualOrigin: value.actualOrigin,
    tokenAudience: 'agent_browser_api',
    clientChannel: value.clientChannel as BrowserTrustedRequestContext['clientChannel'],
  });
}

function readEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  return value as number;
}

function readBrowserIdentity(value: unknown): BrowserSessionIdentityFacts {
  if (
    !hasExactKeys(value, [
      'agent_deployment_id',
      'browser_session_id',
      'end_user_principal_id',
      'observed_deployment_revoke_epoch',
      'observed_principal_session_epoch',
      'session_epoch',
      'workspace_id',
    ]) ||
    !UuidV1Schema.safeParse(value.workspace_id).success ||
    !UuidV1Schema.safeParse(value.browser_session_id).success ||
    !UuidV1Schema.safeParse(value.end_user_principal_id).success ||
    !UuidV1Schema.safeParse(value.agent_deployment_id).success
  ) {
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  }
  return Object.freeze({
    workspaceId: value.workspace_id as string,
    browserSessionId: value.browser_session_id as string,
    endUserPrincipalId: value.end_user_principal_id as string,
    agentDeploymentId: value.agent_deployment_id as string,
    sessionAuthorizationEpoch: readEpoch(value.session_epoch),
    principalAuthorizationEpoch: readEpoch(value.observed_principal_session_epoch),
    deploymentAuthorizationEpoch: readEpoch(value.observed_deployment_revoke_epoch),
  });
}

function readBrowserOriginalAuthorization(
  value: unknown,
  requiredScope: BrowserOriginalRunAuthorizationCommand['requiredScope'],
): OriginalRunAuthorizationFacts {
  if (
    !hasExactKeys(value, [
      'acceptedPrincipal',
      'authorizedScope',
      'browserSessionId',
      'deploymentAuthorizationEpoch',
      'deploymentId',
      'principalAuthorizationEpoch',
      'runId',
      'sessionAuthorizationEpoch',
      'targetKind',
      'workspaceId',
    ]) ||
    !UuidV1Schema.safeParse(value.workspaceId).success ||
    !UuidV1Schema.safeParse(value.runId).success ||
    !UuidV1Schema.safeParse(value.deploymentId).success ||
    !UuidV1Schema.safeParse(value.browserSessionId).success ||
    value.authorizedScope !== requiredScope ||
    value.targetKind !== 'agent' ||
    !hasExactKeys(value.acceptedPrincipal, ['end_user_principal_id', 'kind', 'schema_version']) ||
    value.acceptedPrincipal.schema_version !== 'conversation-principal/1' ||
    value.acceptedPrincipal.kind !== 'end_user' ||
    !UuidV1Schema.safeParse(value.acceptedPrincipal.end_user_principal_id).success
  ) {
    throw new RunBoundaryError('RUN_NOT_FOUND');
  }
  return Object.freeze({
    workspaceId: value.workspaceId as string,
    runId: value.runId as string,
    acceptedPrincipal: {
      schema_version: 'conversation-principal/1' as const,
      kind: 'end_user' as const,
      end_user_principal_id: value.acceptedPrincipal.end_user_principal_id as string,
    },
    targetKind: 'agent',
    deploymentId: value.deploymentId as string,
    authorizedScope: requiredScope,
    browserSessionId: value.browserSessionId as string,
    sessionAuthorizationEpoch: readEpoch(value.sessionAuthorizationEpoch),
    principalAuthorizationEpoch: readEpoch(value.principalAuthorizationEpoch),
    deploymentAuthorizationEpoch: readEpoch(value.deploymentAuthorizationEpoch),
  });
}

export async function authenticateBrowserRunIdentityInTransaction(input: {
  readonly transaction: BrowserIdentityDatabaseTransaction;
  readonly token: string;
  readonly declaredWorkspaceId: string;
  browserSessionPepper(): Promise<Uint8Array>;
}): Promise<BrowserSessionIdentityFacts> {
  let pepper: Buffer | undefined;
  try {
    pepper = Buffer.from(await input.browserSessionPepper());
    return await withBrowserSessionVerifier(input.token, pepper, async (proof) => {
      const trustedRequestContext = readTrustedBrowserRequestContext(
        input.transaction.trustedBrowserRequestContext(),
      );
      const value = await input.transaction.authenticateBrowserSessionIdentity({
        browserSessionId: proof.browserSessionId,
        declaredWorkspaceId: input.declaredWorkspaceId,
        verifier: proof.verifier,
        ...trustedRequestContext,
      });
      const identity = readBrowserIdentity(value);
      if (
        identity.workspaceId !== input.declaredWorkspaceId ||
        identity.browserSessionId !== proof.browserSessionId
      ) {
        throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
      }
      return identity;
    });
  } catch (error) {
    if (error instanceof RunBoundaryError) throw error;
    throw new RunBoundaryError('RUN_AUTHORIZATION_FAILED');
  } finally {
    pepper?.fill(0);
  }
}

export async function authorizeBrowserOriginalRunInTransaction(input: {
  readonly transaction: RunDatabaseTransaction;
  readonly identity: BrowserSessionIdentityFacts;
  readonly runId: string;
  readonly requiredScope?: BrowserOriginalRunAuthorizationCommand['requiredScope'];
}): Promise<OriginalRunAuthorizationFacts> {
  const requiredScope = input.requiredScope ?? 'run:read';
  const command: BrowserOriginalRunAuthorizationCommand = {
    ...input.identity,
    runId: input.runId,
    targetKind: 'agent',
    requiredScope,
  };
  const facts = readBrowserOriginalAuthorization(
    await input.transaction.authorizeBrowserOriginalRun(command),
    requiredScope,
  );
  if (
    facts.workspaceId !== input.identity.workspaceId ||
    facts.runId !== input.runId ||
    facts.acceptedPrincipal.kind !== 'end_user' ||
    facts.acceptedPrincipal.end_user_principal_id !== input.identity.endUserPrincipalId ||
    facts.deploymentId !== input.identity.agentDeploymentId ||
    facts.browserSessionId !== input.identity.browserSessionId ||
    facts.sessionAuthorizationEpoch !== input.identity.sessionAuthorizationEpoch ||
    facts.principalAuthorizationEpoch !== input.identity.principalAuthorizationEpoch ||
    facts.deploymentAuthorizationEpoch !== input.identity.deploymentAuthorizationEpoch
  ) {
    throw new RunBoundaryError('RUN_NOT_FOUND');
  }
  return facts;
}
