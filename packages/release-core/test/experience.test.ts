import { describe, expect, it } from 'vitest';

import { assembleExperienceRelease, canonicalSha256ExcludingRootKeys } from '../src/index.js';
import {
  agentId,
  hashC,
  makeAgentRelease,
  makeExperienceRelease,
  otherWorkspaceId,
  workspaceId,
} from './fixtures.js';

describe('Experience and Agent public-handle assembly', () => {
  it('derives a stable frozen required-binding projection', () => {
    const assembly = assembleExperienceRelease({
      workspace_id: workspaceId,
      agent_release: makeAgentRelease(),
      experience_release: makeExperienceRelease(),
    });

    expect(assembly).toEqual({
      schema_version: 'prepared-experience-assembly/1',
      workspace_id: workspaceId,
      compatible_agent_id: agentId,
      required_binding_contracts: [
        {
          public_handle: 'summarize',
          binding_id: 'summarize-binding',
          operation_contract_hash: `sha256:${'a'.repeat(64)}`,
          input_schema_hash: makeExperienceRelease().quick_entries[0].input_schema_hash,
        },
      ],
    });
    expect(Object.isFrozen(assembly.required_binding_contracts[0])).toBe(true);
  });

  it('rejects incompatible agents, missing handles and disabled bindings', () => {
    expect(() =>
      assembleExperienceRelease({
        workspace_id: workspaceId,
        agent_release: makeAgentRelease(),
        experience_release: {
          ...makeExperienceRelease(),
          compatible_agent_id: otherWorkspaceId,
        },
      }),
    ).toThrowError(/RELEASE_EXPERIENCE_INCOMPATIBLE/);

    expect(() =>
      assembleExperienceRelease({
        workspace_id: workspaceId,
        agent_release: { ...makeAgentRelease(), public_capability_handles: [] },
        experience_release: makeExperienceRelease(),
      }),
    ).toThrowError(/RELEASE_EXPERIENCE_INCOMPATIBLE/);

    expect(() =>
      assembleExperienceRelease({
        workspace_id: workspaceId,
        agent_release: makeAgentRelease({ enabled: false }),
        experience_release: makeExperienceRelease(),
      }),
    ).toThrowError(/RELEASE_EXPERIENCE_INCOMPATIBLE/);
  });

  it('rejects operation and input-schema hash drift', () => {
    const experience = makeExperienceRelease();
    for (const field of ['operation_contract_hash', 'input_schema_hash'] as const) {
      expect(() =>
        assembleExperienceRelease({
          workspace_id: workspaceId,
          agent_release: makeAgentRelease(),
          experience_release: {
            ...experience,
            quick_entries: [{ ...experience.quick_entries[0], [field]: hashC }],
          },
        }),
      ).toThrowError(/RELEASE_EXPERIENCE_INCOMPATIBLE|RELEASE_HASH_MISMATCH/);
    }
  });

  it('does not let matching Experience and handle hashes hide binding-contract drift', () => {
    const agent = makeAgentRelease();
    const experience = makeExperienceRelease();
    const driftedExperience = {
      ...experience,
      quick_entries: [
        {
          ...experience.quick_entries[0],
          operation_contract_hash: hashC,
        },
      ],
    };
    const rehashedExperience = {
      ...driftedExperience,
      content_hash: canonicalSha256ExcludingRootKeys(driftedExperience, ['content_hash']),
    };

    expect(() =>
      assembleExperienceRelease({
        workspace_id: workspaceId,
        agent_release: {
          ...agent,
          public_capability_handles: [
            { ...agent.public_capability_handles[0], operation_contract_hash: hashC },
          ],
        },
        experience_release: rehashedExperience,
      }),
    ).toThrowError(/RELEASE_EXPERIENCE_INCOMPATIBLE/);
  });
});
