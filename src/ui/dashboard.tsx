import { Box, Newline, Text, render, useInput } from 'ink';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { WorkflowDb, type StepExecution } from '../db/workflow-db.ts';
import { ConsoleLogger } from '../utils/logger.ts';

interface Run {
  id: string;
  workflow_name: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  total_tokens?: number;
  duration_ms?: number;
  exec_total?: number;
  exec_failed?: number;
  exec_retries?: number;
  exec_soft_failures?: number;
}

interface Thought {
  id: string;
  run_id: string;
  workflow_name: string;
  step_id: string;
  content: string;
  source: 'thinking' | 'reasoning';
  created_at: string;
}

const logger = new ConsoleLogger();

const Dashboard = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);

  // Reuse database connection instead of creating new one every 2 seconds
  const db = useMemo(() => new WorkflowDb(), []);

  // Cleanup database connection on unmount
  useEffect(() => {
    return () => db.close();
  }, [db]);

  const fetchData = useCallback(async () => {
    try {
      const recentRuns = (await db.listRuns(10)) as (Run & { outputs: string | null })[];
      const runIds = recentRuns.map((run) => run.id);
      const steps = await db.getStepsByRuns(runIds);
      const stepsByRun = new Map<string, StepExecution[]>();
      for (const step of steps) {
        const list = stepsByRun.get(step.run_id);
        if (list) {
          list.push(step);
        } else {
          stepsByRun.set(step.run_id, [step]);
        }
      }

      const runsWithUsage = recentRuns.map((run) => {
        let total_tokens = 0;
        let exec_total = 0;
        let exec_failed = 0;
        let exec_retries = 0;
        let exec_soft_failures = 0;
        const runSteps = stepsByRun.get(run.id) || [];
        total_tokens = runSteps.reduce((sum, s) => {
          if (s.usage) {
            try {
              const u = JSON.parse(s.usage);
              return sum + (u.total_tokens || 0);
            } catch (e) {
              return sum;
            }
          }
          return sum;
        }, 0);
        exec_total = runSteps.length;
        exec_failed = runSteps.filter((step) => step.status === 'failed').length;
        exec_retries = runSteps.reduce((sum, step) => sum + (step.retry_count || 0), 0);
        exec_soft_failures = runSteps.filter(
          (step) => step.status === 'success' && step.error
        ).length;
        const startedMs = new Date(run.started_at).getTime();
        const completedMs = run.completed_at ? new Date(run.completed_at).getTime() : Date.now();
        const duration_ms = Number.isFinite(startedMs)
          ? Math.max(0, completedMs - startedMs)
          : undefined;
        return {
          ...run,
          total_tokens,
          duration_ms,
          exec_total,
          exec_failed,
          exec_retries,
          exec_soft_failures,
        };
      });
      setRuns(runsWithUsage);
      const recentThoughts = (await db.listThoughtEvents(12)) as Thought[];
      setThoughts(recentThoughts);
    } catch (error) {
      logger.error(`Failed to fetch runs: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [db]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useInput((input) => {
    if (input === 'r') {
      fetchData();
    }
  });

  if (loading) {
    return (
      <Box>
        <Text color="cyan">Loading Keystone Dashboard...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">
          🏛️ KEYSTONE DASHBOARD
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        <Box marginBottom={0}>
          <Box width={12}>
            <Text bold color="cyan">
              ID
            </Text>
          </Box>
          <Box width={24}>
            <Text bold color="cyan">
              WORKFLOW
            </Text>
          </Box>
          <Box width={12}>
            <Text bold color="cyan">
              STATUS
            </Text>
          </Box>
          <Box width={10}>
            <Text bold color="cyan">
              START
            </Text>
          </Box>
          <Box width={8}>
            <Text bold color="cyan">
              DUR
            </Text>
          </Box>
          <Box width={7}>
            <Text bold color="cyan">
              EXECS
            </Text>
          </Box>
          <Box width={6}>
            <Text bold color="cyan">
              FAIL
            </Text>
          </Box>
          <Box width={7}>
            <Text bold color="cyan">
              RETRY
            </Text>
          </Box>
          <Box width={8}>
            <Text bold color="cyan">
              TOKENS
            </Text>
          </Box>
        </Box>

        <Box marginBottom={1}>
          <Text color="gray">{'─'.repeat(92)}</Text>
        </Box>

        {runs.length === 0 ? (
          <Text italic color="gray">
            No workflow runs found.
          </Text>
        ) : (
          runs.map((run) => (
            <Box key={run.id} marginBottom={0}>
              <Box width={12}>
                <Text color="gray">{run.id.substring(0, 8)}</Text>
              </Box>
              <Box width={24}>
                <Text>{run.workflow_name}</Text>
              </Box>
              <Box width={12}>
                <Text color={getStatusColor(run.status)}>
                  {getStatusIcon(run.status)} {run.status.toUpperCase()}
                </Text>
              </Box>
              <Box width={10}>
                <Text color="gray">{formatClock(run.started_at)}</Text>
              </Box>
              <Box width={8}>
                <Text color="gray">
                  {run.duration_ms !== undefined ? formatDuration(run.duration_ms) : '--:--'}
                </Text>
              </Box>
              <Box width={7}>
                <Text color="gray">{run.exec_total ?? 0}</Text>
              </Box>
              <Box width={6}>
                <Text color={getFailColor(run.exec_failed, run.exec_soft_failures)}>
                  {formatFailCount(run.exec_failed, run.exec_soft_failures)}
                </Text>
              </Box>
              <Box width={7}>
                <Text color={run.exec_retries ? 'yellow' : 'gray'}>{run.exec_retries ?? 0}</Text>
              </Box>
              <Box width={8}>
                <Text color="yellow">{run.total_tokens || 0}</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            THOUGHTS
          </Text>
        </Box>
        {thoughts.length === 0 ? (
          <Text italic color="gray">
            No thought events yet.
          </Text>
        ) : (
          thoughts.map((thought) => (
            <Box key={thought.id} marginBottom={0}>
              <Box width={10}>
                <Text color="gray">{formatClock(thought.created_at)}</Text>
              </Box>
              <Box width={10}>
                <Text color="gray">{thought.run_id.substring(0, 8)}</Text>
              </Box>
              <Box width={16}>
                <Text color="gray">{thought.step_id}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text>{truncateText(thought.content, 120)}</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1} paddingX={1}>
        <Text color="gray">
          <Text bold color="white">
            {' '}
            r{' '}
          </Text>{' '}
          refresh •
          <Text bold color="white">
            {' '}
            Ctrl+C{' '}
          </Text>{' '}
          exit •<Text italic> Auto-refreshing every 2s</Text>
        </Text>
      </Box>
    </Box>
  );
};

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'success':
      return 'green';
    case 'failed':
      return 'red';
    case 'running':
      return 'yellow';
    case 'paused':
      return 'blue';
    case 'pending':
      return 'gray';
    default:
      return 'white';
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'success':
      return '✅';
    case 'failed':
      return '❌';
    case 'running':
      return '⏳';
    case 'paused':
      return '⏸️';
    case 'pending':
      return '⚪';
    default:
      return '🔹';
  }
};

const formatDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '--:--';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
      seconds
    ).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatClock = (iso: string): string => {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '--:--:--';
  }
};

const truncateText = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

const formatFailCount = (failed = 0, softFailed = 0): string => {
  if (softFailed > 0) {
    return `${failed}+${softFailed}`;
  }
  return String(failed);
};

const getFailColor = (failed = 0, softFailed = 0): string => {
  if (failed > 0) return 'red';
  if (softFailed > 0) return 'yellow';
  return 'gray';
};

export const startDashboard = () => {
  render(<Dashboard />);
};
