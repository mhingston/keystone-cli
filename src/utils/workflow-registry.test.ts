import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../parser/config-schema.ts';
import { ConfigLoader } from './config-loader.ts';
import { WorkflowRegistry } from './workflow-registry.ts';

describe('WorkflowRegistry', () => {
  const tempWorkflowsDir = join(
    process.cwd(),
    `temp-workflows-${Math.random().toString(36).substring(7)}`
  );

  beforeAll(() => {
    try {
      mkdirSync(tempWorkflowsDir, { recursive: true });
    } catch (e) {
      // Ignore cleanup error
    }
  });

  afterAll(() => {
    try {
      rmSync(tempWorkflowsDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup error
    }
  });

  it('should list workflows in the workflows directory', () => {
    const keystoneWorkflowsDir = join(tempWorkflowsDir, '.keystone', 'workflows');
    mkdirSync(keystoneWorkflowsDir, { recursive: true });

    const workflowContent = `
name: registry-test
steps:
  - id: s1
    type: shell
    run: echo 1
`;
    const filePath = join(keystoneWorkflowsDir, 'registry-test.yaml');
    writeFileSync(filePath, workflowContent);

    // Mock homedir and cwd to use our temp dir
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(tempWorkflowsDir);
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(tempWorkflowsDir);

    try {
      const workflows = WorkflowRegistry.listWorkflows();
      const testWorkflow = workflows.find((w) => w.name === 'registry-test');
      expect(testWorkflow).toBeDefined();
      expect(testWorkflow?.name).toBe('registry-test');
    } finally {
      homedirSpy.mockRestore();
      cwdSpy.mockRestore();
    }
  });

  it('should resolve a workflow name to a path', () => {
    const keystoneWorkflowsDir = join(tempWorkflowsDir, '.keystone', 'workflows');
    mkdirSync(keystoneWorkflowsDir, { recursive: true });

    const fileName = 'resolve-test.yaml';
    const filePath = join(keystoneWorkflowsDir, fileName);
    writeFileSync(filePath, 'name: resolve-test\nsteps: []');

    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(tempWorkflowsDir);

    try {
      const resolved = WorkflowRegistry.resolvePath('resolve-test');
      expect(resolved.endsWith(fileName)).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('should resolve a workflow by internal name when filename differs', () => {
    const keystoneWorkflowsDir = join(tempWorkflowsDir, '.keystone', 'workflows');
    mkdirSync(keystoneWorkflowsDir, { recursive: true });

    const filePath = join(keystoneWorkflowsDir, 'alias.yaml');
    writeFileSync(filePath, 'name: internal-name\nsteps: []\n');

    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(tempWorkflowsDir);

    try {
      const resolved = WorkflowRegistry.resolvePath('internal-name');
      expect(resolved).toBe(filePath);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('should skip directories when scanning for workflow names', () => {
    const keystoneWorkflowsDir = join(tempWorkflowsDir, '.keystone', 'workflows');
    mkdirSync(keystoneWorkflowsDir, { recursive: true });

    const fakeDir = join(keystoneWorkflowsDir, 'folder.yaml');
    mkdirSync(fakeDir, { recursive: true });

    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(tempWorkflowsDir);

    try {
      expect(() => WorkflowRegistry.resolvePath('missing-name')).toThrow(
        /Workflow "missing-name" not found/
      );
    } finally {
      cwdSpy.mockRestore();
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('should resolve an absolute or relative path directly', () => {
    const filePath = join(tempWorkflowsDir, 'direct-path.yaml');
    writeFileSync(filePath, 'name: direct\nsteps: []');

    expect(WorkflowRegistry.resolvePath(filePath)).toBe(filePath);
    rmSync(filePath);
  });

  it('should look in the home directory .keystone folder', () => {
    const mockHome = join(tempWorkflowsDir, 'mock-home');
    const keystoneDir = join(mockHome, '.keystone', 'workflows');
    mkdirSync(keystoneDir, { recursive: true });

    const workflowPath = join(keystoneDir, 'home-test.yaml');
    writeFileSync(workflowPath, 'name: home-test\nsteps: []');

    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(mockHome);

    try {
      const resolved = WorkflowRegistry.resolvePath('home-test');
      expect(resolved).toBe(workflowPath);

      const workflows = WorkflowRegistry.listWorkflows();
      expect(workflows.some((w) => w.name === 'home-test')).toBe(true);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('should warn and continue when workflow directory cannot be read', () => {
    const baseDir = join(tempWorkflowsDir, 'bad-workflows-dir');
    const keystoneDir = join(baseDir, '.keystone');
    mkdirSync(keystoneDir, { recursive: true });
    writeFileSync(join(keystoneDir, 'workflows'), 'not-a-directory');

    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(baseDir);
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(baseDir);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const workflows = WorkflowRegistry.listWorkflows();
      expect(workflows).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      homedirSpy.mockRestore();
      cwdSpy.mockRestore();
    }
  });

  it('should throw if workflow not found', () => {
    expect(() => WorkflowRegistry.resolvePath('non-existent')).toThrow(
      /Workflow "non-existent" not found/
    );
  });
});
