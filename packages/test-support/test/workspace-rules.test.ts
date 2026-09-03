import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  validateCiWorkflow,
  validateDeploymentWorkflow,
  validateGitAttributes,
  validateWorkspaceGraph,
  type WorkspacePackage,
} from '../scripts/workspace-rules.mjs';

describe('validateGitAttributes', () => {
  const requiredLfPatterns = [
    '*.cjs',
    '*.cts',
    '*.js',
    '*.jsx',
    '*.json',
    '*.mjs',
    '*.mts',
    '*.md',
    '*.sql',
    '*.ts',
    '*.tsx',
    '*.yaml',
    '*.yml',
  ];
  const validAttributes = [
    '* text=auto',
    '',
    ...requiredLfPatterns.map((pattern) => `${pattern} text eol=lf`),
    '',
    '*.bat text eol=crlf',
    '*.cmd text eol=crlf',
    '*.ps1 text eol=crlf',
    '',
  ].join('\n');

  it('accepts explicit LF checkout rules for every formatted source extension', () => {
    expect(validateGitAttributes(validAttributes)).toEqual([]);
  });

  it('rejects a missing MTS rule that would turn declarations into CRLF on Windows', () => {
    for (const attributes of [
      validAttributes.replace('*.mts text eol=lf\n', ''),
      `${validAttributes}*.mts text eol=crlf\n`,
      `${validAttributes}*.mts -text\n`,
      `${validAttributes}* text=auto eol=crlf\n`,
    ]) {
      expect(validateGitAttributes(attributes)).toContain(
        '.gitattributes: attributes must match the closed cross-platform checkout schema',
      );
    }
  });
});

describe('validateDeploymentWorkflow', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/deploy-foundation.yml', import.meta.url),
    'utf8',
  );

  it('accepts the secret-separated, CI-attested production workflow', () => {
    expect(validateDeploymentWorkflow(workflow)).toEqual([]);
  });

  it('rejects manual dispatch, build secrets, SSH TOFU, and mutable deploy actions', () => {
    for (const weakened of [
      workflow.replace('on:\n', 'on:\n  workflow_dispatch:\n'),
      workflow.replace(
        '    runs-on: ubuntu-latest',
        '    env:\n      LEAK: $' + '{{ secrets.LEAK }}\n    runs-on: ubuntu-latest',
      ),
      workflow.replace(
        '          test -n "' + '$' + '{SSH_KNOWN_HOSTS}"',
        '          ssh-keyscan "' + '$' + '{DEPLOY_HOST}"',
      ),
      workflow.replace(
        'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
        'actions/download-artifact@v4',
      ),
    ]) {
      expect(validateDeploymentWorkflow(weakened)).not.toEqual([]);
    }
  });

  it('rejects deployment without the explicit production enable variable', () => {
    expect(
      validateDeploymentWorkflow(
        workflow.replace("vars.BETTER_AGENT_DEPLOY_ENABLED == 'true' &&\n      ", ''),
      ),
    ).toContain(
      '.github/workflows/deploy-foundation.yml: production deployment must require the explicit enable variable',
    );
  });

  it('rejects enable-condition bypasses and mutable build actions', () => {
    for (const weakened of [
      workflow.replace("vars.BETTER_AGENT_DEPLOY_ENABLED == 'true' &&", 'true ||'),
      workflow.replace(
        "github.event.workflow_run.head_branch == 'main'",
        "true || github.event.workflow_run.head_branch == 'main'",
      ),
      workflow.replace("needs.build.result == 'success'", 'always()'),
      workflow.replace(
        'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
        'actions/checkout@v6',
      ),
      workflow.replace(
        '    env:\n      ACCEPTED_SHA:',
        '    env:\n      LEAK: $' + '{{ secrets.LEAK }}\n      ACCEPTED_SHA:',
      ),
      workflow.replace(
        '      - name: Provision isolated PostgreSQL and switch current',
        '      - name: Provision isolated PostgreSQL and switch current\n        continue-on-error: true',
      ),
      workflow.replace('-o BatchMode=yes', '-o BatchMode=yes -o StrictHostKeyChecking=no'),
      workflow.replace(
        'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
        'evil/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      ),
      workflow.replace(
        '          test "${ACCEPTED_SHA}" = "$(git ls-remote https://github.com/${GITHUB_REPOSITORY}.git refs/heads/main | cut -f1)"\n',
        '',
      ),
    ]) {
      expect(validateDeploymentWorkflow(weakened)).not.toEqual([]);
    }
  });

  it('requires executable validation of existing current-link rollback evidence', () => {
    expect(
      validateDeploymentWorkflow(
        workflow.replace('scripts/deployment/resolve-current-release.mjs', 'readlink -f'),
      ),
    ).not.toEqual([]);
  });

  it('requires the attested release to build and contain the public web runtime', () => {
    for (const [requiredText, weakened] of [
      [
        'pnpm --filter @better-agent/web build',
        workflow.replace('          pnpm --filter @better-agent/web build\n', ''),
      ],
      [
        'apps/web/dist/server.js',
        workflow.replaceAll('apps/web/dist/server.js', 'apps/web/dist/missing.js'),
      ],
      [
        'apps/web/public/index.html',
        workflow.replaceAll('apps/web/public/index.html', 'apps/web/public/missing.html'),
      ],
    ] as const) {
      expect(validateDeploymentWorkflow(weakened)).toContain(
        `.github/workflows/deploy-foundation.yml: missing ${requiredText}`,
      );
    }
  });

  it('requires managed service installation and public Web acceptance', () => {
    for (const [requiredText, weakened] of [
      [
        'deploy/systemd/better-agent-web.service',
        workflow.replaceAll(
          'deploy/systemd/better-agent-web.service',
          'deploy/systemd/missing.service',
        ),
      ],
      [
        'deploy/nginx/better-agent.location.conf',
        workflow.replaceAll('deploy/nginx/better-agent.location.conf', 'deploy/nginx/missing.conf'),
      ],
      [
        'scripts/deployment/install-production-web.sh',
        workflow.replaceAll(
          'scripts/deployment/install-production-web.sh',
          'scripts/deployment/missing.sh',
        ),
      ],
      [
        'https://songuu.top/better-agent/api/healthz',
        workflow.replace(
          'https://songuu.top/better-agent/api/healthz',
          'http://127.0.0.1:4310/healthz',
        ),
      ],
    ] as const) {
      expect(validateDeploymentWorkflow(weakened)).toContain(
        `.github/workflows/deploy-foundation.yml: missing ${requiredText}`,
      );
    }
  });

  it('requires current-link validation before the database migration side effect', () => {
    const resolver =
      '          previous_release="$(node "${REMOTE_RELEASE}/scripts/deployment/resolve-current-release.mjs" "${RELEASE_ROOT}" "${CURRENT_LINK}")"\n';
    const weakened = workflow
      .replace(resolver, '')
      .replace(
        '          receipt="${SHARED_ROOT}/last-deployment"\n',
        resolver + '          receipt="${SHARED_ROOT}/last-deployment"\n',
      );
    expect(validateDeploymentWorkflow(weakened)).not.toEqual([]);
  });
});

function workspacePackage(
  directory: string,
  name: string,
  manifest: Record<string, unknown> = {},
): WorkspacePackage {
  return { directory, manifest: { ...manifest, name } };
}

describe('validateWorkspaceGraph', () => {
  it('accepts package dependencies and app-to-package dependencies', () => {
    const graph = [
      workspacePackage('packages/test-support', '@better-agent/test-support'),
      workspacePackage('packages/domain', '@better-agent/domain', {
        devDependencies: { '@better-agent/test-support': 'workspace:*' },
      }),
      workspacePackage('apps/api', '@better-agent/api', {
        dependencies: { '@better-agent/domain': 'workspace:*' },
      }),
    ];

    expect(validateWorkspaceGraph(graph)).toEqual([]);
  });

  it.each([
    {
      name: 'package to app',
      packages: [
        workspacePackage('packages/domain', '@better-agent/domain', {
          dependencies: { '@better-agent/api': 'workspace:*' },
        }),
        workspacePackage('apps/api', '@better-agent/api'),
      ],
      message: 'packages must not depend on app',
    },
    {
      name: 'app to app',
      packages: [
        workspacePackage('apps/api', '@better-agent/api', {
          dependencies: { '@better-agent/worker': 'workspace:*' },
        }),
        workspacePackage('apps/worker', '@better-agent/worker'),
      ],
      message: 'apps must not depend directly on app',
    },
    {
      name: 'non-workspace internal version',
      packages: [
        workspacePackage('packages/api-contract', '@better-agent/api-contract', {
          dependencies: { '@better-agent/domain': '^1.0.0' },
        }),
        workspacePackage('packages/domain', '@better-agent/domain'),
      ],
      message: 'must use the workspace: protocol',
    },
    {
      name: 'missing internal package',
      packages: [
        workspacePackage('packages/domain', '@better-agent/domain', {
          dependencies: { '@better-agent/missing': 'workspace:*' },
        }),
      ],
      message: 'is not a workspace package',
    },
    {
      name: 'test support as production dependency',
      packages: [
        workspacePackage('packages/test-support', '@better-agent/test-support'),
        workspacePackage('packages/domain', '@better-agent/domain', {
          dependencies: { '@better-agent/test-support': 'workspace:*' },
        }),
      ],
      message: 'allowed only in devDependencies',
    },
  ])('rejects $name', ({ packages, message }) => {
    expect(validateWorkspaceGraph(packages)).toContainEqual(expect.stringContaining(message));
  });

  it('normalizes Windows paths before enforcing package boundaries', () => {
    const graph = [
      workspacePackage('packages\\domain', '@better-agent/domain', {
        dependencies: { '@better-agent/api': 'workspace:*' },
      }),
      workspacePackage('apps\\api', '@better-agent/api'),
    ];

    expect(validateWorkspaceGraph(graph)).toContainEqual(
      expect.stringContaining('packages must not depend on app'),
    );
  });

  it('rejects production dependency cycles', () => {
    const graph = [
      workspacePackage('packages/a', '@better-agent/a', {
        dependencies: { '@better-agent/b': 'workspace:*' },
      }),
      workspacePackage('packages/b', '@better-agent/b', {
        dependencies: { '@better-agent/a': 'workspace:*' },
      }),
    ];

    expect(validateWorkspaceGraph(graph)).toContain(
      'workspace production dependency cycle: @better-agent/a -> @better-agent/b -> @better-agent/a',
    );
  });
});

describe('validateCiWorkflow', () => {
  const validWorkflow = [
    'name: CI',
    '',
    'on:',
    '  push:',
    '  pull_request:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    '  group: ci-$' + '{{ github.workflow }}-$' + '{{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  quality:',
    '    name: Quality ($' + '{{ matrix.os }})',
    '    runs-on: $' + '{{ matrix.os }}',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        os:',
    '          - ubuntu-latest',
    '          - windows-latest',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v6',
    '        with:',
    '          persist-credentials: false',
    '      - name: Set up pnpm',
    '        uses: pnpm/action-setup@v6',
    '        with:',
    '          run_install: false',
    '      - name: Set up Node.js',
    '        uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 22',
    '          cache: pnpm',
    '      - name: Install dependencies',
    '        run: pnpm install --frozen-lockfile',
    '      - name: Check formatting',
    '        run: pnpm format:check',
    '      - name: Lint',
    '        run: pnpm lint',
    '      - name: Check workspace boundaries',
    '        run: pnpm workspace:smoke',
    '      - name: Check OpenAPI and domain contracts',
    '        run: pnpm contract:check',
    '      - name: Typecheck',
    '        run: pnpm typecheck',
    '      - name: Test',
    '        run: pnpm test',
    '      - name: Build',
    '        run: pnpm build',
    '      - name: Test the architecture gate control plane',
    '        run: pnpm architecture:gate:test',
    '      - name: Verify tracked files are unchanged',
    '        run: git diff --exit-code -- .',
    '  architecture-gate:',
    '    name: G0-08 executable architecture gate',
    '    needs: quality',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v6',
    '        with:',
    '          persist-credentials: false',
    '      - name: Set up pnpm',
    '        uses: pnpm/action-setup@v6',
    '        with:',
    '          run_install: false',
    '      - name: Set up Node.js',
    '        uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 22',
    '          cache: pnpm',
    '      - name: Install dependencies',
    '        run: pnpm install --frozen-lockfile',
    '      - name: Run the clean-checkout architecture gate',
    '        run: pnpm architecture:gate',
  ].join('\n');

  function replaceArchitectureGateRun(workflow: string, replacement: string): string {
    return workflow.replace(/^ {8}run: pnpm architecture:gate$/mu, replacement);
  }

  it('accepts the single G0-08 aggregation entry', () => {
    expect(validateCiWorkflow(validWorkflow)).toEqual([]);
  });

  it('rejects a missing architecture gate and a direct PostgreSQL bypass', () => {
    expect(validateCiWorkflow(replaceArchitectureGateRun(validWorkflow, ''))).toContainEqual(
      expect.stringContaining('pnpm architecture:gate'),
    );
    expect(validateCiWorkflow(`${validWorkflow}\nrun: pnpm db:test:postgres16`)).toContainEqual(
      expect.stringContaining('must run through pnpm architecture:gate'),
    );
  });

  it('does not accept a required command that appears only inside a comment', () => {
    const disabled = replaceArchitectureGateRun(
      validWorkflow,
      '        run: echo disabled # pnpm architecture:gate',
    );
    expect(validateCiWorkflow(disabled)).toContainEqual(
      expect.stringContaining('pnpm architecture:gate'),
    );
  });

  it('rejects disabled, misplaced, weakened, or incorrectly configured gate execution', () => {
    for (const weakenedWorkflow of [
      validWorkflow.replace('pnpm/action-setup@v6', 'pnpm/action-setup@v5'),
      validWorkflow.replace(
        '      - name: Install dependencies',
        '      - uses: example/untrusted@v1\n      - name: Install dependencies',
      ),
      validWorkflow.replace(
        '          persist-credentials: false',
        '          persist-credentials: false\n          ref: main',
      ),
      validWorkflow.replace(
        '      - name: Install dependencies',
        '      - name: Unexpected mutation\n        run: node scripts/mutate.mjs\n      - name: Install dependencies',
      ),
      validWorkflow.replace('  pull_request:', '  workflow_dispatch:'),
    ]) {
      expect(validateCiWorkflow(weakenedWorkflow)).toContainEqual(
        expect.stringContaining('must match the closed G0-08 CI schema'),
      );
    }
    expect(
      validateCiWorkflow(
        validWorkflow.replace('  architecture-gate:', '  architecture-gate:\n    if: false'),
      ),
    ).toContainEqual(expect.stringContaining('must not define conditions'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace('  architecture-gate:', "  architecture-gate:\n    'if': false"),
      ),
    ).toContainEqual(expect.stringContaining('must not define conditions'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '        !!str if: false\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('must not define conditions'));
    expect(
      validateCiWorkflow(validWorkflow.replace('node-version: 22', 'node-version: 24')),
    ).toContainEqual(expect.stringContaining('Node 22'));
    expect(
      validateCiWorkflow(validWorkflow.replace('persist-credentials: false', '')),
    ).toContainEqual(expect.stringContaining('quality checkout'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(/( {2}architecture-gate:[\s\S]*?)persist-credentials: false/u, '$1'),
      ),
    ).toContainEqual(expect.stringContaining('architecture-gate checkout'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '      - uses: actions/checkout@v6\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('exactly one checkout'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '      - uses: "actions/checkout@v5"\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('exactly one checkout'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '      - "uses": actions/checkout@v5\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('exactly one checkout'));
    for (const flowCheckout of [
      '- { uses: actions/checkout@v5 }',
      '- uses : actions/checkout@v5',
    ]) {
      expect(
        validateCiWorkflow(
          validWorkflow.replace(
            '      - name: Run the clean-checkout architecture gate',
            `      ${flowCheckout}\n      - name: Run the clean-checkout architecture gate`,
          ),
        ),
      ).toContainEqual(expect.stringContaining('exactly one checkout'));
    }
    expect(
      validateCiWorkflow(validWorkflow.replace('actions/setup-node@v7', 'actions/setup-node@v6')),
    ).toContainEqual(expect.stringContaining('exactly one setup-node@v7'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '      - uses: actions/setup-node@v6\n        with:\n          node-version: 24\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('exactly one setup-node@v7'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          "      - 'uses': actions/setup-node@v6\n        with:\n          node-version: 24\n        run: pnpm architecture:gate",
        ),
      ),
    ).toContainEqual(expect.stringContaining('exactly one setup-node@v7'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '      - "uses" : actions/setup-node@v6\n        with:\n          node-version: 24\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('exactly one setup-node@v7'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '        uses: actions/checkout@v6',
          '        uses: actions/checkout@v6\n        uses: actions/checkout@v5',
        ),
      ),
    ).toContainEqual(expect.stringContaining('valid YAML with unique keys'));
    expect(
      validateCiWorkflow(validWorkflow.replace('  quality:', '  quality: &quality')),
    ).toContainEqual(expect.stringContaining('must not use YAML anchors'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '        continue-on-error: true\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('fail closed'));
    for (const contextOverride of [
      "        shell: bash --noprofile --norc -c 'exit 0' -- {0}",
      '        env:\n          NODE_OPTIONS: --import=./skip-gate.mjs',
      '        working-directory: ..',
    ]) {
      expect(
        validateCiWorkflow(
          replaceArchitectureGateRun(
            validWorkflow,
            `${contextOverride}\n        run: pnpm architecture:gate`,
          ),
        ),
      ).toContainEqual(expect.stringContaining('must not override the execution context'));
    }
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '    timeout-minutes: 30',
          "    timeout-minutes: 30\n    defaults:\n      run:\n        shell: bash --noprofile --norc -c 'exit 0' -- {0}",
        ),
      ),
    ).toContainEqual(expect.stringContaining('must not override the execution context'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          'jobs:',
          "defaults:\n  run:\n    shell: bash --noprofile --norc -c 'exit 0' -- {0}\njobs:",
        ),
      ),
    ).toContainEqual(expect.stringContaining('must not override the gate execution context'));
    const movedControlPlaneTest = replaceArchitectureGateRun(
      validWorkflow.replace('run: pnpm architecture:gate:test', 'run: echo moved'),
      '        run: pnpm architecture:gate\n      - run: pnpm architecture:gate:test',
    );
    expect(validateCiWorkflow(movedControlPlaneTest)).toContainEqual(
      expect.stringContaining('quality job must execute pnpm architecture:gate:test'),
    );
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '        run: pnpm architecture:gate:test',
          '        continue-on-error: true\n        run: pnpm architecture:gate:test',
        ),
      ),
    ).toContainEqual(expect.stringContaining('quality job must fail closed'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '        run: pnpm architecture:gate:test',
          '        !!str continue-on-error: true\n        run: pnpm architecture:gate:test',
        ),
      ),
    ).toContainEqual(expect.stringContaining('quality job must fail closed'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace('          - windows-latest', '          # - windows-latest'),
      ),
    ).toContainEqual(expect.stringContaining('Ubuntu then Windows'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '          - windows-latest',
          '          - windows-latest\n        exclude: [{ os: windows-latest }]',
        ),
      ),
    ).toContainEqual(expect.stringContaining('Ubuntu then Windows'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '    timeout-minutes: 30',
          '    timeout-minutes: 30\n    container: malicious.example/gate:latest',
        ),
      ),
    ).toContainEqual(expect.stringContaining('must not override the execution context'));
    expect(
      validateCiWorkflow(validWorkflow.replace('  contents: read', '  contents: write')),
    ).toContainEqual(expect.stringContaining('permissions must be exactly contents: read'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace('    runs-on: $' + '{{ matrix.os }}', '    runs-on: self-hosted'),
      ),
    ).toContainEqual(expect.stringContaining('matrix.os'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '  architecture-gate:',
          '  architecture-gate:\n    if: $' + '{{ 1 == 2 }}',
        ),
      ),
    ).toContainEqual(expect.stringContaining('must not define conditions'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow,
          '        if: false\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('must not define conditions'));
    expect(
      validateCiWorkflow(
        validWorkflow.replace(
          '        run: pnpm architecture:gate:test',
          '        if: false\n        run: pnpm architecture:gate:test',
        ),
      ),
    ).toContainEqual(expect.stringContaining('quality job must not define conditions'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow.replace('    timeout-minutes: 30\n', ''),
          '        timeout-minutes: 30\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('30 minute timeout'));
    expect(
      validateCiWorkflow(
        replaceArchitectureGateRun(
          validWorkflow.replace('    needs: quality\n', ''),
          '        env:\n          needs: quality\n        run: pnpm architecture:gate',
        ),
      ),
    ).toContainEqual(expect.stringContaining('must need quality'));
    const movedWindowsQualityTest = replaceArchitectureGateRun(
      validWorkflow.replace('      - name: Test\n        run: pnpm test\n', ''),
      '        run: pnpm architecture:gate\n      - name: Moved test\n        run: pnpm test',
    );
    expect(validateCiWorkflow(movedWindowsQualityTest)).toContainEqual(
      expect.stringContaining('quality job must execute pnpm test'),
    );
  });
});
