import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pnpmEntrypoint = process.env.npm_execpath;
if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
  throw new Error('G1 failure injection requires the pnpm npm_execpath contract');
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${String(code)}${stderr ? ': see stderr' : ''}`,
    );
  }
  for (const marker of options.markers ?? []) {
    const count = stdout.split(/\r?\n/u).filter((line) => line.trim() === marker).length;
    if (count !== 1) throw new Error(`failure injection command omitted exact marker: ${marker}`);
  }
}

await run(process.execPath, ['infra/test/postgres/run-g1-vertical-agent-integration.mjs'], {
  env: { BETTER_AGENT_G1_FAILURE_MATRIX: '1' },
  markers: [
    'g1-vertical-failure-matrix/1 authority-bypasses pass',
    'g1-acceptance-receipt/1 vertical-agent-flow pass',
  ],
});
await run(process.execPath, [
  pnpmEntrypoint,
  '--filter',
  '@better-agent/instruction-skill',
  'test',
  '--',
  'activation-compiler.test.ts',
]);
await run(process.execPath, [
  pnpmEntrypoint,
  '--filter',
  '@better-agent/release-core',
  'test',
  '--',
  'instruction-skill-source.test.ts',
  'agent-root-binding-entry-set.test.ts',
]);
await run(process.execPath, [
  pnpmEntrypoint,
  '--filter',
  '@better-agent/domain-contracts',
  'test',
  '--',
  'semantic-invariants.test.ts',
  'instruction-skill-source.test.ts',
]);
await run(process.execPath, ['infra/test/postgres/run-g1-production-evaluation-integration.mjs'], {
  markers: ['architecture-gate-suite/1 g1-production-evaluation pass'],
});

process.stdout.write('g1-failure-receipt/1 bypass-matrix pass\n');
