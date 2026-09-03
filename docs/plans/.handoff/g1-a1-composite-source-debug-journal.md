# Strategy / Skill Pack source feedback journal

Date: 2026-09-02. Pure local T3.2 source increment; no publication or runtime claims.

| Signal | Cause | Correction / permanent evidence |
|---|---|---|
| Strategy 46 RED: absent APIs | New source adapter | Closed source and assembly implementation. Initial fixture mutated frozen prepared pin; structuredClone corrected fixture. 46 GREEN. |
| Strategy model/allowset mutants survive | Single model and empty gate did not isolate full identity/set checks | 49 GREEN; complete model axes, second model, nonempty gates, valid-reference allowset expansion/shrink. Four mutants killed (2/1/1/1 failing cases). |
| Pack APIs absent | New source projection | Implement full body/pin/member projection and exact exposure verification. Negatives use exact errors so missing APIs cannot count as passing. |
| requires_key without key source accepted | Wrapper only checked shape; source operation could be safe | Two targeted REDs, then wrapper invariant; direct/nested positive with actual key source. Existing key-floor negative changed to unsafe to isolate later guard. |
| Nested member effect/key/approval below known operation accepted | Nested branch checked alias/hash only | Three targeted REDs, then shared coversOperation for known nested operations and outer selected declarations. 39 GREEN. |
| Three Pack mutants survive | No same-alias hash drift or distinct two-member projection/second restriction case | Same alias body drift, independent complete two-member target/operation projection and second-only classification violation. 40 GREEN, all three mutants killed. |
| First fixture typechecks | Empty [] inferred never[], frozen pins reused, unchecked first tuple element | Explicit string[]/guard/clone; no production semantic weakening. |

Final package inventory: release-core 542, domain 143. See [[g1-a1-composite-source-review]] for gate/review evidence. No test removed/skipped, no target provenance fabricated. Generic source helper budget/lossless parsing is shared by only the new Strategy/Pack modules; existing executable semantics remain unchanged except the newly exported standalone Binding wrapper.
