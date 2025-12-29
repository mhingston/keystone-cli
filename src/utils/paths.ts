import { homedir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';

export class PathResolver {
  /**
   * Get the project-local .keystone directory
   */
  static getProjectDir(): string {
    return resolve(process.cwd(), '.keystone');
  }

  /**
   * Get the XDG config directory for Keystone
   * Priority: $XDG_CONFIG_HOME/keystone or ~/.config/keystone
   */
  static getUserConfigDir(): string {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    if (xdgConfigHome) {
      return join(xdgConfigHome, 'keystone');
    }
    return join(homedir(), '.config', 'keystone');
  }

  /**
   * Get the XDG data directory for Keystone
   * Priority: $XDG_DATA_HOME/keystone or ~/.local/share/keystone
   */
  static getUserDataDir(): string {
    const xdgDataHome = process.env.XDG_DATA_HOME;
    if (xdgDataHome) {
      return join(xdgDataHome, 'keystone');
    }
    return join(homedir(), '.local', 'share', 'keystone');
  }

  /**
   * Get potential configuration file paths in order of precedence
   */
  static getConfigPaths(): string[] {
    const paths: string[] = [];

    // 1. KEYSTONE_CONFIG environment variable
    if (process.env.KEYSTONE_CONFIG) {
      paths.push(resolve(process.env.KEYSTONE_CONFIG));
    }

    // 2. Project-local config
    const projectDir = PathResolver.getProjectDir();
    paths.push(join(projectDir, 'config.yaml'));
    paths.push(join(projectDir, 'config.yml'));

    // 3. User-level (XDG) config
    const userConfigDir = PathResolver.getUserConfigDir();
    paths.push(join(userConfigDir, 'config.yaml'));
    paths.push(join(userConfigDir, 'config.yml'));

    return paths;
  }

  /**
   * Get the database path for a given run
   * Defaults to project-local state, but can be global if configured
   */
  static resolveDbPath(isGlobal = false): string {
    if (isGlobal) {
      return join(PathResolver.getUserDataDir(), 'state.db');
    }
    return join(PathResolver.getProjectDir(), 'state.db');
  }

  /**
   * Normalize a path by trimming whitespace and defaulting to '.' if empty
   */
  static normalizePath(rawPath: string): string {
    const trimmed = rawPath.trim();
    return trimmed.length > 0 ? trimmed : '.';
  }

  /**
   * Assert that a path is within the current working directory
   * @throws Error if path is outside CWD and allowOutsideCwd is false
   */
  static assertWithinCwd(
    targetPath: string,
    allowOutsideCwd?: boolean,
    label = 'Path'
  ): void {
    if (allowOutsideCwd) return;
    const cwd = process.cwd();
    const realCwd = realpathSync(cwd);
    const normalizedPath = PathResolver.normalizePath(targetPath);
    const resolvedPath = resolve(cwd, normalizedPath);

    // Iterate up the directory tree until we find an existing directory
    let current = resolvedPath;
    while (true) {
      try {
        const real = realpathSync(current);
        if (real !== realCwd && !real.startsWith(realCwd + sep)) {
          throw new Error(
            `${label} "${targetPath}" is outside the project directory. ` +
            `Use 'allowOutsideCwd: true' if this is intended.`
          );
        }
        break; // Successfully validated against an existing ancestor
      } catch (e: any) {
        if (e.message?.includes('outside the project directory')) {
          throw e;
        }

        const parent = join(current, '..');
        if (parent === current) {
          // We reached the root and still couldn't validate
          throw new Error(
            `${label} "${targetPath}" is outside the project directory. ` +
            `Use 'allowOutsideCwd: true' if this is intended.`
          );
        }
        current = parent;
      }
    }
  }
}
