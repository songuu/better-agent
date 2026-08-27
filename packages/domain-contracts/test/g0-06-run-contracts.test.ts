import { describe, expect, it } from 'vitest';

import {
  ConversationPrincipalV1Schema,
  ConversationStateCasV1Schema,
  ConversationV1Schema,
} from '../src/conversation-v1.js';
import {
  RunIdempotencyNamespaceV1Schema,
  RunIdempotencyRequestV1Schema,
} from '../src/run-idempotency-v1.js';
import {
  PublicRunStatusV1Schema,
  RunAcceptanceV1Schema,
  RunSnapshotV1Schema,
  RunStatusV1Schema,
} from '../src/run-v1.js';

const workspaceId = '018f47f2-c541-7cc6-9292-4a2c35303eee';
const credentialId = '018f47f2-c541-7cc6-9292-4a2c35303e01';
const principalId = '018f47f2-c541-7cc6-9292-4a2c35303e02';
const conversationId = '018f47f2-c541-7cc6-9292-4a2c35303e03';
const agentDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e04';
const agentRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e05';
const agentId = '018f47f2-c541-7cc6-9292-4a2c35303e06';
const agentReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e07';
const experienceReleaseId = '018f47f2-c541-7cc6-9292-4a2c35303e08';
const flowDeploymentId = '018f47f2-c541-7cc6-9292-4a2c35303e09';
const flowRevisionId = '018f47f2-c541-7cc6-9292-4a2c35303e0a';
const flowId = '018f47f2-c541-7cc6-9292-4a2c35303e0b';
const flowVersionId = '018f47f2-c541-7cc6-9292-4a2c35303e0c';
const runId = '018f47f2-c541-7cc6-9292-4a2c35303e0d';
const requestId = '018f47f2-c541-7cc6-9292-4a2c35303e0e';
const messageId = '018f47f2-c541-7cc6-9292-4a2c35303e0f';
const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const hashC = `sha256:${'c'.repeat(64)}`;

const credentialPrincipal = {
  schema_version: 'conversation-principal/1',
  kind: 'credential',
  credential_id: credentialId,
} as const;

const endUserPrincipal = {
  schema_version: 'conversation-principal/1',
  kind: 'end_user',
  end_user_principal_id: principalId,
} as const;

const conversation = {
  schema_version: 'conversation/1',
  workspace_id: workspaceId,
  conversation_id: conversationId,
  principal: endUserPrincipal,
  agent_deployment_id: agentDeploymentId,
  created_under_agent_deployment_revision_id: agentRevisionId,
  conversation_contract_hash: hashA,
  state_version: 0,
} as const;

const agentAcceptance = {
  schema_version: 'run-acceptance/1',
  workspace_id: workspaceId,
  run_id: runId,
  accepted_request_id: requestId,
  accepted_principal: endUserPrincipal,
  admission_snapshot_hash: hashA,
  accepted_plan_hash: hashB,
  accepted_output_schema_ref: 'registry://agent-output/1',
  accepted_output_schema_hash: hashC,
  dependency_pins_hash: hashC,
  status: 'QUEUED',
  execution_status: 'ACCEPTED',
  billing_state: 'PENDING',
  target: {
    schema_version: 'run-target/1',
    target_kind: 'agent',
    agent_deployment_id: agentDeploymentId,
    agent_deployment_revision_id: agentRevisionId,
    agent_id: agentId,
    agent_release_id: agentReleaseId,
    experience_release_id: experienceReleaseId,
    conversation_id: conversationId,
    conversation_contract_hash: hashA,
    accepted_conversation_state_version: 1,
    user_message_id: messageId,
  },
} as const;

describe('G0-06 Conversation contracts', () => {
  it('accepts exactly one runtime principal kind and a safe monotonic state boundary', () => {
    expect(ConversationPrincipalV1Schema.safeParse(credentialPrincipal).success).toBe(true);
    expect(ConversationPrincipalV1Schema.safeParse(endUserPrincipal).success).toBe(true);
    expect(
      ConversationPrincipalV1Schema.safeParse({
        ...credentialPrincipal,
        end_user_principal_id: principalId,
      }).success,
    ).toBe(false);
    expect(
      ConversationPrincipalV1Schema.safeParse({
        schema_version: 'conversation-principal/1',
        kind: 'user',
        user_id: principalId,
      }).success,
    ).toBe(false);
    expect(
      ConversationPrincipalV1Schema.safeParse({
        schema_version: 'conversation-principal/2',
        kind: 'credential',
        credential_id: credentialId,
      }).success,
    ).toBe(false);

    expect(ConversationV1Schema.safeParse(conversation).success).toBe(true);
    expect(ConversationV1Schema.safeParse({ ...conversation, state_version: -1 }).success).toBe(
      false,
    );
    expect(
      ConversationV1Schema.safeParse({
        ...conversation,
        state_version: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      ConversationStateCasV1Schema.safeParse({
        schema_version: 'conversation-state-cas/1',
        workspace_id: workspaceId,
        conversation_id: conversationId,
        expected_state_version: 0,
        next_state_version: 1,
      }).success,
    ).toBe(false);
  });
});

describe('G0-06 Run acceptance and terminal facts', () => {
  it('keeps Agent Chat pins complete, Flow pins disjoint and Plan identity independent', () => {
    expect(RunAcceptanceV1Schema.safeParse(agentAcceptance).success).toBe(true);

    for (const field of [
      'conversation_id',
      'conversation_contract_hash',
      'accepted_conversation_state_version',
      'user_message_id',
    ] as const) {
      const target = { ...agentAcceptance.target };
      delete target[field];
      expect(RunAcceptanceV1Schema.safeParse({ ...agentAcceptance, target }).success).toBe(false);
    }

    const flowAcceptance = {
      ...agentAcceptance,
      accepted_principal: credentialPrincipal,
      target: {
        schema_version: 'run-target/1',
        target_kind: 'flow',
        flow_deployment_id: flowDeploymentId,
        flow_deployment_revision_id: flowRevisionId,
        flow_id: flowId,
        flow_version_id: flowVersionId,
      },
    } as const;
    expect(RunAcceptanceV1Schema.safeParse(flowAcceptance).success).toBe(true);
    expect(
      RunAcceptanceV1Schema.safeParse({
        ...flowAcceptance,
        target: { ...flowAcceptance.target, conversation_id: conversationId },
      }).success,
    ).toBe(false);
    expect(
      RunAcceptanceV1Schema.safeParse({
        ...agentAcceptance,
        accepted_plan_hash: agentAcceptance.admission_snapshot_hash,
      }).success,
    ).toBe(false);
  });

  it('separates public status from scheduling status and closes terminal billing shapes', () => {
    expect(RunStatusV1Schema.safeParse('NEEDS_ATTENTION').success).toBe(true);
    expect(PublicRunStatusV1Schema.safeParse('NEEDS_ATTENTION').success).toBe(false);

    const queued = {
      schema_version: 'run-snapshot/1',
      workspace_id: workspaceId,
      run_id: runId,
      status: 'QUEUED',
      execution_status: 'ACCEPTED',
      billing_state: 'PENDING',
    } as const;
    expect(RunSnapshotV1Schema.safeParse(queued).success).toBe(true);
    expect(RunSnapshotV1Schema.safeParse({ ...queued, terminal_result_redacted: {} }).success).toBe(
      false,
    );

    const succeeded = {
      ...queued,
      status: 'SUCCEEDED',
      execution_status: 'SUCCEEDED',
      termination_reason: 'COMPLETED',
      finished_at: '2026-08-27T00:00:00Z',
      terminal_billing_pending: false,
      terminal_billing_pending_at: '2026-08-27T00:00:00Z',
      terminal_result_redacted: {},
      billing_state: 'SETTLED',
      billing_settled_at: '2026-08-27T00:00:00Z',
    } as const;
    expect(RunSnapshotV1Schema.safeParse(succeeded).success).toBe(true);
    expect(
      RunSnapshotV1Schema.safeParse({ ...succeeded, terminal_error_redacted: {} }).success,
    ).toBe(false);
    expect(
      RunSnapshotV1Schema.safeParse({
        ...succeeded,
        status: 'FAILED',
        execution_status: 'FAILED',
        termination_reason: 'INTERNAL_FAILURE',
        terminal_result_redacted: undefined,
        terminal_error_redacted: {},
        billing_state: 'NEEDS_ATTENTION',
        billing_settled_at: undefined,
      }).success,
    ).toBe(false);
    expect(
      RunSnapshotV1Schema.safeParse({
        ...succeeded,
        status: 'CANCELLED',
        execution_status: 'CANCELLED',
        termination_reason: 'INTERNAL_FAILURE',
        terminal_result_redacted: undefined,
        terminal_error_redacted: {
          code: 'INTERNAL_FAILURE',
          retryable: false,
          category: 'EXECUTION',
        },
      }).success,
    ).toBe(false);
    expect(
      RunSnapshotV1Schema.safeParse({
        ...succeeded,
        status: 'FAILED',
        execution_status: 'FAILED',
        termination_reason: 'INTERNAL_FAILURE',
        terminal_result_redacted: undefined,
        terminal_error_redacted: {
          code: 'INTERNAL_FAILURE',
          retryable: false,
          category: 'EXECUTION',
          requires_operator_action: true,
        },
      }).success,
    ).toBe(false);
  });
});

describe('G0-06 idempotency namespace', () => {
  it('includes route in the namespace and requires a key only for resume', () => {
    const base = {
      schema_version: 'run-idempotency-namespace/1',
      workspace_id: workspaceId,
      authenticated_principal: credentialPrincipal,
      idempotency_key: 'same-key',
    } as const;
    expect(
      RunIdempotencyNamespaceV1Schema.safeParse({
        ...base,
        fixed_route: '/v1/oapi/agent/chat',
      }).success,
    ).toBe(true);
    expect(
      RunIdempotencyNamespaceV1Schema.safeParse({
        ...base,
        fixed_route: '/v1/oapi/flow/run',
      }).success,
    ).toBe(true);

    for (const fixedRoute of ['/v1/oapi/agent/chat', '/v1/oapi/runs/{run_id}/cancel'] as const) {
      expect(
        RunIdempotencyRequestV1Schema.safeParse({
          schema_version: 'run-idempotency-request/1',
          fixed_route: fixedRoute,
          idempotency_key: null,
        }).success,
      ).toBe(true);
      expect(
        RunIdempotencyRequestV1Schema.safeParse({
          schema_version: 'run-idempotency-request/1',
          fixed_route: fixedRoute,
        }).success,
      ).toBe(true);
    }

    expect(
      RunIdempotencyRequestV1Schema.safeParse({
        schema_version: 'run-idempotency-request/1',
        fixed_route: '/v1/oapi/runs/{run_id}/gates/{gate_id}/resume',
        idempotency_key: '',
      }).success,
    ).toBe(false);
  });
});
