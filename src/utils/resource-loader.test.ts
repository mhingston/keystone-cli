import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ResourceLoader } from './resource-loader';

describe('ResourceLoader', () => {
    const testDir = join(process.cwd(), 'temp_test_project');
    const keystoneDir = join(testDir, '.keystone');
    const workflowDir = join(keystoneDir, 'workflows');
    const testFile = join(workflowDir, 'test.yaml');

    beforeAll(() => {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
        mkdirSync(workflowDir, { recursive: true });
        writeFileSync(testFile, 'name: test-workflow');
    });

    afterAll(() => {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    test('should read local file if it exists', () => {
        const content = ResourceLoader.readFile(testFile);
        expect(content).toBe('name: test-workflow');
    });

    test('exists() should return true for local files', () => {
        expect(ResourceLoader.exists(testFile)).toBe(true);
        expect(ResourceLoader.exists(workflowDir)).toBe(true);
    });

    test('listDirectory() should include local files', () => {
        const files = ResourceLoader.listDirectory(workflowDir);
        expect(files).toContain('test.yaml');
    });

    test('isDirectory() should work for local paths', () => {
        expect(ResourceLoader.isDirectory(workflowDir)).toBe(true);
        expect(ResourceLoader.isDirectory(testFile)).toBe(false);
    });

    test('should have embedded assets from repo during tests', () => {
        const assets = ResourceLoader.getEmbeddedAssets();
        const keys = Object.keys(assets);
        // We expect at least the default seeded workflows if they exist in .keystone
        expect(keys.length).toBeGreaterThan(0);

        // Check for a common seeded workflow if it exists
        const hasScaffold = keys.some(k => k.includes('scaffold-feature.yaml'));
        if (hasScaffold) {
            expect(hasScaffold).toBe(true);
        }
    });
});
