# `@better-agent/db`

Executable G0-03 migration tooling plus the reviewed G0-04 tenant/auth/RLS,
G0-05 Release/Deployment/admission, G0-06 Run/Billing facts, and the G0-07
internal phase/lease/fencing security plane.
`docs/database` remains design input; only the ordered SQL re-cut and reviewed
under `migrations/` is executable.

## Contract

- Files are named `NNN_snake_case.up.sql`; a reviewed
  `NNN_snake_case.down.sql` is optional.
- Versions start at `000` and are contiguous. Missing, duplicated, symlinked,
  non-UTF-8 or self-transactional migrations fail before a connection opens.
- One PostgreSQL transaction and one advisory lock cover an invocation.
- Applied up/down SHA-256 checksums are immutable. Editing either side of an applied migration aborts.
- PostgreSQL older than 16 aborts. Migration `000` verifies the `vector`
  and `pgcrypto` extensions and the platform role boundary.
- Rollback requires both `--allow-down` and `--to`; if any selected migration
  lacks a reviewed down file, nothing is sent to PostgreSQL.

## Platform bootstrap

Run `bootstrap/platform-roles.sql` against the target database as a DBA before
the application migration runner. It installs the two extensions, revokes
untrusted `CREATE` on schema `public`, and creates only these NOLOGIN roles:

- `ba_migrator`, `ba_auth_owner`, `ba_authorization_owner`;
- `ba_run_owner`, `ba_billing_owner`, `ba_archive_evidence_owner`,
  `ba_retention`;
- `ba_runtime`, `ba_control_executor`;
- `ba_management_attestation_issuer`, `ba_subject_assertion_verifier`;
- `ba_internal_service_attestation_issuer`;
- `ba_admission_executor`, `ba_execution_executor`, `ba_metering_executor`,
  `ba_finalizer_executor`, `ba_reclaimer_executor`,
  `ba_reconciliation_executor`, `ba_archive_evidence_executor`, and
  `ba_retention_executor`.

The actual deployment login is provisioned separately as a non-superuser and
granted `ba_migrator`. Migration `000` rejects a superuser/BYPASSRLS runner,
missing ADMIN OPTION on the G0-04/G0-05 owner roles, login-capable owner/group
roles, or owner-role membership inherited by an executable role. Migration
`004` applies the same catalog and membership boundary to the four G0-06
owners; only `ba_migrator` may hold their ADMIN OPTION. Migration `005` also
rejects phase-role inheritance through peer/legacy groups and any LOGIN that
combines more than one phase or overlaps a phase with runtime, control,
issuer, migrator, or owner authority. Deployment enrolls each internal-service
LOGIN into exactly one phase role; an external API credential cannot stand in
for that enrollment or its signed database attestation.

## G0-04 control/auth boundary

`001_tenant_identity.up.sql` creates Workspace-direct facts for role/member,
secret reference, five credential kinds, closed scopes, permission callbacks,
browser assertion issuer configs, end-user principals, one-use assertion facts
and durable authorization invalidation. `002_auth_context_rls.up.sql` adds the
private auth projection, append-only redacted audit, signed transaction-local
tenant context, FORCE RLS, one-way lifecycle triggers and least-privilege ACLs.

Low-privilege callers do not write these tables directly. After a trusted
management gateway issues an attestation, `ba_control_executor` establishes its
transaction context and uses the reviewed functions:

```text
auth.create_secret_ref(uuid,text,text,text,text,timestamptz,jsonb)
auth.create_api_credential(uuid,uuid,text,text,bytea,text[],text[],timestamptz,timestamptz,uuid)
auth.add_api_credential_scope(uuid,text)
auth.transition_api_credential(uuid,text,timestamptz,uuid,text)
auth.create_browser_subject_issuer_config(uuid,text,text,uuid,integer,text[],integer,integer,timestamptz,timestamptz)
auth.transition_browser_subject_issuer_config(uuid,text,text)
auth.create_permission_callback(uuid,text,text,uuid,integer)
auth.transition_permission_callback(uuid,text,text)
auth.revoke_end_user_principal(uuid,text)
```

The subject assertion adapter uses a dedicated login that is a member only of
`ba_subject_assertion_verifier`; membership in `ba_runtime` is explicitly
rejected. In one transaction it first calls the publish-only
`auth.authenticate_publish_exchange_credential`, resolves the versioned
verification-key/trust limits through
`auth.get_browser_subject_verifier_config`, verifies the signature outside
PostgreSQL, then calls the G0-05 atomic
`auth.exchange_browser_subject_assertion_for_session`. The underlying assertion
consumer is no longer executable by the verifier role on its own. The exchange
accepts issuer, audience, canonical origin, time window, key version,
subject/nonce hashes and a derived session verifier, but never accepts
`principal_id`, Deployment or revision authority; nonce consumption, typed
target resolution and public/private session inserts share one transaction.
The verifier-config row includes `workspace_id`, maximum TTL and clock skew so
the adapter can select the workspace-scoped identity HMAC key without trusting
an assertion-supplied tenant identifier.

Both credential authenticators return a versioned authorization snapshot only
after the signed transaction-local context has been established and revalidated
through the FORCE-RLS-protected source tables. The snapshot contains sorted
`credential_scopes`, `credential_authorization_epoch` and
`workspace_authorization_epoch`; it never contains the presented verifier or
the stored verifier HMAC. The private auth index remains only the verifier and
lifecycle authentication projection, not a second source of scopes or epochs.
Every rejected authentication returns zero rows.

Management attestation issuance/revocation and control-context establishment
also use separate logins. A login must never inherit both
`ba_management_attestation_issuer` and `ba_control_executor`; migration 000 and
both sides of the runtime handshake reject that combination recursively.
No executable login may also inherit `ba_migrator`, `ba_auth_owner`, or
`ba_authorization_owner`, including through indirect role membership.

The authentication/control entry-point signatures are:

```text
auth.issue_control_session_attestation(uuid,uuid,uuid,name,text,bytea,bytea,timestamptz)
auth.revoke_control_session_attestation(uuid,text)
auth.establish_control_workspace_context(uuid,bytea)
auth.authenticate_api_credential(uuid,bytea)
  -> (workspace_id uuid, credential_id uuid, credential_kind text,
      credential_scopes text[], credential_authorization_epoch bigint,
      workspace_authorization_epoch bigint)
auth.authenticate_publish_exchange_credential(uuid,bytea)
  -> (workspace_id uuid, credential_id uuid, credential_kind text,
      credential_scopes text[], credential_authorization_epoch bigint,
      workspace_authorization_epoch bigint)
auth.get_browser_subject_verifier_config(uuid)
auth.exchange_browser_subject_assertion_for_session(
  uuid,bytea,text,text,text,text,timestamptz,uuid,text,bytea,
  text,integer,bytea,timestamptz,timestamptz
)
```

The presented API/control verifier remains bearer-equivalent. Drivers must use
binary never-log parameters, and production admission must independently prove
PostgreSQL, pooler, APM, error and support-export parameter redaction. The SQL
schema cannot prove that deployment configuration by itself.

## G0-05 Release and Deployment boundary

`003_release_deployment.up.sql` adds append-only typed resource roots/Drafts,
Strategy/Agent/Flow/Experience Releases, the canonical full-pin registry and
derived dependency/requirement/handle projections. It also adds immutable
policy versions, stable Agent/Flow Deployment axes, immutable revisions and
credential mappings, separate CAS active pointers, monotonic security epochs,
typed entry grants, promotion audit, and safe/public plus verifier/private
browser-session facts.

Draft append, stable Deployment creation, typed grant create/revoke, pointer
promotion and security transitions are available only through fixed-kind
`app.*` functions to `ba_control_executor`. Content-addressed publisher
functions physically exist for the typed persistence schema, but remain
executable only by the NOLOGIN `ba_authorization_owner`: the control role cannot
self-assert a document, dependency-manifest, compiler or change-set hash. They
are never granted to an executable application role. Migration 009 instead adds
fixed-kind attested wrappers: an isolated management issuer reviews the exact
prepared storage bytes and issues a short-lived proof bound to Workspace,
publisher login, full pin and database-computed storage digest. The isolated
control executor can consume that proof exactly once; wrong bytes, verifier,
login, kind, expiry, revocation or replay fail closed. A failed underlying
publication rolls the consumption back. The disposable integration harness uses
the raw owner-only functions only to seed independent readback fixtures.

`ba_runtime` receives only Agent/Flow service admission and browser-session
authentication functions; the subject verifier receives only atomic browser
exchange. Direct selector-based admission accepts only new-entry scopes
(`agent:conversation:*`, `agent:run:create`, `flow:run:create`). Original-Run
read/cancel/resume/events scopes remain reserved for a G0-06 resolver that starts
from the persisted Run target. Admission locks and rechecks credential, grant,
pointer and security facts after concurrent waits, returns a hashable snapshot,
and deliberately does not create Run rows or compute a second SQL canonical
hash. `@better-agent/release-core` validates/JCS-hashes prepared commands and API
snapshots, but its output is not a database authorization credential.

Production pointer promotion and activation fail closed. Reviewed schema down
to `002` succeeds only while every G0-05 table and invalidation source is empty;
after any durable fact, recovery is forward-only and business rollback uses
pointer CAS plus audit.

## G0-06 Run and Billing fact boundary

`004_run_billing.up.sql` projects the immutable Conversation contract hash from
the G0-05 Agent revision document and adds Workspace-direct typed-principal
Conversation/message/state facts, complete idempotency sentinels and receipts,
Run/Attempt/Step/Event/Checkpoint/HumanGate/Outbox facts, credit
reservation/ledger/reconciliation facts, and the three-part archive evidence
plus purge receipts. Every new relation has a Workspace candidate key and
`ENABLE + FORCE RLS`; raw application relation access remains denied.

The four NOLOGIN owners separate Run composition, billing, archive evidence and
retention. Cross-owner work is exposed only through narrowly scoped definer
functions with a fixed `pg_catalog, public, auth, app, pg_temp` search path. Two
exact trigger guards remain SECURITY INVOKER because their policy must inspect
the actual billing/retention `current_user`; they pin the same search path and
are frozen by catalog and static tests. Billing serialization follows Workspace
before Run/reservation/ledger and uses `FOR NO KEY UPDATE` for the Workspace row
so concurrent namespace foreign-key checks cannot form a lock-upgrade deadlock.
Durable ledger entries are append-only, and Run identity plus terminal
tombstones are immutable. The reviewed down migration rejects any later
migration or durable G0-06 fact with SQLSTATE `55000`; only an empty fact layer
can return to the exact G0-05 catalog shape.

`ba_runtime` can authenticate pointer-free browser identity and use only the
persisted-target idempotency lookup, original-Run read/events and controlled
cancellation primitives. Lookup and mutation functions revalidate current
literal service scope/grant/security or signed browser session/principal/
Deployment epochs before returning a receipt or writing Event/Outbox facts.
Browser identity establishment still requires the exact canonical origin,
`agent_browser_api` audience and reviewed client channel. It never reads the
active revision for an existing Run.

Prepared root acceptance, Conversation mutation, billing, finalization,
archive/purge and HumanGate mutation remain owner-only seams. In particular,
application `SUCCEEDED` finalization, child/allocation and all positive Gate
paths fail closed until G0-07 supplies executor attestation, fencing and trusted
validation. The migration does not add a scheduler, worker, HTTP handler or
production credential.

Public HTTP handlers, production pools/APM/CORS and deployed infrastructure
remain outside this package's verified state. Successful local PostgreSQL
integration proves only disposable migration/catalog behavior, not that a
production database has applied a migration.

## G0-07 runtime security boundary

`005_runtime_security.up.sql` begins with one schema-qualified `NOWAIT` table
lock over every mutable through-004 relation. After that quiescence point it
rejects nonterminal/unsettled/undelivered legacy facts and ledger values that
cannot be represented losslessly by the frozen `/1` contracts. It then adds
short-lived internal-service attestations, protocol-v5 Attempt and
`RUN_DISPATCH` generations, immutable retry/effect/checkpoint/usage/termination
provenance, one-use recovery ticket dispositions, HOLD/dispatch retirement
evidence, transaction-scoped finalizer claims, and append-only billing
authority receipts.

The legacy facts are `ENABLE + FORCE RLS`, so 005 first verifies the exact
through-004 owners and both RLS catalog bits. While the complete inventory lock
is held, it switches only to `ba_run_owner` or `ba_billing_owner`, temporarily
removes `FORCE` from the exact relations each owner must scan, leaves RLS
enabled, and restores `FORCE` before protocol-v5 schema expansion or data
backfill. A rejected migration rolls the inspection window back with the same
transaction. The down guard uses the same owner-visible pattern for protocol-v5
columns on through-004 relations; no migrator scan without tenant context is
accepted as evidence that those tables are empty.

Each phase LOGIN receives only context establishment plus its exact façade.
Workspace and `session_user` are derived from the verified transaction proof;
caller JSON cannot select a tenant. Execution writes require the current full
lease tuple. Metering/finalizer consume immutable historical producer
attribution without pretending a later fence is the source. Reclaimer can
fence and clear an expired generation, then issue a replay ticket or HOLD, but
cannot execute, acknowledge, bill, or terminalize work. Raw table DML, schema
creation, temporary tables, legacy owner primitives, and cross-phase execution
remain denied.

Billing `/1` and its owner-only current-fence compatibility behavior stay
frozen. Protocol-v5 settlement/release uses the strict `/2` authority union and
an acyclic source-authority → billing-intent → receipt/ledger hash flow. The
receipt and ledger are a deferred one-to-one pair; exact replay returns the
first committed identity, while a different source or intent conflicts.

The reviewed `005` down path is disposable-only. Its first statement locks the
complete legacy plus G0-07 inventory, and any attestation, protocol-v5 fact,
authority receipt, audit row, or later migration makes rollback fail closed.
Production recovery is forward-only; bootstrap roles remain dormant rather
than being dropped.

Use only the documented discrete libpq environment variables (`PGHOST`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPORT`, the supported `PGSSL*` variables
and `PGCONNECT_TIMEOUT`). The child process receives an explicit allowlist; the
CLI rejects `DATABASE_URL`, `PGSERVICE`, `PGOPTIONS`, `PGPASSFILE` and other
ambient libpq controls.

```powershell
pnpm --filter @better-agent/db build
node packages/db/dist/cli.js up
node packages/db/dist/cli.js status
node packages/db/dist/cli.js down --to 0 --allow-down
```

The registered integration harnesses under `infra/test/postgres` are the evidence path
for an empty database, idempotent apply, checksum tamper rejection, exact G0-05
catalog restoration after empty G0-06 down/reapply, non-empty down protection,
FORCE RLS/ACL attacks, typed admission, Flow/Agent Chat facts, billing, terminal
and retention concurrency, browser original-Run authorization, phase
attestation/ACL isolation, lease fencing, recovery, and backend/client failure
injection. Run the complete serial gate with
`pnpm --filter @better-agent/db test:integration`. It is local disposable
PostgreSQL evidence only, not production-state evidence.

Migration `011_g1_knowledge_database_capability` adds the G1-A3 durable
Knowledge-query and read-only Database-operation receipts. Both tables are
immutable, owner-only and FORCE RLS. Execution can write only through fixed
lease/fence-checked functions; exact source pins are checked by a narrow
authorization-owner projection, without granting the run owner raw registry
access. Non-empty rollback is rejected.

Migrations `012_g1_agent_strategy_execution` and
`013_g1_worker_human_gate` retain the reviewed AgentPlan, fenced Strategy
state/actions/results and replay-first Human Gate decisions behind phase-local
functions and immutable FORCE-RLS facts.

Migrations `014_g1_join_child_execution`, `015_g1_join_child_settlement` and
`016_g1_join_child_terminalization` implement the join-only descendant path.
The execution phase can create only an exact Plan-authorized child allocation
and immutable terminal intent under a live lease. The billing phase alone can
settle that allocation against the root reservation, and the finalizer consumes
the retained intent to publish the exact terminal event and tombstone. Root,
child and grandchild replay/conflict, concurrent settlement and guarded
rollback are exercised by the registered PostgreSQL 16 harness.

Migrations `017_g1_public_run_events` and
`018_g1_browser_run_event_session` add the strict external SSE projection and
the browser EventSource bridge. Public events are immutable and independently
validated; browser capabilities are bound to one Run and one canonical Origin,
expire within 60 seconds, store only HMAC verifier material in the private auth
schema, and recheck the session, principal, Deployment and original Run before
readback.
