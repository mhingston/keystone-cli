import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { WorkflowDb } from '../db/workflow-db';
import { MemoryDb } from '../db/memory-db';
import type { Workflow } from '../parser/schema';
import { WorkflowRunner } from './workflow-runner';
import { container } from '../utils/container';
import { ConsoleLogger } from '../utils/logger';
import { ConfigLoader } from '../utils/config-loader';

describe('Join Scheduling & Resume', () => {
    const dbPath = ':memory:';

    // Setup DI container for tests
    container.register('logger', new ConsoleLogger());
    container.register('db', new WorkflowDb(dbPath));
    container.register('memoryDb', new MemoryDb());

    const activeSpies: Array<{ mockRestore: () => void }> = [];
    const trackSpy = <T extends { mockRestore: () => void }>(spy: T): T => {
        activeSpies.push(spy);
        return spy;
    };

    afterAll(() => {
        // Cleanup any file-based DBs if used
        const files = ['test-resume-retry.db'];
        for (const f of files) {
            if (existsSync(f)) rmSync(f);
        }
    });

    afterEach(() => {
        for (const spy of activeSpies) {
            spy.mockRestore();
        }
        activeSpies.length = 0;
        ConfigLoader.clear();
    });

    it('should execute join step when one dependency fails but has allowFailure: true', async () => {
        const workflow: Workflow = {
            name: 'join-allow-failure',
            steps: [
                {
                    id: 'A',
                    type: 'shell',
                    run: 'exit 1', // Fails
                    allowFailure: true,
                    place: 'local', // Avoid shell injection check for simple exit
                    needs: [],
                },
                {
                    id: 'B',
                    type: 'shell',
                    run: 'echo "B success"',
                    needs: [],
                },
                {
                    id: 'C',
                    type: 'shell',
                    run: 'echo "Joined"',
                    needs: ['A', 'B'],
                },
            ],
            outputs: {
                c_status: '${{ steps.C.status }}',
                a_status: '${{ steps.A.status }}',
                a_error: '${{ steps.A.error }}',
            },
        } as unknown as Workflow;

        const runner = new WorkflowRunner(workflow, { dbPath });
        const outputs = await runner.run();

        expect(outputs.c_status).toBe('success');
        expect(outputs.a_status).toBe('success');
        expect(outputs.a_error).toContain('code 1');
    });

    it('should execute join step after dependency succeeds via retry', async () => {
        const counterFile = `/tmp/keystone-test-retry-${Date.now()}.txt`;
        await Bun.write(counterFile, '0');

        const workflow: Workflow = {
            name: 'join-retry',
            steps: [
                {
                    id: 'A',
                    type: 'shell',
                    // Read counter, increment, if < 2 exit 1, else exit 0
                    run: `
            val=$(cat ${counterFile})
            echo $((val + 1)) > ${counterFile}
            if [ "$val" -lt "2" ]; then exit 1; else exit 0; fi
          `,
                    retry: { count: 3 },
                    allowInsecure: true,
                    needs: [],
                },
                {
                    id: 'B',
                    type: 'shell',
                    run: 'echo "B"',
                    needs: ['A'],
                },
            ],
            outputs: {
                b_status: '${{ steps.B.status }}',
            },
        } as unknown as Workflow;

        const runner = new WorkflowRunner(workflow, { dbPath });
        const outputs = await runner.run();

        expect(outputs.b_status).toBe('success');

        // Verify it ran 3 times (0 -> 1 (fail), 1 -> 2 (fail), 2 -> 3 (success))
        const finalVal = await Bun.file(counterFile).text();
        expect(finalVal.trim()).toBe('3');

        if (existsSync(counterFile)) rmSync(counterFile);
    });

    it('should resume and retry a step that previously exhausted retries', async () => {
        const dbPath = 'test-resume-retry.db';
        if (existsSync(dbPath)) rmSync(dbPath);

        const counterFile = `/tmp/keystone-test-resume-${Date.now()}.txt`;
        await Bun.write(counterFile, '0');

        // Workflow that fails initially (retry count 1, but we make it fail 2 times)
        const workflow: Workflow = {
            name: 'resume-retry',
            steps: [
                {
                    id: 'A',
                    type: 'shell',
                    // Read counter, increment. 
                    // We want it to fail runs 1 and 2. 
                    // Setup: Retry count 1.
                    // Run 1: fails. Retry 1: fails. -> Workflow Fails.
                    // Resume.
                    // Run 3: succeeds.
                    run: `
            val=$(cat ${counterFile})
            echo $((val + 1)) > ${counterFile}
            if [ "$val" -lt "2" ]; then exit 1; else exit 0; fi
          `,
                    retry: { count: 1 },
                    allowInsecure: true,
                    needs: [],
                },
                {
                    id: 'B',
                    type: 'shell',
                    run: 'echo "Done"',
                    needs: ['A'],
                },
            ],
            outputs: {
                b_visited: '${{ steps.B.status }}',
            },
        } as unknown as Workflow;

        // First run
        const runner1 = new WorkflowRunner(workflow, { dbPath });
        let runId = '';
        try {
            await runner1.run();
        } catch (e) {
            runId = runner1.runId;
        }

        expect(runId).toBeTruthy();

        // Verify it failed twice (initial + 1 retry)
        let val = await Bun.file(counterFile).text();
        expect(val.trim()).toBe('2');

        // Now resume. It should try again (Run 3) and succeed.
        const runner2 = new WorkflowRunner(workflow, {
            dbPath,
            resumeRunId: runId
        });

        const outputs = await runner2.run();

        expect(outputs.b_visited).toBe('success');

        val = await Bun.file(counterFile).text();
        expect(val.trim()).toBe('3');

        if (existsSync(dbPath)) rmSync(dbPath);
        if (existsSync(counterFile)) rmSync(counterFile);
    });
});
