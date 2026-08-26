import { z } from 'zod';

import { CanonicalHttpsOriginV1Schema, UuidV1Schema } from './auth-v1.js';
import {
  BrowserClientChannelV1Schema,
  BrowserSessionTokenAudienceV1Schema,
} from './deployment-common-v1.js';
import { addCustomIssue, NonNegativeIntegerSchema } from './primitives.js';

export const BrowserSessionMetadataV1Schema = z
  .strictObject({
    schema_version: z.literal('browser-session-metadata/1'),
    browser_session_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    agent_deployment_id: UuidV1Schema,
    principal_id: UuidV1Schema,
    assertion_use_id: UuidV1Schema,
    client_channel: BrowserClientChannelV1Schema,
    canonical_origin: CanonicalHttpsOriginV1Schema,
    token_audience: BrowserSessionTokenAudienceV1Schema,
    observed_principal_session_epoch: NonNegativeIntegerSchema,
    observed_deployment_revoke_epoch: NonNegativeIntegerSchema,
    session_epoch: NonNegativeIntegerSchema,
    status: z.enum(['ACTIVE', 'REVOKED']),
    issued_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    revoked_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((session, ctx) => {
    const issuedAt = Date.parse(session.issued_at);
    const expiresAt = Date.parse(session.expires_at);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 900_000) {
      addCustomIssue(ctx, ['expires_at'], 'browser session TTL must be between 1 and 900 seconds');
    }
    if ((session.status === 'REVOKED') !== (session.revoked_at !== undefined)) {
      addCustomIssue(
        ctx,
        ['revoked_at'],
        'revoked browser sessions require revoked_at and active sessions forbid it',
      );
    }
    if (
      session.revoked_at !== undefined &&
      Date.parse(session.revoked_at) < Date.parse(session.issued_at)
    ) {
      addCustomIssue(ctx, ['revoked_at'], 'browser session revoked_at cannot precede issued_at');
    }
  });

export type BrowserSessionMetadataV1 = z.infer<typeof BrowserSessionMetadataV1Schema>;
