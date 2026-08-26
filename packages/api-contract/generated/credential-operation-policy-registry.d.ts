// Generated from docs/api/openapi.yaml by @better-agent/api-contract.
// DO NOT EDIT: run `pnpm --filter @better-agent/api-contract generate`.

export type ServiceCredentialOperationId = "createAgentChatRun" | "createAgentConversation" | "createFlowRun" | "exchangeBrowserSession" | "getRun" | "listAgentConversationMessages" | "listAgentConversations" | "requestRunCancellation" | "resumeHumanGate" | "streamRunEvents";

export interface ReviewedServiceCredentialOperation {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly policy: Readonly<Record<string, unknown>>;
}

export declare const credentialOperationPolicyRegistrySchemaVersion: "openapi-credential-operation-policy/1";

export declare const serviceCredentialOperationIds: readonly ServiceCredentialOperationId[];

export declare function getReviewedServiceCredentialOperation(
  operationId: string,
): Readonly<ReviewedServiceCredentialOperation> | undefined;
