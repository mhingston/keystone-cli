import type { StepStatusType, WorkflowStatusType } from '../types/status.ts';

export type StepPhase = 'main' | 'errors' | 'finally';

export type WorkflowEvent =
  | {
      type: 'workflow.start';
      timestamp: string;
      runId: string;
      workflow: string;
      inputs?: Record<string, unknown>;
    }
  | {
      type: 'step.start';
      timestamp: string;
      runId: string;
      workflow: string;
      stepId: string;
      stepType: string;
      phase: StepPhase;
      stepIndex?: number;
      totalSteps?: number;
    }
  | {
      type: 'step.end';
      timestamp: string;
      runId: string;
      workflow: string;
      stepId: string;
      stepType: string;
      phase: StepPhase;
      status: StepStatusType;
      durationMs?: number;
      error?: string;
      stepIndex?: number;
      totalSteps?: number;
    }
  | {
      type: 'llm.thought';
      timestamp: string;
      runId: string;
      workflow: string;
      stepId: string;
      content: string;
      source: 'thinking' | 'reasoning';
    }
  | {
      type: 'workflow.complete';
      timestamp: string;
      runId: string;
      workflow: string;
      status: WorkflowStatusType;
      outputs?: Record<string, unknown>;
      error?: string;
    };

export type EventHandler = (event: WorkflowEvent) => void;
