import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const definitions = Object.freeze({
  e2e: Object.freeze({
    marker: 'g1-acceptance-receipt/1 vertical-agent-flow pass',
    script: fileURLToPath(
      new URL('../infra/test/postgres/run-g1-vertical-agent-integration.mjs', import.meta.url),
    ),
  }),
  failure: Object.freeze({
    marker: 'g1-failure-receipt/1 bypass-matrix pass',
    script: fileURLToPath(
      new URL('../tests/failure-injection/g1-bypass-matrix.mjs', import.meta.url),
    ),
  }),
});

function definitionFor(mode) {
  const definition = definitions[mode];
  if (definition === undefined) throw new Error(`unsupported G1 gate mode: ${mode}`);
  return definition;
}

export async function runG1GateCommand({ mode, script }) {
  const definition = definitionFor(mode);
  const child = spawn(process.execPath, [script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
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
      `G1 ${mode} command exited with code ${String(code)}${stderr === '' ? '' : ': see stderr'}`,
    );
  }
  const markers = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line === definition.marker);
  if (markers.length !== 1) {
    throw new Error(`G1 ${mode} command is missing exact semantic receipt: ${definition.marker}`);
  }
  return Object.freeze({ marker: definition.marker });
}

async function main() {
  const mode = process.argv[2] ?? '';
  const definition = definitionFor(mode);
  await runG1GateCommand({ mode, script: definition.script });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
