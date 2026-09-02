import { CompiledGateSpecEntryV1Schema } from '@better-agent/domain-contracts';

import { canonicalResourceNodeId } from './closure-identity.js';
import { compareCanonicalStrings, deepFreezeJson } from './dependency-manifest.js';
import { prepareExecutableSource } from './executable-source.js';
import { ReleaseCoreError } from './errors.js';

type CompiledGateSpecEntryV1 = ReturnType<typeof CompiledGateSpecEntryV1Schema.parse>;

interface PreparedAgentGateSpecsV1 {
  readonly schema_version: 'prepared-agent-gate-specs/1';
  readonly root: ReturnType<typeof prepareExecutableSource>['root'];
  readonly gate_specs: readonly CompiledGateSpecEntryV1[];
}

function notClosed(): never {
  throw new ReleaseCoreError(
    'GATE_SPEC_NOT_CLOSED',
    '$.gate_specs',
    'Agent GateSpec cannot be compiled into the closed source-bound contract',
  );
}

/** Compile immutable Agent-root gates; Binding operation coverage is joined in a later step. */
export function prepareAgentGateSpecs(rootInput: unknown): PreparedAgentGateSpecsV1 {
  const source = prepareExecutableSource(rootInput);
  if (source.root.pin.published_resource_kind !== 'AGENT_RELEASE') notClosed();
  const document = source.preimage.document as unknown as {
    gate_specs: readonly {
      gate_spec_id: string;
      gate_spec_hash: string;
      kind: 'input' | 'approval';
      decision_schema_hash: string;
      approver_policy_ref: string;
      approver_policy_hash: string;
      notification_profile_hash?: string;
      on_reject: 'fail_run' | 'cancel_run';
      on_expire: 'fail_run' | 'cancel_run';
      protected_operation_contract_hashes: readonly string[];
    }[];
  };
  const sourceNodeId = canonicalResourceNodeId(source.root.pin);
  const gates = document.gate_specs
    .map((gate) => {
      const parsed = CompiledGateSpecEntryV1Schema.safeParse({
        schema_version: 'compiled-gate-spec/1',
        gate_spec_id: gate.gate_spec_id,
        gate_spec_hash: gate.gate_spec_hash,
        kind: gate.kind,
        decision_schema_hash: gate.decision_schema_hash,
        approver_policy_ref: gate.approver_policy_ref,
        approver_policy_hash: gate.approver_policy_hash,
        ...(gate.notification_profile_hash === undefined
          ? {}
          : { notification_profile_hash: gate.notification_profile_hash }),
        on_reject: gate.on_reject,
        on_expire: gate.on_expire,
        protected_operation_contract_hashes: gate.protected_operation_contract_hashes,
        source_kind: 'agent_release',
        source_node_id: sourceNodeId,
      });
      if (!parsed.success) notClosed();
      return parsed.data;
    })
    .sort((left, right) => compareCanonicalStrings(left.gate_spec_id, right.gate_spec_id));
  return deepFreezeJson({
    schema_version: 'prepared-agent-gate-specs/1',
    root: source.root,
    gate_specs: gates,
  });
}
