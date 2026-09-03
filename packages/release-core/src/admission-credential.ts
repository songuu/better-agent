import type {
  AdmissionAuthorizationDecisionV1,
  AgentDeploymentCredentialMappingV1,
  FlowDeploymentCredentialMappingV1,
  CredentialRequirementV1,
} from '@better-agent/domain-contracts';
import { prepareCredentialMappings } from './credential-mapping.js';
import { canonicalSha256 } from './hash.js';
import { ReleaseCoreError } from './errors.js';

type Credential =
  AdmissionAuthorizationDecisionV1['allowed_bindings'][number]['credential_bindings'][number];
type Mapping = AgentDeploymentCredentialMappingV1 | FlowDeploymentCredentialMappingV1;

export function credentialMaterialIdentityHash(
  credential: Omit<Credential, 'requirement_id' | 'mapping_hash' | 'epoch_source'>,
) {
  return canonicalSha256({
    schema_version: 'credential-material-identity/1',
    credential_id: credential.credential_id,
    credential_version_id: credential.credential_version_id,
    provider_id: credential.provider_id,
    audience: credential.audience,
    granted_scopes: credential.granted_scopes,
    principal_mode: credential.principal_mode,
    credential_subject_id: credential.credential_subject_id,
    credential_handle_hash: credential.credential_handle_hash,
    material_fingerprint_hash: credential.material_fingerprint_hash,
  });
}

/** Internal parsed-fact join; the resolver owns bounded parsing and the independently read epoch set. */
export function verifyAdmissionCredential(input: {
  deployment_kind: 'agent' | 'flow';
  workspace_id: string;
  caller: { kind: 'service' } | { kind: 'browser'; principal_id: string };
  requirement: CredentialRequirementV1;
  mapping: Mapping | undefined;
  credential: Credential | undefined;
  epoch_evidence: ReadonlySet<string>;
  path: string;
}) {
  const fail = (reason: string): never => {
    throw new ReleaseCoreError('RELEASE_RESOLVED_PLAN_INVALID', input.path, reason);
  };
  const { mapping, credential } = input;
  if (mapping === undefined || credential === undefined)
    return fail('every credential requirement needs one exact mapping and material');
  prepareCredentialMappings({
    deployment_kind: input.deployment_kind,
    workspace_id: input.workspace_id,
    requirements: [input.requirement],
    mappings: [mapping],
  });
  if (input.caller.kind === 'service' && mapping.principal_mode === 'caller_delegated')
    fail('service entry cannot borrow an authenticated end-user credential mapping');
  if (input.caller.kind === 'browser' && mapping.principal_mode === 'service_principal')
    fail('interactive entry cannot borrow a background service principal');
  const expectedSubject =
    mapping.principal_mode === 'service_principal'
      ? mapping.service_principal_id
      : mapping.principal_mode === 'team_shared'
        ? mapping.team_credential_policy_id
        : input.caller.kind === 'browser'
          ? input.caller.principal_id
          : undefined;
  if (
    credential.requirement_id !== input.requirement.requirement_id ||
    credential.mapping_hash !== mapping.mapping_hash ||
    credential.principal_mode !== mapping.principal_mode ||
    credential.credential_subject_id !== expectedSubject ||
    credential.provider_id !== mapping.provider_id ||
    credential.audience !== mapping.audience ||
    canonicalSha256([...credential.granted_scopes].sort()) !==
      canonicalSha256([...mapping.allowed_scopes].sort())
  )
    fail(
      'resolved credential does not match its exact Deployment mapping and authenticated subject',
    );
  if (
    credential.epoch_source.source_kind !== 'credential' ||
    credential.epoch_source.source_id !== credential.credential_id ||
    credential.epoch_source.source_subkey !== credentialMaterialIdentityHash(credential)
  )
    fail('credential epoch must bind the exact credential identity and material version');
  if (!input.epoch_evidence.has(canonicalSha256(credential.epoch_source)))
    fail('resolved credential epoch is absent from the authoritative decision vector');
  return mapping.mapping_hash;
}
