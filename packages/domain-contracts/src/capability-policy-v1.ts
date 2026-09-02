import { z } from 'zod';

import { CredentialRequirementV1Schema } from './agent-release-v1.js';
import {
  hasUniqueBy,
  hasUniqueStrings,
  PostgresTextV1Schema,
  Sha256HexV1Schema,
} from './primitives.js';

const Text = PostgresTextV1Schema.min(1).max(4_096);
const Hash = Sha256HexV1Schema.length(71);
const Limit = z.number().int().nonnegative().safe();
const Classification = z.enum(['public', 'internal', 'confidential', 'restricted']);
const SideEffect = z.enum(['safe', 'requires_key', 'unsafe']);
const CredentialMode = z.enum(['caller_delegated', 'service_principal', 'team_shared']);
const PrincipalMode = z.enum(['caller_delegated', 'service_principal', 'team_shared', 'none']);
const PrincipalModes = z.array(PrincipalMode).max(4).refine(hasUniqueStrings);
const OperationHashes = z.array(Hash).max(128).refine(hasUniqueStrings);

function canonicalDnsHost(value: string): boolean {
  if (value.length > 253 || !/[a-z]/u.test(value.split('.').at(-1) ?? '')) return false;
  if (!value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
    return false;
  try {
    // Also rejects the WHATWG numeric/hex IP aliases which superficially look like DNS labels.
    return new URL(`https://${value}`).hostname === value;
  } catch {
    return false;
  }
}

const literalPathCharacter = /^[A-Za-z0-9._~!$&'()*+,;=:@-]$/u;
function canonicalPath(value: string): boolean {
  if (value === '/') return true;
  if (value.length > 4_096 || !value.startsWith('/')) return false;
  try {
    return value
      .slice(1)
      .split('/')
      .every((segment) => {
        if (segment.length === 0) return false;
        const decoded = decodeURIComponent(segment);
        if (decoded === '.' || decoded === '..') return false;
        const characters = [...decoded];
        if (characters.some((character) => /[\p{Cc}\\/%?#]/u.test(character))) return false;
        const canonical = characters
          .map((character) =>
            literalPathCharacter.test(character) ? character : encodeURIComponent(character),
          )
          .join('');
        return segment === canonical;
      });
  } catch {
    return false;
  }
}

export const CanonicalEgressRuleV1Schema = z
  .strictObject({
    schema_version: z.literal('canonical-egress-rule/1'),
    network_policy: z.strictObject({
      policy_id: Text,
      policy_hash: Hash,
      address_class: z.enum(['public_only', 'approved_internal']),
    }),
    scheme: z.enum(['https', 'http']),
    host: z.strictObject({
      match: z.enum(['exact', 'subdomains']),
      name: Text.refine(
        canonicalDnsHost,
        'expected a canonical DNS host, not an IP literal or URL',
      ),
    }),
    port: z.number().int().min(1).max(65_535),
    path: z.strictObject({
      match: z.enum(['exact', 'subtree']),
      value: Text.refine(canonicalPath, 'expected a canonical absolute URI path'),
    }),
    methods: z
      .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']))
      .min(1)
      .max(7)
      .refine(hasUniqueStrings),
    dns_resolution: z.literal('revalidate_each_connection'),
    redirects: z
      .strictObject({
        mode: z.enum(['deny', 'same_origin', 'approved_targets']),
        max_hops: z.number().int().min(0).max(10),
        strip_cross_origin_credentials: z.literal(true),
      })
      .refine(
        (value) => (value.mode === 'deny') === (value.max_hops === 0),
        'zero redirect hops must use deny and nonzero hops must not',
      ),
  })
  .refine(
    (value) =>
      value.network_policy.address_class !== 'public_only' ||
      (value.scheme === 'https' && value.host.name.includes('.')),
    'public egress requires HTTPS and a fully qualified DNS host',
  );

export const CapabilityBudgetV1Schema = z.strictObject({
  schema_version: z.literal('capability-budget/1'),
  amount_credits: z
    .string()
    .refine(
      (value) =>
        value.length <= 19 &&
        /^(?:0|[1-9][0-9]*)(?![\s\S])/u.test(value) &&
        BigInt(value) <= 9_223_372_036_854_775_807n,
      'expected canonical non-negative PostgreSQL bigint credits',
    ),
  input_tokens: Limit,
  output_tokens: Limit,
  total_tokens: Limit,
  duration_ms: Limit,
});

const CredentialAllowance = z.strictObject({
  provider_id: Text,
  audience: Text,
  allowed_scopes: z.array(Text).max(128).refine(hasUniqueStrings),
  principal_modes: z.array(CredentialMode).max(3).refine(hasUniqueStrings),
});
const Requirements = z
  .array(
    CredentialRequirementV1Schema.extend({
      requirement_id: Text,
      provider_id: Text,
      audience: Text,
      required_scopes: z.array(Text).min(1).max(128).refine(hasUniqueStrings),
      allowed_principal_modes: z.array(CredentialMode).min(1).max(3).refine(hasUniqueStrings),
    }),
  )
  .max(32)
  .refine(
    (values) => hasUniqueBy(values, (value) => value.requirement_id),
    'credential requirement ids must be unique',
  );

const PolicyShape = {
  principal_modes: PrincipalModes,
  egress: z.array(CanonicalEgressRuleV1Schema).max(32),
  readable_data_classification_ceiling: Classification,
  output_data_classification: Classification,
  side_effect: z.strictObject({
    maximum_class: SideEffect,
    approval: z.enum(['none', 'required']),
  }),
  operation_contract_hashes: OperationHashes,
  max_calls: Limit,
  max_depth: Limit,
  max_parallelism: Limit,
  budget: CapabilityBudgetV1Schema,
};

export const CapabilityPolicyCeilingV1Schema = z.strictObject({
  schema_version: z.literal('capability-policy-ceiling/1'),
  credential_allowances: z
    .array(CredentialAllowance)
    .max(32)
    .refine(
      (values) =>
        hasUniqueBy(values, (value) => JSON.stringify([value.provider_id, value.audience])),
      'credential provider/audience keys must be unique',
    ),
  ...PolicyShape,
});

export const CapabilityRequirementsV1Schema = z.strictObject({
  schema_version: z.literal('capability-requirements/1'),
  credential_requirements: Requirements,
  principal_modes: PrincipalModes.min(1),
  egress: z.array(CanonicalEgressRuleV1Schema).max(32),
  readable_data_classification: Classification,
  output_data_classification: Classification,
  side_effect_class: SideEffect,
  approval_required: z.boolean(),
  operation_contract_hashes: OperationHashes,
  minimum_limits: z.strictObject({
    calls: Limit,
    depth: Limit,
    parallelism: Limit,
    budget: CapabilityBudgetV1Schema,
  }),
});

export const EffectiveCapabilityPolicyV1Schema = z.strictObject({
  credential_requirements: Requirements,
  ...PolicyShape,
});

export type CanonicalEgressRuleV1 = z.infer<typeof CanonicalEgressRuleV1Schema>;
export type CapabilityBudgetV1 = z.infer<typeof CapabilityBudgetV1Schema>;
export type CapabilityPolicyCeilingV1 = z.infer<typeof CapabilityPolicyCeilingV1Schema>;
export type CapabilityRequirementsV1 = z.infer<typeof CapabilityRequirementsV1Schema>;
export type EffectiveCapabilityPolicyV1 = z.infer<typeof EffectiveCapabilityPolicyV1Schema>;
