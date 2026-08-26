export type ReleaseCoreErrorCode =
  | 'RELEASE_CANONICALIZATION_INVALID'
  | 'RELEASE_HASH_PROFILE_INVALID'
  | 'RELEASE_INPUT_INVALID'
  | 'RELEASE_DRAFT_FORBIDDEN'
  | 'RELEASE_KIND_UNSUPPORTED'
  | 'RELEASE_KIND_MISMATCH'
  | 'RELEASE_HASH_MISMATCH'
  | 'RELEASE_WORKSPACE_MISMATCH'
  | 'RELEASE_DEPENDENCY_INVALID'
  | 'RELEASE_DEPENDENCY_UNREGISTERED'
  | 'RELEASE_EXPERIENCE_INCOMPATIBLE'
  | 'RELEASE_CREDENTIAL_MAPPING_INVALID'
  | 'RELEASE_DEPLOYMENT_INVALID'
  | 'RELEASE_ADMISSION_SNAPSHOT_INVALID';

export class ReleaseCoreError extends Error {
  constructor(
    readonly code: ReleaseCoreErrorCode,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${code}: ${reason} at ${path}`);
    this.name = 'ReleaseCoreError';
  }
}
