/**
 * Robustly extract JSON from a string that may contain other text or Markdown blocks.
 */
export function extractJson(text: string): any {
    if (!text) return null;

    // 1. Try to extract from Markdown code blocks first
    const markdownRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    let match: RegExpExecArray | null;
    const blocks: string[] = [];

    while ((match = markdownRegex.exec(text)) !== null) {
        blocks.push(match[1].trim());
    }

    if (blocks.length > 0) {
        // If there are multiple blocks, try to parse them. Use the first one that is valid JSON.
        for (const block of blocks) {
            try {
                return JSON.parse(block);
            } catch (e) {
                // Continue to next block
            }
        }
    }

    // 2. Fallback: Find the first occurrence of { or [ and try to find its balanced closing counterpart
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');

    // Start from whichever comes first
    let startIndex = -1;
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIndex = firstBrace;
    } else if (firstBracket !== -1) {
        startIndex = firstBracket;
    }

    if (startIndex !== -1) {
        const stopper = text[startIndex] === '{' ? '}' : ']';
        const opener = text[startIndex];

        // Simple balanced brace matching
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = startIndex; i < text.length; i++) {
            const char = text[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === opener) {
                    depth++;
                } else if (char === stopper) {
                    depth--;
                    if (depth === 0) {
                        const potentialJson = text.substring(startIndex, i + 1);
                        try {
                            return JSON.parse(potentialJson);
                        } catch (e) {
                            // Not valid JSON, keep looking for another matching brace if possible?
                            // Actually, if it's not valid yet, it might be a sub-brace.
                            // But we are tracking depth, so if we hit 0 and it's invalid, it's likely just bad text.
                        }
                    }
                }
            }
        }
    }

    // 3. Last ditch effort: Try parsing the whole thing as is (after trimming)
    try {
        return JSON.parse(text.trim());
    } catch (e) {
        throw new Error(`Failed to extract valid JSON from LLM response. Content: ${text.substring(0, 100)}...`);
    }
}
