import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Bun macro to read all files in a directory and return them as a map.
 * This runs at build-time.
 */
export function bundleAssets(): Record<string, string> {
  const dirPath = process.env.ASSETS_DIR || '.keystone';
  const assets: Record<string, string> = {};

  if (!existsSync(dirPath)) {
    // If directory doesn't exist, return empty (e.g. during dev of CLI itself)
    return {};
  }

  function walk(currentDir: string) {
    const files = readdirSync(currentDir);
    for (const file of files) {
      const fullPath = join(currentDir, file);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
      } else if (stats.isFile()) {
        // Use relative path as key
        const relPath = relative(dirPath, fullPath);
        assets[relPath] = readFileSync(fullPath, 'utf8');
      }
    }
  }

  walk(dirPath);

  return assets;
}
