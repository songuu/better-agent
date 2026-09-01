import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCurrentRelease } from '../../scripts/deployment/resolve-current-release.mjs';

const releaseRoot = '/opt/better-agent/releases';
const currentLink = '/opt/better-agent/current';
const validRelease = `${releaseRoot}/better-agent-${'a'.repeat(40)}`;

function fakeFileSystem({
  currentKind = 'symlink',
  currentTarget = validRelease,
  currentExists = true,
  cliExists = true,
  cliKind = 'file',
  cliLinks = 1,
  cliTarget = `${validRelease}/packages/db/dist/cli.js`,
} = {}) {
  const expectedCli = `${validRelease}/packages/db/dist/cli.js`;
  return {
    async lstat(target) {
      if (target === currentLink && !currentExists) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      if (target === currentLink) return { isSymbolicLink: () => currentKind === 'symlink' };
      assert.equal(target, expectedCli);
      if (!cliExists) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return { isFile: () => cliKind === 'file', nlink: cliLinks };
    },
    async realpath(target) {
      if (target === releaseRoot) return releaseRoot;
      if (target === currentLink && currentTarget === null) {
        const error = new Error('dangling');
        error.code = 'ENOENT';
        throw error;
      }
      if (target === currentLink) return currentTarget;
      assert.equal(target, expectedCli);
      if (!cliExists) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return cliTarget;
    },
    async stat(target) {
      if (target === validRelease) return { isDirectory: () => true, isFile: () => false };
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  };
}

test('accepts a missing current link only as the first deployment state', async () => {
  assert.equal(
    await resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ currentExists: false }),
    }),
    '',
  );
});

test('resolves a valid immutable current release with its executable artifact', async () => {
  assert.equal(
    await resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem(),
    }),
    validRelease,
  );
});

test('rejects a regular current path instead of overwriting it', async () => {
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ currentKind: 'file' }),
    }),
    /must be a symbolic link/u,
  );
});

test('rejects dangling and release-root-external current links', async () => {
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ currentTarget: null }),
    }),
    /does not resolve to an existing release/u,
  );
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ currentTarget: `/tmp/better-agent-${'b'.repeat(40)}` }),
    }),
    /outside the immutable release root/u,
  );
});

test('rejects malformed and non-executable release targets', async () => {
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ currentTarget: `${releaseRoot}/better-agent-latest` }),
    }),
    /must name an immutable release/u,
  );
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ cliExists: false }),
    }),
    /does not contain the deployment CLI/u,
  );
});

test('rejects a deployment CLI reached through a file or ancestor symbolic link', async () => {
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ cliTarget: '/tmp/cli.js' }),
    }),
    /deployment CLI must resolve inside its immutable release/u,
  );
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ cliTarget: `${validRelease}/linked-dist/cli.js` }),
    }),
    /deployment CLI must resolve inside its immutable release/u,
  );
});

test('rejects a non-regular or multiply-linked deployment CLI', async () => {
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ cliKind: 'symlink' }),
    }),
    /deployment CLI must be a single-link regular file/u,
  );
  await assert.rejects(
    resolveCurrentRelease({
      currentLink,
      releaseRoot,
      fileSystem: fakeFileSystem({ cliLinks: 2 }),
    }),
    /deployment CLI must be a single-link regular file/u,
  );
});
