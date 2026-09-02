import {
  type CanonicalEgressRuleV1,
  type CapabilityBudgetV1,
  type CapabilityPolicyCeilingV1,
  CapabilityPolicyCeilingV1Schema,
  type CapabilityRequirementsV1,
  CapabilityRequirementsV1Schema,
  type EffectiveCapabilityPolicyV1,
  EffectiveCapabilityPolicyV1Schema,
} from '@better-agent/domain-contracts';

import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { canonicalJsonBytes } from './canonical-json.js';
import { deepFreezeJson } from './dependency-manifest.js';
import { ReleaseCoreError } from './errors.js';

type Rule = CanonicalEgressRuleV1;
type Ceiling = CapabilityPolicyCeilingV1;
type Allowance = Ceiling['credential_allowances'][number];
const classificationRank = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;
const effectRank = { safe: 0, requires_key: 1, unsafe: 2 } as const;
const redirectRank = { deny: 0, same_origin: 1, approved_targets: 2 } as const;
const budgetNumbers = ['input_tokens', 'output_tokens', 'total_tokens', 'duration_ms'] as const;

function invalid(path: string): never {
  throw new ReleaseCoreError(
    'CLOSURE_POLICY_INPUT_INVALID',
    path,
    'policy does not match its closed versioned contract',
  );
}
function unavailable(path: string): never {
  throw new ReleaseCoreError(
    'CLOSURE_POLICY_REQUIREMENT_UNAVAILABLE',
    path,
    'an intrinsic capability requirement exceeds the effective authority',
  );
}
function limit(): never {
  throw new ReleaseCoreError(
    'CLOSURE_POLICY_LIMIT_EXCEEDED',
    '$.egress',
    'egress normalization exceeds its absolute rule budget',
  );
}

function parse<T>(
  input: unknown,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T {
  const result = schema.safeParse(boundedDataSnapshot(input, 'policy'));
  if (!result.success) invalid('$');
  return result.data;
}

function intersection<T extends string>(left: T[], right: T[]): T[] {
  const allowed = new Set(right);
  return left.filter((value) => allowed.has(value)).sort();
}
function canonicalSort<T>(values: T[]): T[] {
  return values
    .map((value) => ({ value, bytes: canonicalJsonBytes(value) }))
    .sort((left, right) => Buffer.compare(left.bytes, right.bytes))
    .map(({ value }) => value);
}
function lower<T extends string>(left: T, right: T, rank: Record<T, number>): T {
  return rank[left] <= rank[right] ? left : right;
}
function higher<T extends string>(left: T, right: T, rank: Record<T, number>): T {
  return rank[left] >= rank[right] ? left : right;
}

function hostContains(parent: Rule['host'], child: Rule['host']): boolean {
  if (parent.match === 'exact') return child.match === 'exact' && child.name === parent.name;
  return (
    (child.match === 'subdomains' && child.name === parent.name) ||
    child.name.endsWith(`.${parent.name}`)
  );
}
function pathContains(parent: Rule['path'], child: Rule['path']): boolean {
  if (parent.match === 'exact') return child.match === 'exact' && child.value === parent.value;
  return (
    parent.value === '/' ||
    child.value === parent.value ||
    child.value.startsWith(`${parent.value}/`)
  );
}
function sameNetwork(left: Rule, right: Rule): boolean {
  return (
    left.scheme === right.scheme &&
    left.port === right.port &&
    left.network_policy.policy_id === right.network_policy.policy_id &&
    left.network_policy.policy_hash === right.network_policy.policy_hash &&
    left.network_policy.address_class === right.network_policy.address_class
  );
}
function contains(parent: Rule, child: Rule): boolean {
  return (
    sameNetwork(parent, child) &&
    hostContains(parent.host, child.host) &&
    pathContains(parent.path, child.path) &&
    child.methods.every((method) => parent.methods.includes(method)) &&
    redirectRank[parent.redirects.mode] >= redirectRank[child.redirects.mode] &&
    parent.redirects.max_hops >= child.redirects.max_hops
  );
}

function atoms(rules: Rule[]): Rule[] {
  return rules.flatMap((rule) => rule.methods.map((method) => ({ ...rule, methods: [method] })));
}

function normalizeRules(rules: Rule[]): Rule[] {
  const unique = new Map<string, Rule>();
  for (const rule of atoms(rules)) {
    unique.set(canonicalJsonBytes(rule).toString('utf8'), rule);
    if (unique.size > 1_024) limit();
  }
  const candidates = [...unique.values()];
  // Method atoms prevent a redundant GET region from depending on how GET/POST were grouped.
  const minimal = candidates.filter(
    (child, index) =>
      !candidates.some((parent, other) => index !== other && contains(parent, child)),
  );
  const grouped = new Map<string, Rule>();
  for (const rule of minimal) {
    const key = canonicalJsonBytes({ ...rule, methods: [] }).toString('utf8');
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, { ...rule, methods: [...rule.methods] });
    else existing.methods.push(...rule.methods);
  }
  if (grouped.size > 32) limit();
  return canonicalSort(
    [...grouped.values()].map((rule) => ({ ...rule, methods: rule.methods.sort() })),
  );
}

function intersectRules(left: Rule[], right: Rule[]): Rule[] {
  const candidates = new Map<string, Rule>();
  for (const a of atoms(left)) {
    for (const b of atoms(right)) {
      if (!sameNetwork(a, b) || a.methods[0] !== b.methods[0]) continue;
      const host = hostContains(a.host, b.host)
        ? b.host
        : hostContains(b.host, a.host)
          ? a.host
          : undefined;
      const path = pathContains(a.path, b.path)
        ? b.path
        : pathContains(b.path, a.path)
          ? a.path
          : undefined;
      if (host === undefined || path === undefined) continue;
      const rule: Rule = {
        ...a,
        host,
        path,
        redirects: {
          mode: lower(a.redirects.mode, b.redirects.mode, redirectRank),
          max_hops: Math.min(a.redirects.max_hops, b.redirects.max_hops),
          strip_cross_origin_credentials: true,
        },
      };
      candidates.set(canonicalJsonBytes(rule).toString('utf8'), rule);
      if (candidates.size > 1_024) limit();
    }
  }
  return normalizeRules([...candidates.values()]);
}

function sameCredential(
  left: Pick<Allowance, 'provider_id' | 'audience'>,
  right: Pick<Allowance, 'provider_id' | 'audience'>,
): boolean {
  return left.provider_id === right.provider_id && left.audience === right.audience;
}
function canonicalCeiling(value: Ceiling): Ceiling {
  return {
    ...value,
    principal_modes: value.principal_modes.sort(),
    credential_allowances: canonicalSort(
      value.credential_allowances
        .map((allowance) => ({
          ...allowance,
          allowed_scopes: allowance.allowed_scopes.sort(),
          principal_modes: allowance.principal_modes
            .filter((mode) => value.principal_modes.includes(mode))
            .sort(),
        }))
        .filter(
          (allowance) =>
            allowance.allowed_scopes.length > 0 && allowance.principal_modes.length > 0,
        ),
    ),
    egress: normalizeRules(value.egress),
    operation_contract_hashes: value.operation_contract_hashes.sort(),
  };
}

/** Pure data, not an authorization attestation. Registry/grant verification belongs to admission. */
export function normalizeCapabilityPolicyCeiling(input: unknown): Readonly<Ceiling> {
  return sealCeiling(parse(input, CapabilityPolicyCeilingV1Schema));
}

function sealCeiling(value: Ceiling): Readonly<Ceiling> {
  // Intersection can multiply host/path regions: legal inputs do not imply bounded output.
  return deepFreezeJson(parse(canonicalCeiling(value), CapabilityPolicyCeilingV1Schema));
}

function meetBudget(left: CapabilityBudgetV1, right: CapabilityBudgetV1): CapabilityBudgetV1 {
  return {
    schema_version: 'capability-budget/1',
    amount_credits:
      BigInt(left.amount_credits) <= BigInt(right.amount_credits)
        ? left.amount_credits
        : right.amount_credits,
    input_tokens: Math.min(left.input_tokens, right.input_tokens),
    output_tokens: Math.min(left.output_tokens, right.output_tokens),
    total_tokens: Math.min(left.total_tokens, right.total_tokens),
    duration_ms: Math.min(left.duration_ms, right.duration_ms),
  };
}

export function meetCapabilityPolicyCeilings(
  leftInput: unknown,
  rightInput: unknown,
): Readonly<Ceiling> {
  const left = canonicalCeiling(parse(leftInput, CapabilityPolicyCeilingV1Schema));
  const right = canonicalCeiling(parse(rightInput, CapabilityPolicyCeilingV1Schema));
  const credential_allowances = left.credential_allowances.flatMap((a) => {
    const b = right.credential_allowances.find((candidate) => sameCredential(a, candidate));
    return b === undefined
      ? []
      : [
          {
            ...a,
            allowed_scopes: intersection(a.allowed_scopes, b.allowed_scopes),
            principal_modes: intersection(a.principal_modes, b.principal_modes),
          },
        ];
  });
  return sealCeiling({
    schema_version: 'capability-policy-ceiling/1',
    credential_allowances,
    principal_modes: intersection(left.principal_modes, right.principal_modes),
    egress: intersectRules(left.egress, right.egress),
    readable_data_classification_ceiling: lower(
      left.readable_data_classification_ceiling,
      right.readable_data_classification_ceiling,
      classificationRank,
    ),
    output_data_classification: higher(
      left.output_data_classification,
      right.output_data_classification,
      classificationRank,
    ),
    side_effect: {
      maximum_class: lower(
        left.side_effect.maximum_class,
        right.side_effect.maximum_class,
        effectRank,
      ),
      approval:
        left.side_effect.approval === 'required' || right.side_effect.approval === 'required'
          ? 'required'
          : 'none',
    },
    operation_contract_hashes: intersection(
      left.operation_contract_hashes,
      right.operation_contract_hashes,
    ),
    max_calls: Math.min(left.max_calls, right.max_calls),
    max_depth: Math.min(left.max_depth, right.max_depth),
    max_parallelism: Math.min(left.max_parallelism, right.max_parallelism),
    budget: meetBudget(left.budget, right.budget),
  });
}

function assertDemandLimits(ceiling: Ceiling, required: CapabilityRequirementsV1): void {
  if (
    classificationRank[required.readable_data_classification] >
    classificationRank[ceiling.readable_data_classification_ceiling]
  )
    unavailable('$.readable_data_classification');
  if (effectRank[required.side_effect_class] > effectRank[ceiling.side_effect.maximum_class])
    unavailable('$.side_effect_class');
  for (const [demand, bound] of [
    ['calls', 'max_calls'],
    ['depth', 'max_depth'],
    ['parallelism', 'max_parallelism'],
  ] as const) {
    if (required.minimum_limits[demand] > ceiling[bound]) unavailable(`$.minimum_limits.${demand}`);
  }
  const budget = required.minimum_limits.budget;
  if (BigInt(budget.amount_credits) > BigInt(ceiling.budget.amount_credits))
    unavailable('$.minimum_limits.budget.amount_credits');
  for (const field of budgetNumbers)
    if (budget[field] > ceiling.budget[field]) unavailable(`$.minimum_limits.budget.${field}`);
  // Both minima must fit simultaneously; adding safe integers as Number can lose precision.
  if (
    BigInt(budget.input_tokens) + BigInt(budget.output_tokens) >
    BigInt(ceiling.budget.total_tokens)
  ) {
    unavailable('$.minimum_limits.budget.total_tokens');
  }
}

/** Validate demands in full before narrowing; never intersect away a required scope/operation. */
export function resolveEffectiveCapabilityPolicy(
  ceilingInput: unknown,
  requirementsInput: unknown,
): Readonly<EffectiveCapabilityPolicyV1> {
  const ceiling = canonicalCeiling(parse(ceilingInput, CapabilityPolicyCeilingV1Schema));
  const required = parse(requirementsInput, CapabilityRequirementsV1Schema);
  let modes = intersection(ceiling.principal_modes, required.principal_modes);
  for (const credential of required.credential_requirements) {
    const allowance = ceiling.credential_allowances.find((value) =>
      sameCredential(value, credential),
    );
    if (
      allowance === undefined ||
      !credential.required_scopes.every((scope) => allowance.allowed_scopes.includes(scope))
    )
      unavailable('$.credential_requirements');
    const allowedModes = intersection(
      credential.allowed_principal_modes,
      allowance.principal_modes,
    );
    modes = modes.filter((mode) => mode !== 'none' && allowedModes.includes(mode));
  }
  if (modes.length === 0) unavailable('$.principal_modes');
  if (
    !required.operation_contract_hashes.every((hash) =>
      ceiling.operation_contract_hashes.includes(hash),
    )
  )
    unavailable('$.operation_contract_hashes');
  const egress = normalizeRules(required.egress);
  const allowedAtoms = atoms(ceiling.egress);
  if (!atoms(egress).every((rule) => allowedAtoms.some((allowed) => contains(allowed, rule))))
    unavailable('$.egress');
  assertDemandLimits(ceiling, required);
  const { schema_version: _version, credential_allowances: _allowances, ...effective } = ceiling;
  const result = parse(
    {
      ...effective,
      credential_requirements: canonicalSort(
        required.credential_requirements.map((credential) => ({
          ...credential,
          required_scopes: credential.required_scopes.sort(),
          allowed_principal_modes: credential.allowed_principal_modes
            .filter((mode) => modes.includes(mode))
            .sort(),
        })),
      ),
      principal_modes: modes,
      egress,
      operation_contract_hashes: required.operation_contract_hashes.sort(),
      output_data_classification: higher(
        ceiling.output_data_classification,
        required.output_data_classification,
        classificationRank,
      ),
      side_effect: {
        ...ceiling.side_effect,
        approval:
          required.approval_required || ceiling.side_effect.approval === 'required'
            ? 'required'
            : 'none',
      },
    },
    EffectiveCapabilityPolicyV1Schema,
  );
  return deepFreezeJson(result);
}
