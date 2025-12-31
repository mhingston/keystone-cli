/**
 * Centralized constants for timeouts, limits, and defaults.
 * Consolidates magic numbers from across the codebase.
 */

/** Timeout values in milliseconds */
export const TIMEOUTS = {
  /** Default timeout for script execution in ProcessSandbox */
  DEFAULT_SCRIPT_TIMEOUT_MS: 5000,
  /** Default base delay for retry backoff */
  DEFAULT_RETRY_BASE_DELAY_MS: 1000,
  /** Default timeout for HTTP requests */
  DEFAULT_HTTP_TIMEOUT_MS: 30000,
  /** Default regex execution timeout for search operations */
  REGEX_TIMEOUT_MS: 1000,
  /** Timeout for OAuth login flows (5 minutes) */
  OAUTH_LOGIN_TIMEOUT_MS: 5 * 60 * 1000,
  /** SSE connection timeout for MCP client */
  SSE_CONNECTION_TIMEOUT_MS: 60000,
} as const;

/** Database related constants */
export const DB = {
  /** SQLite busy/locked error code */
  SQLITE_BUSY: 5,
  /** Base delay for retry backoff in ms */
  RETRY_BASE_DELAY_MS: 50,
  /** Multiplier for exponential backoff */
  RETRY_BACKOFF_MULTIPLIER: 1.5,
  /** Maximum delay between retries in ms */
  RETRY_MAX_DELAY_MS: 2000,
  /** Random jitter to add to delays in ms */
  RETRY_JITTER_MS: 50,
  /** Retry count threshold for warning log */
  RETRY_WARN_THRESHOLD: 10,
} as const;

/** Limit values for various operations */
export const LIMITS = {
  /** Maximum size for LLM responses to prevent memory exhaustion */
  MAX_RESPONSE_SIZE_BYTES: 1024 * 1024,
  /** Maximum bytes to read from a file in file read steps */
  MAX_FILE_READ_BYTES: 5 * 1024 * 1024,
  /** Maximum length for search query strings */
  MAX_SEARCH_QUERY_LENGTH: 500,
  /** Maximum length for regex patterns in search queries */
  MAX_REGEX_PATTERN_LENGTH: 200,
  /** Maximum bytes to read per file in content search */
  MAX_SEARCH_FILE_BYTES: 1024 * 1024,
  /** Maximum line length to evaluate in content search */
  MAX_SEARCH_LINE_LENGTH: 2000,
  /** Maximum bytes to read from HTTP responses */
  MAX_HTTP_RESPONSE_BYTES: 2 * 1024 * 1024,
  /** Maximum bytes to capture from process stdout/stderr */
  MAX_PROCESS_OUTPUT_BYTES: 2 * 1024 * 1024,
  /** Maximum messages to keep in LLM conversation history */
  MAX_MESSAGE_HISTORY: 50,
  /** Maximum bytes to keep per tool output in LLM history */
  MAX_TOOL_OUTPUT_BYTES: 50 * 1024,
  /** Maximum total bytes to keep in LLM conversation history */
  MAX_CONVERSATION_BYTES: 512 * 1024,
  /** Maximum results from content search */
  MAX_SEARCH_RESULTS: 100,
  /** Maximum entries in the engine version cache */
  VERSION_CACHE_MAX_SIZE: 100,
  /** Maximum size for rate limiter wait queue */
  MAX_RATE_LIMITER_QUEUE_SIZE: 1000,
  /** Maximum string length for CLI input values */
  MAX_INPUT_STRING_LENGTH: 100_000,
  /** Maximum depth for balanced brace matching in JSON parser */
  MAX_JSON_BRACE_DEPTH: 100,
  /** Maximum string length to attempt JSON extraction from */
  MAX_JSON_PARSE_LENGTH: 1_000_000,
  /** Maximum timeout for resource pool acquire (1 hour) */
  MAX_RESOURCE_POOL_TIMEOUT_MS: 3600000,
  /** Maximum shell command length to check for injection patterns */
  MAX_SHELL_COMMAND_CHECK_LENGTH: 10_000,
  /** Standard length for error message truncation in logs */
  ERROR_MESSAGE_TRUNCATE_LENGTH: 500,
  /** Maximum iterations for foreach loops to prevent memory exhaustion */
  MAX_FOREACH_ITERATIONS: 10_000,
  /** Threshold for warning about large foreach iteration count */
  FOREACH_MEMORY_WARNING_THRESHOLD: 1000,
  /** Maximum bytes for accumulated foreach results (100MB) */
  MAX_FOREACH_RESULTS_BYTES: 100 * 1024 * 1024,
  /** Default maximum retries for database operations */
  MAX_DB_RETRIES: 20,
} as const;

/** File mode constants for secure filesystem operations */
export const FILE_MODES = {
  /** Owner-only permissions for sensitive temp directories */
  SECURE_DIR: 0o700,
} as const;

/** Default iteration counts */
export const ITERATIONS = {
  /** Default max iterations for LLM ReAct loop */
  DEFAULT_LLM_MAX_ITERATIONS: 10,
} as const;

/** LLM-related constants for conversation management */
export const LLM = {
  /** Opening tag for thinking blocks in streaming responses */
  THINKING_OPEN_TAG: '<thinking>',
  /** Closing tag for thinking blocks in streaming responses */
  THINKING_CLOSE_TAG: '</thinking>',
  /** Tool name for agent handoff functionality */
  TRANSFER_TOOL_NAME: 'transfer_to_agent',
  /** Key for context updates in tool outputs */
  CONTEXT_UPDATE_KEY: '__keystone_context',
} as const;

/** MCP (Model Context Protocol) related constants */
export const MCP = {
  /**
   * MCP Protocol version - update when upgrading to newer MCP spec
   * @see https://modelcontextprotocol.io/
   */
  PROTOCOL_VERSION: '2024-11-05',
} as const;
