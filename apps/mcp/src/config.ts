import { z } from 'zod';
const EnvSchema = z.object({
  API_BASE_URL: z.string().url(), // Remove .default() - require it
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('http'), // Change from 'stdio' to 'http'
  MCP_API_TOKEN: z.string().min(1),
});
export const loadConfig = () => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      'Invalid MCP configuration',
      parsed.error.flatten().fieldErrors,
    );
    process.exit(1);
  }
  return parsed.data;
};