import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import type { Config } from 'drizzle-kit';
loadDotenv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL  ?? 'postgres://app:app@localhost:5432/explainer' }, 
} satisfies Config;
