import { describe, expect, it } from 'vitest';

import { validateWorkspaceGraph, type WorkspacePackage } from '../scripts/workspace-rules.mjs';

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
