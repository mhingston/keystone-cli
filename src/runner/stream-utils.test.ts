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

  it('handles tool calls in a final line without a newline', async () => {
    const response = responseFromChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"final_tool","arguments":"{\\"x\\":1}"}}]}}]}',
    ]);

    const result = await processOpenAIStream(response);

    expect(result.message.tool_calls?.[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'final_tool', arguments: '{"x":1}' },
    });
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
    expect(logger.warn.mock.calls[0][0]).toContain('Malformed JSON line');
  });

  it('throws error when buffer size is exceeded', async () => {
    const response = responseFromChunks(['a'.repeat(1024 * 1024 + 1)]);
    await expect(processOpenAIStream(response)).rejects.toThrow(
      'LLM stream line exceed maximum size'
    );
  });

  it('throws error when response size limit is exceeded', async () => {
    const response = responseFromChunks([
      `data: {"choices":[{"delta":{"content":"${'a'.repeat(600 * 1024)}"}}]}\n`,
      `data: {"choices":[{"delta":{"content":"${'a'.repeat(500 * 1024)}"}}]}\n`,
    ]);
    await expect(processOpenAIStream(response)).rejects.toThrow(
      'LLM response exceeds maximum size'
    );
  });

  it('throws error when tool call arguments size limit is exceeded', async () => {
    const response = responseFromChunks([
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${'a'.repeat(600 * 1024)}"}}]}}]}\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${'a'.repeat(500 * 1024)}"}}]}}]}\n`,
    ]);
    await expect(processOpenAIStream(response)).rejects.toThrow(
      'LLM tool call arguments exceed maximum size'
    );
  });

  it('handles and logs generic errors during chunk processing', async () => {
    const logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    // Mocking JSON.parse to throw a non-SyntaxError
    const originalParse = JSON.parse;
    JSON.parse = (str: string) => {
      if (str === '{"trigger_error":true}') throw new Error('Generic error');
      return originalParse(str);
    };

    try {
      const response = responseFromChunks(['data: {"trigger_error":true}\n']);
      await processOpenAIStream(response, { logger });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain(
        'Error processing chunk: Error: Generic error'
      );
    } finally {
      JSON.parse = originalParse;
    }
  });

  it('handles errors in the final line processing', async () => {
    const logger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
    };
    const response = responseFromChunks(['data: {bad json}']); // No newline, triggers buffer processing

    await processOpenAIStream(response, { logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('Malformed JSON line');
  });

  it('throws size limit error in final line processing', async () => {
    const response = responseFromChunks([
      `data: {"choices":[{"delta":{"content":"${'a'.repeat(600 * 1024)}"}}]}\n`,
      `data: {"choices":[{"delta":{"content":"${'a'.repeat(500 * 1024)}"}}]}`,
    ]);
    // The first line is ok, the second line is in the final buffer and exceeds size
    await expect(processOpenAIStream(response)).rejects.toThrow(
      'LLM response exceeds maximum size'
    );
  });

  it('bubbles up reader cancel errors', async () => {
    const reader = {
      read: async () => {
        throw new Error('Read error');
      },
      cancel: async () => {
        throw new Error('Cancel error');
      },
    };
    const response = {
      body: {
        getReader: () => reader,
      },
    } as unknown as Response;

    await expect(processOpenAIStream(response)).rejects.toThrow('Read error');
  });
});
