import { z } from 'zod';

export const ConfigSchema = z.object({
  default_provider: z.string().default('openai'),
  default_model: z.string().optional(),
  providers: z
    .record(
      z.object({
        type: z.enum(['openai', 'anthropic', 'copilot']).default('openai'),
        base_url: z.string().optional(),
        api_key_env: z.string().optional(),
        default_model: z.string().optional(),
      })
    )
    .default({
      openai: {
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key_env: 'OPENAI_API_KEY',
        default_model: 'gpt-4o',
      },
      anthropic: {
        type: 'anthropic',
        base_url: 'https://api.anthropic.com/v1',
        api_key_env: 'ANTHROPIC_API_KEY',
        default_model: 'claude-3-5-sonnet-20240620',
      },
      copilot: {
        type: 'copilot',
        base_url: 'https://api.githubcopilot.com',
        default_model: 'gpt-4o',
      },
    }),
  model_mappings: z.record(z.string()).default({
    'claude-*': 'anthropic',
  }),
  storage: z
    .object({
      retention_days: z.number().default(30),
    })
    .default({}),
  workflows_directory: z.string().default('workflows'),
  mcp_servers: z
    .record(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('local').default('local'),
          command: z.string(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
        }),
        z.object({
          type: z.literal('remote'),
          url: z.string().url(),
          headers: z.record(z.string()).optional(),
          oauth: z
            .object({
              scope: z.string().optional(),
            })
            .optional(),
        }),
      ])
    )
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
