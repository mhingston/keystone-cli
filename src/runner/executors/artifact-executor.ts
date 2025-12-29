import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import type { ExpressionContext } from '../../expression/evaluator.ts';
import { ExpressionEvaluator } from '../../expression/evaluator.ts';
import type { ArtifactStep } from '../../parser/schema.ts';
import type { Logger } from '../../utils/logger.ts';
import type { StepResult } from './types.ts';

function normalizePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  return trimmed.length > 0 ? trimmed : '.';
}

function assertWithinBaseDir(
  baseDir: string,
  targetPath: string,
  allowOutsideCwd?: boolean,
  label = 'Path'
): void {
  if (allowOutsideCwd) return;
  const realBase = fs.realpathSync(baseDir);
  const normalizedPath = normalizePath(targetPath);
  const resolvedPath = path.resolve(baseDir, normalizedPath);

  let current = resolvedPath;
  while (current !== path.dirname(current) && !fs.existsSync(current)) {
    current = path.dirname(current);
  }
  const realTarget = fs.existsSync(current) ? fs.realpathSync(current) : current;
  const relativePath = path.relative(realBase, realTarget);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(
      `Access denied: ${label} '${normalizedPath}' resolves outside the working directory. Use 'allowOutsideCwd: true' to override.`
    );
  }
}

function resolveSafeRelativePath(baseDir: string, absolutePath: string): string {
  const relativeToBase = path.relative(baseDir, absolutePath);
  if (!relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase)) {
    return relativeToBase;
  }
  const root = path.parse(absolutePath).root;
  return path.relative(root, absolutePath);
}

/**
 * Execute an artifact step (upload/download)
 */
export async function executeArtifactStep(
  step: ArtifactStep,
  context: ExpressionContext,
  logger: Logger,
  options: {
    artifactRoot?: string;
    workflowDir?: string;
    runId?: string;
    abortSignal?: AbortSignal;
  }
): Promise<StepResult> {
  if (options.abortSignal?.aborted) {
    throw new Error('Artifact operation aborted');
  }
  const baseDir = options.workflowDir || process.cwd();
  const rawName = ExpressionEvaluator.evaluateString(step.name, context);
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    throw new Error('Artifact name must be a non-empty string');
  }
  const sanitizedName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (sanitizedName !== rawName) {
    logger.warn(
      `⚠️  Artifact name "${rawName}" contained unsafe characters. Using "${sanitizedName}".`
    );
  }

  const artifactRoot = options.artifactRoot || path.join(process.cwd(), '.keystone', 'artifacts');
  const runDir = options.runId ? path.join(artifactRoot, options.runId) : artifactRoot;

  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir, { recursive: true });
  }

  const artifactPath = path.join(runDir, sanitizedName);

  if (step.op === 'upload') {
    const patterns = (
      step.paths && step.paths.length > 0 ? step.paths : step.path ? [step.path] : []
    ).map((value) => ExpressionEvaluator.evaluateString(value, context));
    if (patterns.length === 0) {
      throw new Error('Artifact upload requires at least one path');
    }

    const matchedFiles = new Set<string>();
    for (const pattern of patterns) {
      const matches = globSync(pattern, {
        cwd: baseDir,
        absolute: true,
        dot: true,
        nodir: true,
      });
      for (const match of matches) {
        matchedFiles.add(match);
      }
    }

    if (matchedFiles.size === 0) {
      throw new Error(`No files matched for artifact "${rawName}"`);
    }

    await fs.promises.rm(artifactPath, { recursive: true, force: true });
    fs.mkdirSync(artifactPath, { recursive: true });

    const files: string[] = [];
    for (const filePath of matchedFiles) {
      if (options.abortSignal?.aborted) {
        throw new Error('Artifact upload aborted');
      }
      assertWithinBaseDir(baseDir, filePath, step.allowOutsideCwd);
      const relativePath = resolveSafeRelativePath(baseDir, filePath);
      const destination = path.join(artifactPath, relativePath);
      const relativeToArtifact = path.relative(artifactPath, destination);
      if (relativeToArtifact.startsWith('..') || path.isAbsolute(relativeToArtifact)) {
        throw new Error(`Artifact path escape detected for "${relativePath}"`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(filePath, destination);
      files.push(relativePath);
    }

    return {
      output: {
        name: sanitizedName,
        op: 'upload',
        artifactPath,
        files,
        fileCount: files.length,
      },
      status: 'success',
    };
  } else {
    // download
    if (!step.path) {
      throw new Error(`Artifact download requires a destination path for "${rawName}"`);
    }
    const dest = ExpressionEvaluator.evaluateString(step.path, context);
    const destPath = path.isAbsolute(dest) ? dest : path.join(baseDir, dest);
    assertWithinBaseDir(baseDir, destPath, step.allowOutsideCwd);

    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Artifact not found for download: ${sanitizedName}`);
    }

    // ensure dest dir exists
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    await fs.promises.cp(artifactPath, destPath, { recursive: true, force: true });

    return {
      output: { name: sanitizedName, path: destPath, op: 'download', artifactPath },
      status: 'success',
    };
  }
}
