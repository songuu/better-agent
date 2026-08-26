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
