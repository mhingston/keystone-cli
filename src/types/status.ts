/**
 * Centralized status constants for workflow and step execution
 */

export const StepStatus = {
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed',
  PAUSED: 'paused',
  SUSPENDED: 'suspended',
  SKIPPED: 'skipped',
  RUNNING: 'running',
} as const;

export type StepStatusType = (typeof StepStatus)[keyof typeof StepStatus];

export const WorkflowStatus = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  PAUSED: 'paused',
  SUSPENDED: 'suspended',
  RUNNING: 'running',
} as const;

export type WorkflowStatusType = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];
