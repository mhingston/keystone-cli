import { describe, expect, it, mock } from 'bun:test';
import { processOpenAIStream } from './stream-utils';

const encoder = new TextEncoder();

function responseFromChunks(chunks: string[]): Response {
  let index = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }
      const value = encoder.encode(chunks[index]);
      index += 1;
      return { done: false, value };
    },
    async cancel(): Promise<void> {},
  };

  return {
    body: {
      getReader: () => reader,
    },
  } as Response;
}

describe('processOpenAIStream', () => {
  it('accumulates content and tool calls across chunks', async () => {
    const onStream = mock(() => {});
    const response = responseFromChunks([
      'data: {"choices":[{"delta":{"content":"hello "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"id":"call_1","function":{"name":"my_tool","arguments":"{\\"arg\\":"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n',
      'data: [DONE]\n',
    ]);

    const result = await processOpenAIStream(response, { onStream });

    expect(result.message.content).toBe('hello world');
    expect(onStream).toHaveBeenCalledTimes(2);
    expect(result.message.tool_calls?.[0]?.function?.name).toBe('my_tool');
    expect(result.message.tool_calls?.[0]?.function?.arguments).toBe('{"arg":1}');
  });

  it('parses a final line without a newline', async () => {
    const onStream = mock(() => {});
    const response = responseFromChunks(['data: {"choices":[{"delta":{"content":"tail"}}]}']);

    const result = await processOpenAIStream(response, { onStream });

    expect(result.message.content).toBe('tail');
    expect(onStream).toHaveBeenCalledTimes(1);
  });

  it('logs malformed JSON and continues processing', async () => {
    const logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const response = responseFromChunks([
      'data: {bad json}\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
      'data: [DONE]\n',
    ]);

    const result = await processOpenAIStream(response, { logger });

    expect(result.message.content).toBe('ok');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
