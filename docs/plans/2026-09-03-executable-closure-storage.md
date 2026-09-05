# T6: immutable executable closure storage and verified readback

Status: storage increment implemented and reviewed. Planning P3; risk L4. Parent T6 remains open.

## Outcome and authority boundary

Persist Agent/Flow compiled preimages and complete closure preimages alongside
the exact typed published version, then re-derive source, compiled hash, closure
hash and direct manifest from database readback. This supplies missing durable
compiler evidence for the complete Agent application, not a substitute product.
All work uses disposable PostgreSQL. No existing database migration, production
data, host receipt or public publisher grant is modified.

The existing owner-only G0 publisher is not a compiler attestation boundary.
New owner-only typed wrappers atomically invoke it and retain compiled evidence;
no executable role gains access. Content consistency is not independent source
provenance: registry-backed dependency loading and complete source/policy compiler
replay remain required before unpausing application publication.

The existing registry supports five G0 kinds only. This storage migration does
not silently relabel or admit unsupported G1 dependency kinds. A complete T6
delivery also requires typed registry writers for Instruction Skills, leaf
resources and Packs; that remains an explicit subsequent dependency, not removed
product scope. Missing closure storage on a historical release always rejects
compiled readback; there is no legacy fallback.

## Decision and alternatives

Add migration 006; retain immutable 000–005 bytes. Store canonical compiled
preimage (8 MiB) and closure preimage excluding its own hash (32 MiB), avoiding
duplicate full closure storage. The registry's existing canonical typed document
retains source metadata. A full-pin FK and insert-time manifest/source joins bind
the immutable row to the typed registry. PostgreSQL hashes original UTF-8 bytes;
the TypeScript readback boundary independently requires canonical JSON and
recomputes source/closure semantics. SQL JSONB text is never an RFC8785 encoder.
Storage byte limits are an additional wire profile, not a claim that every value
within the earlier object/string budget will fit serialized storage.

Rejected alternatives: editing historical migrations breaks checksums; an opaque
closure blob does not bind the source; granting the existing publisher to runtime
roles would expose unverified prepared payloads. A new general-purpose registry
or public transport artifact is unnecessary.

## Ordered tasks (serial: shared L4 contracts, no [P])

1. Add private source/closure storage projection and exact readback verifier, with
   positive Agent/Flow and independently isolated hash/source/manifest mutations.
   Files: release-core storage module and tests/fixtures.
2. Add immutable table, RLS, full-pin FK, byte/hash guards, typed owner-only atomic
   publication wrappers and non-empty down guard in 006 up/down migrations.
3. Add real PG integration: complete typed rows + compiled evidence, independent
   readback, cross-workspace/role denial, rollback, conflict and immutable facts.
   Wire the suite into the frozen gate without removing historical suites.
4. Run repository and complete gate checks, five independent review perspectives,
   update actual inventories and save evidence. Do not mark T6 or the app complete.

## Risks and verification

| Risk | Impact | Mitigation |
|---|---|---|
| Missing JSON key passes SQL NULL logic | Unbound source | IS DISTINCT FROM / IS TRUE; omission vectors |
| JSONB reserialization changes hash | Invalid persisted identity | Hash text bytes; verify RFC8785 on readback |
| Partial typed/registry/closure publication | Incomplete executable | One statement/transaction; injected late failure and independent readback |
| Owner bypass / cross-tenant evidence | Authority leakage | FORCE RLS, fixed search_path, explicit executable-role revokes |
| Self-consistent forged closure treated as compiler proof | Premature authority | Private consistency helper, owner-only SQL, publication pause retained |
| Migration upgrade changes historical test scope | Misleading evidence | Preserve milestone prefixes; add latest-schema lifecycle coverage |

PostgreSQL semantics checked against the official
[constraint](https://www.postgresql.org/docs/16/ddl-constraints.html) and
[row-security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) references.

## Verified evidence

- Release-core: **1087/1087** across **40** files; the new Agent/Flow storage suite is **17/17**.
- Database unit tests: **89/89** across **8** files; architecture mutation tests: **37/37**.
- All seven disposable PostgreSQL 16 suites pass. Migration lifecycle covers seven production
  migrations plus the dynamic probe; the new suite proves typed publication, independent readback,
  owner-only ACL, late-failure rollback/retry, immutable evidence and guarded down.
- The complete clean-snapshot architecture gate passes all three gates. Report source manifest:
  **466 files**, **6,715,426 bytes**, digest
  `sha256:6065b95cf50efe61bb4e3caf3759287e2018151e6adf10f57c5d9753079ce420`.
- Final L4 architecture, security, quality, performance/bounds and test-evidence review found no
  remaining P0/P1/P2 issue in this increment. Existing unrelated lint diagnostics remain non-fatal
  at 10 warnings and 1 info.
- No production/cloud database, upload, deployment or host-attested Acceptance was exercised.
  Flow remains a schema-verified storage fixture rather than a completed compiler. G1 registry
  writers for unsupported dependency kinds and the rest of T6 remain open.
