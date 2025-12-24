import { describe, expect, it } from 'bun:test';
import { WorkflowRunner } from './workflow-runner';
import type { Workflow } from '../parser/schema';

describe('Workflow Concurrency Integration', () => {
    const dbPath = ':memory:';

    it('should respect workflow-level concurrency limit', async () => {
        const workflow: Workflow = {
            name: 'concurrency-wf',
            concurrency: 2,
            steps: [
                { id: 's1', type: 'sleep', duration: 100, needs: [] },
                { id: 's2', type: 'sleep', duration: 100, needs: [] },
                { id: 's3', type: 'sleep', duration: 100, needs: [] },
                { id: 's4', type: 'sleep', duration: 100, needs: [] },
            ],
        } as unknown as Workflow;

        const start = Date.now();
        const runner = new WorkflowRunner(workflow, { dbPath });
        await runner.run();
        const duration = Date.now() - start;

        // Concurrent=2, Total=4 steps, 100ms each -> should take ~200ms
        // seq=400ms, parallel=100ms.
        // We expect 200ms <= duration < 250ms
        expect(duration).toBeGreaterThanOrEqual(200);
        expect(duration).toBeLessThan(350); // Safe buffer
    });

    it('should respect pool-level limits', async () => {
        const workflow: Workflow = {
            name: 'pool-wf',
            pools: {
                slow: 1,
            },
            steps: [
                { id: 's1', type: 'sleep', duration: 100, pool: 'slow', needs: [] },
                { id: 's2', type: 'sleep', duration: 100, pool: 'slow', needs: [] },
                { id: 's3', type: 'sleep', duration: 100, needs: [] }, // Default pool (type=sleep)
                { id: 's4', type: 'sleep', duration: 100, needs: [] }, // Default pool
            ],
        } as unknown as Workflow;

        const start = Date.now();
        const runner = new WorkflowRunner(workflow, { dbPath });
        await runner.run();
        const duration = Date.now() - start;

        // 'slow' pool limit 1 -> s1, s2 run sequentially (200ms)
        // default pool (sleep) limit 10 (default) -> s3, s4 run parallel (100ms)
        // Overall should take ~200ms
        expect(duration).toBeGreaterThanOrEqual(200);
        expect(duration).toBeLessThan(280);
    });

    it('should respect foreach concurrency limit', async () => {
        const workflow: Workflow = {
            name: 'foreach-concurrency-wf',
            steps: [
                {
                    id: 'process',
                    type: 'sleep',
                    duration: 50,
                    concurrency: 2,
                    foreach: '${{ [1, 2, 3, 4] }}',
                    needs: [],
                },
            ],
        } as unknown as Workflow;

        const start = Date.now();
        const runner = new WorkflowRunner(workflow, { dbPath });
        await runner.run();
        const duration = Date.now() - start;

        // 4 items, concurrency 2, 50ms each -> ~100ms
        expect(duration).toBeGreaterThanOrEqual(100);
        expect(duration).toBeLessThan(180);
    });
});
