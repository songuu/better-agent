# `@better-agent/billing-core`

Pure, deterministic credit fact preparation for Better Agent.

The package owns the G0-06 pure billing boundary:

- canonical PostgreSQL-`bigint` decimal strings at the contract boundary and
  exact `bigint` values internally, including values beyond JavaScript's safe
  integer range;
- top-level `HELD` reservations, including an explicit zero-credit fact;
- closed `RESERVE`, `SETTLE`, `RELEASE`, `EXPIRED`, and `RECONCILIATION`
  intents with replay/conflict classification;
- immutable ledger facts with exact available/reserved/settled delta triangles;
- monotonic `PENDING | SETTLED | NEEDS_ATTENTION` current billing state;
- deterministic Workspace → Run/Attempt → reservation → charge-key lock order.

Every function receives IDs, hashes and timestamps from its trusted caller. The
package does not read a database, clock, random source, API context or executor
state. It prepares and validates facts only; PostgreSQL owner functions remain
responsible for authorization, locking, durable balances and append-only writes.

Child allocation is deliberately unavailable until its dedicated contract and
migration exist. Calling `prepareChildAllocationV1` always fails closed.
