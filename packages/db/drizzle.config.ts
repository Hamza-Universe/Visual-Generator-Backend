import 'dotenv/config';
import type { Config } from 'drizzle-kit';
export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgresql://neondb_owner:npg_4myUOHl9vZds@ep-shy-meadow-b32iqyf1-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require' },
  // dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/explainer' },
} satisfies Config;
