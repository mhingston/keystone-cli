import { type ChildProcess, spawn } from 'node:child_process';
import { type Interface, createInterface } from 'node:readline';
import pkg from '../../package.json' with { type: 'json' };

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface MCPResponse {
  id?: number;
  result?: {
    tools?: MCPTool[];
    content?: Array<{ type: string; text: string }>;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPTransport {
  send(message: unknown): Promise<void>;
  onMessage(callback: (message: MCPResponse) => void): void;
  close(): void;
}

class StdConfigTransport implements MCPTransport {
  private process: ChildProcess;
  private rl: Interface;

  constructor(command: string, args: string[] = [], env: Record<string, string> = {}) {
    this.process = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to start MCP server: stdio not available');
    }

    this.rl = createInterface({
      input: this.process.stdout,
    });
  }

  async send(message: unknown): Promise<void> {
    this.process.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(callback: (message: MCPResponse) => void): void {
    this.rl.on('line', (line) => {
      try {
        const response = JSON.parse(line) as MCPResponse;
        callback(response);
      } catch (e) {
        // Ignore non-JSON lines
      }
    });
  }

  close(): void {
    this.process.kill();
  }
}

class SSETransport implements MCPTransport {
  private url: string;
  private headers: Record<string, string>;
  private endpoint?: string;
  private onMessageCallback?: (message: MCPResponse) => void;
  private abortController: AbortController | null = null;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();

    return new Promise((resolve, reject) => {
      (async () => {
        try {
          const response = await fetch(this.url, {
            headers: {
              Accept: 'text/event-stream',
              ...this.headers,
            },
            signal: this.abortController?.signal,
          });

          if (!response.ok) {
            reject(new Error(`SSE connection failed: ${response.status} ${response.statusText}`));
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            reject(new Error('Failed to get response body reader'));
            return;
          }

          // Process the stream in the background
          (async () => {
            let buffer = '';
            const decoder = new TextDecoder();
            let currentEvent: { event?: string; data?: string } = {};

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split(/\r\n|\r|\n/);
                buffer = lines.pop() || '';

                for (const line of lines) {
                  if (line.trim() === '') {
                    // End of event - dispatch
                    if (currentEvent.data) {
                      if (currentEvent.event === 'endpoint') {
                        this.endpoint = currentEvent.data;
                        if (this.endpoint) {
                          this.endpoint = new URL(this.endpoint, this.url).href;
                        }
                        resolve();
                      } else if (
                        (!currentEvent.event || currentEvent.event === 'message') &&
                        this.onMessageCallback
                      ) {
                        try {
                          const message = JSON.parse(currentEvent.data) as MCPResponse;
                          this.onMessageCallback(message);
                        } catch (e) {
                          // Ignore parse errors
                        }
                      }
                    }
                    currentEvent = {};
                    continue;
                  }

                  if (line.startsWith('event:')) {
                    currentEvent.event = line.substring(6).trim();
                  } else if (line.startsWith('data:')) {
                    const data = line.substring(5).trim();
                    currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${data}` : data;
                  }
                }
              }
            } catch (err) {
              if ((err as Error).name !== 'AbortError') {
                // Only reject if we haven't resolved yet
                // Actually, if we are already resolved, we might want to log the error or handle reconnection
              }
            }
          })();
        } catch (err) {
          reject(err);
        }
      })();
    });
  }

  async send(message: unknown): Promise<void> {
    if (!this.endpoint) {
      throw new Error('SSE transport not connected or endpoint not received');
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to send message to MCP server: ${response.status} ${response.statusText}${
          text ? ` - ${text}` : ''
        }`
      );
    }
  }

  onMessage(callback: (message: MCPResponse) => void): void {
    this.onMessageCallback = callback;
  }

  close(): void {
    this.abortController?.abort();
  }
}

export class MCPClient {
  private transport: MCPTransport;
  private messageId = 0;
  private pendingRequests = new Map<number, (response: MCPResponse) => void>();
  private timeout: number;

  constructor(
    transportOrCommand: MCPTransport | string,
    timeoutOrArgs: number | string[] = [],
    env: Record<string, string> = {},
    timeout = 60000
  ) {
    if (typeof transportOrCommand === 'string') {
      this.transport = new StdConfigTransport(transportOrCommand, timeoutOrArgs as string[], env);
      this.timeout = timeout;
    } else {
      this.transport = transportOrCommand;
      this.timeout = (timeoutOrArgs as number) || 60000;
    }

    this.transport.onMessage((response) => {
      if (response.id !== undefined && this.pendingRequests.has(response.id)) {
        const resolve = this.pendingRequests.get(response.id);
        if (resolve) {
          this.pendingRequests.delete(response.id);
          resolve(response);
        }
      }
    });
  }

  static async createLocal(
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
    timeout = 60000
  ): Promise<MCPClient> {
    const transport = new StdConfigTransport(command, args, env);
    return new MCPClient(transport, timeout);
  }

  static async createRemote(
    url: string,
    headers: Record<string, string> = {},
    timeout = 60000
  ): Promise<MCPClient> {
    const transport = new SSETransport(url, headers);
    await transport.connect();
    return new MCPClient(transport, timeout);
  }

  private async request(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<MCPResponse> {
    const id = this.messageId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, resolve);
      this.transport.send(message).catch((err) => {
        this.pendingRequests.delete(id);
        reject(err);
      });

      // Add a timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, this.timeout);
    });
  }

  async initialize() {
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'keystone-cli',
        version: pkg.version,
      },
    });
  }

  async listTools(): Promise<MCPTool[]> {
    const response = await this.request('tools/list');
    return response.result?.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.request('tools/call', {
      name,
      arguments: args,
    });
    if (response.error) {
      throw new Error(`MCP tool call failed: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  stop() {
    this.transport.close();
  }
}
