import { Box, Newline, Text, render, useInput } from 'ink';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { WorkflowDb } from '../db/workflow-db.ts';
import { ConsoleLogger } from '../utils/logger.ts';

interface Run {
  id: string;
  workflow_name: string;
  status: string;
  started_at: string;
  total_tokens?: number;
}

const logger = new ConsoleLogger();

const Dashboard = () => {
  const [runs, setRuns] = useState<Run[]>([]);
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
      const runsWithUsage = await Promise.all(
        recentRuns.map(async (run) => {
          let total_tokens = 0;
          try {
            // Get steps to aggregate tokens if not in outputs (future-proofing)
            const steps = await db.getStepsByRun(run.id);
            total_tokens = steps.reduce((sum, s) => {
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
          } catch (e) {
            // Ignore read error
          }
          return { ...run, total_tokens };
        })
      );
      setRuns(runsWithUsage);
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
          <Box width={30}>
            <Text bold color="cyan">
              WORKFLOW
            </Text>
          </Box>
          <Box width={15}>
            <Text bold color="cyan">
              STATUS
            </Text>
          </Box>
          <Box width={15}>
            <Text bold color="cyan">
              STARTED
            </Text>
          </Box>
          <Box>
            <Text bold color="cyan">
              TOKENS
            </Text>
          </Box>
        </Box>

        <Box marginBottom={1}>
          <Text color="gray">{'─'.repeat(80)}</Text>
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
              <Box width={30}>
                <Text>{run.workflow_name}</Text>
              </Box>
              <Box width={15}>
                <Text color={getStatusColor(run.status)}>
                  {getStatusIcon(run.status)} {run.status.toUpperCase()}
                </Text>
              </Box>
              <Box width={15}>
                <Text color="gray">{new Date(run.started_at).toLocaleTimeString()}</Text>
              </Box>
              <Box>
                <Text color="yellow">{run.total_tokens || 0}</Text>
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

export const startDashboard = () => {
  render(<Dashboard />);
};
