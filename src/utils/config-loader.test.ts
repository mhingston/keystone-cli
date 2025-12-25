import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../parser/config-schema';
import { ConfigLoader } from './config-loader';

describe('ConfigLoader', () => {
  afterEach(() => {
    ConfigLoader.clear();
  });

  it('should allow setting and clearing config', () => {
    const mockConfig: Config = {
      default_provider: 'test',
      providers: {
        test: { type: 'openai' },
      },
      model_mappings: {},
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      mcp_servers: {},
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    };

    ConfigLoader.setConfig(mockConfig);
    expect(ConfigLoader.load()).toEqual(mockConfig);

    ConfigLoader.clear();
    // After clear, it will try to load from disk or use defaults
    const loaded = ConfigLoader.load();
    expect(loaded).not.toEqual(mockConfig);
  });

  it('should return correct provider for model', () => {
    const mockConfig: Config = {
      default_provider: 'openai',
      providers: {
        openai: { type: 'openai' },
        anthropic: { type: 'anthropic' },
        copilot: { type: 'copilot' },
      },
      model_mappings: {
        'gpt-*': 'copilot',
        'claude-v1': 'anthropic',
      },
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      mcp_servers: {},
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    };
    ConfigLoader.setConfig(mockConfig);

    expect(ConfigLoader.getProviderForModel('gpt-4')).toBe('copilot');
    expect(ConfigLoader.getProviderForModel('claude-v1')).toBe('anthropic');
    expect(ConfigLoader.getProviderForModel('unknown')).toBe('openai');
    expect(ConfigLoader.getProviderForModel('anthropic:claude-3')).toBe('anthropic');
  });

  it('should interpolate environment variables in config', () => {
    const originalCwd = process.cwd();
    const tempDir = mkdtempSync(join(originalCwd, 'temp-config-'));
    const keystoneDir = join(tempDir, '.keystone');
    mkdirSync(keystoneDir, { recursive: true });

    process.env.TEST_PROVIDER = 'interpolated-provider';
    process.env.TEST_MODEL = 'interpolated-model';

    const configPath = join(keystoneDir, 'config.yaml');
    writeFileSync(
      configPath,
      'default_provider: ${TEST_PROVIDER}\n' + 'default_model: $TEST_MODEL\n'
    );

    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(tempDir);

    try {
      ConfigLoader.clear();
      const config = ConfigLoader.load();
      expect(config.default_provider).toBe('interpolated-provider');
      expect(config.default_model).toBe('interpolated-model');
    } finally {
      cwdSpy.mockRestore();
      process.env.TEST_PROVIDER = undefined;
      process.env.TEST_MODEL = undefined;
      rmSync(tempDir, { recursive: true, force: true });
      ConfigLoader.clear();
    }
  });
});
