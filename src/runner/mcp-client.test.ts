import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { MCPClient } from './mcp-client';

interface MockProcess extends EventEmitter {
  stdout: Readable;
  stdin: Writable;
  kill: ReturnType<typeof mock>;
}

describe('MCPClient', () => {
  describe('Local Transport', () => {
    let mockProcess: MockProcess;
    let spawnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      const emitter = new EventEmitter();
      const stdout = new Readable({
        read() {},
      });
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const kill = mock(() => {});

      mockProcess = Object.assign(emitter, { stdout, stdin, kill }) as unknown as MockProcess;

      spawnSpy = spyOn(child_process, 'spawn').mockReturnValue(
        mockProcess as unknown as child_process.ChildProcess
      );
    });

    afterEach(() => {
      spawnSpy.mockRestore();
    });

    it('should initialize correctly', async () => {
      const client = await MCPClient.createLocal('node', ['server.js']);
      const initPromise = client.initialize();

      // Simulate server response
      mockProcess.stdout.push(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          result: { protocolVersion: '2024-11-05' },
        })}\n`
      );

      const response = await initPromise;
      expect(response.result?.protocolVersion).toBe('2024-11-05');
      expect(spawnSpy).toHaveBeenCalledWith('node', ['server.js'], expect.any(Object));
    });

    it('should list tools', async () => {
      const client = await MCPClient.createLocal('node');
      const listPromise = client.listTools();

      mockProcess.stdout.push(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          result: {
            tools: [{ name: 'test-tool', inputSchema: {} }],
          },
        })}\n`
      );

      const tools = await listPromise;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-tool');
    });

    it('should call tool', async () => {
      const client = await MCPClient.createLocal('node');
      const callPromise = client.callTool('my-tool', { arg: 1 });

      mockProcess.stdout.push(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          result: { content: [{ type: 'text', text: 'success' }] },
        })}\n`
      );

      const result = await callPromise;
      expect((result as { content: Array<{ text: string }> }).content[0].text).toBe('success');
    });

    it('should handle tool call error', async () => {
      const client = await MCPClient.createLocal('node');
      const callPromise = client.callTool('my-tool', {});

      mockProcess.stdout.push(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32000, message: 'Tool error' },
        })}\n`
      );

      await expect(callPromise).rejects.toThrow(/MCP tool call failed/);
    });

    it('should timeout on request', async () => {
      // Set a very short timeout for testing
      const client = await MCPClient.createLocal('node', [], {}, 10);
      const requestPromise = client.initialize();

      // Don't push any response to stdout
      await expect(requestPromise).rejects.toThrow(/MCP request timeout/);
    });

    it('should stop the process', async () => {
      const client = await MCPClient.createLocal('node');
      client.stop();
      expect(mockProcess.kill).toHaveBeenCalled();
    });
  });

  describe('SSE Transport', () => {
    it('should connect and receive endpoint', async () => {
      const mockEventSource = new EventEmitter();
      // @ts-ignore
      mockEventSource.addEventListener = mockEventSource.on;
      // @ts-ignore
      mockEventSource.close = mock(() => {});
      // @ts-ignore
      global.EventSource = mock(() => mockEventSource);

      const clientPromise = MCPClient.createRemote('http://localhost:8080/sse');

      // Simulate endpoint event
      mockEventSource.emit('endpoint', { data: '/endpoint' });

      const client = await clientPromise;
      expect(client).toBeDefined();

      // Test sending a message
      const fetchMock = spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true })))
      );

      const initPromise = client.initialize();

      // Simulate message event (response from server)
      mockEventSource.emit('message', {
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          result: { protocolVersion: '2024-11-05' },
        }),
      });

      const response = await initPromise;
      expect(response.result?.protocolVersion).toBe('2024-11-05');
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/endpoint', expect.any(Object));

      client.stop();
      // @ts-ignore
      expect(mockEventSource.close).toHaveBeenCalled();

      fetchMock.mockRestore();
      // @ts-ignore
      global.EventSource = undefined;
    });

    it('should handle SSE connection failure', async () => {
      const mockEventSource = {
        addEventListener: mock((_event: string, callback: (arg: unknown) => void) => {
          if (_event === 'error') {
            // Store the callback to trigger it later
            mockEventSource.onerror = callback;
          }
        }),
        onerror: null as ((arg: unknown) => void) | null,
        close: mock(() => {}),
      };

      // @ts-ignore
      global.EventSource = mock(() => mockEventSource);

      const clientPromise = MCPClient.createRemote('http://localhost:8080/sse');

      // Trigger the onerror callback
      if (mockEventSource.onerror) {
        mockEventSource.onerror({ message: 'Connection failed' });
      }

      await expect(clientPromise).rejects.toThrow(/SSE connection failed/);

      // @ts-ignore
      global.EventSource = undefined;
    });
  });
});
