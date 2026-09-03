import { z } from 'zod';

import { OperationContractPinV1Schema } from './compiled-capability-closure-v1.js';
import { JsonObjectSchema } from './primitives.js';

/** Source bytes for an operation declaration; not a target release or authorization grant. */
export const OperationContractSourceV1Schema = OperationContractPinV1Schema.omit({
  input_schema_hash: true,
  output_schema_hash: true,
  contract_hash: true,
})
  .extend({
    schema_version: z.literal('operation-contract-source/1'),
    input_schema: JsonObjectSchema,
    output_schema: JsonObjectSchema.optional(),
  })
  .refine(
    (source) => source.side_effect_class !== 'requires_key' || source.operation_key_required,
    'requires_key operations must require an operation key',
  )
  .refine(
    (source) => source.operation_kind !== 'knowledge_query' || source.side_effect_class === 'safe',
    'knowledge queries cannot declare a write side effect',
  );

export type OperationContractSourceV1 = z.infer<typeof OperationContractSourceV1Schema>;
export type OperationContractPinV1 = z.infer<typeof OperationContractPinV1Schema>;
