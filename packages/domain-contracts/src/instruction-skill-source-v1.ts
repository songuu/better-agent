import { z } from 'zod';
import { UuidV1Schema } from './auth-v1.js';
import {
  hasUniqueBy,
  hasUniqueStrings,
  PostgresTextV1Schema,
  Sha256HexV1Schema,
} from './primitives.js';

const Text = PostgresTextV1Schema.min(1).max(4_096);
const Path = PostgresTextV1Schema.min(1).max(1_024);
const Id = UuidV1Schema.refine((value) => value === value.toLowerCase());
const Hash = Sha256HexV1Schema.length(71);
export const InstructionSkillManifestFileV1Schema = z.strictObject({
  path: Path,
  kind: z.enum(['instruction', 'reference', 'asset', 'script']),
  size_bytes: z.number().int().nonnegative().max(1_048_576),
  content_hash: Hash,
});
export const InstructionSkillFileV1Schema = z.strictObject({
  path: Path,
  chunks_base64: z.array(z.string().min(1).max(65_536)).max(22),
});
export const InstructionSkillSourceV1Schema = z.strictObject({
  schema_version: z.literal('instruction-skill-source/1'),
  resource_id: Id,
  resource_version_id: Id,
  name: Text,
  description: Text,
  parser_version: z.literal('instruction-skill-bundle-parser/1'),
  entry_path: z.literal('SKILL.md'),
  origin: z.strictObject({
    publisher_id: Text,
    source_id: Text,
    revision: Text.refine((value) => !['latest', 'floating_latest'].includes(value.toLowerCase())),
  }),
  manifest: z
    .array(InstructionSkillManifestFileV1Schema)
    .min(1)
    .max(64)
    .refine((values) => hasUniqueBy(values, (value) => value.path)),
  allowed_capability_binding_ids: z.array(Text).max(128).refine(hasUniqueStrings),
  context_budget_tokens: z.number().int().min(1).max(1_000_000),
  data_classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  scripts: z.strictObject({ mode: z.literal('inert'), requires_execution: z.boolean() }),
  signature: z.strictObject({
    algorithm: z.literal('ed25519'),
    key_id: Text,
    signature_base64: z.string().length(88),
  }),
});
export const InstructionSkillSourceCandidateV1Schema = z.strictObject({
  schema_version: z.literal('instruction-skill-source-candidate/1'),
  workspace_id: Id,
  document: InstructionSkillSourceV1Schema,
  files: z
    .array(InstructionSkillFileV1Schema)
    .min(1)
    .max(64)
    .refine((values) => hasUniqueBy(values, (value) => value.path)),
});
export const InstructionSkillTrustedSignersV1Schema = z.strictObject({
  schema_version: z.literal('instruction-skill-trusted-signers/1'),
  workspace_id: Id,
  signers: z
    .array(
      z.strictObject({
        key_id: Text,
        publisher_id: Text,
        source_id: Text,
        allowed_resource_ids: z.array(Id).min(1).max(128).refine(hasUniqueStrings),
        public_key_spki_base64: z.string().min(1).max(128),
      }),
    )
    .max(128)
    .refine((values) => hasUniqueBy(values, (value) => value.key_id)),
});
export type InstructionSkillSourceV1 = z.infer<typeof InstructionSkillSourceV1Schema>;
export type InstructionSkillSourceCandidateV1 = z.infer<
  typeof InstructionSkillSourceCandidateV1Schema
>;
export type InstructionSkillFileV1 = z.infer<typeof InstructionSkillFileV1Schema>;
