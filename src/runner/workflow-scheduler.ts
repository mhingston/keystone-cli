import type { Workflow, Step, JoinStep } from '../parser/schema.ts';
import { WorkflowParser } from '../parser/workflow-parser.ts';

export class WorkflowScheduler {
    private executionOrder: string[];
    private pendingSteps: Set<string>;
    private completedSteps: Set<string>;
    private stepMap: Map<string, Step>;

    constructor(private readonly workflow: Workflow, alreadyCompleted: Set<string> = new Set()) {
        this.executionOrder = WorkflowParser.topologicalSort(workflow);
        this.stepMap = new Map(workflow.steps.map((s) => [s.id, s]));

        // Initialize completed steps (from already completed/restored state)
        this.completedSteps = new Set(alreadyCompleted);

        // Remaining steps to execute
        const remaining = this.executionOrder.filter((id) => !this.completedSteps.has(id));
        this.pendingSteps = new Set(remaining);
    }

    public getExecutionOrder(): string[] {
        return this.executionOrder;
    }

    public getPendingCount(): number {
        return this.pendingSteps.size;
    }

    public isComplete(): boolean {
        return this.pendingSteps.size === 0;
    }

    public markStepComplete(stepId: string): void {
        this.completedSteps.add(stepId);
        this.pendingSteps.delete(stepId);
    }

    public getRunnableSteps(runningCount: number, globalConcurrencyLimit: number): Step[] {
        const runnable: Step[] = [];

        for (const stepId of this.pendingSteps) {
            if (runningCount + runnable.length >= globalConcurrencyLimit) {
                break;
            }

            const step = this.stepMap.get(stepId);
            if (!step) continue;

            if (this.isStepReady(step)) {
                runnable.push(step);
            }
        }

        return runnable;
    }

    public startStep(stepId: string): void {
        this.pendingSteps.delete(stepId);
    }

    private isStepReady(step: Step): boolean {
        if (step.type === 'join') {
            const joinStep = step as JoinStep;
            const needs = joinStep.needs ?? [];
            if (needs.length === 0) return true;
            return needs.every((dep) => this.completedSteps.has(dep));
        }
        const needs = step.needs ?? [];
        return needs.every((dep: string) => this.completedSteps.has(dep));
    }
}
