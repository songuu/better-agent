---
title: "All-kind Schema batch validation"
date: 2026-09-02
tags: [solution, contracts, testing, performance]
related_instincts: []
aliases: ["typed Schema collection", "bounded source Schema batch"]
---

# All-kind Schema batch validation

## Problem

Executable, leaf and Skill Pack source adapters previously bound JSON documents without compiling every explicit JSON Schema-bearing field. Calling the single-schema worker once per field would make a maximum Flow consume thousands of workers and deadlines; scanning arbitrary keys ending in `_schema` would also confuse business JSON with executable contracts.

## Decision

- Walk only the typed contracts: Agent root/GateSpec/Capability Binding, recursive Flow node/human gate, four leaf primary operations plus Plugin/A2A collections, and Skill Pack envelope/member/exposure operations.
- Snapshot at most 8,194 schemas and 8 MiB aggregate bytes, canonicalize and deduplicate only the worker compilation inputs, and compile the batch in one fixed worker with the same 5-second deadline and V8 limits as a single schema.
- Keep one evidence item per canonical field path even when two schemas have identical bytes. Sort paths canonically and split evidence into arrays of at most 1,024 items so the complete wrapper remains valid under the shared data-snapshot contract.
- Rebuild the complete source artifact, evidence and validation hash in every verifier. Schema evidence is neither registry provenance nor host attestation.

## Regression shape

The suite covers invalid non-first schemas, all explicit input/output axes, nested branch/else/loop gates, non-first Plugin/A2A operations, four leaf kinds, Skill Pack members/exposures, caller evidence drift, 8,194 unique schemas and a real Flow producing 1,025 evidence paths split as `[1024, 1]`.

## Result

Release-core passes 729 tests; the repository quality marker and architecture manifest are synchronized. Final path/policy/route compilation, registry admission, live runtime instances and the complete application remain subsequent work.

## Prevention

Freeze batch count/bytes/deadline in the hashed profile and architecture contract. Protect all collection loops with heterogeneous non-first items, output-axis mutations, exact 4,999/5,000 ms lifecycle tests and real evidence-batch boundaries.

## Related

- [[2026-09-02-schema-reference-and-worker-boundaries]]
- [[2026-09-02-g1-a1-capability-closure-kernel]]
- [[session-2026-09-02]]
