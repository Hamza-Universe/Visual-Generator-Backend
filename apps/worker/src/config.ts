import { z } from 'zod';
const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STORAGE_DIR: z.string().min(1),
});
export const loadConfig = () => {
  const result = Schema.safeParse(process.env);
  if (!result.success) {
    console.error(
      'Invalid worker configuration',
      result.error.flatten().fieldErrors,
    );
    process.exit(1);
  }
  return result.data;
};
