import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = path.resolve(import.meta.dirname, '..', 'migrations');
const up = fs.readFileSync(
  path.join(migrationDirectory, '025_product_agent_knowledge_binding.up.sql'),
  'utf8',
);
const down = fs.readFileSync(
  path.join(migrationDirectory, '025_product_agent_knowledge_binding.down.sql'),
  'utf8',
);

describe('product Agent Knowledge binding migration', () => {
  it('separates mutable draft selection from immutable release evidence', () => {
    expect(up).toContain('CREATE TABLE public.agent_product_knowledge_bindings');
    expect(up).toContain('CREATE TABLE public.agent_product_release_knowledge_bindings');
    expect(up).toContain('CREATE TABLE public.agent_product_release_knowledge_documents');
    expect(up).toContain('CREATE TRIGGER agent_product_release_knowledge_bindings_immutable');
    expect(up).toContain('CREATE TRIGGER agent_product_release_knowledge_documents_immutable');
  });

  it('snapshots only documents present when the Agent release is published', () => {
    expect(up).toContain('CREATE FUNCTION app.snapshot_agent_product_release_knowledge');
    expect(up).toContain('CREATE TRIGGER agent_product_release_knowledge_snapshot');
    expect(up).toContain('INSERT INTO public.agent_product_release_knowledge_documents');
    expect(up).toContain('FROM public.product_knowledge_documents AS document');
    expect(up).toContain('document.knowledge_base_id = v_knowledge_base_id');
  });

  it('retrieves through the conversation pinned release with bounded output', () => {
    expect(up).toContain('CREATE FUNCTION app.search_agent_product_conversation_knowledge');
    expect(up).toContain('conversation.release_version = release_document.release_version');
    expect(up).toContain('LIMIT p_limit');
    expect(up).toContain('p_limit NOT BETWEEN 1 AND 8');
  });

  it('exposes only definer functions to runtime and reverses the extension', () => {
    expect(up).toContain('REVOKE ALL ON public.agent_product_knowledge_bindings');
    expect(up).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.search_agent_product_conversation_knowledge\(uuid, uuid, text, integer\)\s+TO ba_runtime;/u,
    );
    expect(down).toContain('DROP TABLE public.agent_product_release_knowledge_documents;');
    expect(down).toContain('DROP TABLE public.agent_product_release_knowledge_bindings;');
    expect(down).toContain('DROP TABLE public.agent_product_knowledge_bindings;');
  });
});
