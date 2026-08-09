import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Compute a stable sha256 hex digest of a file's contents.
 * Used to detect whether an OpenAPI spec changed between runs.
 */
export function computeFileHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}