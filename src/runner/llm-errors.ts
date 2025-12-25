/**
 * Standardized error class for LLM provider errors
 * 
 * Provides consistent error formatting across all LLM adapters.
 */

export class LLMProviderError extends Error {
    constructor(
        public readonly provider: string,
        public readonly statusCode: number,
        message: string,
        public readonly retryable = false
    ) {
        super(`[${provider}] API error (${statusCode}): ${message}`);
        this.name = 'LLMProviderError';
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

        return new LLMProviderError(provider, response.status, message, retryable);
    }

    /**
     * Check if error is a rate limit error
     */
    isRateLimitError(): boolean {
        return this.statusCode === 429;
    }

    /**
     * Check if error is an authentication error
     */
    isAuthError(): boolean {
        return this.statusCode === 401 || this.statusCode === 403;
    }
}
