#!/usr/bin/env node
import { checkGeneratedContract } from '../packages/api-contract/src/contract-toolchain.mjs';

checkGeneratedContract()
  .then((result) => {
    console.log(
      `Contract gate passed: ${result.operationIds.length} operations, ` +
        `${result.localReferenceCount} local references, bundle ${result.bundleSha256}, ` +
        `TypeScript ${result.typescriptSha256}, response baseline ` +
        `${result.responseBaselineSha256}`,
    );
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
