import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const immutableReleaseName = /^better-agent-[0-9a-f]{40}$/u;

function deploymentError(message, cause) {
  return new Error(`current release validation failed: ${message}`, cause ? { cause } : undefined);
}

async function requirePathType(fileSystem, target, predicate, message) {
  let metadata;
  try {
    metadata = await fileSystem.stat(target);
  } catch (error) {
    throw deploymentError(message, error);
  }
  if (!predicate(metadata)) throw deploymentError(message);
}

export async function resolveCurrentRelease({ currentLink, releaseRoot, fileSystem = fs }) {
  if (!path.posix.isAbsolute(currentLink) || !path.posix.isAbsolute(releaseRoot)) {
    throw deploymentError('current link and release root must be absolute paths');
  }

  let linkMetadata;
  try {
    linkMetadata = await fileSystem.lstat(currentLink);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return '';
    throw deploymentError(`cannot inspect ${currentLink}`, error);
  }
  if (!linkMetadata.isSymbolicLink()) {
    throw deploymentError(`${currentLink} must be a symbolic link when it exists`);
  }

  let resolvedRelease;
  try {
    resolvedRelease = await fileSystem.realpath(currentLink);
  } catch (error) {
    throw deploymentError(`${currentLink} does not resolve to an existing release`, error);
  }
  const canonicalReleaseRoot = await fileSystem.realpath(releaseRoot);
  if (path.posix.dirname(resolvedRelease) !== canonicalReleaseRoot) {
    throw deploymentError(`${currentLink} resolves outside the immutable release root`);
  }
  if (!immutableReleaseName.test(path.posix.basename(resolvedRelease))) {
    throw deploymentError(`${currentLink} must name an immutable release`);
  }

  await requirePathType(
    fileSystem,
    resolvedRelease,
    (metadata) => metadata.isDirectory(),
    `${resolvedRelease} is not an existing release directory`,
  );
  const expectedCli = path.posix.join(resolvedRelease, 'packages/db/dist/cli.js');
  let canonicalCli;
  try {
    canonicalCli = await fileSystem.realpath(expectedCli);
  } catch (error) {
    throw deploymentError(`${resolvedRelease} does not contain the deployment CLI`, error);
  }
  if (canonicalCli !== expectedCli) {
    throw deploymentError('deployment CLI must resolve inside its immutable release');
  }
  let cliMetadata;
  try {
    cliMetadata = await fileSystem.lstat(expectedCli);
  } catch (error) {
    throw deploymentError(`${resolvedRelease} does not contain the deployment CLI`, error);
  }
  if (!cliMetadata.isFile() || cliMetadata.nlink !== 1) {
    throw deploymentError('deployment CLI must be a single-link regular file');
  }
  return resolvedRelease;
}

async function main() {
  const releaseRoot = process.argv[2];
  const currentLink = process.argv[3];
  if (!releaseRoot || !currentLink || process.argv.length !== 4) {
    throw deploymentError('usage: node resolve-current-release.mjs <release-root> <current-link>');
  }
  const resolvedRelease = await resolveCurrentRelease({ currentLink, releaseRoot });
  process.stdout.write(resolvedRelease);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
