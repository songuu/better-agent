import { SkillPackOperationRouteV1Schema } from '@better-agent/domain-contracts';

import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';
import { canonicalSha256 } from './hash.js';
import { prepareGraphBoundDirectDependency } from './pinned-graph-slice.js';
import { prepareAgentSkillPackDependencyPaths } from './root-binding-paths.js';

type SkillPackOperationRouteV1 = ReturnType<typeof SkillPackOperationRouteV1Schema.parse>;
type SkillPackMemberOperationV1 = ReturnType<
  typeof prepareAgentSkillPackDependencyPaths
>['exposed_operations'][number]['member_operation_contract'];

interface PreparedSkillPackOperationRoutesV1 {
  readonly schema_version: 'prepared-skill-pack-operation-routes/1';
  readonly root: ReturnType<typeof prepareAgentSkillPackDependencyPaths>['root'];
  readonly dependency: ReturnType<typeof prepareAgentSkillPackDependencyPaths>['dependency'];
  readonly routes: readonly SkillPackOperationRouteV1[];
  readonly binding_operations: readonly {
    readonly binding_id: string;
    readonly pack_binding_path: `bp1.${string}`;
    readonly operation_contracts: readonly SkillPackMemberOperationV1[];
  }[];
}

interface PreparedGraphBoundSkillPackOperationRoutesV1 {
  readonly schema_version: 'graph-bound-skill-pack-operation-routes/1';
  readonly graph_binding: ReturnType<typeof prepareGraphBoundDirectDependency>;
  readonly prepared_routes: PreparedSkillPackOperationRoutesV1;
}

function unresolved(): never {
  throw new ReleaseCoreError(
    'SKILL_PACK_OPERATION_UNRESOLVED',
    '$.routes',
    'selected Pack operation does not resolve to one exact member path',
  );
}

/**
 * Compile exact Pack exposure-to-member routes without claiming publisher or registry authority.
 * Disabled source paths remain routable facts; effective policy decides runtime availability later.
 */
export function prepareSkillPackOperationRoutes(
  rootInput: unknown,
  dependencyInput: unknown,
): PreparedSkillPackOperationRoutesV1 {
  const paths = prepareAgentSkillPackDependencyPaths(rootInput, dependencyInput);
  const routes = paths.bindings
    .flatMap((binding) =>
      binding.selected_exposed_operations.map((selected) => {
        const exposures = paths.exposed_operations.filter(
          (exposure) =>
            exposure.exposed_operation_id === selected.exposed_operation_id &&
            exposure.exposed_operation_contract_hash === selected.exposed_operation_contract_hash,
        );
        if (exposures.length !== 1) unresolved();
        const exposure = exposures[0];
        if (exposure === undefined) unresolved();
        const members = binding.members.filter(
          (member) => member.member_binding_id === exposure.member_binding_id,
        );
        if (members.length !== 1) unresolved();
        const member = members[0];
        if (member === undefined) unresolved();
        const content = {
          pack_binding_path: binding.binding_path,
          exposed_operation_id: exposure.exposed_operation_id,
          exposed_operation_contract_hash: exposure.exposed_operation_contract_hash,
          member_binding_path: member.member_binding_path,
          member_target: exposure.member_target,
          member_operation_contract_hash: exposure.member_operation_contract.contract_hash,
        };
        const route = SkillPackOperationRouteV1Schema.safeParse({
          ...content,
          route_hash: canonicalSha256({
            schema_version: 'skill-pack-operation-route-preimage/1',
            ...content,
          }),
        });
        if (!route.success) unresolved();
        return route.data;
      }),
    )
    .sort((left, right) => {
      const byPath = compareCanonicalStrings(left.pack_binding_path, right.pack_binding_path);
      return byPath === 0
        ? compareCanonicalStrings(left.exposed_operation_id, right.exposed_operation_id)
        : byPath;
    });
  const bindingOperations = paths.bindings
    .filter((binding) => binding.selected_exposed_operations.length > 0)
    .map((binding) => {
      const operations = new Map<string, SkillPackMemberOperationV1>();
      for (const selected of binding.selected_exposed_operations) {
        const exposure = paths.exposed_operations.find(
          (candidate) =>
            candidate.exposed_operation_id === selected.exposed_operation_id &&
            candidate.exposed_operation_contract_hash === selected.exposed_operation_contract_hash,
        );
        if (exposure === undefined) unresolved();
        operations.set(
          exposure.member_operation_contract.contract_hash,
          exposure.member_operation_contract,
        );
      }
      return {
        binding_id: binding.binding_id,
        pack_binding_path: binding.binding_path,
        operation_contracts: [...operations.values()].sort((left, right) =>
          compareCanonicalStrings(left.contract_hash, right.contract_hash),
        ),
      };
    })
    .sort((left, right) =>
      compareCanonicalStrings(left.pack_binding_path, right.pack_binding_path),
    );
  return deepFreezeJson({
    schema_version: 'prepared-skill-pack-operation-routes/1',
    root: paths.root,
    dependency: paths.dependency,
    routes,
    binding_operations: bindingOperations,
  });
}

/** Require the prepared Pack route slice to be the root's exact direct graph dependency. */
export function prepareGraphBoundSkillPackOperationRoutes(
  expectedGraph: unknown,
  graphCandidate: unknown,
  rootInput: unknown,
  dependencyInput: unknown,
): PreparedGraphBoundSkillPackOperationRoutesV1 {
  const preparedRoutes = prepareSkillPackOperationRoutes(rootInput, dependencyInput);
  const graphBinding = prepareGraphBoundDirectDependency(
    expectedGraph,
    graphCandidate,
    preparedRoutes.root.pin,
    preparedRoutes.dependency,
  );
  return deepFreezeJson({
    schema_version: 'graph-bound-skill-pack-operation-routes/1',
    graph_binding: graphBinding,
    prepared_routes: preparedRoutes,
  });
}
