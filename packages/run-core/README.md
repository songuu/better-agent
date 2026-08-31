# `@better-agent/run-core`

Pure, deterministic Run fact preparation for Better Agent.

The G0-06 package owns canonical route intents, replay/conflict decisions,
canonical acceptance receipts, verified acceptance preparation, Conversation
CAS, Run/terminal mappings and retention eligibility. Every time, identity and
evidence value is supplied explicitly by the caller; the package does not read
a database, clock, random source, API or executor.

Persistence authority remains in reviewed PostgreSQL functions. This package
must never treat structural validation or a caller-provided hash as Run
authorization.

HumanGate contracts are shape-only in G0-06. Positive mutation always returns
`RUN_HUMAN_GATE_APPLY_UNAVAILABLE` until lease/fencing and published GateSpec
authority exist.

G0-07 adds pure, clock-free decisions for Attempt claim/renew/relinquish,
two-stage recovery fencing and ticket disposition, lease-bound execution facts,
and `RUN_DISPATCH` delivery/terminal retirement. Callers must supply values read
or derived under the database row lock (`now`, `session_user`, tokens, IDs and
hashes); these helpers validate contracts and produce immutable persistence
intents, but they do not grant authority or prove that a transaction committed.
PostgreSQL owner functions remain the authorization and linearization boundary.
