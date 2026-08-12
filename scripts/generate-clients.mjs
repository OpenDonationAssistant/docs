#!/usr/bin/env node
/**
 * Generates one npm package per OpenAPI spec in api-reference/.
 *
 * For each valid spec it:
 *   1. Generates a self-contained TypeScript client (types + SDK + axios client)
 *      using @hey-api/openapi-ts.
 *   2. Writes a package.json, tsconfig.json, README.md and a manifest.json
 *      (recording the spec path + hash for change detection on publish).
 *   3. Compiles the client to dist/ so the package is installable.
 *
 * Usage: node scripts/generate-clients.mjs
 */

import { createClient } from '@hey-api/openapi-ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { computeFileHash } from './lib/spec-hash.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SPECS_DIR = join(ROOT, 'api-reference');
const OUTPUT_DIR = join(ROOT, 'generated');
const SCOPE = '@opendonationassistant';
const REGISTRY = 'https://npm.pkg.github.com';
const MANIFEST_FILE = 'manifest.json';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** List OpenAPI spec files (oda-*.yml) in the specs directory. */
function discoverSpecFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.startsWith('oda-') && name.endsWith('.yml'))
    .map((name) => join(dir, name))
    .sort();
}

/** Read and parse a YAML spec file. */
function readSpec(filePath) {
  return YAML.parse(readFileSync(filePath, 'utf8'));
}

/** Derive a scoped npm package name from the spec title. */
function derivePackageName(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^oda-/, '');
  return `${SCOPE}/${slug}`;
}

/** Normalize a version string to valid npm semver (e.g. "0.0" -> "0.0.0"). */
function normalizeVersion(version) {
  const parts = String(version).split('.');
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

/** Build the package.json contents for a generated package. */
function buildPackageJson(name, version) {
  return {
    name,
    version,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    },
    files: ['dist'],
    repository: {
      type: 'git',
      url: 'git+https://github.com/opendonationassistant/docs.git',
    },
    dependencies: {
      axios: '^1.13.4',
    },
    publishConfig: {
      registry: REGISTRY,
    },
    scripts: { build: 'tsc' },
    sideEffects: false,
  };
}

/** Build the tsconfig.json contents for a generated package. */
function buildTsconfig() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      declaration: true,
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
    },
    include: ['src'],
  };
}

/** Build the README.md contents for a generated package. */
function buildReadme(name, version) {
  return `# ${name}

TypeScript client for the \`${name}\` service (v${version}).

Generated from the OpenAPI spec in \`api-reference/\`. Do not edit generated files.

## Install from GitHub Packages

This package is published to GitHub Packages. Add the following to your project's
\`.npmrc\` so npm resolves the \`${SCOPE}\` scope to the GitHub Packages registry:

\`\`\`bash
${SCOPE}:registry=${REGISTRY}
//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}
\`\`\`

\`GITHUB_TOKEN\` must be a token with \`read:packages\` scope (or a personal access
token configured on \`https://npm.pkg.github.com\`).

## Install

\`\`\`bash
npm install ${name}
\`\`\`

## Usage

The spec does not define a server URL, so you must configure the base URL at runtime:

\`\`\`ts
import { client } from '${name}';

client.setConfig({ baseURL: 'https://api.example.com' });
\`\`\`

Then call the generated SDK functions:

\`\`\`ts
import { getActions } from '${name}';

const { data, error } = await getActions({ query: { recipientId: '...' } });
\`\`\`

## Authentication

If the service requires authentication, pass a bearer token via the client config:

\`\`\`ts
client.setConfig({
  baseURL: 'https://api.example.com',
  auth: () => \`Bearer \${token}\`,
});
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Generate the TypeScript client source for one spec into pkgDir/src. */
async function generateClientSource(specPath, pkgDir) {
  const srcDir = join(pkgDir, 'src');
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });

  await createClient({
    input: specPath,
    output: {
      path: srcDir,
      clean: true,
      entryFile: true,
      module: { extension: '.js' },
    },
    plugins: [
      {
        name: '@hey-api/client-axios',
        baseUrl: false,
        includeInEntry: true,
      },
    ],
  });
}

/** Compile a generated package's src/ to dist/ using the local tsc. */
function buildPackage(pkgDir) {
  const tscBin = join(ROOT, 'node_modules', '.bin', 'tsc');
  execFileSync(tscBin, ['-p', join(pkgDir, 'tsconfig.json')], { stdio: 'inherit' });
}

/** Generate a full npm package for a single spec. */
async function generatePackage(specPath) {
  const spec = readSpec(specPath);
  const info = spec?.info;

  if (!info?.title || !info?.version) {
    console.warn(`SKIP ${specPath}: missing info.title or info.version`);
    return null;
  }

  const name = derivePackageName(info.title);
  const version = normalizeVersion(info.version);
  const pkgDir = join(OUTPUT_DIR, name.replace(`${SCOPE}/`, ''));

  console.log(`\nGenerating ${name}@${version} from ${specPath}`);

  await generateClientSource(specPath, pkgDir);

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(buildPackageJson(name, version), null, 2) + '\n');
  writeFileSync(join(pkgDir, 'tsconfig.json'), JSON.stringify(buildTsconfig(), null, 2) + '\n');
  writeFileSync(join(pkgDir, 'README.md'), buildReadme(name, version));

  const manifest = {
    name,
    version,
    specPath: resolve(specPath),
    specHash: computeFileHash(specPath),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(pkgDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');

  buildPackage(pkgDir);

  return { name, version, pkgDir };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const specs = discoverSpecFiles(SPECS_DIR);
  if (specs.length === 0) {
    console.error(`No specs found in ${SPECS_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${specs.length} spec(s) in ${SPECS_DIR}`);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const results = [];
  for (const specPath of specs) {
    try {
      const result = await generatePackage(specPath);
      if (result) results.push(result);
    } catch (error) {
      console.error(`FAILED ${specPath}:`, error.message);
    }
  }

  console.log(`\nDone. Generated ${results.length} package(s) in ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
