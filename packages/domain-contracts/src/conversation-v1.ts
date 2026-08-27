import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import { Sha256HexV1Schema } from './primitives.js';

export const ConversationStateVersionV1Schema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const CredentialConversationPrincipalV1Schema = z.strictObject({
  schema_version: z.literal('conversation-principal/1'),
  kind: z.literal('credential'),
  credential_id: UuidV1Schema,
});

const EndUserConversationPrincipalV1Schema = z.strictObject({
  schema_version: z.literal('conversation-principal/1'),
  kind: z.literal('end_user'),
  end_user_principal_id: UuidV1Schema,
});

/** Runtime Conversations never inherit Studio/management-user authority. */
export const ConversationPrincipalV1Schema = z.discriminatedUnion('kind', [
  CredentialConversationPrincipalV1Schema,
  EndUserConversationPrincipalV1Schema,
]);

export const ConversationV1Schema = z.strictObject({
  schema_version: z.literal('conversation/1'),
  workspace_id: UuidV1Schema,
  conversation_id: UuidV1Schema,
  principal: ConversationPrincipalV1Schema,
  agent_deployment_id: UuidV1Schema,
  created_under_agent_deployment_revision_id: UuidV1Schema,
  conversation_contract_hash: Sha256HexV1Schema,
  state_version: ConversationStateVersionV1Schema,
});

/**
 * Caller input contains only the expected version. The transaction computes
 * current + 1 so a caller cannot choose or skip the next state version.
 */
export const ConversationStateCasV1Schema = z.strictObject({
  schema_version: z.literal('conversation-state-cas/1'),
  workspace_id: UuidV1Schema,
  conversation_id: UuidV1Schema,
  expected_state_version: ConversationStateVersionV1Schema,
});

export type ConversationPrincipalV1 = z.infer<typeof ConversationPrincipalV1Schema>;
export type ConversationV1 = z.infer<typeof ConversationV1Schema>;
export type ConversationStateCasV1 = z.infer<typeof ConversationStateCasV1Schema>;
