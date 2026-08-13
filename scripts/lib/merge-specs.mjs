/**
 * Pure merge logic for combining per-service OpenAPI specs into one spec.
 *
 * Strategy:
 *   1. Group spec files by service slug (derived from info.title).
 *   2. Select the latest version per service (semver comparison).
 *   3. Merge paths from all selected specs.
 *   4. Merge component schemas, deduplicating identical definitions and
 *      namespacing genuine conflicts with a service prefix.
 *   5. Rewrite every internal $ref to the final (possibly namespaced) name.
 *   6. Prefix colliding operationIds with the service prefix so the generated
 *      SDK exports unique function names.
 *   7. Tag every operation with its service so the merged spec is navigable.
 *
 * All functions are pure: same input -> same output, no side effects.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Normalize a version string to valid semver (e.g. "0.0" -> "0.0.0"). */
export function normalizeVersion(version) {
  const parts = String(version ?? '0').split('.');
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

/** Compare two version strings numerically. Returns negative/zero/positive. */
export function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map(Number);
  const pb = normalizeVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/** Derive a service slug from a spec title (e.g. "ODA Actions Service" -> "actions-service"). */
export function slugFromTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^oda-/, '');
}

/** Short camelCase prefix for a service slug (e.g. "actions-service" -> "actions"). */
export function servicePrefix(slug) {
  return slug
    .replace(/-service$/, '')
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Human-readable tag name for a service slug (e.g. "actions-service" -> "Actions"). */
export function serviceDisplayName(slug) {
  const base = slug.replace(/-service$/, '');
  return base
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Deep structural equality for plain JSON data. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Discovery & selection
// ---------------------------------------------------------------------------

/** List OpenAPI spec files (oda-*.yml) in a directory. */
export function discoverSpecFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.startsWith('oda-') && name.endsWith('.yml'))
    .map((name) => join(dir, name))
    .sort();
}

/** Read and parse a YAML spec file. */
export function readSpec(filePath) {
  return YAML.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Select the latest spec per service (grouped by title slug, compared by semver).
 * Returns an array of { slug, file, spec } sorted by slug.
 */
export function selectLatestSpecs(specFiles) {
  const groups = new Map();

  for (const file of specFiles) {
    const spec = readSpec(file);
    const title = spec?.info?.title;
    if (!title) continue;

    const slug = slugFromTitle(title);
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push({ file, spec });
  }

  const selected = [];
  for (const [slug, entries] of groups) {
    entries.sort((a, b) => compareVersions(a.spec.info.version, b.spec.info.version));
    selected.push({ slug, ...entries[entries.length - 1] });
  }

  return selected.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Schema mapping
// ---------------------------------------------------------------------------

/**
 * Build a per-service mapping of original schema name -> final merged name.
 *
 * Rules:
 *   - First occurrence of a name keeps the name.
 *   - Later identical definitions reuse the existing name (dedupe).
 *   - Later differing definitions get namespaced as `<prefix>_<name>`.
 *
 * Returns a Map<slug, Map<originalName, finalName>>.
 */
export function buildSchemaMapping(selected) {
  const seen = new Map(); // name -> [{ def, finalName }]
  const mapping = new Map();

  for (const { slug, spec } of selected) {
    const schemas = spec.components?.schemas || {};
    const slugMap = new Map();

    for (const [name, def] of Object.entries(schemas)) {
      const entries = seen.get(name);
      let finalName = name;

      if (entries) {
        const match = entries.find((entry) => deepEqual(entry.def, def));
        if (match) {
          finalName = match.finalName;
        } else {
          finalName = `${servicePrefix(slug)}_${name}`;
          entries.push({ def, finalName });
        }
      } else {
        seen.set(name, [{ def, finalName }]);
      }

      slugMap.set(name, finalName);
    }

    mapping.set(slug, slugMap);
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// Ref rewriting
// ---------------------------------------------------------------------------

/**
 * Deep-clone a node, rewriting every internal component $ref through the
 * per-service name map. Unknown refs are left untouched.
 */
export function rewriteRefs(node, slugMap) {
  if (Array.isArray(node)) {
    return node.map((item) => rewriteRefs(item, slugMap));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
        const original = value.split('/').pop();
        const finalName = slugMap.get(original) || original;
        out[key] = `#/components/schemas/${finalName}`;
      } else {
        out[key] = rewriteRefs(value, slugMap);
      }
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------
// OperationId collision handling
// ---------------------------------------------------------------------------

/** Count occurrences of each operationId across all path items. */
export function countOperationIds(pathItems) {
  const counts = new Map();
  for (const pathItem of pathItems) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation?.operationId) {
        counts.set(operation.operationId, (counts.get(operation.operationId) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Prefix every colliding operationId with its service prefix so generated SDK
 * function names stay unique. Accepts [{ slug, item }] and returns clean items.
 */
export function disambiguateOperationIds(entries, counts) {
  return entries.map(({ slug, item }) => {
    const out = { ...item };
    for (const method of HTTP_METHODS) {
      const operation = out[method];
      if (operation?.operationId && counts.get(operation.operationId) > 1) {
        out[method] = {
          ...operation,
          operationId: `${servicePrefix(slug)}_${operation.operationId}`,
        };
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge selected specs into a single self-contained OpenAPI document.
 * Returns a plain object ready for YAML serialization.
 */
export function mergeSpecs(selected) {
  const mapping = buildSchemaMapping(selected);
  const mergedPaths = new Map(); // pathKey -> { slug, item }
  const mergedSchemas = new Map(); // finalName -> schema
  const tagNames = new Set();

  // 1. Collect paths and schemas per service.
  for (const { slug, spec } of selected) {
    const slugMap = mapping.get(slug);
    const displayName = serviceDisplayName(slug);

    for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
      const item = rewriteRefs(pathItem, slugMap);
      for (const method of HTTP_METHODS) {
        if (item[method]) {
          item[method] = { ...item[method], tags: [displayName] };
          tagNames.add(displayName);
        }
      }
      mergedPaths.set(pathKey, { slug, item });
    }

    for (const [name, def] of Object.entries(spec.components?.schemas || {})) {
      const finalName = slugMap.get(name);
      if (!mergedSchemas.has(finalName)) {
        mergedSchemas.set(finalName, rewriteRefs(def, slugMap));
      }
    }
  }

  // 2. Disambiguate colliding operationIds.
  const pathItems = [...mergedPaths.entries()].map(([key, { slug, item }]) => ({ key, slug, item }));
  const counts = countOperationIds(pathItems.map(({ item }) => item));
  const disambiguated = disambiguateOperationIds(pathItems, counts);

  const paths = {};
  const ordered = pathItems
    .map(({ key }, index) => ({ key, item: disambiguated[index] }))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const { key, item } of ordered) {
    paths[key] = item;
  }

  // 3. Assemble the merged document (deterministic ordering).
  const schemas = {};
  for (const name of [...mergedSchemas.keys()].sort()) {
    schemas[name] = mergedSchemas.get(name);
  }

  return {
    openapi: '3.0.1',
    info: {
      title: 'ODA Client',
      version: '1.0.0',
      description: 'Merged OpenAPI specification for all OpenDonationAssistant microservices.',
      license: {
        name: 'AGPL-3.0',
        url: 'https://www.gnu.org/licenses/agpl-3.0.en.html',
      },
    },
    tags: [...tagNames].sort().map((name) => ({ name })),
    paths,
    components: { schemas },
  };
}