import { describe, expect, it } from 'bun:test';
import { ExpressionEvaluator } from './evaluator';
import type { ExpressionContext } from './evaluator';

describe('ExpressionEvaluator Audit Fixes', () => {
  const context = { inputs: { a: 1 } };

  it('should use loose equality for ==', () => {
    expect(ExpressionEvaluator.evaluate("${{ 5 == '5' }}", context)).toBe(true);
    expect(ExpressionEvaluator.evaluate("${{ '5' == 5 }}", context)).toBe(true);
    // Strict should still work
    expect(ExpressionEvaluator.evaluate("${{ 5 === '5' }}", context)).toBe(false);
  });

  it('should use loose inequality for !=', () => {
    expect(ExpressionEvaluator.evaluate("${{ 5 != '5' }}", context)).toBe(false);
    expect(ExpressionEvaluator.evaluate("${{ '5' != 5 }}", context)).toBe(false);
    expect(ExpressionEvaluator.evaluate("${{ 5 != '6' }}", context)).toBe(true);
    // Strict should still work
    expect(ExpressionEvaluator.evaluate("${{ 5 !== '5' }}", context)).toBe(true);
  });

  it('should block Array constructor', () => {
    expect(() => ExpressionEvaluator.evaluate('${{ Array(10) }}', context)).toThrow();
  });

  it('should block repeat method', () => {
    expect(() => ExpressionEvaluator.evaluate("${{ 'a'.repeat(10) }}", context)).toThrow();
  });

  describe('Nesting Support', () => {
    const nestedContext: ExpressionContext = {
      inputs: {
        a: { b: { c: { d: 1 } } },
        arr: [[[1]]],
      },
    };

    it('should support level 1 nesting', () => {
      // ${{ { a: 1 } }}
      expect(ExpressionEvaluator.evaluate('${{ { x: 1 }.x }}', nestedContext)).toBe(1);
    });

    it('should support level 2 nesting', () => {
      // ${{ { a: { b: 1 } } }}
      expect(ExpressionEvaluator.evaluate('${{ { x: { y: 1 } }.x.y }}', nestedContext)).toBe(1);
    });

    it('should support level 3 nesting', () => {
      // ${{ { a: { b: { c: 1 } } } }}
      expect(
        ExpressionEvaluator.evaluate('${{ { x: { y: { z: 1 } } }.x.y.z }}', nestedContext)
      ).toBe(1);
    });

    it('should support level 3 object access in context', () => {
      expect(ExpressionEvaluator.evaluate('${{ inputs.a.b.c.d }}', nestedContext)).toBe(1);
    });

    it('should support level 3 array nesting', () => {
      // ${{ [ [ [ 1 ] ] ] }}
      const res = ExpressionEvaluator.evaluate(
        '${{ [ [ [ 1 ] ] ] }}',
        nestedContext
      ) as number[][][];
      expect(res[0][0][0]).toBe(1);
    });
  });
});
