import {
  RunArchiveEvidenceV1Schema,
  type RunBillingStateValueV1,
  RunBillingStateValueV1Schema,
  RunRetentionHorizonsV1Schema,
  type RunRetentionMaterialKindV1,
  RunRetentionMaterialKindV1Schema,
  RunRetentionPurgeReceiptV1Schema,
  type RunStatusV1,
  RunStatusV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import { failRunCore } from './errors.js';
import { isTerminalRunStatus } from './run-state.js';

export type RetentionIneligibilityReasonV1 =
  | 'RUN_NOT_TERMINAL'
  | 'BILLING_NOT_SETTLED'
  | 'RECONCILIATION_EVIDENCE_MISSING'
  | 'HELD_RESERVATION_PRESENT'
  | 'OUTBOX_DELIVERY_IN_PROGRESS'
  | 'ARCHIVE_EVIDENCE_MISSING'
  | 'ARCHIVE_EVIDENCE_MISMATCH'
  | 'PURGE_ALREADY_RECORDED'
  | 'HORIZON_NOT_REACHED';

export type RunRetentionEligibilityV1 =
  | { readonly eligible: true; readonly material_kind: RunRetentionMaterialKindV1 }
  | { readonly eligible: false; readonly reason: RetentionIneligibilityReasonV1 };

export interface EvaluateRunRetentionEligibilityInputV1 {
  readonly material_kind: RunRetentionMaterialKindV1;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly run_status: RunStatusV1;
  readonly billing_state: RunBillingStateValueV1;
  readonly now: string;
  readonly horizons: unknown;
  readonly archive_evidence?: unknown;
  readonly existing_purge_receipts: readonly unknown[];
  readonly reconciliation_evidence_present: boolean;
  readonly held_reservation_present: boolean;
  readonly pending_or_leased_outbox_present: boolean;
}

function ineligible(reason: RetentionIneligibilityReasonV1): RunRetentionEligibilityV1 {
  return Object.freeze({ eligible: false, reason });
}

function parseInstant(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    failRunCore('RUN_RETENTION_INVALID', path, 'expected an ISO date-time');
  }
  return parsed;
}

export function evaluateRunRetentionEligibility(
  input: EvaluateRunRetentionEligibilityInputV1,
): RunRetentionEligibilityV1 {
  const material = RunRetentionMaterialKindV1Schema.safeParse(input.material_kind);
  const workspace = UuidV1Schema.safeParse(input.workspace_id);
  const run = UuidV1Schema.safeParse(input.run_id);
  const status = RunStatusV1Schema.safeParse(input.run_status);
  const billing = RunBillingStateValueV1Schema.safeParse(input.billing_state);
  if (
    !material.success ||
    !workspace.success ||
    !run.success ||
    !status.success ||
    !billing.success ||
    typeof input.reconciliation_evidence_present !== 'boolean' ||
    typeof input.held_reservation_present !== 'boolean' ||
    typeof input.pending_or_leased_outbox_present !== 'boolean'
  ) {
    failRunCore('RUN_RETENTION_INVALID', '$', 'retention identity or state is invalid');
  }
  if (!isTerminalRunStatus(status.data)) return ineligible('RUN_NOT_TERMINAL');
  if (billing.data !== 'SETTLED') return ineligible('BILLING_NOT_SETTLED');
  if (status.data === 'NEEDS_ATTENTION' && !input.reconciliation_evidence_present) {
    return ineligible('RECONCILIATION_EVIDENCE_MISSING');
  }
  if (material.data === 'RECOVERY' && input.held_reservation_present) {
    return ineligible('HELD_RESERVATION_PRESENT');
  }
  if (material.data === 'RECOVERY' && input.pending_or_leased_outbox_present) {
    return ineligible('OUTBOX_DELIVERY_IN_PROGRESS');
  }

  const horizons = RunRetentionHorizonsV1Schema.safeParse(input.horizons);
  if (!horizons.success) {
    failRunCore('RUN_RETENTION_INVALID', '$.horizons', 'retention horizons are invalid', {
      cause: horizons.error,
    });
  }
  if (horizons.data.workspace_id !== workspace.data || horizons.data.run_id !== run.data) {
    failRunCore('RUN_RETENTION_INVALID', '$.horizons', 'horizons belong to another Run');
  }
  if (input.archive_evidence === undefined) return ineligible('ARCHIVE_EVIDENCE_MISSING');
  const evidence = RunArchiveEvidenceV1Schema.safeParse(input.archive_evidence);
  if (!evidence.success) return ineligible('ARCHIVE_EVIDENCE_MISMATCH');
  if (
    evidence.data.manifest.workspace_id !== workspace.data ||
    evidence.data.manifest.run_id !== run.data
  ) {
    return ineligible('ARCHIVE_EVIDENCE_MISMATCH');
  }

  for (const [index, candidate] of input.existing_purge_receipts.entries()) {
    const receipt = RunRetentionPurgeReceiptV1Schema.safeParse(candidate);
    if (!receipt.success) {
      failRunCore(
        'RUN_RETENTION_INVALID',
        `$.existing_purge_receipts[${index}]`,
        'existing purge receipt is invalid',
      );
    }
    if (
      receipt.data.workspace_id === workspace.data &&
      receipt.data.run_id === run.data &&
      receipt.data.material_kind === material.data
    ) {
      return ineligible('PURGE_ALREADY_RECORDED');
    }
  }

  const now = parseInstant(input.now, '$.now');
  const horizon =
    material.data === 'EVENTS'
      ? parseInstant(horizons.data.events_retention_until, '$.horizons.events_retention_until')
      : Math.max(
          parseInstant(
            horizons.data.recovery_retention_until,
            '$.horizons.recovery_retention_until',
          ),
          parseInstant(horizons.data.retention_until, '$.horizons.retention_until'),
        );
  if (now < horizon) return ineligible('HORIZON_NOT_REACHED');
  return Object.freeze({ eligible: true, material_kind: material.data });
}
