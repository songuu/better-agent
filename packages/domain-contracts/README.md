# `@better-agent/domain-contracts`

G0-02/G0-04 structural contract boundary for versioned Agent Release, Flow IR,
Compiled Capability Closure, Agent Strategy and authentication payloads.

The package fails closed on unknown top-level fields and schema versions, checks
kind/pin/config agreement, Flow reachability and ordinary control-edge DAGs,
closure reference membership, and promotion decision field consistency. It is
not yet a publisher, compiler or admission boundary:

- action-specific Flow config schemas remain owned by their later capability tasks;
- canonical binding/resource/hash calculations and policy meet belong to G1-01;
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

These boundaries are deliberate. A successful Zod parse proves structural
contract validity only; it does not prove publication, authorization or runtime
safety.
