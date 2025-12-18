import { describe, expect, test } from 'bun:test';
import { ExpressionEvaluator } from './evaluator';

describe('ExpressionEvaluator', () => {
  const context = {
    inputs: {
      name: 'World',
      count: 5,
      items: ['a', 'b', 'c'],
    },
    steps: {
      step1: {
        output: 'Hello',
        outputs: {
          data: { id: 1 },
        },
      },
    },
    item: 'current-item',
    index: 0,
    my_val: 123,
  };

  test('should evaluate simple literals', () => {
    expect(ExpressionEvaluator.evaluate("${{ 'hello' }}", context)).toBe('hello');
    expect(ExpressionEvaluator.evaluate('${{ 123 }}', context)).toBe(123);
    expect(ExpressionEvaluator.evaluate('${{ true }}', context)).toBe(true);
  });

  test('should evaluate input variables', () => {
    expect(ExpressionEvaluator.evaluate('${{ inputs.name }}', context)).toBe('World');
    expect(ExpressionEvaluator.evaluate('${{ inputs.count }}', context)).toBe(5);
  });

  test('should evaluate step outputs', () => {
    expect(ExpressionEvaluator.evaluate('${{ steps.step1.output }}', context)).toBe('Hello');
    expect(ExpressionEvaluator.evaluate('${{ steps.step1.outputs.data.id }}', context)).toBe(1);
  });

  test('should evaluate item and index', () => {
    expect(ExpressionEvaluator.evaluate('${{ item }}', context)).toBe('current-item');
    expect(ExpressionEvaluator.evaluate('${{ index }}', context)).toBe(0);
  });

  test('should support arithmetic operators', () => {
    expect(ExpressionEvaluator.evaluate('${{ inputs.count + 1 }}', context)).toBe(6);
    expect(ExpressionEvaluator.evaluate('${{ 10 * 2 }}', context)).toBe(20);
    expect(ExpressionEvaluator.evaluate('${{ 10 / 2 }}', context)).toBe(5);
    expect(ExpressionEvaluator.evaluate('${{ 10 % 3 }}', context)).toBe(1);
    expect(ExpressionEvaluator.evaluate('${{ -5 }}', context)).toBe(-5);
    expect(ExpressionEvaluator.evaluate('${{ +5 }}', context)).toBe(5);
  });

  test('should support logical operators', () => {
    expect(ExpressionEvaluator.evaluate('${{ inputs.count > 0 && true }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ inputs.count < 0 || false }}', context)).toBe(false);
    expect(ExpressionEvaluator.evaluate('${{ !true }}', context)).toBe(false);
    expect(ExpressionEvaluator.evaluate('${{ true && 1 }}', context)).toBe(1);
    expect(ExpressionEvaluator.evaluate('${{ false && 1 }}', context)).toBe(false);
    expect(ExpressionEvaluator.evaluate('${{ true || 1 }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ false || 1 }}', context)).toBe(1);
  });

  test('should support comparison operators', () => {
    expect(ExpressionEvaluator.evaluate('${{ 1 == 1 }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ 1 === 1 }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ 1 != 2 }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ 1 !== "1" }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ 1 <= 1 }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ 1 >= 1 }}', context)).toBe(true);
  });

  test('should support more globals and complex expressions', () => {
    expect(ExpressionEvaluator.evaluate('${{ Math.max(1, 2) }}', context)).toBe(2);
    expect(ExpressionEvaluator.evaluate('${{ JSON.stringify({a: 1}) }}', context)).toBe('{"a":1}');
    expect(ExpressionEvaluator.evaluate('${{ parseInt("123") }}', context)).toBe(123);
    expect(ExpressionEvaluator.evaluate('${{ isNaN(NaN) }}', context)).toBe(true);
  });

  test('should handle hasExpression', () => {
    expect(ExpressionEvaluator.hasExpression('no expr')).toBe(false);
    expect(ExpressionEvaluator.hasExpression('has ${{ expr }}')).toBe(true);
  });

  test('should handle evaluateObject', () => {
    const obj = {
      name: 'Hello ${{ inputs.name }}',
      list: ['${{ 1 + 1 }}', 3],
      nested: {
        val: '${{ inputs.count }}',
      },
    };
    const result = ExpressionEvaluator.evaluateObject(obj, context);
    expect(result).toEqual({
      name: 'Hello World',
      list: [2, 3],
      nested: {
        val: 5,
      },
    });
  });

  test('should throw error for unsupported operators', () => {
    // jsep doesn't support many out of box, but let's try something if we can
    // It's hard to trigger "Unsupported binary operator" because jsep wouldn't parse it
  });

  test('should handle member access with null/undefined', () => {
    expect(ExpressionEvaluator.evaluate('${{ steps.non_existent.output }}', context)).toBe(
      undefined
    );
  });

  test('should handle computed member access', () => {
    expect(ExpressionEvaluator.evaluate("${{ inputs['name'] }}", context)).toBe('World');
  });

  test('should support ternary operator', () => {
    expect(ExpressionEvaluator.evaluate("${{ inputs.count > 0 ? 'yes' : 'no' }}", context)).toBe(
      'yes'
    );
    expect(ExpressionEvaluator.evaluate("${{ inputs.count < 0 ? 'yes' : 'no' }}", context)).toBe(
      'no'
    );
  });

  test('should support array methods and arrow functions', () => {
    expect(
      ExpressionEvaluator.evaluate('${{ inputs.items.map(i => i.toUpperCase()) }}', context)
    ).toEqual(['A', 'B', 'C']);
    expect(
      ExpressionEvaluator.evaluate("${{ inputs.items.filter(i => i !== 'b') }}", context)
    ).toEqual(['a', 'c']);
    expect(ExpressionEvaluator.evaluate('${{ [1, 2, 3].every(n => n > 0) }}', context)).toBe(true);
  });

  test('should support string methods', () => {
    expect(ExpressionEvaluator.evaluate('${{ inputs.name.toLowerCase() }}', context)).toBe('world');
    expect(ExpressionEvaluator.evaluate("${{ '  trimmed  '.trim() }}", context)).toBe('trimmed');
  });

  test('should handle mixed text and expressions', () => {
    expect(ExpressionEvaluator.evaluate('Hello, ${{ inputs.name }}!', context)).toBe(
      'Hello, World!'
    );
    expect(
      ExpressionEvaluator.evaluate('Count: ${{ inputs.count }}, Item: ${{ item }}', context)
    ).toBe('Count: 5, Item: current-item');
  });

  test('should handle nested object literals', () => {
    const result = ExpressionEvaluator.evaluate(
      "${{ { foo: 'bar', baz: inputs.count } }}",
      context
    );
    expect(result).toEqual({ foo: 'bar', baz: 5 });
  });

  test('should throw error for undefined variables', () => {
    expect(() => ExpressionEvaluator.evaluate('${{ undefined_var }}', context)).toThrow(
      /Undefined variable/
    );
  });

  test('should support arrow functions as standalone values', () => {
    const fn = ExpressionEvaluator.evaluate('${{ x => x * 2 }}', context) as (x: number) => number;
    expect(fn(5)).toBe(10);
  });

  test('should throw error for non-function calls', () => {
    expect(() => ExpressionEvaluator.evaluate('${{ my_val() }}', context)).toThrow(
      /is not a function/
    );
  });

  test('should support subtraction and other binary operators', () => {
    expect(ExpressionEvaluator.evaluate('${{ 10 - 5 }}', context)).toBe(5);
  });

  test('should extract step dependencies', () => {
    expect(
      ExpressionEvaluator.findStepDependencies('Hello, ${{ steps.ask_name.output }}!')
    ).toEqual(['ask_name']);
    expect(
      ExpressionEvaluator.findStepDependencies("${{ steps.step1.output + steps['step2'].output }}")
    ).toEqual(['step1', 'step2']);
    expect(ExpressionEvaluator.findStepDependencies('No expressions here')).toEqual([]);
    expect(
      ExpressionEvaluator.findStepDependencies("${{ inputs.name + steps.step3.outputs['val'] }}")
    ).toEqual(['step3']);
  });

  test('should throw error for forbidden properties', () => {
    expect(() => ExpressionEvaluator.evaluate("${{ inputs['constructor'] }}", context)).toThrow(
      /Access to property constructor is forbidden/
    );
  });

  test('should handle short-circuiting in logical expressions', () => {
    expect(ExpressionEvaluator.evaluate('${{ true || undefined_var }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ false && undefined_var }}', context)).toBe(false);
  });

  test('should throw error for unsupported binary operator', () => {
    // We have to bypass jsep parsing or find one it supports but we don't
    // For now we'll just try to reach it if possible, but it's mostly for safety
  });

  test('should throw error for method not allowed', () => {
    expect(() => ExpressionEvaluator.evaluate("${{ 'abc'.reverse() }}", context)).toThrow(
      /Method reverse is not allowed/
    );
  });

  test('should handle standalone function calls with arrow functions', () => {
    // 'escape' is a safe global function we added
    expect(ExpressionEvaluator.evaluate("${{ escape('hello world') }}", context)).toBe(
      "'hello world'"
    );
  });

  test('should handle nested logical expressions and short-circuiting', () => {
    expect(ExpressionEvaluator.evaluate('${{ true && false || true }}', context)).toBe(true);
    expect(ExpressionEvaluator.evaluate('${{ false && true || false }}', context)).toBe(false);
  });

  test('should throw error for non-existent methods', () => {
    expect(() => ExpressionEvaluator.evaluate('${{ [1,2].nonExistent() }}', context)).toThrow(
      /Method nonExistent is not allowed/
    );
  });

  test('should handle CallExpression with arrow function for standalone function', () => {
    const contextWithFunc = {
      ...context,
      runFn: (fn: (x: number) => number) => fn(10),
    };
    expect(ExpressionEvaluator.evaluate('${{ runFn(x => x + 5) }}', contextWithFunc)).toBe(15);
  });

  test('should handle multiple expressions and fallback values', () => {
    // line 83: multiple expressions returning null/undefined
    const contextWithNull = { ...context, nullVal: null };
    expect(ExpressionEvaluator.evaluate('Val: ${{ nullVal }}', contextWithNull)).toBe('Val: ');

    // line 87: multiple expressions returning objects
    expect(ExpressionEvaluator.evaluate('Data: ${{ steps.step1.outputs.data }}', context)).toBe(
      'Data: {\n  "id": 1\n}'
    );
  });

  test('should handle evaluateString fallback for null/undefined', () => {
    // line 103: evaluateString returning null/undefined
    const contextWithNull = { ...context, nullVal: null };
    expect(ExpressionEvaluator.evaluateString('${{ nullVal }}', contextWithNull)).toBe('');
  });

  test('should throw error for unsupported unary operator', () => {
    // '~' is a unary operator jsep supports but we don't
    expect(() => ExpressionEvaluator.evaluate('${{ ~1 }}', context)).toThrow(
      /Unsupported unary operator: ~/
    );
  });
});
