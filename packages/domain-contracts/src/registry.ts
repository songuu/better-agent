import type { z } from 'zod';

import {
  AgentGateSpecV1Schema,
  AgentReleaseV1Schema,
  AsyncChildPolicyV1Schema,
  CredentialRequirementV1Schema,
  DatabaseBindingConfigV1Schema,
  FlowBindingConfigV1Schema,
  G1JoinChildTerminalOutcomeMapV1Schema,
  KnowledgeBindingConfigV1Schema,
  PluginBindingConfigV1Schema,
  PublicCapabilityHandleV1Schema,
  SkillPackBindingConfigV1Schema,
  SubagentBindingConfigV1Schema,
  SubagentContextProjectionV1Schema,
} from './agent-release-v1.js';
import {
  StrategyCheckpointV1Schema,
  StrategyGateRequestV1Schema,
  StrategyStartV1Schema,
} from './agent-strategy-v1.js';
import {
  CallerPrincipalV1Schema,
  CredentialOperationPolicyV1Schema,
  TenantAuthContextV1Schema,
  VerifiedSubjectAssertionV1Schema,
} from './auth-v1.js';
import {
  CompiledCapabilityClosureV1Schema,
  CompiledGateSpecEntryV1Schema,
  ProductionPromotionGateDecisionV1Schema,
  ProductionPromotionGateKeyV1Schema,
} from './compiled-capability-closure-v1.js';
import { FlowGateSpecV1Schema, FlowIrV1Schema } from './flow-ir-v1.js';

export type DomainContractErrorCode =
  | 'DOMAIN_SCHEMA_VERSION_MISSING'
  | 'DOMAIN_SCHEMA_VERSION_UNKNOWN'
  | 'DOMAIN_SCHEMA_VERSION_DUPLICATE'
  | 'DOMAIN_CONTRACT_INVALID';

export class DomainContractError extends Error {
  readonly code: DomainContractErrorCode;
  readonly schemaVersion: string | undefined;
  readonly validationError: z.ZodError | undefined;

  constructor(
    code: DomainContractErrorCode,
    message: string,
    options: { schemaVersion?: string; validationError?: z.ZodError } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'DomainContractError';
    this.code = code;
    this.schemaVersion = options.schemaVersion;
    this.validationError = options.validationError;
  }
}

export interface VersionedSchemaEntry {
  readonly schemaVersion: string;
  readonly schema: z.ZodType;
}

export class VersionedSchemaRegistry {
  readonly #schemas = new Map<string, z.ZodType>();

  constructor(entries: readonly VersionedSchemaEntry[]) {
    for (const entry of entries) {
      if (this.#schemas.has(entry.schemaVersion)) {
        throw new DomainContractError(
          'DOMAIN_SCHEMA_VERSION_DUPLICATE',
          `schema version ${entry.schemaVersion} is registered more than once`,
          { schemaVersion: entry.schemaVersion },
        );
      }
      this.#schemas.set(entry.schemaVersion, entry.schema);
    }
  }

  versions(): readonly string[] {
    return Object.freeze([...this.#schemas.keys()]);
  }

  schemaFor(schemaVersion: string): z.ZodType {
    const schema = this.#schemas.get(schemaVersion);
    if (schema === undefined) {
      throw new DomainContractError(
        'DOMAIN_SCHEMA_VERSION_UNKNOWN',
        `no validator is registered for ${schemaVersion}`,
        { schemaVersion },
      );
    }
    return schema;
  }

  parse(input: unknown): unknown {
    const schemaVersion = readSchemaVersion(input);
    const schema = this.schemaFor(schemaVersion);
    const result = schema.safeParse(input);
    if (!result.success) {
      throw new DomainContractError(
        'DOMAIN_CONTRACT_INVALID',
        `payload does not satisfy ${schemaVersion}`,
        { schemaVersion, validationError: result.error },
      );
    }
    return result.data;
  }

  safeParse(input: unknown): VersionedSchemaSafeParseResult {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      if (error instanceof DomainContractError) {
        return { success: false, error };
      }
      throw error;
    }
  }
}

export type VersionedSchemaSafeParseResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: DomainContractError };

export function createVersionedSchemaRegistry(
  entries: readonly VersionedSchemaEntry[],
): VersionedSchemaRegistry {
  return new VersionedSchemaRegistry(entries);
}

function readSchemaVersion(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainContractError(
      'DOMAIN_SCHEMA_VERSION_MISSING',
      'a domain contract must be an object with a schema_version discriminator',
    );
  }

  const schemaVersion = Reflect.get(input, 'schema_version');
  if (typeof schemaVersion !== 'string' || schemaVersion.length === 0) {
    throw new DomainContractError(
      'DOMAIN_SCHEMA_VERSION_MISSING',
      'schema_version must be a non-empty string',
    );
  }
  return schemaVersion;
}

export const domainContractSchemaEntries = [
  { schemaVersion: 'caller-principal/1', schema: CallerPrincipalV1Schema },
  { schemaVersion: 'tenant-auth-context/1', schema: TenantAuthContextV1Schema },
  {
    schemaVersion: 'verified-subject-assertion/1',
    schema: VerifiedSubjectAssertionV1Schema,
  },
  {
    schemaVersion: 'credential-operation-policy/1',
    schema: CredentialOperationPolicyV1Schema,
  },
  { schemaVersion: 'agent-release/1', schema: AgentReleaseV1Schema },
  { schemaVersion: 'agent-human-gate/1', schema: AgentGateSpecV1Schema },
  {
    schemaVersion: 'public-capability-handle/1',
    schema: PublicCapabilityHandleV1Schema,
  },
  { schemaVersion: 'credential-requirement/1', schema: CredentialRequirementV1Schema },
  { schemaVersion: 'async-child-policy/1', schema: AsyncChildPolicyV1Schema },
  {
    schemaVersion: 'g1-join-child-terminal-map/1',
    schema: G1JoinChildTerminalOutcomeMapV1Schema,
  },
  { schemaVersion: 'knowledge-binding/1', schema: KnowledgeBindingConfigV1Schema },
  { schemaVersion: 'database-binding/1', schema: DatabaseBindingConfigV1Schema },
  { schemaVersion: 'flow-binding/1', schema: FlowBindingConfigV1Schema },
  { schemaVersion: 'plugin-binding/1', schema: PluginBindingConfigV1Schema },
  { schemaVersion: 'skill-pack-binding/1', schema: SkillPackBindingConfigV1Schema },
  {
    schemaVersion: 'subagent-context-projection/1',
    schema: SubagentContextProjectionV1Schema,
  },
  { schemaVersion: 'subagent-binding/1', schema: SubagentBindingConfigV1Schema },
  { schemaVersion: 'flow-ir/1', schema: FlowIrV1Schema },
  { schemaVersion: 'human-gate/1', schema: FlowGateSpecV1Schema },
  {
    schemaVersion: 'compiled-capability-closure/1',
    schema: CompiledCapabilityClosureV1Schema,
  },
  { schemaVersion: 'compiled-gate-spec/1', schema: CompiledGateSpecEntryV1Schema },
  {
    schemaVersion: 'production-promotion-gate-key/1',
    schema: ProductionPromotionGateKeyV1Schema,
  },
  {
    schemaVersion: 'production-promotion-gate-decision/1',
    schema: ProductionPromotionGateDecisionV1Schema,
  },
  { schemaVersion: 'agent-strategy-start/1', schema: StrategyStartV1Schema },
  { schemaVersion: 'strategy-gate-request/1', schema: StrategyGateRequestV1Schema },
  { schemaVersion: 'agent-strategy-checkpoint/1', schema: StrategyCheckpointV1Schema },
] as const satisfies readonly VersionedSchemaEntry[];

export type DomainContractSchemaVersion =
  (typeof domainContractSchemaEntries)[number]['schemaVersion'];
type DomainContractSchema = (typeof domainContractSchemaEntries)[number]['schema'];
export type DomainContract = z.output<DomainContractSchema>;

export const domainContractSchemaRegistry = createVersionedSchemaRegistry(
  domainContractSchemaEntries,
);

export const domainContractSchemaVersions =
  domainContractSchemaRegistry.versions() as readonly DomainContractSchemaVersion[];

export function parseDomainContract(input: unknown): DomainContract {
  return domainContractSchemaRegistry.parse(input) as DomainContract;
}

export type DomainContractSafeParseResult =
  | { readonly success: true; readonly data: DomainContract }
  | { readonly success: false; readonly error: DomainContractError };

export function safeParseDomainContract(input: unknown): DomainContractSafeParseResult {
  return domainContractSchemaRegistry.safeParse(input) as DomainContractSafeParseResult;
}
