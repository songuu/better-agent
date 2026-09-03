import { z } from 'zod';

import { PublishedResourcePinV1Schema, ForcedExecutionV1Schema } from './agent-release-v1.js';
import {
  AgentDeploymentEntryAdmissionSnapshotV1Schema,
  AgentDeploymentRevisionV1Schema,
} from './agent-deployment-v1.js';
import {
  CapabilityPolicyCeilingV1Schema,
  EffectiveCapabilityPolicyV1Schema,
} from './capability-policy-v1.js';
import {
  CanonicalBindingPathV1Schema,
  ClosureResourceNodeIdV1Schema,
  hasUniqueBy,
  hasUniqueStrings,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  Sha256HexV1Schema,
} from './primitives.js';
import {
  CompiledCapabilityClosureV1Schema,
  CompiledGateSpecEntryV1Schema,
} from './compiled-capability-closure-v1.js';
import {
  FlowDeploymentEntryAdmissionSnapshotV1Schema,
  FlowDeploymentRevisionV1Schema,
} from './flow-deployment-v1.js';

export const AuthorizationEpochSourceV1Schema = z.strictObject({
  source_kind: z.enum([
    'workspace_authorization',
    'agent_deployment_security',
    'flow_deployment_security',
    'agent_entry_grant',
    'flow_entry_grant',
    'credential',
    'browser_session',
    'principal_session',
    'published_release_state',
    'published_release_grant',
    'capability_release_state',
    'capability_release_grant',
    'credential_policy',
    'permission_policy',
    'permission_callback',
    'service_principal',
    'system_release_visibility',
    'system_release_grant',
  ]),
  source_id: NonEmptyStringSchema,
  source_subkey: z.string().max(4_096),
  observed_epoch: NonNegativeIntegerSchema,
});

export const CanonicalAuthorizationEpochSourcesV1Schema = z
  .array(AuthorizationEpochSourceV1Schema)
  .min(1)
  .max(8_192)
  .refine(
    (values) =>
      hasUniqueBy(values, (value) =>
        JSON.stringify([value.source_kind, value.source_id, value.source_subkey]),
      ),
    'authorization epoch source identities must be unique',
  )
  .refine(
    (values) =>
      values.every(
        (value, index) =>
          index === 0 ||
          JSON.stringify([
            values[index - 1]?.source_kind,
            values[index - 1]?.source_id,
            values[index - 1]?.source_subkey,
          ]) < JSON.stringify([value.source_kind, value.source_id, value.source_subkey]),
      ),
    'authorization epoch sources must be canonically sorted',
  );

export const AdmissionAuthorizationDecisionV1Schema = z.strictObject({
  schema_version: z.literal('admission-authorization-decision/1'),
  decision_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  deployment_kind: z.enum(['agent', 'flow']),
  deployment_id: NonEmptyStringSchema,
  deployment_revision_id: NonEmptyStringSchema,
  deployment_revision_contract_hash: Sha256HexV1Schema,
  capability_closure_hash: Sha256HexV1Schema,
  admission_snapshot_hash: Sha256HexV1Schema,
  admission_activation_epoch: NonNegativeIntegerSchema,
  expires_at: z.iso.datetime({ offset: true }),
  epoch_sources: CanonicalAuthorizationEpochSourcesV1Schema,
  allowed_bindings: z
    .array(
      z.strictObject({
        binding_path: CanonicalBindingPathV1Schema,
        policy_ceiling: CapabilityPolicyCeilingV1Schema,
        credential_bindings: z
          .array(
            z.strictObject({
              requirement_id: NonEmptyStringSchema,
              mapping_hash: Sha256HexV1Schema,
              principal_mode: z.enum(['caller_delegated', 'service_principal', 'team_shared']),
              credential_subject_id: NonEmptyStringSchema,
              credential_id: NonEmptyStringSchema,
              credential_version_id: NonEmptyStringSchema,
              provider_id: NonEmptyStringSchema,
              audience: NonEmptyStringSchema,
              granted_scopes: z
                .array(NonEmptyStringSchema)
                .max(128)
                .refine(hasUniqueStrings)
                .refine((values) =>
                  values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value),
                ),
              credential_handle_hash: Sha256HexV1Schema,
              material_fingerprint_hash: Sha256HexV1Schema,
              epoch_source: AuthorizationEpochSourceV1Schema.extend({
                source_kind: z.literal('credential'),
                source_subkey: Sha256HexV1Schema,
              }),
            }),
          )
          .max(32)
          .refine(
            (values) => hasUniqueBy(values, (value) => value.requirement_id),
            'credential bindings must be unique by requirement',
          )
          .refine(
            (values) =>
              values.every(
                (value, index) =>
                  index === 0 || (values[index - 1]?.requirement_id ?? '') < value.requirement_id,
              ),
            'credential bindings must be sorted',
          ),
      }),
    )
    .max(8_192)
    .refine(
      (values) => hasUniqueBy(values, (value) => value.binding_path),
      'allowed binding paths must be unique',
    )
    .refine(
      (values) =>
        values.every(
          (value, index) =>
            index === 0 || (values[index - 1]?.binding_path ?? '') < value.binding_path,
        ),
      'allowed binding paths must be canonically sorted',
    ),
  decision_hash: Sha256HexV1Schema,
});

export const ResolveExecutionPlanInputV1Schema = z.strictObject({
  executable_source: z.unknown(),
  closure: CompiledCapabilityClosureV1Schema,
  deployment_revision: z.union([AgentDeploymentRevisionV1Schema, FlowDeploymentRevisionV1Schema]),
  admission_snapshot: z.union([
    AgentDeploymentEntryAdmissionSnapshotV1Schema,
    FlowDeploymentEntryAdmissionSnapshotV1Schema,
  ]),
  authorization_decision: AdmissionAuthorizationDecisionV1Schema,
  expected_admission_epochs: z.strictObject({
    admission_activation_epoch: NonNegativeIntegerSchema,
    observed_revoke_epoch: NonNegativeIntegerSchema,
  }),
  admission_clock: z.strictObject({
    source: z.literal('database_transaction_clock'),
    observed_at: z.iso.datetime({ offset: false }),
  }),
  expected_authorization_epoch_sources: CanonicalAuthorizationEpochSourcesV1Schema,
  entry_purpose: z.enum(['agent_run', 'agent_conversation', 'flow_run']),
});

const ResolvedBindingV1Schema = z.strictObject({
  binding_path: CanonicalBindingPathV1Schema,
  target: PublishedResourcePinV1Schema,
  operation_contract_hashes: z
    .array(Sha256HexV1Schema)
    .max(128)
    .refine(hasUniqueStrings)
    .refine(
      (values) => values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value),
      'operation hashes must be sorted',
    ),
  effective_policy: EffectiveCapabilityPolicyV1Schema,
  effective_policy_hash: Sha256HexV1Schema,
  approval_gate_spec: z
    .strictObject({ gate_spec_id: NonEmptyStringSchema, gate_spec_hash: Sha256HexV1Schema })
    .optional(),
  credential_mapping_hashes: z
    .array(Sha256HexV1Schema)
    .max(32)
    .refine(hasUniqueStrings)
    .refine(
      (values) => values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value),
      'credential mapping hashes must be sorted',
    ),
  credential_bindings: z
    .array(
      z.strictObject({
        requirement_id: NonEmptyStringSchema,
        mapping_hash: Sha256HexV1Schema,
        principal_mode: z.enum(['caller_delegated', 'service_principal', 'team_shared']),
        credential_subject_id: NonEmptyStringSchema,
        credential_id: NonEmptyStringSchema,
        credential_version_id: NonEmptyStringSchema,
        provider_id: NonEmptyStringSchema,
        audience: NonEmptyStringSchema,
        granted_scopes: z
          .array(NonEmptyStringSchema)
          .max(128)
          .refine(hasUniqueStrings)
          .refine((values) =>
            values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value),
          ),
        credential_handle_hash: Sha256HexV1Schema,
        material_fingerprint_hash: Sha256HexV1Schema,
        epoch_source: AuthorizationEpochSourceV1Schema.extend({
          source_kind: z.literal('credential'),
          source_subkey: Sha256HexV1Schema,
        }),
      }),
    )
    .max(32)
    .refine(
      (values) => hasUniqueBy(values, (value) => value.requirement_id),
      'credential bindings must be unique by requirement',
    )
    .refine(
      (values) =>
        values.every(
          (value, index) =>
            index === 0 || (values[index - 1]?.requirement_id ?? '') < value.requirement_id,
        ),
      'credential bindings must be sorted',
    ),
});

const resolvedPlanBase = {
  schema_version: z.literal('resolved-execution-plan/1'),
  workspace_id: NonEmptyStringSchema,
  deployment_revision_id: NonEmptyStringSchema,
  deployment_revision_contract_hash: Sha256HexV1Schema,
  root_release: PublishedResourcePinV1Schema,
  capability_closure_hash: Sha256HexV1Schema,
  admission_snapshot_hash: Sha256HexV1Schema,
  admission_activation_epoch: NonNegativeIntegerSchema,
  observed_revoke_epoch: NonNegativeIntegerSchema,
  authorization_decision_id: NonEmptyStringSchema,
  authorization_decision_hash: Sha256HexV1Schema,
  authorization_epoch_vector_hash: Sha256HexV1Schema,
  authorization_expires_at: z.iso.datetime({ offset: true }),
  enabled_bindings: z
    .array(ResolvedBindingV1Schema)
    .max(8_192)
    .refine((values) => hasUniqueBy(values, (value) => value.binding_path))
    .refine(
      (values) =>
        values.every(
          (value, index) =>
            index === 0 || (values[index - 1]?.binding_path ?? '') < value.binding_path,
        ),
      'enabled bindings must be sorted',
    ),
  disabled_binding_paths: z
    .array(CanonicalBindingPathV1Schema)
    .max(8_192)
    .refine(hasUniqueStrings)
    .refine(
      (values) => values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value),
      'disabled binding paths must be sorted',
    ),
  required_binding_paths: z
    .array(CanonicalBindingPathV1Schema)
    .max(8_192)
    .refine(hasUniqueStrings)
    .refine(
      (values) => values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value),
      'required binding paths must be sorted',
    ),
  required_calls: z
    .array(
      ForcedExecutionV1Schema.safeExtend({
        binding_path: CanonicalBindingPathV1Schema,
        execution_scope_path: CanonicalBindingPathV1Schema,
        source_node_id: ClosureResourceNodeIdV1Schema,
        on_empty_gate: CompiledGateSpecEntryV1Schema.optional(),
        on_timeout_gate: CompiledGateSpecEntryV1Schema.optional(),
      }).superRefine((call, ctx) => {
        for (const branch of ['on_empty', 'on_timeout'] as const) {
          const pin = call[`${branch}_gate_spec`];
          const gate = call[`${branch}_gate`];
          if (
            (pin === undefined) !== (gate === undefined) ||
            (gate !== undefined &&
              (gate.kind !== 'input' ||
                gate.source_kind !== 'agent_release' ||
                gate.source_node_id !== call.source_node_id ||
                gate.gate_spec_id !== pin?.gate_spec_id ||
                gate.gate_spec_hash !== pin.gate_spec_hash))
          )
            ctx.addIssue({
              code: 'custom',
              path: [`${branch}_gate`],
              message: 'ask_user must retain its exact typed same-owner input Gate plan',
            });
        }
      }),
    )
    .max(8_192)
    .refine(
      (values) =>
        hasUniqueBy(values, (value) => value.binding_path) &&
        hasUniqueBy(values, (value) => JSON.stringify([value.execution_scope_path, value.order])),
      'required call paths and scope-local order values must be unique',
    )
    .refine(
      (values) =>
        values.every(
          (value, index) =>
            index === 0 ||
            (values[index - 1]?.execution_scope_path ?? '') < value.execution_scope_path ||
            (values[index - 1]?.execution_scope_path === value.execution_scope_path &&
              (values[index - 1]?.order ?? -1) < value.order),
        ),
      'required calls must be sorted by scope then local execution order',
    ),
  plan_hash: Sha256HexV1Schema,
};

export const ResolvedExecutionPlanV1Schema = z
  .discriminatedUnion('plan_kind', [
    z.strictObject({
      ...resolvedPlanBase,
      root_release: PublishedResourcePinV1Schema.extend({
        published_resource_kind: z.literal('AGENT_RELEASE'),
      }),
      plan_kind: z.literal('agent'),
      agent_deployment_id: NonEmptyStringSchema,
      agent_release_id: NonEmptyStringSchema,
      experience_release_id: NonEmptyStringSchema,
    }),
    z.strictObject({
      ...resolvedPlanBase,
      root_release: PublishedResourcePinV1Schema.extend({
        published_resource_kind: z.literal('FLOW_VERSION'),
      }),
      plan_kind: z.literal('flow'),
      flow_deployment_id: NonEmptyStringSchema,
      flow_version_id: NonEmptyStringSchema,
    }),
  ])
  .superRefine((plan, ctx) => {
    if (plan.root_release.workspace_id !== plan.workspace_id)
      ctx.addIssue({
        code: 'custom',
        path: ['root_release', 'workspace_id'],
        message: 'root release must use the Plan Workspace',
      });
    const versionId = plan.plan_kind === 'agent' ? plan.agent_release_id : plan.flow_version_id;
    if (plan.root_release.resource_version_id !== versionId)
      ctx.addIssue({
        code: 'custom',
        path: ['root_release', 'resource_version_id'],
        message: 'root release version must match the Plan version identity',
      });
    const enabled = new Set(plan.enabled_bindings.map((binding) => binding.binding_path));
    if (plan.disabled_binding_paths.some((path) => enabled.has(path)))
      ctx.addIssue({
        code: 'custom',
        path: ['disabled_binding_paths'],
        message: 'enabled and disabled binding paths must be disjoint',
      });
    if (plan.required_binding_paths.some((path) => !enabled.has(path)))
      ctx.addIssue({
        code: 'custom',
        path: ['required_binding_paths'],
        message: 'required binding paths must be enabled',
      });
    const required = new Set(plan.required_binding_paths);
    if (
      plan.required_calls.length !== plan.required_binding_paths.length ||
      plan.required_calls.some((call) => !required.has(call.binding_path))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['required_calls'],
        message: 'required calls must cover every required binding exactly once',
      });
  });

export type AdmissionAuthorizationDecisionV1 = z.infer<
  typeof AdmissionAuthorizationDecisionV1Schema
>;
export type ResolvedExecutionPlanV1 = z.infer<typeof ResolvedExecutionPlanV1Schema>;
