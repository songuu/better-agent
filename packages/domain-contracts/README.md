# `@better-agent/domain-contracts`

G0-02 through G0-06 structural contract boundary for versioned Agent Release,
Flow IR, Compiled Capability Closure, Agent Strategy, Experience, Agent/Flow
Deployment, typed entry grants, admission snapshots, browser-session metadata
and authentication payloads. G0-06 adds closed typed-principal Conversation,
Run target/acceptance/snapshot/idempotency, Event/Outbox, HumanGate shape,
reservation/ledger/current billing and archive/retention evidence contracts.

The package fails closed on unknown top-level fields and schema versions, checks
kind/pin/config agreement, Flow reachability and ordinary control-edge DAGs,
closure reference membership, closed Deployment/mapping/grant discriminators,
browser-session TTL/origin facts, and promotion decision field consistency. It
is not itself a publisher, compiler or authorization boundary:

- action-specific Flow config schemas remain owned by their later capability tasks;
- canonical Release/Deployment hash preparation belongs to `release-core`;
- closure canonicalization and policy meet remain owned by G1-01;
- model, budget, egress and authorization sub-vocabularies must be replaced by
  their own versioned closed schemas before a runtime consumes them;
- the package does not persist Releases, resolve credentials, or execute a Run.

`auth-v1` closes credential kind/scope, structured caller principal, redacted
subject assertion, operation policy and `TenantAuthContextV1`. The tenant context
records separate observed Workspace and credential authorization epochs. The API
auth boundary obtains exact operation policies from the immutable generated
OpenAPI registry and binds each one to its reviewed HTTP method and route template
before request authentication. Its runtime-verifiable `credential_phase_passed`
proof includes that route tuple, the operation ID, required scope and canonical
binding hash. That proof is an input to the G0-05 typed Deployment
grant/cardinality transaction, never a final authorization.

G0-05 `*DeploymentEntryAdmissionSnapshotV1` values intentionally stop before a
Run or effective plan: they contain only the transaction-observed credential or
browser-session source, typed grant tuple, stable Deployment, active immutable
revision pins and authorization epochs. G0-06 persists the snapshot with a Run;
G1-01 later combines it with a compiled closure and policy meet.

G0-06 contracts are structural facts, not executable authority. Agent Chat pins
Conversation/message/state while direct Flow forbids those fields;
`admission_snapshot_hash` and `accepted_plan_hash` remain distinct. Zero-credit
Run acceptance still has a reservation and RESERVE ledger fact. HumanGate
positive mutation, application Run acceptance, billing mutation, finalization,
child Run and successful output validation remain unavailable until their
database authority, fencing and registry dependencies exist.

These boundaries are deliberate. A successful Zod parse proves structural
contract validity only; it does not prove publication, authorization or runtime
safety.
