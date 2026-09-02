export const hashA = `sha256:${'a'.repeat(64)}`;
export const hashB = `sha256:${'b'.repeat(64)}`;

export function budget() {
  return {
    schema_version: 'capability-budget/1' as const,
    amount_credits: '9223372036854775807',
    input_tokens: 200,
    output_tokens: 100,
    total_tokens: 250,
    duration_ms: 30_000,
  };
}

export function egress() {
  return {
    schema_version: 'canonical-egress-rule/1' as const,
    network_policy: {
      policy_id: 'deployment-network-1',
      policy_hash: hashA,
      address_class: 'public_only' as const,
    },
    scheme: 'https' as const,
    host: { match: 'subdomains' as const, name: 'example.com' },
    port: 443,
    path: { match: 'subtree' as const, value: '/v1' },
    methods: ['GET', 'POST'] as ('GET' | 'POST')[],
    dns_resolution: 'revalidate_each_connection' as const,
    redirects: {
      mode: 'approved_targets' as const,
      max_hops: 5,
      strip_cross_origin_credentials: true as const,
    },
  };
}

export function ceiling() {
  return {
    schema_version: 'capability-policy-ceiling/1' as const,
    credential_allowances: [
      {
        provider_id: 'provider',
        audience: 'audience',
        allowed_scopes: ['read', 'write'],
        principal_modes: ['caller_delegated', 'service_principal'] as (
          | 'caller_delegated'
          | 'service_principal'
        )[],
      },
    ],
    principal_modes: ['none', 'caller_delegated', 'service_principal'] as (
      | 'none'
      | 'caller_delegated'
      | 'service_principal'
    )[],
    egress: [egress()],
    readable_data_classification_ceiling: 'restricted' as const,
    output_data_classification: 'public' as const,
    side_effect: { maximum_class: 'unsafe' as const, approval: 'none' as const },
    operation_contract_hashes: [hashA, hashB],
    max_calls: 10,
    max_depth: 5,
    max_parallelism: 4,
    budget: budget(),
  };
}

export function requirements() {
  return {
    schema_version: 'capability-requirements/1' as const,
    credential_requirements: [
      {
        schema_version: 'credential-requirement/1' as const,
        requirement_id: 'provider-read',
        provider_id: 'provider',
        audience: 'audience',
        required_scopes: ['read'],
        allowed_principal_modes: ['service_principal'] as 'service_principal'[],
      },
    ],
    principal_modes: ['service_principal'] as 'service_principal'[],
    egress: [
      {
        ...egress(),
        host: { match: 'exact' as const, name: 'api.example.com' },
        methods: ['GET' as const],
      },
    ],
    readable_data_classification: 'internal' as const,
    output_data_classification: 'confidential' as const,
    side_effect_class: 'requires_key' as const,
    approval_required: true,
    operation_contract_hashes: [hashA],
    minimum_limits: {
      calls: 1,
      depth: 1,
      parallelism: 1,
      budget: {
        ...budget(),
        amount_credits: '1',
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        duration_ms: 1,
      },
    },
  };
}
