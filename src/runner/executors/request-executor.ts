import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { RequestStep } from '../../parser/schema.ts';
import { TIMEOUTS, LIMITS } from '../../utils/constants.ts';
import type { Logger } from '../../utils/logger.ts';
import { validateRemoteUrl } from '../mcp-client.ts';
import type { StepResult } from './types.ts';

async function readResponseTextWithLimit(
    response: Response,
    maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) {
        return { text: '', truncated: false };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytesRead = 0;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        if (bytesRead + value.byteLength > maxBytes) {
            const allowed = maxBytes - bytesRead;
            if (allowed > 0) {
                text += decoder.decode(value.slice(0, allowed), { stream: true });
            }
            text += decoder.decode();
            try {
                await reader.cancel();
            } catch { }
            return { text, truncated: true };
        }

        bytesRead += value.byteLength;
        text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
    return { text, truncated: false };
}

/**
 * Execute an HTTP request step
 */
export async function executeRequestStep(
    step: RequestStep,
    context: ExpressionContext,
    _logger: Logger,
    abortSignal?: AbortSignal
): Promise<StepResult> {
    if (abortSignal?.aborted) {
        throw new Error('Step canceled');
    }
    const url = ExpressionEvaluator.evaluateString(step.url, context);
    const requestTimeoutMs = step.timeout ?? TIMEOUTS.DEFAULT_HTTP_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('Step canceled'));
    if (abortSignal) {
        if (abortSignal.aborted) {
            onAbort();
        } else {
            abortSignal.addEventListener('abort', onAbort, { once: true });
        }
    }
    const timeoutId = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${requestTimeoutMs}ms`));
    }, requestTimeoutMs);

    try {
        // Validate URL to prevent SSRF
        await validateRemoteUrl(url, { allowInsecure: step.allowInsecure });

        // Evaluate headers
        const headers: Record<string, string> = {};
        if (step.headers) {
            for (const [key, value] of Object.entries(step.headers)) {
                headers[key] = ExpressionEvaluator.evaluateString(value, context);
            }
        }

        // Evaluate body
        let body: string | undefined;
        if (step.body !== undefined) {
            const evaluatedBody = ExpressionEvaluator.evaluateObject(step.body, context);

            const contentType = Object.entries(headers).find(
                ([k]) => k.toLowerCase() === 'content-type'
            )?.[1];

            if (contentType?.includes('application/x-www-form-urlencoded')) {
                if (typeof evaluatedBody === 'object' && evaluatedBody !== null) {
                    const params = new URLSearchParams();
                    for (const [key, value] of Object.entries(evaluatedBody)) {
                        params.append(key, String(value));
                    }
                    body = params.toString();
                } else {
                    body = String(evaluatedBody);
                }
            } else {
                // Default to JSON if not form-encoded and not already a string
                body = typeof evaluatedBody === 'string' ? evaluatedBody : JSON.stringify(evaluatedBody);

                // Auto-set Content-Type to application/json if not already set and body is an object
                if (!contentType && typeof evaluatedBody === 'object' && evaluatedBody !== null) {
                    headers['Content-Type'] = 'application/json';
                }
            }
        }

        const maxRedirects = 5;
        let response: Response | undefined;
        let currentUrl = url;
        let currentMethod = step.method;
        let currentBody = body;
        const currentHeaders: Record<string, string> = { ...headers };
        const safeCrossOriginHeaders = new Set(['accept', 'accept-language', 'user-agent']);
        const removeHeader = (name: string) => {
            const target = name.toLowerCase();
            for (const key of Object.keys(currentHeaders)) {
                if (key.toLowerCase() === target) {
                    delete currentHeaders[key];
                }
            }
        };
        const stripCrossOriginHeaders = () => {
            for (const key of Object.keys(currentHeaders)) {
                if (!safeCrossOriginHeaders.has(key.toLowerCase())) {
                    delete currentHeaders[key];
                }
            }
        };

        for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
            response = await fetch(currentUrl, {
                method: currentMethod,
                headers: currentHeaders,
                body: currentBody,
                redirect: 'manual',
                signal: controller.signal,
            });

            // Early rejection for oversized responses based on Content-Length
            // This prevents unnecessary memory allocation for responses we know are too large
            const contentLength = response.headers.get('content-length');
            if (contentLength) {
                const expectedSize = parseInt(contentLength, 10);
                if (!Number.isNaN(expectedSize) && expectedSize > LIMITS.MAX_HTTP_RESPONSE_BYTES) {
                    throw new Error(
                        `Response too large: Content-Length ${expectedSize} bytes exceeds limit of ${LIMITS.MAX_HTTP_RESPONSE_BYTES} bytes`
                    );
                }
            }

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (!location) {
                    break;
                }
                if (redirectCount >= maxRedirects) {
                    throw new Error(`Request exceeded maximum redirects (${maxRedirects})`);
                }

                const nextUrl = new URL(location, currentUrl).href;
                await validateRemoteUrl(nextUrl, { allowInsecure: step.allowInsecure });

                let nextMethod = currentMethod;
                let nextBody = currentBody;
                if (
                    response.status === 303 ||
                    ((response.status === 301 || response.status === 302) &&
                        currentMethod !== 'GET' &&
                        currentMethod !== 'HEAD')
                ) {
                    nextMethod = 'GET';
                    nextBody = undefined;
                    removeHeader('content-type');
                }

                const fromOrigin = new URL(currentUrl).origin;
                const toOrigin = new URL(nextUrl).origin;
                if (fromOrigin !== toOrigin) {
                    removeHeader('authorization');
                    removeHeader('proxy-authorization');
                    removeHeader('cookie');
                    if (!step.allowInsecure) {
                        if (nextMethod !== 'GET' && nextMethod !== 'HEAD') {
                            throw new Error(
                                `Cross-origin redirect blocked for ${nextMethod} request. Set allowInsecure to true to override.`
                            );
                        }
                        stripCrossOriginHeaders();
                    }
                }

                currentMethod = nextMethod;
                currentBody = nextBody;
                currentUrl = nextUrl;
                continue;
            }

            break;
        }

        if (!response) {
            throw new Error('Request failed: No response received');
        }

        const maxResponseBytes = LIMITS.MAX_HTTP_RESPONSE_BYTES;
        const { text: responseText, truncated } = await readResponseTextWithLimit(
            response,
            maxResponseBytes
        );
        let responseData: unknown;

        try {
            responseData = JSON.parse(responseText);
        } catch {
            responseData = responseText;
        }

        return {
            output: {
                status: response.status,
                statusText: response.statusText,
                headers: (() => {
                    const h: Record<string, string> = {};
                    response.headers.forEach((v, k) => {
                        h[k] = v;
                    });
                    return h;
                })(),
                data: responseData,
                truncated,
                maxBytes: maxResponseBytes,
            },
            status: response.ok ? 'success' : 'failed',
            error: response.ok
                ? undefined
                : `HTTP ${response.status}: ${response.statusText}${responseText
                    ? `\nResponse Body: ${responseText.substring(0, 500)}${responseText.length > 500 ? '...' : ''}${truncated ? ' [truncated]' : ''
                    }`
                    : truncated
                        ? '\nResponse Body: [truncated]'
                        : ''
                }`,
        };
    } finally {
        clearTimeout(timeoutId);
        if (abortSignal) {
            abortSignal.removeEventListener('abort', onAbort);
        }
    }
}
