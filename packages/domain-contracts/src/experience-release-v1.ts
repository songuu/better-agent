import { z } from 'zod';

import { UuidV1Schema } from './auth-v1.js';
import {
  addCustomIssue,
  hasUniqueBy,
  hasUniqueStrings,
  JsonObjectSchema,
  NonEmptyStringSchema,
  Sha256HexV1Schema,
} from './primitives.js';

export const ExperienceQuickEntryV1Schema = z.strictObject({
  quick_entry_id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  public_handle: NonEmptyStringSchema,
  operation_contract_hash: Sha256HexV1Schema,
  input_schema_hash: Sha256HexV1Schema,
  default_inputs: JsonObjectSchema,
});

export const ExperienceReleaseV1Schema = z
  .strictObject({
    schema_version: z.literal('experience-release/1'),
    experience_id: UuidV1Schema,
    experience_release_id: UuidV1Schema,
    compatible_agent_id: UuidV1Schema,
    source_draft_revision_id: UuidV1Schema,
    opening_message: z.string().min(1).max(8192).optional(),
    recommended_questions: z
      .array(z.string().min(1).max(1024))
      .max(20)
      .refine(hasUniqueStrings, 'recommended questions must be unique'),
    quick_entries: z.array(ExperienceQuickEntryV1Schema).max(50),
    content_hash: Sha256HexV1Schema,
  })
  .superRefine((release, ctx) => {
    if (!hasUniqueBy(release.quick_entries, (entry) => entry.quick_entry_id)) {
      addCustomIssue(ctx, ['quick_entries'], 'quick entry ids must be unique');
    }
    if (!hasUniqueBy(release.quick_entries, (entry) => entry.public_handle)) {
      addCustomIssue(ctx, ['quick_entries'], 'quick entry public handles must be unique');
    }
  });

export type ExperienceQuickEntryV1 = z.infer<typeof ExperienceQuickEntryV1Schema>;
export type ExperienceReleaseV1 = z.infer<typeof ExperienceReleaseV1Schema>;
