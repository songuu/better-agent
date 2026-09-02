---
title: "G1-A1 Schema validation feedback journal"
date: 2026-09-02
tags: [debug-journal, contracts, testing]
---

# Feedback loop

1. New public validation API tests began RED (missing implementation), then real local-reference cases exposed canonical URI encoding and Ajv strict `$anchor` registration differences. Corrected only those boundaries; pinned engine 8.20.0/formats 3.0.1, no dependency downgrade.
2. Ajv omits `__proto__` schema-map entries; profile now rejects those declarations explicitly instead of silently dropping constraints. Real data with own `__proto__` still works through patternProperties.
3. Independent quality/performance reviews reproduced dynamicRef wrong-target acceptance. Four permanent targeted cases were RED; profile now validates original data, lowers confirmed anchors to pointers and single-resource dynamic refs to static refs. A follow-up root-recursion case exposed root-anchor resolution with `$id`; pointer lowering handles it too. Existing constraints and allOf indexes are preserved. Root plain/dynamic recursion, three nested target variants and simultaneous refs are GREEN.
4. Test review showed masked guards: useDefaults=true, early slot release, duplicate terminate and missing schema-node limit could pass the earlier tests. Added required+default refusal, controlled delayed-exit/rejection four-slot tests and 4096/4097 boundaries; readonly mutations are caught. Vitest async `.rejects` assertions were corrected to be explicitly awaited inside async map callbacks.
5. Real operation/Strategy wrapper tests began 18/18 RED (missing APIs), then 18/18 GREEN after implementation. Added an input-fit/source-artifact-fit/output-wrapper-overflow test and large legal round trip: 19/19 GREEN. Separate JSON Schema artifact overflow regression verifies the same Schema can validate data while prepare's larger result must fail.
6. Initial dist smoke used Node deepStrictEqual with a plain expected object; source snapshot deliberately returns null-prototype JSON objects. Corrected the smoke assertion to test exact JSON bytes plus null prototype. Dist prepare/verify/instance and operation wrapper passed; no production code changed for this harness mistake.

## Evidence boundary

All tests run on local deterministic source/config fixtures. No database, external application, upload, historical reviewer authority or production acceptance is exercised. Final validation/review status is in [[g1-a1-json-schema-review]].

## Related

- [[2026-09-02-schema-reference-and-worker-boundaries]]
- [[2026-09-02-g1-a1-capability-closure-kernel]]
