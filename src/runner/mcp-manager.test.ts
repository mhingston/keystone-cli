import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { ConfigLoader } from '../utils/config-loader';
import type { MCPClient } from './mcp-client';
import { type MCPClientFactory, MCPManager } from './mcp-manager';

import type { Config } from '../parser/config-schema';

describe('MCPManager', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  const createMockClient = (initializeImpl?: () => Promise<unknown>) => {
    const initialize = mock(
      initializeImpl ||
        (async () => ({
          result: { protocolVersion: '1.0' },
          jsonrpc: '2.0',
          id: 0,
        }))
    );
    const stop = mock(() => undefined);
    const client = { initialize, stop } as unknown as MCPClient;
    return { client, initialize, stop };
  };

  const createMockFactory = (client: MCPClient): MCPClientFactory => ({
    createLocal: mock(async () => client),
    createRemote: mock(async () => client),
  });

  beforeEach(() => {
    ConfigLoader.clear();

    const mockProcess = Object.assign(new EventEmitter(), {
      stdout: new Readable({ read() {} }),
      stdin: new Writable({
        write(_chunk, _encoding, cb: (error?: Error | null) => void) {
          cb();
        },
      }),
      kill: mock(() => {}),
    });
    spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(
      mockProcess as unknown as child_process.ChildProcess
    );
  });

  afterEach(() => {
    ConfigLoader.clear();
    spawnSpy.mockRestore();
  });

  it('should load global config on initialization', () => {
    ConfigLoader.setConfig({
      mcp_servers: {
        'test-server': {
          type: 'local',
          command: 'node',
          args: ['test.js'],
          env: { FOO: 'bar' },
        },
      },
      providers: {},
      model_mappings: {},
      default_provider: 'openai',
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    } as unknown as Config);

    const manager = new MCPManager();
    const servers = manager.getGlobalServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('test-server');
    expect(servers[0].command).toBe('node');
  });

  it('should get client for global server', async () => {
    ConfigLoader.setConfig({
      mcp_servers: {
        'test-server': {
          type: 'local',
          command: 'node',
        },
      },
      providers: {},
      model_mappings: {},
      default_provider: 'openai',
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    } as unknown as Config);

    const { client: mockClient, initialize, stop } = createMockClient();
    const clientFactory = createMockFactory(mockClient);
    const manager = new MCPManager(undefined, clientFactory);
    const client = await manager.getClient('test-server');

    expect(client).toBeDefined();
    expect(initialize).toHaveBeenCalled();

    // Should reuse client
    const client2 = await manager.getClient('test-server');
    expect(client2).toBe(client);
    expect(initialize).toHaveBeenCalledTimes(1);

    await manager.stopAll();
    expect(stop).toHaveBeenCalled();
  });

  it('should get client for ad-hoc server config', async () => {
    const { client: mockClient, initialize } = createMockClient();
    const clientFactory = createMockFactory(mockClient);
    const manager = new MCPManager(undefined, clientFactory);
    const client = await manager.getClient({
      name: 'adhoc',
      type: 'local',
      command: 'node',
    });

    expect(client).toBeDefined();
    expect(initialize).toHaveBeenCalled();
  });

  it('should return undefined if global server not found', async () => {
    const manager = new MCPManager();
    const client = await manager.getClient('non-existent');
    expect(client).toBeUndefined();
  });

  it('should handle concurrent connection requests without double-spawning', async () => {
    ConfigLoader.setConfig({
      mcp_servers: {
        'concurrent-server': {
          type: 'local',
          command: 'node',
        },
      },
      providers: {},
      model_mappings: {},
      default_provider: 'openai',
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    } as unknown as Config);

    // Mock initialize to take some time
    let initCalls = 0;
    const { client: mockClient, initialize } = createMockClient(async () => {
      initCalls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        result: { protocolVersion: '1.0' },
        jsonrpc: '2.0',
        id: 0,
      };
    });
    const clientFactory = createMockFactory(mockClient);
    const manager = new MCPManager(undefined, clientFactory);

    // Fire off multiple requests concurrently
    const p1 = manager.getClient('concurrent-server');
    const p2 = manager.getClient('concurrent-server');
    const p3 = manager.getClient('concurrent-server');

    const [c1, c2, c3] = await Promise.all([p1, p2, p3]);

    expect(c1).toBeDefined();
    expect(c1).toBe(c2);
    expect(c1).toBe(c3);
    expect(initCalls).toBe(1); // Crucial: only one initialization
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('should handle connection failure', async () => {
    ConfigLoader.setConfig({
      mcp_servers: {
        'fail-server': {
          type: 'local',
          command: 'fail',
        },
      },
      providers: {},
      model_mappings: {},
      default_provider: 'openai',
      storage: { retention_days: 30, redact_secrets_at_rest: true },
      engines: { allowlist: {}, denylist: [] },
      concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
    } as unknown as Config);

    const { client: mockClient } = createMockClient(async () => {
      throw new Error('Connection failed');
    });
    const clientFactory = createMockFactory(mockClient);
    const manager = new MCPManager(undefined, clientFactory);
    const client = await manager.getClient('fail-server');

    expect(client).toBeUndefined();
  });
});
