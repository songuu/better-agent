import { describe, expect, it } from 'vitest';

import { validateAgentInput } from '../src/product-store.js';

describe('product Agent input', () => {
  it('accepts and freezes the closed product draft payload', () => {
    const input = validateAgentInput({
      description: '面向运维团队的助手',
      instructions: '只根据已核验的运行事实回答。',
      model: 'gpt-5.6-sol',
      name: '运行守望者',
    });

    expect(input).toEqual({
      description: '面向运维团队的助手',
      instructions: '只根据已核验的运行事实回答。',
      model: 'gpt-5.6-sol',
      name: '运行守望者',
    });
    expect(Object.isFrozen(input)).toBe(true);
  });

  it.each([
    [{ description: '', instructions: '', model: 'gpt-5.6-sol', name: 'A' }],
    [{ description: '', extra: true, instructions: 'Do work', model: 'gpt-5.6-sol', name: 'A' }],
    [{ description: '', instructions: 'Do work', model: 'latest', name: 'A' }],
  ])('rejects an incomplete, open or mutable draft payload', (payload) => {
    expect(() => validateAgentInput(payload)).toThrow();
  });
});
