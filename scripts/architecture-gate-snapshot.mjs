import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalSha256, validateArchitectureGateManifest } from './architecture-gate-core.mjs';
import {
  architectureGateError,
  combineGateErrors,
  gitBytes,
  manifestSummary,
  sha256Bytes,
} from './architecture-gate-runtime.mjs';

const SNAPSHOT_BUDGET = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
});
export const SNAPSHOT_PREFIX = 'better-agent-g0-08-';

export function validateSnapshotRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\\') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    throw architectureGateError(
      `snapshot path is not a safe repository-relative path: ${String(value)}`,
    );
  }
  const segments = value.split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    segments[0]?.toLowerCase() === '.git'
  ) {
    throw architectureGateError(`snapshot path escapes or targets Git metadata: ${value}`);
  }
  return value;
}

export function isControlPlanePath(value) {
  const normalized = validateSnapshotRelativePath(value).toLowerCase();
  return (
    normalized === 'docs/plans/.handoff' ||
    normalized.startsWith('docs/plans/.handoff/') ||
    (normalized.startsWith('docs/plans/') && normalized.endsWith('.acceptance.json'))
  );
}

export function parseGitPathList(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes)) throw architectureGateError('Git path list must be a Buffer');
  const paths = bytes
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0)
    .map(validateSnapshotRelativePath)
    .filter((value) => options.excludeControlPlane === false || !isControlPlanePath(value));
  if (new Set(paths).size !== paths.length) {
    throw architectureGateError('Git path list contains duplicate entries');
  }
  return paths;
}

export function createSourceManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw architectureGateError('source manifest requires at least one file');
  }
  const normalized = entries
    .map((entry) => {
      if (entry === null || typeof entry !== 'object' || !Buffer.isBuffer(entry.bytes)) {
        throw architectureGateError('source manifest entries require path and Buffer bytes');
      }
      return { path: validateSnapshotRelativePath(entry.path), bytes: entry.bytes };
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (
    new Set(normalized.map(({ path: relativePath }) => relativePath)).size !== normalized.length
  ) {
    throw architectureGateError('source manifest contains duplicate paths');
  }
  const hash = createHash('sha256');
  let totalBytes = 0;
  let largestFileBytes = 0;
  for (const entry of normalized) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    hash.update(Buffer.from(`${pathBytes.length}:`, 'ascii'));
    hash.update(pathBytes);
    hash.update(Buffer.from(`${entry.bytes.length}:`, 'ascii'));
    hash.update(entry.bytes);
    totalBytes += entry.bytes.length;
    largestFileBytes = Math.max(largestFileBytes, entry.bytes.length);
  }
  assertSnapshotBudget({
    fileCount: normalized.length,
    largestFileBytes,
    totalBytes,
  });
  return Object.freeze({
    digest: `sha256:${hash.digest('hex')}`,
    fileCount: normalized.length,
    paths: Object.freeze(normalized.map(({ path: relativePath }) => relativePath)),
    totalBytes,
  });
}

export function assertSnapshotBudget(value, limits = SNAPSHOT_BUDGET) {
  if (value.fileCount > limits.maxFiles) {
    throw architectureGateError(
      `snapshot file count ${String(value.fileCount)} exceeds ${String(limits.maxFiles)}`,
    );
  }
  if (value.largestFileBytes > limits.maxFileBytes) {
    throw architectureGateError(
      `snapshot single file ${String(value.largestFileBytes)} bytes exceeds ${String(limits.maxFileBytes)}`,
    );
  }
  if (value.totalBytes > limits.maxTotalBytes) {
    throw architectureGateError(
      `snapshot total bytes ${String(value.totalBytes)} exceeds ${String(limits.maxTotalBytes)}`,
    );
  }
}

export function architectureMutationTestArguments() {
  return ['--test', 'tests/architecture-gate/architecture-gate.test.mjs'];
}

export function assertSourceStatusUnchanged(before, after) {
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after) || !before.equals(after)) {
    throw architectureGateError('source Git status changed while the disposable gate was running');
  }
}

export function assertStableSnapshotFileIdentity(before, after, relativePath) {
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.nlink !== 1
  ) {
    throw architectureGateError(
      `source snapshot requires a single-link regular file: ${relativePath}`,
    );
  }
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
    if (String(before[field]) !== String(after[field])) {
      throw architectureGateError(`source file changed while reading: ${relativePath}`);
    }
  }
}

function resolveInside(root, relativePath) {
  const safePath = validateSnapshotRelativePath(relativePath);
  const absolute = path.resolve(root, ...safePath.split('/'));
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw architectureGateError(`snapshot path escaped repository root: ${safePath}`);
  }
  return absolute;
}

export async function sourceEntries(root, paths, budgetState = undefined) {
  const sharedBudget = budgetState ?? {
    fileCount: 0,
    largestFileBytes: 0,
    totalBytes: 0,
  };
  const entries = [];
  for (const relativePath of paths) {
    const entry = await readStableSnapshotEntry(root, relativePath, { budgetState: sharedBudget });
    if (entry !== null) {
      entries.push(entry);
      sharedBudget.fileCount += 1;
      sharedBudget.totalBytes += entry.bytes.length;
      sharedBudget.largestFileBytes = Math.max(sharedBudget.largestFileBytes, entry.bytes.length);
    }
  }
  return entries;
}

function isOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

async function assertUnlinkedAncestors(root, relativePath) {
  const segments = validateSnapshotRelativePath(relativePath).split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const identity = await lstat(current);
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      throw architectureGateError(
        `source snapshot ancestor is linked or non-directory: ${relativePath}`,
      );
    }
  }
}

async function assertRealPathContained(root, absolute, relativePath) {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(absolute)]);
  if (isOutsideRoot(realRoot, realFile)) {
    throw architectureGateError(
      `source snapshot resolved outside repository root: ${relativePath}`,
    );
  }
  return realFile;
}

async function readExpectedFileBytes(handle, expectedBytes, relativePath) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw architectureGateError(`source file has an invalid size: ${relativePath}`);
  }
  const bytes = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const overflowProbe = Buffer.allocUnsafe(1);
  const overflow = await handle.read(overflowProbe, 0, 1, offset);
  if (offset !== expectedBytes || overflow.bytesRead !== 0) {
    throw architectureGateError(`source file size changed while reading: ${relativePath}`);
  }
  return bytes;
}

export async function readStableSnapshotEntry(root, relativePath, options = {}) {
  const absolute = resolveInside(root, relativePath);
  let before;
  try {
    await assertUnlinkedAncestors(root, relativePath);
    before = await lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw architectureGateError(`cannot inspect source file ${relativePath}: ${error.message}`, {
      cause: error,
    });
  }
  assertStableSnapshotFileIdentity(before, before, relativePath);
  const budgetState = options.budgetState ?? {
    fileCount: 0,
    largestFileBytes: 0,
    totalBytes: 0,
  };
  assertSnapshotBudget(
    {
      fileCount: budgetState.fileCount + 1,
      largestFileBytes: Math.max(budgetState.largestFileBytes, before.size),
      totalBytes: budgetState.totalBytes + before.size,
    },
    options.limits ?? SNAPSHOT_BUDGET,
  );
  const realPathBefore = await assertRealPathContained(root, absolute, relativePath);
  let handle;
  let operationError;
  let result;
  try {
    handle = await open(absolute, 'r');
    const opened = await handle.stat();
    assertStableSnapshotFileIdentity(before, opened, relativePath);
    const bytes = await readExpectedFileBytes(handle, before.size, relativePath);
    const after = await handle.stat();
    assertStableSnapshotFileIdentity(opened, after, relativePath);
    await assertUnlinkedAncestors(root, relativePath);
    const realPathAfter = await assertRealPathContained(root, absolute, relativePath);
    if (realPathAfter !== realPathBefore) {
      throw architectureGateError(`source file real path changed while reading: ${relativePath}`);
    }
    result = { path: relativePath, bytes };
  } catch (error) {
    operationError =
      error instanceof Error && error.message.startsWith('architecture gate:')
        ? error
        : architectureGateError(
            `cannot read stable source file ${relativePath}: ${error.message}`,
            {
              cause: error,
            },
          );
  }
  let closeError;
  try {
    await handle?.close();
  } catch (error) {
    closeError = architectureGateError(
      `cannot close stable source file ${relativePath}: ${error.message}`,
      { cause: error },
    );
  }
  const combinedError = combineGateErrors([operationError, closeError]);
  if (combinedError !== undefined) throw combinedError;
  return result;
}

function createEmptyManifest() {
  return Object.freeze({
    digest: sha256Bytes(Buffer.alloc(0)),
    fileCount: 0,
    paths: Object.freeze([]),
    totalBytes: 0,
  });
}

export async function collectSnapshotManifests(root) {
  const paths = parseGitPathList(
    await gitBytes(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    { excludeControlPlane: false },
  );
  const productPaths = paths.filter((relativePath) => !isControlPlanePath(relativePath));
  const controlPlanePaths = paths.filter(isControlPlanePath);
  const sharedBudget = { fileCount: 0, largestFileBytes: 0, totalBytes: 0 };
  const productEntries = await sourceEntries(root, productPaths, sharedBudget);
  const controlPlaneEntries = await sourceEntries(root, controlPlanePaths, sharedBudget);
  return Object.freeze({
    productEntries,
    productManifest: createSourceManifest(productEntries),
    controlPlaneManifest:
      controlPlaneEntries.length === 0
        ? createEmptyManifest()
        : createSourceManifest(controlPlaneEntries),
  });
}

export async function copyEntries(destinationRoot, entries) {
  for (const entry of entries) {
    const destination = resolveInside(destinationRoot, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes, { flag: 'wx' });
  }
}

export function assertDisposableDirectory(directory, temporaryRoot) {
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolved = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== '.' ||
    !path.basename(resolved).startsWith(SNAPSHOT_PREFIX)
  ) {
    throw architectureGateError(`refusing to clean an unverified temporary directory: ${resolved}`);
  }
}

export function attestationFor(snapshots) {
  const manifestEntry = snapshots.productEntries.find(
    ({ path: relativePath }) => relativePath === 'tests/architecture-gate/manifest.json',
  );
  if (manifestEntry === undefined) {
    throw architectureGateError('snapshot is missing the architecture gate manifest');
  }
  let manifest;
  try {
    manifest = validateArchitectureGateManifest(JSON.parse(manifestEntry.bytes.toString('utf8')));
  } catch (error) {
    throw architectureGateError(
      `snapshot architecture gate manifest is invalid: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  return Object.freeze({
    sourceManifest: manifestSummary(snapshots.productManifest),
    controlPlaneManifest: manifestSummary(snapshots.controlPlaneManifest),
    gateManifest: canonicalSha256(manifest),
  });
}
