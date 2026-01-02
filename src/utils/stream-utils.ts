import { StringDecoder } from 'node:string_decoder';

export const TRUNCATED_SUFFIX = '\n... [truncated]';

export interface OutputLimiter {
  append(chunk: Buffer | string): void;
  finalize(): string;
  readonly truncated: boolean;
}

/**
 * Creates a limiter that accumulates output up to a maximum number of bytes.
 * Handles multi-byte character boundaries correctly using StringDecoder.
 */
export function createOutputLimiter(maxBytes: number): OutputLimiter {
  let bytes = 0;
  let text = '';
  let truncated = false;
  // Use StringDecoder to correctly handle multi-byte characters split across chunks
  const decoder = new StringDecoder('utf8');

  const append = (chunk: Buffer | string) => {
    if (truncated || maxBytes <= 0) {
      truncated = true;
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (buffer.length <= remaining) {
      text += decoder.write(buffer);
      bytes += buffer.length;
      return;
    }
    // Truncate logic: decode up to allowable bytes
    const sub = buffer.subarray(0, remaining);
    text += decoder.write(sub);
    bytes = maxBytes;
    truncated = true;
  };

  const finalize = () => {
    // Flush any remaining bytes in the decoder
    text += decoder.end();
    return truncated ? `${text}${TRUNCATED_SUFFIX}` : text;
  };

  return {
    append,
    finalize,
    get truncated() {
      return truncated;
    },
  };
}
