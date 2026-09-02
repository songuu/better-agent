# G1-A1 executable source debug journal

Date: 2026-09-02. Base: local `75062c2` (T3.1). Scope: pure T3.2 source preimages, not registry publication or production execution.

## 1. Lossless semantic input

- Symptom: an Agent role containing an own `__proto__` object and the same role without that field could share a seed after successful schema parsing.
- Minimal feedback: compare `JsonObjectSchema.parse(JSON.parse(...))` keys, then add source rejection tests. The first rejection assertion failed because no error was thrown.
- Cause: schema record parsing silently removed the own key. There was no observed global prototype mutation.
- Fix: compare canonical snapshot input with canonical parsed output before any documented metadata exclusion. Apply independently to Agent and Flow.
- Permanent regression: Agent role, nested Agent role, Flow input schema, execution defaults and node inputs. Ordinary own `constructor`, `prototype`, `toString` and `hasOwnProperty` survive diagnostic probes.
- Sensitivity: deleting only the Flow barrier in memory fails three Flow tests; retaining the Agent barrier cannot hide that gap.

## 2. Recursive schema work explosion

- Symptom: legitimate condition-loop Flow inputs of about 15–16 KiB took about 78/167/632/2459 ms at depths 6/8/10/12 in one independent Windows diagnostic.
- Minimal feedback: a schema-only leaf getter counts work, with 13 collection/condition wrappers. The source API still rejects getters; this is a deterministic instrumentation fixture for schema dispatch, not an input exception.
- Red: condition parsing read the leaf 16383 times, above a bound of 64. The input was otherwise valid.
- Cause: trial union recursively parsed condition bodies in both failed collection and successful condition branches. Flow node trial dispatch did additional irrelevant work.
- Fix: discriminator-based dispatch by loop `mode` and node `type`, keeping recursive body schemas and refinements.
- Green: five domain regressions pass, including valid-root missing/mixed/unknown loop mode negatives. Comparable diagnostic timings became about 14/7/7/6 ms. These are not portable SLA measurements.
- Sensitivity: changing only the loop discriminator back to union in memory fails the condition work-count test (8192 reads), with the other four cases passing.

## 3. Review-discovered test gaps

These three were missing regression protections, not observed implementation failures:

| Mutation | Initial gap | Permanent protection |
|---|---|---|
| Drop capability bindings from Agent normalized document | Hash-focused tests remained green | Complete expected document equality, enabled/timeout/default-parameter changes and all six Binding configs; mutant now fails four assertions |
| Remove shared gate membership refinement | Existing release/domain tests remained green | Same valid rich Source and Release pair accepted, same missing gate reference rejected; source preparation also rejects |
| Skip loop body recursion | Shared single-leaf fixture concealed skipped work | Multi-node child graphs, isolated second-case/loop/else drift, nested node/edge permutation and exact 4096-node budget; mutant now fails three cases |

## Final evidence and boundary

Final release-core 319/319, domain-contracts 127/127. Fresh zero-cache full `pnpm check` passed at 12:22 +08:00, and architecture unit/mutation suite passed 31/31. All three independent reviewers returned DONE with no remaining P0/P1/P2.

No source/registry provenance, nested closure body, PostgreSQL, remote CI, host attestation or production acceptance is inferred from these results. Continue final closure compilation under T3.2, then T4–T6 and the actual application layers.
