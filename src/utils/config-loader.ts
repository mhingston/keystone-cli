import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { type Config, ConfigSchema } from '../parser/config-schema';
import { PathResolver } from './paths';
import { ResourceLoader } from './resource-loader';

export class ConfigLoader {
  private static instance: Config;

  private static deepMerge(target: any, source: any): any {
    const output = { ...target };
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = ConfigLoader.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      }
    }
    return output;
  }

  static load(): Config {
    if (ConfigLoader.instance) return ConfigLoader.instance;

    const configPaths = PathResolver.getConfigPaths();
    let mergedConfig: Record<string, unknown> = {};

    // Load configurations in reverse precedence order (User -> Project -> Env)
    for (const path of [...configPaths].reverse()) {
      if (ResourceLoader.exists(path)) {
        try {
          let content = ResourceLoader.readFile(path);
          if (!content) continue;

          // Interpolate environment variables: ${VAR_NAME} or $VAR_NAME
          content = content.replace(
            /\${([^}]+)}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
            (_, group1, group2) => {
              const varName = group1 || group2;
              return process.env[varName] || '';
            }
          );

          const config = (yaml.load(content) as Record<string, unknown>) || {};
          mergedConfig = ConfigLoader.deepMerge(mergedConfig, config);
        } catch (error) {
          console.warn(`Warning: Failed to load config from ${path}:`, error);
        }
      }
    }

    const result = ConfigSchema.safeParse(mergedConfig);
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
