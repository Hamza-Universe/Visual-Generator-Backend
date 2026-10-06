import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export const createDb = (url: string) => {
  const client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
    transform: {
      undefined: null,
    },
  });
  return drizzle(client, { schema });
};
export type Database = ReturnType<typeof createDb>;
