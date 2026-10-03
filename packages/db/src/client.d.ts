import postgres from 'postgres';
import * as schema from './schema.js';
export declare const createDb: (url: string) => import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema> & {
    $client: postgres.Sql<{}>;
};
export type Database = ReturnType<typeof createDb>;
