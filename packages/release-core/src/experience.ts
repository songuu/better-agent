import {
  AgentReleaseV1Schema,
  ExperienceReleaseV1Schema,
  UuidV1Schema,
} from '@better-agent/domain-contracts';

import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';

export interface AssembleExperienceReleaseInputV1 {
  readonly workspace_id: string;
  readonly agent_release: unknown;
  readonly experience_release: unknown;
}

export interface PreparedExperienceAssemblyV1 {
  readonly schema_version: 'prepared-experience-assembly/1';
  readonly workspace_id: string;
  readonly compatible_agent_id: string;
  readonly required_binding_contracts: readonly {
    readonly public_handle: string;
    readonly binding_id: string;
    readonly operation_contract_hash: string;
    readonly input_schema_hash: string;
  }[];
}

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_EXPERIENCE_INCOMPATIBLE', path, reason);
}

function bindingOperationContractHash(
  binding: ReturnType<typeof AgentReleaseV1Schema.parse>['capability_bindings'][number],
): string | undefined {
  if (binding.kind === 'plugin' || binding.kind === 'database') {
    return binding.config.operation_contract_hash;
  }
  if (binding.kind === 'knowledge') return binding.config.query_contract_hash;
  return undefined;
}

export function assembleExperienceRelease(
  input: AssembleExperienceReleaseInputV1,
): PreparedExperienceAssemblyV1 {
  if (!UuidV1Schema.safeParse(input.workspace_id).success) {
    throw new ReleaseCoreError(
      'RELEASE_INPUT_INVALID',
      '$.workspace_id',
      'Workspace identity must be a UUID',
    );
  }
  const agentResult = AgentReleaseV1Schema.safeParse(input.agent_release);
  if (!agentResult.success) fail('$.agent_release', 'Agent Release contract is invalid');
  const experienceResult = ExperienceReleaseV1Schema.safeParse(input.experience_release);
  if (!experienceResult.success)
    fail('$.experience_release', 'Experience Release contract is invalid');

  const agent = agentResult.data;
  const experience = experienceResult.data;
  if (agent.agent_id !== experience.compatible_agent_id) {
    fail('$.experience_release.compatible_agent_id', 'Experience targets a different stable Agent');
  }

  const expectedContentHash = canonicalSha256ExcludingRootKeys(experience, ['content_hash']);
  if (experience.content_hash !== expectedContentHash) {
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.experience_release.content_hash',
      'Experience content hash does not match its canonical content',
    );
  }

  const handles = new Map(
    agent.public_capability_handles.map((handle) => [handle.public_handle, handle]),
  );
  const bindings = new Map(
    agent.capability_bindings.map((binding) => [binding.binding_id, binding]),
  );
  const requiredBindingContracts = experience.quick_entries.map((entry, index) => {
    const handle = handles.get(entry.public_handle);
    if (handle === undefined) {
      fail(
        `$.experience_release.quick_entries[${index}].public_handle`,
        'Experience quick entry references an unknown public handle',
      );
    }
    const binding = bindings.get(handle.binding_id);
    if (binding === undefined || !binding.enabled) {
      fail(
        `$.agent_release.public_capability_handles.${handle.public_handle}`,
        'Experience public handle must resolve to an enabled capability binding',
      );
    }
    const bindingOperationHash = bindingOperationContractHash(binding);
    if (bindingOperationHash === undefined) {
      fail(
        `$.agent_release.capability_bindings.${binding.binding_id}`,
        'Experience shortcuts require a binding kind with one explicit operation contract',
      );
    }
    if (handle.operation_contract_hash !== bindingOperationHash) {
      fail(
        `$.agent_release.public_capability_handles.${handle.public_handle}.operation_contract_hash`,
        'Agent public handle operation hash differs from its capability binding',
      );
    }
    if (handle.input_schema_hash !== canonicalSha256(binding.input_schema)) {
      fail(
        `$.agent_release.public_capability_handles.${handle.public_handle}.input_schema_hash`,
        'Agent public handle input hash differs from its capability binding input schema',
      );
    }
    if (handle.operation_contract_hash !== entry.operation_contract_hash) {
      fail(
        `$.experience_release.quick_entries[${index}].operation_contract_hash`,
        'Experience operation contract hash differs from the Agent public handle',
      );
    }
    if (handle.input_schema_hash !== entry.input_schema_hash) {
      fail(
        `$.experience_release.quick_entries[${index}].input_schema_hash`,
        'Experience input schema hash differs from the Agent public handle',
      );
    }
    return {
      public_handle: entry.public_handle,
      binding_id: handle.binding_id,
      operation_contract_hash: entry.operation_contract_hash,
      input_schema_hash: entry.input_schema_hash,
    };
  });
  requiredBindingContracts.sort((left, right) =>
    compareCanonicalStrings(left.public_handle, right.public_handle),
  );

  return deepFreezeJson({
    schema_version: 'prepared-experience-assembly/1',
    workspace_id: input.workspace_id,
    compatible_agent_id: experience.compatible_agent_id,
    required_binding_contracts: requiredBindingContracts,
  });
}
