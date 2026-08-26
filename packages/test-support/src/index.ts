/**
 * Declares an immutable fixture at the point where a test owns its input.
 * Runtime freezing catches accidental fixture mutation between test cases.
 */
export function defineFixture<const Fixture>(fixture: Fixture): Readonly<Fixture> {
  return Object.freeze(fixture);
}

/**
 * Keeps exhaustiveness failures explicit and preserves the caller's context.
 */
export function assertUnreachable(value: never, context: string): never {
  throw new Error(`${context}: unexpected value ${JSON.stringify(value)}`);
}
