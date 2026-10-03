import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
export const createDb = (url) => {
    console.log('executing');
    console.log(url, 'DB url in db module dist folder');
    return drizzle(postgres(url), { schema });
};
