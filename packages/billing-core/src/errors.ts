export type BillingCoreErrorCode =
  | 'BILLING_AMOUNT_INVALID'
  | 'BILLING_BALANCE_INSUFFICIENT'
  | 'BILLING_BALANCE_VERSION_EXHAUSTED'
  | 'BILLING_CHILD_ALLOCATION_UNSUPPORTED'
  | 'BILLING_EXPIRED_RESERVATION_CONSUMED'
  | 'BILLING_EXPIRY_NOT_REACHED'
  | 'BILLING_FACT_INVALID'
  | 'BILLING_INTENT_CONFLICT'
  | 'BILLING_LEDGER_MISMATCH'
  | 'BILLING_RESERVATION_EXCEEDED'
  | 'BILLING_RESERVATION_STATE_INVALID'
  | 'BILLING_STATE_TRANSITION_INVALID';

export class BillingCoreError extends Error {
  readonly code: BillingCoreErrorCode;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    code: BillingCoreErrorCode,
    message: string,
    context: Readonly<Record<string, string>> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'BillingCoreError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
