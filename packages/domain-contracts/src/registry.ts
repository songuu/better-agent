import type { z } from 'zod';

import {
  AgentDeploymentActivePointerV1Schema,
  AgentDeploymentCredentialMappingV1Schema,
  AgentDeploymentEntryAdmissionSnapshotV1Schema,
  AgentDeploymentEntryGrantV1Schema,
  AgentDeploymentRevisionV1Schema,
  AgentDeploymentSecurityStateV1Schema,
  AgentDeploymentV1Schema,
} from './agent-deployment-v1.js';
import {
  AgentExecutableSourceV1Schema,
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
import { AgentStrategyReleaseV1Schema } from './agent-strategy-release-v1.js';
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
  BillingIntentV1Schema,
  CreditLedgerEntryV1Schema,
  CreditReservationV1Schema,
  RunBillingStateV1Schema,
} from './billing-v1.js';
import {
  BillingIntentV2Schema,
  CreditLedgerEntryV2Schema,
  RunCancellationReleaseAuthorityV1Schema,
} from './billing-v2.js';
import { BrowserSessionMetadataV1Schema } from './browser-session-v1.js';
import {
  CanonicalEgressRuleV1Schema,
  CapabilityBudgetV1Schema,
  CapabilityPolicyCeilingV1Schema,
  CapabilityRequirementsV1Schema,
} from './capability-policy-v1.js';
import {
  CompiledCapabilityClosureV1Schema,
  CompiledGateSpecEntryV1Schema,
  ProductionPromotionGateDecisionV1Schema,
  ProductionPromotionGateKeyV1Schema,
} from './compiled-capability-closure-v1.js';
import {
  ConversationPrincipalV1Schema,
  ConversationStateCasV1Schema,
  ConversationV1Schema,
} from './conversation-v1.js';
import { ImmutableDeploymentPolicyPinV1Schema } from './deployment-common-v1.js';
import { ExperienceReleaseV1Schema } from './experience-release-v1.js';
import {
  FlowDeploymentActivePointerV1Schema,
  FlowDeploymentCredentialMappingV1Schema,
  FlowDeploymentEntryAdmissionSnapshotV1Schema,
  FlowDeploymentEntryGrantV1Schema,
  FlowDeploymentRevisionV1Schema,
  FlowDeploymentSecurityStateV1Schema,
  FlowDeploymentV1Schema,
} from './flow-deployment-v1.js';
import { FlowGateSpecV1Schema, FlowIrV1Schema } from './flow-ir-v1.js';
import { HumanGateResumeIntentV1Schema, HumanGateV1Schema } from './human-gate-v1.js';
import {
  ArchiveApprovalReceiptV1Schema,
  ArchiveManifestV1Schema,
  ArchiveVerificationReceiptV1Schema,
  RunArchiveEvidenceV1Schema,
  RunRetentionHorizonsV1Schema,
  RunRetentionPurgeReceiptV1Schema,
} from './retention-v1.js';
import {
  OutboxMessageSetV1Schema,
  OutboxMessageV1Schema,
  RunEventV1Schema,
} from './run-event-outbox-v1.js';
import {
  RunAttemptLeaseAuthorityV1Schema,
  RunAttemptLeaseStateV1Schema,
  RunDispatchRetirementReceiptV1Schema,
  RunExecutionCheckpointV1Schema,
  RunRecoveryHoldIntentV1Schema,
  RunRecoveryTicketDispositionV1Schema,
  RunRecoveryTicketV1Schema,
  RunRetryEffectEnvelopeV1Schema,
  RunSideEffectReceiptV1Schema,
  RunTerminationIntentV1Schema,
  RunTerminationIntentRecordResultV1Schema,
  RunUsageAttributionV1Schema,
  RunUsageAttributionRecordResultV1Schema,
} from './run-execution-v1.js';
import {
  RunIdempotencyNamespaceV1Schema,
  RunIdempotencyRequestV1Schema,
} from './run-idempotency-v1.js';
import { RunAcceptanceV1Schema, RunSnapshotV1Schema, RunTargetV1Schema } from './run-v1.js';

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
  { schemaVersion: 'agent-executable-source/1', schema: AgentExecutableSourceV1Schema },
  { schemaVersion: 'agent-strategy-release/1', schema: AgentStrategyReleaseV1Schema },
  { schemaVersion: 'experience-release/1', schema: ExperienceReleaseV1Schema },
  { schemaVersion: 'deployment-policy-pin/1', schema: ImmutableDeploymentPolicyPinV1Schema },
  { schemaVersion: 'agent-deployment-stable/1', schema: AgentDeploymentV1Schema },
  { schemaVersion: 'agent-deployment/1', schema: AgentDeploymentRevisionV1Schema },
  {
    schemaVersion: 'agent-deployment-credential-mapping/1',
    schema: AgentDeploymentCredentialMappingV1Schema,
  },
  {
    schemaVersion: 'agent-deployment-entry-grant/1',
    schema: AgentDeploymentEntryGrantV1Schema,
  },
  {
    schemaVersion: 'agent-deployment-active-pointer/1',
    schema: AgentDeploymentActivePointerV1Schema,
  },
  {
    schemaVersion: 'agent-deployment-security-state/1',
    schema: AgentDeploymentSecurityStateV1Schema,
  },
  {
    schemaVersion: 'agent-deployment-entry-admission-snapshot/1',
    schema: AgentDeploymentEntryAdmissionSnapshotV1Schema,
  },
  { schemaVersion: 'flow-deployment-stable/1', schema: FlowDeploymentV1Schema },
  { schemaVersion: 'flow-deployment/1', schema: FlowDeploymentRevisionV1Schema },
  {
    schemaVersion: 'flow-deployment-credential-mapping/1',
    schema: FlowDeploymentCredentialMappingV1Schema,
  },
  {
    schemaVersion: 'flow-deployment-entry-grant/1',
    schema: FlowDeploymentEntryGrantV1Schema,
  },
  {
    schemaVersion: 'flow-deployment-active-pointer/1',
    schema: FlowDeploymentActivePointerV1Schema,
  },
  {
    schemaVersion: 'flow-deployment-security-state/1',
    schema: FlowDeploymentSecurityStateV1Schema,
  },
  {
    schemaVersion: 'flow-deployment-entry-admission-snapshot/1',
    schema: FlowDeploymentEntryAdmissionSnapshotV1Schema,
  },
  { schemaVersion: 'browser-session-metadata/1', schema: BrowserSessionMetadataV1Schema },
  { schemaVersion: 'conversation-principal/1', schema: ConversationPrincipalV1Schema },
  { schemaVersion: 'conversation/1', schema: ConversationV1Schema },
  { schemaVersion: 'conversation-state-cas/1', schema: ConversationStateCasV1Schema },
  { schemaVersion: 'run-target/1', schema: RunTargetV1Schema },
  { schemaVersion: 'run-acceptance/1', schema: RunAcceptanceV1Schema },
  { schemaVersion: 'run-snapshot/1', schema: RunSnapshotV1Schema },
  {
    schemaVersion: 'run-idempotency-namespace/1',
    schema: RunIdempotencyNamespaceV1Schema,
  },
  {
    schemaVersion: 'run-idempotency-request/1',
    schema: RunIdempotencyRequestV1Schema,
  },
  { schemaVersion: 'run-event/1', schema: RunEventV1Schema },
  { schemaVersion: 'run-outbox-message/1', schema: OutboxMessageV1Schema },
  { schemaVersion: 'run-outbox-message-set/1', schema: OutboxMessageSetV1Schema },
  { schemaVersion: 'run-attempt-lease-state/1', schema: RunAttemptLeaseStateV1Schema },
  { schemaVersion: 'run-attempt-lease-authority/1', schema: RunAttemptLeaseAuthorityV1Schema },
  { schemaVersion: 'run-retry-effect-envelope/1', schema: RunRetryEffectEnvelopeV1Schema },
  { schemaVersion: 'run-side-effect-receipt/1', schema: RunSideEffectReceiptV1Schema },
  { schemaVersion: 'run-execution-checkpoint/1', schema: RunExecutionCheckpointV1Schema },
  { schemaVersion: 'run-usage-attribution/1', schema: RunUsageAttributionV1Schema },
  { schemaVersion: 'run-termination-intent/1', schema: RunTerminationIntentV1Schema },
  {
    schemaVersion: 'run-usage-attribution-record-result/1',
    schema: RunUsageAttributionRecordResultV1Schema,
  },
  {
    schemaVersion: 'run-termination-intent-record-result/1',
    schema: RunTerminationIntentRecordResultV1Schema,
  },
  { schemaVersion: 'run-recovery-ticket/1', schema: RunRecoveryTicketV1Schema },
  {
    schemaVersion: 'run-recovery-ticket-disposition/1',
    schema: RunRecoveryTicketDispositionV1Schema,
  },
  { schemaVersion: 'run-recovery-hold-intent/1', schema: RunRecoveryHoldIntentV1Schema },
  {
    schemaVersion: 'run-dispatch-retirement-receipt/1',
    schema: RunDispatchRetirementReceiptV1Schema,
  },
  { schemaVersion: 'human-gate-instance/1', schema: HumanGateV1Schema },
  { schemaVersion: 'human-gate-resume-intent/1', schema: HumanGateResumeIntentV1Schema },
  { schemaVersion: 'credit-reservation/1', schema: CreditReservationV1Schema },
  { schemaVersion: 'credit-ledger-entry/1', schema: CreditLedgerEntryV1Schema },
  { schemaVersion: 'run-billing-state/1', schema: RunBillingStateV1Schema },
  { schemaVersion: 'billing-intent/1', schema: BillingIntentV1Schema },
  {
    schemaVersion: 'run-cancellation-release-authority/1',
    schema: RunCancellationReleaseAuthorityV1Schema,
  },
  { schemaVersion: 'billing-intent/2', schema: BillingIntentV2Schema },
  { schemaVersion: 'credit-ledger-entry/2', schema: CreditLedgerEntryV2Schema },
  { schemaVersion: 'run-archive-manifest/1', schema: ArchiveManifestV1Schema },
  {
    schemaVersion: 'run-archive-verification-receipt/1',
    schema: ArchiveVerificationReceiptV1Schema,
  },
  {
    schemaVersion: 'run-archive-approval-receipt/1',
    schema: ArchiveApprovalReceiptV1Schema,
  },
  { schemaVersion: 'run-archive-evidence/1', schema: RunArchiveEvidenceV1Schema },
  { schemaVersion: 'run-retention-horizons/1', schema: RunRetentionHorizonsV1Schema },
  {
    schemaVersion: 'run-retention-purge-receipt/1',
    schema: RunRetentionPurgeReceiptV1Schema,
  },
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
    schemaVersion: 'canonical-egress-rule/1',
    schema: CanonicalEgressRuleV1Schema,
  },
  {
    schemaVersion: 'capability-budget/1',
    schema: CapabilityBudgetV1Schema,
  },
  {
    schemaVersion: 'capability-policy-ceiling/1',
    schema: CapabilityPolicyCeilingV1Schema,
  },
  {
    schemaVersion: 'capability-requirements/1',
    schema: CapabilityRequirementsV1Schema,
  },
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
