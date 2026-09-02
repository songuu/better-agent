import { describe, expect, it } from 'vitest';

import {
  canonicalBindingPath,
  compareCanonicalStrings,
  prepareExecutableSource,
  ReleaseCoreError,
} from '../src/index.js';
import { compileRootBindingPathsFromPreparedSource } from '../src/root-binding-paths.js';
import { nestedFlowSource, richAgentSource } from './executable-source-fixtures.js';
import { workspaceId } from './fixtures.js';

function candidate(document: unknown = richAgentSource()) {
  return { schema_version: 'executable-source-candidate/1', workspace_id: workspaceId, document };
}

function requiredBinding(source: ReturnType<typeof richAgentSource>, index: number) {
  const binding = source.capability_bindings[index];
  if (binding === undefined) throw new Error(`fixture is missing Binding ${index}`);
  return binding;
}

function compile(document: unknown = richAgentSource()) {
  return compileRootBindingPathsFromPreparedSource(prepareExecutableSource(candidate(document)));
}

describe('root Binding path compilation', () => {
  it('compiles every Agent capability Binding into a canonical typed path', () => {
    const source = richAgentSource();
    const prepared = prepareExecutableSource(candidate(source));
    const result = compileRootBindingPathsFromPreparedSource(prepared);
    expect(result.bindings).toHaveLength(richAgentSource().capability_bindings.length);
    for (const binding of result.bindings) {
      const declared = source.capability_bindings.find(
        (candidateBinding) => candidateBinding.binding_id === binding.binding_id,
      );
      if (declared === undefined) throw new Error('compiled Binding is absent from fixture source');
      const expectedSegments = [
        { segment_kind: 'root' as const, pin: prepared.root.pin },
        {
          segment_kind: 'binding' as const,
          owner: { owner_kind: 'root' as const, pin: prepared.root.pin },
          binding_kind: declared.kind,
          local_binding_id: declared.binding_id,
        },
      ];
      expect(binding.binding_path_segments).toEqual(expectedSegments);
      expect(binding.binding_path).toBe(canonicalBindingPath(expectedSegments));
    }
  });

  it('preserves exact local IDs without exposing them in the opaque path', () => {
    const source = richAgentSource();
    const target = requiredBinding(source, 0);
    const previous = target.binding_id;
    target.binding_id = '含/冒号:prefix';
    source.strategy.allowed_capability_binding_ids =
      source.strategy.allowed_capability_binding_ids.map((value) =>
        value === previous ? '含/冒号:prefix' : value,
      );
    for (const skill of source.instruction_skill_bindings)
      skill.allowed_capability_binding_ids = skill.allowed_capability_binding_ids.map((value) =>
        value === previous ? '含/冒号:prefix' : value,
      );
    for (const handle of source.public_capability_handles)
      if (handle.binding_id === previous) handle.binding_id = '含/冒号:prefix';
    const [binding] = compile(source).bindings.filter(
      (item) => item.binding_id === '含/冒号:prefix',
    );
    expect(binding?.binding_path).toMatch(/^bp1\.[A-Za-z0-9_-]{43}$/u);
    expect(binding?.binding_path).not.toContain('含');
  });

  it('separates identical local IDs under different root identities', () => {
    const first = compile();
    const changed = richAgentSource();
    changed.agent_release_id = '00000000-0000-7000-8000-000000000099';
    const second = compile(changed);
    expect(second.bindings[0]?.binding_path).not.toBe(first.bindings[0]?.binding_path);
  });

  it('is stable under source Binding permutation', () => {
    const source = richAgentSource();
    source.capability_bindings.reverse();
    expect(compile(source)).toEqual(compile());
  });

  it('sorts by canonical opaque path rather than local declaration order', () => {
    const result = compile();
    expect(result.bindings.map((binding) => binding.binding_path)).toEqual(
      result.bindings
        .map((binding) => binding.binding_path)
        .sort((left, right) => compareCanonicalStrings(left, right)),
    );
  });

  it('records disabled paths and only disabled paths', () => {
    const source = richAgentSource();
    requiredBinding(source, 1).enabled = false;
    const result = compile(source);
    const disabledDeclaration = requiredBinding(source, 1);
    const prepared = prepareExecutableSource(candidate(source));
    const disabledPath = canonicalBindingPath([
      { segment_kind: 'root', pin: prepared.root.pin },
      {
        segment_kind: 'binding',
        owner: { owner_kind: 'root', pin: prepared.root.pin },
        binding_kind: disabledDeclaration.kind,
        local_binding_id: disabledDeclaration.binding_id,
      },
    ]);
    expect(result.source_disabled_binding_paths).toEqual([disabledPath]);
    for (const binding of result.bindings)
      expect(binding.enabled).toBe(binding.binding_id !== disabledDeclaration.binding_id);
  });

  it('does not treat disabled Bindings as absent from the immutable namespace', () => {
    const source = richAgentSource();
    requiredBinding(source, 1).enabled = false;
    expect(compile(source).bindings).toHaveLength(source.capability_bindings.length);
  });

  it('does not expose a standalone hash that could be mistaken for closure authority', () => {
    expect(compile()).not.toHaveProperty('index_hash');
  });

  it('returns a deeply immutable snapshot', () => {
    const result = compile();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bindings)).toBe(true);
    expect(Object.isFrozen(result.bindings[0]?.binding_path_segments)).toBe(true);
    expect(Object.isFrozen(result.bindings[0])).toBe(true);
    expect(Object.isFrozen(result.bindings[0]?.binding_path_segments[0])).toBe(true);
    expect(Object.isFrozen(result.root.pin)).toBe(true);
  });

  it('rejects Flow roots because their Binding namespace is node-scoped', () => {
    try {
      compile(nestedFlowSource());
      throw new Error('expected Flow rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseCoreError);
      expect(error).toMatchObject({ code: 'CLOSURE_SOURCE_INVALID', path: '$.document' });
    }
  });

  it('supports an Agent with an empty capability namespace', () => {
    const source = richAgentSource();
    source.capability_bindings = [];
    source.strategy.allowed_capability_binding_ids = [];
    source.instruction_skill_bindings = [];
    source.public_capability_handles = [];
    expect(compile(source)).toMatchObject({ bindings: [], source_disabled_binding_paths: [] });
  });

  it('rejects duplicate local IDs through the closed Agent source contract', () => {
    const source = richAgentSource();
    source.capability_bindings.push(structuredClone(requiredBinding(source, 0)));
    expect(() => compile(source)).toThrow('CLOSURE_SOURCE_INVALID');
  });
});
