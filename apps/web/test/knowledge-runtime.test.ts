import { describe, expect, it } from 'vitest';

import { splitKnowledgeText } from '../src/knowledge-runtime.js';

describe('product Knowledge ingestion', () => {
  it('normalizes, chunks with bounded overlap and freezes the result', () => {
    const chunks = splitKnowledgeText(`  第一段。\r\n${'知识'.repeat(600)}。最后一段。  `);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0 });
    expect(chunks.at(-1)?.content).toContain('最后一段');
    expect(Object.isFrozen(chunks)).toBe(true);
    expect(chunks.every((chunk) => Object.isFrozen(chunk) && chunk.content.length <= 800)).toBe(
      true,
    );
  });

  it.each([null, '', 'x'.repeat(200_001)])(
    'rejects non-text, empty and oversized content',
    (value) => {
      expect(() => splitKnowledgeText(value)).toThrow('Knowledge document');
    },
  );
});
