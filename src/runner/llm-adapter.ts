import { randomUUID } from 'node:crypto';
import { pipeline } from '@xenova/transformers';
import { AuthManager, COPILOT_HEADERS } from '../utils/auth-manager';
import { ConfigLoader } from '../utils/config-loader';
import { ConsoleLogger } from '../utils/logger';
import { processOpenAIStream } from './stream-utils';

// Maximum response size to prevent memory exhaustion (1MB)
const MAX_RESPONSE_SIZE = 1024 * 1024;
const ANTHROPIC_OAUTH_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
].join(',');
const GEMINI_DEFAULT_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const GEMINI_DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const GEMINI_HEADERS = {
  'User-Agent': 'antigravity/1.11.5 windows/amd64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};
const defaultLogger = new ConsoleLogger();

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
  reasoning?: {
    encrypted_content: string;
    summary?: string;
  };
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

type LLMMessageWithId = LLMMessage & { id?: string };
type ChatGPTToolCall = Omit<LLMToolCall, 'id'>;
type ChatGPTMessage = Omit<LLMMessage, 'tool_calls'> & { tool_calls?: ChatGPTToolCall[] };

export interface LLMResponse {
  message: LLMMessage;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown> | string;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiSystemInstruction {
  role?: 'system';
  parts: GeminiPart[];
}

export interface LLMAdapter {
  chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMTool[];
      onStream?: (chunk: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<LLMResponse>;
  embed?(text: string, model?: string): Promise<number[]>;
}

export class OpenAIAdapter implements LLMAdapter {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || Bun.env.OPENAI_API_KEY || '';
    this.baseUrl = baseUrl || Bun.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

    if (!this.apiKey && this.baseUrl === 'https://api.openai.com/v1') {
      defaultLogger.warn('Warning: OPENAI_API_KEY is not set.');
    }
  }

  async chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMTool[];
      onStream?: (chunk: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<LLMResponse> {
    const isStreaming = !!options?.onStream;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || 'gpt-4o',
        messages,
        tools: options?.tools,
        stream: isStreaming,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${error}`);
    }

    if (isStreaming) {
      if (!response.body) throw new Error('Response body is null');
      return processOpenAIStream(response, options, 'OpenAI');
    }

    const data = (await response.json()) as {
      choices: { message: LLMMessage }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    // Validate response size to prevent memory exhaustion
    const contentLength = data.choices[0]?.message?.content?.length ?? 0;
    if (contentLength > MAX_RESPONSE_SIZE) {
      throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
    }

    return {
      message: data.choices[0].message,
      usage: data.usage,
    };
  }

  async embed(text: string, model = 'text-embedding-3-small'): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `OpenAI Embeddings API error: ${response.status} ${response.statusText} - ${error}`
      );
    }

    const data = (await response.json()) as {
      data: { embedding: number[] }[];
    };
    return data.data[0].embedding;
  }
}

export class AnthropicAdapter implements LLMAdapter {
  private apiKey: string;
  private baseUrl: string;
  private authMode: 'api-key' | 'oauth';

  constructor(apiKey?: string, baseUrl?: string, authMode: 'api-key' | 'oauth' = 'api-key') {
    this.apiKey = apiKey || Bun.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = baseUrl || Bun.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
    this.authMode = authMode;

    if (
      this.authMode === 'api-key' &&
      !this.apiKey &&
      this.baseUrl === 'https://api.anthropic.com/v1'
    ) {
      defaultLogger.warn('Warning: ANTHROPIC_API_KEY is not set.');
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.authMode === 'oauth') {
      const token = await AuthManager.getAnthropicClaudeToken();
      if (!token) {
        throw new Error(
          'Anthropic Claude authentication not found. Please run "keystone auth login anthropic-claude" first.'
        );
      }
      return {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': ANTHROPIC_OAUTH_BETAS,
      };
    }

    return {
      'x-api-key': this.apiKey,
    };
  }

  async chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMTool[];
      onStream?: (chunk: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<LLMResponse> {
    const isStreaming = !!options?.onStream;
    const system = messages.find((m) => m.role === 'system')?.content || undefined;

    // Anthropic requires alternating user/assistant roles.
    // Sequential tool results must be grouped into a single user message.
    const anthropicMessages: Array<{
      role: 'user' | 'assistant';
      content: string | Array<Record<string, unknown>>;
    }> = [];

    for (const m of messages) {
      if (m.role === 'system') continue;

      if (m.role === 'tool') {
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        const toolResult = {
          type: 'tool_result' as const,
          tool_use_id: m.tool_call_id,
          content: m.content,
        };

        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          // Append to existing tool result block if previous message was also a tool result
          lastMsg.content.push(toolResult);
        } else {
          // Start a new user message for tool results
          anthropicMessages.push({
            role: 'user',
            content: [toolResult],
          });
        }
      } else if (m.tool_calls) {
        anthropicMessages.push({
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.tool_calls.map((tc) => {
              let input = {};
              try {
                input =
                  typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments;
              } catch (e) {
                defaultLogger.error(`Failed to parse tool arguments: ${tc.function.arguments}`);
              }
              return {
                type: 'tool_use' as const,
                id: tc.id,
                name: tc.function.name,
                input,
              };
            }),
          ],
        });
      } else {
        const role = m.role as 'user' | 'assistant';
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];

        if (
          lastMsg &&
          lastMsg.role === role &&
          typeof lastMsg.content === 'string' &&
          typeof m.content === 'string'
        ) {
          lastMsg.content += `\n\n${m.content}`;
        } else {
          anthropicMessages.push({
            role,
            content: m.content || '',
          });
        }
      }
    }

    const anthropicTools = options?.tools
      ? options.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }))
      : undefined;

    const authHeaders = await this.getAuthHeaders();
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options?.model || 'claude-3-5-sonnet-20240620',
        system,
        messages: anthropicMessages,
        tools: anthropicTools,
        max_tokens: 4096,
        stream: isStreaming,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText} - ${error}`);
    }

    if (isStreaming) {
      if (!response.body) throw new Error('Response body is null');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      // Track tool calls by content block index for robust correlation
      const toolCallsMap = new Map<number, { id: string; name: string; inputString: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter((line) => line.trim() !== '');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'content_block_delta' && data.delta?.text) {
              if (fullContent.length + data.delta.text.length > MAX_RESPONSE_SIZE) {
                throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
              }
              fullContent += data.delta.text;
              options.onStream?.(data.delta.text);
            }

            // Track tool calls by their index in the content blocks
            if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
              const index = data.index ?? toolCallsMap.size;
              toolCallsMap.set(index, {
                id: data.content_block.id || '',
                name: data.content_block.name || '',
                inputString: '',
              });
            }

            // Handle tool input streaming - Anthropic uses content_block_delta with input_json_delta
            if (
              data.type === 'content_block_delta' &&
              data.delta?.type === 'input_json_delta' &&
              data.delta?.partial_json
            ) {
              const index = data.index;
              const toolCall = toolCallsMap.get(index);
              if (toolCall) {
                toolCall.inputString += data.delta.partial_json;
              }
            }

            // Update tool call ID if it arrives later (some edge cases)
            if (data.type === 'content_block_delta' && data.content_block?.id) {
              const index = data.index;
              const toolCall = toolCallsMap.get(index);
              if (toolCall && !toolCall.id) {
                toolCall.id = data.content_block.id;
              }
            }
          } catch (e) {
            // Log non-SyntaxError exceptions at warning level (they indicate real issues)
            if (!(e instanceof SyntaxError)) {
              defaultLogger.warn(`[Anthropic Stream] Error processing chunk: ${e}`);
            } else if (process.env.DEBUG || process.env.LLM_DEBUG) {
              // SyntaxErrors are normal for incomplete chunks - only log in debug mode
              process.stderr.write(
                `[Anthropic Stream] Incomplete chunk parse: ${line.slice(0, 50)}...\n`
              );
            }
          }
        }
      }

      // Convert map to array and filter out incomplete tool calls
      const toolCalls = Array.from(toolCallsMap.values())
        .filter((tc) => tc.id && tc.name) // Only include complete tool calls
        .map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.inputString },
        }));

      return {
        message: {
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      };
    }

    const data = (await response.json()) as {
      content: {
        type: 'text' | 'tool_use';
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[];
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = data.content.find((c) => c.type === 'text')?.text || null;

    // Validate response size to prevent memory exhaustion
    if (content && content.length > MAX_RESPONSE_SIZE) {
      throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
    }

    const toolCalls = data.content
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({
        id: c.id as string,
        type: 'function' as const,
        function: {
          name: c.name as string,
          arguments: JSON.stringify(c.input),
        },
      }));

    return {
      message: {
        role: 'assistant',
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  }
}

export class AnthropicClaudeAdapter extends AnthropicAdapter {
  constructor(baseUrl?: string) {
    super(undefined, baseUrl, 'oauth');
  }
}

export class OpenAIChatGPTAdapter implements LLMAdapter {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || Bun.env.OPENAI_CHATGPT_BASE_URL || 'https://api.openai.com/v1';
  }

  private filterMessages(messages: LLMMessage[]): ChatGPTMessage[] {
    // Stateless mode requires stripping all IDs and filtering out item_references
    return messages.map((m): ChatGPTMessage => {
      // Create a shallow copy and remove id if it exists
      const { id: _id, ...rest } = m as LLMMessageWithId;

      if (m.tool_calls) {
        const toolCalls = m.tool_calls.map((tc) => {
          const { id: _toolCallId, ...tcRest } = tc;
          return tcRest;
        });
        return {
          ...rest,
          tool_calls: toolCalls,
        };
      }

      return rest;
    });
  }

  private normalizeModel(model: string): string {
    // Map Keystone model names to Codex API expected names
    if (model.includes('gpt-5')) return 'gpt-5-codex';
    if (model.includes('gpt-4o-codex')) return 'gpt-4o';
    return model;
  }

  async chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMTool[];
      onStream?: (chunk: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<LLMResponse> {
    const isStreaming = !!options?.onStream;
    const token = await AuthManager.getOpenAIChatGPTToken();
    if (!token) {
      throw new Error(
        'OpenAI ChatGPT authentication not found. Please run "keystone auth login openai-chatgpt" first.'
      );
    }

    const filteredMessages = this.filterMessages(messages);
    const resolvedModel = this.normalizeModel(options?.model || 'gpt-5-codex');

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'OpenAI-Organization': '', // Ensure clear org context
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: filteredMessages,
        tools: options?.tools,
        stream: isStreaming,
        // Critical for ChatGPT Plus/Pro backend compatibility
        store: false,
        include: ['reasoning.encrypted_content'],
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      // Handle usage limit messages gracefully
      if (response.status === 429 && error.includes('limit')) {
        throw new Error(
          'ChatGPT subscription limit reached. Please wait and try again or switch to another provider.'
        );
      }
      throw new Error(
        `OpenAI ChatGPT API error: ${response.status} ${response.statusText} - ${error}`
      );
    }

    if (isStreaming) {
      if (!response.body) throw new Error('Response body is null');
      return processOpenAIStream(response, options, 'OpenAIChatGPT');
    }

    const data = (await response.json()) as {
      choices: { message: LLMMessage }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      message: data.choices[0].message,
      usage: data.usage,
    };
  }
}

export class GoogleGeminiAdapter implements LLMAdapter {
  private baseUrl: string;
  private projectId?: string;

  constructor(baseUrl?: string, projectId?: string) {
    this.baseUrl = (baseUrl || Bun.env.GOOGLE_GEMINI_BASE_URL || GEMINI_DEFAULT_BASE_URL).replace(
      /\/$/,
      ''
    );
    this.projectId =
      projectId || Bun.env.GOOGLE_GEMINI_PROJECT_ID || Bun.env.KEYSTONE_GEMINI_PROJECT_ID;
  }

  private sanitizeToolName(name: string, index: number, used: Set<string>): string {
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    if (!sanitized) {
      sanitized = `tool_${index}`;
    }
    while (used.has(sanitized)) {
      sanitized = `${sanitized}_${index}`.slice(0, 64);
    }
    used.add(sanitized);
    return sanitized;
  }

  private buildToolMaps(tools?: LLMTool[]): {
    nameToSanitized: Map<string, string>;
    sanitizedToName: Map<string, string>;
    tools?: {
      functionDeclarations: Array<{ name: string; description: string; parameters: unknown }>;
    }[];
    toolConfig?: { functionCallingConfig: { mode: 'AUTO' } };
  } {
    const nameToSanitized = new Map<string, string>();
    const sanitizedToName = new Map<string, string>();

    if (!tools || tools.length === 0) {
      return { nameToSanitized, sanitizedToName };
    }

    const usedNames = new Set<string>();
    const functionDeclarations = tools.map((tool, index) => {
      const originalName = tool.function.name;
      const sanitized = this.sanitizeToolName(originalName, index, usedNames);
      nameToSanitized.set(originalName, sanitized);
      sanitizedToName.set(sanitized, originalName);
      return {
        name: sanitized,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      };
    });

    return {
      nameToSanitized,
      sanitizedToName,
      tools: [{ functionDeclarations }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    };
  }

  private parseToolResponse(content: string | null): Record<string, unknown> {
    if (!content) return {};
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
      return { content: parsed };
    } catch {
      return { content };
    }
  }

  private buildContents(
    messages: LLMMessage[],
    nameToSanitized: Map<string, string>
  ): { contents: GeminiContent[]; systemInstruction?: GeminiSystemInstruction } {
    const contents: GeminiContent[] = [];
    const systemParts: string[] = [];

    for (const message of messages) {
      if (message.role === 'system') {
        if (message.content) systemParts.push(message.content);
        continue;
      }

      const role: GeminiContent['role'] = message.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiPart[] = [];

      if (message.role === 'tool') {
        const toolName = message.name
          ? nameToSanitized.get(message.name) || message.name
          : undefined;
        if (toolName) {
          parts.push({
            functionResponse: {
              name: toolName,
              response: this.parseToolResponse(message.content),
            },
          });
        } else if (message.content) {
          parts.push({ text: message.content });
        }
      } else {
        if (message.content) {
          parts.push({ text: message.content });
        }

        if (message.tool_calls) {
          for (const toolCall of message.tool_calls) {
            const toolName = nameToSanitized.get(toolCall.function.name) || toolCall.function.name;
            let args: Record<string, unknown> | string = {};
            if (typeof toolCall.function.arguments === 'string') {
              try {
                args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
              } catch {
                args = toolCall.function.arguments;
              }
            } else {
              args = toolCall.function.arguments as unknown as Record<string, unknown>;
            }
            parts.push({
              functionCall: {
                name: toolName,
                args,
              },
            });
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    const systemInstruction =
      systemParts.length > 0
        ? {
            parts: [{ text: systemParts.join('\n\n') }],
          }
        : undefined;

    return { contents, systemInstruction };
  }

  private buildEndpoint(isStreaming: boolean): string {
    const action = isStreaming ? 'streamGenerateContent' : 'generateContent';
    const suffix = isStreaming ? '?alt=sse' : '';
    return `${this.baseUrl}/v1internal:${action}${suffix}`;
  }

  private buildUsage(usage?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  }): LLMResponse['usage'] | undefined {
    if (!usage) return undefined;
    const promptTokens = usage.promptTokenCount ?? 0;
    const completionTokens = usage.candidatesTokenCount ?? 0;
    const totalTokens = usage.totalTokenCount ?? promptTokens + completionTokens;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }

  private extractGeminiParts(
    data: {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    },
    sanitizedToName: Map<string, string>,
    onStream?: (chunk: string) => void,
    toolCalls?: LLMToolCall[]
  ): { content: string; usage?: LLMResponse['usage'] } {
    let content = '';
    if (Array.isArray(data.candidates)) {
      const candidate = data.candidates[0];
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          if (content.length + part.text.length > MAX_RESPONSE_SIZE) {
            throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
          }
          content += part.text;
          onStream?.(part.text);
        }
        if (part.functionCall && toolCalls) {
          const originalName =
            sanitizedToName.get(part.functionCall.name) || part.functionCall.name;
          const args = part.functionCall.args ?? {};
          const argsString = typeof args === 'string' ? args : JSON.stringify(args);
          toolCalls.push({
            id: `gemini_tool_${toolCalls.length + 1}`,
            type: 'function',
            function: {
              name: originalName,
              arguments: argsString,
            },
          });
        }
      }
    }

    return { content, usage: this.buildUsage(data.usageMetadata) };
  }

  async chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMTool[];
      onStream?: (chunk: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<LLMResponse> {
    const isStreaming = !!options?.onStream;
    const token = await AuthManager.getGoogleGeminiToken();
    if (!token) {
      throw new Error(
        'Google Gemini authentication not found. Please run "keystone auth login gemini" first.'
      );
    }

    const { nameToSanitized, sanitizedToName, tools, toolConfig } = this.buildToolMaps(
      options?.tools
    );
    const { contents, systemInstruction } = this.buildContents(messages, nameToSanitized);

    const requestPayload: Record<string, unknown> = {
      contents,
      sessionId: randomUUID(),
    };
    if (systemInstruction) requestPayload.systemInstruction = systemInstruction;
    if (tools) requestPayload.tools = tools;
    if (toolConfig) requestPayload.toolConfig = toolConfig;

    const authProjectId = this.projectId ? undefined : AuthManager.load().google_gemini?.project_id;
    const resolvedProjectId = this.projectId || authProjectId || GEMINI_DEFAULT_PROJECT_ID;

    const wrappedBody = {
      project: resolvedProjectId,
      model: options?.model || 'gemini-3-pro-high',
      request: requestPayload,
      userAgent: 'antigravity',
      requestId: `keystone-${randomUUID()}`,
    };

    const response = await fetch(this.buildEndpoint(isStreaming), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...GEMINI_HEADERS,
        ...(isStreaming ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(wrappedBody),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Google Gemini API error: ${response.status} ${response.statusText} - ${error}`
      );
    }

    if (isStreaming) {
      if (!response.body) throw new Error('Response body is null');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      const toolCalls: LLMToolCall[] = [];
      let usage: LLMResponse['usage'] | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            const data = JSON.parse(payload) as {
              candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                totalTokenCount?: number;
              };
            };
            const result = this.extractGeminiParts(
              data,
              sanitizedToName,
              options?.onStream,
              toolCalls
            );
            if (result.content) {
              if (fullContent.length + result.content.length > MAX_RESPONSE_SIZE) {
                throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
              }
              fullContent += result.content;
            }
            if (result.usage) {
              usage = result.usage;
            }
          } catch (e) {
            if (e instanceof Error && e.message.includes('LLM response exceeds')) {
              throw e;
            }
            if (process.env.DEBUG || process.env.LLM_DEBUG) {
              process.stderr.write(`[Gemini Stream] Failed to parse chunk: ${payload}\n`);
            }
          }
        }
      }

      const finalToolCalls = toolCalls.length > 0 ? toolCalls : undefined;
      return {
        message: {
          role: 'assistant',
          content: fullContent || null,
          tool_calls: finalToolCalls,
        },
        usage,
      };
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const toolCalls: LLMToolCall[] = [];
    const extracted = this.extractGeminiParts(data, sanitizedToName, undefined, toolCalls);
    const content = extracted.content || null;

    return {
      message: {
        role: 'assistant',
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage: extracted.usage,
    };
  }
}

export class CopilotAdapter implements LLMAdapter {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || 'https://api.githubcopilot.com';
  }

  async chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMTool[];
      onStream?: (chunk: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<LLMResponse> {
    const isStreaming = !!options?.onStream;
    const token = await AuthManager.getCopilotToken();
    if (!token) {
      throw new Error('GitHub Copilot token not found. Please run "keystone auth login" first.');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'vscode-editorid': 'vscode-chat',
        'vscode-machineid': 'default',
        ...COPILOT_HEADERS,
      },
      body: JSON.stringify({
        model: options?.model || 'gpt-4o',
        messages,
        tools: options?.tools,
        stream: isStreaming,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Copilot API error: ${response.status} ${response.statusText} - ${error}`);
    }

    if (isStreaming) {
      // Use the same streaming logic as OpenAIAdapter since Copilot uses OpenAI API
      if (!response.body) throw new Error('Response body is null');
      return processOpenAIStream(response, options, 'Copilot');
    }

    const data = (await response.json()) as {
      choices: { message: LLMMessage }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    // Validate response size to prevent memory exhaustion
    const contentLength = data.choices[0]?.message?.content?.length ?? 0;
    if (contentLength > MAX_RESPONSE_SIZE) {
      throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
    }

    return {
      message: data.choices[0].message,
      usage: data.usage,
    };
  }
}

export class LocalEmbeddingAdapter implements LLMAdapter {
  // biome-ignore lint/suspicious/noExplicitAny: transformers pipeline type
  private static extractor: any = null;

  async chat(
    _messages: LLMMessage[],
    _options?: {
      model?: string;
      tools?: LLMTool[];
      onStream?: (chunk: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<LLMResponse> {
    throw new Error(
      'Local models in Keystone currently only support memory/embedding operations. ' +
        'To use a local LLM for chat/generation, please use an OpenAI-compatible local server ' +
        '(like Ollama, LM Studio, or LocalAI) and configure it as an OpenAI provider in your config.'
    );
  }

  async embed(text: string, model = 'Xenova/all-MiniLM-L6-v2'): Promise<number[]> {
    const modelToUse = model === 'local' ? 'Xenova/all-MiniLM-L6-v2' : model;
    if (!LocalEmbeddingAdapter.extractor) {
      LocalEmbeddingAdapter.extractor = await pipeline('feature-extraction', modelToUse);
    }
    const output = await LocalEmbeddingAdapter.extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(output.data);
  }
}

export function getAdapter(model: string): { adapter: LLMAdapter; resolvedModel: string } {
  if (model === 'local' || model.startsWith('local:')) {
    const resolvedModel = model === 'local' ? 'Xenova/all-MiniLM-L6-v2' : model.substring(6);
    return { adapter: new LocalEmbeddingAdapter(), resolvedModel };
  }

  const providerName = ConfigLoader.getProviderForModel(model);
  const config = ConfigLoader.load();
  const providerConfig = config.providers[providerName];

  if (!providerConfig) {
    throw new Error(`Provider configuration not found for: ${providerName}`);
  }

  let resolvedModel = model;
  if (model.includes(':')) {
    const [prefix, ...rest] = model.split(':');
    if (config.providers[prefix]) {
      resolvedModel = rest.join(':');
    }
  }

  let adapter: LLMAdapter;
  if (providerConfig.type === 'copilot') {
    adapter = new CopilotAdapter(providerConfig.base_url);
  } else if (providerConfig.type === 'openai-chatgpt') {
    adapter = new OpenAIChatGPTAdapter(providerConfig.base_url);
  } else if (providerConfig.type === 'google-gemini') {
    adapter = new GoogleGeminiAdapter(providerConfig.base_url, providerConfig.project_id);
  } else if (providerConfig.type === 'anthropic-claude') {
    adapter = new AnthropicClaudeAdapter(providerConfig.base_url);
  } else {
    const apiKey = providerConfig.api_key_env ? Bun.env[providerConfig.api_key_env] : undefined;

    if (providerConfig.type === 'anthropic') {
      adapter = new AnthropicAdapter(apiKey, providerConfig.base_url);
    } else {
      adapter = new OpenAIAdapter(apiKey, providerConfig.base_url);
    }
  }

  return { adapter, resolvedModel };
}
