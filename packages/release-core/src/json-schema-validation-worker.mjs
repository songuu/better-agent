import { parentPort, workerData } from 'node:worker_threads';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { JSON_SCHEMA_VALIDATOR_PROFILE as profile } from './json-schema-profile.mjs';

const maps = new Set([
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
]);
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const singles = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'unevaluatedItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
const keywords = new Set([
  ...maps,
  ...arrays,
  ...singles,
  '$schema',
  '$id',
  '$anchor',
  '$dynamicAnchor',
  '$ref',
  '$dynamicRef',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'format',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxContains',
  'minContains',
  'maxProperties',
  'minProperties',
  'required',
  'dependentRequired',
  'contentEncoding',
  'contentMediaType',
]);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** @param {string} part */
function escapePointer(part) {
  return part.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Inspect only schema-bearing positions: defaults/const/examples are business data, not code. @param {unknown} document */
function checkProfile(document) {
  const locations = new Set();
  /** @type {Map<string, string>} */
  const anchors = new Map();
  /** @type {Record<string, unknown>[]} */
  const schemaNodes = [];
  /** @type {string[]} */
  const references = [];
  /** @param {unknown} node @param {string} path */
  function visit(node, path) {
    if (locations.size >= profile.maximum_schema_nodes) throw new RangeError('limit');
    locations.add(path);
    if (typeof node === 'boolean') return;
    if (!object(node)) throw new Error('schema');
    schemaNodes.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (!keywords.has(key)) throw new Error('keyword');
      if (key === '$schema' && value !== profile.dialect) throw new Error('dialect');
      if (key === '$id' && path !== '') throw new Error('nested resource');
      // Ajv intentionally omits this map key; accepting it would silently drop a constraint.
      if (key === 'dependentRequired' && object(value) && Object.hasOwn(value, '__proto__'))
        throw new Error('unsupported map key');
      if (key === 'format' && (typeof value !== 'string' || !profile.formats.includes(value)))
        throw new Error('format');
      if (key === '$anchor' || key === '$dynamicAnchor') {
        if (
          typeof value !== 'string' ||
          !/^[A-Za-z_][-A-Za-z0-9._]*$/u.test(value) ||
          anchors.has(value)
        )
          throw new Error('anchor');
        anchors.set(value, path);
      }
      if (key === '$ref' || key === '$dynamicRef') {
        if (typeof value !== 'string' || !value.startsWith('#'))
          throw new Error('external reference');
        const decoded = decodeURIComponent(value.slice(1));
        if (value !== `#${encodeURI(decoded).replaceAll('#', '%23')}`)
          throw new Error('reference encoding');
        references.push(decoded);
      }
      if (maps.has(key)) {
        if (!object(value)) throw new Error('map');
        for (const [name, child] of Object.entries(value)) {
          if (name === '__proto__') throw new Error('unsupported map key');
          visit(child, `${path}/${key}/${escapePointer(name)}`);
        }
      } else if (arrays.has(key)) {
        if (!Array.isArray(value)) throw new Error('array');
        value.forEach((child, index) => {
          visit(child, `${path}/${key}/${index}`);
        });
      } else if (singles.has(key)) visit(value, `${path}/${key}`);
    }
  }
  visit(document, '');
  for (const reference of references) {
    if (
      !(reference === '' || reference.startsWith('/')
        ? locations.has(reference)
        : anchors.has(reference))
    )
      throw new Error('unresolved reference');
  }
  return { schemaNodes, anchors };
}

/** @param {Record<string, unknown>[]} schemaNodes @param {Map<string, string>} anchors */
function lowerReferences(schemaNodes, anchors) {
  // One resource + unique anchors means there is no dynamic override. Lowering
  // avoids Ajv's incorrect root fallback for ordinary anchors and pointer targets.
  // Mutate only the worker copy, after validating the original meta-schema.
  for (const node of schemaNodes) {
    for (const key of ['$ref', '$dynamicRef']) {
      if (typeof node[key] !== 'string') continue;
      const fragment = decodeURIComponent(node[key].slice(1));
      const location = anchors.get(fragment);
      if (location !== undefined) node[key] = `#${encodeURI(location).replaceAll('#', '%23')}`;
    }
    if (!Object.hasOwn(node, '$dynamicRef')) continue;
    const reference = node.$dynamicRef;
    if (Object.hasOwn(node, '$ref')) {
      const allOf = /** @type {unknown[]} */ (node.allOf ?? []);
      // Append so all existing pointer locations and sibling constraints survive.
      node.allOf = [...allOf, { $ref: reference }];
    } else node.$ref = reference;
    delete node.$dynamicRef;
  }
}

// The worker handles one bounded message and exits. No loader, user-defined keyword,
// schema-supplied executable, logger callback or network reference fetch is registered.
if (parentPort !== null) {
  let status = 'invalid_schema';
  try {
    const request = /** @type {{schema: string, instance?: string}} */ (workerData);
    const document = JSON.parse(request.schema);
    const { schemaNodes, anchors } = checkProfile(document);
    const ajv = new Ajv2020({ ...profile.ajv_options, logger: false });
    // Ajv resolves standard $anchor references but does not whitelist the keyword
    // in strict mode; its syntax/uniqueness is checked above and by the meta-schema.
    ajv.addKeyword('$anchor');
    addFormats.default(ajv, {
      mode: 'full',
      formats: /** @type {import('ajv-formats').FormatName[]} */ ([...profile.formats]),
      keywords: false,
    });
    if (!ajv.validateSchema(document)) throw new Error('schema');
    lowerReferences(schemaNodes, anchors);
    const validator = ajv.compile(document);
    status = 'ok';
    if (request.instance !== undefined) {
      try {
        status = validator(JSON.parse(request.instance)) ? 'ok' : 'invalid_instance';
      } catch {
        status = 'limit';
      }
    }
  } catch (error) {
    if (error instanceof RangeError) status = 'limit';
  }
  parentPort.postMessage(status);
  parentPort.close();
}
