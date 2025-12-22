import { type ChildProcess, spawn } from 'node:child_process';
import { type Interface, createInterface } from 'node:readline';
import pkg from '../../package.json' with { type: 'json' };

// MCP Protocol version - update when upgrading to newer MCP spec
export const MCP_PROTOCOL_VERSION = '2024-11-05';

// Maximum buffer size for incoming messages (10MB) to prevent memory exhaustion
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

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
    // Filter out sensitive environment variables from the host process
    // unless they are explicitly provided in the 'env' argument
    const safeEnv: Record<string, string> = {};
    const sensitivePattern = /(?:key|token|secret|password|credential|auth|private)/i;

    for (const [key, value] of Object.entries(process.env)) {
      if (value && !sensitivePattern.test(key)) {
        safeEnv[key] = value;
      }
    }

    this.process = spawn(command, args, {
      env: { ...safeEnv, ...env },
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
      // Safety check for extremely long lines that might have bypassed readline's internal limits
      if (line.length > MAX_BUFFER_SIZE) {
        process.stderr.write(
          `[MCP Error] Received line exceeding maximum size (${line.length} bytes), ignoring.\n`
        );
        return;
      }

      try {
        const response = JSON.parse(line) as MCPResponse;
        callback(response);
      } catch (e) {
        // Log non-JSON lines to stderr so they show up in the terminal
        if (line.trim()) {
          process.stderr.write(`[MCP Server Output] ${line}\n`);
        }
      }
    });
  }

  close(): void {
    this.rl.close();
    this.process.kill();
  }
}

class SSETransport implements MCPTransport {
  private url: string;
  private headers: Record<string, string>;
  private endpoint?: string;
  private onMessageCallback?: (message: MCPResponse) => void;
  private abortController: AbortController | null = null;
  private sessionId?: string;
  private activeReaders: Set<ReadableStreamDefaultReader<Uint8Array>> = new Set();

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  async connect(timeout = 60000): Promise<void> {
    this.abortController = new AbortController();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.close();
        reject(new Error(`SSE connection timeout: ${this.url}`));
      }, timeout);

      (async () => {
        try {
          let response = await fetch(this.url, {
            headers: {
              Accept: 'application/json, text/event-stream',
              ...this.headers,
            },
            signal: this.abortController?.signal,
          });

          if (response.status === 405) {
            // Some MCP servers (like GitHub) require POST to start a session
            response = await fetch(this.url, {
              method: 'POST',
              headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
                ...this.headers,
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'ping',
                method: 'ping',
              }),
              signal: this.abortController?.signal,
            });
          }

          if (!response.ok) {
            clearTimeout(timeoutId);
            reject(new Error(`SSE connection failed: ${response.status} ${response.statusText}`));
            return;
          }

          // Check for session ID in headers
          this.sessionId =
            response.headers.get('mcp-session-id') ||
            response.headers.get('Mcp-Session-Id') ||
            undefined;

          const reader = response.body?.getReader();
          if (!reader) {
            clearTimeout(timeoutId);
            reject(new Error('Failed to get response body reader'));
            return;
          }

          // Track reader for cleanup
          this.activeReaders.add(reader);

          // Process the stream in the background
          (async () => {
            let buffer = '';
            const decoder = new TextDecoder();
            let currentEvent: { event?: string; data?: string } = {};
            let isResolved = false;

            const dispatchEvent = () => {
              if (currentEvent.data) {
                if (currentEvent.event === 'endpoint') {
                  this.endpoint = currentEvent.data;
                  if (this.endpoint) {
                    this.endpoint = new URL(this.endpoint, this.url).href;
                  }
                  if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeoutId);
                    resolve();
                  }
                } else if (!currentEvent.event || currentEvent.event === 'message') {
                  // If we get a message before an endpoint, verify it's a valid JSON-RPC message
                  // before assuming the URL itself is the endpoint.
                  // (Common in some MCP over SSE implementations like GitHub's)
                  if (!this.endpoint) {
                    try {
                      const msg = JSON.parse(currentEvent.data || '{}');
                      if (
                        msg &&
                        typeof msg === 'object' &&
                        (msg.jsonrpc === '2.0' || msg.id !== undefined)
                      ) {
                        this.endpoint = this.url;
                        if (!isResolved) {
                          isResolved = true;
                          clearTimeout(timeoutId);
                          resolve();
                        }
                      }
                    } catch (e) {
                      // Not a valid JSON message, ignore for endpoint discovery
                    }
                  }

                  if (this.onMessageCallback && currentEvent.data) {
                    try {
                      const message = JSON.parse(currentEvent.data) as MCPResponse;
                      this.onMessageCallback(message);
                    } catch (e) {
                      // Ignore parse errors
                    }
                  }
                }
              }
              currentEvent = {};
            };

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  // Dispatch any remaining data
                  dispatchEvent();
                  break;
                }

                const decoded = decoder.decode(value, { stream: true });
                if (buffer.length + decoded.length > MAX_BUFFER_SIZE) {
                  throw new Error(`SSE buffer size limit exceeded (${MAX_BUFFER_SIZE} bytes)`);
                }
                buffer += decoded;

                const lines = buffer.split(/\r\n|\r|\n/);
                buffer = lines.pop() || '';

                for (const line of lines) {
                  if (line.trim() === '') {
                    dispatchEvent();
                    continue;
                  }

                  if (line.startsWith('event:')) {
                    currentEvent.event = line.substring(6).trim();
                  } else if (line.startsWith('data:')) {
                    const data = line.substring(5).trim();
                    if (
                      currentEvent.data &&
                      currentEvent.data.length + data.length > MAX_BUFFER_SIZE
                    ) {
                      throw new Error(`SSE data size limit exceeded (${MAX_BUFFER_SIZE} bytes)`);
                    }
                    currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${data}` : data;
                  }
                }
              }

              if (!isResolved) {
                // If the stream ended before we resolved, but we have a session ID, we can try to resolve
                if (this.sessionId && !this.endpoint) {
                  this.endpoint = this.url;
                  isResolved = true;
                  clearTimeout(timeoutId);
                  resolve();
                } else {
                  clearTimeout(timeoutId);
                  reject(new Error('SSE stream ended before connection established'));
                }
              }
            } catch (err) {
              if ((err as Error).name !== 'AbortError' && !isResolved) {
                clearTimeout(timeoutId);
                reject(err);
              }
            } finally {
              this.activeReaders.delete(reader);
            }
          })();
        } catch (err) {
          clearTimeout(timeoutId);
          reject(err);
        }
      })();
    });
  }

  async send(message: unknown): Promise<void> {
    if (!this.endpoint) {
      throw new Error('SSE transport not connected or endpoint not received');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
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

    // Some MCP servers (like GitHub) send the response directly in the POST response as SSE
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/event-stream')) {
      const reader = response.body?.getReader();
      if (reader) {
        // Track reader for cleanup
        this.activeReaders.add(reader);
        (async () => {
          let buffer = '';
          const decoder = new TextDecoder();
          let currentEvent: { event?: string; data?: string } = {};

          const dispatchEvent = () => {
            if (
              this.onMessageCallback &&
              currentEvent.data &&
              (!currentEvent.event || currentEvent.event === 'message')
            ) {
              try {
                const message = JSON.parse(currentEvent.data) as MCPResponse;
                this.onMessageCallback(message);
              } catch (e) {
                // Ignore parse errors
              }
            }
            currentEvent = {};
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                dispatchEvent();
                break;
              }

              const decoded = decoder.decode(value, { stream: true });
              if (buffer.length + decoded.length > MAX_BUFFER_SIZE) {
                throw new Error(`SSE buffer size limit exceeded (${MAX_BUFFER_SIZE} bytes)`);
              }
              buffer += decoded;

              const lines = buffer.split(/\r\n|\r|\n/);
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.trim() === '') {
                  dispatchEvent();
                  continue;
                }

                if (line.startsWith('event:')) {
                  currentEvent.event = line.substring(6).trim();
                } else if (line.startsWith('data:')) {
                  const data = line.substring(5).trim();
                  if (
                    currentEvent.data &&
                    currentEvent.data.length + data.length > MAX_BUFFER_SIZE
                  ) {
                    throw new Error(`SSE data size limit exceeded (${MAX_BUFFER_SIZE} bytes)`);
                  }
                  currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${data}` : data;
                }
              }
            }
          } catch (e) {
            // Ignore stream errors
          } finally {
            this.activeReaders.delete(reader);
          }
        })();
      }
    }
  }

  onMessage(callback: (message: MCPResponse) => void): void {
    this.onMessageCallback = callback;
  }

  close(): void {
    // Cancel all active readers to prevent memory leaks
    for (const reader of this.activeReaders) {
      reader.cancel().catch(() => {});
    }
    this.activeReaders.clear();
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
      this.timeout = timeoutOrArgs as number;
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
    await transport.connect(timeout);
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
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, this.timeout);

      this.pendingRequests.set(id, (response) => {
        clearTimeout(timeoutId);
        resolve(response);
      });

      this.transport.send(message).catch((err) => {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  async initialize() {
    return this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
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
    // Reject all pending requests to prevent hanging callers
    for (const [id, resolve] of this.pendingRequests) {
      resolve({ id, error: { code: -1, message: 'MCP client stopped' } });
    }
    this.pendingRequests.clear();
    this.transport.close();
  }
}
