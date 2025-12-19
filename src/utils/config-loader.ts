import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { type Config, ConfigSchema } from '../parser/config-schema';

export class ConfigLoader {
  private static instance: Config;

  static load(): Config {
    if (ConfigLoader.instance) return ConfigLoader.instance;

    const configPaths = [
      join(process.cwd(), '.keystone', 'config.yaml'),
      join(process.cwd(), '.keystone', 'config.yml'),
    ];

    let userConfig: Record<string, unknown> = {};

    for (const path of configPaths) {
      if (existsSync(path)) {
        try {
          let content = readFileSync(path, 'utf8');

          // Interpolate environment variables: ${VAR_NAME} or $VAR_NAME
          content = content.replace(
            /\${([^}]+)}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
            (_, group1, group2) => {
              const varName = group1 || group2;
              return process.env[varName] || '';
            }
          );

          userConfig = (yaml.load(content) as Record<string, unknown>) || {};
          break;
        } catch (error) {
          console.warn(`Warning: Failed to load config from ${path}:`, error);
        }
      }
    }

    const result = ConfigSchema.safeParse(userConfig);
    if (!result.success) {
      console.warn('Warning: Invalid configuration, using defaults:', result.error.message);
      ConfigLoader.instance = ConfigSchema.parse({});
    } else {
      ConfigLoader.instance = result.data;
    }

    return ConfigLoader.instance;
  }

  /**
   * For testing purposes, manually set the configuration
   */
  static setConfig(config: Config): void {
    ConfigLoader.instance = config;
  }

  /**
   * For testing purposes, clear the cached configuration
   */
  static clear(): void {
    // @ts-ignore - allowing clearing for tests
    ConfigLoader.instance = undefined;
  }

  static getProviderForModel(model: string): string {
    const config = ConfigLoader.load();

    // Check for provider prefix (e.g. "copilot:gpt-4o")
    if (model.includes(':')) {
      const [provider] = model.split(':');
      if (config.providers[provider]) {
        return provider;
      }
    }

    // Check explicit mappings first
    if (config.model_mappings[model]) {
      return config.model_mappings[model];
    }

    // Check glob-style mappings (very basic)
    for (const [pattern, provider] of Object.entries(config.model_mappings)) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (model.startsWith(prefix)) {
          return provider;
        }
      }
    }

    return config.default_provider;
  }
}
