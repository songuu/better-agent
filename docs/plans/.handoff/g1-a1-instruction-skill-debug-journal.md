# Instruction Skill signed source feedback journal

Date: 2026-09-02. Local T3.2 source increment, no publication or runtime claims.

| Signal | Cause | Correction / permanent evidence |
|---|---|---|
| Initial 52 RED tests | Missing source APIs | Closed bundle/trust schemas, byte/hash/signature verification and exact Agent assembly checks; 52 GREEN, then explicit ceilings/format probes expanded to 56. |
| Four test-sensitivity mutants survived | First-only fixtures and partial artifact expectations | Complete independent full pin/manifest owner/inert_content source assertions, second signer and second allowed Binding checks; permanent cases retained. |
| P1 degenerate Ed25519 key accepted; 58/59 GREEN | Node key import/DER roundtrip plus signature verification did not reject identity public key | Fixed @noble/curves 2.4.0; strict canonical point, nonidentity, torsion-free and explicit non-ZIP215 signature verification. Original two-message rejection regression now GREEN. |
| Install refused noninteractive module replacement | Existing modules used a custom temporary pnpm store, default install selected another store | Read .modules.yaml; reuse exact existing store with --ignore-scripts. Only two dependencies added, no reset/rebuild of the module tree. |
| Two new boundary tests failed with Cannot redefine property | Library exports frozen objects; direct spy is unsupported | Separate isolated module-mock guard suite from real-library signature suite. All 63 release increment tests GREEN; nine domain structural cases GREEN. No real crypto test replaced by mocks. |
| Nonfinal chunk check mutation survived | Old split also changed file bytes/hash and was rejected earlier | Repartition the exact signed entry bytes only; metadata/hash/signature stay unchanged. Removing the 49,152-byte nonfinal check now fails the permanent regression. |

The key defect was corrected through a version-pinned library rather than one-vector blacklisting or new cryptographic arithmetic. Structural schema acceptance alone does not verify content, signatures or publisher authority. Final whole-repository and independent-review results belong in [[g1-a1-instruction-skill-review]].
