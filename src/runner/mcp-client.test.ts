import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as child_process from 'node:child_process';
import * as dns from 'node:dns/promises';
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
    let lookupSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // Mock DNS lookup to return a public IP for api.example.com
      lookupSpy = spyOn(dns, 'lookup').mockResolvedValue([
        { address: '93.184.216.34', family: 4 }, // example.com's actual IP
      ] as any);
    });

    afterEach(() => {
      lookupSpy.mockRestore();
    });

    it('should connect and receive endpoint', async () => {
      let controller: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
          controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /endpoint\n\n'));
        },
      });

      const fetchMock = spyOn(global, 'fetch').mockImplementation((url) => {
        if (url === 'https://api.example.com/sse') {
          return Promise.resolve(new Response(stream));
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      });

      const clientPromise = MCPClient.createRemote('https://api.example.com/sse', {}, 60000, {});

      const client = await clientPromise;
      expect(client).toBeDefined();

      const initPromise = client.initialize();

      // Simulate message event (response from server)
      if (controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: 0,
              result: { protocolVersion: '2024-11-05' },
            })}\n\n`
          )
        );
      }

      const response = await initPromise;
      expect(response.result?.protocolVersion).toBe('2024-11-05');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/endpoint',
        expect.any(Object)
      );

      client.stop();
      fetchMock.mockRestore();
    });

    it('should handle SSE with multiple events and chunked data', async () => {
      let controller: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
          // Send endpoint event
          controller.enqueue(new TextEncoder().encode('event: endpoint\n'));
          controller.enqueue(new TextEncoder().encode('data: /endpoint\n\n'));
        },
      });

      const fetchMock = spyOn(global, 'fetch').mockImplementation((url) => {
        if (url === 'https://api.example.com/sse') {
          return Promise.resolve(new Response(stream));
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      });

      const client = await MCPClient.createRemote('https://api.example.com/sse', {}, 60000, {});

      // We can't easily hook into onMessage without reaching into internals
      // Instead, we'll test that initialize resolves correctly when the response arrives
      const initPromise = client.initialize();

      // Enqueue data in chunks
      if (controller) {
        controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":0,'));
        controller.enqueue(
          new TextEncoder().encode('"result":{"protocolVersion":"2024-11-05"}}\n\n')
        );

        // Send another event (just to test dispatching doesn't crash)
        controller.enqueue(
          new TextEncoder().encode(
            'event: message\ndata: {"jsonrpc":"2.0","id":99,"result":"ignored"}\n\n'
          )
        );

        // Send empty line
        controller.enqueue(new TextEncoder().encode('\n'));

        controller.close();
      }

      const response = await initPromise;
      expect(response.result?.protocolVersion).toBe('2024-11-05');

      client.stop();
      fetchMock.mockRestore();
    });

    it('should handle SSE connection failure', async () => {
      const fetchMock = spyOn(global, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response(null, {
            status: 500,
            statusText: 'Internal Server Error',
          })
        )
      );

      const clientPromise = MCPClient.createRemote('https://api.example.com/sse', {}, 60000, {});

      await expect(clientPromise).rejects.toThrow(/SSE connection failed: 500/);

      fetchMock.mockRestore();
    });
  });
});
