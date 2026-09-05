import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runG1GateCommand } from '../../../scripts/g1-gate.mjs';

async function fixture(source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'better-agent-g1-gate-'));
  const filename = path.join(directory, 'fixture.mjs');
  await writeFile(filename, source, 'utf8');
  return filename;
}

test('accepts only the exact vertical E2E semantic receipt', async () => {
  const script = await fixture(
    "process.stdout.write('g1-acceptance-receipt/1 vertical-agent-flow pass\\n')",
  );

  const result = await runG1GateCommand({ mode: 'e2e', script });

  assert.equal(result.marker, 'g1-acceptance-receipt/1 vertical-agent-flow pass');
});

test('rejects exit zero when the semantic receipt is absent', async () => {
  const script = await fixture("process.stdout.write('tests passed\\n')");

  await assert.rejects(
    runG1GateCommand({ mode: 'e2e', script }),
    /missing exact semantic receipt/u,
  );
});

test('rejects a receipt emitted by a failing command', async () => {
  const script = await fixture(
    "process.stdout.write('g1-failure-receipt/1 bypass-matrix pass\\n'); process.exitCode = 7",
  );

  await assert.rejects(runG1GateCommand({ mode: 'failure', script }), /exited with code 7/u);
});

test('rejects unknown gate modes', async () => {
  await assert.rejects(
    runG1GateCommand({ mode: 'unknown', script: 'unused' }),
    /unsupported G1 gate mode/u,
  );
});
