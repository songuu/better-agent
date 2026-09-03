import type {
  CapabilityPolicyCeilingV1,
  EffectiveCapabilityPolicyV1,
} from '@better-agent/domain-contracts';

/** Requirement IDs are path-local; ceilings group authority by provider and audience. */
export function effectivePolicyAsCeiling(
  policy: EffectiveCapabilityPolicyV1,
): CapabilityPolicyCeilingV1 {
  const allowances = new Map<string, CapabilityPolicyCeilingV1['credential_allowances'][number]>();
  for (const requirement of policy.credential_requirements) {
    const key = JSON.stringify([requirement.provider_id, requirement.audience]);
    const current = allowances.get(key);
    allowances.set(key, {
      provider_id: requirement.provider_id,
      audience: requirement.audience,
      allowed_scopes: [
        ...new Set([...(current?.allowed_scopes ?? []), ...requirement.required_scopes]),
      ].sort(),
      principal_modes: [
        ...new Set([...(current?.principal_modes ?? []), ...requirement.allowed_principal_modes]),
      ].sort(),
    });
  }
  const { credential_requirements: _requirements, ...shape } = policy;
  return {
    schema_version: 'capability-policy-ceiling/1',
    credential_allowances: [...allowances.values()],
    ...shape,
  };
}
