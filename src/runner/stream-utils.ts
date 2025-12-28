import { ConsoleLogger, type Logger } from '../utils/logger.ts';
import type { LLMResponse, LLMToolCall } from './llm-adapter.ts';

// Maximum response size to prevent memory exhaustion (1MB)
const MAX_RESPONSE_SIZE = 1024 * 1024;
const MAX_BUFFER_SIZE = MAX_RESPONSE_SIZE;

type ToolCallDelta = {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export async function processOpenAIStream(
  response: Response,
  options?: { onStream?: (chunk: string) => void; logger?: Logger },
  streamLabel = 'OpenAI'
): Promise<LLMResponse> {
  if (!response.body) throw new Error('Response body is null');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  const toolCalls: LLMToolCall[] = [];
  let buffer = '';

  let usage: LLMResponse['usage'];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      if (buffer.length > MAX_BUFFER_SIZE) {
        throw new Error(`LLM stream line exceed maximum size of ${MAX_BUFFER_SIZE} bytes`);
      }
      const lines = buffer.split('\n');
      // Keep the last partial line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine === '' || trimmedLine === 'data: [DONE]') continue;
        if (!trimmedLine.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(trimmedLine.slice(6));

          if (data.usage) {
            usage = data.usage;
          }

          const delta = data.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            if (fullContent.length + delta.content.length > MAX_RESPONSE_SIZE) {
              throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
            }
            fullContent += delta.content;
            options?.onStream?.(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const toolCall = tc as ToolCallDelta;
              if (!toolCalls[toolCall.index]) {
                toolCalls[toolCall.index] = {
                  id: toolCall.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                };
              }
              const existing = toolCalls[toolCall.index];
              if (toolCall.function?.name) existing.function.name += toolCall.function.name;
              if (toolCall.function?.arguments) {
                if (
                  fullContent.length +
                  toolCalls.reduce((acc, t) => acc + (t?.function?.arguments?.length || 0), 0) +
                  toolCall.function.arguments.length >
                  MAX_RESPONSE_SIZE
                ) {
                  throw new Error(
                    `LLM tool call arguments exceed maximum size of ${MAX_RESPONSE_SIZE} bytes`
                  );
                }
                existing.function.arguments += toolCall.function.arguments;
              }
            }
          }
        } catch (e) {
          const activeLogger = options?.logger || new ConsoleLogger();

          // Rethrow size limit errors so they bubble up
          if (e instanceof Error && e.message.toLowerCase().includes('maximum size')) {
            throw e;
          }

          if (e instanceof SyntaxError) {
            activeLogger.warn(
              `[${streamLabel} Stream] Malformed JSON line: ${line.slice(0, 80)}...`
            );
          } else {
            activeLogger.warn(`[${streamLabel} Stream] Error processing chunk: ${e}`);
          }
        }
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors while bubbling up the original issue.
    }
    throw error;
  }

  // Final check for any remaining data in the buffer (in case of no final newline)
  if (buffer.trim()) {
    const trimmedLine = buffer.trim();
    if (trimmedLine.startsWith('data: ') && trimmedLine !== 'data: [DONE]') {
      try {
        const data = JSON.parse(trimmedLine.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta) {
          if (delta.content) {
            if (fullContent.length + delta.content.length > MAX_RESPONSE_SIZE) {
              throw new Error(`LLM response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`);
            }
            fullContent += delta.content;
            options?.onStream?.(delta.content);
          }
          if (delta.tool_calls) {
            // Tool calls in the very last chunk are unlikely but possible
            for (const tc of delta.tool_calls) {
              const toolCall = tc as ToolCallDelta;
              if (!toolCalls[toolCall.index]) {
                toolCalls[toolCall.index] = {
                  id: toolCall.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                };
              }
              const existing = toolCalls[toolCall.index];
              if (toolCall.function?.name) existing.function.name += toolCall.function.name;
              if (toolCall.function?.arguments) {
                if (
                  fullContent.length +
                  toolCalls.reduce((acc, t) => acc + (t?.function?.arguments?.length || 0), 0) +
                  toolCall.function.arguments.length >
                  MAX_RESPONSE_SIZE
                ) {
                  throw new Error(
                    `LLM tool call arguments exceed maximum size of ${MAX_RESPONSE_SIZE} bytes`
                  );
                }
                existing.function.arguments += toolCall.function.arguments;
              }
            }
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.toLowerCase().includes('maximum size')) {
          throw e;
        }
        const activeLogger = options?.logger || new ConsoleLogger();
        if (e instanceof SyntaxError) {
          activeLogger.warn(
            `[${streamLabel} Stream] Malformed JSON line: ${trimmedLine.slice(0, 80)}...`
          );
        } else {
          activeLogger.warn(`[${streamLabel} Stream] Error processing final line: ${e}`);
        }
      }
    }
  }

  return {
    message: {
      role: 'assistant',
      content: fullContent || null,
      tool_calls: toolCalls.length > 0 ? toolCalls.filter(Boolean) : undefined,
    },
    usage,
  };
}
