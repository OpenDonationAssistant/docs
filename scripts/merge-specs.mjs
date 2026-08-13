#!/usr/bin/env node
/**
 * Merges all per-service OpenAPI specs in api-reference/ into a single
 * self-contained spec (api-reference/merged.yml).
 *
 * Uses the latest version (by semver) of each service.
 *
 * Usage: node scripts/merge-specs.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { discoverSpecFiles, mergeSpecs, selectLatestSpecs } from './lib/merge-specs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SPECS_DIR = join(ROOT, 'api-reference');
const OUTPUT_FILE = join(SPECS_DIR, 'merged.yml');

function main() {
  const specFiles = discoverSpecFiles(SPECS_DIR);
  if (specFiles.length === 0) {
    console.error(`No specs found in ${SPECS_DIR}`);
    process.exit(1);
  }

  const selected = selectLatestSpecs(specFiles);
  const merged = mergeSpecs(selected);

  writeFileSync(OUTPUT_FILE, YAML.stringify(merged) + '\n');

  const operationCount = Object.values(merged.paths).reduce(
    (sum, pathItem) => sum + Object.keys(pathItem).filter((m) => m !== 'parameters').length,
    0,
  );
  console.log(`Merged ${selected.length} service spec(s) into ${OUTPUT_FILE}`);
  console.log(`  paths: ${Object.keys(merged.paths).length}, operations: ${operationCount}, schemas: ${Object.keys(merged.components.schemas).length}`);
}

main();