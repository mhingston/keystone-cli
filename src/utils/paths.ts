import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
        const projectDir = this.getProjectDir();
        paths.push(join(projectDir, 'config.yaml'));
        paths.push(join(projectDir, 'config.yml'));

        // 3. User-level (XDG) config
        const userConfigDir = this.getUserConfigDir();
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
            return join(this.getUserDataDir(), 'state.db');
        }
        return join(this.getProjectDir(), 'state.db');
    }
}
