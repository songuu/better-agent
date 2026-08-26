# `@better-agent/api-contract`

Contract-first OpenAPI 3.1 gate for `docs/api/openapi.yaml`.

`pnpm contract:check` performs strict YAML parsing, local-reference and
`operationId` checks, Redocly semantic/example validation, bundling, TypeScript
generation drift checks, reviewed response compatibility, and credential-policy
baseline checks. External file/network `$ref` values are forbidden so CI remains
hermetic.

Runtime authorization code consumes the generated
`@better-agent/api-contract/credential-operation-policy-registry.js` subpath. It
exposes only a schema version, frozen operation IDs, and a resolver whose results
are recursively frozen; the mutable baseline JSON is not a package export. Both
the registry JavaScript and its declarations participate in the generated-artifact
drift gate.

The response baseline is intentionally conservative: any structural response
change is treated as potentially breaking. After an API review, update it with:

```powershell
pnpm --filter @better-agent/api-contract accept-response-baseline
pnpm contract:check
```

The baseline command does not update the generated bundle or TypeScript types;
review their diffs separately with `pnpm --filter @better-agent/api-contract generate`.
