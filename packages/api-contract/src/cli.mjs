#!/usr/bin/env node
import {
  acceptResponseCompatibilityBaseline,
  checkGeneratedContract,
  generateContract,
} from './contract-toolchain.mjs';

function printResult(mode, result) {
  console.log(
    [
      `OpenAPI contract ${mode} passed`,
      `operations=${result.operationIds.length}`,
      `localRefs=${result.localReferenceCount}`,
      `bundleSha256=${result.bundleSha256}`,
      `typescriptSha256=${result.typescriptSha256}`,
      result.responseBaselineSha256 === undefined
        ? undefined
        : `responseBaselineSha256=${result.responseBaselineSha256}`,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'generate') {
    printResult('generation', await generateContract());
    return;
  }
  if (mode === 'check') {
    printResult('check', await checkGeneratedContract());
    return;
  }
  if (mode === 'accept-response-baseline') {
    const result = await acceptResponseCompatibilityBaseline();
    console.log(
      `Accepted reviewed response baseline ${result.baselinePath} ` +
        `sha256=${result.responseBaselineSha256}`,
    );
    return;
  }
  throw new Error(
    `Unknown contract command ${String(mode)}; expected "generate", "check" or ` +
      '"accept-response-baseline"',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
