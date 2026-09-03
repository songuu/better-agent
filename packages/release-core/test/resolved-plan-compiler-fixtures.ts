import {
  calculateCredentialMappingSetHash,
  canonicalSha256,
  canonicalSha256ExcludingRootKeys,
  deriveDependencyManifest,
  deriveExecutableCompiledHash,
  prepareExecutableSource,
} from '../src/index.js';
import { prepareCompiledCapabilityClosure } from '../src/compiled-capability-closure.js';
import {
  agentDeploymentId,
  agentDeploymentRevisionId,
  credentialId,
  hashA,
  makeExperiencePin,
  makePolicyPin,
} from './fixtures.js';

/** Admission facts for a real no-credential compiler result; never repairs a negative mutation. */
export function compiledAgentAdmission(
  rootInput: unknown,
  closureInput: unknown,
  enabledPaths?: readonly string[],
) {
  const closure = prepareCompiledCapabilityClosure(closureInput);
  const source = prepareExecutableSource(rootInput);
  const root = {
    ...source.root.pin,
    published_resource_kind: 'AGENT_RELEASE' as const,
    contract_hash: deriveExecutableCompiledHash(rootInput, closure.closure_hash),
  };
  const experience = makeExperiencePin();
  const manifest = deriveDependencyManifest(
    {
      workspace_id: root.workspace_id,
      published_resource_kind: 'DEPLOYMENT_REVISION',
      resource_id: agentDeploymentId,
      resource_version_id: agentDeploymentRevisionId,
    },
    [root, experience],
  );
  const profile = makePolicyPin('deployment_profile');
  const grantPolicy = makePolicyPin('entry_grant');
  const scopePolicy = makePolicyPin('entry_scope');
  const revisionDraft = {
    schema_version: 'agent-deployment/1',
    deployment_kind: 'agent',
    workspace_id: root.workspace_id,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentDeploymentRevisionId,
    agent_id: root.resource_id,
    environment: 'development',
    ingress_channel: 'service_api',
    agent_release: root,
    experience_release: experience,
    policy_profile: profile,
    entry_grant_policy: grantPolicy,
    entry_scope_policy: scopePolicy,
    credential_mappings: [],
    credential_mapping_hash: calculateCredentialMappingSetHash('agent', []),
    conversation_contract_hash: hashA,
    dependency_manifest_hash: manifest.manifest_hash,
    change_set_hash: hashA,
  } as const;
  const revision = { ...revisionDraft, revision_contract_hash: canonicalSha256(revisionDraft) };
  const principal = {
    schema_version: 'caller-principal/1',
    kind: 'credential',
    credential_id: credentialId,
  } as const;
  const entryGrantId = '018f47f2-c541-7cc6-9292-4a2c35303e18';
  const snapshotDraft = {
    schema_version: 'agent-deployment-entry-admission-snapshot/1',
    deployment_kind: 'agent',
    entry_source_kind: 'service_credential',
    workspace_id: root.workspace_id,
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentDeploymentRevisionId,
    agent_deployment_revision_contract_hash: revision.revision_contract_hash,
    agent_release: root,
    experience_release: experience,
    environment: 'development',
    ingress_channel: 'service_api',
    admission_activation_epoch: 3,
    observed_revoke_epoch: 7,
    authenticated_principal: principal,
    credential_id: credentialId,
    credential_authorization_epoch: 5,
    workspace_authorization_epoch: 9,
    entry_grant_id: entryGrantId,
    entry_grant_authorization_epoch: 4,
    entry_credential_kind: 'service_api',
    entry_principal_mode: 'credential_service_principal',
    entry_audience: 'agent_runtime_api',
    entry_channel: 'service_api',
    entry_scope: 'agent:run:create',
    entry_target_cardinality: 'exactly_one_agent_deployment',
    policy_profile_contract_hash: profile.contract_hash,
    entry_scope_policy_contract_hash: scopePolicy.contract_hash,
    credential_mapping_hash: revision.credential_mapping_hash,
    dependency_manifest_hash: revision.dependency_manifest_hash,
  } as const;
  const snapshot = { ...snapshotDraft, snapshot_hash: canonicalSha256(snapshotDraft) };
  const enabled = closure.bindings.filter((binding) =>
    enabledPaths === undefined
      ? !closure.disabled_binding_paths.includes(binding.binding_path)
      : enabledPaths.includes(binding.binding_path),
  );
  if (enabled.some((binding) => binding.effective_policy.credential_requirements.length !== 0))
    throw new Error('compiler admission fixture requires credential-free bindings');
  const epochs = [
    {
      source_kind: 'agent_deployment_security',
      source_id: agentDeploymentId,
      source_subkey: '',
      observed_epoch: 7,
    },
    {
      source_kind: 'agent_entry_grant',
      source_id: entryGrantId,
      source_subkey: '',
      observed_epoch: 4,
    },
    { source_kind: 'credential', source_id: credentialId, source_subkey: '', observed_epoch: 5 },
    {
      source_kind: 'workspace_authorization',
      source_id: root.workspace_id,
      source_subkey: '',
      observed_epoch: 9,
    },
    ...[profile, grantPolicy, scopePolicy].map((policy) => ({
      source_kind: 'permission_policy',
      source_id: policy.policy_id,
      source_subkey: policy.policy_kind,
      observed_epoch: 1,
    })),
  ];
  for (const { kind, target } of [
    ...[
      root,
      experience,
      ...source.dependency_manifest.dependencies,
      ...closure.resource_nodes.filter((node) => node.node_role !== 'root').map((node) => node.pin),
    ].map((target) => ({
      kind: 'published_release',
      target,
    })),
    ...enabled.map((binding) => ({ kind: 'capability_release', target: binding.target })),
  ]) {
    const grantIdentity = canonicalSha256({
      schema_version: 'release-grant-identity/1',
      workspace_id: root.workspace_id,
      authenticated_principal: principal,
      target,
    });
    epochs.push({
      source_kind: `${kind}_state`,
      source_id: target.resource_version_id,
      source_subkey: target.published_resource_kind,
      observed_epoch: 1,
    });
    epochs.push({
      source_kind: `${kind}_grant`,
      source_id: `grant:${grantIdentity}`,
      source_subkey: grantIdentity,
      observed_epoch: 1,
    });
  }
  const key = (epoch: (typeof epochs)[number]) =>
    JSON.stringify([epoch.source_kind, epoch.source_id, epoch.source_subkey]);
  const epochSources = [...new Map(epochs.map((epoch) => [key(epoch), epoch])).values()].sort(
    (left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0),
  );
  const decisionDraft = {
    schema_version: 'admission-authorization-decision/1',
    decision_id: 'compiler-admission',
    workspace_id: root.workspace_id,
    deployment_kind: 'agent',
    deployment_id: agentDeploymentId,
    deployment_revision_id: agentDeploymentRevisionId,
    deployment_revision_contract_hash: revision.revision_contract_hash,
    capability_closure_hash: closure.closure_hash,
    admission_snapshot_hash: snapshot.snapshot_hash,
    admission_activation_epoch: 3,
    expires_at: '2099-01-01T00:00:00.000Z',
    epoch_sources: epochSources,
    allowed_bindings: enabled.map((binding) => {
      const { credential_requirements: _requirements, ...policy } = binding.effective_policy;
      return {
        binding_path: binding.binding_path,
        policy_ceiling: {
          schema_version: 'capability-policy-ceiling/1',
          credential_allowances: [],
          ...policy,
        },
        credential_bindings: [],
      };
    }),
  };
  const decision = {
    ...decisionDraft,
    decision_hash: canonicalSha256ExcludingRootKeys(decisionDraft, ['decision_hash']),
  };
  return {
    executable_source: rootInput,
    closure,
    deployment_revision: revision,
    admission_snapshot: snapshot,
    authorization_decision: decision,
    entry_purpose: 'agent_run' as const,
    expected_admission_epochs: { admission_activation_epoch: 3, observed_revoke_epoch: 7 },
    expected_authorization_epoch_sources: epochSources,
    admission_clock: {
      source: 'database_transaction_clock' as const,
      observed_at: '2026-09-03T00:00:00.000Z',
    },
  };
}
