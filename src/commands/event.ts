/**
 * keystone event command
 * Trigger an event to resume waiting workflows
 */

import type { Command } from 'commander';
import type { WorkflowDb } from '../db/workflow-db.ts';
import { container } from '../utils/container.ts';

export function registerEventCommand(program: Command): void {
  program
    .command('event')
    .description('Trigger an event to resume waiting workflows')
    .argument('<name>', 'Event name')
    .argument('[data]', 'Event data (JSON)')
    .action(async (name, dataStr) => {
      const db = container.resolve('db') as WorkflowDb;
      let data = null;
      if (dataStr) {
        try {
          data = JSON.parse(dataStr);
        } catch {
          data = dataStr;
        }
      }
      await db.storeEvent(name, data);
      console.log(`✓ Event '${name}' triggered.`);

      // Check for workflows waiting for this event
      const suspendedRunIds = await db.getSuspendedStepsForEvent(name);
      if (suspendedRunIds.length > 0) {
        console.log(`\nFound ${suspendedRunIds.length} workflow(s) waiting for this event:`);
        for (const runId of suspendedRunIds) {
          console.log(`  - Run ${runId}: Resume with \`keystone resume ${runId}\``);
        }
      }
    });
}
