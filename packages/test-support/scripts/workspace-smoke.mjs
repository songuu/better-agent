import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateCiWorkflow,
  validateDeploymentWorkflow,
  validateGitAttributes,
  validateWorkspaceGraph,
} from './workspace-rules.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const errors = [];

function report(message) {
  errors.push(message);
}

async function exists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readText(relativePath) {
  try {
    return await readFile(path.join(repoRoot, relativePath), 'utf8');
  } catch (error) {
    report(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function readJson(relativePath) {
  const text = await readText(relativePath);
  if (text === undefined) return undefined;

  try {
    return JSON.parse(text);
  } catch (error) {
    report(
      `${relativePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function requireObjectProperty(object, propertyPath, context) {
  let value = object;
  for (const segment of propertyPath) {
    if (value === null || typeof value !== 'object' || !(segment in value)) {
      report(`${context}: missing ${propertyPath.join('.')}`);
      return undefined;
    }
    value = value[segment];
  }
  return value;
}

async function collectWorkspacePackages() {
  const packages = [];

  for (const workspaceDirectory of ['apps', 'packages']) {
    const absoluteDirectory = path.join(repoRoot, workspaceDirectory);
    if (!(await exists(workspaceDirectory))) continue;

    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.posix.join(workspaceDirectory, entry.name, 'package.json');
      if (!(await exists(manifestPath))) continue;

      const manifest = await readJson(manifestPath);
      if (manifest !== undefined) {
        packages.push({ directory: path.posix.join(workspaceDirectory, entry.name), manifest });
      }
    }
  }

  return packages;
}

const requiredFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'biome.json',
  '.github/workflows/ci.yml',
  'scripts/architecture-gate-core.mjs',
  'scripts/architecture-gate.mjs',
  'tests/architecture-gate/architecture-gate.test.mjs',
  'tests/architecture-gate/manifest.json',
  'packages/test-support/package.json',
  'packages/test-support/tsconfig.json',
  'packages/test-support/tsconfig.build.json',
  'packages/api-contract/package.json',
  'packages/api-contract/baseline/credential-operation-policy.json',
  'packages/api-contract/baseline/response-compatibility.json',
  'packages/api-contract/generated/credential-operation-policy-registry.d.ts',
  'packages/api-contract/generated/credential-operation-policy-registry.js',
  'packages/api-contract/generated/openapi.bundle.json',
  'packages/api-contract/generated/openapi.d.ts',
  'packages/domain-contracts/package.json',
  'packages/database-capability/package.json',
  'packages/database-capability/tsconfig.build.json',
  'packages/instruction-skill/package.json',
  'packages/instruction-skill/tsconfig.build.json',
  'packages/knowledge-core/package.json',
  'packages/knowledge-core/tsconfig.build.json',
  'packages/run-core/package.json',
  'packages/run-core/tsconfig.build.json',
  'packages/billing-core/package.json',
  'packages/billing-core/tsconfig.build.json',
  'packages/auth/package.json',
  'packages/db/package.json',
  'packages/db/migrations/000_platform_prerequisites.up.sql',
  'packages/db/migrations/001_tenant_identity.up.sql',
  'packages/db/migrations/002_auth_context_rls.up.sql',
  'apps/api/package.json',
  'infra/test/postgres/compose.yaml',
];

for (const relativePath of requiredFiles) {
  if (!(await exists(relativePath))) report(`missing required file: ${relativePath}`);
}

const rootManifest = await readJson('package.json');
if (rootManifest !== undefined) {
  if (rootManifest.private !== true) report('package.json: root package must be private');
  if (
    typeof rootManifest.packageManager !== 'string' ||
    !rootManifest.packageManager.startsWith('pnpm@')
  ) {
    report('package.json: packageManager must pin pnpm');
  }
  if (typeof rootManifest.engines?.node !== 'string' || !rootManifest.engines.node.includes('22')) {
    report('package.json: engines.node must include the Node 22 baseline');
  }
  for (const script of [
    'architecture:gate',
    'build',
    'check',
    'contract:check',
    'db:test:postgres16',
    'format:check',
    'lint',
    'test',
    'typecheck',
    'workspace:smoke',
  ]) {
    requireObjectProperty(rootManifest, ['scripts', script], 'package.json');
  }
}

const workspaceDefinition = await readText('pnpm-workspace.yaml');
if (workspaceDefinition !== undefined) {
  for (const pattern of ["'apps/*'", "'packages/*'"]) {
    if (!workspaceDefinition.includes(pattern)) {
      report(`pnpm-workspace.yaml: missing workspace pattern ${pattern}`);
    }
  }
}

const turboConfig = await readJson('turbo.json');
if (turboConfig !== undefined) {
  for (const task of ['build', 'lint', 'test', 'typecheck']) {
    requireObjectProperty(turboConfig, ['tasks', task], 'turbo.json');
  }
}

const rootTypeScriptConfig = await readJson('tsconfig.json');
if (rootTypeScriptConfig !== undefined) {
  const references = rootTypeScriptConfig.references;
  for (const requiredReference of [
    './packages/auth/tsconfig.build.json',
    './packages/db/tsconfig.build.json',
    './packages/database-capability/tsconfig.build.json',
    './packages/instruction-skill/tsconfig.build.json',
    './packages/knowledge-core/tsconfig.build.json',
    './packages/domain-contracts/tsconfig.build.json',
    './packages/run-core/tsconfig.build.json',
    './packages/billing-core/tsconfig.build.json',
    './packages/test-support/tsconfig.build.json',
    './apps/api/tsconfig.build.json',
  ]) {
    if (
      !Array.isArray(references) ||
      !references.some((reference) => reference?.path === requiredReference)
    ) {
      report(`tsconfig.json: missing project reference to ${requiredReference}`);
    }
  }
}

const testSupportManifest = await readJson('packages/test-support/package.json');
if (testSupportManifest !== undefined) {
  if (testSupportManifest.name !== '@better-agent/test-support') {
    report('packages/test-support/package.json: unexpected package name');
  }
  if (testSupportManifest.private !== true) {
    report('packages/test-support/package.json: package must remain private');
  }
  for (const script of ['build', 'lint', 'test', 'typecheck']) {
    requireObjectProperty(
      testSupportManifest,
      ['scripts', script],
      'packages/test-support/package.json',
    );
  }
}

const ciWorkflow = await readText('.github/workflows/ci.yml');
if (ciWorkflow !== undefined) {
  errors.push(...validateCiWorkflow(ciWorkflow));
}

const deploymentWorkflow = await readText('.github/workflows/deploy-foundation.yml');
if (deploymentWorkflow !== undefined) {
  errors.push(...validateDeploymentWorkflow(deploymentWorkflow));
}

const gitAttributes = await readText('.gitattributes');
if (gitAttributes !== undefined) {
  errors.push(...validateGitAttributes(gitAttributes));
}

const workspacePackages = await collectWorkspacePackages();
errors.push(...validateWorkspaceGraph(workspacePackages));

if (errors.length > 0) {
  console.error(`workspace smoke failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`workspace smoke passed for ${workspacePackages.length} package(s)`);
}
