import { describe, expect, it } from 'vitest';

import { defineFixture } from '../src/index.js';

describe('defineFixture', () => {
  it('freezes shared fixtures so tests cannot mutate their input', () => {
    const fixture = defineFixture({ kind: 'workspace-smoke', version: 1 });

    expect(fixture).toEqual({ kind: 'workspace-smoke', version: 1 });
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(() => Object.assign(fixture, { version: 2 })).toThrow(TypeError);
  });
});
