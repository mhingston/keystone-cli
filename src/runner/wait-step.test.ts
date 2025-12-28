import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { WorkflowDb } from '../db/workflow-db';
import { executeStep } from './step-executor';
import { container } from '../utils/container';
import { ConsoleLogger } from '../utils/logger';
import type { WaitStep } from '../parser/schema';

describe('Wait Step', () => {
  let db: WorkflowDb;
  const logger = new ConsoleLogger();
  const context = { inputs: {}, steps: {} };

  beforeEach(() => {
    db = new WorkflowDb(':memory:');
    container.register('db', db);
    container.register('logger', logger);
    });

    afterEach(() => {
        db.close();
    });

  it('should succeed when event exists and consume it by default (oneShot: true)', async () => {
    const eventName = 'test-event';
    const eventData = { foo: 'bar' };
    await db.storeEvent(eventName, eventData);

        const step: WaitStep = {
            id: 'wait1',
            type: 'wait',
      event: eventName,
      needs: [],
    };

    const result = await executeStep(step, context, logger, { db });
    expect(result.status).toBe('success');
    expect(result.output).toEqual(eventData);

        // Verify event is consumed
        const eventAfter = await db.getEvent(eventName);
        expect(eventAfter).toBeNull();
    });

    it('should suspend when event does not exist', async () => {
        const eventName = 'non-existent';
    const step: WaitStep = {
      id: 'wait1',
      type: 'wait',
      event: eventName,
      needs: [],
    };

    const result = await executeStep(step, context, logger, { db });
    expect(result.status).toBe('suspended');
    expect(result.output).toEqual({ event: eventName });
    });

    it('should NOT consume event when oneShot is false', async () => {
        const eventName = 'persistent-event';
        const eventData = { hello: 'world' };
        await db.storeEvent(eventName, eventData);

        const step: WaitStep = {
            id: 'wait1',
            type: 'wait',
            event: eventName,
      oneShot: false,
      needs: [],
    };

    const result = await executeStep(step, context, logger, { db });
    expect(result.status).toBe('success');
    expect(result.output).toEqual(eventData);

        // Verify event STILL exists
        const eventAfter = await db.getEvent(eventName);
        expect(eventAfter).not.toBeNull();
        expect(JSON.parse(eventAfter!.data!)).toEqual(eventData);
    });

    it('should handle sequential wait steps for the same one-shot event', async () => {
        const eventName = 'seq-event';
        await db.storeEvent(eventName, { count: 1 });

        const step: WaitStep = {
            id: 'wait1',
            type: 'wait',
      event: eventName,
      needs: [],
    };

    // First wait succeeds and consumes
    const result1 = await executeStep(step, context, logger, { db });
    expect(result1.status).toBe('success');

    // Second wait suspends because event is gone
    const result2 = await executeStep(step, context, logger, { db });
    expect(result2.status).toBe('suspended');
  });
});
