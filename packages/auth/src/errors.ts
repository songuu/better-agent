export class AuthenticationInputError extends Error {
  readonly code = 'AUTHENTICATION_FAILED';

  constructor() {
    super('authentication input is invalid');
    this.name = 'AuthenticationInputError';
  }
}

export class BrowserSessionTokenError extends Error {
  readonly code = 'BROWSER_SESSION_TOKEN_INVALID';

  constructor() {
    super('browser session token input is invalid');
    this.name = 'BrowserSessionTokenError';
  }
}

export class AuthorizationBoundaryError extends Error {
  readonly code = 'AUTHORIZATION_CREDENTIAL_PHASE_REJECTED';

  constructor(readonly reason: 'credential_kind' | 'credential_scope' | 'policy_contract') {
    super(`credential authorization phase rejected: ${reason}`);
    this.name = 'AuthorizationBoundaryError';
  }
}

export class SubjectAssertionError extends Error {
  readonly code = 'SUBJECT_ASSERTION_INVALID';

  constructor(readonly reason: string) {
    super(`subject assertion rejected: ${reason}`);
    this.name = 'SubjectAssertionError';
  }
}
