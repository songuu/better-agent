import { UuidV1Schema } from '@better-agent/domain-contracts';

import { failRunCore } from './errors.js';

export interface CanonicalAcceptanceReceiptDataV1 {
  readonly status: 'QUEUED';
  readonly run_id: string;
  readonly accepted_request_id: string;
  readonly operation_url: string;
  readonly events_url: string;
  readonly cancel_url: string;
  readonly conversation_id?: string;
}

export interface CanonicalAcceptanceReceiptV1 {
  readonly http_status: 202;
  readonly data: CanonicalAcceptanceReceiptDataV1;
}

export interface PrepareCanonicalAcceptanceReceiptInputV1 {
  readonly http_status: number;
  readonly run_id: string;
  readonly accepted_request_id: string;
  readonly conversation_id?: string;
}

function readUuid(value: string, path: string): string {
  const parsed = UuidV1Schema.safeParse(value);
  if (!parsed.success) {
    failRunCore('RUN_ACCEPTANCE_RECEIPT_INVALID', path, 'expected a canonical UUID');
  }
  return parsed.data;
}

export function prepareCanonicalAcceptanceReceipt(
  input: PrepareCanonicalAcceptanceReceiptInputV1,
): CanonicalAcceptanceReceiptV1 {
  if (input.http_status !== 202) {
    failRunCore(
      'RUN_ACCEPTANCE_RECEIPT_INVALID',
      '$.http_status',
      'durable acceptance receipt must be the canonical 202 projection',
    );
  }
  const runId = readUuid(input.run_id, '$.run_id');
  const acceptedRequestId = readUuid(input.accepted_request_id, '$.accepted_request_id');
  const conversationId =
    input.conversation_id === undefined
      ? undefined
      : readUuid(input.conversation_id, '$.conversation_id');
  const data: CanonicalAcceptanceReceiptDataV1 = Object.freeze({
    status: 'QUEUED',
    run_id: runId,
    accepted_request_id: acceptedRequestId,
    operation_url: `/v1/oapi/runs/${runId}`,
    events_url: `/v1/oapi/runs/${runId}/events`,
    cancel_url: `/v1/oapi/runs/${runId}/cancel`,
    ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
  });
  return Object.freeze({ http_status: 202, data });
}
