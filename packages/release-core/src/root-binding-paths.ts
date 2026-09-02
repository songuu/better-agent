import type {
  BindingPathSegmentV1Schema,
  CapabilityBindingV1,
} from '@better-agent/domain-contracts';

import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { createClosureIdentityRegistry } from './closure-identity.js';
import type { PreparedExecutableSourceV1 } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';

type BindingPathSegmentV1 = ReturnType<typeof BindingPathSegmentV1Schema.parse>;

interface CompiledRootBindingPathV1 {
  readonly binding_id: string;
  readonly binding_kind: CapabilityBindingV1['kind'];
  readonly binding_path: `bp1.${string}`;
  readonly binding_path_segments: readonly BindingPathSegmentV1[];
  readonly enabled: boolean;
}

interface RootBindingPaths {
  readonly root: PreparedExecutableSourceV1['root'];
  readonly bindings: readonly CompiledRootBindingPathV1[];
  readonly source_disabled_binding_paths: readonly `bp1.${string}`[];
}

/** Compile the root Agent namespace. Nested Flow/Pack/SubAgent segments are appended by later expansion. */
export function compileRootBindingPathsFromPreparedSource(
  source: PreparedExecutableSourceV1,
): RootBindingPaths {
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE')
    throw new ReleaseCoreError(
      'CLOSURE_SOURCE_INVALID',
      '$.document',
      'root Binding paths require an Agent executable source',
    );

  const document = source.preimage.document as unknown as {
    capability_bindings: readonly CapabilityBindingV1[];
  };
  const identity = createClosureIdentityRegistry();
  identity.registerResourceNode(source.root.pin);
  const rootSegment: BindingPathSegmentV1 = { segment_kind: 'root', pin: source.root.pin };
  const bindings = document.capability_bindings
    .map((binding): CompiledRootBindingPathV1 => {
      const segments: BindingPathSegmentV1[] = [
        rootSegment,
        {
          segment_kind: 'binding',
          owner: { owner_kind: 'root', pin: source.root.pin },
          binding_kind: binding.kind,
          local_binding_id: binding.binding_id,
        },
      ];
      return {
        binding_id: binding.binding_id,
        binding_kind: binding.kind,
        binding_path: identity.registerBindingPath(segments),
        binding_path_segments: segments,
        enabled: binding.enabled,
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.binding_path, right.binding_path));
  const source_disabled_binding_paths = bindings
    .filter((binding) => !binding.enabled)
    .map((binding) => binding.binding_path)
    .sort(compareCanonicalStrings);
  return deepFreezeJson({
    root: source.root,
    bindings,
    source_disabled_binding_paths,
  });
}
