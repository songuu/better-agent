import {
  AdmissionAuthorizationDecisionV1Schema,
  AgentDeploymentRevisionV1Schema,
  type EffectiveCapabilityPolicyV1,
  FlowDeploymentRevisionV1Schema,
  ResolvedExecutionPlanV1Schema,
  CanonicalAuthorizationEpochSourcesV1Schema,
  ResolveExecutionPlanInputV1Schema,
} from '@better-agent/domain-contracts';

import { verifyAdmissionSnapshot } from './admission-snapshot.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import {
  compileCapabilityRequirementEnvelope,
  meetCapabilityPolicyCeilings,
  normalizeCapabilityPolicyCeiling,
  resolveEffectiveCapabilityPolicy,
} from './capability-policy.js';
import { prepareCompiledCapabilityClosure } from './compiled-capability-closure.js';
import {
  calculateCredentialMappingHash,
  calculateCredentialMappingSetHash,
} from './credential-mapping.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256, canonicalSha256ExcludingRootKeys } from './hash.js';
import { createRequiredBindingCallResolver } from './required-binding-call.js';
import { prepareExecutableSource, verifyExecutableCompiledHash } from './executable-source.js';
import { canonicalBindingPath, canonicalResourceNodeId } from './closure-identity.js';
import { effectivePolicyAsCeiling } from './effective-policy-ceiling.js';
import { sealBoundedResolvedPlan } from './resolved-plan-seal.js';
import {
  credentialMaterialIdentityHash,
  verifyAdmissionCredential,
} from './admission-credential.js';

export interface ResolveExecutionPlanInputV1 {
  readonly executable_source: unknown;
  readonly closure: unknown;
  readonly deployment_revision: unknown;
  readonly admission_snapshot: unknown;
  readonly authorization_decision: unknown;
  readonly expected_admission_epochs: {
    readonly admission_activation_epoch: number;
    readonly observed_revoke_epoch: number;
  };
  readonly admission_clock: {
    readonly source: 'database_transaction_clock';
    readonly observed_at: string;
  };
  readonly expected_authorization_epoch_sources: unknown;
  readonly entry_purpose: 'agent_run' | 'agent_conversation' | 'flow_run';
}

function fail(path: string, reason: string): never {
  throw new ReleaseCoreError('RELEASE_RESOLVED_PLAN_INVALID', path, reason);
}

function samePin(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return [
    'workspace_id',
    'published_resource_kind',
    'resource_id',
    'resource_version_id',
    'contract_hash',
    'binding_mode',
  ].every((key) => left[key] === right[key]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort(compareCanonicalStrings);
  return (
    left.length === right.length &&
    [...left].sort(compareCanonicalStrings).every((value, index) => value === sortedRight[index])
  );
}

export function resolveExecutionPlan(input: ResolveExecutionPlanInputV1) {
  const inputResult = ResolveExecutionPlanInputV1Schema.safeParse(
    boundedDataSnapshot(input, 'closure'),
  );
  if (!inputResult.success) {
    const issue = inputResult.error.issues[0];
    fail(
      issue === undefined ? '$' : `$.${issue.path.join('.')}`,
      issue === undefined
        ? 'admission input does not match the closed bounded v1 contract'
        : `admission input does not match the closed bounded v1 contract: ${issue.message}`,
    );
  }
  const safeInput = inputResult.data;
  const closure = prepareCompiledCapabilityClosure(safeInput.closure);
  const decisionResult = AdmissionAuthorizationDecisionV1Schema.safeParse(
    safeInput.authorization_decision,
  );
  if (!decisionResult.success)
    fail('$.authorization_decision', 'authorization decision is not a closed v1 contract');
  const decision = decisionResult.data;
  for (const [index, allowed] of decision.allowed_bindings.entries()) {
    if (
      canonicalSha256(allowed.policy_ceiling) !==
      canonicalSha256(normalizeCapabilityPolicyCeiling(allowed.policy_ceiling))
    )
      fail(
        `$.authorization_decision.allowed_bindings[${index}].policy_ceiling`,
        'authorization policy ceiling is not canonical',
      );
  }
  if (
    decision.root_authority !== undefined &&
    canonicalSha256(decision.root_authority.policy_ceiling) !==
      canonicalSha256(normalizeCapabilityPolicyCeiling(decision.root_authority.policy_ceiling))
  )
    fail(
      '$.authorization_decision.root_authority.policy_ceiling',
      'root authorization policy ceiling is not canonical',
    );
  const expectedDecisionHash = canonicalSha256ExcludingRootKeys(decision, ['decision_hash']);
  if (decision.decision_hash !== expectedDecisionHash) {
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.authorization_decision.decision_hash',
      'authorization decision hash is stale',
    );
  }

  const rawKind =
    typeof safeInput.deployment_revision === 'object' && safeInput.deployment_revision !== null
      ? Reflect.get(safeInput.deployment_revision, 'deployment_kind')
      : undefined;
  const revisionResult =
    rawKind === 'agent'
      ? AgentDeploymentRevisionV1Schema.safeParse(safeInput.deployment_revision)
      : rawKind === 'flow'
        ? FlowDeploymentRevisionV1Schema.safeParse(safeInput.deployment_revision)
        : undefined;
  if (revisionResult === undefined || !revisionResult.success)
    fail('$.deployment_revision', 'revision does not match a closed Agent or Flow profile');
  const revision = revisionResult.data;
  const revisionForHash =
    revision.deployment_kind === 'agent' && revision.ingress_channel === 'browser'
      ? {
          ...revision,
          credential_mappings: [...revision.credential_mappings].sort((left, right) =>
            compareCanonicalStrings(left.requirement_id, right.requirement_id),
          ),
          allowed_origins: [...revision.allowed_origins].sort(compareCanonicalStrings),
          browser_client_channels: [...revision.browser_client_channels].sort(
            compareCanonicalStrings,
          ),
        }
      : {
          ...revision,
          credential_mappings: [...revision.credential_mappings].sort((left, right) =>
            compareCanonicalStrings(left.requirement_id, right.requirement_id),
          ),
        };
  const revisionHash = canonicalSha256ExcludingRootKeys(revisionForHash, [
    'revision_contract_hash',
  ]);
  if (revision.revision_contract_hash !== revisionHash) {
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.deployment_revision.revision_contract_hash',
      'Deployment revision hash is stale',
    );
  }
  const mappings = [...revision.credential_mappings].sort((left, right) =>
    compareCanonicalStrings(left.requirement_id, right.requirement_id),
  );
  for (const [index, mapping] of mappings.entries()) {
    if (mapping.mapping_hash !== calculateCredentialMappingHash(mapping))
      fail(
        `$.deployment_revision.credential_mappings[${index}].mapping_hash`,
        'credential mapping hash is stale',
      );
  }
  if (
    revision.credential_mapping_hash !==
    calculateCredentialMappingSetHash(revision.deployment_kind, mappings)
  )
    fail('$.deployment_revision.credential_mapping_hash', 'credential mapping set hash is stale');

  const deploymentId =
    revision.deployment_kind === 'agent'
      ? revision.agent_deployment_id
      : revision.flow_deployment_id;
  const revisionId =
    revision.deployment_kind === 'agent'
      ? revision.agent_deployment_revision_id
      : revision.flow_deployment_revision_id;
  const rootRelease =
    revision.deployment_kind === 'agent' ? revision.agent_release : revision.flow_version;
  const executableSource = prepareExecutableSource(safeInput.executable_source);
  if (!samePin(closure.root.pin, executableSource.root.pin))
    fail(
      '$.closure.root.pin',
      'closure root does not equal the independently recomputed semantic source pin',
    );
  verifyExecutableCompiledHash(rootRelease, safeInput.executable_source, closure.closure_hash);

  const snapshot = verifyAdmissionSnapshot({
    snapshot: safeInput.admission_snapshot,
    expected: {
      deployment_kind: revision.deployment_kind,
      workspace_id: revision.workspace_id,
      deployment_id: deploymentId,
      deployment_revision_id: revisionId,
      deployment_revision_contract_hash: revision.revision_contract_hash,
      admission_activation_epoch: safeInput.expected_admission_epochs.admission_activation_epoch,
      observed_revoke_epoch: safeInput.expected_admission_epochs.observed_revoke_epoch,
    },
  });
  if (
    snapshot.credential_mapping_hash !== revision.credential_mapping_hash ||
    snapshot.dependency_manifest_hash !== revision.dependency_manifest_hash
  ) {
    fail(
      '$.admission_snapshot',
      'snapshot mapping or dependency manifest differs from the Deployment revision',
    );
  }
  const snapshotRootRelease =
    snapshot.deployment_kind === 'agent' ? snapshot.agent_release : snapshot.flow_version;
  if (
    !samePin(snapshotRootRelease, rootRelease) ||
    snapshot.environment !== revision.environment ||
    snapshot.ingress_channel !== revision.ingress_channel ||
    snapshot.policy_profile_contract_hash !== revision.policy_profile.contract_hash ||
    snapshot.entry_scope_policy_contract_hash !== revision.entry_scope_policy.contract_hash
  ) {
    fail(
      '$.admission_snapshot',
      'snapshot release or Deployment profile facts differ from the exact revision',
    );
  }

  if (
    decision.workspace_id !== revision.workspace_id ||
    decision.deployment_kind !== revision.deployment_kind ||
    decision.deployment_id !== deploymentId ||
    decision.deployment_revision_id !== revisionId ||
    decision.deployment_revision_contract_hash !== revision.revision_contract_hash ||
    decision.capability_closure_hash !== closure.closure_hash ||
    decision.admission_snapshot_hash !== snapshot.snapshot_hash ||
    decision.admission_activation_epoch !== snapshot.admission_activation_epoch
  ) {
    fail(
      '$.authorization_decision',
      'decision is not bound to this exact admission, revision and closure',
    );
  }
  if (safeInput.admission_clock.source !== 'database_transaction_clock')
    fail(
      '$.admission_clock.source',
      'admission freshness must come from the database transaction clock',
    );
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(safeInput.admission_clock.observed_at))
    fail(
      '$.admission_clock.observed_at',
      'database transaction time must use canonical UTC millisecond spelling',
    );
  const admissionTime = Date.parse(safeInput.admission_clock.observed_at);
  if (Date.parse(decision.expires_at) <= admissionTime)
    fail(
      '$.authorization_decision.expires_at',
      'authorization decision is expired at admission time',
    );

  if (snapshot.deployment_kind === 'flow') {
    if (safeInput.entry_purpose !== 'flow_run' || snapshot.entry_scope !== 'flow:run:create')
      fail('$.entry_purpose', 'Flow execution requires the flow:run:create entry scope');
  } else {
    if (snapshot.entry_source_kind === 'service_credential') {
      const expectedScope =
        safeInput.entry_purpose === 'agent_run'
          ? 'agent:run:create'
          : safeInput.entry_purpose === 'agent_conversation'
            ? 'agent:conversation:write'
            : undefined;
      if (expectedScope === undefined || snapshot.entry_scope !== expectedScope)
        fail(
          '$.entry_purpose',
          'Agent execution purpose does not match its create/write entry scope',
        );
    } else {
      if (safeInput.entry_purpose !== 'agent_conversation')
        fail('$.entry_purpose', 'browser admission is only valid for an Agent conversation entry');
      if (revision.deployment_kind !== 'agent' || revision.ingress_channel !== 'browser')
        fail(
          '$.deployment_revision',
          'browser admission requires the Agent browser revision branch',
        );
      if (
        !revision.allowed_origins.includes(snapshot.canonical_origin) ||
        !revision.browser_client_channels.includes(snapshot.client_channel) ||
        revision.session_token_audience !== snapshot.token_audience
      )
        fail(
          '$.admission_snapshot',
          'browser origin, channel or audience is outside the revision profile',
        );
    }
    if (
      revision.deployment_kind !== 'agent' ||
      !samePin(snapshot.agent_release, revision.agent_release) ||
      !samePin(snapshot.experience_release, revision.experience_release)
    )
      fail('$.admission_snapshot', 'Agent snapshot release pins differ from the revision');
  }

  const expectedEpochResult = CanonicalAuthorizationEpochSourcesV1Schema.safeParse(
    safeInput.expected_authorization_epoch_sources,
  );
  if (!expectedEpochResult.success)
    fail(
      '$.expected_authorization_epoch_sources',
      'expected authorization epochs must be a canonical closed source set',
    );
  const canonicalEpochSources = [...decision.epoch_sources];
  const completeEpochEvidence = new Set(
    canonicalEpochSources.map((source) => canonicalSha256(source)),
  );
  if (canonicalSha256(canonicalEpochSources) !== canonicalSha256(expectedEpochResult.data))
    fail(
      '$.authorization_decision.epoch_sources',
      'decision epoch sources differ from the independently read current source set',
    );
  const requiredEpochs = new Map([
    [
      JSON.stringify(['workspace_authorization', revision.workspace_id, '']),
      snapshot.workspace_authorization_epoch,
    ],
    [
      JSON.stringify([
        revision.deployment_kind === 'agent'
          ? 'agent_deployment_security'
          : 'flow_deployment_security',
        deploymentId,
        '',
      ]),
      snapshot.observed_revoke_epoch,
    ],
  ]);
  if (snapshot.entry_source_kind === 'service_credential') {
    requiredEpochs.set(
      JSON.stringify(['credential', snapshot.credential_id, '']),
      snapshot.credential_authorization_epoch,
    );
    requiredEpochs.set(
      JSON.stringify([
        snapshot.deployment_kind === 'agent' ? 'agent_entry_grant' : 'flow_entry_grant',
        snapshot.entry_grant_id,
        '',
      ]),
      snapshot.entry_grant_authorization_epoch,
    );
  } else {
    requiredEpochs.set(
      JSON.stringify(['browser_session', snapshot.browser_session_id, '']),
      snapshot.session_epoch,
    );
    requiredEpochs.set(
      JSON.stringify([
        'principal_session',
        snapshot.authenticated_principal.end_user_principal_id,
        '',
      ]),
      snapshot.observed_principal_session_epoch,
    );
  }
  for (const [identity, epoch] of requiredEpochs) {
    const source = canonicalEpochSources.find(
      (candidate) =>
        JSON.stringify([candidate.source_kind, candidate.source_id, candidate.source_subkey]) ===
        identity,
    );
    if (source?.observed_epoch !== epoch)
      fail(
        '$.authorization_decision.epoch_sources',
        'decision omits or changes an admission epoch source',
      );
  }

  const closureBindings = new Map(
    closure.bindings.map((binding) => [binding.binding_path, binding]),
  );
  const mappingByRequirement = new Map(
    mappings.map((mapping) => [mapping.requirement_id, mapping]),
  );
  const rootNode = closure.resource_nodes.find((node) => node.node_role === 'root');
  if (rootNode === undefined) fail('$.closure.resource_nodes', 'closure omits its root authority');
  const rootRequirements = compileCapabilityRequirementEnvelope(rootNode.intrinsic_policy);
  const rootHasExecutableDemand =
    rootRequirements.credential_requirements.length > 0 ||
    rootRequirements.operation_contract_hashes.length > 0 ||
    rootRequirements.minimum_limits.calls > 0 ||
    rootRequirements.minimum_limits.depth > 0 ||
    rootRequirements.minimum_limits.parallelism > 0 ||
    rootRequirements.minimum_limits.budget.amount_credits !== '0' ||
    rootRequirements.minimum_limits.budget.input_tokens > 0 ||
    rootRequirements.minimum_limits.budget.output_tokens > 0 ||
    rootRequirements.minimum_limits.budget.total_tokens > 0 ||
    rootRequirements.minimum_limits.budget.duration_ms > 0;
  if (
    revision.deployment_kind === 'flow' &&
    rootHasExecutableDemand &&
    decision.root_authority === undefined
  )
    fail(
      '$.authorization_decision.root_authority',
      'capability-bearing Flow root requires explicit authorization and credentials',
    );
  const rootAuthority =
    decision.root_authority === undefined
      ? undefined
      : (() => {
          const closureCeiling = normalizeCapabilityPolicyCeiling(
            effectivePolicyAsCeiling(closure.aggregate_limits),
          );
          const authorizationCeiling = normalizeCapabilityPolicyCeiling(
            decision.root_authority.policy_ceiling,
          );
          const intersection = meetCapabilityPolicyCeilings(closureCeiling, authorizationCeiling);
          if (canonicalSha256(intersection) !== canonicalSha256(authorizationCeiling))
            fail(
              '$.authorization_decision.root_authority.policy_ceiling',
              'root authorization policy attempts to expand the verified closure',
            );
          let effectivePolicy: EffectiveCapabilityPolicyV1;
          try {
            effectivePolicy = resolveEffectiveCapabilityPolicy(intersection, rootRequirements);
          } catch (error) {
            const context = error instanceof Error ? `: ${error.message}` : '';
            fail(
              '$.authorization_decision.root_authority.policy_ceiling',
              `root authorization cannot satisfy the verified Flow demand${context}`,
            );
          }
          const bindings = decision.root_authority.credential_bindings;
          const byRequirement = new Map(
            bindings.map((binding) => [binding.requirement_id, binding]),
          );
          if (byRequirement.size !== effectivePolicy.credential_requirements.length)
            fail(
              '$.authorization_decision.root_authority.credential_bindings',
              'Flow root must resolve every and only credential requirement',
            );
          const credentialMappingHashes = effectivePolicy.credential_requirements
            .map((requirement) =>
              verifyAdmissionCredential({
                deployment_kind: revision.deployment_kind,
                workspace_id: revision.workspace_id,
                caller:
                  snapshot.entry_source_kind === 'browser_session'
                    ? {
                        kind: 'browser',
                        principal_id: snapshot.authenticated_principal.end_user_principal_id,
                      }
                    : { kind: 'service' },
                requirement,
                mapping: mappingByRequirement.get(requirement.requirement_id),
                credential: byRequirement.get(requirement.requirement_id),
                epoch_evidence: completeEpochEvidence,
                path: '$.authorization_decision.root_authority.credential_bindings',
              }),
            )
            .sort(compareCanonicalStrings);
          return {
            effective_policy: effectivePolicy,
            effective_policy_hash: canonicalSha256(effectivePolicy),
            credential_mapping_hashes: credentialMappingHashes,
            credential_bindings: bindings,
          };
        })();
  const enabledBindings = decision.allowed_bindings
    .map((allowed, index) => {
      const binding = closureBindings.get(allowed.binding_path);
      if (binding === undefined || closure.disabled_binding_paths.includes(allowed.binding_path))
        fail(
          `$.authorization_decision.allowed_bindings[${index}].binding_path`,
          'decision introduces an unknown or disabled binding path',
        );
      const closureCeiling = normalizeCapabilityPolicyCeiling(
        effectivePolicyAsCeiling(binding.effective_policy),
      );
      const authorizationCeiling = normalizeCapabilityPolicyCeiling(allowed.policy_ceiling);
      const intersection = meetCapabilityPolicyCeilings(closureCeiling, authorizationCeiling);
      if (canonicalSha256(intersection) !== canonicalSha256(authorizationCeiling)) {
        fail(
          `$.authorization_decision.allowed_bindings[${index}].policy_ceiling`,
          'authorization policy attempts to expand the verified closure',
        );
      }
      let narrowedPolicy: EffectiveCapabilityPolicyV1;
      try {
        narrowedPolicy = resolveEffectiveCapabilityPolicy(intersection, {
          ...compileCapabilityRequirementEnvelope(binding.requirement_expression),
          // Composite demand accounts for child work, but callable operation authority is path-local.
          operation_contract_hashes: binding.effective_policy.operation_contract_hashes,
        });
      } catch (error) {
        const context = error instanceof Error ? `: ${error.message}` : '';
        fail(
          `$.authorization_decision.allowed_bindings[${index}].policy_ceiling`,
          `authorization policy cannot satisfy the verified binding without expansion${context}`,
        );
      }
      const availableOperations = new Set(
        binding.operation_contracts.map((operation) => operation.contract_hash),
      );
      if (
        narrowedPolicy.side_effect.approval === 'required' &&
        binding.approval_gate_spec === undefined
      )
        fail(
          `$.authorization_decision.allowed_bindings[${index}].policy_ceiling`,
          'approval narrowing requires an existing compiled approval GateSpec',
        );
      if (narrowedPolicy.operation_contract_hashes.some((hash) => !availableOperations.has(hash)))
        fail(
          `$.authorization_decision.allowed_bindings[${index}].policy_ceiling.operation_contract_hashes`,
          'decision introduces an operation outside the verified closure',
        );
      const credentialBindingByRequirement = new Map(
        allowed.credential_bindings.map((binding) => [binding.requirement_id, binding]),
      );
      if (credentialBindingByRequirement.size !== narrowedPolicy.credential_requirements.length)
        fail(
          `$.authorization_decision.allowed_bindings[${index}].credential_bindings`,
          'enabled binding must resolve every and only credential requirement',
        );
      const credentialMappingHashes = narrowedPolicy.credential_requirements
        .map((requirement) => {
          const mapping = mappingByRequirement.get(requirement.requirement_id);
          const credentialBinding = credentialBindingByRequirement.get(requirement.requirement_id);
          return verifyAdmissionCredential({
            deployment_kind: revision.deployment_kind,
            workspace_id: revision.workspace_id,
            caller:
              snapshot.entry_source_kind === 'browser_session'
                ? {
                    kind: 'browser',
                    principal_id: snapshot.authenticated_principal.end_user_principal_id,
                  }
                : { kind: 'service' },
            requirement,
            mapping,
            credential: credentialBinding,
            epoch_evidence: completeEpochEvidence,
            path: `$.authorization_decision.allowed_bindings[${index}].credential_bindings`,
          });
        })
        .sort(compareCanonicalStrings);
      return {
        binding_path: binding.binding_path,
        target: binding.target,
        operation_contract_hashes: [...narrowedPolicy.operation_contract_hashes].sort(
          compareCanonicalStrings,
        ),
        effective_policy: narrowedPolicy,
        effective_policy_hash: canonicalSha256(narrowedPolicy),
        ...(narrowedPolicy.side_effect.approval === 'required'
          ? { approval_gate_spec: binding.approval_gate_spec }
          : {}),
        credential_mapping_hashes: credentialMappingHashes,
        credential_bindings: allowed.credential_bindings,
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const enabledPaths = new Set(enabledBindings.map((binding) => binding.binding_path));
  const closurePaths = new Set(closure.bindings.map((binding) => binding.binding_path));
  const ancestorPaths = new Map(
    closure.bindings.map((binding) => [
      binding.binding_path,
      binding.binding_path_segments.slice(1).flatMap((_segment, index) => {
        const prefix = canonicalBindingPath(binding.binding_path_segments.slice(0, index + 1));
        return closurePaths.has(prefix) ? [prefix] : [];
      }),
    ]),
  );
  const ownerIsEnabled = (path: string) =>
    (ancestorPaths.get(path) ?? []).every((ancestor) => enabledPaths.has(ancestor));
  for (const binding of closure.bindings) {
    if (enabledPaths.has(binding.binding_path) && !ownerIsEnabled(binding.binding_path))
      fail(
        '$.authorization_decision.allowed_bindings',
        'a descendant cannot execute without its enabled parent mount',
      );
    if (
      binding.admission_requirement === 'forced' &&
      ownerIsEnabled(binding.binding_path) &&
      !enabledPaths.has(binding.binding_path)
    )
      fail(
        '$.authorization_decision.allowed_bindings',
        `forced binding ${binding.binding_path} is unavailable`,
      );
  }
  const requiredBindingPaths = closure.bindings
    .filter(
      (binding) =>
        binding.admission_requirement === 'forced' && ownerIsEnabled(binding.binding_path),
    )
    .map((binding) => binding.binding_path)
    .sort(compareCanonicalStrings);
  const requiredPathSet = new Set(requiredBindingPaths);
  const resolveRequiredCall = createRequiredBindingCallResolver(
    closure.gate_specs,
    closure.resource_nodes,
  );
  const requiredCalls = closure.bindings
    .filter((binding) => requiredPathSet.has(binding.binding_path))
    .flatMap((binding) => {
      const call = resolveRequiredCall(binding);
      return call === undefined ? [] : [call];
    })
    .sort(
      (left, right) =>
        compareCanonicalStrings(left.execution_scope_path, right.execution_scope_path) ||
        left.order - right.order,
    );
  const disabledBindingPaths = closure.bindings
    .map((binding) => binding.binding_path)
    .filter((path) => !enabledPaths.has(path))
    .sort(compareCanonicalStrings);
  const epochIdentitySet = new Set(
    canonicalEpochSources.map((source) =>
      JSON.stringify([source.source_kind, source.source_id, source.source_subkey]),
    ),
  );
  const requireEpochIdentity = (
    kind: (typeof canonicalEpochSources)[number]['source_kind'],
    id: string,
    subkey: string,
  ) => {
    if (!epochIdentitySet.has(JSON.stringify([kind, id, subkey])))
      fail(
        '$.authorization_decision.epoch_sources',
        `decision omits required ${kind} source ${id}/${subkey}`,
      );
  };
  requireEpochIdentity(
    'published_release_state',
    rootRelease.resource_version_id,
    rootRelease.published_resource_kind,
  );
  const grantSubjects = new Set(
    canonicalEpochSources
      .filter(
        (source) =>
          source.source_kind === 'published_release_grant' ||
          source.source_kind === 'capability_release_grant',
      )
      .map((source) => JSON.stringify([source.source_kind, source.source_subkey])),
  );
  const requireGrantForPin = (
    kind: 'published_release_grant' | 'capability_release_grant',
    pin: typeof rootRelease | (typeof closure.assembly_pins)[number],
  ) => {
    const grantIdentity = canonicalSha256({
      schema_version: 'release-grant-identity/1',
      workspace_id: revision.workspace_id,
      authenticated_principal: snapshot.authenticated_principal,
      target: pin,
    });
    if (!grantSubjects.has(JSON.stringify([kind, grantIdentity])))
      fail(
        '$.authorization_decision.epoch_sources',
        `decision omits required ${kind} for the exact subject and published pin`,
      );
  };
  requireGrantForPin('published_release_grant', rootRelease);
  // The manifest contains optional targets too. Only active mounted owners consume
  // their inert assembly dependencies; unselected capabilities require no caller grant.
  const activeAssemblyScopes = new Set([
    JSON.stringify([
      canonicalResourceNodeId(closure.root.pin),
      canonicalBindingPath([{ segment_kind: 'root', pin: closure.root.pin }]),
    ]),
  ]);
  for (const binding of closure.bindings.filter((entry) => enabledPaths.has(entry.binding_path))) {
    const path =
      binding.target.published_resource_kind === 'AGENT_RELEASE'
        ? canonicalBindingPath([
            ...binding.binding_path_segments,
            { segment_kind: 'subagent_target', target_pin: binding.target },
          ])
        : binding.binding_path;
    activeAssemblyScopes.add(JSON.stringify([canonicalResourceNodeId(binding.target), path]));
  }
  const activeAssemblyNodes = new Set(
    closure.dependency_edges
      .filter(
        (edge) =>
          edge.relation === 'typed_internal_dependency' &&
          activeAssemblyScopes.has(JSON.stringify([edge.from_node_id, edge.source_path])),
      )
      .map((edge) => edge.to_node_id),
  );
  // Root assembly obligations come from the independently rehashed source too;
  // an omitted graph edge must never erase an always-used Strategy/Instruction.
  const rootAssemblyPins = executableSource.dependency_manifest.dependencies.filter((pin) =>
    ['AGENT_STRATEGY_RELEASE', 'INSTRUCTION_SKILL_RELEASE'].includes(pin.published_resource_kind),
  );
  const requiredAssemblyPins = new Map(
    [
      ...rootAssemblyPins,
      ...closure.resource_nodes
        .filter((node) => activeAssemblyNodes.has(node.node_id))
        .map((node) => node.pin),
    ].map((pin) => [canonicalResourceNodeId(pin), pin]),
  );
  for (const pin of requiredAssemblyPins.values()) {
    requireEpochIdentity(
      'published_release_state',
      pin.resource_version_id,
      pin.published_resource_kind,
    );
    requireGrantForPin('published_release_grant', pin);
  }
  for (const policy of [
    revision.policy_profile,
    revision.entry_grant_policy,
    revision.entry_scope_policy,
  ])
    requireEpochIdentity('permission_policy', policy.policy_id, policy.policy_kind);
  for (const binding of enabledBindings) {
    requireEpochIdentity(
      'capability_release_state',
      binding.target.resource_version_id,
      binding.target.published_resource_kind,
    );
    requireGrantForPin('capability_release_grant', binding.target);
  }
  const usedMappingHashes = new Set([
    ...(rootAuthority?.credential_mapping_hashes ?? []),
    ...enabledBindings.flatMap((binding) => binding.credential_mapping_hashes),
  ]);
  for (const mapping of mappings.filter((candidate) =>
    usedMappingHashes.has(candidate.mapping_hash),
  )) {
    requireEpochIdentity(
      'credential_policy',
      mapping.credential_policy.policy_id,
      mapping.requirement_id,
    );
    if (mapping.principal_mode === 'service_principal')
      requireEpochIdentity(
        'service_principal',
        mapping.service_principal_id,
        mapping.requirement_id,
      );
  }
  if (revision.deployment_kind === 'agent') {
    requireEpochIdentity(
      'published_release_state',
      revision.experience_release.resource_version_id,
      'EXPERIENCE_RELEASE',
    );
    requireGrantForPin('published_release_grant', revision.experience_release);
  }
  const base = {
    schema_version: 'resolved-execution-plan/1' as const,
    workspace_id: revision.workspace_id,
    deployment_revision_id: revisionId,
    deployment_revision_contract_hash: revision.revision_contract_hash,
    root_release: rootRelease,
    capability_closure_hash: closure.closure_hash,
    admission_snapshot_hash: snapshot.snapshot_hash,
    admission_activation_epoch: snapshot.admission_activation_epoch,
    observed_revoke_epoch: snapshot.observed_revoke_epoch,
    authorization_decision_id: decision.decision_id,
    authorization_decision_hash: decision.decision_hash,
    authorization_epoch_vector_hash: canonicalSha256({
      schema_version: 'authorization-epoch-vector/1',
      sources: canonicalEpochSources,
    }),
    authorization_expires_at: decision.expires_at,
    ...(rootAuthority === undefined ? {} : { root_authority: rootAuthority }),
    enabled_bindings: enabledBindings,
    disabled_binding_paths: disabledBindingPaths,
    required_binding_paths: requiredBindingPaths,
    required_calls: requiredCalls,
  };
  const candidate =
    revision.deployment_kind === 'agent'
      ? {
          ...base,
          plan_kind: 'agent' as const,
          agent_deployment_id: revision.agent_deployment_id,
          agent_release_id: revision.agent_release.resource_version_id,
          experience_release_id: revision.experience_release.resource_version_id,
        }
      : {
          ...base,
          plan_kind: 'flow' as const,
          flow_deployment_id: revision.flow_deployment_id,
          flow_version_id: revision.flow_version.resource_version_id,
        };
  const plan = sealBoundedResolvedPlan(candidate);
  return verifyResolvedExecutionPlan(plan, plan.plan_hash);
}

/** expectedPlanHash must come from the committed admission receipt, not the untrusted plan. */
export function verifyResolvedExecutionPlan(input: unknown, expectedPlanHash: unknown) {
  const parsed = ResolvedExecutionPlanV1Schema.safeParse(boundedDataSnapshot(input, 'closure'));
  if (!parsed.success) fail('$.plan', 'resolved plan failed its closed output contract');
  if (parsed.data.root_authority !== undefined) {
    const root = parsed.data.root_authority;
    if (
      !sameStrings(
        root.credential_mapping_hashes,
        root.credential_bindings.map((credential) => credential.mapping_hash),
      ) ||
      !sameStrings(
        root.credential_bindings.map((credential) => credential.requirement_id),
        root.effective_policy.credential_requirements.map(
          (requirement) => requirement.requirement_id,
        ),
      ) ||
      root.effective_policy_hash !== canonicalSha256(root.effective_policy)
    )
      fail('$.plan.root_authority', 'root credential set or effective policy hash is stale');
    for (const credential of root.credential_bindings) {
      const requirement = root.effective_policy.credential_requirements.find(
        (entry) => entry.requirement_id === credential.requirement_id,
      );
      if (
        requirement === undefined ||
        requirement.provider_id !== credential.provider_id ||
        requirement.audience !== credential.audience ||
        !sameStrings(requirement.required_scopes, credential.granted_scopes) ||
        !requirement.allowed_principal_modes.includes(credential.principal_mode) ||
        credential.epoch_source.source_id !== credential.credential_id ||
        credential.epoch_source.source_subkey !== credentialMaterialIdentityHash(credential)
      )
        fail('$.plan.root_authority.credential_bindings', 'root credential authority is invalid');
    }
  }
  for (const [index, binding] of parsed.data.enabled_bindings.entries()) {
    if (
      binding.target.workspace_id !== parsed.data.workspace_id ||
      !sameStrings(
        binding.operation_contract_hashes,
        binding.effective_policy.operation_contract_hashes,
      ) ||
      !sameStrings(
        binding.credential_mapping_hashes,
        binding.credential_bindings.map((credential) => credential.mapping_hash),
      ) ||
      !sameStrings(
        binding.credential_bindings.map((credential) => credential.requirement_id),
        binding.effective_policy.credential_requirements.map(
          (requirement) => requirement.requirement_id,
        ),
      )
    )
      fail(
        `$.plan.enabled_bindings[${index}]`,
        'resolved binding target, operation and credential sets must agree with its policy',
      );
    const policy = binding.effective_policy;
    if ((policy.side_effect.approval === 'required') !== (binding.approval_gate_spec !== undefined))
      fail(
        `$.plan.enabled_bindings[${index}].approval_gate_spec`,
        'resolved approval must retain exact compiled Gate evidence',
      );
    const canonicalPolicy = resolveEffectiveCapabilityPolicy(effectivePolicyAsCeiling(policy), {
      schema_version: 'capability-requirements/1',
      credential_requirements: policy.credential_requirements,
      principal_modes: policy.principal_modes,
      egress: policy.egress,
      readable_data_classification: policy.readable_data_classification_ceiling,
      output_data_classification: policy.output_data_classification,
      side_effect_class: policy.side_effect.maximum_class,
      approval_required: policy.side_effect.approval === 'required',
      operation_contract_hashes: policy.operation_contract_hashes,
      minimum_limits: {
        calls: 0,
        depth: 0,
        parallelism: 0,
        budget: {
          schema_version: 'capability-budget/1',
          amount_credits: '0',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          duration_ms: 0,
        },
      },
    });
    if (canonicalSha256(canonicalPolicy) !== canonicalSha256(policy))
      fail(
        `$.plan.enabled_bindings[${index}].effective_policy`,
        'effective policy must be canonical',
      );
    for (const credential of binding.credential_bindings) {
      const requirement = policy.credential_requirements.find(
        (entry) => entry.requirement_id === credential.requirement_id,
      );
      if (
        requirement === undefined ||
        requirement.provider_id !== credential.provider_id ||
        requirement.audience !== credential.audience ||
        !sameStrings(requirement.required_scopes, credential.granted_scopes) ||
        !requirement.allowed_principal_modes.includes(credential.principal_mode)
      )
        fail(
          `$.plan.enabled_bindings[${index}].credential_bindings`,
          'actual credential does not satisfy its resolved policy',
        );
      if (
        credential.epoch_source.source_id !== credential.credential_id ||
        credential.epoch_source.source_subkey !== credentialMaterialIdentityHash(credential)
      )
        fail(
          `$.plan.enabled_bindings[${index}].credential_bindings`,
          'credential material identity is not sealed',
        );
    }
    if (binding.effective_policy_hash !== canonicalSha256(binding.effective_policy))
      fail(
        `$.plan.enabled_bindings[${index}].effective_policy_hash`,
        'effective policy hash is stale',
      );
  }
  const expectedHash = canonicalSha256ExcludingRootKeys(parsed.data, ['plan_hash']);
  if (parsed.data.plan_hash !== expectedHash || parsed.data.plan_hash !== expectedPlanHash)
    throw new ReleaseCoreError(
      'RELEASE_HASH_MISMATCH',
      '$.plan.plan_hash',
      'ResolvedPlan differs from its trusted admission receipt hash',
    );
  return deepFreezeJson(parsed.data);
}
