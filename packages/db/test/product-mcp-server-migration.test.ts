import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = join(import.meta.dirname, '..', 'migrations');
const up = readFileSync(join(migrations, '040_product_mcp_server.up.sql'), 'utf8');
const down = readFileSync(join(migrations, '040_product_mcp_server.down.sql'), 'utf8');

describe('product MCP server migration', () => {
  it('stores versioned server resources and immutable Agent release bindings', () => {
    expect(up).toMatch(/CREATE TABLE public\.product_mcp_server_resources/u);
    expect(up).toMatch(/CREATE TABLE public\.product_mcp_server_releases/u);
    expect(up).toMatch(/CREATE TABLE public\.agent_product_mcp_server_bindings/u);
    expect(up).toMatch(/CREATE TABLE public\.agent_product_release_mcp_server_bindings/u);
    expect(up).toMatch(/product_mcp_server_releases_immutable/u);
    expect(up).toMatch(/agent_product_release_mcp_server_bindings_immutable/u);
  });

  it('pins an exact MCP release into Agent publication and Run readback', () => {
    expect(up).toMatch(/snapshot_agent_product_release_mcp_server/u);
    expect(up).toMatch(/create_agent_draft_with_strategy_capabilities_v8/u);
    expect(up).toMatch(/update_agent_draft_with_strategy_capabilities_v8/u);
    expect(up).toMatch(/read_agent_product_run_mcp_server/u);
  });

  it('enforces owner-only RLS, runtime function ACL and guarded rollback', () => {
    expect(up).toMatch(/FORCE ROW LEVEL SECURITY/gu);
    expect(up).toMatch(
      /REVOKE ALL ON public\.product_mcp_server_resources[\s\S]*FROM PUBLIC,ba_runtime/u,
    );
    expect(up).toMatch(/GRANT EXECUTE ON FUNCTION app\.list_product_mcp_servers/u);
    expect(down).toMatch(/Cannot roll back product MCP server migration while resources exist/u);
  });
});
