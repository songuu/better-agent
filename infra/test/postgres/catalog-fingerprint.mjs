const g005CatalogSchemas = Object.freeze(['app', 'auth', 'public']);

function renderSchemaListSql(schemaNames) {
  if (!Array.isArray(schemaNames) || schemaNames.length === 0) {
    throw new Error('catalog fingerprint requires at least one schema');
  }
  const uniqueNames = [...new Set(schemaNames)];
  for (const schemaName of uniqueNames) {
    if (typeof schemaName !== 'string' || !/^[a-z_][a-z0-9_]*$/u.test(schemaName)) {
      throw new Error(`invalid catalog fingerprint schema: ${String(schemaName)}`);
    }
  }
  return uniqueNames.map((schemaName) => `'${schemaName}'`).join(', ');
}

function renderCatalogLinesCte(schemaNames) {
  const schemaListSql = renderSchemaListSql(schemaNames);
  return `WITH catalog_lines(line) AS (
  SELECT pg_catalog.format(
    'class|%I.%I|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    relation.relkind,
    relation.relowner::regrole::text,
    COALESCE(relation.relacl::text, ''),
    relation.relrowsecurity,
    relation.relforcerowsecurity,
    relation.relreplident
  )
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN (${schemaListSql})
  UNION ALL
  SELECT pg_catalog.format(
    'attribute|%I.%I|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    attribute.attname,
    attribute.atttypid::regtype::text,
    attribute.attnotnull,
    attribute.attgenerated,
    COALESCE(attribute.attacl::text, ''),
    COALESCE(pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid), '')
  )
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE namespace_row.nspname IN (${schemaListSql})
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  UNION ALL
  SELECT pg_catalog.format(
    'constraint|%I.%I|%s|%s',
    namespace_row.nspname,
    relation.relname,
    constraint_row.conname,
    pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
  )
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN (${schemaListSql})
  UNION ALL
  SELECT pg_catalog.format(
    'policy|%I.%I|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    policy.polname,
    policy.polpermissive,
    policy.polcmd,
    policy.polroles::text,
    COALESCE(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), ''),
    COALESCE(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), '')
  )
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN (${schemaListSql})
  UNION ALL
  SELECT pg_catalog.format(
    'function|%I.%I(%s)|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    procedure_row.proname,
    pg_catalog.pg_get_function_identity_arguments(procedure_row.oid),
    procedure_row.proowner::regrole::text,
    COALESCE(procedure_row.proacl::text, ''),
    procedure_row.prosecdef,
    procedure_row.prokind,
    procedure_row.provolatile,
    procedure_row.proparallel,
    procedure_row.proleakproof,
    procedure_row.proisstrict,
    procedure_row.proretset,
    COALESCE(procedure_row.proconfig::text, ''),
    pg_catalog.pg_get_function_result(procedure_row.oid),
    CASE
      WHEN procedure_row.prokind = 'a' THEN ''
      ELSE pg_catalog.pg_get_functiondef(procedure_row.oid)
    END
  )
  FROM pg_catalog.pg_proc AS procedure_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname IN (${schemaListSql})
  UNION ALL
  SELECT pg_catalog.format(
    'trigger|%I.%I|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    trigger_row.tgname,
    trigger_row.tgenabled,
    trigger_row.tgisinternal,
    pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
  )
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname IN (${schemaListSql})
    -- PostgreSQL assigns OID-derived names to internal RI triggers every time
    -- a foreign key is recreated. Retaining those names or their rendered
    -- definitions would make exact down/reapply comparison depend on allocator
    -- history rather than DDL.
    AND NOT trigger_row.tgisinternal
  UNION ALL
  SELECT pg_catalog.format(
    'internal_trigger|%I.%I|%s|%s|%I.%I(%s)|%s|%s|%s|%s',
    namespace_row.nspname,
    relation.relname,
    CASE
      WHEN constraint_relation.oid IS NULL THEN ''
      ELSE pg_catalog.format(
        '%I.%I',
        constraint_namespace.nspname,
        constraint_relation.relname
      )
    END,
    COALESCE(pg_catalog.quote_ident(constraint_row.conname), ''),
    function_namespace.nspname,
    trigger_function.proname,
    pg_catalog.pg_get_function_identity_arguments(trigger_function.oid),
    trigger_row.tgtype,
    trigger_row.tgenabled,
    trigger_row.tgdeferrable,
    trigger_row.tginitdeferred
  )
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  JOIN pg_catalog.pg_proc AS trigger_function ON trigger_function.oid = trigger_row.tgfoid
  JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = trigger_function.pronamespace
  LEFT JOIN pg_catalog.pg_constraint AS constraint_row
    ON constraint_row.oid = trigger_row.tgconstraint
  LEFT JOIN pg_catalog.pg_class AS constraint_relation
    ON constraint_relation.oid = constraint_row.conrelid
  LEFT JOIN pg_catalog.pg_namespace AS constraint_namespace
    ON constraint_namespace.oid = constraint_relation.relnamespace
  WHERE namespace_row.nspname IN (${schemaListSql})
    AND trigger_row.tgisinternal
  UNION ALL
  SELECT pg_catalog.format(
    'index|%I.%I|%I|%s|%s|%s|%s|%s|%s|%s|%s|%s',
    namespace_row.nspname,
    table_relation.relname,
    index_relation.relname,
    index_row.indisunique,
    index_row.indisprimary,
    index_row.indisexclusion,
    index_row.indisvalid,
    index_row.indisready,
    index_row.indislive,
    index_row.indisclustered,
    index_row.indisreplident,
    pg_catalog.pg_get_indexdef(index_relation.oid)
  )
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_row.indrelid
  JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_relation.relnamespace
  WHERE namespace_row.nspname IN (${schemaListSql})
  UNION ALL
  SELECT pg_catalog.format(
    'schema|%I|%s|%s',
    namespace_row.nspname,
    namespace_row.nspowner::regrole::text,
    COALESCE(namespace_row.nspacl::text, '')
  )
  FROM pg_catalog.pg_namespace AS namespace_row
  WHERE namespace_row.nspname IN (${schemaListSql})
)`;
}

function renderCatalogFingerprintSelectSql(schemaNames) {
  return `${renderCatalogLinesCte(schemaNames)}
SELECT pg_catalog.encode(
  public.digest(
    COALESCE(pg_catalog.string_agg(line, E'\\n' ORDER BY line), ''),
    'sha256'
  ),
  'hex'
)
FROM catalog_lines`;
}

function renderCatalogLinesStatementSql(schemaNames) {
  return `${renderCatalogLinesCte(schemaNames)}
SELECT pg_catalog.encode(pg_catalog.convert_to(line, 'UTF8'), 'hex')
FROM catalog_lines
ORDER BY line;`;
}

export function renderCatalogFingerprintExpressionSql(schemaNames) {
  return `(${renderCatalogFingerprintSelectSql(schemaNames)})`;
}

export const g005CatalogFingerprintSql = `${renderCatalogFingerprintSelectSql(
  g005CatalogSchemas,
)};`;

export const g005CatalogLinesSql = renderCatalogLinesStatementSql(g005CatalogSchemas);

export function decodeCatalogLines(encodedLines) {
  if (encodedLines === '') return [];
  return encodedLines.split(/\r?\n/u).map((line) => Buffer.from(line, 'hex').toString('utf8'));
}

function catalogLineKey(line) {
  const parts = line.split('|');
  if (parts[0] === 'function') return parts.slice(0, 3).join('|');
  if (parts[0] === 'internal_trigger') return parts.slice(0, 6).join('|');
  if (parts[0] === 'trigger' || parts[0] === 'index') return parts.slice(0, 4).join('|');
  return line;
}

export function describeCatalogDeltas(expectedLines, actualLines) {
  const expectedByKey = new Map(expectedLines.map((line) => [catalogLineKey(line), line]));
  const actualByKey = new Map(actualLines.map((line) => [catalogLineKey(line), line]));
  const keys = new Set([...expectedByKey.keys(), ...actualByKey.keys()]);
  return [...keys]
    .filter((key) => expectedByKey.get(key) !== actualByKey.get(key))
    .slice(0, 12)
    .map((key) => {
      const expected = expectedByKey.get(key);
      const actual = actualByKey.get(key);
      if (expected === undefined) return `added ${key}`;
      if (actual === undefined) return `removed ${key}`;
      let offset = 0;
      while (offset < expected.length && expected[offset] === actual[offset]) offset += 1;
      return `changed ${key} at character ${String(offset)}`;
    })
    .join('; ');
}
