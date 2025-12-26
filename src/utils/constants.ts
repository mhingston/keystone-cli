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
