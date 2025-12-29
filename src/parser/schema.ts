import { z } from 'zod';

// ===== Input/Output Schema =====

const InputSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
    default: z.any().optional(),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    secret: z.boolean().optional(),
    description: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const type = value.type;
    const defaultValue = value.default;

    if (defaultValue !== undefined) {
      if (type === 'string' && typeof defaultValue !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default must be a string for type "${type}"`,
        });
      }
      if (type === 'number' && typeof defaultValue !== 'number') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default must be a number for type "${type}"`,
        });
      }
      if (type === 'boolean' && typeof defaultValue !== 'boolean') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default must be a boolean for type "${type}"`,
        });
      }
      if (type === 'array' && !Array.isArray(defaultValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default must be an array for type "${type}"`,
        });
      }
      if (
        type === 'object' &&
        (typeof defaultValue !== 'object' || defaultValue === null || Array.isArray(defaultValue))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default must be an object for type "${type}"`,
        });
      }
    }

    if (value.values) {
      if (type !== 'string' && type !== 'number' && type !== 'boolean') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `values cannot be used with type "${type}"`,
        });
        return;
      }

      for (const allowed of value.values) {
        const matchesType =
          (type === 'string' && typeof allowed === 'string') ||
          (type === 'number' && typeof allowed === 'number') ||
          (type === 'boolean' && typeof allowed === 'boolean');
        if (!matchesType) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `enum value ${JSON.stringify(allowed)} must be a ${type}`,
          });
        }
      }

      if (defaultValue !== undefined && !value.values.includes(defaultValue as never)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `default must be one of: ${value.values.map((v) => JSON.stringify(v)).join(', ')}`,
        });
      }
    }
  });

// ===== Retry Schema =====

const RetrySchema = z.object({
  count: z.number().int().min(0).default(0),
  backoff: z.enum(['linear', 'exponential']).default('linear'),
  baseDelay: z.number().int().min(0).default(1000),
});

// ===== Auto-Heal Schema =====

const AutoHealSchema = z.object({
  agent: z.string(),
  model: z.string().optional(),
  maxAttempts: z.number().int().min(1).default(1),
});

// ===== Reflexion Schema =====

const ReflexionSchema = z.object({
  limit: z.number().int().min(1).default(3),
  hint: z.string().optional(),
});

// ===== Matrix Strategy Schema =====

const StrategySchema = z.object({
  matrix: z.record(z.array(z.union([z.string(), z.number(), z.boolean()]))),
});

// ===== Base Step Schema =====

export const BaseStepSchema = z.object({
  id: z.string(),
  type: z.string(),
  needs: z.array(z.string()).optional().default([]),
  if: z.union([z.string(), z.boolean()]).optional(),
  timeout: z.number().int().positive().optional(),
  retry: RetrySchema.optional(),
  auto_heal: AutoHealSchema.optional(),
  reflexion: ReflexionSchema.optional(),
  allowFailure: z.boolean().optional(),
  idempotencyKey: z.string().optional(), // Expression for dedup key (evaluated at runtime)
  idempotencyScope: z.enum(['run', 'global']).optional(), // Default: run
  idempotencyTtlSeconds: z.number().int().positive().optional(),
  foreach: z.string().optional(),
  // Accept both number and string (for expressions or YAML number-as-string)
  concurrency: z.union([z.number().int().positive(), z.string()]).optional(),
  pool: z.string().optional(), // Resource pool to use for this step
  breakpoint: z.boolean().optional(),
  strategy: StrategySchema.optional(),
  transform: z.string().optional(),
  learn: z.boolean().optional(),
  memoize: z.boolean().optional(),
  memoizeTtlSeconds: z.number().int().positive().optional(),
  inputSchema: z.any().optional(),
  outputSchema: z.any().optional(),
  outputRetries: z.number().int().min(0).optional(), // Max retries for output validation failures
  repairStrategy: z.enum(['reask', 'repair', 'hybrid']).optional(), // Strategy for output repair
  compensate: z.lazy(() => StepSchema).optional(), // Compensation step to run on rollback
});

// ===== Step Type Schemas =====

const ShellStepSchema = BaseStepSchema.extend({
  type: z.literal('shell'),
  run: z.string().optional(),
  args: z.array(z.string()).optional(),
  dir: z.string().optional(),
  env: z.record(z.string()).optional(),
  allowOutsideCwd: z.boolean().optional(),
  allowInsecure: z.boolean().optional(),
});

// Forward declaration for AgentToolSchema which depends on StepSchema
const AgentToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.any().optional(), // JSON Schema for tool arguments
  execution: z.lazy(() => StepSchema), // Tools are essentially steps
});

const JoinStepSchema = BaseStepSchema.extend({
  type: z.literal('join'),
  target: z.enum(['steps', 'branches']).optional().default('steps'),
  condition: z
    .union([z.literal('all'), z.literal('any'), z.number().int().positive()])
    .default('all'),
});

const EngineConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  input: z.any().optional(),
  env: z.record(z.string()),
  cwd: z.string(),
});

const EngineHandoffSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.any().optional(),
  engine: EngineConfigSchema.extend({
    timeout: z.number().int().positive().optional(),
    outputSchema: z.any().optional(),
  }),
});

const QualityGateSchema = z.object({
  agent: z.string(),
  prompt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  maxAttempts: z.number().int().min(1).default(1),
});

const LlmStepSchema = BaseStepSchema.extend({
  type: z.literal('llm'),
  agent: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string(),
  tools: z.array(AgentToolSchema).optional(),
  allowedHandoffs: z.array(z.string()).optional(),
  maxIterations: z.number().int().positive().default(10),
  maxMessageHistory: z.number().int().positive().optional(), // Max messages to keep in conversation history
  contextStrategy: z.enum(['truncate', 'summary', 'auto']).optional(),
  qualityGate: QualityGateSchema.optional(),
  useGlobalMcp: z.boolean().optional(),
  allowClarification: z.boolean().optional(),
  mcpServers: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          type: z.enum(['local', 'remote']).optional(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          url: z.string().optional(),
          headers: z.record(z.string()).optional(),
          timeout: z.number().int().positive().optional(),
        }),
      ])
    )
    .optional(),
  useStandardTools: z.boolean().optional(),
  allowOutsideCwd: z.boolean().optional(),
  allowInsecure: z.boolean().optional(),
  handoff: EngineHandoffSchema.optional(),
});

const PlanStepSchema = BaseStepSchema.extend({
  type: z.literal('plan'),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  prompt: z.string().optional(),
  agent: z.string().optional().default('keystone-architect'),
  provider: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(AgentToolSchema).optional(),
  allowedHandoffs: z.array(z.string()).optional(),
  maxIterations: z.number().int().positive().default(10),
  maxMessageHistory: z.number().int().positive().optional(),
  contextStrategy: z.enum(['truncate', 'summary', 'auto']).optional(),
  qualityGate: QualityGateSchema.optional(),
  useGlobalMcp: z.boolean().optional(),
  allowClarification: z.boolean().optional(),
  mcpServers: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          type: z.enum(['local', 'remote']).optional(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          url: z.string().optional(),
          headers: z.record(z.string()).optional(),
          timeout: z.number().int().positive().optional(),
        }),
      ])
    )
    .optional(),
  useStandardTools: z.boolean().optional(),
  allowOutsideCwd: z.boolean().optional(),
  allowInsecure: z.boolean().optional(),
  handoff: EngineHandoffSchema.optional(),
});

const OutputMappingItemSchema = z.union([
  z.string(), // Rename: alias -> originalKey
  z.object({
    from: z.string(),
    default: z.any().optional(),
  }),
]);

const WorkflowStepSchema = BaseStepSchema.extend({
  type: z.literal('workflow'),
  path: z.string(),
  inputs: z.record(z.string()).optional(),
  outputMapping: z.record(OutputMappingItemSchema).optional(),
});

const FileStepSchema = BaseStepSchema.extend({
  type: z.literal('file'),
  path: z.string(),
  content: z.string().optional(),
  op: z.enum(['read', 'write', 'append', 'patch']),
  allowOutsideCwd: z.boolean().optional(),
});

const RequestStepSchema = BaseStepSchema.extend({
  type: z.literal('request'),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
  body: z.any().optional(),
  headers: z.record(z.string()).optional(),
  allowInsecure: z.boolean().optional(),
});

const HumanStepSchema = BaseStepSchema.extend({
  type: z.literal('human'),
  message: z.string(),
  inputType: z.enum(['confirm', 'text']).default('confirm'),
});

const SleepStepSchema = BaseStepSchema.extend({
  type: z.literal('sleep'),
  duration: z.union([z.number().int().positive(), z.string()]).optional(),
  until: z.string().optional(),
  durable: z.boolean().optional(), // Persist across restarts for long sleeps
});

const ScriptStepSchema = BaseStepSchema.extend({
  type: z.literal('script'),
  run: z.string(),
  allowOutsideCwd: z.boolean().optional(),
  allowInsecure: z.boolean().optional().default(false),
});

const EngineStepSchema = BaseStepSchema.extend({
  type: z.literal('engine'),
}).merge(EngineConfigSchema);

const BlueprintSchema = z.object({
  architecture: z.object({
    description: z.string(),
    patterns: z.array(z.string()).optional(),
  }),
  apis: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        endpoints: z
          .array(
            z.object({
              path: z.string(),
              method: z.string(),
              purpose: z.string(),
            })
          )
          .optional(),
      })
    )
    .optional(),
  files: z.array(
    z.object({
      path: z.string(),
      purpose: z.string(),
      constraints: z.array(z.string()).optional(),
    })
  ),
  dependencies: z
    .array(
      z.object({
        name: z.string(),
        version: z.string().optional(),
        purpose: z.string(),
      })
    )
    .optional(),
  constraints: z.array(z.string()).optional(),
});

const BlueprintStepSchema = BaseStepSchema.extend({
  type: z.literal('blueprint'),
  prompt: z.string(),
  agent: z.string().optional().default('keystone-architect'),
});

const MemoryStepSchema = BaseStepSchema.extend({
  type: z.literal('memory'),
  op: z.enum(['search', 'store']),
  query: z.string().optional(), // for search
  text: z.string().optional(), // for store
  model: z.string().optional().default('local'), // embedding model
  metadata: z.record(z.any()).optional(),
  limit: z.number().int().positive().optional().default(5),
});

const ArtifactStepSchema = BaseStepSchema.extend({
  type: z.literal('artifact'),
  op: z.enum(['upload', 'download']),
  name: z.string(),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  allowOutsideCwd: z.boolean().optional(),
});

const GitStepSchema = BaseStepSchema.extend({
  type: z.literal('git'),
  op: z.enum(['clone', 'worktree_add', 'worktree_remove', 'checkout', 'pull', 'push', 'commit']),
  path: z.string().optional(), // Local path for clone or worktree
  url: z.string().optional(), // Repo URL for clone
  branch: z.string().optional(),
  message: z.string().optional(), // For commit
  cwd: z.string().optional(), // Working directory for the git command
  env: z.record(z.string()).optional(),
  allowOutsideCwd: z.boolean().optional(),
  allowInsecure: z.boolean().optional(),
});

const WaitStepSchema = BaseStepSchema.extend({
  type: z.literal('wait'),
  event: z.string(),
  oneShot: z.boolean().optional().default(true),
  // timeout is already in BaseStepSchema, but let's make it explicit here if needed
});

// ===== Discriminated Union for Steps =====

export const StepSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    ShellStepSchema as any,
    LlmStepSchema as any,
    PlanStepSchema as any,
    WorkflowStepSchema as any,
    FileStepSchema as any,
    RequestStepSchema as any,
    HumanStepSchema as any,
    SleepStepSchema as any,
    ScriptStepSchema as any,
    EngineStepSchema as any,
    MemoryStepSchema as any,
    JoinStepSchema as any,
    BlueprintStepSchema as any,
    ArtifactStepSchema as any,
    WaitStepSchema as any,
    GitStepSchema as any,
  ])
);

// ===== Evaluation Schema =====

const EvalSchema = z.object({
  scorer: z.enum(['llm', 'script']),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  run: z.string().optional(), // for script scorer
  allowInsecure: z.boolean().optional(),
  allowSecrets: z.boolean().optional(),
});

// ===== Workflow Schema =====

export const WorkflowSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    inputs: z.record(InputSchema).optional(),
    outputs: z.record(z.string()).optional(),
    outputSchema: z.any().optional(), // JSON Schema for final workflow outputs
    env: z.record(z.string()).optional(),
    concurrency: z.union([z.number().int().positive(), z.string()]).optional(),
    pools: z.record(z.union([z.number().int().positive(), z.string()])).optional(), // Resource pool overrides
    steps: z.array(StepSchema),
    errors: z.array(StepSchema).optional(),
    finally: z.array(StepSchema).optional(),
    compensate: z.lazy(() => StepSchema).optional(), // Top-level compensation for the entire workflow
    eval: EvalSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const checkShellSteps = (steps: Step[] | undefined, pathPrefix: (string | number)[]) => {
      if (!steps) return;
      steps.forEach((step, index) => {
        if (step.type === 'shell' && !step.run && !step.args) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Shell step must have either "run" or "args"',
            path: [...pathPrefix, index],
          });
        }
      });
    };

    checkShellSteps(data.steps, ['steps']);
    checkShellSteps(data.errors, ['errors']);
    checkShellSteps(data.finally, ['finally']);
  });

// ===== Agent Schema =====

export const AgentSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(AgentToolSchema).default([]),
  systemPrompt: z.string(),
});

// ===== Types =====

export type WorkflowInput = z.infer<typeof InputSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;

export type Step =
  | z.infer<typeof ShellStepSchema>
  | z.infer<typeof LlmStepSchema>
  | z.infer<typeof PlanStepSchema>
  | z.infer<typeof WorkflowStepSchema>
  | z.infer<typeof FileStepSchema>
  | z.infer<typeof RequestStepSchema>
  | z.infer<typeof HumanStepSchema>
  | z.infer<typeof SleepStepSchema>
  | z.infer<typeof ScriptStepSchema>
  | z.infer<typeof EngineStepSchema>
  | z.infer<typeof MemoryStepSchema>
  | z.infer<typeof JoinStepSchema>
  | z.infer<typeof BlueprintStepSchema>
  | z.infer<typeof ArtifactStepSchema>
  | z.infer<typeof WaitStepSchema>
  | z.infer<typeof GitStepSchema>;

export type ShellStep = z.infer<typeof ShellStepSchema>;
export type LlmStep = z.infer<typeof LlmStepSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type FileStep = z.infer<typeof FileStepSchema>;
export type RequestStep = z.infer<typeof RequestStepSchema>;
export type HumanStep = z.infer<typeof HumanStepSchema>;
export type SleepStep = z.infer<typeof SleepStepSchema>;
export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type MemoryStep = z.infer<typeof MemoryStepSchema>;
export type EngineStep = z.infer<typeof EngineStepSchema>;
export type JoinStep = z.infer<typeof JoinStepSchema>;
export type BlueprintStep = z.infer<typeof BlueprintStepSchema>;
export type ArtifactStep = z.infer<typeof ArtifactStepSchema>;
export type GitStep = z.infer<typeof GitStepSchema>;
export type Blueprint = z.infer<typeof BlueprintSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type AgentTool = z.infer<typeof AgentToolSchema>;
export type WaitStep = z.infer<typeof WaitStepSchema>;

// ===== Helper Schemas =====
export {
  InputSchema,
  RetrySchema,
  AutoHealSchema,
  ReflexionSchema,
  StrategySchema,
  EngineConfigSchema,
  EngineHandoffSchema,
  BlueprintSchema,
  WaitStepSchema,
  ShellStepSchema,
  LlmStepSchema,
  PlanStepSchema,
  WorkflowStepSchema,
  FileStepSchema,
  RequestStepSchema,
  HumanStepSchema,
  SleepStepSchema,
  ScriptStepSchema,
  EngineStepSchema,
  BlueprintStepSchema,
  MemoryStepSchema,
  ArtifactStepSchema,
  GitStepSchema,
};
export type Agent = z.infer<typeof AgentSchema>;
