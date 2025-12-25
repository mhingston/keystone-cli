/**
 * Shared test fixtures for Keystone CLI tests.
 * 
 * Centralizes mock agents, workflows, and configs to reduce duplication
 * across test files.
 */

/**
 * Mock agent content for test-agent.md
 */
export const TEST_AGENT_CONTENT = `---
name: test-agent
model: gpt-4
tools:
  - name: test-tool
    execution:
      type: shell
      run: echo "tool executed with \${{ args.val }}"
---
You are a test agent.`;

/**
 * Mock agent without tools
 */
export const SIMPLE_AGENT_CONTENT = `---
name: simple-agent
model: gpt-4
---
You are a simple test agent.`;

/**
 * Basic workflow fixture
 */
export const BASIC_WORKFLOW_CONTENT = `name: test-workflow
steps:
  - id: step1
    type: shell
    run: echo "hello"
`;

/**
 * Workflow with LLM step
 */
export const LLM_WORKFLOW_CONTENT = `name: llm-test-workflow
steps:
  - id: ask
    type: llm
    agent: test-agent
    prompt: "Test prompt"
    maxIterations: 5
`;

/**
 * Default test config
 */
export const TEST_CONFIG = {
    providers: {
        openai: { type: 'openai' as const, api_key_env: 'OPENAI_API_KEY' },
    },
    default_provider: 'openai',
    model_mappings: {},
    storage: { retention_days: 30, redact_secrets_at_rest: true },
    mcp_servers: {},
    engines: { allowlist: {}, denylist: [] },
    concurrency: { default: 10, pools: { llm: 2, shell: 5, http: 10, engine: 2 } },
};

/**
 * Create a mock LLM response
 */
export function createMockLLMResponse(content: string) {
    return {
        message: { role: 'assistant' as const, content },
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
}

/**
 * Create a mock tool call response
 */
export function createMockToolCallResponse(
    toolName: string,
    args: Record<string, unknown>,
    callId = 'call-1'
) {
    return {
        message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
                {
                    id: callId,
                    type: 'function' as const,
                    function: { name: toolName, arguments: JSON.stringify(args) },
                },
            ],
        },
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
}
