import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
