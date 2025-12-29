import { type ChildProcess, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type Interface, createInterface } from 'node:readline';
import pkg from '../../package.json' with { type: 'json' };
import { MCP, TIMEOUTS } from '../utils/constants.ts';
import { ConsoleLogger, type Logger } from '../utils/logger.ts';

// Re-export for backwards compatibility
export const MCP_PROTOCOL_VERSION = MCP.PROTOCOL_VERSION;

// Maximum buffer size for incoming messages (10MB) to prevent memory exhaustion
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Efficient line splitting without regex to prevent ReDoS attacks.
 * Handles \r\n, \r, and \n line endings.
 */
function splitLines(str: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\n') {
      lines.push(str.substring(start, i));
      start = i + 1;
    } else if (str[i] === '\r') {
      lines.push(str.substring(start, i));
      // Skip \n if this is a \r\n sequence
      if (str[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  // Return remaining content as incomplete line (will be buffered)
  lines.push(str.substring(start));
  return lines;
}

/**
 * Validate a URL to prevent SSRF attacks
 * Blocks private IP ranges, localhost, and other internal addresses
 * @param url The URL to validate
 * @param options.allowInsecure If true, skips all security checks (use only for development/testing)
 * @throws Error if the URL is potentially dangerous
 */
function isPrivateIpAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const parseMappedIpv4 = (mapped: string): string | null => {
    const rest = mapped.replace(/^::ffff:/i, '');
    if (rest.includes('.')) {
      return rest;
    }
    const parts = rest.split(':');
    if (parts.length !== 2) {
      return null;
    }
    const high = Number.parseInt(parts[0], 16);
    const low = Number.parseInt(parts[1], 16);
    if (Number.isNaN(high) || Number.isNaN(low)) {
      return null;
    }
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    return `${a}.${b}.${c}.${d}`;
  };

  // IPv4 checks
  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    return (
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
      a === 127 // 127.0.0.0/8
    );
  }

  // IPv6-mapped IPv4 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (normalized.startsWith('::ffff:')) {
    const mappedIpv4 = parseMappedIpv4(normalized);
    if (mappedIpv4) {
      return isPrivateIpAddress(mappedIpv4);
    }
  }

  // IPv6 checks (best-effort, without full CIDR parsing)
  const ipv6 = normalized.replace(/^\[|\]$/g, '');
  return (
    ipv6 === '::1' || // Loopback
    ipv6.startsWith('fe80:') || // Link-local
    ipv6.startsWith('fc') || // Unique local (fc00::/7)
    ipv6.startsWith('fd') // Unique local (fc00::/7)
  );
}

export async function validateRemoteUrl(
  url: string,
  options: { allowInsecure?: boolean } = {}
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Skip all security checks if allowInsecure is set (for development/testing)
  if (options.allowInsecure) {
    return;
  }

  // Require HTTPS in production
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `SSRF Protection: URL must use HTTPS. Got: ${parsed.protocol}. Set allowInsecure option to true if you trust this server.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.localhost')
  ) {
    throw new Error(`SSRF Protection: Cannot connect to localhost/loopback address: ${hostname}`);
  }

  // Block private IP ranges (IPv4/IPv6) for literal IPs
  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error(
        `SSRF Protection: Cannot connect to private/internal IP address: ${hostname}`
      );
    }
  }

  // Block cloud metadata endpoints
  if (
    hostname === '169.254.169.254' || // AWS/GCP/Azure metadata
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.internal')
  ) {
    throw new Error(`SSRF Protection: Cannot connect to cloud metadata endpoint: ${hostname}`);
  }

  // Resolve DNS to prevent hostnames that map to private IPs (DNS rebinding)
  if (!isIP(hostname)) {
    try {
      const resolved = await lookup(hostname, { all: true });
      for (const record of resolved) {
        if (isPrivateIpAddress(record.address)) {
          throw new Error(
            `SSRF Protection: Hostname "${hostname}" resolves to private/internal address: ${record.address}`
          );
        }
      }
    } catch (error) {
      throw new Error(
        `SSRF Protection: Failed to resolve hostname "${hostname}": ${error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

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
  setLogger(logger: Logger): void;
}

class StdConfigTransport implements MCPTransport {
  private process: ChildProcess;
  private rl: Interface;
  private logger: Logger = new ConsoleLogger();

  constructor(command: string, args: string[] = [], env: Record<string, string> = {}) {
    // Filter out sensitive environment variables from the host process
    // unless they are explicitly provided in the 'env' argument.
    // Uses specific patterns to avoid false positives with legitimate variables.
    const safeEnv: Record<string, string> = {};
    const sensitivePatterns = [
      /^.*_(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)(_.*)?$/i,
      /^(API_KEY|AUTH_TOKEN|SECRET_KEY|PRIVATE_KEY|PASSWORD|CREDENTIALS?)(_.*)?$/i,
      /^(AWS_SECRET|GITHUB_TOKEN|NPM_TOKEN|SSH_KEY|PGP_PASSPHRASE)(_.*)?$/i,
      /^.*_AUTH_(TOKEN|KEY|SECRET)(_.*)?$/i,
      /^(COOKIE|SESSION_ID|SESSION_SECRET)(_.*)?$/i,
    ];

    for (const [key, value] of Object.entries(process.env)) {
      if (value && !sensitivePatterns.some((p) => p.test(key))) {
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

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  async send(message: unknown): Promise<void> {
    this.process.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(callback: (message: MCPResponse) => void): void {
    this.rl.on('line', (line) => {
      // Safety check for extremely long lines that might have bypassed readline's internal limits
      if (line.length > MAX_BUFFER_SIZE) {
        this.logger.error(
          `[MCP Error] Received line exceeding maximum size (${line.length} bytes), ignoring.`
        );
        return;
      }

      try {
        const response = JSON.parse(line) as MCPResponse;
        callback(response);
      } catch (e) {
        // Log non-JSON lines to stderr so they show up in the terminal
        if (line.trim()) {
          this.logger.log(`[MCP Server Output] ${line}`);
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
  private logger: Logger = new ConsoleLogger();

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  async connect(timeout: number = TIMEOUTS.SSE_CONNECTION_TIMEOUT_MS): Promise<void> {
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
                  // Validate endpoint to prevent SSRF - only allow relative paths
                  const endpointValue = currentEvent.data;
                  if (
                    endpointValue &&
                    (endpointValue.startsWith('http://') ||
                      endpointValue.startsWith('https://') ||
                      endpointValue.startsWith('//'))
                  ) {
                    throw new Error(
                      `SSE endpoint must be a relative path, got absolute URL: ${endpointValue.substring(0, 50)}`
                    );
                  }
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

                const lines = splitLines(buffer);
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
        `Failed to send message to MCP server: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''
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

              const lines = splitLines(buffer);
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
            // Stream errors will be cleaned up in finally block
          } finally {
            try {
              await reader.cancel();
            } catch (error) {
              // Silently ignore cancellation errors
            }
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
      reader.cancel().catch(() => { });
    }
    this.activeReaders.clear();
    this.abortController?.abort();
  }
}

export class MCPClient {
  private transport: MCPTransport;
  private messageId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (response: MCPResponse) => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();
  private timeout: number;
  private logger: Logger;
  private _isHealthy = true;
  private lastHealthCheck = Date.now();

  constructor(
    transportOrCommand: MCPTransport | string,
    timeoutOrArgs: number | string[] = [],
    env: Record<string, string> = {},
    timeout = 60000,
    logger: Logger = new ConsoleLogger()
  ) {
    this.logger = logger;
    if (typeof transportOrCommand === 'string') {
      this.transport = new StdConfigTransport(transportOrCommand, timeoutOrArgs as string[], env);
      this.timeout = timeout;
    } else {
      this.transport = transportOrCommand;
      this.timeout = timeoutOrArgs as number;
    }
    this.transport.setLogger(this.logger);

    this.transport.onMessage((response) => {
      if (response.id !== undefined && this.pendingRequests.has(response.id)) {
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          clearTimeout(pending.timeoutId);
          pending.resolve(response);
        }
      }
    });
  }

  /**
   * Returns whether the client is considered healthy.
   * Updated after each health check or failed request.
   */
  get isHealthy(): boolean {
    return this._isHealthy;
  }

  /**
   * Returns the timestamp of the last health check.
   */
  get lastHealthCheckTime(): number {
    return this.lastHealthCheck;
  }

  static async createLocal(
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
    timeout = 60000,
    logger: Logger = new ConsoleLogger()
  ): Promise<MCPClient> {
    const transport = new StdConfigTransport(command, args, env);
    return new MCPClient(transport, timeout, {}, 0, logger);
  }

  static async createRemote(
    url: string,
    headers: Record<string, string> = {},
    timeout = 60000,
    options: { allowInsecure?: boolean; logger?: Logger } = {}
  ): Promise<MCPClient> {
    // Validate URL to prevent SSRF attacks
    await validateRemoteUrl(url, options);

    const logger = options.logger || new ConsoleLogger();
    const transport = new SSETransport(url, headers);
    transport.setLogger(logger);
    await transport.connect(timeout);
    return new MCPClient(transport, timeout, {}, 0, logger);
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
          this._isHealthy = false;
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, this.timeout);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });

      this.transport.send(message).catch((err) => {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        this._isHealthy = false;
        reject(err);
      });
    });
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'keystone-cli',
        version: pkg.version,
      },
    });
    this._isHealthy = true;
    return response;
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

  /**
   * Perform a health check by sending a ping-like request.
   * Uses a shorter timeout than normal requests.
   *
   * @param timeout Optional timeout in ms (default: 5000)
   * @returns true if healthy, false otherwise
   */
  async healthCheck(timeout = 5000): Promise<boolean> {
    this.lastHealthCheck = Date.now();
    const id = this.messageId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method: 'ping', // Standard MCP ping or falls back gracefully
    };

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this._isHealthy = false;
          resolve(false);
        }
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: () => {
          this._isHealthy = true;
          resolve(true);
        },
        reject: () => {
          this._isHealthy = false;
          resolve(false);
        },
        timeoutId,
      });

      this.transport.send(message).catch(() => {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        this._isHealthy = false;
        resolve(false);
      });
    });
  }

  stop() {
    // Reject all pending requests to prevent hanging callers
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('MCP client stopped'));
    }
    this.pendingRequests.clear();
    this.transport.close();
  }
}
