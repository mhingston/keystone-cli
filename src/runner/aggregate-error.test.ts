import { describe, expect, it } from 'bun:test';
import { AggregateWorkflowError } from './aggregate-error';

describe('AggregateWorkflowError', () => {
  it('should create with multiple errors', () => {
    const errors = [new Error('Error 1'), new Error('Error 2'), new Error('Error 3')];
    const aggregate = new AggregateWorkflowError('test-step', errors);

    expect(aggregate.name).toBe('AggregateWorkflowError');
    expect(aggregate.stepId).toBe('test-step');
    expect(aggregate.errors).toHaveLength(3);
    expect(aggregate.count).toBe(3);
  });

  it('should format message with all errors', () => {
    const errors = [new Error('First error'), new Error('Second error')];
    const aggregate = new AggregateWorkflowError('my-step', errors);

    expect(aggregate.message).toContain('my-step');
    expect(aggregate.message).toContain('2 error(s)');
    expect(aggregate.message).toContain('[1] First error');
    expect(aggregate.message).toContain('[2] Second error');
  });

  it('should return first error', () => {
    const first = new Error('First');
    const errors = [first, new Error('Second')];
    const aggregate = new AggregateWorkflowError('step', errors);

    expect(aggregate.firstError).toBe(first);
  });

  it('should return undefined for empty errors', () => {
    const aggregate = new AggregateWorkflowError('step', []);
    expect(aggregate.firstError).toBeUndefined();
  });

  it('should check if all errors are of specific type', () => {
    class CustomError extends Error {}
    const errors = [new CustomError('a'), new CustomError('b')];
    const aggregate = new AggregateWorkflowError('step', errors);

    expect(aggregate.allOfType(CustomError)).toBe(true);
    expect(aggregate.allOfType(TypeError)).toBe(false);
  });

  it('should filter errors by type', () => {
    class CustomError extends Error {}
    const custom = new CustomError('custom');
    const errors = [custom, new Error('regular'), new CustomError('another')];
    const aggregate = new AggregateWorkflowError('step', errors);

    const customErrors = aggregate.ofType(CustomError);
    expect(customErrors).toHaveLength(2);
    expect(customErrors[0]).toBe(custom);
  });
});
