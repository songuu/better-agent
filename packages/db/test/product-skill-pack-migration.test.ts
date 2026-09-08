import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrations = join(import.meta.dirname, '..', 'migrations');
const up = readFileSync(join(migrations, '039_product_skill_pack.up.sql'), 'utf8');
const down = readFileSync(join(migrations, '039_product_skill_pack.down.sql'), 'utf8');

describe('product Skill Pack migration', () => {
  it('stores versioned workspace resources and immutable Agent release bindings', () => {
    expect(up).toMatch(/CREATE TABLE public\.product_skill_pack_resources/u);
    expect(up).toMatch(/CREATE TABLE public\.product_skill_pack_releases/u);
    expect(up).toMatch(/CREATE TABLE public\.agent_product_skill_pack_bindings/u);
    expect(up).toMatch(/CREATE TABLE public\.agent_product_release_skill_pack_bindings/u);
    expect(up).toMatch(/product_skill_pack_releases_immutable/u);
    expect(up).toMatch(/agent_product_release_skill_pack_bindings_immutable/u);
  });

  it('pins an exact pack release into Agent publication and Run readback', () => {
    expect(up).toMatch(/snapshot_agent_product_release_skill_pack/u);
    expect(up).toMatch(/create_agent_draft_with_strategy_capabilities_v7/u);
    expect(up).toMatch(/update_agent_draft_with_strategy_capabilities_v7/u);
    expect(up).toMatch(/read_agent_product_run_skill_pack/u);
  });

  it('enforces owner-only RLS, runtime function ACL and guarded rollback', () => {
    expect(up).toMatch(/FORCE ROW LEVEL SECURITY/gu);
    expect(up).toMatch(
      /REVOKE ALL ON public\.product_skill_pack_resources[\s\S]*FROM PUBLIC,ba_runtime/u,
    );
    expect(up).toMatch(/GRANT EXECUTE ON FUNCTION app\.list_product_skill_packs/u);
    expect(down).toMatch(/Cannot roll back product Skill Pack migration while resources exist/u);
  });
});
