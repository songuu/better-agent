export interface ProductKnowledgeChunk {
  readonly content: string;
  readonly ordinal: number;
}

const MAX_DOCUMENT_CHARACTERS = 200_000;
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
const MAX_CHUNKS = 320;

export function splitKnowledgeText(value: unknown): readonly ProductKnowledgeChunk[] {
  if (typeof value !== 'string') throw new Error('Knowledge document content must be text');
  const content = value.replace(/\r\n?/gu, '\n').trim();
  if (content.length < 1 || content.length > MAX_DOCUMENT_CHARACTERS) {
    throw new Error('Knowledge document content must contain 1–200,000 characters');
  }
  const chunks: ProductKnowledgeChunk[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(offset + CHUNK_SIZE, content.length);
    if (end < content.length) {
      const boundary = Math.max(
        content.lastIndexOf('\n', end),
        content.lastIndexOf('。', end),
        content.lastIndexOf('！', end),
        content.lastIndexOf('？', end),
      );
      if (boundary >= offset + Math.floor(CHUNK_SIZE * 0.55)) end = boundary + 1;
    }
    const chunk = content.slice(offset, end).trim();
    if (chunk.length > 0) chunks.push(Object.freeze({ content: chunk, ordinal: chunks.length }));
    if (chunks.length > MAX_CHUNKS) throw new Error('Knowledge document produced too many chunks');
    if (end === content.length) break;
    offset = Math.max(offset + 1, end - CHUNK_OVERLAP);
  }
  return Object.freeze(chunks);
}
