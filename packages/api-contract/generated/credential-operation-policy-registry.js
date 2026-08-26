// Generated from docs/api/openapi.yaml by @better-agent/api-contract.
// DO NOT EDIT: run `pnpm --filter @better-agent/api-contract generate`.

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

const reviewedServiceCredentialOperations = deepFreeze({
  "createAgentChatRun": {
    "method": "POST",
    "path": "/v1/oapi/agent/chat",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "operation_purpose": "agent_invoke",
      "required_scopes": [
        "agent:run:create"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "exactly_one_deployment",
      "typed_grant_family": "agent_deployment_entry_grants"
    }
  },
  "createAgentConversation": {
    "method": "POST",
    "path": "/v1/oapi/agent/conversation",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "operation_purpose": "agent_invoke",
      "required_scopes": [
        "agent:conversation:write"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "exactly_one_deployment",
      "typed_grant_family": "agent_deployment_entry_grants"
    }
  },
  "createFlowRun": {
    "method": "POST",
    "path": "/v1/oapi/flow/run",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "operation_purpose": "flow_invoke",
      "required_scopes": [
        "flow:run:create"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "exactly_one_flow",
      "typed_grant_family": "flow_deployment_entry_grants"
    }
  },
  "exchangeBrowserSession": {
    "method": "POST",
    "path": "/v1/oapi/browser/sessions/exchange",
    "policy": {
      "allowed_kinds": [
        "publish"
      ],
      "operation_purpose": "deployment_publish",
      "required_scopes": [
        "browser-session:exchange"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "exactly_one_deployment",
      "typed_grant_family": "agent_deployment_entry_grants"
    }
  },
  "getRun": {
    "method": "GET",
    "path": "/v1/oapi/runs/{run_id}",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "allowed_original_run_target_kinds": [
        "agent",
        "flow"
      ],
      "operation_purpose": "run_read",
      "required_scopes": [
        "run:read"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "original_run_only",
      "typed_grant_family": "original_run_entry_grant"
    }
  },
  "listAgentConversationMessages": {
    "method": "GET",
    "path": "/v1/oapi/agent/conversation/messages",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "operation_purpose": "agent_invoke",
      "required_scopes": [
        "agent:conversation:read"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "exactly_one_deployment",
      "typed_grant_family": "agent_deployment_entry_grants"
    }
  },
  "listAgentConversations": {
    "method": "GET",
    "path": "/v1/oapi/agent/conversations",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "operation_purpose": "agent_invoke",
      "required_scopes": [
        "agent:conversation:read"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "exactly_one_deployment",
      "typed_grant_family": "agent_deployment_entry_grants"
    }
  },
  "requestRunCancellation": {
    "method": "POST",
    "path": "/v1/oapi/runs/{run_id}/cancel",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "allowed_original_run_target_kinds": [
        "agent",
        "flow"
      ],
      "operation_purpose": "run_cancel",
      "required_scopes": [
        "run:cancel"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "original_run_only",
      "typed_grant_family": "original_run_entry_grant"
    }
  },
  "resumeHumanGate": {
    "method": "POST",
    "path": "/v1/oapi/runs/{run_id}/gates/{gate_id}/resume",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "allowed_original_run_target_kinds": [
        "agent",
        "flow"
      ],
      "operation_purpose": "run_resume",
      "required_scopes": [
        "run:resume"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "original_run_only",
      "typed_grant_family": "original_run_entry_grant"
    }
  },
  "streamRunEvents": {
    "method": "GET",
    "path": "/v1/oapi/runs/{run_id}/events",
    "policy": {
      "allowed_kinds": [
        "service_api"
      ],
      "allowed_original_run_target_kinds": [
        "agent",
        "flow"
      ],
      "operation_purpose": "run_events_read",
      "required_scopes": [
        "run:events:read"
      ],
      "schema_version": "credential-operation-policy/1",
      "target_cardinality": "original_run_only",
      "typed_grant_family": "original_run_entry_grant"
    }
  }
});

export const credentialOperationPolicyRegistrySchemaVersion = "openapi-credential-operation-policy/1";

export const serviceCredentialOperationIds = Object.freeze(
  Object.keys(reviewedServiceCredentialOperations),
);

export function getReviewedServiceCredentialOperation(operationId) {
  return Object.hasOwn(reviewedServiceCredentialOperations, operationId)
    ? reviewedServiceCredentialOperations[operationId]
    : undefined;
}
