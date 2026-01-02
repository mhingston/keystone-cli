import { LLM } from '../../../utils/constants';
import type { Logger } from '../../../utils/logger';

const { THINKING_OPEN_TAG, THINKING_CLOSE_TAG } = LLM;

export class ThoughtStreamParser {
  private buffer = '';
  private thoughtBuffer = '';
  private inThinking = false;

  process(chunk: string): { output: string; thoughts: string[] } {
    this.buffer += chunk;
    const thoughts: string[] = [];
    let output = '';

    while (this.buffer.length > 0) {
      const lower = this.buffer.toLowerCase();
      if (!this.inThinking) {
        const openIndex = lower.indexOf(THINKING_OPEN_TAG);
        if (openIndex === -1) {
          const keep = Math.max(0, this.buffer.length - (THINKING_OPEN_TAG.length - 1));
          output += this.buffer.slice(0, keep);
          this.buffer = this.buffer.slice(keep);
          break;
        }
        output += this.buffer.slice(0, openIndex);
        this.buffer = this.buffer.slice(openIndex + THINKING_OPEN_TAG.length);
        this.inThinking = true;
        continue;
      }

      const closeIndex = lower.indexOf(THINKING_CLOSE_TAG);
      if (closeIndex === -1) {
        const keep = Math.max(0, this.buffer.length - (THINKING_CLOSE_TAG.length - 1));
        this.thoughtBuffer += this.buffer.slice(0, keep);
        this.buffer = this.buffer.slice(keep);
        break;
      }
      this.thoughtBuffer += this.buffer.slice(0, closeIndex);
      this.buffer = this.buffer.slice(closeIndex + THINKING_CLOSE_TAG.length);
      this.inThinking = false;
      const thought = this.thoughtBuffer.trim();
      if (thought) {
        thoughts.push(thought);
      }
      this.thoughtBuffer = '';
    }

    return { output, thoughts };
  }

  flush(): { output: string; thoughts: string[] } {
    const thoughts: string[] = [];
    let output = '';

    if (this.inThinking) {
      this.thoughtBuffer += this.buffer;
      const thought = this.thoughtBuffer.trim();
      if (thought) {
        thoughts.push(thought);
      }
    } else {
      output = this.buffer;
    }

    this.buffer = '';
    this.thoughtBuffer = '';
    this.inThinking = false;
    return { output, thoughts };
  }
}

export class StreamHandler {
  private parser = new ThoughtStreamParser();

  constructor(private logger: Logger) {}

  processChunk(chunk: string): { text: string; thoughts: string[] } {
    const { output, thoughts } = this.parser.process(chunk);

    if (thoughts.length > 0) {
      for (const t of thoughts) {
        this.logger.log(`  💭 ${t}`);
      }
    }

    // We might want to stream output to logger or just accumulate it
    // The executor typically accumulates full text.
    // For now, just return parsed parts.

    return { text: output, thoughts };
  }

  flush(): { text: string; thoughts: string[] } {
    const { output, thoughts } = this.parser.flush();
    if (thoughts.length > 0) {
      for (const t of thoughts) {
        this.logger.log(`  💭 ${t}`);
      }
    }
    return { text: output, thoughts };
  }
}
