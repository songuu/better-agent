import { createHash, randomBytes } from 'node:crypto';

import { canonicalJsonBytes } from '../../../packages/release-core/dist/index.js';
import { prepareG1VerticalSources } from './g1-vertical-sources.mjs';
import { assertEqual, assertRejected } from './harness.mjs';

const id = (n) => `f1800000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalHash = (value) =>
  `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const jsonb = (value) => `${sqlLiteral(JSON.stringify(value))}::jsonb`;

export async function runG1VerticalExtension(context) {
  const { harness, fact, ownerPsql, controlContextSql, browserSessionId } = context;
  const ids = Object.freeze({
    workspace: context.workspaceId,
    attempt: id(1),
    step: id(2),
    internalAttestation: id(3),
    knowledge: id(10),
    knowledgeVersion: id(11),
    database: id(12),
    databaseVersion: id(13),
    instruction: id(14),
    instructionVersion: id(15),
    knowledgePublication: id(16),
    databasePublication: id(17),
    instructionPublication: id(18),
    knowledgeReceipt: id(19),
    databaseReceipt: id(20),
    subject: id(21),
    checkpoint: id(22),
    gate: id(23),
    strategyExecution: id(24),
    planAttestation: id(25),
    childAgent: id(26),
    childDraft: id(27),
    childRelease: id(28),
    childRun: id(29),
    childLink: id(30),
    childAllocation: id(31),
    joinCheckpoint: id(32),
    childEvent: id(33),
    childOutbox: id(34),
    parentWaitEvent: id(35),
    parentWaitOutbox: id(36),
    childAttempt: id(37),
    childStep: id(38),
    childTerminalIntent: id(39),
    finalizerAttestation: id(40),
    billingAuthority: id(41),
    childLedger: id(42),
    childTerminalEvent: id(43),
    childTerminalOutbox: id(44),
    childSettlement: id(45),
    parentResumeAttempt: id(46),
    parentResumeEvent: id(47),
    parentResumeOutbox: id(48),
    bypassStep: id(49),
  });
  const sources = prepareG1VerticalSources(ids);
  const publicationVerifier = randomBytes(32).toString('hex');
  const internalVerifier = randomBytes(32).toString('hex');
  const internalSubject = randomBytes(32).toString('hex');

  for (const [attestationId, storage] of [
    [ids.knowledgePublication, sources.knowledge],
    [ids.databasePublication, sources.database],
    [ids.instructionPublication, sources.instruction],
  ]) {
    await harness.psql(
      'ba_management_issuer_test',
      `SELECT auth.issue_g1_source_publication_attestation(
  '${attestationId}', '${ids.workspace}', 'ba_control_test', ${jsonb(storage)},
  decode('${publicationVerifier}', 'hex'), clock_timestamp() + interval '10 minutes'
);`,
      { scanFor: [publicationVerifier] },
    );
  }
  for (const [publisher, attestationId, storage] of [
    ['publish_attested_knowledge_index_generation', ids.knowledgePublication, sources.knowledge],
    ['publish_attested_database_operation_release', ids.databasePublication, sources.database],
    ['publish_attested_instruction_skill_release', ids.instructionPublication, sources.instruction],
  ]) {
    await harness.psql(
      'ba_control_test',
      controlContextSql(
        `SELECT app.${publisher}('${attestationId}', decode('${publicationVerifier}', 'hex'), ${jsonb(storage)});`,
      ),
      { scanFor: [publicationVerifier] },
    );
  }

  await ownerPsql(
    'ba_run_owner',
    `INSERT INTO public.run_attempts (
  workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation
) VALUES ('${ids.workspace}','${ids.attempt}','${fact.run_id}',1,'PENDING',5,0);`,
  );
  await harness.psql(
    'ba_internal_issuer_test',
    `SELECT auth.issue_internal_service_attestation(
  '${ids.internalAttestation}','${ids.workspace}','ba_execution_test'::name,'execution',
  'better-agent/internal-service/1',decode('${internalSubject}','hex'),
  public.hmac(decode('${internalVerifier}','hex'),
    convert_to('better-agent/internal-service-attestation-verifier/1','UTF8') || decode('00','hex'),
    'sha256'),clock_timestamp()+interval '10 minutes'
);`,
    { scanFor: [internalVerifier, internalSubject] },
  );
  const establish = (body) => `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${ids.internalAttestation}', decode('${internalVerifier}', 'hex'), 'execution'
);
${body}
COMMIT;`;
  const call = async (functionName, value) => {
    const result = await harness.psql(
      'ba_execution_test',
      establish(`SELECT app.${functionName}(${jsonb(value)});`),
      { scanFor: [internalVerifier], tuplesOnly: true },
    );
    const line = result.stdout
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .findLast((item) => item.startsWith('{'));
    if (line === undefined) throw new Error(`${functionName} returned no JSON receipt`);
    return JSON.parse(line);
  };
  const authority = await call('claim_run_attempt', {
    run_id: fact.run_id,
    attempt_id: ids.attempt,
    duration_seconds: 300,
  });
  const leased = {
    run_id: fact.run_id,
    attempt_id: ids.attempt,
    lease_token: authority.lease_token,
    lease_fencing_token: authority.lease_fencing_token,
  };
  await call('record_attempt_started', leased);
  await call('record_step_started', {
    ...leased,
    step_id: ids.step,
    step_key: 'g1-fixed-read-capabilities',
    input_hash: sha('g1-fixed-read-input'),
  });

  const knowledgeDraft = {
    schema_version: 'compiled-knowledge-query/1',
    generation_pin: sources.knowledge.full_pin,
    authority_hash: sha('g1-authority'),
    workspace_id: ids.workspace,
    subject_id: ids.subject,
    authorized_sources: [{ source_id: ids.knowledge, source_release_id: ids.knowledgeVersion }],
    text: 'deployment policy',
    filters: [{ field: 'category', operator: 'eq', value: 'guide' }],
    embedding: { model: 'deterministic-embedding' },
    retrieval: { top_k: 3 },
    rerank: { mode: 'none' },
    index_manifest: { shard_hashes: [sha('g1-shard')] },
    timeout_ms: 800,
  };
  const compiledKnowledge = {
    ...knowledgeDraft,
    compiled_hash: canonicalHash(knowledgeDraft),
  };
  const knowledgeReceiptDraft = {
    schema_version: 'knowledge-query-execution-receipt/1',
    receipt_id: ids.knowledgeReceipt,
    operation_key: 'g1:knowledge:fixed',
    compiled_query: compiledKnowledge,
    result_ref: 'snapshot://g1/knowledge',
    result_hash: sha('g1-knowledge-result'),
    result_count: 1,
    duration_ms: 20,
  };
  const knowledgeReceipt = {
    ...knowledgeReceiptDraft,
    receipt_hash: canonicalHash(knowledgeReceiptDraft),
  };
  await call('record_knowledge_query_receipt', {
    ...leased,
    step_id: ids.step,
    receipt: knowledgeReceipt,
  });

  const databaseDraft = {
    schema_version: 'compiled-database-select/1',
    connector_id: ids.database,
    connector_revision_id: ids.databaseVersion,
    database_operation_pin: sources.database.full_pin,
    table_revision_id: ids.databaseVersion,
    operation_contract_hash: sha('g1-database-operation'),
    sql: 'SELECT "title" FROM "app"."records" WHERE "workspace_id" = $1::uuid LIMIT 10',
    values: [ids.workspace],
    result_columns: ['title'],
    max_rows: 10,
    timeout_ms: 700,
    transaction_mode: 'read_only',
  };
  const compiledDatabase = { ...databaseDraft, compiled_hash: canonicalHash(databaseDraft) };
  const databaseReceiptDraft = {
    schema_version: 'database-operation-execution-receipt/1',
    receipt_id: ids.databaseReceipt,
    operation_key: 'g1:database:fixed-select',
    compiled_select: compiledDatabase,
    result_ref: 'snapshot://g1/database',
    result_hash: sha('g1-database-result'),
    row_count: 1,
    duration_ms: 18,
  };
  const databaseReceipt = {
    ...databaseReceiptDraft,
    receipt_hash: canonicalHash(databaseReceiptDraft),
  };
  await call('record_database_operation_receipt', {
    ...leased,
    step_id: ids.step,
    receipt: databaseReceipt,
  });

  await call('record_step_finished', {
    ...leased,
    step_id: ids.step,
    step_status: 'SUCCEEDED',
    output_hash: sha('g1-fixed-read-output'),
  });
  await ownerPsql(
    'ba_run_owner',
    `INSERT INTO public.run_checkpoints (
  workspace_id,id,run_id,checkpoint_hash,payload_ref,payload_redacted
) VALUES (
  '${ids.workspace}','${ids.checkpoint}','${fact.run_id}','${sha('g1-human-checkpoint')}',
  'checkpoint:${ids.checkpoint}','{}'::jsonb
);
INSERT INTO public.human_gates (
  workspace_id,id,run_id,checkpoint_id,gate_type,canonical_operation_hash,
  resolved_plan_hash,barrier_generation,approver_policy_hash,public_schema,status,expires_at
) VALUES (
  '${ids.workspace}','${ids.gate}','${fact.run_id}','${ids.checkpoint}','APPROVAL',
  '${sha('g1-human-operation')}','${fact.accepted_plan_hash}',1,
  '${sha('g1-human-policy')}','{}'::jsonb,'PENDING',clock_timestamp()+interval '10 minutes'
);
UPDATE public.run_attempts SET status='SUCCEEDED',lease_owner=NULL,lease_token=NULL,
  lease_fencing_token=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),
  updated_at=clock_timestamp()
WHERE workspace_id='${ids.workspace}' AND id='${ids.attempt}';
UPDATE public.runs SET status='WAITING_FOR_APPROVAL',execution_status='WAITING_FOR_APPROVAL'
WHERE workspace_id='${ids.workspace}' AND id='${fact.run_id}';`,
  );
  const browserResumeFact = {
    workspaceId: ids.workspace,
    authenticatedPrincipal: {
      schema_version: 'conversation-principal/1',
      kind: 'end_user',
      end_user_principal_id: context.principalId,
    },
    idempotencyKey: 'g1-human-gate-approve',
    runId: fact.run_id,
    gateId: ids.gate,
    action: 'approve',
    requiredScope: 'run:resume',
  };
  await harness.psql(
    'ba_runtime_test',
    context.browserIdentityBlock(
      context.browserSessionId,
      context.browserSessionVerifier,
      `v_result := app.resume_human_gate(
  ${jsonb(browserResumeFact)} || jsonb_build_object('browserIdentity',v_browser_identity)
);
IF v_result #>> '{receipt,data,outcome}' IS DISTINCT FROM 'RUN_RESUMED' THEN
  RAISE EXCEPTION 'G1 browser Human Gate did not resume';
END IF;`,
    ),
    { scanFor: [context.browserSessionVerifier] },
  );

  const childContractHash = sha('g1-child-agent-contract');
  const childManifestHash = sha('g1-child-agent-manifest');
  const childPin = {
    binding_mode: 'pinned',
    contract_hash: childContractHash,
    published_resource_kind: 'AGENT_RELEASE',
    resource_id: ids.childAgent,
    resource_version_id: ids.childRelease,
    workspace_id: ids.workspace,
  };
  const childDocument = {
    agent_id: ids.childAgent,
    agent_release_id: ids.childRelease,
    capability_bindings: [],
    contract_hash: childContractHash,
    public_capability_handles: [],
    schema_version: 'agent-release/1',
    source_draft_revision_id: ids.childDraft,
    workspace_id: ids.workspace,
  };
  const childPrepared = {
    canonical_document: JSON.stringify(childDocument),
    dependency_manifest: {
      dependencies: [],
      manifest_hash: childManifestHash,
      owner: childPin,
      schema_version: 'published-resource-dependency-manifest/1',
    },
    full_pin: childPin,
    schema_version: 'prepared-published-resource/1',
  };
  await ownerPsql(
    'ba_authorization_owner',
    `SELECT app.create_publishable_resource_root('AGENT_RELEASE','${ids.childAgent}');
SELECT app.append_publishable_resource_draft_revision(
  '${ids.childDraft}','AGENT_RELEASE','${ids.childAgent}',1,
  '{"name":"G1 join-only child"}'::jsonb,'${sha('g1-child-draft')}'
);
SELECT app.publish_agent_release(${jsonb(childPrepared)});`,
  );

  const resumedAttemptId = await harness.queryScalar(
    'ba_bootstrap_test',
    `SELECT id FROM public.run_attempts
WHERE workspace_id='${ids.workspace}' AND run_id='${fact.run_id}' AND status='PENDING'
ORDER BY attempt_number DESC LIMIT 1;`,
  );
  const resumedAuthority = await call('claim_run_attempt', {
    run_id: fact.run_id,
    attempt_id: resumedAttemptId,
    duration_seconds: 300,
  });
  const resumedLease = {
    run_id: fact.run_id,
    attempt_id: resumedAttemptId,
    lease_token: resumedAuthority.lease_token,
    lease_fencing_token: resumedAuthority.lease_fencing_token,
  };
  await call('record_attempt_started', resumedLease);

  const asyncChildPolicy = {
    schema_version: 'async-child-policy/1',
    invocation: 'async',
    completion_policy: 'join',
    cancel_propagation: 'cascade',
    result_projection: 'safe_summary',
    parent_terminal_policy: 'wait_for_settlement',
    terminal_outcome_map: {
      schema_version: 'g1-join-child-terminal-map/1',
      SUCCEEDED: 'PARENT_CALL_SUCCEEDED_CONTINUE',
      FAILED: 'PARENT_CALL_FAILED_PARENT_FAILED',
      CANCELLED: 'PARENT_CALL_CANCELLED_PARENT_CANCELLED',
      TIMED_OUT: 'PARENT_CALL_FAILED_CHILD_TIMED_OUT_PARENT_FAILED',
      NEEDS_ATTENTION: 'PARENT_CALL_AND_RUN_NEEDS_ATTENTION',
    },
  };
  const childPolicyHash = canonicalHash(asyncChildPolicy);
  const targetRef = `agent-release:${ids.childAgent}:${ids.childRelease}`;
  const childCeiling = {
    schema_version: 'g1-join-child-ceiling/1',
    target_ref: targetRef,
    max_calls: 1,
    max_depth: 1,
    max_ttl_seconds: 540,
    max_budget_credits: '0',
    delegation_policy_hash: sha('g1-child-delegation'),
  };
  const operationHash = sha('g1-spawn-child');
  const instructionArtifact = JSON.parse(sources.instruction.canonical_source_artifact);
  const planDraft = {
    schema_version: 'compiled-agent-plan/1',
    agent_release: {
      workspace_id: ids.workspace,
      published_resource_kind: 'AGENT_RELEASE',
      resource_id: context.agentId,
      resource_version_id: context.agentReleaseId,
      contract_hash: context.agentContractHash,
      binding_mode: 'pinned',
    },
    resolved_execution_plan_hash: fact.accepted_plan_hash,
    capability_closure_hash: sha('g1-vertical-closure'),
    strategy: {
      strategy_pin: {
        strategy_release_id: 'g1-vertical-strategy',
        implementation_digest: sha('g1-vertical-strategy-implementation'),
      },
    },
    capability_catalog: [
      {
        schema_version: 'agent-capability-catalog-entry/1',
        local_binding_id: 'child',
        binding_kind: 'subagent',
        async_child_policy_hash: childPolicyHash,
        join_child_ceiling: childCeiling,
        target: {
          published_resource_kind: 'AGENT_RELEASE',
          resource_id: ids.childAgent,
          resource_version_id: ids.childRelease,
        },
        operations: [{ contract_hash: operationHash }],
      },
    ],
    instruction_skills: [
      {
        binding_id: 'g1-inert',
        skill_pin: sources.instruction.full_pin,
        content_hash: instructionArtifact.content_hash,
        entry_content_hash: instructionArtifact.inert_content.entry_content_hash,
        script_mode: 'inert',
      },
    ],
    checkpoint_contract_version: 'agent-strategy-checkpoint/1',
  };
  const compiledPlan = { ...planDraft, plan_hash: canonicalHash(planDraft) };
  const planVerifier = randomBytes(32).toString('hex');
  await harness.psql(
    'ba_management_issuer_test',
    `SELECT auth.issue_agent_strategy_plan_attestation(
  '${ids.planAttestation}','${ids.workspace}','${fact.run_id}','${ids.strategyExecution}',
  'ba_execution_test'::name,${jsonb(compiledPlan)},decode('${planVerifier}','hex'),
  clock_timestamp()+interval '10 minutes'
);`,
    { scanFor: [planVerifier] },
  );
  await call('register_agent_strategy_execution', {
    ...resumedLease,
    agent_strategy_execution_id: ids.strategyExecution,
    compiled_agent_plan: compiledPlan,
    plan_attestation_id: ids.planAttestation,
    plan_attestation_verifier: planVerifier,
  });

  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 8 * 60_000).toISOString();
  const admission = {
    schema_version: 'g1-join-child-admission/1',
    workspace_id: ids.workspace,
    parent_run_id: fact.run_id,
    child_run_id: ids.childRun,
    link_id: ids.childLink,
    billing_owner_run_id: fact.run_id,
    parent_plan_hash: fact.accepted_plan_hash,
    parent_checkpoint_id: ids.joinCheckpoint,
    parent_checkpoint_object_ref: `run-checkpoint://${fact.run_id}/${ids.childRun}`,
    parent_checkpoint_sha256: sha('g1-join-checkpoint'),
    child_plan_hash: sha('g1-child-plan'),
    canonical_operation_hash: operationHash,
    binding_id: 'child',
    target_agent_id: ids.childAgent,
    target_agent_release_id: ids.childRelease,
    target_ref: targetRef,
    ancestor_target_refs: [`agent-release:${context.agentId}:${context.agentReleaseId}`],
    parent_depth: 0,
    child_depth: 1,
    completed_child_calls: 0,
    call_sequence: 1,
    allocated_credits: 0,
    admission_snapshot_hash: sha('g1-child-admission'),
    accepted_output_schema_ref: 'schema://g1/child-output',
    accepted_output_schema_hash: sha('g1-child-output'),
    dependency_pins_hash: childManifestHash,
    context_projection_object_ref: `run-context://${ids.childRun}`,
    context_projection_sha256: sha('g1-child-context'),
    delegation_reason: 'G1 bounded join-only acceptance',
    delegation: {
      schema_version: 'g1-bounded-child-delegation/1',
      policy_hash: sha('g1-child-delegation'),
      allowed_target_refs: [targetRef],
      max_calls: 1,
      max_depth: 1,
      max_budget_credits: 0,
      issued_at: issuedAt,
      expires_at: expiresAt,
    },
    compiled_child_ceiling: childCeiling,
    async_child_policy: asyncChildPolicy,
    created_at: createdAt,
  };
  const childFact = {
    admission,
    allocation_id: ids.childAllocation,
    parent_reservation_id: fact.reservation_id,
    attempt_id: resumedAttemptId,
    lease_token: resumedLease.lease_token,
    lease_fencing_token: resumedLease.lease_fencing_token,
    child_event_id: ids.childEvent,
    child_outbox_id: ids.childOutbox,
    parent_wait_event_id: ids.parentWaitEvent,
    parent_wait_outbox_id: ids.parentWaitOutbox,
  };
  const childCreation = await call('create_child_run', childFact);
  assertEqual(
    `${childCreation.child_run_id}|${String(childCreation.replayed)}`,
    `${ids.childRun}|false`,
    'browser Agent admits one fixed join-only child',
  );

  await ownerPsql(
    'ba_run_owner',
    `INSERT INTO public.run_attempts (
  workspace_id,id,run_id,attempt_number,status,runtime_protocol_version,lease_generation
) VALUES ('${ids.workspace}','${ids.childAttempt}','${ids.childRun}',1,'PENDING',5,0);`,
  );
  const childAuthority = await call('claim_run_attempt', {
    run_id: ids.childRun,
    attempt_id: ids.childAttempt,
    duration_seconds: 300,
  });
  const childLease = {
    run_id: ids.childRun,
    attempt_id: ids.childAttempt,
    lease_token: childAuthority.lease_token,
    lease_fencing_token: childAuthority.lease_fencing_token,
  };
  await call('record_attempt_started', childLease);
  await call('record_step_started', {
    ...childLease,
    step_id: ids.childStep,
    step_key: 'join-child-output',
    input_hash: sha('g1-child-input'),
  });
  const terminalIntent = await call('commit_join_child_terminal_intent', {
    ...childLease,
    step_id: ids.childStep,
    terminal_intent_id: ids.childTerminalIntent,
    terminal_status: 'SUCCEEDED',
    termination_reason: 'COMPLETED',
    terminal_payload_redacted: { summary: 'join-only child completed' },
    settled_credits: '0',
    producer_operation_key: 'g1:join-child:terminal',
  });

  const finalizerVerifier = randomBytes(32).toString('hex');
  const finalizerSubject = randomBytes(32).toString('hex');
  await harness.psql(
    'ba_internal_issuer_test',
    `SELECT auth.issue_internal_service_attestation(
  '${ids.finalizerAttestation}','${ids.workspace}','ba_finalizer_test'::name,'finalizer',
  'better-agent/internal-service/1',decode('${finalizerSubject}','hex'),
  public.hmac(decode('${finalizerVerifier}','hex'),
    convert_to('better-agent/internal-service-attestation-verifier/1','UTF8') || decode('00','hex'),
    'sha256'),clock_timestamp()+interval '10 minutes'
);`,
    { scanFor: [finalizerVerifier, finalizerSubject] },
  );
  const finalizerCall = async (functionName, value) => {
    const result = await harness.psql(
      'ba_finalizer_test',
      `BEGIN;
SELECT auth.establish_internal_service_workspace_context(
  '${ids.finalizerAttestation}',decode('${finalizerVerifier}','hex'),'finalizer'
);
SELECT app.${functionName}(${jsonb(value)});
COMMIT;`,
      { scanFor: [finalizerVerifier], tuplesOnly: true },
    );
    const line = result.stdout
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .findLast((item) => item.startsWith('{'));
    if (line === undefined) throw new Error(`${functionName} returned no finalizer receipt`);
    return JSON.parse(line);
  };
  const finishedAt = new Date().toISOString();
  await finalizerCall('finalize_join_child', {
    child_run_id: ids.childRun,
    terminal_intent_id: ids.childTerminalIntent,
    terminal_intent_hash: terminalIntent.terminal_intent_hash,
    authority_id: ids.billingAuthority,
    ledger_entry_id: ids.childLedger,
    terminal_event_id: ids.childTerminalEvent,
    terminal_outbox_id: ids.childTerminalOutbox,
    finished_at: finishedAt,
    events_retention_until: new Date(Date.parse(finishedAt) + 8 * 86_400_000).toISOString(),
    recovery_retention_until: new Date(Date.parse(finishedAt) + 31 * 86_400_000).toISOString(),
    retention_until: new Date(Date.parse(finishedAt) + 91 * 86_400_000).toISOString(),
  });
  const settlement = await finalizerCall('settle_join_child', {
    child_run_id: ids.childRun,
    child_terminal_intent_hash: terminalIntent.terminal_intent_hash,
    settlement_id: ids.childSettlement,
    terminal_payload_object_ref: `run-result://${ids.childRun}`,
    terminal_payload_sha256: canonicalHash({ summary: 'join-only child completed' }),
    parent_attempt_id: ids.parentResumeAttempt,
    parent_event_id: ids.parentResumeEvent,
    parent_outbox_id: ids.parentResumeOutbox,
    settled_at: new Date(Date.now() + 1_000).toISOString(),
  });
  assertEqual(
    `${settlement.parent_run_id}|${settlement.outcome}`,
    `${fact.run_id}|PARENT_RESUMED`,
    'settled join-only child resumes the browser Agent root',
  );

  await ownerPsql(
    'ba_run_owner',
    `SELECT app.append_public_run_event_projection(jsonb_build_object(
  'workspace_id',event.workspace_id,'schema_version','run-event/1','event_id',event.id,
  'sequence',event.sequence::text,'occurred_at',event.occurred_at,
  'accepted_request_id','${fact.accepted_request_id}'::uuid,'run_id',event.run_id,
  'type','run.accepted','data',jsonb_build_object('status','QUEUED')
)) FROM public.run_events event
WHERE event.workspace_id='${ids.workspace}' AND event.run_id='${fact.run_id}'
  AND event.event_type='RUN_ACCEPTED';
SELECT app.append_public_run_event_projection(jsonb_build_object(
  'workspace_id',event.workspace_id,'schema_version','run-event/1','event_id',event.id,
  'sequence',event.sequence::text,'occurred_at',event.occurred_at,
  'accepted_request_id','${fact.accepted_request_id}'::uuid,'run_id',event.run_id,
  'type','run.started','data',jsonb_build_object('status','RUNNING')
)) FROM public.run_events event
WHERE event.workspace_id='${ids.workspace}' AND event.run_id='${fact.run_id}'
  AND event.event_type='RUN_STARTED';
SELECT app.append_public_run_event_projection(jsonb_build_object(
  'workspace_id',event.workspace_id,'schema_version','run-event/1','event_id',event.id,
  'sequence',event.sequence::text,'occurred_at',event.occurred_at,
  'accepted_request_id','${fact.accepted_request_id}'::uuid,'run_id',event.run_id,
  'type','run.resumed','data',jsonb_build_object(
    'gate_id','${ids.gate}'::uuid,'action','approve','resumed_at',event.occurred_at)
)) FROM public.run_events event
WHERE event.workspace_id='${ids.workspace}' AND event.run_id='${fact.run_id}'
  AND event.event_type='RUN_RESUMED' AND event.payload_redacted->>'gate_id'='${ids.gate}';`,
  );

  await harness.psql(
    'ba_runtime_other_test',
    context.browserIdentityBlock(
      context.replayBrowserSessionId,
      context.replayBrowserSessionVerifier,
      `v_events := app.read_public_run_events(
  '${fact.run_id}', 0,
  jsonb_build_object(
    'auth_mode','browser','workspaceId','${ids.workspace}',
    'browserIdentity',v_browser_identity
  )
);
IF jsonb_array_length(v_events->'events') < 3 THEN
  RAISE EXCEPTION 'G1 disconnected browser replay is incomplete';
END IF;`,
    ),
    { scanFor: [context.replayBrowserSessionVerifier] },
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT count(*) FROM public.browser_subject_assertion_uses
    WHERE workspace_id='${ids.workspace}' AND principal_id IS NOT NULL),
  (SELECT count(*) FROM public.knowledge_query_receipts WHERE run_id='${fact.run_id}'),
  (SELECT count(*) FROM public.database_operation_receipts WHERE run_id='${fact.run_id}'),
  (SELECT canonical_document::jsonb->'scripts'->>'mode' FROM public.published_g1_resource_sources
    WHERE workspace_id='${ids.workspace}' AND resource_version_id='${ids.instructionVersion}'),
  (SELECT principal_id::text FROM public.browser_sessions WHERE id='${browserSessionId}')
);`,
    ),
    `4|1|1|inert|${context.principalId}`,
    'browser exchange, fixed capability receipts and inert instruction source share one authority chain',
  );

  assertEqual(
    await harness.queryScalar(
      'ba_bootstrap_test',
      `SELECT concat_ws('|',
  (SELECT status FROM public.runs WHERE id='${ids.childRun}'),
  (SELECT status FROM public.runs WHERE id='${fact.run_id}'),
  (SELECT status||':'||allocated_credits||':'||settled_credits||':'||released_credits
    FROM public.run_budget_allocations WHERE child_run_id='${ids.childRun}'),
  (SELECT count(*) FROM public.join_child_settlement_receipts
    WHERE child_run_id='${ids.childRun}'),
  (SELECT count(*) FROM public.phase_operation_audit
    WHERE workspace_id='${ids.workspace}' AND resource_id IN ('${ids.attempt}','${ids.childAttempt}')),
  (SELECT count(*) FROM public.run_events WHERE run_id='${fact.run_id}')
);`,
    ),
    'SUCCEEDED|QUEUED|RELEASED:0:0:0|1|2|8',
    'independent Run, billing, authorization audit and event readback agree',
  );

  if (process.env.BETTER_AGENT_G1_FAILURE_MATRIX === '1') {
    assertRejected(
      await harness.psql(
        'ba_runtime_test',
        `BEGIN;
SELECT set_config('app.g1_publish_verifier','${context.publishCredentialVerifier}',true);
SELECT count(*) FROM auth.authenticate_api_credential(
  '${context.publishCredentialKey}',decode(current_setting('app.g1_publish_verifier'),'hex')
) authenticated
CROSS JOIN LATERAL app.resolve_agent_service_admission(
  'g006-browser-agent','agent:conversation:write'
) admission;
COMMIT;`,
        { allowFailure: true, scanFor: [context.publishCredentialVerifier] },
      ),
      /isolated runtime credential context|42501/u,
      'publish credential cannot enter the service API path',
    );
    assertRejected(
      await harness.psql(
        'ba_execution_test',
        establish(`INSERT INTO public.published_g1_resource_sources (
  workspace_id,published_resource_kind,resource_id,resource_version_id,contract_hash,
  dependency_manifest_hash,source_schema_version,canonical_document,
  canonical_source_preimage,canonical_source_artifact,stored_by
) VALUES (
  '${ids.workspace}','KNOWLEDGE_INDEX_GENERATION','${id(90)}','${id(91)}',
  '${sha('forged-contract')}','${sha('forged-manifest')}',
  'knowledge-index-generation-source/1','{}','{}','{}','forged'
);`),
        { allowFailure: true, scanFor: [internalVerifier] },
      ),
      /permission denied|42501/u,
      'execution role cannot bypass source publication RLS',
    );
    const latestDraft = {
      ...knowledgeDraft,
      generation_pin: { ...knowledgeDraft.generation_pin, binding_mode: 'latest' },
    };
    const latestCompiled = { ...latestDraft, compiled_hash: canonicalHash(latestDraft) };
    const latestReceiptDraft = {
      ...knowledgeReceiptDraft,
      receipt_id: id(92),
      operation_key: 'g1:knowledge:latest-bypass',
      compiled_query: latestCompiled,
    };
    const latestReceipt = {
      ...latestReceiptDraft,
      receipt_hash: canonicalHash(latestReceiptDraft),
    };
    const bypassAuthority = await call('claim_run_attempt', {
      run_id: fact.run_id,
      attempt_id: ids.parentResumeAttempt,
      duration_seconds: 300,
    });
    const bypassLease = {
      run_id: fact.run_id,
      attempt_id: ids.parentResumeAttempt,
      lease_token: bypassAuthority.lease_token,
      lease_fencing_token: bypassAuthority.lease_fencing_token,
    };
    await call('record_attempt_started', bypassLease);
    await call('record_step_started', {
      ...bypassLease,
      step_id: ids.bypassStep,
      step_key: 'latest-bypass-probe',
      input_hash: sha('latest-bypass-input'),
    });
    assertRejected(
      await harness.psql(
        'ba_execution_test',
        establish(
          `SELECT app.record_knowledge_query_receipt(${jsonb({
            ...bypassLease,
            step_id: ids.bypassStep,
            receipt: latestReceipt,
          })});`,
        ),
        { allowFailure: true, scanFor: [internalVerifier] },
      ),
      /invalid|pin|55000|22023/u,
      'runtime latest binding cannot bypass an exact published pin',
    );
    assertRejected(
      await harness.psql(
        'ba_execution_test',
        establish(
          `SELECT app.create_child_run(${jsonb({
            ...childFact,
            admission: { ...admission, child_plan_hash: sha('g1-drifted-child-plan') },
          })});`,
        ),
        { allowFailure: true, scanFor: [internalVerifier] },
      ),
      /join-child replay conflict|23505/u,
      'join-only child replay cannot drift after authority retirement',
    );
    process.stdout.write('g1-vertical-failure-matrix/1 authority-bypasses pass\n');
  }

  process.stdout.write(
    'G1 vertical Agent acceptance passed: authenticated browser exchange, fixed Knowledge, parameterized read-only Database, inert Instruction Skill, one HumanGate resume, join-only child terminalization, durable replay and independent PostgreSQL readback.\n',
  );
  process.stdout.write('g1-acceptance-receipt/1 vertical-agent-flow pass\n');

  return Object.freeze({ call, ids, leased, sources });
}
