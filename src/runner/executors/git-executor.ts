import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import type { GitStep } from '../../parser/schema.ts';
import { ConsoleLogger, type Logger } from '../../utils/logger.ts';
import { PathResolver } from '../../utils/paths.ts';
import { executeShell, type ShellResult } from './shell-executor.ts';
import type { StepResult } from './types.ts';

/**
 * Git command executor
 */
export async function executeGitStep(
    step: GitStep,
    context: ExpressionContext,
    logger: Logger = new ConsoleLogger(),
    abortSignal?: AbortSignal
): Promise<StepResult> {
    const op = step.op;
    const cwd = step.cwd ? ExpressionEvaluator.evaluateString(step.cwd, context) : undefined;

    if (cwd) {
        PathResolver.assertWithinCwd(cwd, step.allowOutsideCwd, 'CWD');
    }

    // Pre-process common inputs
    const path = step.path ? ExpressionEvaluator.evaluateString(step.path, context) : undefined;
    const url = step.url ? ExpressionEvaluator.evaluateString(step.url, context) : undefined;
    const branch = step.branch ? ExpressionEvaluator.evaluateString(step.branch, context) : undefined;
    const message = step.message ? ExpressionEvaluator.evaluateString(step.message, context) : undefined;

    let command = '';
    switch (op) {
        case 'clone':
            if (!url) throw new Error('Git clone requires a "url"');
            command = `git clone ${branch ? `-b ${branch} ` : ''}${url} ${path || ''}`;
            break;
        case 'worktree_add':
            if (!path) throw new Error('Git worktree_add requires a "path"');
            command = `git worktree add ${path} ${branch || ''}`;
            break;
        case 'worktree_remove':
            if (!path) throw new Error('Git worktree_remove requires a "path"');
            command = `git worktree remove ${path}`;
            break;
        case 'checkout':
            if (!branch) throw new Error('Git checkout requires a "branch"');
            command = `git checkout ${branch}`;
            break;
        case 'pull':
            command = `git pull origin ${branch || ''}`;
            break;
        case 'push':
            command = `git push origin ${branch || ''}`;
            break;
        case 'commit':
            if (!message) throw new Error('Git commit requires a "message"');
            command = `git add . && git commit -m "${message.replace(/"/g, '\\"')}"`;
            break;
        default:
            throw new Error(`Unsupported git operation: ${op}`);
    }

    // Use executeShell to leverage its security checks and output handling
    // We explicitly allow insecure if the user set it, but by default executeShell
    // will check the command against the whitelist.
    // Note: Git commands often contain spaces/slashes which are in the whitelist.
    const result: ShellResult = await executeShell(
        {
            ...step,
            type: 'shell',
            run: command,
            dir: cwd,
        },
        context,
        logger,
        abortSignal,
        command
    );

    if (result.exitCode !== 0) {
        return {
            output: result,
            status: 'failed',
            error: `Git ${op} failed with code ${result.exitCode}: ${result.stderr}`,
        };
    }

    // Provide some structured output based on the operation
    const output: any = { ...result };
    if (op === 'worktree_add') {
        output.worktreePath = path;
    }

    return {
        output,
        status: 'success',
    };
}
