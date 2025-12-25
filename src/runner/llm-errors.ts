/**
 * Standardized error class for LLM provider errors
 * 
 * Provides consistent error formatting across all LLM adapters.
 */

export class LLMProviderError extends Error {
    public readonly retryAfterMs?: number;

    constructor(
        public readonly provider: string,
        public readonly statusCode: number,
        message: string,
        public readonly retryable = false,
        retryAfterMs?: number
    ) {
        super(`[${provider}] API error (${statusCode}): ${message}`);
        this.name = 'LLMProviderError';
        this.retryAfterMs = retryAfterMs;
    }

    /**
     * Create error from HTTP response
     */
    static async fromResponse(
        provider: string,
        response: Response,
        customMessage?: string
    ): Promise<LLMProviderError> {
        let message = customMessage || response.statusText;
        try {
            const text = await response.text();
            if (text) {
                message = `${message} - ${text.slice(0, 500)}`;
            }
        } catch {
            // Ignore error reading body
        }

        // 429 and 5xx errors are typically retryable
        const retryable = response.status === 429 || response.status >= 500;

        // Parse Retry-After header if present
        let retryAfterMs: number | undefined;
        const retryAfterHeader = response.headers.get('Retry-After');
        if (retryAfterHeader) {
            const seconds = Number.parseInt(retryAfterHeader, 10);
            if (!isNaN(seconds)) {
                retryAfterMs = seconds * 1000;
            }
        }

        return new LLMProviderError(provider, response.status, message, retryable, retryAfterMs);
    }

    /**
     * Check if error is a rate limit error
     * Detects both 429 (Too Many Requests) and 503 (Service Unavailable) with rate-related messages
     */
    isRateLimitError(): boolean {
        if (this.statusCode === 429) {
            return true;
        }
        // Some providers return 503 for rate limits
        if (this.statusCode === 503) {
            const lowerMessage = this.message.toLowerCase();
            return lowerMessage.includes('rate') ||
                lowerMessage.includes('quota') ||
                lowerMessage.includes('capacity') ||
                lowerMessage.includes('overloaded');
        }
        return false;
    }

    /**
     * Check if error is an authentication error
     */
    isAuthError(): boolean {
        return this.statusCode === 401 || this.statusCode === 403;
    }
}
