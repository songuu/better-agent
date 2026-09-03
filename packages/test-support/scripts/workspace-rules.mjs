import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { parseDocument, visit } from 'yaml';

const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const productionDependencySections = new Set([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]);

const githubWorkflowExpression = '$' + '{{ github.workflow }}';
const githubRefExpression = '$' + '{{ github.ref }}';
const matrixOsExpression = '$' + '{{ matrix.os }}';

const requiredLfGitAttributes = [
  '*.cjs',
  '*.conf',
  '*.css',
  '*.cts',
  '*.html',
  '*.js',
  '*.jsx',
  '*.json',
  '*.mjs',
  '*.mts',
  '*.md',
  '*.sql',
  '*.service',
  '*.sh',
  '*.ts',
  '*.tsx',
  '*.yaml',
  '*.yml',
];

const expectedGitAttributes = [
  '* text=auto',
  '.gitattributes text eol=lf',
  '',
  ...requiredLfGitAttributes.map((pattern) => `${pattern} text eol=lf`),
  '',
  '*.bat text eol=crlf',
  '*.cmd text eol=crlf',
  '*.ps1 text eol=crlf',
  '',
].join('\n');

const expectedCiWorkflow = {
  name: 'CI',
  on: { push: null, pull_request: null },
  permissions: { contents: 'read' },
  concurrency: {
    group: `ci-${githubWorkflowExpression}-${githubRefExpression}`,
    'cancel-in-progress': true,
  },
  jobs: {
    quality: {
      name: `Quality (${matrixOsExpression})`,
      'runs-on': matrixOsExpression,
      strategy: {
        'fail-fast': false,
        matrix: { os: ['ubuntu-latest', 'windows-latest'] },
      },
      steps: [
        {
          name: 'Checkout',
          uses: 'actions/checkout@v6',
          with: { 'persist-credentials': false },
        },
        { name: 'Set up pnpm', uses: 'pnpm/action-setup@v6', with: { run_install: false } },
        {
          name: 'Set up Node.js',
          uses: 'actions/setup-node@v7',
          with: { 'node-version': 22, cache: 'pnpm' },
        },
        { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
        { name: 'Check formatting', run: 'pnpm format:check' },
        { name: 'Lint', run: 'pnpm lint' },
        { name: 'Check workspace boundaries', run: 'pnpm workspace:smoke' },
        { name: 'Check OpenAPI and domain contracts', run: 'pnpm contract:check' },
        { name: 'Typecheck', run: 'pnpm typecheck' },
        { name: 'Test', run: 'pnpm test' },
        { name: 'Build', run: 'pnpm build' },
        { name: 'Test the architecture gate control plane', run: 'pnpm architecture:gate:test' },
        { name: 'Verify tracked files are unchanged', run: 'git diff --exit-code -- .' },
      ],
    },
    'architecture-gate': {
      name: 'G0-08 executable architecture gate',
      needs: 'quality',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 30,
      steps: [
        {
          name: 'Checkout',
          uses: 'actions/checkout@v6',
          with: { 'persist-credentials': false },
        },
        { name: 'Set up pnpm', uses: 'pnpm/action-setup@v6', with: { run_install: false } },
        {
          name: 'Set up Node.js',
          uses: 'actions/setup-node@v7',
          with: { 'node-version': 22, cache: 'pnpm' },
        },
        { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
        { name: 'Run the clean-checkout architecture gate', run: 'pnpm architecture:gate' },
      ],
    },
  },
};

function normalizeDirectory(directory) {
  return directory.replaceAll('\\', '/');
}

function findProductionCycles(graph) {
  const errors = [];
  const states = new Map();
  const stack = [];

  function visit(packageName) {
    const state = states.get(packageName);
    if (state === 'visited') return;
    if (state === 'visiting') {
      const cycleStart = stack.indexOf(packageName);
      const cycle = [...stack.slice(cycleStart), packageName];
      errors.push(`workspace production dependency cycle: ${cycle.join(' -> ')}`);
      return;
    }

    states.set(packageName, 'visiting');
    stack.push(packageName);
    const dependencies = [...(graph.get(packageName) ?? [])].sort();
    for (const dependency of dependencies) visit(dependency);
    stack.pop();
    states.set(packageName, 'visited');
  }

  for (const packageName of [...graph.keys()].sort()) visit(packageName);
  return errors;
}

export function validateCiWorkflow(workflow) {
  if (typeof workflow !== 'string' || workflow.length === 0) {
    return ['.github/workflows/ci.yml: workflow text is required'];
  }
  const errors = [];
  const workflowDefinition = parseCiWorkflow(workflow, errors);
  if (workflowDefinition === null) return errors;
  if (!isDeepStrictEqual(workflowDefinition, expectedCiWorkflow)) {
    errors.push('.github/workflows/ci.yml: workflow must match the closed G0-08 CI schema');
  }
  if (!hasExactReadOnlyPermissions(workflowDefinition)) {
    errors.push('.github/workflows/ci.yml: workflow permissions must be exactly contents: read');
  }
  if (recordDefinesAny(workflowDefinition, ['defaults', 'env'])) {
    errors.push('.github/workflows/ci.yml: workflow must not override the gate execution context');
  }
  for (const requiredText of ['ubuntu-latest', 'windows-latest']) {
    if (!workflow.includes(requiredText)) {
      errors.push(`.github/workflows/ci.yml: missing ${requiredText}`);
    }
  }
  for (const requiredCommand of [
    'pnpm install --frozen-lockfile',
    'pnpm contract:check',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'pnpm build',
    'pnpm architecture:gate:test',
    'pnpm architecture:gate',
  ]) {
    if (!hasCiRunCommand(workflow, requiredCommand)) {
      errors.push(`.github/workflows/ci.yml: missing executable run command ${requiredCommand}`);
    }
  }
  if (hasCiRunCommand(workflow, 'pnpm db:test:postgres16')) {
    errors.push('.github/workflows/ci.yml: PostgreSQL must run through pnpm architecture:gate');
  }
  const qualityJob = extractJobBlock(workflow, 'quality');
  if (qualityJob === null) {
    errors.push('.github/workflows/ci.yml: quality job is required');
  } else {
    const qualityJobDefinition = getJobDefinition(workflowDefinition, 'quality');
    if (!/^ {4}runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}\s*$/imu.test(qualityJob)) {
      errors.push('.github/workflows/ci.yml: quality job must run on matrix.os');
    }
    if (
      !/^ {6}matrix:\s*\r?\n {8}os:\s*\r?\n {10}-\s+ubuntu-latest\s*\r?\n {10}-\s+windows-latest\s*$/imu.test(
        qualityJob,
      ) ||
      !hasExactQualityStrategy(qualityJobDefinition)
    ) {
      errors.push(
        '.github/workflows/ci.yml: quality matrix must contain Ubuntu then Windows runners',
      );
    }
    for (const requiredCommand of [
      'pnpm install --frozen-lockfile',
      'pnpm contract:check',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm architecture:gate:test',
    ]) {
      if (
        !hasCiRunCommand(qualityJob, requiredCommand) ||
        !hasExactlyOneClosedRunStep(qualityJobDefinition, requiredCommand)
      ) {
        errors.push(`.github/workflows/ci.yml: quality job must execute ${requiredCommand}`);
      }
    }
    if (jobOrStepDefines(qualityJobDefinition, 'continue-on-error')) {
      errors.push('.github/workflows/ci.yml: quality job must fail closed');
    }
    if (jobOrStepDefines(qualityJobDefinition, 'if')) {
      errors.push('.github/workflows/ci.yml: quality job must not define conditions');
    }
    if (
      jobOrStepDefinesAny(qualityJobDefinition, [
        'container',
        'defaults',
        'env',
        'permissions',
        'shell',
        'working-directory',
      ])
    ) {
      errors.push('.github/workflows/ci.yml: quality job must not override the execution context');
    }
    if (!hasExactlyOneIsolatedCheckout(qualityJob, qualityJobDefinition)) {
      errors.push(
        '.github/workflows/ci.yml: quality checkout must have exactly one checkout step with persist-credentials: false',
      );
    }
    if (!hasExactlyOnePinnedNodeSetup(qualityJob, qualityJobDefinition)) {
      errors.push(
        '.github/workflows/ci.yml: quality must have exactly one setup-node@v7 using Node 22',
      );
    }
  }
  const architectureJob = extractJobBlock(workflow, 'architecture-gate');
  if (architectureJob === null) {
    errors.push('.github/workflows/ci.yml: architecture-gate job is required');
    return errors;
  }
  const architectureJobDefinition = getJobDefinition(workflowDefinition, 'architecture-gate');
  if (jobOrStepDefines(architectureJobDefinition, 'if')) {
    errors.push('.github/workflows/ci.yml: architecture-gate job must not define conditions');
  }
  if (jobOrStepDefines(architectureJobDefinition, 'continue-on-error')) {
    errors.push('.github/workflows/ci.yml: architecture-gate job must fail closed');
  }
  if (
    jobOrStepDefinesAny(architectureJobDefinition, [
      'defaults',
      'env',
      'container',
      'permissions',
      'shell',
      'working-directory',
    ])
  ) {
    errors.push(
      '.github/workflows/ci.yml: architecture-gate must not override the execution context',
    );
  }
  if (!hasExactlyOneIsolatedCheckout(architectureJob, architectureJobDefinition)) {
    errors.push(
      '.github/workflows/ci.yml: architecture-gate checkout must have exactly one checkout step with persist-credentials: false',
    );
  }
  if (!hasExactlyOnePinnedNodeSetup(architectureJob, architectureJobDefinition)) {
    errors.push(
      '.github/workflows/ci.yml: architecture-gate must have exactly one setup-node@v7 using Node 22',
    );
  }
  for (const [pattern, message] of [
    [/^ {4}needs:\s*quality\s*$/imu, 'architecture-gate job must need quality'],
    [/^ {4}runs-on:\s*ubuntu-latest\s*$/imu, 'architecture-gate job must run on Ubuntu'],
    [/^ {4}timeout-minutes:\s*30\s*$/imu, 'architecture-gate job must use 30 minute timeout'],
  ]) {
    if (!pattern.test(architectureJob)) errors.push(`.github/workflows/ci.yml: ${message}`);
  }
  for (const requiredCommand of ['pnpm install --frozen-lockfile', 'pnpm architecture:gate']) {
    if (
      !hasCiRunCommand(architectureJob, requiredCommand) ||
      !hasExactlyOneClosedRunStep(architectureJobDefinition, requiredCommand)
    ) {
      errors.push(
        `.github/workflows/ci.yml: architecture-gate job must execute ${requiredCommand}`,
      );
    }
  }
  return errors;
}

export function validateGitAttributes(attributes) {
  if (typeof attributes !== 'string' || attributes.length === 0) {
    return ['.gitattributes: attributes text is required'];
  }

  const normalized = `${attributes.replaceAll('\r\n', '\n').trimEnd()}\n`;
  return normalized === expectedGitAttributes
    ? []
    : ['.gitattributes: attributes must match the closed cross-platform checkout schema'];
}

export function validateDeploymentWorkflow(workflow) {
  if (typeof workflow !== 'string' || workflow.length === 0) {
    return ['.github/workflows/deploy-foundation.yml: workflow text is required'];
  }
  const errors = [];
  const workflowDigest = createHash('sha256')
    .update(workflow.replaceAll('\r\n', '\n'))
    .digest('hex');
  if (workflowDigest !== '81a7e5658e7af0c642a14cfedd1a8899407dc54fca0c2b5daf8690bd2fd6bbec') {
    errors.push('.github/workflows/deploy-foundation.yml: workflow must match the frozen schema');
  }
  const definition = parseCiWorkflow(workflow, errors);
  if (definition === null) return errors;
  const trigger = definition.on;
  if (
    !isRecord(trigger) ||
    Object.keys(trigger).length !== 1 ||
    !isRecord(trigger.workflow_run) ||
    !isDeepStrictEqual(trigger.workflow_run.workflows, ['CI']) ||
    !isDeepStrictEqual(trigger.workflow_run.types, ['completed'])
  ) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: deploy must trigger only from completed CI',
    );
  }
  if (!hasExactReadOnlyPermissions(definition)) {
    errors.push('.github/workflows/deploy-foundation.yml: workflow permissions must be read-only');
  }
  const build = getJobDefinition(definition, 'build');
  const deploy = getJobDefinition(definition, 'deploy');
  if (build === null || deploy === null || Object.keys(definition.jobs ?? {}).length !== 2) {
    errors.push('.github/workflows/deploy-foundation.yml: build and deploy jobs are required');
    return errors;
  }
  const expectedBuildCondition =
    "vars.BETTER_AGENT_DEPLOY_ENABLED == 'true' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main'";
  const expectedDeployCondition =
    "vars.BETTER_AGENT_DEPLOY_ENABLED == 'true' && needs.build.result == 'success'";
  if (build.if !== expectedBuildCondition || deploy.if !== expectedDeployCondition) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: production deployment must require the explicit enable variable',
    );
  }
  if (JSON.stringify(build).includes('secrets.')) {
    errors.push('.github/workflows/deploy-foundation.yml: build job must not receive secrets');
  }
  if (JSON.stringify(deploy.env ?? {}).includes('secrets.')) {
    errors.push('.github/workflows/deploy-foundation.yml: deploy job env must not receive secrets');
  }
  if (deploy.needs !== 'build' || deploy.environment !== 'production') {
    errors.push(
      '.github/workflows/deploy-foundation.yml: deploy must use protected production after build',
    );
  }
  const deploySteps = Array.isArray(deploy.steps) ? deploy.steps : [];
  const configureSsh = deploySteps.find((step) => isRecord(step) && step.name === 'Configure SSH');
  const secretSteps = deploySteps.filter(
    (step) => isRecord(step) && JSON.stringify(step).includes('secrets.'),
  );
  if (
    !isRecord(configureSsh) ||
    secretSteps.length !== 1 ||
    secretSteps[0] !== configureSsh ||
    !isRecord(configureSsh.env) ||
    Object.keys(configureSsh.env).sort().join(',') !== 'SSH_KNOWN_HOSTS,SSH_PRIVATE_KEY'
  ) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: SSH secrets must be scoped to Configure SSH',
    );
  }
  const buildSteps = Array.isArray(build.steps) ? build.steps : [];
  const allSteps = [...buildSteps, ...deploySteps];
  for (const step of allSteps) {
    if (isRecord(step) && typeof step.uses === 'string' && !/@[a-f0-9]{40}$/u.test(step.uses)) {
      errors.push(
        '.github/workflows/deploy-foundation.yml: all actions must pin a full commit SHA',
      );
    }
  }
  const expectedActions = new Map([
    ['Check out the accepted commit', 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'],
    ['Set up pnpm', 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86'],
    ['Set up Node.js', 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'],
    ['Upload attested release', 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'],
    [
      'Download attested release',
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    ],
  ]);
  const actionSteps = allSteps.filter((step) => isRecord(step) && typeof step.uses === 'string');
  if (
    actionSteps.length !== expectedActions.size ||
    actionSteps.some((step) => expectedActions.get(String(step.name)) !== step.uses)
  ) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: action inventory must match the frozen allowlist',
    );
  }
  for (const requiredText of [
    'pnpm architecture:gate',
    'pnpm --filter @better-agent/web build',
    'apps/web/dist/server.js',
    'apps/web/public/index.html',
    'deploy/systemd/better-agent-web.service',
    'deploy/nginx/better-agent.location.conf',
    'scripts/deployment/install-production-web.sh',
    'Verify public Better Agent web route',
    'https://songuu.top/better-agent/api/healthz',
    'BETTER_AGENT_POSTGRES_ROOT',
    'scripts/deployment/configure-production-postgres.mjs',
    'Remove deployment key',
    'Preflight target filesystems',
    "-regex '.*/better-agent-[0-9a-f]{40}'",
    'pending_receipt="${receipt}.next"',
    'scripts/deployment/resolve-current-release.mjs',
    'mv -Tf "${pending_receipt}" "${receipt}"',
  ]) {
    if (!workflow.includes(requiredText)) {
      errors.push(`.github/workflows/deploy-foundation.yml: missing ${requiredText}`);
    }
  }
  const currentResolver =
    'previous_release="$(node "${REMOTE_RELEASE}/scripts/deployment/resolve-current-release.mjs"';
  const databaseMigration =
    'node "${REMOTE_RELEASE}/scripts/deployment/configure-production-postgres.mjs" up';
  if (
    workflow.indexOf(currentResolver) < 0 ||
    workflow.indexOf(databaseMigration) < 0 ||
    workflow.indexOf(currentResolver) > workflow.indexOf(databaseMigration)
  ) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: current release must be validated before database migration',
    );
  }
  if (workflow.includes('workflow_dispatch') || workflow.includes('ssh-keyscan')) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: manual dispatch and SSH TOFU are forbidden',
    );
  }
  const mainLookup = 'git ls-remote https://github.com/${GITHUB_REPOSITORY}.git refs/heads/main';
  if (workflow.split(mainLookup).length - 1 !== 3) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: all three main SHA attestations are required',
    );
  }
  if (
    workflow.includes('continue-on-error') ||
    workflow.includes('StrictHostKeyChecking=no') ||
    workflow.includes('UserKnownHostsFile=/dev/null')
  ) {
    errors.push(
      '.github/workflows/deploy-foundation.yml: failure or SSH host-key bypass is forbidden',
    );
  }
  return errors;
}

function extractJobBlock(workflow, jobName) {
  const escapedName = jobName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const startPattern = new RegExp(`^  ${escapedName}:\\s*$`, 'mu');
  const match = startPattern.exec(workflow);
  if (match === null) return null;
  const remainder = workflow.slice(match.index + match[0].length);
  const nextJob = /^ {2}[A-Za-z0-9_-]+:\s*$/mu.exec(remainder);
  return workflow.slice(
    match.index,
    nextJob === null ? workflow.length : match.index + match[0].length + nextJob.index,
  );
}

function hasCiRunCommand(workflow, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(
    `^\\s*run:\\s*(?:${escaped}|"${escaped}"|'${escaped}')(?:\\s+#.*)?\\s*$`,
    'mu',
  ).test(workflow);
}

function parseCiWorkflow(workflow, errors) {
  const document = parseDocument(workflow, { uniqueKeys: true });
  if (document.errors.length > 0) {
    errors.push('.github/workflows/ci.yml: workflow must be valid YAML with unique keys');
    return null;
  }

  let hasAnchorOrAlias = false;
  visit(document, {
    Alias() {
      hasAnchorOrAlias = true;
    },
    Node(_key, node) {
      if (typeof node.anchor === 'string' && node.anchor.length > 0) hasAnchorOrAlias = true;
    },
  });
  if (hasAnchorOrAlias) {
    errors.push('.github/workflows/ci.yml: workflow must not use YAML anchors or aliases');
    return null;
  }

  const definition = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(definition)) {
    errors.push('.github/workflows/ci.yml: workflow root must be a mapping');
    return null;
  }
  return definition;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getJobDefinition(workflowDefinition, jobName) {
  const jobs = workflowDefinition.jobs;
  if (!isRecord(jobs)) return null;
  const job = jobs[jobName];
  return isRecord(job) ? job : null;
}

function jobOrStepDefines(jobDefinition, key) {
  if (!isRecord(jobDefinition)) return false;
  if (Object.hasOwn(jobDefinition, key)) return true;
  return (
    Array.isArray(jobDefinition.steps) &&
    jobDefinition.steps.some((step) => isRecord(step) && Object.hasOwn(step, key))
  );
}

function recordDefinesAny(record, keys) {
  return isRecord(record) && keys.some((key) => Object.hasOwn(record, key));
}

function hasExactReadOnlyPermissions(workflowDefinition) {
  const permissions = workflowDefinition.permissions;
  return (
    isRecord(permissions) &&
    Object.keys(permissions).length === 1 &&
    permissions.contents === 'read'
  );
}

function hasExactQualityStrategy(jobDefinition) {
  if (!isRecord(jobDefinition) || !isRecord(jobDefinition.strategy)) return false;
  const strategy = jobDefinition.strategy;
  if (
    Object.keys(strategy).length !== 2 ||
    strategy['fail-fast'] !== false ||
    !isRecord(strategy.matrix)
  ) {
    return false;
  }
  const matrix = strategy.matrix;
  return (
    Object.keys(matrix).length === 1 &&
    Array.isArray(matrix.os) &&
    matrix.os.length === 2 &&
    matrix.os[0] === 'ubuntu-latest' &&
    matrix.os[1] === 'windows-latest'
  );
}

function jobOrStepDefinesAny(jobDefinition, keys) {
  if (!isRecord(jobDefinition)) return false;
  if (recordDefinesAny(jobDefinition, keys)) return true;
  return (
    Array.isArray(jobDefinition.steps) &&
    jobDefinition.steps.some((step) => recordDefinesAny(step, keys))
  );
}

function hasExactlyOneClosedRunStep(jobDefinition, command) {
  if (!isRecord(jobDefinition) || !Array.isArray(jobDefinition.steps)) return false;
  const matchingSteps = jobDefinition.steps.filter(
    (step) => isRecord(step) && step.run === command,
  );
  if (matchingSteps.length !== 1) return false;
  const stepKeys = Object.keys(matchingSteps[0]);
  return (
    stepKeys.length === 2 &&
    stepKeys.includes('name') &&
    typeof matchingSteps[0].name === 'string' &&
    matchingSteps[0].name.length > 0 &&
    stepKeys.includes('run')
  );
}

function countActionReferences(jobDefinition, action) {
  if (!isRecord(jobDefinition) || !Array.isArray(jobDefinition.steps)) return 0;
  const actionPrefix = `${action.toLowerCase()}@`;
  return jobDefinition.steps.filter(
    (step) =>
      isRecord(step) &&
      typeof step.uses === 'string' &&
      step.uses.trim().toLowerCase().startsWith(actionPrefix),
  ).length;
}

function hasExactlyOneIsolatedCheckout(job, jobDefinition) {
  return (
    countActionReferences(jobDefinition, 'actions/checkout') === 1 &&
    /^(?: {6}- name:[^\r\n]+\r?\n {8}uses: actions\/checkout@v6| {6}- uses: actions\/checkout@v6)\s*\r?\n {8}with:\s*\r?\n {10}persist-credentials:\s*false\s*$/imu.test(
      job,
    )
  );
}

function hasExactlyOnePinnedNodeSetup(job, jobDefinition) {
  return (
    countActionReferences(jobDefinition, 'actions/setup-node') === 1 &&
    /^(?: {6}- name:[^\r\n]+\r?\n {8}uses: actions\/setup-node@v7| {6}- uses: actions\/setup-node@v7)\s*\r?\n {8}with:\s*\r?\n {10}node-version:\s*(?:22|['"]22['"])\s*$/imu.test(
      job,
    )
  );
}

export function validateWorkspaceGraph(workspacePackages) {
  const errors = [];
  const packagesByName = new Map();
  const productionGraph = new Map();

  for (const workspacePackage of workspacePackages) {
    workspacePackage.directory = normalizeDirectory(workspacePackage.directory);
    const name = workspacePackage.manifest.name;
    if (typeof name !== 'string' || name.length === 0) {
      errors.push(`${workspacePackage.directory}/package.json: package name is required`);
      continue;
    }
    if (packagesByName.has(name)) {
      errors.push(`duplicate workspace package name: ${name}`);
      continue;
    }
    packagesByName.set(name, workspacePackage);
    productionGraph.set(name, new Set());
  }

  for (const source of workspacePackages) {
    const sourceName = source.manifest.name;
    if (typeof sourceName !== 'string' || !packagesByName.has(sourceName)) continue;

    for (const section of dependencySections) {
      const dependencies = source.manifest[section];
      if (dependencies === undefined) continue;
      if (
        dependencies === null ||
        typeof dependencies !== 'object' ||
        Array.isArray(dependencies)
      ) {
        errors.push(`${source.directory}/package.json: ${section} must be an object`);
        continue;
      }

      for (const [dependencyName, version] of Object.entries(dependencies)) {
        if (!dependencyName.startsWith('@better-agent/')) continue;

        const target = packagesByName.get(dependencyName);
        if (target === undefined) {
          errors.push(
            `${source.directory}/package.json: internal dependency ${dependencyName} is not a workspace package`,
          );
          continue;
        }
        if (typeof version !== 'string' || !version.startsWith('workspace:')) {
          errors.push(
            `${source.directory}/package.json: ${dependencyName} must use the workspace: protocol`,
          );
        }
        if (source.directory.startsWith('packages/') && target.directory.startsWith('apps/')) {
          errors.push(`${source.directory}: packages must not depend on app ${target.directory}`);
        }
        if (source.directory.startsWith('apps/') && target.directory.startsWith('apps/')) {
          errors.push(
            `${source.directory}: apps must not depend directly on app ${target.directory}`,
          );
        }
        if (dependencyName === '@better-agent/test-support' && section !== 'devDependencies') {
          errors.push(
            `${source.directory}/package.json: @better-agent/test-support is allowed only in devDependencies`,
          );
        }
        if (productionDependencySections.has(section)) {
          productionGraph.get(sourceName)?.add(dependencyName);
        }
      }
    }
  }

  errors.push(...findProductionCycles(productionGraph));
  return errors;
}
