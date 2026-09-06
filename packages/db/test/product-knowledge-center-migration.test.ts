import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');
const up = fs.readFileSync(
  path.join(migrationDirectory, '023_product_knowledge_center.up.sql'),
  'utf8',
);
const down = fs.readFileSync(
  path.join(migrationDirectory, '023_product_knowledge_center.down.sql'),
  'utf8',
);

describe('product Knowledge Center migration', () => {
  it('stores tenant-scoped bases, immutable documents and ordered chunks', () => {
    for (const table of [
      'product_knowledge_bases',
      'product_knowledge_documents',
      'product_knowledge_chunks',
    ]) {
      expect(up).toContain(`CREATE TABLE public.${table}`);
      expect(up).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(up).toContain('product_knowledge_documents_immutable');
    expect(up).toContain('product_knowledge_chunks_immutable');
    expect(up).toContain('GENERATED ALWAYS AS');
    expect(up).toContain('USING gin (search_vector)');
  });

  it('exposes only bounded security-definer ingestion and retrieval operations', () => {
    for (const name of [
      'list_product_knowledge_bases',
      'create_product_knowledge_base',
      'ingest_product_knowledge_document',
      'list_product_knowledge_documents',
      'search_product_knowledge',
    ]) {
      expect(up).toContain(`CREATE FUNCTION app.${name}`);
      expect(up).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION app\\.${name}\\([^;]+ TO ba_runtime;`, 'u'),
      );
    }
    expect(up).toContain('jsonb_array_length(p_chunks) NOT BETWEEN 1 AND 320');
    expect(up).toContain('octet_length(p_chunks::text) > 1048576');
    expect(up).toContain('p_limit NOT BETWEEN 1 AND 20');
  });

  it('denies direct runtime table access and supports Chinese substring retrieval', () => {
    expect(up).toContain('FROM ba_runtime;');
    expect(up).toContain('strpos(lower(chunk.content), lower(v_query)) > 0');
    expect(up).toContain("plainto_tsquery('simple', v_query)");
  });

  it('guards rollback and removes the complete Knowledge surface', () => {
    expect(down).toContain('cannot remove product Knowledge Center while Knowledge facts exist');
    expect(down).toContain('DROP FUNCTION app.search_product_knowledge');
    expect(down).toContain('DROP TABLE public.product_knowledge_chunks;');
    expect(down).toContain('DROP FUNCTION app.reject_product_knowledge_immutable_mutation();');
  });
});
