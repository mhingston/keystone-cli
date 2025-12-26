import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bundleAssets } from './assets.macro.ts' with { type: 'macro' };

// These are bundled at build-time (macro). If macros are unavailable at runtime,
// fall back to an empty set so local filesystem reads still work.
const EMBEDDED_ASSETS = (() => {
  try {
    return bundleAssets();
  } catch (e) {
    console.warn(
      'ResourceLoader: bundleAssets() failed to load embedded assets. Falling back to local filesystem.',
      e instanceof Error ? e.message : String(e)
    );
    return {};
  }
})();

export class ResourceLoader {
  /**
   * Reads a file.
   * Priority:
   * 1. Local file system (if it exists)
   * 2. Embedded assets
   */
  static readFile(path: string): string | null {
    // 1. Check local file system first
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        // File exists but cannot be read (permissions, etc.) - fall back to embedded assets
      }
    }

    // 2. Check embedded assets
    // The path passed might be absolute or relative to CWD.
    // We need to check if it matches an embedded asset key.
    // Usually, embedded assets are relative to the .keystone directory.

    // Normalize path to check against embedded assets
    const projectRelPath = ResourceLoader.getProjectRelativePath(path);
    if (projectRelPath && EMBEDDED_ASSETS[projectRelPath]) {
      return EMBEDDED_ASSETS[projectRelPath];
    }

    return null;
  }

  /**
   * Check if a file or directory exists.
   */
  static exists(path: string): boolean {
    if (existsSync(path)) return true;

    const projectRelPath = ResourceLoader.getProjectRelativePath(path);
    if (projectRelPath) {
      // Check if it's a file
      if (EMBEDDED_ASSETS[projectRelPath]) return true;

      // Check if it's a directory (prefix match)
      const dirPrefix = projectRelPath.endsWith('/') ? projectRelPath : `${projectRelPath}/`;
      return Object.keys(EMBEDDED_ASSETS).some((key) => key.startsWith(dirPrefix));
    }

    return false;
  }

  /**
   * List files in a directory.
   */
  static listDirectory(dirPath: string): string[] {
    const files = new Set<string>();

    // 1. Add local files
    if (existsSync(dirPath)) {
      try {
        if (statSync(dirPath).isDirectory()) {
          for (const file of readdirSync(dirPath)) {
            files.add(file);
          }
        }
      } catch {
        // Directory cannot be read (permissions, etc.) - continue with embedded assets only
      }
    }

    // 2. Add embedded files
    const projectRelPath = ResourceLoader.getProjectRelativePath(dirPath);
    if (projectRelPath) {
      const dirPrefix =
        projectRelPath === ''
          ? ''
          : projectRelPath.endsWith('/')
            ? projectRelPath
            : `${projectRelPath}/`;
      for (const key of Object.keys(EMBEDDED_ASSETS)) {
        if (key.startsWith(dirPrefix)) {
          const relativeToDir = key.slice(dirPrefix.length);
          const firstPart = relativeToDir.split('/')[0];
          if (firstPart) {
            files.add(firstPart);
          }
        }
      }
    }

    return Array.from(files);
  }

  /**
   * Get stats for a path.
   */
  static isDirectory(path: string): boolean {
    if (existsSync(path)) {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    }

    const projectRelPath = ResourceLoader.getProjectRelativePath(path);
    if (projectRelPath) {
      // If it exists in embedded assets as a key, it's a file.
      if (EMBEDDED_ASSETS[projectRelPath]) return false;

      // If it's a prefix of any key, it's a directory.
      const dirPrefix = projectRelPath.endsWith('/') ? projectRelPath : `${projectRelPath}/`;
      return Object.keys(EMBEDDED_ASSETS).some((key) => key.startsWith(dirPrefix));
    }

    return false;
  }

  private static getProjectRelativePath(path: string): string | null {
    const cwd = process.cwd();
    const keystoneDir = join(cwd, '.keystone');

    if (path.startsWith(keystoneDir)) {
      return path.slice(keystoneDir.length + 1);
    }

    // If it's already relative and starts with .keystone
    if (path.startsWith('.keystone/')) {
      return path.slice(10);
    }

    if (path === '.keystone') {
      return '';
    }

    return null;
  }

  /**
   * Get all embedded assets for debugging/manifest
   */
  static getEmbeddedAssets(): Record<string, string> {
    return EMBEDDED_ASSETS;
  }
}
