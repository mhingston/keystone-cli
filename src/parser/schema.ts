import { z } from 'zod';

// ===== Input/Output Schema =====

const InputSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  default: z.any().optional(),
  description: z.string().optional(),
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

// ===== Base Step Schema =====

const BaseStepSchema = z.object({
  id: z.string(),
  type: z.string(),
  needs: z.array(z.string()).optional().default([]),
  if: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  retry: RetrySchema.optional(),
  auto_heal: AutoHealSchema.optional(),
  reflexion: ReflexionSchema.optional(),
  foreach: z.string().optional(),
  // Accept both number and string (for expressions or YAML number-as-string)
  concurrency: z.union([z.number().int().positive(), z.string()]).optional(),
  transform: z.string().optional(),
  learn: z.boolean().optional(),
});

// ===== Step Type Schemas =====

const ShellStepSchema = BaseStepSchema.extend({
  type: z.literal('shell'),
  run: z.string(),
  dir: z.string().optional(),
  env: z.record(z.string()).optional(),
  allowInsecure: z.boolean().optional(),
});

// Forward declaration for AgentToolSchema which depends on StepSchema
const AgentToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.any().optional(), // JSON Schema for tool arguments
  execution: z.lazy(() => StepSchema), // Tools are essentially steps
});

const LlmStepSchema = BaseStepSchema.extend({
  type: z.literal('llm'),
  agent: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string(),
  schema: z.any().optional(),
  tools: z.array(AgentToolSchema).optional(),
  maxIterations: z.number().int().positive().default(10),
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
});

const WorkflowStepSchema = BaseStepSchema.extend({
  type: z.literal('workflow'),
  path: z.string(),
  inputs: z.record(z.string()).optional(),
});

const FileStepSchema = BaseStepSchema.extend({
  type: z.literal('file'),
  path: z.string(),
  content: z.string().optional(),
  op: z.enum(['read', 'write', 'append']),
  allowOutsideCwd: z.boolean().optional(),
});

const RequestStepSchema = BaseStepSchema.extend({
  type: z.literal('request'),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
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
  duration: z.union([z.number().int().positive(), z.string()]),
});

const ScriptStepSchema = BaseStepSchema.extend({
  type: z.literal('script'),
  run: z.string(),
  allowInsecure: z.boolean().optional().default(false),
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

// ===== Discriminated Union for Steps =====

// biome-ignore lint/suspicious/noExplicitAny: Recursive Zod type
export const StepSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    ShellStepSchema,
    LlmStepSchema,
    WorkflowStepSchema,
    FileStepSchema,
    RequestStepSchema,
    HumanStepSchema,
    SleepStepSchema,
    ScriptStepSchema,
    MemoryStepSchema,
  ])
);

// ===== Evaluation Schema =====

const EvalSchema = z.object({
  scorer: z.enum(['llm', 'script']),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  run: z.string().optional(), // for script scorer
});

// ===== Workflow Schema =====

export const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputs: z.record(InputSchema).optional(),
  outputs: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  concurrency: z.union([z.number().int().positive(), z.string()]).optional(),
  steps: z.array(StepSchema),
  finally: z.array(StepSchema).optional(),
  eval: EvalSchema.optional(),
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
export type Step = z.infer<typeof StepSchema>;
export type ShellStep = z.infer<typeof ShellStepSchema>;
export type LlmStep = z.infer<typeof LlmStepSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type FileStep = z.infer<typeof FileStepSchema>;
export type RequestStep = z.infer<typeof RequestStepSchema>;
export type HumanStep = z.infer<typeof HumanStepSchema>;
export type SleepStep = z.infer<typeof SleepStepSchema>;
export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type MemoryStep = z.infer<typeof MemoryStepSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type AgentTool = z.infer<typeof AgentToolSchema>;
export type Agent = z.infer<typeof AgentSchema>;
