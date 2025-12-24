import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { AuthManager } from '../utils/auth-manager';
import { ConfigLoader } from '../utils/config-loader';
import {
  AnthropicAdapter,
  CopilotAdapter,
  LocalEmbeddingAdapter,
  OpenAIAdapter,
  getAdapter,
} from './llm-adapter';

interface MockFetch {
  mock: {
    calls: unknown[][];
  };
}

describe('OpenAIAdapter', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // @ts-ignore
    global.fetch = mock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should call the OpenAI API correctly', async () => {
    const mockResponse = {
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    // @ts-ignore
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const adapter = new OpenAIAdapter('fake-key');
    const response = await adapter.chat([{ role: 'user', content: 'hi' }]);

    expect(response.message.content).toBe('hello');
    expect(response.usage?.total_tokens).toBe(15);

    // @ts-ignore
    const fetchMock = global.fetch;
    // @ts-ignore
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchCall[1].headers.Authorization).toBe('Bearer fake-key');
  });

  it('should handle API errors', async () => {
    // @ts-ignore
    global.fetch = mock(() =>
      Promise.resolve(
        new Response('Error message', {
          status: 400,
          statusText: 'Bad Request',
        })
      )
    );

    const adapter = new OpenAIAdapter('fake-key');
    await expect(adapter.chat([])).rejects.toThrow(/OpenAI API error: 400 Bad Request/);
  });

  it('should call the embeddings endpoint', async () => {
    const mockResponse = {
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    };

    // @ts-ignore
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const adapter = new OpenAIAdapter('fake-key');
    const embedding = await adapter.embed('hello');
    expect(embedding).toEqual([0.1, 0.2, 0.3]);

    // @ts-ignore
    const fetchMock = global.fetch as MockFetch;
    // @ts-ignore
    // biome-ignore lint/suspicious/noExplicitAny: mock fetch init
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer fake-key');
  });
});

describe('AnthropicAdapter', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // @ts-ignore
    global.fetch = mock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should map messages correctly and call Anthropic API', async () => {
    const mockResponse = {
      content: [{ type: 'text', text: 'hello from claude' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    // @ts-ignore
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const adapter = new AnthropicAdapter('fake-anthropic-key');
    const response = await adapter.chat([
      { role: 'system', content: 'You are a bot' },
      { role: 'user', content: 'hi' },
    ]);

    expect(response.message.content).toBe('hello from claude');
    expect(response.usage?.total_tokens).toBe(15);

    // @ts-ignore
    const fetchMock = global.fetch as MockFetch;
    // @ts-ignore
    // @ts-ignore
    // biome-ignore lint/suspicious/noExplicitAny: mock fetch init
    const [url, init] = fetchMock.mock.calls[0] as [string, any];

    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('fake-anthropic-key');

    const body = JSON.parse(init.body);
    expect(body.system).toBe('You are a bot');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('hi');
  });

  it('should handle tool calls correctly', async () => {
    const mockResponse = {
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'get_weather',
          input: { city: 'San Francisco' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    // @ts-ignore
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const adapter = new AnthropicAdapter('fake-key');
    const response = await adapter.chat([{ role: 'user', content: 'what is the weather?' }], {
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });

    expect(response.message.tool_calls?.[0].function.name).toBe('get_weather');
    // @ts-ignore
    expect(JSON.parse(response.message.tool_calls?.[0].function.arguments)).toEqual({
      city: 'San Francisco',
    });
  });

  it('should map assistant tool calls correctly', async () => {
    // @ts-ignore
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }))
    );

    const adapter = new AnthropicAdapter('fake-key');
    await adapter.chat([
      {
        role: 'assistant',
        content: 'I will call a tool',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'my_tool', arguments: '{"arg": 1}' },
          },
        ],
      },
    ]);

    // @ts-ignore
    // biome-ignore lint/suspicious/noExplicitAny: mock fetch init
    const init = global.fetch.mock.calls[0][1] as any;
    const body = JSON.parse(init.body);
    expect(body.messages[0].role).toBe('assistant');
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'I will call a tool' });
    expect(body.messages[0].content[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'my_tool',
      input: { arg: 1 },
    });
  });

  it('should map tool results correctly', async () => {
    // @ts-ignore
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }))
    );

    const adapter = new AnthropicAdapter('fake-key');
    await adapter.chat([
      {
        role: 'tool',
        content: 'result',
        tool_call_id: 'call_1',
      },
    ]);

    // @ts-ignore
    // biome-ignore lint/suspicious/noExplicitAny: mock fetch init
    const init = global.fetch.mock.calls[0][1] as any;
    const body = JSON.parse(init.body);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'result',
    });
  });
});

describe('CopilotAdapter', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // @ts-ignore
    global.fetch = mock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should get token from AuthManager and call Copilot API', async () => {
    const mockResponse = {
      choices: [{ message: { role: 'assistant', content: 'hello from copilot' } }],
    };

    const spy = spyOn(AuthManager, 'getCopilotToken').mockResolvedValue('mock-token');

    // @ts-ignore
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const adapter = new CopilotAdapter();
    const response = await adapter.chat([{ role: 'user', content: 'hi' }]);

    expect(response.message.content).toBe('hello from copilot');
    expect(AuthManager.getCopilotToken).toHaveBeenCalled();

    // @ts-ignore
    const fetchMock = global.fetch as MockFetch;
    // @ts-ignore
    // @ts-ignore
    // biome-ignore lint/suspicious/noExplicitAny: mock fetch init
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.githubcopilot.com/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer mock-token');
    spy.mockRestore();
  });

  it('should throw error if token not found', async () => {
    const spy = spyOn(AuthManager, 'getCopilotToken').mockResolvedValue(undefined);

    const adapter = new CopilotAdapter();
    await expect(adapter.chat([])).rejects.toThrow(/GitHub Copilot token not found/);
    spy.mockRestore();
  });
});

describe('LocalEmbeddingAdapter', () => {
  it('should throw on chat', async () => {
    const adapter = new LocalEmbeddingAdapter();
    await expect(adapter.chat()).rejects.toThrow(/Local models in Keystone currently only support/);
  });
});

describe('getAdapter', () => {
  beforeEach(() => {
    // Setup a clean config for each test
    ConfigLoader.setConfig({
      default_provider: 'openai',
      providers: {
        openai: { type: 'openai', api_key_env: 'OPENAI_API_KEY' },
        anthropic: { type: 'anthropic', api_key_env: 'ANTHROPIC_API_KEY' },
        copilot: { type: 'copilot' },
      },
      model_mappings: {
        'claude-*': 'anthropic',
        'gpt-*': 'openai',
        'copilot:*': 'copilot',
      },
      storage: { retention_days: 30 },
      mcp_servers: {},
    });
  });

  afterEach(() => {
    ConfigLoader.clear();
  });

  it('should return OpenAIAdapter for gpt models', () => {
    // ConfigLoader.getProviderForModel logic will handle this
    const { adapter, resolvedModel } = getAdapter('gpt-4');
    expect(adapter).toBeInstanceOf(OpenAIAdapter);
    expect(resolvedModel).toBe('gpt-4');
  });

  it('should return AnthropicAdapter for claude models', () => {
    // Explicit mapping in our mock config above covers this if ConfigLoader logic works
    // Or we rely on model name prefix if ConfigLoader has that default logic
    // Let's ensure the mapping exists if we removed the spy
    // ConfigLoader.getProviderForModel uses: explicit mapping OR default provider
    const { adapter, resolvedModel } = getAdapter('claude-3');
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
    expect(resolvedModel).toBe('claude-3');
  });

  it('should return CopilotAdapter for copilot models', () => {
    const { adapter, resolvedModel } = getAdapter('copilot:gpt-4');
    expect(adapter).toBeInstanceOf(CopilotAdapter);
    expect(resolvedModel).toBe('gpt-4');
  });

  it('should return LocalEmbeddingAdapter for local models', () => {
    const { adapter, resolvedModel } = getAdapter('local');
    expect(adapter).toBeInstanceOf(LocalEmbeddingAdapter);
    expect(resolvedModel).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('should throw error for unknown provider', () => {
    // Set config with empty providers to force error
    ConfigLoader.setConfig({
      default_provider: 'unknown',
      providers: {}, // No providers configured
      model_mappings: {},
      storage: { retention_days: 30 },
      mcp_servers: {},
    });

    expect(() => getAdapter('unknown-model')).toThrow();
  });
});
