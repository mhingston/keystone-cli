import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { parseAgent, resolveAgentPath } from './agent-parser';

describe('agent-parser', () => {
  // Use a unique temp directory with random suffix to prevent parallel test collisions
  const tempDir = join(process.cwd(), `temp-test-agents-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeAll(() => {
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) { }
  });

  describe('parseAgent', () => {
    it('should parse a valid agent markdown file', () => {
      const agentContent = `---
name: test-agent
description: A test agent
model: gpt-4
tools:
  - name: test-tool
    description: A test tool
    execution:
      type: shell
      run: echo "hello"
---
You are a test agent.
`;
      const filePath = join(tempDir, 'test-agent.md');
      writeFileSync(filePath, agentContent);

      const agent = parseAgent(filePath);
      expect(agent.name).toBe('test-agent');
      expect(agent.description).toBe('A test agent');
      expect(agent.model).toBe('gpt-4');
      expect(agent.tools).toHaveLength(1);
      expect(agent.tools[0].name).toBe('test-tool');
      expect(agent.tools[0].execution.id).toBe('tool-test-tool');
      expect(agent.systemPrompt).toBe('You are a test agent.');
    });

    it('should inject tool IDs if missing', () => {
      const agentContent = `---
name: test-agent
tools:
  - name: tool-without-id
    execution:
      type: shell
      run: ls
---
`;
      const filePath = join(tempDir, 'test-id-injection.md');
      writeFileSync(filePath, agentContent);

      const agent = parseAgent(filePath);
      expect(agent.tools[0].execution.id).toBe('tool-tool-without-id');
    });

    it('should parse single-line frontmatter', () => {
      const agentContent = '---name: single-line---\nPrompt';
      const filePath = join(tempDir, 'single-line.md');
      writeFileSync(filePath, agentContent);

      const agent = parseAgent(filePath);
      expect(agent.name).toBe('single-line');
      expect(agent.systemPrompt).toBe('Prompt');
    });

    it('should throw error for missing frontmatter', () => {
      const agentContent = 'Just some content without frontmatter';
      const filePath = join(tempDir, 'invalid-format.md');
      writeFileSync(filePath, agentContent);

      expect(() => parseAgent(filePath)).toThrow(/Missing frontmatter/);
    });

    it('should throw error for invalid schema', () => {
      const agentContent = `---
name: 123
---
Prompt`;
      const filePath = join(tempDir, 'invalid-schema.md');
      writeFileSync(filePath, agentContent);
      expect(() => parseAgent(filePath)).toThrow(/Invalid agent definition/);
    });
  });

  describe('resolveAgentPath', () => {
    it('should resolve agent path in .keystone/workflows/agents', () => {
      const agentsDir = join(process.cwd(), '.keystone', 'workflows', 'agents');
      try {
        mkdirSync(agentsDir, { recursive: true });
      } catch (e) { }

      const filePath = join(agentsDir, 'my-agent.md');
      writeFileSync(filePath, '---name: my-agent---');

      const resolved = resolveAgentPath('my-agent');
      expect(resolved).toBe(filePath);
    });

    it('should look in the home directory .keystone/workflows/agents folder', () => {
      const mockHome = join(tempDir, 'mock-home');
      const keystoneDir = join(mockHome, '.keystone', 'workflows', 'agents');
      mkdirSync(keystoneDir, { recursive: true });

      const agentPath = join(keystoneDir, 'home-agent.md');
      writeFileSync(agentPath, '---name: home-agent---');

      const homedirSpy = spyOn(os, 'homedir').mockReturnValue(mockHome);

      try {
        const resolved = resolveAgentPath('home-agent');
        expect(resolved).toBe(agentPath);
      } finally {
        homedirSpy.mockRestore();
      }
    });

    it('should throw error if agent not found', () => {
      expect(() => resolveAgentPath('non-existent-agent')).toThrow(
        /Agent "non-existent-agent" not found/
      );
    });
  });
});
