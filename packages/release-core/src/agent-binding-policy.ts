import { boundedDataSnapshot } from './bounded-data-snapshot.js';
import { normalizeCapabilityPolicyCeiling } from './capability-policy.js';
import { ReleaseCoreError } from './errors.js';

export interface AgentBindingPolicyInput {
  readonly workspace_ceiling: ReturnType<typeof normalizeCapabilityPolicyCeiling>;
  readonly root_ceiling: ReturnType<typeof normalizeCapabilityPolicyCeiling>;
  readonly binding_ceilings: readonly {
    readonly binding_path: string;
    readonly ceiling: ReturnType<typeof normalizeCapabilityPolicyCeiling>;
  }[];
}

function notClosed(path = '$.policy'): never {
  throw new ReleaseCoreError(
    'CLOSURE_BINDING_ENTRY_NOT_CLOSED',
    path,
    'Binding policy inputs do not form one exact closed path projection',
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseAgentBindingPolicyInput(
  input: unknown,
  schemaVersion: string,
): AgentBindingPolicyInput {
  const snapshot = boundedDataSnapshot(input, 'policy');
  if (
    !plainRecord(snapshot) ||
    !exactKeys(snapshot, [
      'schema_version',
      'workspace_ceiling',
      'root_ceiling',
      'binding_ceilings',
    ]) ||
    snapshot.schema_version !== schemaVersion ||
    !Array.isArray(snapshot.binding_ceilings)
  )
    notClosed();
  const bindingCeilings = snapshot.binding_ceilings.map((item, index) => {
    if (
      !plainRecord(item) ||
      !exactKeys(item, ['binding_path', 'ceiling']) ||
      typeof item.binding_path !== 'string'
    )
      notClosed(`$.policy.binding_ceilings[${index}]`);
    return {
      binding_path: item.binding_path,
      ceiling: normalizeCapabilityPolicyCeiling(item.ceiling),
    };
  });
  return {
    workspace_ceiling: normalizeCapabilityPolicyCeiling(snapshot.workspace_ceiling),
    root_ceiling: normalizeCapabilityPolicyCeiling(snapshot.root_ceiling),
    binding_ceilings: bindingCeilings,
  };
}
