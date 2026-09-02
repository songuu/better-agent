import type { CapabilityBindingV1, OperationContractPinV1 } from '@better-agent/domain-contracts';

import { deepFreezeJson, publishedResourcePinKey } from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';
import { prepareLeafResourceSource, verifyLeafResourceBindings } from './leaf-resource-source.js';
import { prepareRootBindingPaths } from './root-binding-paths.js';

interface PreparedAgentLeafBindingOperationsV1 {
  readonly schema_version: 'prepared-agent-leaf-binding-operations/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly dependency: ReturnType<typeof prepareLeafResourceSource>['full_pin'];
  readonly intrinsic_policy: ReturnType<typeof prepareLeafResourceSource>['intrinsic_policy'];
  readonly bindings: readonly {
    readonly binding_id: string;
    readonly binding_kind: CapabilityBindingV1['kind'];
    readonly binding_path: `bp1.${string}`;
    readonly enabled: boolean;
    readonly operation_contracts: readonly OperationContractPinV1[];
  }[];
}

function unresolved(): never {
  throw new ReleaseCoreError(
    'CAPABILITY_DEPENDENCY_UNRESOLVED',
    '$.dependency',
    'leaf source is not an exact compatible Agent Binding dependency',
  );
}

/** Collect one verified leaf operation under every exact matching root Binding path. */
export function prepareAgentLeafBindingOperations(
  rootInput: unknown,
  dependencyInput: unknown,
): PreparedAgentLeafBindingOperationsV1 {
  const rootSource = prepareExecutableSource(rootInput);
  if (rootSource.root.pin.published_resource_kind !== 'AGENT_RELEASE') unresolved();
  const preliminaryLeaf = prepareLeafResourceSource(dependencyInput);
  const expectedBindingKind = {
    KNOWLEDGE_INDEX_GENERATION: 'knowledge',
    DATABASE_OPERATION_RELEASE: 'database',
    PLUGIN_TOOL_RELEASE: 'plugin',
    A2A_AGENT_RELEASE: 'subagent',
  } as const;
  const kind = expectedBindingKind[preliminaryLeaf.full_pin.published_resource_kind];
  const document = rootSource.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const targetKey = publishedResourcePinKey(preliminaryLeaf.full_pin);
  const matching = document.capability_bindings.filter(
    (binding) =>
      binding.kind === kind &&
      publishedResourcePinKey(binding.pin) === targetKey &&
      (kind !== 'subagent' ||
        (binding.kind === 'subagent' && binding.target_kind === 'external_a2a')),
  );
  if (matching.length === 0) unresolved();
  const leaf = verifyLeafResourceBindings(matching, dependencyInput);
  const matchingIds = new Set(matching.map((binding) => binding.binding_id));
  const paths = prepareRootBindingPaths(rootInput);
  return deepFreezeJson({
    schema_version: 'prepared-agent-leaf-binding-operations/1',
    root: rootSource.root,
    dependency: leaf.full_pin,
    intrinsic_policy: leaf.intrinsic_policy,
    bindings: paths.bindings.map((binding) => ({
      binding_id: binding.binding_id,
      binding_kind: binding.binding_kind,
      binding_path: binding.binding_path,
      enabled: binding.enabled,
      operation_contracts: matchingIds.has(binding.binding_id) ? [leaf.operation_contract] : [],
    })),
  });
}
