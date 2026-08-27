import { failRunCore } from './errors.js';

/** G0-06 freezes Gate facts but deliberately exposes no positive mutation path. */
export function applyHumanGateMutation(_input: unknown): never {
  failRunCore(
    'RUN_HUMAN_GATE_APPLY_UNAVAILABLE',
    '$',
    'HumanGate apply awaits G0-07 lease/fence and a published GateSpec',
  );
}
