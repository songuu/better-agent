import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import { addCustomIssue, NonEmptyStringSchema, Sha256HexV1Schema } from './primitives.js';

const CanonicalNonNegativeIntegerStringV1Schema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u, 'expected a canonical non-negative decimal integer string');

const DurableArchiveRefV1Schema = NonEmptyStringSchema.max(2_048).refine(
  (value) => !value.includes('?') && !value.includes('#'),
  'archive and receipt refs must not contain query parameters or fragments',
);

export const RunRetentionMaterialKindV1Schema = z.enum(['EVENTS', 'RECOVERY']);

export const RunRetentionHorizonsV1Schema = z
  .strictObject({
    schema_version: z.literal('run-retention-horizons/1'),
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    finished_at: z.iso.datetime({ offset: true }),
    events_retention_until: z.iso.datetime({ offset: true }),
    recovery_retention_until: z.iso.datetime({ offset: true }),
    retention_until: z.iso.datetime({ offset: true }),
  })
  .superRefine((horizons, ctx) => {
    const finishedAt = Date.parse(horizons.finished_at);
    const eventsUntil = Date.parse(horizons.events_retention_until);
    const recoveryUntil = Date.parse(horizons.recovery_retention_until);
    const policyUntil = Date.parse(horizons.retention_until);

    if (eventsUntil < finishedAt + 7 * 24 * 60 * 60 * 1_000) {
      addCustomIssue(
        ctx,
        ['events_retention_until'],
        'event retention must extend at least seven days after terminal time',
      );
    }
    if (recoveryUntil < finishedAt + 30 * 24 * 60 * 60 * 1_000) {
      addCustomIssue(
        ctx,
        ['recovery_retention_until'],
        'recovery retention must extend at least thirty days after terminal time',
      );
    }
    if (recoveryUntil < eventsUntil) {
      addCustomIssue(
        ctx,
        ['recovery_retention_until'],
        'recovery retention cannot precede event retention',
      );
    }
    if (policyUntil < recoveryUntil) {
      addCustomIssue(
        ctx,
        ['retention_until'],
        'aggregate policy retention cannot precede recovery retention',
      );
    }
  });

export const ArchiveManifestV1Schema = z.strictObject({
  schema_version: z.literal('run-archive-manifest/1'),
  manifest_id: UuidV1Schema,
  workspace_id: UuidV1Schema,
  run_id: UuidV1Schema,
  archive_ref: DurableArchiveRefV1Schema,
  archive_sha256: Sha256HexV1Schema,
  created_at: z.iso.datetime({ offset: true }),
});

export const ArchiveVerificationReceiptV1Schema = z.strictObject({
  schema_version: z.literal('run-archive-verification-receipt/1'),
  verification_receipt_id: UuidV1Schema,
  manifest_id: UuidV1Schema,
  workspace_id: UuidV1Schema,
  run_id: UuidV1Schema,
  archive_ref: DurableArchiveRefV1Schema,
  archive_sha256: Sha256HexV1Schema,
  receipt_ref: DurableArchiveRefV1Schema,
  receipt_sha256: Sha256HexV1Schema,
  status: z.literal('VERIFIED'),
  verified_at: z.iso.datetime({ offset: true }),
});

export const ArchiveApprovalReceiptV1Schema = z.strictObject({
  schema_version: z.literal('run-archive-approval-receipt/1'),
  approval_receipt_id: UuidV1Schema,
  manifest_id: UuidV1Schema,
  verification_receipt_id: UuidV1Schema,
  verification_receipt_sha256: Sha256HexV1Schema,
  workspace_id: UuidV1Schema,
  run_id: UuidV1Schema,
  receipt_ref: DurableArchiveRefV1Schema,
  receipt_sha256: Sha256HexV1Schema,
  status: z.literal('APPROVED'),
  approved_at: z.iso.datetime({ offset: true }),
});

export const RunArchiveEvidenceV1Schema = z
  .strictObject({
    schema_version: z.literal('run-archive-evidence/1'),
    manifest: ArchiveManifestV1Schema,
    verification_receipt: ArchiveVerificationReceiptV1Schema,
    approval_receipt: ArchiveApprovalReceiptV1Schema,
  })
  .superRefine((evidence, ctx) => {
    const { manifest, verification_receipt: verification, approval_receipt: approval } = evidence;
    if (
      verification.manifest_id !== manifest.manifest_id ||
      verification.workspace_id !== manifest.workspace_id ||
      verification.run_id !== manifest.run_id ||
      verification.archive_ref !== manifest.archive_ref ||
      verification.archive_sha256 !== manifest.archive_sha256
    ) {
      addCustomIssue(
        ctx,
        ['verification_receipt'],
        'verification receipt must exactly bind the archive manifest identity, ref, and hash',
      );
    }
    if (
      approval.manifest_id !== manifest.manifest_id ||
      approval.workspace_id !== manifest.workspace_id ||
      approval.run_id !== manifest.run_id ||
      approval.verification_receipt_id !== verification.verification_receipt_id ||
      approval.verification_receipt_sha256 !== verification.receipt_sha256
    ) {
      addCustomIssue(
        ctx,
        ['approval_receipt'],
        'approval receipt must exactly bind the manifest and verification receipt',
      );
    }
    if (Date.parse(verification.verified_at) < Date.parse(manifest.created_at)) {
      addCustomIssue(
        ctx,
        ['verification_receipt', 'verified_at'],
        'archive verification cannot precede manifest creation',
      );
    }
    if (Date.parse(approval.approved_at) < Date.parse(verification.verified_at)) {
      addCustomIssue(
        ctx,
        ['approval_receipt', 'approved_at'],
        'archive approval cannot precede verification',
      );
    }
  });

export const RunRetentionPurgeReceiptV1Schema = z
  .strictObject({
    schema_version: z.literal('run-retention-purge-receipt/1'),
    purge_receipt_id: UuidV1Schema,
    workspace_id: UuidV1Schema,
    run_id: UuidV1Schema,
    manifest_id: UuidV1Schema,
    material_kind: RunRetentionMaterialKindV1Schema,
    purged_checkpoints: CanonicalNonNegativeIntegerStringV1Schema,
    purged_events: CanonicalNonNegativeIntegerStringV1Schema,
    purged_outbox: CanonicalNonNegativeIntegerStringV1Schema,
    financial_ledger_purged: z.literal(false),
    purged_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((receipt, ctx) => {
    if (
      receipt.material_kind === 'EVENTS' &&
      (receipt.purged_checkpoints !== '0' || receipt.purged_outbox !== '0')
    ) {
      addCustomIssue(
        ctx,
        ['material_kind'],
        'EVENTS purge receipts cannot claim recovery-material deletion',
      );
    }
    if (receipt.material_kind === 'RECOVERY' && receipt.purged_events !== '0') {
      addCustomIssue(ctx, ['material_kind'], 'RECOVERY purge receipts cannot claim event deletion');
    }
  });

export type RunRetentionMaterialKindV1 = z.infer<typeof RunRetentionMaterialKindV1Schema>;
export type RunRetentionHorizonsV1 = z.infer<typeof RunRetentionHorizonsV1Schema>;
export type ArchiveManifestV1 = z.infer<typeof ArchiveManifestV1Schema>;
export type ArchiveVerificationReceiptV1 = z.infer<typeof ArchiveVerificationReceiptV1Schema>;
export type ArchiveApprovalReceiptV1 = z.infer<typeof ArchiveApprovalReceiptV1Schema>;
export type RunArchiveEvidenceV1 = z.infer<typeof RunArchiveEvidenceV1Schema>;
export type RunRetentionPurgeReceiptV1 = z.infer<typeof RunRetentionPurgeReceiptV1Schema>;
