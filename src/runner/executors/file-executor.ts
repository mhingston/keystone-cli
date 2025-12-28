import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { FileStep } from '../../parser/schema.ts';
import { LIMITS } from '../../utils/constants.ts';
import type { Logger } from '../../utils/logger.ts';
import type { StepResult } from './types.ts';

interface DiffHunk {
    originalStart: number;
    originalCount: number;
    lines: string[];
}

interface UnifiedDiff {
    originalFile: string | null;
    newFile: string | null;
    hunks: DiffHunk[];
}

interface SearchReplaceBlock {
    search: string;
    replace: string;
}

function normalizePath(rawPath: string): string {
    const trimmed = rawPath.trim();
    return trimmed.length > 0 ? trimmed : '.';
}

function assertWithinCwd(targetPath: string, allowOutsideCwd?: boolean, label = 'Path'): void {
    if (allowOutsideCwd) return;
    const cwd = process.cwd();
    const realCwd = fs.realpathSync(cwd);
    const normalizedPath = normalizePath(targetPath);
    const resolvedPath = path.resolve(cwd, normalizedPath);

    // Find the first existing ancestor to resolve real path correctly
    let current = resolvedPath;
    while (current !== path.dirname(current) && !fs.existsSync(current)) {
        current = path.dirname(current);
    }
    const realTarget = fs.existsSync(current) ? fs.realpathSync(current) : current;
    const relativePath = path.relative(realCwd, realTarget);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(
            `Access denied: ${label} '${normalizedPath}' resolves outside the working directory. Use 'allowOutsideCwd: true' to override.`
        );
    }
}

function normalizeDiffPath(diffPath: string): string {
    return diffPath.trim().replace(/^([ab]\/)/, '');
}

function assertDiffMatchesTarget(diffPath: string | null, targetPath: string): void {
    if (!diffPath) return;
    const normalizedDiff = normalizeDiffPath(diffPath);
    const normalizedTarget = path.basename(targetPath);

    if (normalizedDiff !== normalizedTarget && !targetPath.endsWith(normalizedDiff)) {
        throw new Error(
            `Diff target path mismatch. Diff says "${normalizedDiff}", but step target is "${targetPath}"`
        );
    }
}

export function parseUnifiedDiff(patch: string): UnifiedDiff {
    const lines = patch.split('\n');
    const result: UnifiedDiff = {
        originalFile: null,
        newFile: null,
        hunks: [],
    };

    let currentHunk: DiffHunk | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('--- ')) {
            result.originalFile = line.slice(4).trim();
            continue;
        }
        if (line.startsWith('+++ ')) {
            result.newFile = line.slice(4).trim();
            continue;
        }

        const hunkHeaderMatch = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (hunkHeaderMatch) {
            if (currentHunk) {
                result.hunks.push(currentHunk);
            }
            currentHunk = {
                originalStart: parseInt(hunkHeaderMatch[1], 10),
                originalCount: hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1,
                lines: [],
            };
            continue;
        }

        if (currentHunk) {
            if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                currentHunk.lines.push(line);
            }
        }
    }

    if (currentHunk) {
        result.hunks.push(currentHunk);
    }

    return result;
}

export function applyUnifiedDiff(content: string, patch: string, targetPath: string): string {
    const diff = parseUnifiedDiff(patch);
    assertDiffMatchesTarget(diff.newFile || diff.originalFile, targetPath);

    const lines = content.split('\n');
    const resultLines = [...lines];

    // Apply hunks in reverse order to keep line numbers valid
    const sortedHunks = [...diff.hunks].sort((a, b) => b.originalStart - a.originalStart);

    for (const hunk of sortedHunks) {
        const startIdx = hunk.originalStart - 1; // 1-indexed to 0-indexed
        const count = hunk.originalCount;

        // Verify context matches if possible
        // (A more robust implementation would look for the context if the line numbers shifted)

        const newLines: string[] = [];
        for (const hLine of hunk.lines) {
            if (hLine.startsWith('-')) continue;
            newLines.push(hLine.slice(1));
        }

        resultLines.splice(startIdx, count, ...newLines);
    }

    return resultLines.join('\n');
}

export function parseSearchReplaceBlocks(patch: string): SearchReplaceBlock[] {
    const blocks: SearchReplaceBlock[] = [];
    const lines = patch.split('\n');

    let currentSearch: string[] | null = null;
    let currentReplace: string[] | null = null;
    let state: 'none' | 'search' | 'replace' = 'none';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.trim() === '<<<<<<< SEARCH') {
            state = 'search';
            currentSearch = [];
            continue;
        }

        if (line.trim() === '=======') {
            state = 'replace';
            currentReplace = [];
            continue;
        }

        if (line.trim() === '>>>>>>> REPLACE') {
            if (currentSearch !== null && currentReplace !== null) {
                blocks.push({
                    search: currentSearch.join('\n'),
                    replace: currentReplace.join('\n'),
                });
            }
            state = 'none';
            currentSearch = null;
            currentReplace = null;
            continue;
        }

        if (state === 'search' && currentSearch !== null) {
            currentSearch.push(line);
        } else if (state === 'replace' && currentReplace !== null) {
            currentReplace.push(line);
        }
    }

    return blocks;
}

export function applySearchReplaceBlocks(content: string, blocks: SearchReplaceBlock[]): string {
    let result = content;

    for (const block of blocks) {
        if (!result.includes(block.search)) {
            // Try with different line endings or slight whitespace variations?
            // For now, strict match
            throw new Error(
                `Search block not found in file. Ensure exact match including whitespace:\n${block.search.substring(0, 100)}...`
            );
        }
        result = result.replace(block.search, block.replace);
    }

    return result;
}

/**
 * Execute a file step
 */
export async function executeFileStep(
    step: FileStep,
    context: ExpressionContext,
    _logger: Logger
): Promise<StepResult> {
    const targetPath = ExpressionEvaluator.evaluateString(step.path, context);
    assertWithinCwd(targetPath, step.allowOutsideCwd);

    switch (step.op) {
        case 'read': {
            if (!fs.existsSync(targetPath)) {
                throw new Error(`File not found: ${targetPath}`);
            }
            const stat = fs.statSync(targetPath);
            if (stat.size > LIMITS.MAX_FILE_READ_BYTES) {
                throw new Error(
                    `File exceeds maximum read size of ${LIMITS.MAX_FILE_READ_BYTES} bytes: ${targetPath}`
                );
            }
            const content = await Bun.file(targetPath).text();
            return {
                output: { content, path: targetPath, bytes: stat.size },
                status: 'success',
            };
        }

        case 'write': {
            if (step.content === undefined) {
                throw new Error('Content is required for write operation');
            }
            const content = ExpressionEvaluator.evaluateString(step.content, context);

            // Ensure parent directory exists
            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            await Bun.write(targetPath, content);
            return {
                output: { path: targetPath, bytes: content.length },
                status: 'success',
            };
        }

        case 'append': {
            if (step.content === undefined) {
                throw new Error('Content is required for append operation');
            }
            const content = ExpressionEvaluator.evaluateString(step.content, context);

            // Ensure parent directory exists
            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            await fs.promises.appendFile(targetPath, content);

            return {
                output: { path: targetPath, bytes: content.length },
                status: 'success',
            };
        }

        case 'patch': {
            if (step.content === undefined) {
                throw new Error('Content is required for patch operation');
            }

            if (!fs.existsSync(targetPath)) {
                throw new Error(`File not found: ${targetPath}`);
            }

            const stat = fs.statSync(targetPath);
            if (stat.size > LIMITS.MAX_FILE_READ_BYTES) {
                throw new Error(
                    `File exceeds maximum read size of ${LIMITS.MAX_FILE_READ_BYTES} bytes: ${targetPath}`
                );
            }

            const patch = ExpressionEvaluator.evaluateString(step.content, context);
            const original = await Bun.file(targetPath).text();

            let updated: string;
            const searchReplaceBlocks = parseSearchReplaceBlocks(patch);
            if (searchReplaceBlocks.length > 0) {
                updated = applySearchReplaceBlocks(original, searchReplaceBlocks);
            } else {
                updated = applyUnifiedDiff(original, patch, targetPath);
            }

            await Bun.write(targetPath, updated);
            return {
                output: { path: targetPath, bytes: updated.length },
                status: 'success',
            };
        }

        default:
            throw new Error(`Unknown file operation: ${(step as any).op}`);
    }
}
