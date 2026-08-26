import {
  AgentDeploymentCredentialMappingV1Schema,
  CredentialRequirementV1Schema,
  type CredentialRequirementV1,
  FlowDeploymentCredentialMappingV1Schema,
} from '@better-agent/domain-contracts';

import { assertUuid, compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';

export type DeploymentKindV1 = 'agent' | 'flow';

export interface PrepareCredentialMappingsInputV1 {
  readonly deployment_kind: DeploymentKindV1;
  readonly workspace_id: string;
  readonly requirements: readonly unknown[];
  readonly mappings: readonly unknown[];
}

export interface PreparedCredentialMappingsV1 {
  readonly schema_version: 'prepared-credential-mappings/1';
  readonly deployment_kind: DeploymentKindV1;
  readonly mappings: readonly Record<string, unknown>[];
  readonly credential_mapping_hash: `sha256:${string}`;
}

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_CREDENTIAL_MAPPING_INVALID', path, reason);
}

function normalizeStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareCanonicalStrings);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizeStrings(left);
  const normalizedRight = normalizeStrings(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

export function extractAgentCredentialRequirements(agentRelease: {
  readonly capability_bindings: readonly {
    readonly enabled: boolean;
    readonly credential_requirement?: CredentialRequirementV1 | undefined;
  }[];
}): readonly CredentialRequirementV1[] {
  return agentRelease.capability_bindings.flatMap((binding) =>
    binding.enabled && binding.credential_requirement !== undefined
      ? [binding.credential_requirement]
      : [],
  );
}

export function calculateCredentialMappingHash(
  mapping: Record<string, unknown>,
): `sha256:${string}` {
  const normalized = {
    ...mapping,
    allowed_scopes: Array.isArray(mapping.allowed_scopes)
      ? normalizeStrings(
          mapping.allowed_scopes.filter((scope): scope is string => typeof scope === 'string'),
        )
      : mapping.allowed_scopes,
  };
  return canonicalSha256ExcludingRootKeys(normalized, ['mapping_hash']);
}

export function calculateCredentialMappingSetHash(
  deploymentKind: DeploymentKindV1,
  mappings: readonly Record<string, unknown>[],
): `sha256:${string}` {
  return canonicalSha256({
    schema_version: 'deployment-credential-mapping-set/1',
    deployment_kind: deploymentKind,
    mappings,
  });
}

export function prepareCredentialMappings(
  input: PrepareCredentialMappingsInputV1,
): PreparedCredentialMappingsV1 {
  if (input.deployment_kind !== 'agent' && input.deployment_kind !== 'flow') {
    fail('$.deployment_kind', 'Deployment kind must be agent or flow');
  }
  assertUuid(input.workspace_id, '$.workspace_id');

  const requirements = input.requirements.map((value, index) => {
    const result = CredentialRequirementV1Schema.safeParse(value);
    if (!result.success) fail(`$.requirements[${index}]`, 'credential requirement is invalid');
    return result.data;
  });
  const requirementById = new Map<string, CredentialRequirementV1>();
  for (const [index, requirement] of requirements.entries()) {
    if (requirementById.has(requirement.requirement_id)) {
      fail(`$.requirements[${index}].requirement_id`, 'credential requirement ids must be unique');
    }
    requirementById.set(requirement.requirement_id, requirement);
  }

  const mappingSchema =
    input.deployment_kind === 'agent'
      ? AgentDeploymentCredentialMappingV1Schema
      : FlowDeploymentCredentialMappingV1Schema;
  const mappingByRequirement = new Map<string, Record<string, unknown>>();
  for (const [index, value] of input.mappings.entries()) {
    const result = mappingSchema.safeParse(value);
    if (!result.success) {
      fail(
        `$.mappings[${index}]`,
        'credential mapping does not match its closed Deployment branch',
      );
    }
    const mapping = result.data as Record<string, unknown> & {
      requirement_id: string;
      provider_id: string;
      audience: string;
      allowed_scopes: string[];
      principal_mode: string;
      mapping_hash: string;
      credential_policy: { workspace_id: string; policy_id: string };
      team_credential_policy_id?: string;
    };
    if (mappingByRequirement.has(mapping.requirement_id)) {
      fail(`$.mappings[${index}].requirement_id`, 'each requirement must have exactly one mapping');
    }
    const requirement = requirementById.get(mapping.requirement_id);
    if (requirement === undefined) {
      fail(`$.mappings[${index}].requirement_id`, 'mapping does not correspond to a requirement');
    }
    if (mapping.provider_id !== requirement.provider_id) {
      fail(`$.mappings[${index}].provider_id`, 'mapping provider differs from its requirement');
    }
    if (mapping.audience !== requirement.audience) {
      fail(`$.mappings[${index}].audience`, 'mapping audience differs from its requirement');
    }
    if (!sameStrings(mapping.allowed_scopes, requirement.required_scopes)) {
      fail(
        `$.mappings[${index}].allowed_scopes`,
        'G0 mapping scopes must equal the required scope set exactly',
      );
    }
    if (!requirement.allowed_principal_modes.includes(mapping.principal_mode as never)) {
      fail(
        `$.mappings[${index}].principal_mode`,
        'mapping principal mode is not allowed by the requirement',
      );
    }
    if (mapping.credential_policy.workspace_id !== input.workspace_id) {
      fail(
        `$.mappings[${index}].credential_policy.workspace_id`,
        'credential policy must use the Deployment Workspace',
      );
    }
    if (
      mapping.principal_mode === 'team_shared' &&
      mapping.team_credential_policy_id !== mapping.credential_policy.policy_id
    ) {
      fail(
        `$.mappings[${index}].team_credential_policy_id`,
        'team credential policy identity must match its immutable policy pin',
      );
    }

    const normalized = {
      ...mapping,
      allowed_scopes: normalizeStrings(mapping.allowed_scopes),
    };
    const expectedHash = calculateCredentialMappingHash(normalized);
    if (mapping.mapping_hash !== expectedHash) {
      throw new ReleaseCoreError(
        'RELEASE_HASH_MISMATCH',
        `$.mappings[${index}].mapping_hash`,
        'credential mapping hash does not match its canonical mapping',
      );
    }
    mappingByRequirement.set(mapping.requirement_id, normalized);
  }

  if (mappingByRequirement.size !== requirementById.size) {
    fail('$.mappings', 'every credential requirement must have exactly one mapping');
  }
  const mappings = [...mappingByRequirement.values()].sort((left, right) =>
    compareCanonicalStrings(String(left.requirement_id), String(right.requirement_id)),
  );
  return deepFreezeJson({
    schema_version: 'prepared-credential-mappings/1',
    deployment_kind: input.deployment_kind,
    mappings,
    credential_mapping_hash: calculateCredentialMappingSetHash(input.deployment_kind, mappings),
  });
}
