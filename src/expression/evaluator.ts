import jsepArrow from '@jsep-plugin/arrow';
import jsepObject from '@jsep-plugin/object';
import jsep from 'jsep';
import { escapeShellArg } from '../runner/shell-executor.ts';

// Register plugins
jsep.plugins.register(jsepArrow);
jsep.plugins.register(jsepObject);

/**
 * Expression evaluator for ${{ }} syntax
 * Supports:
 * - inputs.field
 * - secrets.KEY
 * - steps.step_id.output
 * - steps.step_id.outputs.field
 * - item (for foreach)
 * - Basic JS expressions (arithmetic, comparisons, logical operators)
 * - Array access, method calls (map, filter, every, etc.)
 * - Ternary operator
 *
 * ⚠️ SECURITY:
 * This evaluator uses AST-based parsing (jsep) to safely evaluate expressions
 * without executing arbitrary code. Only whitelisted operations are allowed.
 */

export interface ExpressionContext {
  inputs?: Record<string, unknown>;
  secrets?: Record<string, string>;
  steps?: Record<string, { output?: unknown; outputs?: Record<string, unknown>; status?: string }>;
  item?: unknown;
  index?: number;
  env?: Record<string, string>;
  output?: unknown;
}

type ASTNode = jsep.Expression;

interface ArrowFunctionExpression extends jsep.Expression {
  type: 'ArrowFunctionExpression';
  params: jsep.Identifier[];
  body: jsep.Expression;
}

interface ObjectProperty extends jsep.Expression {
  type: 'Property';
  key: jsep.Expression;
  value: jsep.Expression;
  computed: boolean;
  shorthand: boolean;
}

interface ObjectExpression extends jsep.Expression {
  type: 'ObjectExpression';
  properties: ObjectProperty[];
}

export class ExpressionEvaluator {
  // Pre-compiled regex for performance - handles nested braces (up to 3 levels)
  private static readonly EXPRESSION_REGEX =
    /\$\{\{(?:[^{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\}\}/g;
  private static readonly SINGLE_EXPRESSION_REGEX =
    /^\s*\$\{\{(?:[^{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\}\}\s*$/;
  // Non-global version for hasExpression to avoid lastIndex state issues with global regex
  private static readonly HAS_EXPRESSION_REGEX =
    /\$\{\{(?:[^{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\}\}/;

  // Forbidden properties for security - prevents prototype pollution
  private static readonly FORBIDDEN_PROPERTIES = new Set([
    'constructor',
    '__proto__',
    'prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ]);

  /**
   * Evaluate a string that may contain ${{ }} expressions
   */
  static evaluate(template: string, context: ExpressionContext): unknown {
    const expressionRegex = new RegExp(ExpressionEvaluator.EXPRESSION_REGEX.source, 'g');

    // If the entire string is a single expression, return the evaluated value directly
    const singleExprMatch = template.match(ExpressionEvaluator.SINGLE_EXPRESSION_REGEX);
    if (singleExprMatch) {
      // Extract the expression content between ${{ and }}
      const expr = singleExprMatch[0].replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '');
      return ExpressionEvaluator.evaluateExpression(expr, context);
    }

    // Otherwise, replace all expressions in the string
    return template.replace(expressionRegex, (match) => {
      // Extract the expression content between ${{ and }}
      const expr = match.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      const result = ExpressionEvaluator.evaluateExpression(expr, context);

      if (result === null || result === undefined) {
        return '';
      }

      if (typeof result === 'object' && result !== null) {
        // Special handling for shell command results to avoid [object Object] or JSON in commands
        if (
          'stdout' in result &&
          'exitCode' in result &&
          typeof (result as Record<string, unknown>).stdout === 'string'
        ) {
          return ((result as Record<string, unknown>).stdout as string).trim();
        }
        return JSON.stringify(result, null, 2);
      }

      return String(result);
    });
  }

  /**
   * Evaluate a string and ensure the result is a string.
   * Objects and arrays are stringified to JSON.
   * null and undefined return an empty string.
   */
  static evaluateString(template: string, context: ExpressionContext): string {
    const result = ExpressionEvaluator.evaluate(template, context);

    if (result === null || result === undefined) {
      return '';
    }

    if (typeof result === 'string') {
      return result;
    }

    return JSON.stringify(result, null, 2);
  }

  /**
   * Evaluate a single expression (without the ${{ }} wrapper)
   * This is public to support transform expressions in shell steps
   */
  static evaluateExpression(expr: string, context: ExpressionContext): unknown {
    try {
      const ast = jsep(expr);
      return ExpressionEvaluator.evaluateNode(ast, context);
    } catch (error) {
      throw new Error(
        `Failed to evaluate expression "${expr}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Evaluate an AST node recursively
   */
  private static evaluateNode(node: ASTNode, context: ExpressionContext): unknown {
    switch (node.type) {
      case 'Literal':
        return (node as jsep.Literal).value;

      case 'Identifier': {
        const name = (node as jsep.Identifier).name;

        // Safe global functions and values
        const safeGlobals: Record<string, unknown> = {
          Boolean: Boolean,
          Number: Number,
          String: String,
          // Array: Array, // Disabled for security (DoS prevention)
          Object: Object,
          Math: Math,
          Date: Date,
          JSON: JSON,
          parseInt: Number.parseInt,
          parseFloat: Number.parseFloat,
          isNaN: Number.isNaN,
          isFinite: Number.isFinite,
          undefined: undefined,
          null: null,
          NaN: Number.NaN,
          Infinity: Number.POSITIVE_INFINITY,
          true: true,
          false: false,
          escape: escapeShellArg, // Shell argument escaping for safe command execution
        };

        // Check if it's an arrow function parameter (stored directly in context)
        const contextAsRecord = context as Record<string, unknown>;
        if (name in contextAsRecord && contextAsRecord[name] !== undefined) {
          return contextAsRecord[name];
        }

        // Check safe globals
        if (name in safeGlobals) {
          return safeGlobals[name];
        }

        // Root context variables
        const rootContext: Record<string, unknown> = {
          inputs: context.inputs || {},
          secrets: context.secrets || {},
          steps: context.steps || {},
          item: context.item,
          index: context.index,
          env: context.env || {},
          stdout: contextAsRecord.stdout, // For transform expressions
        };

        if (name in rootContext && rootContext[name] !== undefined) {
          return rootContext[name];
        }

        throw new Error(`Undefined variable: ${name}`);
      }

      case 'MemberExpression': {
        const memberNode = node as jsep.MemberExpression;
        const object = ExpressionEvaluator.evaluateNode(memberNode.object, context);

        if (object === null || object === undefined) {
          return undefined;
        }

        let property: string | number;
        if (memberNode.computed) {
          // Computed access: obj[expr]
          property = ExpressionEvaluator.evaluateNode(memberNode.property, context) as
            | string
            | number;
        } else {
          // Dot access: obj.prop
          property = (memberNode.property as jsep.Identifier).name;
        }

        const propertyAsRecord = object as Record<string | number, unknown>;

        // Security check for sensitive properties - normalize and check
        if (typeof property === 'string') {
          // Normalize the property name to catch bypass attempts (e.g., via unicode or encoded strings)
          const normalizedProperty = property.normalize('NFKC').toLowerCase();
          const propertyLower = property.toLowerCase();

          // Check both original and normalized forms
          if (
            ExpressionEvaluator.FORBIDDEN_PROPERTIES.has(property) ||
            ExpressionEvaluator.FORBIDDEN_PROPERTIES.has(propertyLower) ||
            normalizedProperty.includes('proto') ||
            normalizedProperty.includes('constructor')
          ) {
            throw new Error(`Access to property "${property}" is forbidden for security reasons`);
          }
        }

        return propertyAsRecord[property];
      }

      case 'BinaryExpression': {
        const binaryNode = node as jsep.BinaryExpression;
        const left = ExpressionEvaluator.evaluateNode(binaryNode.left, context);

        // Short-circuit for logical operators that jsep might parse as BinaryExpression
        if (binaryNode.operator === '&&') {
          return left && ExpressionEvaluator.evaluateNode(binaryNode.right, context);
        }
        if (binaryNode.operator === '||') {
          return left || ExpressionEvaluator.evaluateNode(binaryNode.right, context);
        }

        const right = ExpressionEvaluator.evaluateNode(binaryNode.right, context);

        switch (binaryNode.operator) {
          case '+':
            return (left as number) + (right as number);
          case '-':
            return (left as number) - (right as number);
          case '*':
            return (left as number) * (right as number);
          case '/':
            return (left as number) / (right as number);
          case '%':
            return (left as number) % (right as number);
          case '==':
            // Use loose equality to match non-programmer expectations (e.g. "5" == 5)
            // Strict equality is available via ===
            // biome-ignore lint/suspicious/noDoubleEquals: Intentional loose equality for expression language
            return left == right;
          case '===':
            return left === right;
          case '!=':
            // biome-ignore lint/suspicious/noDoubleEquals: Intentional loose inequality for expression language
            return left != right;
          case '!==':
            return left !== right;
          case '<':
            return (left as number) < (right as number);
          case '<=':
            return (left as number) <= (right as number);
          case '>':
            return (left as number) > (right as number);
          case '>=':
            return (left as number) >= (right as number);
          default:
            throw new Error(`Unsupported binary operator: ${binaryNode.operator}`);
        }
      }

      case 'UnaryExpression': {
        const unaryNode = node as jsep.UnaryExpression;
        const argument = ExpressionEvaluator.evaluateNode(unaryNode.argument, context);

        switch (unaryNode.operator) {
          case '-':
            return -(argument as number);
          case '+':
            return +(argument as number);
          case '!':
            return !argument;
          default:
            throw new Error(`Unsupported unary operator: ${unaryNode.operator}`);
        }
      }

      case 'LogicalExpression': {
        const logicalNode = node as unknown as { left: ASTNode; right: ASTNode; operator: string };
        const left = ExpressionEvaluator.evaluateNode(logicalNode.left, context);

        // Short-circuit evaluation
        if (logicalNode.operator === '&&' && !left) {
          return left;
        }
        if (logicalNode.operator === '||' && left) {
          return left;
        }

        return ExpressionEvaluator.evaluateNode(logicalNode.right, context);
      }

      case 'ConditionalExpression': {
        const conditionalNode = node as jsep.ConditionalExpression;
        const test = ExpressionEvaluator.evaluateNode(conditionalNode.test, context);
        return test
          ? ExpressionEvaluator.evaluateNode(conditionalNode.consequent, context)
          : ExpressionEvaluator.evaluateNode(conditionalNode.alternate, context);
      }

      case 'ArrayExpression': {
        const arrayNode = node as jsep.ArrayExpression;
        return arrayNode.elements.map((elem) =>
          elem ? ExpressionEvaluator.evaluateNode(elem, context) : null
        );
      }

      case 'ObjectExpression': {
        const objectNode = node as unknown as ObjectExpression;
        const result: Record<string, unknown> = {};
        for (const prop of objectNode.properties) {
          const key =
            prop.key.type === 'Identifier' && !prop.computed
              ? (prop.key as jsep.Identifier).name
              : ExpressionEvaluator.evaluateNode(prop.key, context);
          result[key as string] = ExpressionEvaluator.evaluateNode(prop.value, context);
        }
        return result;
      }

      case 'CallExpression': {
        const callNode = node as jsep.CallExpression;

        // Evaluate the callee (could be a member expression like arr.map or an identifier like escape())
        if (callNode.callee.type === 'MemberExpression') {
          const memberNode = callNode.callee as jsep.MemberExpression;
          const object = ExpressionEvaluator.evaluateNode(memberNode.object, context);

          let methodName: string;
          if (memberNode.computed) {
            const evaluated = ExpressionEvaluator.evaluateNode(memberNode.property, context);
            methodName = String(evaluated);
          } else {
            methodName = (memberNode.property as jsep.Identifier).name;
          }

          // Evaluate arguments, handling arrow functions specially
          const args = callNode.arguments.map((arg) => {
            if (arg.type === 'ArrowFunctionExpression') {
              return ExpressionEvaluator.createArrowFunction(
                arg as ArrowFunctionExpression,
                context
              );
            }
            return ExpressionEvaluator.evaluateNode(arg, context);
          });

          // Allow only safe array/string/number methods
          const safeMethods = [
            // Array methods
            'map',
            'filter',
            'reduce',
            'every',
            'some',
            'find',
            'findIndex',
            'includes',
            'indexOf',
            'slice',
            'concat',
            'join',
            'flat',
            'flatMap',
            'reverse',
            'sort',
            // String methods
            'split',
            'toLowerCase',
            'toUpperCase',
            'trim',
            'trimStart',
            'trimEnd',
            'startsWith',
            'endsWith',
            'replace',
            'replaceAll',
            'match',
            'toString',
            'charAt',
            'charCodeAt',
            'substring',
            'substr',
            'padStart',
            'padEnd',
            // 'repeat', // Disabled for security (DoS prevention)
            'normalize',
            'localeCompare',
            // Number methods
            'toFixed',
            'toPrecision',
            'toExponential',
            'toLocaleString',
            // Math methods
            'max',
            'min',
            'abs',
            'round',
            'floor',
            'ceil',
            'pow',
            'sqrt',
            'random',
            // Object/JSON methods
            'stringify',
            'parse',
            'keys',
            'values',
            'entries',
            'hasOwnProperty',
            // General
            'length',
          ];

          if (!safeMethods.includes(methodName)) {
            throw new Error(`Method ${methodName} is not allowed`);
          }

          // For methods that take callbacks (map, filter, etc.), we need special handling
          // Since we can't pass AST nodes directly, we'll handle the most common patterns
          if (object && typeof (object as Record<string, unknown>)[methodName] === 'function') {
            const method = (object as Record<string, unknown>)[methodName] as (
              ...args: unknown[]
            ) => unknown;
            return method.call(object, ...args);
          }

          throw new Error(`Cannot call method ${methodName} on ${typeof object}`);
        }

        // Handle standalone function calls (e.g., escape())
        if (callNode.callee.type === 'Identifier') {
          const functionName = (callNode.callee as jsep.Identifier).name;

          // Get the function from safe globals or context
          const func = ExpressionEvaluator.evaluateNode(callNode.callee, context);

          if (typeof func !== 'function') {
            throw new Error(`${functionName} is not a function`);
          }

          // Evaluate arguments
          const args = callNode.arguments.map((arg) => {
            if (arg.type === 'ArrowFunctionExpression') {
              return ExpressionEvaluator.createArrowFunction(
                arg as ArrowFunctionExpression,
                context
              );
            }
            return ExpressionEvaluator.evaluateNode(arg, context);
          });

          return func(...args);
        }

        throw new Error('Only method calls and safe function calls are supported');
      }

      case 'ArrowFunctionExpression': {
        // Arrow functions should be handled in the context of CallExpression
        // If we reach here, it means they're being used outside of a method call
        return ExpressionEvaluator.createArrowFunction(node as ArrowFunctionExpression, context);
      }

      default:
        throw new Error(`Unsupported expression type: ${node.type}`);
    }
  }

  /**
   * Create a JavaScript function from an arrow function AST node
   */
  private static createArrowFunction(
    arrowNode: ArrowFunctionExpression,
    context: ExpressionContext
  ): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
      // Create a new context with arrow function parameters
      const arrowContext = { ...context };

      // Bind parameters to arguments
      arrowNode.params.forEach((param, index) => {
        const paramName = param.name;
        // Store parameter values in the context at the root level
        (arrowContext as Record<string, unknown>)[paramName] = args[index];
      });

      // Evaluate the body with the new context
      return ExpressionEvaluator.evaluateNode(arrowNode.body, arrowContext);
    };
  }

  /**
   * Check if a string contains any expressions
   */
  static hasExpression(str: string): boolean {
    // Use non-global regex to avoid lastIndex state issues
    return ExpressionEvaluator.HAS_EXPRESSION_REGEX.test(str);
  }

  /**
   * Recursively evaluate all expressions in an object
   */
  static evaluateObject(obj: unknown, context: ExpressionContext): unknown {
    if (typeof obj === 'string') {
      return ExpressionEvaluator.evaluate(obj, context);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => ExpressionEvaluator.evaluateObject(item, context));
    }

    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = ExpressionEvaluator.evaluateObject(value, context);
      }
      return result;
    }

    return obj;
  }

  /**
   * Extract step IDs that this template depends on
   */
  static findStepDependencies(template: string): string[] {
    const dependencies = new Set<string>();
    const expressionRegex = new RegExp(ExpressionEvaluator.EXPRESSION_REGEX.source, 'g');
    const matches = template.matchAll(expressionRegex);

    for (const match of matches) {
      const expr = match[0].replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      try {
        const ast = jsep(expr);
        ExpressionEvaluator.collectStepIds(ast, dependencies);
      } catch {
        // Ignore parse errors, they'll be handled at runtime
      }
    }

    return Array.from(dependencies);
  }

  /**
   * Recursively find step IDs in an AST node
   */
  private static collectStepIds(node: jsep.Expression, dependencies: Set<string>): void {
    if (!node) return;

    if (node.type === 'MemberExpression') {
      const memberNode = node as jsep.MemberExpression;
      if (
        memberNode.object.type === 'Identifier' &&
        (memberNode.object as jsep.Identifier).name === 'steps'
      ) {
        if (memberNode.property.type === 'Identifier' && !memberNode.computed) {
          dependencies.add((memberNode.property as jsep.Identifier).name);
        } else if (memberNode.property.type === 'Literal' && memberNode.computed) {
          dependencies.add(String((memberNode.property as jsep.Literal).value));
        }
        return;
      }
    }

    // Generic traversal
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key];
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof (item as jsep.Expression).type === 'string') {
              ExpressionEvaluator.collectStepIds(item as jsep.Expression, dependencies);
            }
          }
        } else if (typeof (child as jsep.Expression).type === 'string') {
          ExpressionEvaluator.collectStepIds(child as jsep.Expression, dependencies);
        }
      }
    }
  }
}
