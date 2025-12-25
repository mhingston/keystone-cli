import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PathResolver } from './paths';

describe('PathResolver', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('should return correct project directory', () => {
        expect(PathResolver.getProjectDir()).toBe(join(process.cwd(), '.keystone'));
    });

    it('should respect XDG_CONFIG_HOME', () => {
        process.env.XDG_CONFIG_HOME = '/custom/config';
        expect(PathResolver.getUserConfigDir()).toBe('/custom/config/keystone');
    });

    it('should fallback to ~/.config if XDG_CONFIG_HOME is not set', () => {
        delete process.env.XDG_CONFIG_HOME;
        expect(PathResolver.getUserConfigDir()).toBe(join(homedir(), '.config', 'keystone'));
    });

    it('should respect XDG_DATA_HOME', () => {
        process.env.XDG_DATA_HOME = '/custom/data';
        expect(PathResolver.getUserDataDir()).toBe('/custom/data/keystone');
    });

    it('should respect KEYSTONE_CONFIG environment variable', () => {
        process.env.KEYSTONE_CONFIG = '/absolute/path/to/config.yaml';
        const paths = PathResolver.getConfigPaths();
        expect(paths[0]).toBe('/absolute/path/to/config.yaml');
    });

    it('should resolve database path correctly', () => {
        expect(PathResolver.resolveDbPath(false)).toBe(join(process.cwd(), '.keystone', 'state.db'));
        expect(PathResolver.resolveDbPath(true)).toBe(join(PathResolver.getUserDataDir(), 'state.db'));
    });
});
