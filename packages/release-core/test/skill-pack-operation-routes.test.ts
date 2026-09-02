import { describe, expect, it } from 'vitest';

import {
  canonicalSha256,
  deriveDependencyManifest,
  prepareExecutableSource,
  preparePinnedDependencyGraph,
  prepareSkillPackSource,
} from '../src/index.js';
import {
  prepareGraphBoundSkillPackOperationRoutes,
  prepareSkillPackOperationRoutes,
} from '../src/skill-pack-operation-routes.js';
import { richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';
import { skillPackSource } from './skill-pack-source-fixtures.js';

function candidate(document: unknown) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function matchingSources() {
  const packInput = skillPackSource();
  const pack = prepareSkillPackSource(packInput);
  const agent = richAgentSource();
  const binding = agent.capability_bindings.find((item) => item.kind === 'skill_pack');
  if (binding === undefined) throw new Error('fixture is missing its Skill Pack Binding');
  binding.pin = pack.full_pin;
  binding.manual = { ...pack.document.manual, hash: pack.component_hashes.manual };
  binding.input_schema = pack.document.input_schema;
  binding.output_schema = pack.document.output_schema;
  binding.config = {
    schema_version: 'skill-pack-binding/1',
    member_projection_hash: pack.member_projection_hash,
    exposed_operations: pack.exposed_operations.map((operation) => ({
      exposed_operation_id: operation.exposed_operation_id,
      exposed_operation_contract_hash: operation.exposed_operation_contract_hash,
    })),
  };
  return { agent, packInput, pack, binding };
}

function graphFixture() {
  const sources = matchingSources();
  const prepared = prepareSkillPackOperationRoutes(candidate(sources.agent), sources.packInput);
  const rootDependencies = [prepared.dependency];
  const { contract_hash: _hash, binding_mode: _mode, ...owner } = prepared.dependency;
  const graphCandidate = {
    schema_version: 'pinned-dependency-graph-candidate/1',
    root: prepared.root,
    root_dependencies: rootDependencies,
    resources: [
      {
        schema_version: 'pinned-dependency-record/1',
        pin: prepared.dependency,
        publication_state: 'sealed',
        dependency_manifest: deriveDependencyManifest(owner, []),
      },
    ],
  };
  return {
    ...sources,
    graphCandidate,
    graph: preparePinnedDependencyGraph(graphCandidate),
  };
}

describe('Skill Pack operation route preparation', () => {
  it('links the exact selected exposure, Pack path, member path and operation hashes', () => {
    const { agent, packInput, pack } = matchingSources();
    const result = prepareSkillPackOperationRoutes(candidate(agent), packInput);
    const route = result.routes[0];
    const exposure = pack.exposed_operations[0];
    expect(result.routes).toHaveLength(1);
    expect(route).toMatchObject({
      exposed_operation_id: exposure?.exposed_operation_id,
      exposed_operation_contract_hash: exposure?.exposed_operation_contract_hash,
      member_target: exposure?.member_target,
      member_operation_contract_hash: exposure?.member_operation_contract.contract_hash,
    });
    expect(route?.pack_binding_path).toMatch(/^bp1\.[A-Za-z0-9_-]{43}$/u);
    expect(route?.member_binding_path).toMatch(/^bp1\.[A-Za-z0-9_-]{43}$/u);
    expect(route?.pack_binding_path).not.toBe(route?.member_binding_path);
  });

  it('defines route_hash as canonical SHA-256 of the complete versioned route preimage', () => {
    const { agent, packInput } = matchingSources();
    const route = prepareSkillPackOperationRoutes(candidate(agent), packInput).routes[0];
    if (route === undefined) throw new Error('fixture route is missing');
    const { route_hash: _routeHash, ...content } = route;
    expect(route.route_hash).toBe(
      canonicalSha256({ schema_version: 'skill-pack-operation-route-preimage/1', ...content }),
    );
  });

  it('attaches the exact member operation pin to the matching Pack Binding path', () => {
    const { agent, packInput, pack, binding } = matchingSources();
    const result = prepareSkillPackOperationRoutes(candidate(agent), packInput);
    expect(result.binding_operations).toEqual([
      {
        binding_id: binding.binding_id,
        pack_binding_path: result.routes[0]?.pack_binding_path,
        operation_contracts: [pack.exposed_operations[0]?.member_operation_contract],
      },
    ]);
  });

  it('deduplicates one member operation exposed under multiple route aliases', () => {
    const packInput = skillPackSource();
    const exposure = packInput.document.exposures[0];
    if (exposure === undefined) throw new Error('fixture exposure is missing');
    packInput.document.exposures.push({
      ...structuredClone(exposure),
      exposed_operation_id: 'search-again',
    });
    const pack = prepareSkillPackSource(packInput);
    const agent = richAgentSource();
    const binding = agent.capability_bindings.find((item) => item.kind === 'skill_pack');
    if (binding === undefined) throw new Error('fixture Pack Binding is missing');
    binding.pin = pack.full_pin;
    binding.manual = { ...pack.document.manual, hash: pack.component_hashes.manual };
    binding.input_schema = pack.document.input_schema;
    binding.output_schema = pack.document.output_schema;
    binding.config = {
      schema_version: 'skill-pack-binding/1',
      member_projection_hash: pack.member_projection_hash,
      exposed_operations: pack.exposed_operations.map((operation) => ({
        exposed_operation_id: operation.exposed_operation_id,
        exposed_operation_contract_hash: operation.exposed_operation_contract_hash,
      })),
    };
    const result = prepareSkillPackOperationRoutes(candidate(agent), packInput);
    expect(result.routes).toHaveLength(2);
    expect(result.binding_operations[0]?.operation_contracts).toHaveLength(1);
  });

  it('isolates identical Pack operations under distinct root Binding paths', () => {
    const { agent, packInput, binding } = matchingSources();
    const second = structuredClone(binding);
    second.binding_id = 'pack-second';
    agent.capability_bindings.push(second);
    agent.strategy.allowed_capability_binding_ids.push(second.binding_id);
    const prepared = prepareSkillPackOperationRoutes(candidate(agent), packInput);
    const routes = prepared.routes;
    expect(routes).toHaveLength(2);
    expect(routes[0]?.pack_binding_path).not.toBe(routes[1]?.pack_binding_path);
    expect(routes[0]?.member_binding_path).not.toBe(routes[1]?.member_binding_path);
    expect(routes[0]?.route_hash).not.toBe(routes[1]?.route_hash);
    expect(prepared.binding_operations).toHaveLength(2);
  });

  it('changes route identity when the root resource identity changes', () => {
    const first = matchingSources();
    const firstRoute = prepareSkillPackOperationRoutes(candidate(first.agent), first.packInput)
      .routes[0];
    const second = matchingSources();
    second.agent.agent_release_id = '00000000-0000-7000-8000-000000000099';
    const secondRoute = prepareSkillPackOperationRoutes(candidate(second.agent), second.packInput)
      .routes[0];
    expect(secondRoute?.pack_binding_path).not.toBe(firstRoute?.pack_binding_path);
    expect(secondRoute?.member_binding_path).not.toBe(firstRoute?.member_binding_path);
    expect(secondRoute?.route_hash).not.toBe(firstRoute?.route_hash);
  });

  it('rejects stale selected exposure projections before route compilation', () => {
    const { agent, packInput, binding } = matchingSources();
    binding.config.member_projection_hash =
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(() => prepareSkillPackOperationRoutes(candidate(agent), packInput)).toThrow(
      'CLOSURE_SOURCE_MISMATCH',
    );
  });

  it('retains disabled Pack routes as source facts for later effective-policy compilation', () => {
    const { agent, packInput, binding } = matchingSources();
    binding.enabled = false;
    const result = prepareSkillPackOperationRoutes(candidate(agent), packInput);
    expect(result.routes).toHaveLength(1);
  });

  it('is deeply frozen and emits no aggregate closure authority hash', () => {
    const { agent, packInput } = matchingSources();
    const result = prepareSkillPackOperationRoutes(candidate(agent), packInput);
    expect(result).not.toHaveProperty('closure_hash');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.routes)).toBe(true);
    expect(Object.isFrozen(result.routes[0]?.member_target)).toBe(true);
    expect(Object.isFrozen(result.binding_operations[0]?.operation_contracts)).toBe(true);
  });

  it('uses the self-consistent Agent contract after changing root identity', () => {
    const { agent, packInput } = matchingSources();
    agent.agent_release_id = '00000000-0000-7000-8000-000000000099';
    const prepared = prepareExecutableSource(candidate(agent));
    const result = prepareSkillPackOperationRoutes(candidate(agent), packInput);
    expect(result.root.pin.contract_hash).toBe(prepared.root.pin.contract_hash);
  });

  it('binds the prepared route slice to the exact recomputed direct graph edge', () => {
    const value = graphFixture();
    const result = prepareGraphBoundSkillPackOperationRoutes(
      value.graph,
      value.graphCandidate,
      candidate(value.agent),
      value.packInput,
    );
    expect(result.graph_binding.graph_hash).toBe(value.graph.graph_hash);
    expect(result.graph_binding.dependency_node.pin).toEqual(result.prepared_routes.dependency);
    expect(result.prepared_routes.routes).toHaveLength(1);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects route preparation when the Pack is not a direct graph dependency', () => {
    const value = graphFixture();
    const changed = structuredClone(value.graphCandidate);
    changed.root_dependencies = [];
    changed.resources = [];
    const changedGraph = preparePinnedDependencyGraph(changed);
    expect(() =>
      prepareGraphBoundSkillPackOperationRoutes(
        changedGraph,
        changed,
        candidate(value.agent),
        value.packInput,
      ),
    ).toThrow('CAPABILITY_DEPENDENCY_UNRESOLVED');
  });
});
