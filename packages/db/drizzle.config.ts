import 'dotenv/config';
import type { Config } from 'drizzle-kit';
export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/explainer' },
} satisfies Config;
