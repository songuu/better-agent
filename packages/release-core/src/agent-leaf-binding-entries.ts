import {
  CompiledBindingEntryV1Schema,
  type CapabilityBindingV1,
} from '@better-agent/domain-contracts';

import { prepareAgentLeafBindingOperations } from './agent-leaf-binding-operations.js';
import { prepareAgentBindingApprovalGate } from './agent-gate-specs.js';
import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import {
  meetCapabilityPolicyCeilings,
  normalizeCapabilityPolicyCeiling,
  resolveEffectiveCapabilityPolicy,
} from './capability-policy.js';
import { canonicalResourceNodeId } from './closure-identity.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';

type CompiledBindingEntryV1 = ReturnType<typeof CompiledBindingEntryV1Schema.parse>;

interface PreparedAgentLeafBindingEntriesV1 {
  readonly schema_version: 'prepared-agent-leaf-binding-entries/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly dependency: ReturnType<typeof prepareAgentLeafBindingOperations>['dependency'];
  readonly entries: readonly CompiledBindingEntryV1[];
}

interface PolicyInput {
  readonly workspace_ceiling: unknown;
  readonly root_ceiling: unknown;
  readonly binding_ceilings: readonly {
    readonly binding_path: string;
    readonly ceiling: unknown;
  }[];
}

function notClosed(path = '$.policy'): never {
  throw new ReleaseCoreError(
    'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    path,
    'leaf Binding entry inputs do not form one exact closed path projection',
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parsePolicyInput(input: unknown): PolicyInput {
  const snapshot = boundedDataSnapshot(input, 'policy');
  if (
    !plainRecord(snapshot) ||
    !exactKeys(snapshot, [
      'schema_version',
      'workspace_ceiling',
      'root_ceiling',
      'binding_ceilings',
    ]) ||
    snapshot.schema_version !== 'agent-leaf-binding-policy-input/1' ||
    !Array.isArray(snapshot.binding_ceilings)
  )
    notClosed();
  const bindingCeilings = snapshot.binding_ceilings.map((item, index) => {
    if (
      !plainRecord(item) ||
      !exactKeys(item, ['binding_path', 'ceiling']) ||
      typeof item.binding_path !== 'string'
    )
      notClosed(`$.policy.binding_ceilings[${index}]`);
    return { binding_path: item.binding_path, ceiling: item.ceiling };
  });
  return {
    workspace_ceiling: normalizeCapabilityPolicyCeiling(snapshot.workspace_ceiling),
    root_ceiling: normalizeCapabilityPolicyCeiling(snapshot.root_ceiling),
    binding_ceilings: bindingCeilings,
  };
}

/**
 * Assemble complete root Binding entries for one independently verified leaf dependency.
 * Typed ceilings are compiler facts only; registry/admission provenance remains external.
 */
export function prepareAgentLeafBindingEntries(
  rootInput: unknown,
  dependencyInput: unknown,
  policyInput: unknown,
): PreparedAgentLeafBindingEntriesV1 {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed('$.root');
  const projection = prepareAgentLeafBindingOperations(rootInput, dependencyInput);
  const rootPaths = prepareRootBindingPaths(rootInput);
  const policies = parsePolicyInput(policyInput);
  const document = source.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const selectedPaths = projection.bindings.filter(
    (binding) => binding.operation_contracts.length > 0,
  );
  if (selectedPaths.length === 0 || policies.binding_ceilings.length !== selectedPaths.length)
    notClosed();
  const uniquePolicyPaths = new Set(policies.binding_ceilings.map((item) => item.binding_path));
  if (uniquePolicyPaths.size !== policies.binding_ceilings.length) notClosed();
  const sharedCeiling = meetCapabilityPolicyCeilings(
    policies.workspace_ceiling,
    policies.root_ceiling,
  );
  const dependencyNodeId = canonicalResourceNodeId(projection.dependency);
  const entries = selectedPaths
    .map((path) => {
      const binding = document.capability_bindings.find(
        (candidate) => candidate.binding_id === path.binding_id,
      );
      const compiledPath = rootPaths.bindings.find(
        (candidate) => candidate.binding_path === path.binding_path,
      );
      const policy = policies.binding_ceilings.find(
        (candidate) => candidate.binding_path === path.binding_path,
      );
      if (binding === undefined || compiledPath === undefined || policy === undefined) notClosed();
      const approval = prepareAgentBindingApprovalGate(
        rootInput,
        binding.binding_id,
        path.operation_contracts,
      );
      const effectivePolicy = resolveEffectiveCapabilityPolicy(
        meetCapabilityPolicyCeilings(sharedCeiling, policy.ceiling),
        {
          ...projection.intrinsic_policy,
          approval_required:
            projection.intrinsic_policy.approval_required ||
            binding.side_effect.approval === 'required',
        },
      );
      if (
        effectivePolicy.side_effect.approval === 'required' &&
        approval.approval_gate_spec === undefined
      )
        notClosed('$.entry.approval_gate_spec');
      const candidate = {
        binding_path_encoding_version: 'binding-path-lp-utf8/1' as const,
        binding_path: path.binding_path,
        binding_path_segments: compiledPath.binding_path_segments,
        binding_id: binding.binding_id,
        binding_kind: binding.kind,
        target: binding.pin,
        config_schema_version: binding.config.schema_version,
        config_hash: canonicalSha256(binding.config),
        source_contract_hash: projection.dependency.contract_hash,
        effective_policy: effectivePolicy,
        operation_contracts: path.operation_contracts,
        dependency_node_ids: [dependencyNodeId],
        ...(approval.approval_gate_spec === undefined
          ? {}
          : { approval_gate_spec: approval.approval_gate_spec }),
        ...(binding.kind === 'subagent' && binding.config.invocation === 'async'
          ? { async_child_policy_hash: canonicalSha256(binding.config.async_child) }
          : {}),
      };
      const parsed = CompiledBindingEntryV1Schema.safeParse(candidate);
      if (!parsed.success) notClosed('$.entry');
      return parsed.data;
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  if (entries.length !== policies.binding_ceilings.length) notClosed();
  return deepFreezeJson({
    schema_version: 'prepared-agent-leaf-binding-entries/1',
    root: source.root,
    dependency: projection.dependency,
    entries,
  });
}
