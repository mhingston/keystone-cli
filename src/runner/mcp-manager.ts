import { ConfigLoader } from '../utils/config-loader';
import { ConsoleLogger, type Logger } from '../utils/logger.ts';
import { MCPClient, validateRemoteUrl } from './mcp-client';

export type MCPClientFactory = Pick<typeof MCPClient, 'createLocal' | 'createRemote'>;

export interface MCPServerConfig {
  name: string;
  type?: 'local' | 'remote';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: {
    scope?: string;
  };
  timeout?: number;
}

export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();
  private connectionPromises: Map<string, Promise<MCPClient | undefined>> = new Map();
  private sharedServers: Map<string, MCPServerConfig> = new Map();
  private logger: Logger;
  private clientFactory: MCPClientFactory;

  constructor(logger?: Logger, clientFactory: MCPClientFactory = MCPClient) {
    this.logger = logger || new ConsoleLogger();
    this.clientFactory = clientFactory;
    this.loadGlobalConfig();

    // Ensure cleanup on process exit
    process.on('exit', () => {
      this.stopAll();
    });
  }

  private loadGlobalConfig() {
    const config = ConfigLoader.load();
    if (config.mcp_servers) {
      for (const [name, server] of Object.entries(config.mcp_servers)) {
        this.sharedServers.set(name, {
          name,
          ...server,
        } as MCPServerConfig);
      }
    }
  }

  async getClient(
    serverRef: string | MCPServerConfig,
    logger?: Logger
  ): Promise<MCPClient | undefined> {
    const activeLogger = logger || this.logger;
    let config: MCPServerConfig;

    if (typeof serverRef === 'string') {
      const shared = this.sharedServers.get(serverRef);
      if (!shared) {
        activeLogger.error(`  ✗ Global MCP server not found: ${serverRef}`);
        return undefined;
      }
      config = shared;
    } else {
      config = serverRef;
    }

    const key = this.getServerKey(config);

    // Check if we already have a client
    if (this.clients.has(key)) {
      return this.clients.get(key);
    }

    // Check if we are already connecting
    if (this.connectionPromises.has(key)) {
      return this.connectionPromises.get(key);
    }

    // Start a new connection and cache the promise
    const connectionPromise = (async () => {
      activeLogger.log(`  🔌 Connecting to MCP server: ${config.name} (${config.type || 'local'})`);

      let client: MCPClient;
      try {
          if (config.type === 'remote') {
            if (!config.url) throw new Error('Remote MCP server missing URL');

            // SSRF Protection: Validate URL before connecting
            await validateRemoteUrl(config.url);

          const headers = { ...(config.headers || {}) };

          if (config.oauth) {
            const { AuthManager } = await import('../utils/auth-manager');
            const auth = AuthManager.load();
            const token = auth.mcp_tokens?.[config.name]?.access_token;

            if (!token) {
              throw new Error(
                `MCP server ${config.name} requires OAuth. Please run "keystone mcp login ${config.name}" first.`
              );
            }

            headers.Authorization = `Bearer ${token}`;
          }

          client = await this.clientFactory.createRemote(config.url, headers, config.timeout, {
            logger: activeLogger,
          });
        } else {
          if (!config.command) throw new Error('Local MCP server missing command');

          const env = { ...(config.env || {}) };

          if (config.oauth) {
            const { AuthManager } = await import('../utils/auth-manager');
            const auth = AuthManager.load();
            const token = auth.mcp_tokens?.[config.name]?.access_token;

            if (!token) {
              throw new Error(
                `MCP server ${config.name} requires OAuth. Please run "keystone mcp login ${config.name}" first.`
              );
            }

            // Pass token to the local proxy via environment variables
            // Most proxies expect AUTHORIZATION or MCP_TOKEN
            env.AUTHORIZATION = `Bearer ${token}`;
            env.MCP_TOKEN = token;
          }

          client = await this.clientFactory.createLocal(
            config.command,
            config.args || [],
            env,
            config.timeout,
            activeLogger
          );
        }

        await client.initialize();
        this.clients.set(key, client);
        return client;
      } catch (error) {
        activeLogger.error(
          `  ✗ Failed to connect to MCP server ${config.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
      } finally {
        // Remove promise from cache once settled
        this.connectionPromises.delete(key);
      }
    })();

    this.connectionPromises.set(key, connectionPromise);
    return connectionPromise;
  }

  private getServerKey(config: MCPServerConfig): string {
    if (config.type === 'remote') {
      return `remote:${config.name}:${config.url}`;
    }
    return `local:${config.name}:${config.command}:${(config.args || []).join(' ')}`;
  }

  getGlobalServers(): MCPServerConfig[] {
    return Array.from(this.sharedServers.values());
  }

  async stopAll() {
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
  }
}
