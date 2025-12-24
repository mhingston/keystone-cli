/**
 * Error renderer for better error messages with context and suggestions.
 * Provides line/column info, source snippets, and actionable suggestions.
 */

export interface ErrorContext {
  /** Error message */
  message: string;
  /** Optional source file path */
  filePath?: string;
  /** Optional source content */
  source?: string;
  /** Line number (1-indexed) */
  line?: number;
  /** Column number (1-indexed) */
  column?: number;
  /** Step ID if error occurred in a step */
  stepId?: string;
  /** Step inputs at time of error */
  stepInputs?: Record<string, unknown>;
  /** Retry attempt count */
  attemptCount?: number;
  /** Step type */
  stepType?: string;
}

export interface FormattedError {
  /** Short error summary */
  summary: string;
  /** Detailed error with context */
  detail: string;
  /** Suggested fixes */
  suggestions: string[];
}

/**
 * Known error patterns and their suggestions
 */
const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  suggestions: (match: RegExpMatchArray, ctx: ErrorContext) => string[];
}> = [
  {
    pattern: /Undefined variable: (\w+)/i,
    suggestions: (match, ctx) => {
      const varName = match[1];
      const hints = [
        `Check if "${varName}" is defined in inputs, steps, or env`,
        `Available root variables: inputs, steps, secrets, env, item, index`,
      ];
      if (varName.startsWith('step')) {
        hints.push(`Did you mean "steps" (plural)?`);
      }
      return hints;
    },
  },
  {
    pattern: /Missing required input: (\w+)/i,
    suggestions: (match) => [
      `Add the input "${match[1]}" when running the workflow`,
      `Example: keystone run workflow.yaml --input ${match[1]}="value"`,
      `Or add a default value in the workflow inputs section`,
    ],
  },
  {
    pattern: /Step (\w+) failed/i,
    suggestions: (match, ctx) => {
      const hints = [`Check the step "${match[1]}" configuration`];
      if (ctx.stepType === 'shell') {
        hints.push('Verify the shell command runs correctly in your terminal');
      }
      if (ctx.stepType === 'llm') {
        hints.push('Check the agent exists and the provider is configured');
      }
      return hints;
    },
  },
  {
    pattern: /Input schema validation failed/i,
    suggestions: () => [
      'Check that step inputs match the inputSchema types',
      'Use --explain flag to see the full schema and actual values',
    ],
  },
  {
    pattern: /Output schema validation failed/i,
    suggestions: () => [
      'The step output does not match the outputSchema',
      'Consider adding outputRetries with repairStrategy for LLM steps',
      'Use --explain flag to see the expected schema vs actual output',
    ],
  },
  {
    pattern: /duplicate mapping key/i,
    suggestions: () => [
      'There are duplicate keys in your YAML file',
      'Check for repeated step IDs or input names',
    ],
  },
  {
    pattern: /bad indentation/i,
    suggestions: () => [
      'Check YAML indentation - use consistent spaces (not tabs)',
      'Nested items should be indented 2 spaces from parent',
    ],
  },
  {
    pattern: /unexpected end of/i,
    suggestions: () => [
      'Check for unclosed quotes, brackets, or braces',
      'Verify YAML structure is complete',
    ],
  },
  {
    pattern: /could not find expected/i,
    suggestions: () => [
      'Check YAML syntax - missing colon after key?',
      'Verify proper quoting for strings with special characters',
    ],
  },
  {
    pattern: /Cannot call method (\w+) on (undefined|null)/i,
    suggestions: (match) => [
      `The value is ${match[2]} when trying to call ${match[1]}()`,
      'Check if the referenced step has completed successfully',
      'Use optional chaining in expressions when values might be undefined',
    ],
  },
  {
    pattern: /Agent "([^"]+)" not found/i,
    suggestions: (match) => [
      `Verify the agent file exists: agents/${match[1]}.md`,
      'Check the path is relative to .keystone/agents/',
    ],
  },
];

/**
 * Extract line and column from YAML error messages
 */
function extractYamlLocation(message: string): { line: number; column: number } | null {
  // Pattern: "at line X, column Y"
  const match = message.match(/at line (\d+),?\s*column (\d+)/i);
  if (match) {
    return {
      line: Number.parseInt(match[1], 10),
      column: Number.parseInt(match[2], 10),
    };
  }
  // Pattern: "line X"
  const lineMatch = message.match(/line (\d+)/i);
  if (lineMatch) {
    return {
      line: Number.parseInt(lineMatch[1], 10),
      column: 1,
    };
  }
  return null;
}

/**
 * Get a source snippet around the error location
 */
function getSourceSnippet(source: string, line: number, column: number, contextLines = 2): string {
  const lines = source.split('\n');
  const startLine = Math.max(0, line - 1 - contextLines);
  const endLine = Math.min(lines.length, line + contextLines);

  const snippetLines: string[] = [];
  const lineNumWidth = String(endLine).length;

  for (let i = startLine; i < endLine; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth, ' ');
    const prefix = i === line - 1 ? '>' : ' ';
    snippetLines.push(`${prefix} ${lineNum} | ${lines[i]}`);

    // Add column indicator for error line
    if (i === line - 1 && column > 0) {
      const indicator = ' '.repeat(lineNumWidth + 4 + column - 1) + '^';
      snippetLines.push(indicator);
    }
  }

  return snippetLines.join('\n');
}

/**
 * Format an error with context and suggestions
 */
export function formatError(ctx: ErrorContext): FormattedError {
  const parts: string[] = [];
  let summary = ctx.message;

  // Try to extract location from message if not provided
  let { line, column } = ctx;
  if (!line) {
    const extracted = extractYamlLocation(ctx.message);
    if (extracted) {
      line = extracted.line;
      column = extracted.column;
    }
  }

  // Build detail message
  if (ctx.filePath) {
    const location = line ? `:${line}${column ? `:${column}` : ''}` : '';
    parts.push(`📍 Location: ${ctx.filePath}${location}`);
  }

  if (ctx.stepId) {
    parts.push(`📋 Step: ${ctx.stepId}${ctx.stepType ? ` (${ctx.stepType})` : ''}`);
    summary = `[${ctx.stepId}] ${summary}`;
  }

  if (ctx.attemptCount && ctx.attemptCount > 1) {
    parts.push(`🔄 Attempt: ${ctx.attemptCount}`);
  }

  parts.push('');
  parts.push(`❌ Error: ${ctx.message}`);

  // Add source snippet if available
  if (ctx.source && line) {
    parts.push('');
    parts.push('📄 Source:');
    parts.push(getSourceSnippet(ctx.source, line, column || 1));
  }

  // Add step inputs if available
  if (ctx.stepInputs && Object.keys(ctx.stepInputs).length > 0) {
    parts.push('');
    parts.push('📥 Step Inputs:');
    parts.push(JSON.stringify(ctx.stepInputs, null, 2));
  }

  // Find matching suggestions
  const suggestions: string[] = [];
  for (const { pattern, suggestions: getSuggestions } of ERROR_PATTERNS) {
    const match = ctx.message.match(pattern);
    if (match) {
      suggestions.push(...getSuggestions(match, ctx));
    }
  }

  if (suggestions.length > 0) {
    parts.push('');
    parts.push('💡 Suggestions:');
    for (const suggestion of suggestions) {
      parts.push(`   • ${suggestion}`);
    }
  }

  return {
    summary,
    detail: parts.join('\n'),
    suggestions,
  };
}

/**
 * Render an error for terminal output (with colors)
 */
export function renderError(ctx: ErrorContext, useColor = true): string {
  const formatted = formatError(ctx);

  if (!useColor) {
    return formatted.detail;
  }

  // Simple ANSI color codes
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const cyan = '\x1b[36m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';

  let output = formatted.detail;

  // Colorize specific parts
  output = output.replace(/^📍.*$/m, (m) => `${cyan}${m}${reset}`);
  output = output.replace(/^📋.*$/m, (m) => `${cyan}${m}${reset}`);
  output = output.replace(/^❌.*$/m, (m) => `${red}${bold}${m}${reset}`);
  output = output.replace(/^💡.*$/m, (m) => `${yellow}${m}${reset}`);
  output = output.replace(/^>.*$/gm, (m) => `${red}${m}${reset}`);
  output = output.replace(/^\s+\^$/m, (m) => `${red}${m}${reset}`);
  output = output.replace(/^ {3}•.*$/gm, (m) => `${dim}${m}${reset}`);

  return output;
}

/**
 * Format a YAML parse error with context
 */
export function formatYamlError(error: Error, source: string, filePath?: string): FormattedError {
  const location = extractYamlLocation(error.message);

  return formatError({
    message: error.message,
    source,
    filePath,
    line: location?.line,
    column: location?.column,
  });
}

/**
 * Format an expression evaluation error
 */
export function formatExpressionError(
  error: Error,
  expression: string,
  stepId?: string
): FormattedError {
  return formatError({
    message: error.message,
    stepId,
    stepInputs: { expression },
  });
}
