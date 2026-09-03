import { z } from 'zod';
import { CapabilityBindingV1Schema } from './agent-release-v1.js';
import { UuidV1Schema } from './auth-v1.js';
import { OperationContractSourceV1Schema } from './operation-contract-source-v1.js';
import { hasUniqueBy, JsonObjectSchema, PostgresTextV1Schema } from './primitives.js';

const Id = UuidV1Schema.refine((value) => value === value.toLowerCase());
const Text = PostgresTextV1Schema.min(1).max(4_096);

export const SkillPackSourceV1Schema = z.strictObject({
  schema_version: z.literal('skill-pack-source/1'),
  resource_id: Id,
  resource_version_id: Id,
  manual: z.strictObject({ description: Text, input_description: Text.optional() }),
  input_schema: JsonObjectSchema,
  output_schema: JsonObjectSchema.optional(),
  member_bindings: z
    .array(CapabilityBindingV1Schema)
    .min(1)
    .max(128)
    .refine((members) => hasUniqueBy(members, (member) => member.binding_id)),
  exposures: z
    .array(
      z.strictObject({
        exposed_operation_id: Text,
        member_binding_id: Text,
        member_operation_id: Text,
        operation: OperationContractSourceV1Schema,
      }),
    )
    .min(1)
    .max(128)
    .refine((exposures) => hasUniqueBy(exposures, (exposure) => exposure.exposed_operation_id)),
});
export const SkillPackSourceCandidateV1Schema = z.strictObject({
  schema_version: z.literal('skill-pack-source-candidate/1'),
  workspace_id: Id,
  document: SkillPackSourceV1Schema,
});
export type SkillPackSourceV1 = z.infer<typeof SkillPackSourceV1Schema>;
