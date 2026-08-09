#!/usr/bin/env node
/**
 * Publishes generated API client packages to GitHub Packages.
 *
 * A package is only published when its OpenAPI spec changed since the last
 * successful publish. Change detection is based on the spec sha256 recorded in
 * each package's manifest.json (at generate time) vs the hash recorded in
 * `<spec>.published-hash` (at last successful publish, stored next to the spec
 * in api-reference/).
 *
 * Usage:
 *   node scripts/publish-clients.mjs                 # publish changed packages
 *   node scripts/publish-clients.mjs --dry-run       # preview, no publish
 *   node scripts/publish-clients.mjs --tag beta      # publish with dist-tag
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFileHash } from './lib/spec-hash.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUTPUT_DIR = join(ROOT, 'generated');
const MANIFEST_FILE = 'manifest.json';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** List generated package directories. */
function discoverPackages(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** Read and parse a JSON file, or null if missing/invalid. */
function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Read the recorded spec hash of the last successful publish, or null. */
function readPublishedHash(specPath) {
  const file = `${specPath}.published-hash`;
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').trim() || null;
}

/** Persist the spec hash after a successful publish, next to the spec file. */
function writePublishedHash(specPath, hash) {
  writeFileSync(`${specPath}.published-hash`, `${hash}\n`);
}

/** Whether the generated client reflects the current spec on disk. */
function isStale(manifestSpecHash, currentSpecHash) {
  return manifestSpecHash !== currentSpecHash;
}

/** Whether the package needs publishing (spec changed since last publish). */
function needsPublish(manifestSpecHash, publishedHash) {
  return manifestSpecHash !== publishedHash;
}

/** Parse CLI args into an options object. */
function parseArgs(argv) {
  const opts = { dryRun: false, tag: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--tag') opts.tag = argv[++i] || null;
    else if (arg.startsWith('--')) console.warn(`Ignoring unknown option: ${arg}`);
  }
  return opts;
}

/** Build npm publish arguments. */
function buildPublishArgs(opts) {
  const args = ['publish'];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.tag) args.push('--tag', opts.tag);
  return args;
}

/** Run npm publish in the package directory. */
function runPublish(pkgDir, opts) {
  execFileSync('npm', buildPublishArgs(opts), { cwd: pkgDir, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(OUTPUT_DIR)) {
    console.error(`No ${OUTPUT_DIR} directory. Run "npm run generate" first.`);
    process.exit(1);
  }

  const packages = discoverPackages(OUTPUT_DIR);
  if (packages.length === 0) {
    console.error(`No generated packages in ${OUTPUT_DIR}. Run "npm run generate" first.`);
    process.exit(1);
  }

  const toPublish = [];
  const toSkip = [];
  const stale = [];
  const invalid = [];

  for (const pkgDir of packages) {
    const pkgName = join(pkgDir).split('/').pop();
    const manifest = readJson(join(pkgDir, MANIFEST_FILE));

    if (!manifest?.specPath || !manifest?.specHash) {
      console.warn(`SKIP ${pkgName}: missing/invalid ${MANIFEST_FILE} (run "npm run generate")`);
      invalid.push(pkgName);
      continue;
    }

    const specPath = resolve(manifest.specPath);
    if (!existsSync(specPath)) {
      console.warn(`SKIP ${pkgName}: spec not found at ${manifest.specPath}`);
      invalid.push(pkgName);
      continue;
    }

    const currentSpecHash = computeFileHash(specPath);

    if (isStale(manifest.specHash, currentSpecHash)) {
      console.warn(`SKIP ${pkgName}: spec changed since generate (run "npm run generate")`);
      stale.push(pkgName);
      continue;
    }

    const publishedHash = readPublishedHash(specPath);

    if (!needsPublish(manifest.specHash, publishedHash)) {
      console.log(`SKIP ${pkgName}: spec unchanged since last publish`);
      toSkip.push(pkgName);
      continue;
    }

    console.log(`PUBLISH ${pkgName}: spec changed since last publish`);
    toPublish.push(pkgDir);
  }

  if (toPublish.length === 0) {
    console.log('\nNothing to publish.');
    return;
  }

  console.log(`\nPublishing ${toPublish.length} package(s)...`);
  let publishedCount = 0;

  for (const pkgDir of toPublish) {
    const manifest = readJson(join(pkgDir, MANIFEST_FILE));
    const pkgName = join(pkgDir).split('/').pop();
    const specPath = resolve(manifest.specPath);
    try {
      runPublish(pkgDir, opts);
      if (!opts.dryRun) writePublishedHash(specPath, manifest.specHash);
      publishedCount += 1;
      console.log(`  ✓ ${pkgName} published`);
    } catch (error) {
      console.error(`  ✗ ${pkgName} failed:`, error.message);
    }
  }

  const summary = [
    `published: ${publishedCount}`,
    `unchanged: ${toSkip.length}`,
    `stale (regenerate needed): ${stale.length}`,
    `invalid: ${invalid.length}`,
  ];
  console.log(`\nSummary — ${summary.join(', ')}`);

  if (publishedCount < toPublish.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
