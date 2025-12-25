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
  /** Default regex execution timeout for search operations */
  REGEX_TIMEOUT_MS: 1000,
} as const;

/** Limit values for various operations */
export const LIMITS = {
  /** Maximum size for LLM responses to prevent memory exhaustion */
  MAX_RESPONSE_SIZE_BYTES: 1024 * 1024,
  /** Maximum length for search query strings */
  MAX_SEARCH_QUERY_LENGTH: 500,
  /** Maximum messages to keep in LLM conversation history */
  MAX_MESSAGE_HISTORY: 50,
  /** Maximum results from content search */
  MAX_SEARCH_RESULTS: 100,
  /** Maximum entries in the engine version cache */
  VERSION_CACHE_MAX_SIZE: 100,
  /** Maximum size for rate limiter wait queue */
  MAX_RATE_LIMITER_QUEUE_SIZE: 1000,
} as const;

/** Default iteration counts */
export const ITERATIONS = {
  /** Default max iterations for LLM ReAct loop */
  DEFAULT_LLM_MAX_ITERATIONS: 10,
} as const;
