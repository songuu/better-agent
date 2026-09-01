import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  architectureGateError,
  combineGateErrors,
  createGateEnvironment,
  runRequired,
} from './architecture-gate-runtime.mjs';

const POSTGRES_REGISTRY_PREFIX = 'better-agent-g0-08-pg-';
const POSTGRES_PROJECT_PATTERN =
  /^better-agent-(?:g0-db|g0-auth-rls|g005-release-deployment|g006-run-billing|g006-run-conversation-browser|runtime-security)-[1-9]\d*-[a-f0-9]{8}$/u;

function assertPostgresRegistryPath(registryPath) {
  const resolved = path.resolve(registryPath);
  const temporaryRoot = path.resolve(tmpdir());
  const relative = path.relative(temporaryRoot, resolved);
  if (
    relative.length === 0 ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !path.basename(resolved).startsWith(POSTGRES_REGISTRY_PREFIX) ||
    path.extname(resolved) !== '.txt'
  ) {
    throw architectureGateError('PostgreSQL project registry path is outside its boundary');
  }
  return resolved;
}

export async function createPostgresProjectRegistry() {
  const registryPath = assertPostgresRegistryPath(
    path.join(tmpdir(), `${POSTGRES_REGISTRY_PREFIX}${process.pid}-${randomUUID()}.txt`),
  );
  await writeFile(registryPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return registryPath;
}

export async function postgresProjectRegistryForGate(options = {}) {
  if (options.acceptInherited !== true) return createPostgresProjectRegistry();
  const inheritedRegistry = Reflect.get(process.env, 'BA_POSTGRES_PROJECT_REGISTRY');
  if (typeof inheritedRegistry !== 'string' || inheritedRegistry.length === 0) {
    return createPostgresProjectRegistry();
  }
  const registryPath = assertPostgresRegistryPath(inheritedRegistry);
  const registryStat = await lstat(registryPath);
  if (!registryStat.isFile() || registryStat.size > 4096) {
    throw architectureGateError('inherited PostgreSQL project registry is invalid');
  }
  return registryPath;
}

export async function cleanupPostgresProjects(root, registryPath, options = {}) {
  const resolvedRegistry = assertPostgresRegistryPath(registryPath);
  const failures = [];
  const projects = [];
  try {
    const registryStat = await lstat(resolvedRegistry);
    if (!registryStat.isFile() || registryStat.size > 4096) {
      throw architectureGateError('PostgreSQL project registry is not a bounded regular file');
    }
    const registeredProjects = (await readFile(resolvedRegistry, 'utf8'))
      .split(/\r?\n/u)
      .filter((value) => value.length > 0);
    if (registeredProjects.length > 12) {
      failures.push(architectureGateError('PostgreSQL project registry is over capacity'));
    }
    const boundedProjects = registeredProjects.slice(0, 12);
    if (new Set(boundedProjects).size !== boundedProjects.length) {
      failures.push(architectureGateError('PostgreSQL project registry contains duplicates'));
    }
    for (const projectName of new Set(boundedProjects)) {
      if (!POSTGRES_PROJECT_PATTERN.test(projectName)) {
        failures.push(
          architectureGateError('PostgreSQL project registry contains an invalid identity'),
        );
      } else {
        projects.push(projectName);
      }
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    failures.push(error);
  }
  await Promise.all(
    projects.map(async (projectName) => {
      try {
        if (options.runCompose !== undefined) {
          await options.runCompose(projectName);
          return;
        }
        await runRequired(
          'docker',
          [
            'compose',
            '--file',
            path.join(root, 'infra', 'test', 'postgres', 'compose.yaml'),
            '--project-name',
            projectName,
            'down',
            '--remove-orphans',
            '--volumes',
          ],
          {
            cwd: root,
            context: `PostgreSQL outer cleanup for ${projectName}`,
            env: createGateEnvironment(),
            timeoutMs: 60_000,
          },
        );
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  if (failures.length === 0) {
    try {
      await rm(resolvedRegistry, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  const combinedError = combineGateErrors(failures);
  if (combinedError !== undefined) throw combinedError;
}
